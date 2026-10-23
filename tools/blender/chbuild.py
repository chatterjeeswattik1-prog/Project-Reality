"""Character assembly for tools/blender/characters.py: MakeHuman body + clothes on our armature, extra gear,
per-part texture atlases baked in numpy (texbake.py), decimation, split into part_head/torso/arms/legs.

Materials are *sources*: every opaque face carries a material slot whose name is a key into Kit.srcs. A source is a
function that, given per-texel attributes (rest position P, normal N, source UV 'suv'), returns base colour (sRGB),
roughness, an optional tangent-space normal (sampled from a source normal map) and an optional height (metres,
turned into normals). At the end every part gets ONE 1024 px atlas (base / normal / roughness) holding all its
opaque faces, packed by world-space texel density (x importance: hands and face get more).
"""
import math
import os
import tempfile

import bpy
import bmesh
import numpy as np
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree

import chcommon as C
import mhcommon as M
import mhchar as H
import texbake as T

TMP = os.environ.get('CHARS_TMP') or tempfile.mkdtemp(prefix='chars_')
os.makedirs(TMP, exist_ok=True)
PARTS = ('head', 'torso', 'arms', 'legs')
ALPHA_PREFIX = 'alpha_'        # material names starting with this stay as they are (hair, brows, lashes)

ARM_BONES = ('upperarm', 'lowerarm', 'hand', 'thumb', 'index', 'middle', 'ring', 'pinky')
HAND_BONES = ('hand', 'thumb', 'index', 'middle', 'ring', 'pinky')


def region_of(bone):
    if bone in ('Head', 'neck_01'):
        return 'head'
    if bone.startswith(('thigh', 'calf', 'foot', 'ball')):
        return 'legs'
    if bone.startswith(ARM_BONES):
        return 'arms'
    return 'torso'


class Src:
    """A material source. fn(a) -> dict(base=(n,3) sRGB, rough=(n,), normal=(n,3) unit tangent normal or None,
    height=(n,) metres or None). a = dict(P, N, suv, ...) arrays for the texels using this source."""

    def __init__(self, fn, importance=1.0):
        self.fn = fn
        self.importance = importance


class Kit:
    def __init__(self, cid, arm, human):
        self.cid = cid
        self.arm = arm
        self.h = human
        self.objs = []            # (object, forced part or None)
        self.srcs = {}
        self.hide = set()
        self.rest = H.rest_of(arm)
        self.bone_m = {b.name: b.matrix_local.copy() for b in arm.data.bones}

    def mat(self, name, src=None, preview=(0.5, 0.5, 0.5)):
        """Placeholder material (slot name = source key)."""
        if src is not None:
            self.srcs[name] = src
        m = bpy.data.materials.get(name)
        if m is None:
            m = C.flat_mat(name, preview, 0.8)
        return m

    def add(self, o, part=None):
        self.objs.append((o, part))
        return o

# ---------------------------------------------------------------------------------------------- sources


_imgcache = {}


def img(path, size=None):
    key = (path, size)
    if key not in _imgcache:
        _imgcache[key] = T.load(path, size)
    return _imgcache[key]


def hipass(lum, r=12):
    lo = lum
    for _ in range(3):
        lo = T.blur(lo, r)
    return lum / np.maximum(lo, 1e-3)


def cloth_maps(clo, size=1024):
    """Source maps of a MakeHuman garment: detail (high-passed luminance), ao, normal (rgb 0..1)."""
    mm = clo.material()
    out = {}
    if 'diffuse' in mm:
        d = img(mm['diffuse'], size)[..., :3]
        lum = d @ np.array([0.3, 0.59, 0.11], np.float32)
        out['detail'] = np.clip(hipass(lum), 0.6, 1.4)[..., None]
        out['diffuse'] = d
    if 'ao' in mm:
        out['ao'] = img(mm['ao'], size)[..., :1]
    if 'normal' in mm:
        out['normal'] = img(mm['normal'], size)[..., :3]
    return out


def src_cloth(maps, color_fn, rough=0.85, detail=1.0, ao=0.8, normal=1.0, height_fn=None, importance=1.0,
              keep_diffuse=False):
    """Garment source: colour from color_fn(a) (sRGB (n,3)) or the original diffuse, modulated by the original
    texture's fine detail (stitches, seams, weave), ambient occlusion and its normal map."""
    def fn(a):
        uv = a['suv']
        if keep_diffuse or color_fn is None:
            base = T.sample(maps['diffuse'], uv)
            if color_fn is not None:
                base = color_fn(a, base)
        else:
            base = color_fn(a)
        if 'detail' in maps and detail:
            dt = T.sample(maps['detail'], uv)[:, 0]
            base = base * (1 + (dt - 1) * detail)[:, None]
        if 'ao' in maps and ao:
            o = T.sample(maps['ao'], uv)[:, 0]
            base = base * (1 - ao + ao * o)[:, None]
        nrm = None
        if 'normal' in maps and normal:
            n = T.rgb2n(T.sample(maps['normal'], uv))
            if normal != 1.0:
                n[:, :2] *= normal
                n /= np.linalg.norm(n, axis=1, keepdims=True)
            nrm = n
        r = np.full(len(uv), rough, np.float32)
        hgt = height_fn(a) if height_fn else None
        return {'base': base, 'rough': r, 'normal': nrm, 'height': hgt}
    return Src(fn, importance)


def src_image(path, tint=(1, 1, 1), rough=0.5, importance=1.0, size=1024, normal_path=None):
    def fn(a):
        base = T.sample(img(path, size)[..., :3], a['suv']) * np.array(tint)
        nrm = T.rgb2n(T.sample(img(normal_path, size)[..., :3], a['suv'])) if normal_path else None
        return {'base': base, 'rough': np.full(len(base), rough), 'normal': nrm, 'height': None}
    return Src(fn, importance)


def src_proc(fn, importance=1.0):
    """fn(a) -> dict(base, rough, height) procedural from 3D position."""
    def f(a):
        r = fn(a)
        r.setdefault('normal', None)
        r.setdefault('height', None)
        if np.isscalar(r['rough']):
            r['rough'] = np.full(len(a['P']), r['rough'])
        return r
    return Src(f, importance)

# ---------------------------------------------------------------------------------------------- camouflage, fabric


def smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def ocp(P, seed=0, scale=1.0):
    """OCP / Multicam-like pattern from rest positions (metres): khaki-tan base with a soft vertical gradient,
    soft-edged olive and brown blobs, small dark-brown spots, a few thin cream / brown branches (elongated
    vertically)."""
    Q = np.asarray(P, np.float64) * np.array([1.0, 1.0, 0.62]) / scale + seed * 13.1
    c_lt = np.array([0.66, 0.60, 0.46])
    c_md = np.array([0.57, 0.52, 0.38])
    c_gr = np.array([0.42, 0.43, 0.29])
    c_ol = np.array([0.33, 0.34, 0.23])
    c_br = np.array([0.45, 0.34, 0.23])
    c_dk = np.array([0.27, 0.21, 0.15])
    c_cr = np.array([0.76, 0.72, 0.58])
    g = T.fbm(Q, 0.30, 3, seed + 1)
    col = c_lt + (c_md - c_lt) * smooth(0.35, 0.65, g)[:, None]

    def blob(sc, th, sd, soft=0.03):
        n = T.fbm(Q, sc, 4, seed + sd)
        return smooth(th - soft, th + soft, n)
    for c, sc, th, sd in ((c_gr, 0.085, 0.55, 10), (c_ol, 0.06, 0.64, 20), (c_br, 0.07, 0.60, 30), (c_dk, 0.03, 0.70, 40)):
        w = blob(sc, th, sd)
        col = col + (c - col) * w[:, None]
    for c, sc, sd, gate, k in ((c_cr, 0.05, 50, 0.58, 0.45), (c_dk, 0.045, 60, 0.60, 0.5)):
        n = T.fbm(Q, sc, 3, seed + sd)
        line = 1 - smooth(0.003, 0.009, np.abs(n - 0.5))
        gt = smooth(gate - 0.03, gate + 0.03, T.fbm(Q, 0.12, 2, seed + sd + 3))
        col = col + (c - col) * (line * gt * k)[:, None]
    return col


def fabric_height(P, N, limb_axis=None, folds=1.0, ripstop=True, seed=0):
    """Fabric relief (metres): ripstop grid, soft wrinkles running around the limbs (compressed along the limb
    axis: X for T-pose arms, Z elsewhere), deeper folds at elbows / knees given as joint points."""
    P = np.asarray(P, np.float64)
    h = (T.vnoise(P, 0.0006, seed + 1) - 0.5) * 0.00004
    if ripstop:
        g = 0.0055
        a = np.abs(((P[:, 0] + P[:, 1]) % g) - g / 2)
        b = np.abs((P[:, 2] % g) - g / 2)
        h += ((1 - smooth(0.0003, 0.0007, g / 2 - a)) + (1 - smooth(0.0003, 0.0007, g / 2 - b))) * 0.00003
    if folds:
        armlike = (np.abs(P[:, 0]) > 0.24) & (P[:, 2] > 1.25)
        Q = np.where(armlike[:, None], P * np.array([3.2, 1.0, 1.0]), P * np.array([1.0, 1.0, 2.6]))
        r = 1 - np.abs(2 * T.fbm(Q, 0.05, 3, seed + 5) - 1)
        h += r ** 3 * 0.0013 * folds
        r2 = 1 - np.abs(2 * T.fbm(Q, 0.022, 2, seed + 6) - 1)
        h += r2 ** 4 * 0.0005 * folds
    return h


def dirt(P, base, amount=0.35, seed=5, ground=0.5):
    """Dust / dirt: tan dust towards the ground and in blotches, slight darkening grime."""
    z = P[:, 2]
    dust = np.array([0.62, 0.55, 0.43])
    n = T.fbm(P, 0.12, 4, seed)
    w = np.clip((ground - z) / ground, 0, 1) ** 1.5 * 0.8 + smooth(0.55, 0.75, n) * 0.35
    w = np.clip(w * amount, 0, 0.8)
    out = base + (dust - base) * w[:, None]
    grime = 1 - 0.12 * amount * smooth(0.5, 0.8, T.fbm(P, 0.05, 3, seed + 9))
    return out * grime[:, None]


def fabric_tint(rgb, var=0.08, seed=3, scale=0.15):
    rgb = np.array(rgb, np.float64)
    def fn(a):
        n = T.fbm(a['P'], scale, 3, seed)
        return rgb[None, :] * (1 - var + 2 * var * n)[:, None]
    return fn

# ---------------------------------------------------------------------------------------------- geometry helpers


def body_bvh(objs):
    """BVH over the (rest pose) meshes of objs, world space."""
    verts, polys = [], []
    for o in objs:
        mw = o.matrix_world
        off = len(verts)
        verts += [mw @ v.co for v in o.data.vertices]
        polys += [[off + i for i in p.vertices] for p in o.data.polygons]
    return BVHTree.FromPolygons(verts, polys)


def weights_from(o, ref, k=6, max_d=0.25, filt=None):
    """Copy skin weights to every vertex of o from the nearest vertices of reference mesh(es) ref (inverse
    distance over k neighbours). filt(name) -> bool limits which bones are used."""
    refs = ref if isinstance(ref, (list, tuple)) else [ref]
    pts, ws = [], []
    for r in refs:
        mw = r.matrix_world
        gn = {g.index: g.name for g in r.vertex_groups}
        for v in r.data.vertices:
            d = {gn[g.group]: g.weight for g in v.groups if g.weight > 1e-4 and (filt is None or filt(gn[g.group]))}
            if d:
                pts.append(mw @ v.co)
                ws.append(d)
    kd = KDTree(len(pts))
    for i, p in enumerate(pts):
        kd.insert(p, i)
    kd.balance()
    o.vertex_groups.clear()
    groups = {}
    mw = o.matrix_world
    for v in o.data.vertices:
        acc = {}
        for co, i, dist in kd.find_n(mw @ v.co, k):
            w = 1.0 / max(dist, 1e-4) ** 2
            for b, x in ws[i].items():
                acc[b] = acc.get(b, 0.0) + w * x
        top = sorted(acc.items(), key=lambda t: -t[1])[:4]
        tot = sum(x for b, x in top) or 1
        for b, x in top:
            g = groups.get(b) or o.vertex_groups.new(name=b)
            groups[b] = g
            g.add([v.index], x / tot, 'REPLACE')
    return o


def rigid(o, arm, bone):
    o.vertex_groups.clear()
    g = o.vertex_groups.new(name=bone)
    g.add(list(range(len(o.data.vertices))), 1.0, 'REPLACE')
    return bind(o, arm)


def bind(o, arm):
    mw = o.matrix_world.copy()
    o.parent = arm
    o.matrix_parent_inverse = arm.matrix_world.inverted()
    o.matrix_world = mw
    for m in list(o.modifiers):
        if m.type == 'ARMATURE':
            o.modifiers.remove(m)
    m = o.modifiers.new('Armature', 'ARMATURE')
    m.object = arm
    return o


def apply_mods(o, keep_armature=True):
    C.set_active(o)
    for m in list(o.modifiers):
        if keep_armature and m.type == 'ARMATURE':
            continue
        # modifiers must come before the armature one to apply on rest geometry
        bpy.ops.object.modifier_move_to_index(modifier=m.name, index=0)
        bpy.ops.object.modifier_apply(modifier=m.name)


def subsurf(o, levels=1):
    m = o.modifiers.new('sub', 'SUBSURF')
    m.levels = levels
    m.render_levels = levels
    apply_mods(o)
    return o


def decimate(o, ratio, protect=None, factor=1.0):
    """Collapse decimation (keeps UVs and weights). protect: vertex group name kept denser."""
    if ratio >= 0.999:
        return o
    m = o.modifiers.new('dec', 'DECIMATE')
    m.decimate_type = 'COLLAPSE'
    m.ratio = ratio
    m.use_collapse_triangulate = False
    if protect and protect in o.vertex_groups:
        m.vertex_group = protect
        m.invert_vertex_group = True
        m.vertex_group_factor = factor
    apply_mods(o)
    return o


def delete_faces(o, mask):
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bm.faces.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[bm.faces[i] for i in np.nonzero(mask)[0]], context='FACES')
    bm.to_mesh(o.data)
    bm.free()
    o.data.update()


def face_bones(o):
    """Dominant bone per polygon (by summed weights of its vertices; non-bone groups ignored)."""
    bones = o.parent.data.bones if (o.parent and o.parent.type == 'ARMATURE') else None
    gn = [g.name if (bones is None or g.name in bones) else '' for g in o.vertex_groups]
    nv = len(o.data.vertices)
    W = np.zeros((nv, max(len(gn), 1)), np.float32)
    for v in o.data.vertices:
        for g in v.groups:
            W[v.index, g.group] = g.weight
    out = []
    for p in o.data.polygons:
        s = W[list(p.vertices)].sum(0)
        out.append(gn[int(s.argmax())] if len(gn) else 'root')
    return out, W, gn

# ---------------------------------------------------------------------------------------------- parts + atlases


def part_of_faces(kit, o, forced):
    n = len(o.data.polygons)
    if forced:
        return np.array([forced] * n, dtype=object)
    fb, W, gn = face_bones(o)
    out = np.empty(n, dtype=object)
    for i, p in enumerate(o.data.polygons):
        b = fb[i]
        r = region_of(b)
        if b.startswith('upperarm'):
            # the arm part starts at mid upper arm
            h, t = kit.rest[b]
            c = np.array(p.center)
            u = np.dot(c - h, t - h) / max(np.dot(t - h, t - h), 1e-9)
            seg = kit.rest['lowerarm' + b[-2:]][0] - h
            u = np.dot(c - h, seg) / np.dot(seg, seg)
            r = 'arms' if u > 0.40 else 'torso'
        out[i] = r
    return out


IMPORTANCE_DEFAULT = {'head': 1.0, 'torso': 1.0, 'arms': 1.0, 'legs': 1.0}


def bake_part(kit, part, items, res, path_prefix):
    """items: [(obj, polygon mask)] of this part (opaque faces). Packs, rasterizes and evaluates the sources,
    writes the three maps and returns the material."""
    imps = []
    for o, mask in items:
        names = [s.material.name if (s.material) else '' for s in o.material_slots]
        imp = np.ones(len(o.data.polygons))
        mi = np.empty(len(o.data.polygons), np.int64)
        o.data.polygons.foreach_get('material_index', mi)
        for k, nm in enumerate(names):
            src = kit.srcs.get(nm.split('.')[0])
            imp[mi == k] = src.importance if src else 1.0
        imps.append(imp)
    T.pack_atlas([(o, mask, imp) for (o, mask), imp in zip(items, imps)], res=res, margin_px=3)
    # gather corners of all items
    cat = {'uv': [], 'suv': [], 'P': [], 'N': [], 'sid': []}
    tris = []
    off = 0
    sid_names = []
    for o, mask in items:
        cd = T.mesh_corners(o, uv_name=o.data.uv_layers[0].name, extra_uv=['src'])
        keep = mask[cd['face']]
        mi = np.empty(len(o.data.polygons), np.int64)
        o.data.polygons.foreach_get('material_index', mi)
        names = [s.material.name.split('.')[0] if s.material else '' for s in o.material_slots]
        ids = []
        for nm in names:
            if nm not in sid_names:
                sid_names.append(nm)
            ids.append(sid_names.index(nm))
        ids = np.array(ids or [0])
        # per corner source id from its face
        face_of_corner = np.empty(len(o.data.loops), np.int64)
        for p in o.data.polygons:
            face_of_corner[p.loop_start:p.loop_start + p.loop_total] = p.index
        cat['uv'].append(cd['uv'])
        cat['suv'].append(cd['uv_src'])
        cat['P'].append(cd['P'])
        cat['N'].append(cd['N'])
        cat['sid'].append(ids[mi[face_of_corner]][:, None].astype(np.float32))
        tris.append(cd['tri'][keep] + off)
        off += len(cd['uv'])
    A = {k: np.concatenate(v) for k, v in cat.items()}
    tri = np.concatenate(tris)
    attrs = {'suv': A['suv'], 'P': A['P'], 'N': A['N'], 'sid': A['sid']}
    mask, tid, R = T.raster(A['uv'], tri, attrs, res)
    # texel source id from the triangle (not interpolated)
    sid = np.full(mask.shape, -1, np.int64)
    sid[mask] = np.round(A['sid'][tri[tid[mask], 0], 0]).astype(np.int64)
    base = np.zeros((res, res, 3), np.float32)
    rough = np.full((res, res), 0.8, np.float32)
    nrm = np.zeros((res, res, 3), np.float32)
    nrm[..., 2] = 1
    hgt = np.zeros((res, res), np.float32)
    for k, nm in enumerate(sid_names):
        sel = mask & (sid == k)
        if not sel.any():
            continue
        src = kit.srcs.get(nm)
        if os.environ.get('CHARS_DEBUG'):
            yy, xx = np.nonzero(sel)
            print('    src %-14s texels %7d  x %4d..%4d y %4d..%4d' % (nm, sel.sum(), xx.min(), xx.max(), yy.min(), yy.max()))
        a = {'P': R['P'][sel].astype(np.float64), 'N': R['N'][sel].astype(np.float64), 'suv': R['suv'][sel].astype(np.float64)}
        if src is None:
            m = bpy.data.materials.get(nm)
            col = m.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value if m else (0.5, 0.5, 0.5, 1)
            out = {'base': np.tile(T.lin2srgb(np.array(col[:3]))[None], (sel.sum(), 1)), 'rough': np.full(sel.sum(), 0.8),
                   'normal': None, 'height': None}
            print('  no source for material', nm)
        else:
            out = src.fn(a)
        base[sel] = out['base']
        rough[sel] = out['rough']
        if out.get('normal') is not None:
            nrm[sel] = out['normal']
        if out.get('height') is not None:
            hgt[sel] = out['height']
    # texel size (m) for height -> normal
    P = R['P']
    d = np.linalg.norm(np.roll(P, -1, 1) - P, axis=-1)
    ok = mask & np.roll(mask, -1, 1) & (tid == np.roll(tid, -1, 1))
    ts = float(np.median(d[ok])) if ok.any() else 0.002
    if np.abs(hgt).max() > 0:
        hd = T.dilate(hgt[..., None], mask, 4)[..., 0]
        hn = T.height_to_normal(hd, 1.0 / ts)
        nrm = T.combine_normals(nrm, hn)
    base = T.dilate(base, mask, 10)
    nrm = T.dilate(nrm, mask, 10)
    nrm /= np.maximum(np.linalg.norm(nrm, axis=-1, keepdims=True), 1e-6)
    rough = T.dilate(rough[..., None], mask, 10)[..., 0]
    mr = np.stack([np.ones_like(rough), rough, np.zeros_like(rough)], -1)
    nm = '%s_%s' % (kit.cid, part)
    ib = T.to_image(nm + '_base', base, path_prefix + '_base.jpg')
    inn = T.to_image(nm + '_normal', T.n2rgb(nrm), path_prefix + '_normal.jpg', non_color=True)
    ir = T.to_image(nm + '_mr', mr, path_prefix + '_mr.jpg', non_color=True)
    print('  atlas %s: texel %.2f mm, coverage %.0f%%' % (nm, ts * 1000, 100 * mask.mean()))
    return C.tex_mat(nm, ib, rough=0.8, normal=inn, rough_img=ir)


def finish(kit, res=1024, budgets=None):
    """Decimate, bake per-part atlases, split by part and join. Returns {part: object}."""
    arm = kit.arm
    budgets = budgets or {}
    # per-object decimation (ratio given when the object was added via o['decimate'])
    for o, forced in kit.objs:
        r = o.get('decimate', 1.0)
        if r < 0.999:
            decimate(o, r, protect=o.get('protect'), factor=o.get('protect_factor', 1.0))
        if o.get('protect') and o.get('protect') in o.vertex_groups:
            o.vertex_groups.remove(o.vertex_groups[o.get('protect')])
    if os.environ.get('CHARS_DEBUG'):
        for o, forced in kit.objs:
            print('   obj %-16s tris %6d (after decimation)' % (o.name, C.tri_count(o)))
    # part per face
    fparts = {}
    for o, forced in kit.objs:
        fparts[o.name] = part_of_faces(kit, o, forced)
    mats = {}
    for part in PARTS:
        items = []
        for o, forced in kit.objs:
            fp = fparts[o.name]
            mi = np.empty(len(o.data.polygons), np.int64)
            o.data.polygons.foreach_get('material_index', mi)
            alpha = np.array([(o.material_slots[i].material.name.startswith(ALPHA_PREFIX) if i < len(o.material_slots) and o.material_slots[i].material else False) for i in mi], bool)
            mask = (fp == part) & ~alpha
            if mask.any():
                items.append((o, mask))
        if items:
            mats[part] = bake_part(kit, part, items, res, os.path.join(TMP, '%s_%s' % (kit.cid, part)))
    parts = {}
    for part in PARTS:
        pieces = []
        for o, forced in kit.objs:
            fp = fparts[o.name]
            if not (fp == part).any():
                continue
            o2 = o.copy()
            o2.data = o.data.copy()
            bpy.context.scene.collection.objects.link(o2)
            mi = np.empty(len(o2.data.polygons), np.int64)
            o2.data.polygons.foreach_get('material_index', mi)
            # opaque faces -> the part atlas material
            slot_alpha = [bool(s.material and s.material.name.startswith(ALPHA_PREFIX)) for s in o2.material_slots]
            if part in mats:
                o2.data.materials.append(mats[part])
                k = len(o2.data.materials) - 1
                nmi = np.array([k if not (i < len(slot_alpha) and slot_alpha[i]) else i for i in mi])
                o2.data.polygons.foreach_set('material_index', nmi)
            delete_faces(o2, fp != part)
            if 'src' in o2.data.uv_layers:
                o2.data.uv_layers.remove(o2.data.uv_layers['src'])
            pieces.append(o2)
        if not pieces:
            continue
        j = C.join(pieces, 'part_' + part)
        # drop unused slots
        used = {p.material_index for p in j.data.polygons}
        for i in reversed(range(len(j.data.materials))):
            if i not in used:
                C.set_active(j)
                j.active_material_index = i
                bpy.ops.object.material_slot_remove()
        bind(j, arm)
        parts[part] = j
    for o, forced in kit.objs:
        bpy.data.objects.remove(o, do_unlink=True)
    return parts


def export(path, arm, parts):
    bpy.ops.object.select_all(action='DESELECT')
    arm.select_set(True)
    for o in parts.values():
        o.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_yup=True,
                              export_animations=False, export_skins=True, export_cameras=False, export_lights=False,
                              export_materials='EXPORT', export_image_format='AUTO', export_jpeg_quality=90,
                              export_apply=False, export_def_bones=False, export_leaf_bone=False)

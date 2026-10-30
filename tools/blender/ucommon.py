"""Helpers for converting the user-supplied weapon models (E:/Terraform_Automation/New/...) into the weapon model
contract (CLAUDE.md "Weapons"). Each build function in uweapons_*.py:
    load(src) -> flatten() -> orient() -> scale_len() -> clean-up -> split parts -> origin at grip -> root + empties
    -> shrink_textures() -> export(id)
Sketchfab exports carry FBX unit scales, nested empties, shared mesh data and stray helpers; flatten() bakes every mesh
into world space (skinned meshes at their rest pose, vertex groups kept) and deletes everything else.
All coordinates after orient() are Blender weapon space: +Y muzzle, +Z up, +X right, metres."""
import math, os, sys
import bpy, bmesh
import numpy as np
from mathutils import Vector, Matrix

SRC = 'E:/Terraform_Automation/New'
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(REPO, 'public', 'models', 'weapons')
# Export quality. 'hi' (default): the first-person model keeps the source detail (no decimation, textures up to 2048 px,
# capped at 1024 for GPU memory) and export() also writes <id>_lod.glb (<= LOD_TRIS, 512 px) for third person.
# UQ=lo restores the old budget behaviour (decimate as the build asks, textures as the build asks, no LOD file).
HI = os.environ.get('UQ', 'hi') == 'hi'
LOD_TRIS, LOD_TEX = 12000, 512

AX = {'+X': Vector((1, 0, 0)), '-X': Vector((-1, 0, 0)), '+Y': Vector((0, 1, 0)), '-Y': Vector((0, -1, 0)),
      '+Z': Vector((0, 0, 1)), '-Z': Vector((0, 0, -1))}


def load(src):
    """Factory-empty scene with the source GLB imported (src relative to SRC or absolute)."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    p = src if os.path.isabs(src) else os.path.join(SRC, src)
    bpy.ops.import_scene.gltf(filepath=p)
    for o in list(bpy.data.objects):
        if o.type in ('LIGHT', 'CAMERA') or o.name.startswith('Icosphere'):
            bpy.data.objects.remove(o, do_unlink=True)


def meshes():
    return [o for o in bpy.data.objects if o.type == 'MESH']


def flatten():
    """Every mesh in world space with identity transform, no parents; armatures (at rest pose) and empties deleted.
    Vertex groups survive (use split_groups() to cut a skinned mesh into parts). Negative scales flip winding back."""
    for a in bpy.data.objects:
        if a.type == 'ARMATURE':
            a.data.pose_position = 'REST'
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    for o in meshes():
        mw = o.matrix_world.copy()
        if any(m.type == 'ARMATURE' for m in o.modifiers):
            e = o.evaluated_get(dg)
            me = bpy.data.meshes.new_from_object(e, preserve_all_data_layers=True, depsgraph=dg)
            # new_from_object drops vertex groups on the mesh copy only for the object; copy the weights back
            o.data = me
            for m in list(o.modifiers):
                o.modifiers.remove(m)
        elif o.data.users > 1:
            o.data = o.data.copy()
        o.parent = None
        o.matrix_world = Matrix.Identity(4)
        o.data.transform(mw)
        if mw.determinant() < 0:
            bm = bmesh.new(); bm.from_mesh(o.data)
            bmesh.ops.reverse_faces(bm, faces=bm.faces)
            bm.to_mesh(o.data); bm.free()
        o.data.update()
    for o in list(bpy.data.objects):
        if o.type != 'MESH':
            bpy.data.objects.remove(o, do_unlink=True)


def xform(M, objs=None):
    for o in objs or meshes():
        o.data.transform(M); o.data.update()


def orient(fwd, up):
    """Rotate so the source axis `fwd` (e.g. '-X') becomes +Y (muzzle) and `up` becomes +Z."""
    f, u = AX[fwd], AX[up]
    r = f.cross(u)
    S = Matrix((r, f, u)).to_4x4()  # rows: source axes that map to X, Y, Z
    xform(S)


def rot(axis, deg, objs=None):
    xform(Matrix.Rotation(math.radians(deg), 4, axis), objs)


def bounds(objs=None):
    P = []
    for o in objs or meshes():
        if not len(o.data.vertices):
            continue
        co = np.empty(len(o.data.vertices) * 3, np.float32); o.data.vertices.foreach_get('co', co)
        P.append(co.reshape(-1, 3) @ np.array(o.matrix_world)[:3, :3].T + np.array(o.matrix_world)[:3, 3])
    P = np.concatenate(P)
    return Vector(P.min(0)), Vector(P.max(0))


def scale_len(length, axis=1, objs=None):
    """Uniform scale so the extent along `axis` (default Y, after orient) equals `length` metres."""
    lo, hi = bounds(objs)
    k = length / (hi[axis] - lo[axis])
    xform(Matrix.Scale(k, 4), objs or meshes())
    return k


def move(v, objs=None):
    """Translate geometry by v."""
    xform(Matrix.Translation(Vector(v)), objs)


def join(objs, name):
    objs = [o for o in objs if o is not None]
    if not objs:
        return None
    if len(objs) > 1:
        with bpy.context.temp_override(active_object=objs[0], selected_editable_objects=objs, selected_objects=objs):
            bpy.ops.object.join()
    o = objs[0]
    o.name = name; o.data.name = name
    return o


def join_all(name):
    return join(meshes(), name)


def _inside(c, lo, hi):
    return all(lo[i] <= c[i] <= hi[i] for i in range(3))


def split(o, lo, hi, name, mode='island'):
    """Cut the part of mesh `o` inside the box lo..hi (weapon space) into a new object `name`.
    mode 'island': whole connected pieces whose centre lies in the box; 'face': faces whose centre lies in it;
    'vert': faces with all vertices in it."""
    lo, hi = Vector(lo), Vector(hi)
    bm = bmesh.new(); bm.from_mesh(o.data)
    bm.faces.ensure_lookup_table()
    sel = set()
    if mode == 'island':
        seen = set()
        for f in bm.faces:
            if f.index in seen:
                continue
            isl, stack = [], [f]; seen.add(f.index)
            while stack:
                g = stack.pop(); isl.append(g)
                for e in g.edges:
                    for h in e.link_faces:
                        if h.index not in seen:
                            seen.add(h.index); stack.append(h)
            vs = {v for g in isl for v in g.verts}
            c = sum((v.co for v in vs), Vector()) / len(vs)
            if _inside(c, lo, hi):
                sel.update(g.index for g in isl)
    elif mode == 'face':
        sel = {f.index for f in bm.faces if _inside(f.calc_center_median(), lo, hi)}
    else:
        sel = {f.index for f in bm.faces if all(_inside(v.co, lo, hi) for v in f.verts)}
    bm.free()
    return split_faces(o, sel, name)


def split_faces(o, face_ids, name):
    """Move the faces `face_ids` of mesh `o` into a new object `name` (same transform, materials, vertex groups)."""
    if not face_ids:
        print('SPLIT EMPTY', name); return None
    face_ids = set(face_ids)
    me = o.data
    nm = me.copy(); nm.name = name
    n = bpy.data.objects.new(name, nm); bpy.context.scene.collection.objects.link(n)
    n.matrix_world = o.matrix_world.copy()
    for g in o.vertex_groups:
        if g.name not in n.vertex_groups:
            n.vertex_groups.new(name=g.name)
    for mesh, keep in ((nm, True), (me, False)):
        bm = bmesh.new(); bm.from_mesh(mesh); bm.faces.ensure_lookup_table()
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if (f.index in face_ids) != keep], context='FACES')
        bm.to_mesh(mesh); bm.free(); mesh.update()
    return n


def islands_pos(o, eps=0.0003):
    """Connected pieces of mesh `o` where vertices closer than ~eps count as joined (sources with unwelded triangles).
    Returns [(face_index_list, lo, hi)] with weapon-space bounding boxes."""
    me = o.data
    n = len(me.vertices)
    co = np.empty(n * 3, np.float32); me.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
    key = np.round(co / eps).astype(np.int64)
    _, vid = np.unique(key, axis=0, return_inverse=True)
    vid = vid.ravel()
    par = list(range(len(_)))
    def find(i):
        while par[i] != i:
            par[i] = par[par[i]]; i = par[i]
        return i
    for p in me.polygons:
        vs = [vid[v] for v in p.vertices]
        r0 = find(vs[0])
        for v in vs[1:]:
            r = find(v)
            if r != r0:
                par[r] = r0
    groups = {}
    for p in me.polygons:
        groups.setdefault(find(vid[p.vertices[0]]), []).append(p.index)
    out = []
    for faces in groups.values():
        vs = sorted({v for f in faces for v in me.polygons[f].vertices})
        P = co[vs]
        out.append((faces, Vector(P.min(0)), Vector(P.max(0))))
    return out


def split_pos(o, pred, name, eps=0.0003):
    """Cut every position-welded island of `o` for which pred(lo, hi) is true (lo/hi = island bbox) into `name`."""
    sel = set()
    for faces, lo, hi in islands_pos(o, eps):
        if pred(lo, hi):
            sel.update(faces)
    return split_faces(o, sel, name)


def in_box(lo, hi, b0, b1):
    """Island bbox centre inside the box b0..b1 (helper for split_pos predicates)."""
    c = (lo + hi) / 2
    return all(b0[i] <= c[i] <= b1[i] for i in range(3))


def split_groups(o, groups, name, thresh=0.5):
    """Cut the faces of a (flattened, skinned) mesh whose vertices are weighted mainly to any of `groups`."""
    idx = {o.vertex_groups[g].index for g in groups if g in o.vertex_groups}
    vsel = set()
    for v in o.data.vertices:
        w = sum(g.weight for g in v.groups if g.group in idx)
        if w >= thresh:
            vsel.add(v.index)
    faces = {p.index for p in o.data.polygons if all(i in vsel for i in p.vertices)}
    return split_faces(o, faces, name)


def delete_box(lo, hi, objs=None, mode='island'):
    """Delete geometry inside a box (extra props in the source scene: spare rockets, second grenades...)."""
    for o in list(objs or meshes()):
        part = split(o, lo, hi, o.name + '_del', mode)
        if part:
            bpy.data.objects.remove(part, do_unlink=True)
    for o in list(meshes()):
        if not len(o.data.polygons):
            bpy.data.objects.remove(o, do_unlink=True)


def delete(pred):
    for o in list(meshes()):
        if pred(o):
            bpy.data.objects.remove(o, do_unlink=True)


def decimate(o, ratio):
    """Budget decimation requested by a build: skipped in HI mode (the LOD file is decimated instead)."""
    if HI:
        return
    _decimate(o, ratio)


def _decimate(o, ratio):
    m = o.modifiers.new('dec', 'DECIMATE'); m.ratio = ratio; m.use_collapse_triangulate = True
    with bpy.context.temp_override(active_object=o, object=o):
        bpy.ops.object.modifier_apply(modifier=m.name)


def set_origin(o, p):
    """Mesh origin at weapon-space point p (data shifted, object moved), keeping the geometry in place."""
    p = Vector(p)
    o.data.transform(Matrix.Translation(-p)); o.data.update()
    o.location = p


def root(id_):
    r = bpy.data.objects.new(id_, None); bpy.context.scene.collection.objects.link(r)
    r.empty_display_size = 0.05
    return r


def parent(child, par):
    """Parent keeping the world transform (parents here are never rotated or scaled)."""
    bpy.context.view_layer.update()
    wm = child.matrix_world.copy()
    child.parent = par
    child.matrix_parent_inverse = Matrix.Identity(4)
    child.matrix_world = wm


def empty(name, p, par):
    e = bpy.data.objects.new(name, None); bpy.context.scene.collection.objects.link(e)
    e.empty_display_size = 0.01
    e.location = Vector(p)
    parent(e, par)
    e.matrix_world = Matrix.Translation(Vector(p))
    return e


def tris(objs=None):
    return sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objs or meshes())


def shrink_textures(max_px=1024, normal_px=None):
    """Downscale every image above max_px (glTF exporter then re-encodes them)."""
    if HI:
        n = sum(1 for i in bpy.data.images if i.size[0] and i.users)
        # 1024 px: 2048 sets pushed laptop GPUs over their texture budget (white weapons / lost WebGL context).
        max_px = 1024
        normal_px = None
    for img in bpy.data.images:
        if not img.size[0]:
            continue
        lim = max_px
        if normal_px and ('normal' in img.name.lower() or any(
                n.type == 'NORMAL_MAP' and n.inputs['Color'].links and n.inputs['Color'].links[0].from_node.image == img
                for m in bpy.data.materials if m.use_nodes for n in m.node_tree.nodes)):
            lim = normal_px
        w, h = img.size
        if max(w, h) > lim:
            k = lim / max(w, h)
            img.scale(max(1, int(w * k)), max(1, int(h * k)))
    for m in bpy.data.materials:
        m.use_backface_culling = False


def clean_materials():
    """Drop unused materials/images so they do not end up in the GLB."""
    for m in list(bpy.data.materials):
        if not m.users:
            bpy.data.materials.remove(m)
    for i in list(bpy.data.images):
        if not i.users:
            bpy.data.images.remove(i)


def _write(path, keep, fmt, quality):
    for o in bpy.data.objects:
        o.select_set(o in keep)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=True, export_yup=True,
                              export_cameras=False, export_lights=False, export_materials='EXPORT',
                              export_image_format=fmt, export_image_quality=quality, export_tangents=True,
                              export_extras=False, export_animations=False, export_skins=False)
    print('EXPORTED', path, round(os.path.getsize(path) / 1e6, 2), 'MB', tris([o for o in keep if o.type == 'MESH']), 'tris')


def export(id_, path=None, fmt='WEBP', quality=None):
    path = path or os.path.join(OUT, f'{id_}.glb')
    r = bpy.data.objects[id_]
    keep = {r} | set(r.children_recursive)
    clean_materials()
    _write(path, keep, fmt, quality or (95 if HI else 88))
    report(r)
    if HI:
        # Third-person / world copy: decimated to LOD_TRIS, LOD_TEX textures.
        ms = [o for o in keep if o.type == 'MESH']
        t = tris(ms)
        if t > LOD_TRIS:
            for o in ms:
                _decimate(o, max(0.05, LOD_TRIS / t))
        for img in bpy.data.images:
            if img.size[0] and max(img.size) > LOD_TEX:
                k = LOD_TEX / max(img.size); img.scale(max(1, int(img.size[0] * k)), max(1, int(img.size[1] * k)))
        _write(path[:-4] + '_lod.glb', keep, fmt, 85)
    return path


def report(r):
    """Print the contract nodes (weapon space) for checking."""
    for o in [r] + sorted(r.children_recursive, key=lambda x: x.name):
        p = o.matrix_world.translation
        extra = ''
        if o.type == 'MESH':
            lo, hi = bounds([o]); extra = f' bbox {tuple(round(v, 3) for v in lo)}..{tuple(round(v, 3) for v in hi)}'
        print(f'  NODE {o.name:12s} {o.type:5s} ({p.x:+.4f}, {p.y:+.4f}, {p.z:+.4f}) parent={o.parent.name if o.parent else "-"}{extra}')


def ortho(path, view='side', ppm=1600, pad=0.03, marks=(), objs=None):
    """Orthographic Workbench render of the current meshes with a metric grid for reading coordinates off the image.
    view 'side' (from +X: right = +Y muzzle, up = +Z), 'top' (from +Z: right = +Y, up = -X... i.e. left side up),
    'front' (from +Y looking back: right = -X, up = +Z), 'back' (from -Y: right = +X, up = +Z).
    Grid: thin line every 1 cm, medium every 5 cm, bright every 10 cm; red lines through the origin.
    marks: [(point, (r,g,b))] drawn as 7 px squares (e.g. the contract empties)."""
    lo, hi = bounds(objs)
    lo -= Vector((pad,) * 3); hi += Vector((pad,) * 3)
    # (right axis index, sign), (up axis index, sign), camera direction
    V = {'side': ((1, 1), (2, 1), Vector((1, 0, 0))), 'top': ((1, 1), (0, -1), Vector((0, 0, 1))),
         'front': ((0, -1), (2, 1), Vector((0, 1, 0))), 'back': ((0, 1), (2, 1), Vector((0, -1, 0)))}
    (ri, rs), (ui, us), d = V[view]
    wr, wu = hi[ri] - lo[ri], hi[ui] - lo[ui]
    W, H = int(wr * ppm), int(wu * ppm)
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_WORKBENCH'
    sc.display.shading.light = 'STUDIO'; sc.display.shading.color_type = 'TEXTURE'
    sc.display.shading.show_cavity = True
    sc.render.resolution_x, sc.render.resolution_y = W, H
    sc.render.film_transparent = False
    sc.view_settings.view_transform = 'Standard'
    w = bpy.data.worlds.get('ow') or bpy.data.worlds.new('ow'); sc.world = w; w.color = (0.55, 0.55, 0.55)
    cam = bpy.data.objects.get('ortho_cam')
    if not cam:
        cam = bpy.data.objects.new('ortho_cam', bpy.data.cameras.new('ortho_cam')); sc.collection.objects.link(cam)
    sc.camera = cam
    cam.data.type = 'ORTHO'; cam.data.ortho_scale = max(wr, wu); cam.data.clip_end = 100
    c = (lo + hi) / 2
    cam.location = c + d * 10
    up = Vector((0, 0, 0)); up[ui] = us
    right = Vector((0, 0, 0)); right[ri] = rs
    # camera basis: local X = screen right, Y = screen up, Z = towards the viewer (it looks down its -Z)
    cam.rotation_euler = Matrix((right, up, d)).transposed().to_euler()
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(path); px = np.array(img.pixels[:], np.float32).reshape(img.size[1], img.size[0], 4)
    Hh, Ww = px.shape[:2]
    # world coordinate -> pixel (pixel rows go bottom-up in Blender images)
    s = max(wr, wu)
    def to_px(val, i, sign, n, ext):
        # camera frame spans s metres along the longer image side, centred on c
        span = s * (n / max(Ww, Hh))
        return int(((val - c[i]) * sign / span + 0.5) * n)
    for step, col, a in ((0.01, (0.8, 0.8, 0.8), 0.18), (0.05, (1, 1, 0.6), 0.35), (0.1, (1, 1, 0.2), 0.7)):
        for i, sign, n, axis in ((ri, rs, Ww, 1), (ui, us, Hh, 0)):
            v0, v1 = lo[i], hi[i]
            k = math.ceil(v0 / step)
            while k * step <= v1:
                p = to_px(k * step, i, sign, n, None)
                if 0 <= p < n:
                    if axis == 1:
                        px[:, p, :3] = px[:, p, :3] * (1 - a) + np.array(col) * a
                    else:
                        px[p, :, :3] = px[p, :, :3] * (1 - a) + np.array(col) * a
                k += 1
    for i, sign, n, axis in ((ri, rs, Ww, 1), (ui, us, Hh, 0)):
        p = to_px(0.0, i, sign, n, None)
        if 0 <= p < n:
            if axis == 1: px[:, max(0, p - 1):p + 1, :3] = (1, 0, 0)
            else: px[max(0, p - 1):p + 1, :, :3] = (1, 0, 0)
    for pt, col in marks:
        pt = Vector(pt)
        x, y = to_px(pt[ri], ri, rs, Ww, None), to_px(pt[ui], ui, us, Hh, None)
        px[max(0, y - 3):y + 4, max(0, x - 3):x + 4, :3] = col
    img.pixels[:] = px.ravel()
    img.filepath_raw = path; img.file_format = 'PNG'; img.save()
    bpy.data.images.remove(img)
    print(f'ORTHO {view} {path} {Ww}x{Hh}px  right=+{"XYZ"[ri]}*{rs} up={"XYZ"[ui]}*{us}  '
          f'{ppm} px/m  centre ({c.x:.3f},{c.y:.3f},{c.z:.3f})')

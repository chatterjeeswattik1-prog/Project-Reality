"""Extra helpers for the vehicle build script (tools/blender/vehicles.py).
Kept apart from common.py (shared by the other build scripts). Blender 4.5, Z up, +Y forward, metres."""
import math
import bpy
import bmesh
import numpy as np
from mathutils import Vector, Matrix
from common import box, cyl, side_prism, prism, attach, empty

# ------------------------------------------------------------------ object utilities
def desel():
    for o in bpy.context.selected_objects:
        o.select_set(False)

def sp(profile, width, m=None, x=0, bevel=0.0, name=None):
    """side_prism without stray selections (side_prism applies transforms to every selected object)."""
    desel()
    o = side_prism(profile, width, m, None, x, bevel, name)
    desel()
    return o

def xz_prism(points, y0, y1, m=None, bevel=0.0, name=None):
    """Extrude a front-view outline (x, z points) along Y from y0 to y1."""
    desel()
    o = prism([(x, z) for x, z in points], y1 - y0, m, None, (0, 0, 0), 0, name)
    # Prism is built in XY extruded along +Z; rotate +90 about X so (x, y_local) -> (x, z) and the extrusion runs along -Y.
    o.rotation_euler = (math.radians(90), 0, 0)
    o.location = (0, y1, 0)
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=False)
    desel()
    if bevel:
        bev(o, bevel)
    return o

def xy_prism(points, z0, z1, m=None, bevel=0.0, name=None):
    """Extrude a plan-view outline (x, y points) up from z0 to z1."""
    desel()
    o = prism(points, z1 - z0, m, None, (0, 0, z0), 0, name)
    if bevel:
        bev(o, bevel)
    return o

def bev(o, w, seg=2, angle=35, clamp=True):
    mod = o.modifiers.new('bevel', 'BEVEL')
    mod.width = w
    mod.segments = seg
    mod.limit_method = 'ANGLE'
    mod.angle_limit = math.radians(angle)
    mod.use_clamp_overlap = clamp
    return o

def bake(o):
    """Apply every modifier of a mesh object (in stack order)."""
    if o.type != 'MESH' or not o.modifiers:
        return o
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
    old = o.data
    o.modifiers.clear()
    o.data = me
    if old.users == 0:
        bpy.data.meshes.remove(old)
    return o

def boolean(t, cutters, op='DIFFERENCE', keep=False):
    """Boolean the target with one or more cutters, applied immediately (modifiers already on t are applied first)."""
    if not isinstance(cutters, (list, tuple)):
        cutters = [cutters]
    bake(t)
    for c in cutters:
        bake(c)
        mod = t.modifiers.new('bool', 'BOOLEAN')
        mod.operation = op
        mod.solver = 'EXACT'
        mod.object = c
        bake(t)
    if not keep:
        for c in cutters:
            bpy.data.objects.remove(c, do_unlink=True)
    smooth(t, 30)
    return t

def dup(o, name=None):
    c = o.copy()
    c.data = o.data.copy()
    bpy.context.scene.collection.objects.link(c)
    if name:
        c.name = name
    return c

def kill(objs):
    for o in objs:
        if o and o.name in bpy.data.objects:
            bpy.data.objects.remove(o, do_unlink=True)

def smooth(o, angle=35):
    for p in o.data.polygons:
        p.use_smooth = True
    desel()
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    try:
        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(angle))
    except Exception:
        pass
    o.select_set(False)
    return o

def set_mat(o, m):
    o.data.materials.clear()
    o.data.materials.append(m)
    for p in o.data.polygons:
        p.material_index = 0
    return o

def group(name, parts, pivot=(0, 0, 0), parent=None):
    """Join mesh parts (modelled in world coordinates) into one mesh object whose origin is the pivot."""
    me = bpy.data.meshes.new(name)
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    o.location = pivot
    parts = [p for p in parts if p is not None and p.name in bpy.data.objects and p.type == 'MESH']
    for p in parts:
        bake(p)
        if p.parent:
            mw = p.matrix_world.copy()
            p.parent = None
            p.matrix_world = mw
    bpy.context.view_layer.update()
    desel()
    for p in parts:
        p.select_set(True)
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    if parts:
        bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    o.name = name
    o.data.name = name
    desel()
    if parent is not None:
        attach(o, parent)
    return o

def strut(p0, p1, w, t, m=None, out=(1, 0, 0), bevel=0.0, name=None):
    """Box running from p0 to p1; t is the size along `out` (e.g. the panel normal), w across."""
    p0, p1 = Vector(p0), Vector(p1)
    d = p1 - p0
    L = d.length
    z = d.normalized()
    x = Vector(out)
    x = (x - x.dot(z) * z).normalized()
    y = z.cross(x)
    c = (p0 + p1) / 2
    M = Matrix((
        (x[0] * t, y[0] * w, z[0] * L, c[0]),
        (x[1] * t, y[1] * w, z[1] * L, c[1]),
        (x[2] * t, y[2] * w, z[2] * L, c[2]),
        (0, 0, 0, 1)))
    mb = MB()
    mb.box(M, m)
    o = mb.obj(name or 'strut', (p0 + p1) / 2)
    if bevel:
        bev(o, bevel)
    return o

def pipe(points, r, m=None, sides=8, name=None, closed=False):
    """Tube along a polyline (curve with a round bevel, converted to a mesh)."""
    cu = bpy.data.curves.new(name or 'pipe', 'CURVE')
    cu.dimensions = '3D'
    cu.bevel_depth = r
    cu.bevel_resolution = max(0, sides // 4 - 1)
    cu.use_fill_caps = True
    s = cu.splines.new('POLY')
    s.points.add(len(points) - 1)
    for i, p in enumerate(points):
        s.points[i].co = (p[0], p[1], p[2], 1)
    s.use_cyclic_u = closed
    co = bpy.data.objects.new('tmp_curve', cu)
    bpy.context.scene.collection.objects.link(co)
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(co.evaluated_get(dg))
    bpy.data.objects.remove(co, do_unlink=True)
    bpy.data.curves.remove(cu)
    o = bpy.data.objects.new(name or 'pipe', me)
    bpy.context.scene.collection.objects.link(o)
    if m:
        set_mat(o, m)
    smooth(o, 50)
    return o

def round_poly(pts, r, n=3):
    """Round the inner corners of an open polyline (3D points) with n segments each."""
    pts = [Vector(p) for p in pts]
    out = [pts[0]]
    for i in range(1, len(pts) - 1):
        a, b, c = pts[i - 1], pts[i], pts[i + 1]
        d1, d2 = (a - b), (c - b)
        rr = min(r, d1.length * 0.45, d2.length * 0.45)
        p0 = b + d1.normalized() * rr
        p1 = b + d2.normalized() * rr
        for k in range(n + 1):
            t = k / n
            out.append((1 - t) ** 2 * p0 + 2 * (1 - t) * t * b + t * t * p1)
    out.append(pts[-1])
    return [tuple(p) for p in out]

def offset_poly(pts, d):
    """Offset a closed 2D polygon inwards by d (mitred corners)."""
    n = len(pts)
    area = sum(pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1] for i in range(n)) / 2
    sg = 1 if area > 0 else -1
    lines = []
    for i in range(n):
        p = np.array(pts[i], float)
        q = np.array(pts[(i + 1) % n], float)
        e = (q - p) / np.linalg.norm(q - p)
        nrm = np.array([-e[1], e[0]]) * sg
        lines.append((p + nrm * d, e))
    out = []
    for i in range(n):
        p1, e1 = lines[i - 1]
        p2, e2 = lines[i]
        A = np.array([[e1[0], -e2[0]], [e1[1], -e2[1]]])
        if abs(np.linalg.det(A)) < 1e-9:
            out.append(tuple(p2))
            continue
        t, s = np.linalg.solve(A, p2 - p1)
        out.append(tuple(p1 + e1 * t))
    return out

# ------------------------------------------------------------------ bmesh builder
def T(x=0, y=0, z=0):
    return Matrix.Translation((x, y, z))

def R(ax, deg):
    return Matrix.Rotation(math.radians(deg), 4, ax)

def S(x, y, z):
    return Matrix.Diagonal((x, y, z, 1))

AX_Y = R('Z', 90)          # lathe axis X -> Y
AX_Z = R('Y', -90)         # lathe axis X -> Z

class MB:
    """Collects geometry in one bmesh with per-face materials."""
    def __init__(self):
        self.bm = bmesh.new()
        self.mats = []

    def mi(self, m):
        if m is None:
            return 0
        if m not in self.mats:
            self.mats.append(m)
        return self.mats.index(m)

    def box(self, M, m=None):
        r = bmesh.ops.create_cube(self.bm, size=1.0, matrix=M)
        idx = self.mi(m)
        fs = {f for v in r['verts'] for f in v.link_faces}
        for f in fs:
            f.material_index = idx
        return r

    def lathe(self, prof, segs, M=Matrix(), m=None, closed=False, cap0=False, cap1=False, a0=0.0, a1=360.0):
        """Revolve (r, a) profile points about the local X axis (a along X)."""
        bm = self.bm
        full = abs(a1 - a0) >= 359.99
        n = segs if full else segs + 1
        rings = []
        for i in range(n):
            t = math.radians(a0 + (a1 - a0) * i / segs)
            ring = [bm.verts.new(M @ Vector((a, r * math.cos(t), r * math.sin(t)))) for r, a in prof]
            rings.append(ring)
        idx = self.mi(m)
        P = len(prof)
        segj = P if closed else P - 1
        for i in range(segs):
            r0, r1 = rings[i], rings[(i + 1) % n]
            for j in range(segj):
                j1 = (j + 1) % P
                f = bm.faces.new((r0[j], r1[j], r1[j1], r0[j1]))
                f.material_index = idx
        if full and cap0:
            f = bm.faces.new([rings[i][0] for i in range(n)]); f.material_index = idx
        if full and cap1:
            f = bm.faces.new([rings[i][-1] for i in range(n)]); f.material_index = idx
        return rings

    def cyl(self, r, h, segs, M=Matrix(), m=None, r2=None):
        """Capped cylinder along local X, centred."""
        r2 = r if r2 is None else r2
        return self.lathe([(r, -h / 2), (r2, h / 2)], segs, M, m, cap0=True, cap1=True)

    def obj(self, name, loc=(0, 0, 0), smooth_angle=35):
        bm = self.bm
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        loc = Vector(loc)
        for v in bm.verts:
            v.co -= loc
        me = bpy.data.meshes.new(name)
        bm.to_mesh(me)
        bm.free()
        for m in self.mats:
            me.materials.append(m)
        o = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(o)
        o.location = loc
        smooth(o, smooth_angle)
        return o

# ------------------------------------------------------------------ materials and textures
_cache = {}

def reset_cache():
    _cache.clear()

def pmat(name, rgb, rough=0.6, metal=0.0, img=None, alpha=None, emit=None, cull=False):
    """Principled material (glTF metallic-roughness). rgb is linear. img (optional) drives Base Color."""
    if name in _cache:
        return _cache[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*rgb, 1)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    if img is not None:
        tex = nt.nodes.new('ShaderNodeTexImage')
        tex.image = img
        tex.location = (-400, 200)
        nt.links.new(tex.outputs['Color'], b.inputs['Base Color'])
    if alpha is not None:
        b.inputs['Alpha'].default_value = alpha
        try:
            m.surface_render_method = 'BLENDED'
        except Exception:
            m.blend_method = 'BLEND'
    if emit:
        b.inputs['Emission Color'].default_value = (*emit, 1)
        b.inputs['Emission Strength'].default_value = 1.0
    m.use_backface_culling = cull
    _cache[name] = m
    return m

def _fbm(n, seed, beta=2.2, sx=1.0, sy=1.0):
    """Tileable fractal noise in [0,1] (power-law filtered white noise); sx/sy > 1 squash features along that axis."""
    rng = np.random.default_rng(seed)
    w = rng.standard_normal((n, n))
    F = np.fft.fft2(w)
    fy = np.fft.fftfreq(n)[:, None] * sy
    fx = np.fft.fftfreq(n)[None, :] * sx
    k = np.sqrt(fx * fx + fy * fy)
    k[0, 0] = 1.0
    F = F / k ** (beta / 2)
    F[0, 0] = 0
    a = np.real(np.fft.ifft2(F))
    lo, hi = np.percentile(a, 1), np.percentile(a, 99)
    return np.clip((a - lo) / (hi - lo), 0, 1)

def _sstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)

def _to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)

def grime_image(name, base, size=1024, seed=1, dirt=(0.16, 0.11, 0.065), dust=(0.42, 0.35, 0.24),
                dirt_amt=0.75, dust_amt=0.35, rust=0.0, rustc=(0.16, 0.055, 0.018), fade=0.0, char=False):
    """Paint texture laid out for auto_uv(): rows 0..0.8 are height 0..H on side faces (mud low, streaks),
    rows 0.84..1 are upward faces (dust), u tiles along the surface. Colours linear; stored as sRGB."""
    n = size
    v = (np.arange(n) + 0.5)[:, None] / n * np.ones((1, n))
    # Upward faces are squeezed into a thin band (v 0.84..1 spans the vehicle width), so their noise is generated
    # squashed along v to come out roughly isotropic on the model.
    top = v > 0.83
    blot = np.where(top, _fbm(n, seed + 5, 2.6, sy=0.18), _fbm(n, seed, 2.6))
    grain = np.where(top, _fbm(n, seed + 6, 1.2, sy=0.18), _fbm(n, seed + 1, 1.2))
    streak = _fbm(n, seed + 2, 2.0, sx=0.35, sy=4.0)       # long vertical streaks
    splat = np.where(top, _fbm(n, seed + 7, 1.6, sy=0.18), _fbm(n, seed + 3, 1.6))
    base = np.array(base)[None, None, :]
    col = base * (0.93 + 0.14 * grain[..., None]) * (0.95 + 0.1 * blot[..., None])
    h = np.clip(v / 0.8, 0, 1)
    side = (v < 0.82)[..., None]
    if char:
        # Burnt: soot black, ash grey, rust orange where the paint burnt away.
        soot = np.array((0.018, 0.016, 0.014))
        ash = np.array((0.16, 0.15, 0.14))
        rst = np.array(rustc)
        c = soot * (0.7 + 0.6 * grain[..., None])
        r = _sstep(0.42, 0.62, blot + 0.25 * (h - 0.5) + 0.25 * (grain - 0.5))[..., None]
        c = c * (1 - r) + rst * (0.6 + 0.6 * splat[..., None]) * r
        a = _sstep(0.62, 0.85, splat)[..., None] * 0.6
        c = c * (1 - a) + ash * a
        # Remnants of the original paint low down and in streaks.
        keep = (_sstep(0.66, 0.85, streak) * _sstep(0.5, 0.1, h))[..., None] * 0.35 * side
        c = c * (1 - keep) + base * 0.35 * keep
        col = c
    else:
        if fade:
            col = col * (1 - fade * blot[..., None]) + np.array((0.55, 0.55, 0.52)) * fade * blot[..., None]
        # Mud thrown up from the wheels, ragged edge.
        mud = _sstep(0.42, 0.05, h + 0.18 * (blot - 0.5) + 0.1 * (splat - 0.5)) * dirt_amt
        # Streaks running down from seams.
        mud = np.maximum(mud, _sstep(0.62, 0.85, streak) * 0.35 * dirt_amt * (1 - 0.5 * h))
        mud = mud[..., None] * side
        dirtc = np.array(dirt)[None, None, :] * (0.8 + 0.4 * splat[..., None])
        col = col * (1 - mud) + dirtc * mud
        # Dust film everywhere, heavier on top faces.
        dmask = np.where(side, dust_amt * 0.55 * blot[..., None], (dust_amt * (0.55 + 0.45 * blot))[..., None])
        col = col * (1 - dmask) + np.array(dust)[None, None, :] * dmask
        if rust:
            rr = (_sstep(0.78, 0.9, splat * 0.7 + blot * 0.3) * rust)
            rr = np.maximum(rr, _sstep(0.8, 0.93, streak) * rust * 0.7 * (1 - h))
            rr = rr[..., None]
            col = col * (1 - rr) + np.array(rustc)[None, None, :] * (0.7 + 0.6 * grain[..., None]) * rr
    px = np.ones((n, n, 4), np.float32)
    px[..., :3] = _to_srgb(col)
    img = bpy.data.images.new(name, n, n, alpha=False)
    img.pixels.foreach_set(px.ravel())
    img.pack()
    return img

def auto_uv(o, H, W, S=2.5):
    """UVs matching grime_image(): side faces get v = height / H * 0.8, top faces the dust band, u runs along the face."""
    me = o.data
    if not me.uv_layers:
        me.uv_layers.new(name='UVMap')
    uv = me.uv_layers.active.data
    mw = o.matrix_world
    rot = mw.to_3x3()
    verts = me.vertices
    for poly in me.polygons:
        n = (rot @ poly.normal).normalized()
        for li in poly.loop_indices:
            p = mw @ verts[me.loops[li].vertex_index].co
            if n.z > 0.7:
                u = p.y / S
                v = 0.86 + 0.12 * min(1, max(0, 0.5 + p.x / W))
            elif n.z < -0.7:
                u, v = p.y / S, 0.01
            else:
                if abs(n.x) >= abs(n.y):
                    u = p.y / S + (0.0 if n.x > 0 else 0.5)
                else:
                    u = p.x / S + (0.25 if n.y > 0 else 0.75)
                v = min(1, max(0, p.z / H)) * 0.8
            uv[li].uv = (u, v)

def tri_count(o):
    total = 0
    def walk(x):
        nonlocal total
        if x.type == 'MESH':
            bake(x)
            x.data.calc_loop_triangles()
            total += len(x.data.loop_triangles)
        for c in x.children:
            walk(c)
    walk(o)
    return total

def vexport(path, root):
    desel()
    def sel(o):
        o.select_set(True)
        for c in o.children:
            sel(c)
    sel(root)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=True, export_yup=True,
                              export_extras=True, export_cameras=False, export_lights=False, export_materials='EXPORT',
                              export_image_format='JPEG', export_jpeg_quality=88)

def plate(outline, thick, cx, cy, ang, m=None, cuts=(), bevel=0.0):
    """Armour plate: outline (u, z) in the plate plane, thickness along the plate normal; built facing +Y at the
    origin, cut by `cuts` (boxes given as (u, z, w, h)), then turned by -ang degrees about Z and moved to (cx, cy)."""
    o = xz_prism(outline, -thick / 2, thick / 2, m)
    cs = []
    for u, z, w, h in cuts:
        cs.append(box((w, thick * 4, h), (u, 0, z), None, bevel=0))
    if cs:
        boolean(o, cs)
    o.rotation_euler = (0, 0, math.radians(-ang))
    o.location = (cx, cy, 0)
    desel()
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    desel()
    if bevel:
        bev(o, bevel, 1)
    return o

def limit_tris(o, target):
    """Collapse-decimate a mesh object down to about `target` triangles (used on wrecks)."""
    bake(o)
    o.data.calc_loop_triangles()
    n = len(o.data.loop_triangles)
    if n <= target:
        return o
    mod = o.modifiers.new('dec', 'DECIMATE')
    mod.decimate_type = 'COLLAPSE'
    mod.ratio = target / n * 0.97
    bake(o)
    return o

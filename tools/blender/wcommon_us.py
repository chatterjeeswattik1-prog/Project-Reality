"""Mesh-building helpers for the US weapon builder (tools/blender/weapons_us.py).

Everything is modelled in MILLIMETRES in a "weapon frame" (bore axis = +Y, z = 0 on the bore, +X right)
and converted to metres when the parts are turned into Blender objects. Geometry is accumulated in plain
vertex/face lists per Part (one Part = one exported mesh object, e.g. body, mag, cover, bolt) so a gun with
hundreds of pieces costs a handful of objects. Bevels are baked with bmesh, normals are recalculated per
island, edges sharper than SHARP_DEG are marked sharp and everything else is smooth shaded, and UVs are box
projected so the small procedural noise textures tile over every surface.
"""
import math
import os
import bpy
import bmesh
import numpy as np
from mathutils import Matrix, Vector, Euler

MM = 0.001
SHARP_DEG = 38.0
UV_SCALE = 0.12  # metres per UV tile


def TM(loc=(0, 0, 0), rot=(0, 0, 0)):
    """Matrix from a location and an XYZ euler in degrees."""
    return Matrix.Translation(Vector(loc)) @ Euler([math.radians(a) for a in rot], 'XYZ').to_matrix().to_4x4()


def rr_pts(w, h, r, n=3):
    """Rounded rectangle (w along u, h along v) as a CCW list of (u, v)."""
    r = max(0.0, min(r, min(w, h) * 0.5 * 0.985))
    hw, hh = w / 2, h / 2
    if r < 1e-6:
        return [(hw, -hh), (hw, hh), (-hw, hh), (-hw, -hh)]
    pts = []
    for cx, cy, a0 in ((hw - r, -hh + r, -90), (hw - r, hh - r, 0), (-hw + r, hh - r, 90), (-hw + r, -hh + r, 180)):
        for i in range(n + 1):
            a = math.radians(a0 + 90 * i / n)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def ell_pts(w, h, n=16):
    return [(w / 2 * math.cos(2 * math.pi * i / n), h / 2 * math.sin(2 * math.pi * i / n)) for i in range(n)]


def offset_path(path, t0, t1=None):
    """Turn a 2D polyline into a closed polygon of thickness (t0 one side, t1 other)."""
    t1 = t0 if t1 is None else t1
    left, right = [], []
    for i, p in enumerate(path):
        a = path[max(i - 1, 0)]; b = path[min(i + 1, len(path) - 1)]
        dx, dy = b[0] - a[0], b[1] - a[1]
        L = math.hypot(dx, dy) or 1
        nx, ny = -dy / L, dx / L
        left.append((p[0] + nx * t0, p[1] + ny * t0))
        right.append((p[0] - nx * t1, p[1] - ny * t1))
    return left + right[::-1]


def _cr(a, b, c, d, t):
    """Catmull-Rom between b and c."""
    t2, t3 = t * t, t * t * t
    return 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)


def _tmp_obj(part, name):
    me = bpy.data.meshes.new(name)
    me.from_pydata(part.V, [], [f for f, _ in part.F])
    for i, (_, mi) in enumerate(part.F):
        me.polygons[i].material_index = mi
    me.update()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    return o


class Part:
    """Accumulates geometry (mm) for one exported mesh object."""

    def __init__(self, name, pivot=(0, 0, 0)):
        self.name = name
        self.pivot = Vector(pivot)
        self.mats = []
        self.V = []
        self.F = []  # (indices, material index)

    # ---------------------------------------------------------------- core
    def _mi(self, m):
        if m not in self.mats:
            self.mats.append(m)
        return self.mats.index(m)

    def commit(self, t, m, mat=None, bevel=0.0, segs=2, ang=30.0):
        bmesh.ops.recalc_face_normals(t, faces=t.faces)
        if bevel > 0:
            if bevel < 1.6:
                segs = 1
            edges = [e for e in t.edges if e.is_manifold and e.calc_face_angle(0) > math.radians(ang)]
            if edges:
                bmesh.ops.bevel(t, geom=edges, offset=bevel, offset_type='OFFSET', segments=segs, profile=0.5,
                                affect='EDGES', clamp_overlap=True)
        if mat is not None:
            bmesh.ops.transform(t, matrix=mat, verts=t.verts)
        t.verts.index_update()
        base = len(self.V)
        self.V.extend(tuple(v.co) for v in t.verts)
        mi = self._mi(m)
        for f in t.faces:
            self.F.append((tuple(base + v.index for v in f.verts), mi))
        t.free()

    # ---------------------------------------------------------------- primitives
    def box(self, size, loc=(0, 0, 0), m=None, rot=(0, 0, 0), bevel=0.5, segs=2):
        t = bmesh.new()
        bmesh.ops.create_cube(t, size=1.0)
        for v in t.verts:
            v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
        self.commit(t, m, TM(loc, rot), bevel, segs)

    def box2(self, lo, hi, m=None, bevel=0.5, segs=2):
        """Axis-aligned box from min/max corners."""
        size = [hi[i] - lo[i] for i in range(3)]
        loc = [(hi[i] + lo[i]) / 2 for i in range(3)]
        self.box(size, loc, m, bevel=bevel, segs=segs)

    def cyl(self, r, depth, loc=(0, 0, 0), m=None, rot=(0, 0, 0), n=16, r2=None, bevel=0.0, segs=2):
        """Cylinder/cone along local Z."""
        t = bmesh.new()
        bmesh.ops.create_cone(t, cap_ends=True, cap_tris=False, segments=n, radius1=r,
                              radius2=r if r2 is None else r2, depth=depth)
        self.commit(t, m, TM(loc, rot), bevel, segs)

    def tube(self, r, y0, y1, x=0, z=0, m=None, n=16, r2=None, bevel=0.0):
        """Cylinder along +Y from y0 to y1."""
        self.cyl(r, y1 - y0, (x, (y0 + y1) / 2, z), m, (-90, 0, 0), n, r2, bevel)

    def cylx(self, r, x0, x1, y, z, m=None, n=12, bevel=0.0):
        """Cylinder along X (pins, screws, knobs)."""
        self.cyl(r, x1 - x0, ((x0 + x1) / 2, y, z), m, (0, 90, 0), n, None, bevel)

    def rod(self, p0, p1, r, m=None, n=10, r2=None, bevel=0.0):
        """Cylinder between two points."""
        p0, p1 = Vector(p0), Vector(p1)
        d = p1 - p0
        t = bmesh.new()
        bmesh.ops.create_cone(t, cap_ends=True, cap_tris=False, segments=n, radius1=r,
                              radius2=r if r2 is None else r2, depth=d.length)
        mat = Matrix.Translation((p0 + p1) / 2) @ d.to_track_quat('Z', 'Y').to_matrix().to_4x4()
        self.commit(t, m, mat, bevel)

    def sphere(self, r, loc=(0, 0, 0), m=None, scale=(1, 1, 1), u=16, v=10, rot=(0, 0, 0)):
        t = bmesh.new()
        bmesh.ops.create_uvsphere(t, u_segments=u, v_segments=v, radius=r)
        for vv in t.verts:
            vv.co = Vector((vv.co.x * scale[0], vv.co.y * scale[1], vv.co.z * scale[2]))
        self.commit(t, m, TM(loc, rot))

    def lathe(self, prof, m=None, loc=(0, 0, 0), rot=(0, 0, 0), n=24, closed=False, a0=0.0, a1=360.0, bevel=0.0):
        """Revolve a (y, r) profile about local Y. Angle 0 = +Z (top), 90 = +X.
        closed=True treats the profile as a closed loop (hollow parts); a0/a1 give a partial sector."""
        t = bmesh.new()
        full = abs(a1 - a0) >= 359.99
        cnt = n if full else n + 1
        angs = [math.radians(a0 + (a1 - a0) * i / n) for i in range(cnt)]
        rings = []
        for y, r in prof:
            if r <= 1e-6 and full:
                rings.append([t.verts.new((0, y, 0))])
            else:
                rings.append([t.verts.new((r * math.sin(a), y, r * math.cos(a))) for a in angs])
        pairs = list(zip(rings, rings[1:]))
        if closed:
            pairs.append((rings[-1], rings[0]))
        span = cnt if full else cnt - 1
        for A, B in pairs:
            if len(A) == 1 and len(B) == 1:
                continue
            for i in range(span):
                j = (i + 1) % cnt
                if len(A) == 1:
                    t.faces.new((A[0], B[j], B[i]))
                elif len(B) == 1:
                    t.faces.new((A[i], A[j], B[0]))
                else:
                    t.faces.new((A[i], A[j], B[j], B[i]))
        if full and not closed:
            for ring in (rings[0], rings[-1]):
                if len(ring) > 2:
                    t.faces.new(ring)
        if not full and closed:
            t.faces.new([rg[0] for rg in rings])
            t.faces.new([rg[-1] for rg in rings])
        self.commit(t, m, TM(loc, rot), bevel)

    def lathe_y(self, prof, x=0, z=0, m=None, n=24, closed=False, a0=0.0, a1=360.0, bevel=0.0):
        self.lathe(prof, m, (x, 0, z), (0, 0, 0), n, closed, a0, a1, bevel)

    def extrude(self, poly, depth, m=None, plane='x', off=0.0, bevel=0.4, segs=2, mat=None, skip_side=None):
        """Extrude a 2D polygon. plane 'x': points are (y, z), extruded across X centred on off.
        plane 'y': points (x, z) extruded along Y from off to off+depth. plane 'z': points (x, y) along Z."""
        t = bmesh.new()
        lo, hi = [], []
        for a, b in poly:
            if plane == 'x':
                lo.append(t.verts.new((off - depth / 2, a, b))); hi.append(t.verts.new((off + depth / 2, a, b)))
            elif plane == 'y':
                lo.append(t.verts.new((a, off, b))); hi.append(t.verts.new((a, off + depth, b)))
            else:
                lo.append(t.verts.new((a, b, off))); hi.append(t.verts.new((a, b, off + depth)))
        t.faces.new(lo)
        t.faces.new(hi[::-1])
        k = len(poly)
        for i in range(k):
            if i == skip_side:
                continue
            j = (i + 1) % k
            t.faces.new((lo[i], lo[j], hi[j], hi[i]))
        self.commit(t, m, mat, bevel, segs)

    def loft(self, rings, m=None, cap=True, closed_ring=True, bevel=0.0, mat=None):
        """Skin a list of 3D rings (same vertex count)."""
        t = bmesh.new()
        R = [[t.verts.new(p) for p in ring] for ring in rings]
        k = len(rings[0])
        span = k if closed_ring else k - 1
        for A, B in zip(R, R[1:]):
            for i in range(span):
                j = (i + 1) % k
                t.faces.new((A[i], A[j], B[j], B[i]))
        if cap and closed_ring:
            t.faces.new(R[0])
            t.faces.new(R[-1])
        self.commit(t, m, mat, bevel)

    def loft_y(self, secs, m=None, x=0.0, n=3, bevel=0.0):
        """Loft rounded-rect sections along Y: secs = [(y, ztop, zbot, width, corner_r[, xoff])]."""
        rings = []
        for s in secs:
            y, zt, zb, w, r = s[:5]
            xo = s[5] if len(s) > 5 else 0.0
            zc, h = (zt + zb) / 2, zt - zb
            rings.append([(x + xo + u, y, zc + v) for u, v in rr_pts(w, h, r, n)])
        self.loft(rings, m, bevel=bevel)

    def loft_axis(self, top, ang, secs, m=None, n=3, x=0.0):
        """Loft along an axis in the YZ plane starting at top=(y, z), tilted ang degrees back from vertical
        (pistol grips, magazines). secs = [(t, depth, width, r, fwd_shift)]; depth runs along the forward normal."""
        a = math.radians(ang)
        d = Vector((0, -math.sin(a), -math.cos(a)))
        nf = Vector((0, math.cos(a), -math.sin(a)))
        o = Vector((x, top[0], top[1]))
        rings = []
        for tt, dep, w, r, sh in secs:
            c = o + d * tt + nf * sh
            rings.append([tuple(c + nf * u + Vector((v, 0, 0))) for u, v in rr_pts(dep, w, r, n)])
        self.loft(rings, m)

    def axis_pt(self, top, ang, tt, sh=0.0):
        a = math.radians(ang)
        return (0.0, top[0] - math.sin(a) * tt + math.cos(a) * sh, top[1] - math.cos(a) * tt - math.sin(a) * sh)

    def torus(self, R, r, loc=(0, 0, 0), m=None, rot=(0, 0, 0), n=20, nr=8):
        """Torus around local Y (ring lies in XZ)."""
        prof = [(r * math.cos(2 * math.pi * i / nr), R + r * math.sin(2 * math.pi * i / nr)) for i in range(nr)]
        self.lathe(prof, m, loc, rot, n, closed=True)

    def loft_spline(self, secs, m=None, steps=3, x=0.0, n=4):
        """loft_y with Catmull-Rom interpolation of the section parameters (smooth stocks, grips)."""
        out = []
        k = len(secs)
        for i in range(k - 1):
            p0, p1, p2, p3 = secs[max(i - 1, 0)], secs[i], secs[i + 1], secs[min(i + 2, k - 1)]
            for st in range(steps):
                t = st / steps
                out.append(tuple(_cr(p0[j], p1[j], p2[j], p3[j], t) for j in range(len(p1))))
        out.append(secs[-1])
        self.loft_y(out, m, x, n)

    def loft_axis_spline(self, top, ang, secs, m=None, steps=3, n=4, x=0.0):
        out = []
        k = len(secs)
        for i in range(k - 1):
            p0, p1, p2, p3 = secs[max(i - 1, 0)], secs[i], secs[i + 1], secs[min(i + 2, k - 1)]
            for st in range(steps):
                t = st / steps
                out.append(tuple(_cr(p0[j], p1[j], p2[j], p3[j], t) for j in range(5)))
        out.append(secs[-1])
        self.loft_axis(top, ang, out, m, n, x)

    def merge(self, V, F, mats):
        base = len(self.V)
        self.V.extend(V)
        remap = [self._mi(mm) for mm in mats] if mats else [self._mi(None)]
        for f, mi in F:
            self.F.append((tuple(base + i for i in f), remap[min(mi, len(remap) - 1)]))

    def sub(self):
        """A scratch Part sharing this part's material list (for boolean / subsurf pieces)."""
        p = Part('tmp')
        p.mats = self.mats
        return p

    def add_cut(self, piece, cutter):
        """Merge piece minus cutter (exact boolean). Cut faces take the cutter's material."""
        A = _tmp_obj(piece, 'bool_a'); B = _tmp_obj(cutter, 'bool_b')
        mod = A.modifiers.new('b', 'BOOLEAN'); mod.operation = 'DIFFERENCE'; mod.solver = 'EXACT'; mod.object = B
        mod.use_self = True
        mod.use_hole_tolerant = True
        try:
            mod.material_mode = 'INDEX'
        except Exception:
            pass
        self._take(A)
        for o in (A, B):
            me = o.data; bpy.data.objects.remove(o, do_unlink=True); bpy.data.meshes.remove(me)

    def add_subsurf(self, piece, levels=1):
        A = _tmp_obj(piece, 'subd')
        mod = A.modifiers.new('s', 'SUBSURF'); mod.levels = levels; mod.render_levels = levels
        self._take(A)
        me = A.data; bpy.data.objects.remove(A, do_unlink=True); bpy.data.meshes.remove(me)

    def _take(self, A):
        dg = bpy.context.evaluated_depsgraph_get()
        ev = A.evaluated_get(dg)
        me = ev.to_mesh()
        V = [tuple(v.co) for v in me.vertices]
        F = [(tuple(p.vertices), p.material_index) for p in me.polygons]
        ev.to_mesh_clear()
        base = len(self.V)
        self.V.extend(V)
        for f, mi in F:
            self.F.append((tuple(base + i for i in f), mi))

    # ---------------------------------------------------------------- compound details
    def pic_rail(self, y0, y1, frame, m, pitch=10.0, base_w=15.6):
        """MIL-STD-1913 rail. frame = matrix mapping rail-local (x across, y along, z up from the deck) into
        the weapon frame. Continuous lower dovetail, 5.35 mm cross slots every 10 mm in the upper part."""
        low = [(-7.8, 0), (7.8, 0), (7.8, 2.0), (10.6, 4.8), (-10.6, 4.8), (-7.8, 2.0)]
        self.extrude(low, y1 - y0, m, 'y', y0, mat=frame)
        top = [(-10.6, 4.8), (10.6, 4.8), (10.6, 5.6), (7.8, 8.4), (-7.8, 8.4), (-10.6, 5.6)]
        n = int((y1 - y0 - 1.0) // pitch)
        start = y0 + ((y1 - y0) - (n * pitch - 5.35)) / 2
        for i in range(n):
            self.extrude(top, pitch - 5.35, m, 'y', start + i * pitch, mat=frame, skip_side=0)

    def screw(self, x, y, z, r, m, axis='x', h=1.2):
        if axis == 'x':
            self.cylx(r, x - h / 2, x + h / 2, y, z, m, 8)
        elif axis == 'z':
            self.cyl(r, h, (x, y, z), m, n=8)
        else:
            self.tube(r, y - h / 2, y + h / 2, x, z, m, 8)


# ---------------------------------------------------------------- materials / textures
def _srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def tile_noise(size, seed, beta=1.6, lo_cut=2.0):
    """Tileable fractal noise in [-1, 1] (FFT filtered, periodic by construction)."""
    rng = np.random.default_rng(seed)
    w = rng.standard_normal((size, size))
    f = np.fft.fftfreq(size) * size
    fx, fy = np.meshgrid(f, f)
    k = np.sqrt(fx * fx + fy * fy)
    k[0, 0] = 1
    filt = 1.0 / np.power(k, beta)
    filt[k < lo_cut] *= 0.4
    filt[0, 0] = 0
    n = np.real(np.fft.ifft2(np.fft.fft2(w) * filt))
    n /= (np.abs(n).max() + 1e-9)
    return n


def _image(name, rgb_arr, colorspace):
    h, w, _ = rgb_arr.shape
    img = bpy.data.images.new(name, w, h, alpha=False)
    img.colorspace_settings.name = colorspace
    px = np.ones((h, w, 4), np.float32)
    px[..., :3] = rgb_arr
    img.pixels.foreach_set(px.ravel())
    img.pack()
    return img


_MATS = {}


def clear_mats():
    _MATS.clear()
    FINISH.clear() if 'FINISH' in globals() else None


def pmat(name, rgb, rough=0.6, metal=0.0, tex=None, emit=None, seed=1):
    """Principled material; tex = dict(amp=, ramp=, speck=, size=) adds a packed tileable noise base colour
    (and a metallic-roughness map when ramp is given) for subtle finish variation."""
    if name in _MATS:
        return _MATS[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*rgb, 1)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    if emit:
        b.inputs['Emission Color'].default_value = (*emit[:3], 1)
        b.inputs['Emission Strength'].default_value = emit[3] if len(emit) > 3 else 1.0
    if tex:
        size = tex.get('size', 256)
        n1 = tile_noise(size, seed, 1.5)
        n2 = tile_noise(size, seed + 7, 0.6, 0)
        tone = 1.0 + tex.get('amp', 0.08) * (0.7 * n1 + 0.3 * n2)
        col = np.stack([np.full((size, size), c) for c in rgb], -1) * tone[..., None]
        if tex.get('speck'):
            rng = np.random.default_rng(seed + 3)
            sp = rng.random((size, size)) < tex['speck']
            sc = np.array(tex.get('speck_rgb', (0.02, 0.02, 0.02)))
            col[sp] = sc
        img = _image(name + '_col', _srgb(col), 'sRGB')
        ti = nt.nodes.new('ShaderNodeTexImage'); ti.image = img; ti.location = (-500, 200)
        nt.links.new(ti.outputs['Color'], b.inputs['Base Color'])
        if tex.get('ramp'):
            rmap = np.clip(rough + tex['ramp'] * (0.6 * n2 + 0.4 * n1), 0.05, 1)
            mr = np.stack([np.zeros_like(rmap), rmap, np.full_like(rmap, metal)], -1)
            img2 = _image(name + '_mr', mr, 'Non-Color')
            t2 = nt.nodes.new('ShaderNodeTexImage'); t2.image = img2; t2.location = (-700, -100)
            sep = nt.nodes.new('ShaderNodeSeparateColor'); sep.location = (-400, -100)
            nt.links.new(t2.outputs['Color'], sep.inputs['Color'])
            nt.links.new(sep.outputs['Green'], b.inputs['Roughness'])
            nt.links.new(sep.outputs['Blue'], b.inputs['Metallic'])
    _MATS[name] = m
    return m


# ---------------------------------------------------------------- objects
def make_object(part, offset, parent):
    """Build a Blender mesh object from a Part. offset (mm) is subtracted from everything (the weapon's
    grip point), the object origin goes to the part's pivot."""
    piv = part.pivot
    me = bpy.data.meshes.new(part.name)
    verts = [((x - piv.x) * MM, (y - piv.y) * MM, (z - piv.z) * MM) for x, y, z in part.V]
    me.from_pydata(verts, [], [f for f, _ in part.F])
    for i, (_, mi) in enumerate(part.F):
        me.polygons[i].material_index = mi
    me.update()
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-7)
    ng = [f for f in bm.faces if len(f.verts) > 4]
    if ng:
        bmesh.ops.triangulate(bm, faces=ng, quad_method='BEAUTY', ngon_method='BEAUTY')
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    lim = math.radians(SHARP_DEG)
    for f in bm.faces:
        f.smooth = True
    for e in bm.edges:
        if len(e.link_faces) != 2 or e.calc_face_angle(0) > lim:
            e.smooth = False
    uv = bm.loops.layers.uv.new('UVMap')
    for f in bm.faces:
        n = f.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        a, b = [(1, 2), (0, 2), (0, 1)][ax]
        for lp in f.loops:
            co = lp.vert.co
            lp[uv].uv = (co[a] / UV_SCALE, co[b] / UV_SCALE)
    bm.to_mesh(me)
    bm.free()
    for m in part.mats:
        me.materials.append(m)
    o = bpy.data.objects.new(part.name, me)
    bpy.context.scene.collection.objects.link(o)
    o.parent = parent
    o.location = ((piv.x - offset.x) * MM, (piv.y - offset.y) * MM, (piv.z - offset.z) * MM)
    return o


def make_empty(name, p, offset, parent):
    o = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(o)
    o.empty_display_size = 0.02
    o.parent = parent
    o.location = ((p[0] - offset.x) * MM, (p[1] - offset.y) * MM, (p[2] - offset.z) * MM)
    return o


def tri_count(objs):
    n = 0
    for o in objs:
        if o.type == 'MESH':
            o.data.calc_loop_triangles()
            n += len(o.data.loop_triangles)
    return n


def export_glb(path, root):
    bpy.ops.object.select_all(action='DESELECT')

    def sel(o):
        o.select_set(True)
        for c in o.children:
            sel(c)
    sel(root)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=True,
                              export_yup=True, export_extras=False, export_cameras=False, export_lights=False,
                              export_materials='EXPORT', export_image_format='JPEG', export_jpeg_quality=88,
                              export_texcoords=True, export_normals=True, export_tangents=True)


# ---------------------------------------------------------------- preview renders
def render_views(prefix, objs, fp_eye=None, res=(960, 540), samples=16, extra=None, views_only_fp=False):
    """Side (from +X, muzzle to the right) and 3/4 views fitted to the mesh bounds; optional first-person view
    from the eye empty looking along +Y."""
    s = bpy.context.scene
    s.render.engine = 'CYCLES'
    s.cycles.device = 'CPU'
    s.cycles.samples = samples
    s.cycles.use_denoising = True
    s.render.resolution_x, s.render.resolution_y = res
    s.render.film_transparent = False
    s.view_settings.view_transform = 'AgX'
    w = bpy.data.worlds.new('w'); s.world = w; w.use_nodes = True
    bg = w.node_tree.nodes['Background']; bg.inputs['Color'].default_value = (0.42, 0.45, 0.5, 1)
    bg.inputs['Strength'].default_value = 0.55
    pts = []
    for o in objs:
        if o.type == 'MESH':
            mw = o.matrix_world
            pts += [mw @ v.co for v in o.data.vertices]
    lo = Vector([min(p[i] for p in pts) for i in range(3)])
    hi = Vector([max(p[i] for p in pts) for i in range(3)])
    c = (lo + hi) / 2
    ext = hi - lo
    sun = bpy.data.lights.new('sun', 'SUN'); sun.energy = 3.0; sun.angle = math.radians(8)
    so = bpy.data.objects.new('sun', sun); s.collection.objects.link(so)
    so.rotation_euler = (math.radians(40), math.radians(-25), math.radians(-60))
    fill = bpy.data.lights.new('fill', 'AREA'); fill.energy = 25 * max(ext) ** 2 + 4; fill.size = 2 * max(ext) + 0.2
    fo = bpy.data.objects.new('fill', fill); s.collection.objects.link(fo)
    bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 0, lo.z - 0.002)); g = bpy.context.object; g.name = 'pv_ground'
    gm = bpy.data.materials.new('pv_ground'); gm.use_nodes = True
    gm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.36, 0.34, 0.3, 1)
    gm.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.9
    g.data.materials.append(gm)
    cam = bpy.data.cameras.new('cam'); cam.lens = 50; cam.clip_start = 0.005
    co = bpy.data.objects.new('cam', cam); s.collection.objects.link(co); s.camera = co
    hfov = 2 * math.atan(18 / 50)
    views = {'side': Vector((1, 0, 0.08)), '34': Vector((0.75, 0.62, 0.42))}
    if extra:
        views.update(extra)
    if views_only_fp:
        views = {}
    for tag, d in views.items():
        cc, scale = c, 1.0
        if isinstance(d, tuple) and d[0] == 'at':
            _, pos, look, lens = d
            cam.lens = lens
            co.location = pos
            co.rotation_euler = (look - pos).to_track_quat('-Z', 'Y').to_euler()
            fo.location = pos + Vector((0.4, -0.6, 1.0)); fo.rotation_euler = (look - fo.location).to_track_quat('-Z', 'Y').to_euler()
            s.render.filepath = f'{prefix}_{tag}.png'
            bpy.ops.render.render(write_still=True)
            cam.lens = 50
            continue
        if isinstance(d, tuple):
            d, cc, scale = d
        d = d.normalized()
        span = max(ext.y, ext.x * 0.6, ext.z * 16 / 9 * 0.95)
        dist = (span * 0.5 / math.tan(hfov / 2) * 1.12 + max(ext.x, ext.z) * 0.5) * scale
        co.location = cc + d * dist
        co.rotation_euler = (cc - co.location).to_track_quat('-Z', 'Y').to_euler()
        fo.location = cc + Vector((d.x * 0.5 + 0.3, d.y * 0.5 - 0.6, 1.0)) * max(1.0, dist)
        fo.rotation_euler = (c - fo.location).to_track_quat('-Z', 'Y').to_euler()
        s.render.filepath = f'{prefix}_{tag}.png'
        bpy.ops.render.render(write_still=True)
    if fp_eye is not None:
        cam.lens = 35
        fp, look = fp_eye if isinstance(fp_eye, tuple) else (fp_eye, None)
        co.location = fp
        if look is not None:
            co.rotation_euler = (look - fp).to_track_quat('-Z', 'Y').to_euler()
        else:
            co.rotation_euler = (math.radians(90), 0, 0)
        s.render.filepath = f'{prefix}_fp.png'
        bpy.ops.render.render(write_still=True)
    for n in ('pv_ground', 'cam', 'sun', 'fill'):
        o = bpy.data.objects.get(n)
        if o:
            bpy.data.objects.remove(o, do_unlink=True)


# ---------------------------------------------------------------- baked texture sets
# Material finish parameters used when compositing the baked masks (linear RGB).
FINISH = {}

PATTERNS = {   # micro relief for the normal bake: (kind, amplitude m, feature size m)
    'park': ('noise', 3.5e-5, 0.00035), 'anod': ('noise', 1.6e-5, 0.0003), 'poly': ('noise', 9e-5, 0.0006),
    'stipple': ('noise', 1.1e-4, 0.0009), 'knurl': ('knurl', 8e-5, 0.0009), 'grip': ('grip', 6e-5, 0.0012),
    'weave': ('knurl', 4.5e-5, 0.0008), 'rubber': ('noise', 6e-5, 0.0005), 'canvas': ('knurl', 3.5e-5, 0.0007),
    'smooth': ('noise', 5e-6, 0.0003), 'sand': ('noise', 2.5e-5, 0.0002),
}


def wmat(name, rgb, rough=0.6, metal=0.0, wear=0.0, worn=None, worn_rough=None, worn_metal=None, ao=0.6,
         grain=0.05, baked=True, emit=None, alpha=None, pattern='smooth', dust=0.12, grime=0.5, smudge=0.0,
         fill=None):
    """Material + finish description. Baked materials are replaced by the weapon's texture set after baking.
    pattern = micro-relief kind for the normal bake (PATTERNS), dust/grime/smudge = compositing amounts."""
    if name in _MATS:
        return _MATS[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*rgb, 1)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    if emit:
        b.inputs['Emission Color'].default_value = (*emit[:3], 1)
        b.inputs['Emission Strength'].default_value = emit[3] if len(emit) > 3 else 1.0
    FINISH[name] = dict(rgb=rgb, rough=rough, metal=metal, wear=wear, worn=worn or rgb,
                        worn_rough=rough if worn_rough is None else worn_rough,
                        worn_metal=metal if worn_metal is None else worn_metal, ao=ao, grain=grain,
                        baked=baked and not emit, pattern=pattern, dust=dust, grime=grime, smudge=smudge,
                        fill=fill or (0.5, 0.5, 0.46))
    _MATS[name] = m
    return m


def _blur(a, k=1):
    out = a.copy()
    for ax in (0, 1):
        acc = out.copy()
        for d in range(1, k + 1):
            acc += np.roll(out, d, ax) + np.roll(out, -d, ax)
        out = acc / (2 * k + 1)
    return out


# ---------------------------------------------------------------- stamped markings (5x7 stamp font)
_F = {
    'A': '01110100011000111111100011000110001', 'B': '11110100011000111110100011000111110',
    'C': '01110100011000010000100001000101110', 'D': '11110100011000110001100011000111110',
    'E': '11111100001000011110100001000011111', 'F': '11111100001000011110100001000010000',
    'G': '01110100011000010111100011000101111', 'H': '10001100011000111111100011000110001',
    'I': '01110001000010000100001000010001110', 'J': '00111000100001000010000101001001100',
    'K': '10001100101010011000101001001010001', 'L': '10000100001000010000100001000011111',
    'M': '10001110111010110101100011000110001', 'N': '10001100011100110101100111000110001',
    'O': '01110100011000110001100011000101110', 'P': '11110100011000111110100001000010000',
    'Q': '01110100011000110001101011001001101', 'R': '11110100011000111110101001001010001',
    'S': '01111100001000001110000010000111110', 'T': '11111001000010000100001000010000100',
    'U': '10001100011000110001100011000101110', 'V': '10001100011000110001100010101000100',
    'W': '10001100011000110101101011010101010', 'X': '10001100010101000100010101000110001',
    'Y': '10001100010101000100001000010000100', 'Z': '11111000010001000100010001000011111',
    '0': '01110100011001110101110011000101110', '1': '00100011000010000100001000010001110',
    '2': '01110100010000100010001000100011111', '3': '11111000100010000010000011000101110',
    '4': '00010001100101010010111110001000010', '5': '11111100001111000001000011000101110',
    '6': '00110010001000011110100011000101110', '7': '11111000010001000100010000100001000',
    '8': '01110100011000101110100011000101110', '9': '01110100011000101111000010001001100',
    '.': '00000000000000000000000000110001100', '-': '00000000000000011111000000000000000',
    '/': '00000000010001000100010001000000000', ':': '00000011000110000000011000110000000',
    ' ': '0' * 35, '#': '1' * 35,
}


def text_mask(text, px):
    """Rasterise text (lines separated by \n) with the stamp font, px pixels per font cell. Returns (h, w) array,
    row 0 at the top."""
    lines = text.split('\n')
    W = max(len(l) for l in lines) * 6 - 1
    H = len(lines) * 9 - 2
    g = np.zeros((H, W), np.float32)
    for li, line in enumerate(lines):
        for ci, ch in enumerate(line.upper()):
            bits = _F.get(ch, _F[' '])
            for r in range(7):
                for c in range(5):
                    if bits[r * 5 + c] == '1':
                        g[li * 9 + r, ci * 6 + c] = 1
    return np.kron(g, np.ones((px, px), np.float32))


def matrix_mask(n, px, seed=3):
    """Pseudo data-matrix code (n x n cells with the L finder pattern)."""
    rng = np.random.default_rng(seed)
    g = (rng.random((n, n)) > 0.5).astype(np.float32)
    g[:, 0] = 1; g[-1, :] = 1
    g[0, ::2] = 1; g[0, 1::2] = 0; g[::2, -1] = 0; g[1::2, -1] = 1
    return np.kron(g, np.ones((px, px), np.float32))


def decal_images(gid, decals, ppm=8):
    """Rasterise decals into one planar side-projection image per side. decals: dicts with text (or matrix=n),
    y, z (centre, mm, weapon frame), h (letter height mm), side (+1 right, -1 left), fill (paint-filled).
    Returns [(image, side, y0, y1, z0, z1)] with R = engraving, G = paint fill."""
    out = []
    for side in (1, -1):
        ds = [d for d in decals if d['side'] == side]
        if not ds:
            continue
        rast = []
        for d in ds:
            cell = d['h'] / 7.0
            px = max(1, int(round(cell * ppm)))
            m = matrix_mask(d['matrix'], px, d.get('seed', 3)) if 'matrix' in d else text_mask(d['text'], px)
            rast.append((d, m))
        y0 = min(d['y'] - m.shape[1] / ppm / 2 for d, m in rast) - 2
        y1 = max(d['y'] + m.shape[1] / ppm / 2 for d, m in rast) + 2
        z0 = min(d['z'] - m.shape[0] / ppm / 2 for d, m in rast) - 2
        z1 = max(d['z'] + m.shape[0] / ppm / 2 for d, m in rast) + 2
        Wp, Hp = int((y1 - y0) * ppm) + 1, int((z1 - z0) * ppm) + 1
        R = np.zeros((Hp, Wp), np.float32); G = np.zeros((Hp, Wp), np.float32)
        for d, m in rast:
            mh, mw = m.shape
            cu = (d['y'] - y0) * ppm if side > 0 else (y1 - d['y']) * ppm
            cv = (d['z'] - z0) * ppm
            c0, r0 = int(cu - mw / 2), int(cv - mh / 2)
            mm = m[::-1, :]                          # image rows go up with z
            R[r0:r0 + mh, c0:c0 + mw] = np.maximum(R[r0:r0 + mh, c0:c0 + mw], mm)
            if d.get('fill'):
                G[r0:r0 + mh, c0:c0 + mw] = np.maximum(G[r0:r0 + mh, c0:c0 + mw], mm)
        R = np.clip(_blur(R, 1) * 1.2, 0, 1); G = np.clip(_blur(G, 1) * 1.2, 0, 1)
        img = bpy.data.images.new(f'{gid}_decal_{side}', Wp, Hp, alpha=False, float_buffer=True)
        img.colorspace_settings.name = 'Non-Color'
        px = np.ones((Hp, Wp, 4), np.float32); px[..., 0] = R; px[..., 1] = G; px[..., 2] = 0
        img.pixels.foreach_set(px.ravel())
        out.append((img, side, y0, y1, z0, z1))
    return out


def _decal_nodes(nt, decs):
    """Shader nodes returning sockets (engrave, fill) for the side-projected decals on object index 1."""
    N = nt.nodes.new
    L = nt.links.new
    tc = N('ShaderNodeTexCoord'); sep = N('ShaderNodeSeparateXYZ'); L(tc.outputs['Object'], sep.inputs[0])
    geo = N('ShaderNodeNewGeometry'); sn = N('ShaderNodeSeparateXYZ'); L(geo.outputs['Normal'], sn.inputs[0])
    oi = N('ShaderNodeObjectInfo')
    cmp_ = N('ShaderNodeMath'); cmp_.operation = 'COMPARE'; cmp_.inputs[1].default_value = 1.0
    cmp_.inputs[2].default_value = 0.2
    L(oi.outputs['Object Index'], cmp_.inputs[0])
    acc = [None, None]
    made = [tc, sep, geo, sn, oi, cmp_]
    for img, side, y0, y1, z0, z1 in decs:
        mu = N('ShaderNodeMath'); mu.operation = 'MULTIPLY_ADD'
        span = y1 - y0
        L(sep.outputs['Y'], mu.inputs[0])
        mu.inputs[1].default_value = (1000.0 / span) * (1 if side > 0 else -1)
        mu.inputs[2].default_value = (-y0 / span) if side > 0 else (y1 / span)
        mv = N('ShaderNodeMath'); mv.operation = 'MULTIPLY_ADD'
        L(sep.outputs['Z'], mv.inputs[0])
        mv.inputs[1].default_value = 1000.0 / (z1 - z0); mv.inputs[2].default_value = -z0 / (z1 - z0)
        cb = N('ShaderNodeCombineXYZ'); L(mu.outputs[0], cb.inputs['X']); L(mv.outputs[0], cb.inputs['Y'])
        ti = N('ShaderNodeTexImage'); ti.image = img; ti.extension = 'CLIP'; ti.interpolation = 'Linear'
        L(cb.outputs[0], ti.inputs['Vector'])
        sc = N('ShaderNodeSeparateColor'); L(ti.outputs['Color'], sc.inputs[0])
        sm = N('ShaderNodeMath'); sm.operation = 'GREATER_THAN' if side > 0 else 'LESS_THAN'
        sm.inputs[1].default_value = 0.55 * side
        L(sn.outputs['X'], sm.inputs[0])
        mk = N('ShaderNodeMath'); mk.operation = 'MULTIPLY'; L(sm.outputs[0], mk.inputs[0]); L(cmp_.outputs[0], mk.inputs[1])
        made += [mu, mv, cb, ti, sc, sm, mk]
        for ch, k in (('Red', 0), ('Green', 1)):
            t = N('ShaderNodeMath'); t.operation = 'MULTIPLY'; L(sc.outputs[ch], t.inputs[0]); L(mk.outputs[0], t.inputs[1])
            made.append(t)
            if acc[k] is None:
                acc[k] = t.outputs[0]
            else:
                a = N('ShaderNodeMath'); a.operation = 'MAXIMUM'; L(acc[k], a.inputs[0]); L(t.outputs[0], a.inputs[1])
                acc[k] = a.outputs[0]; made.append(a)
    return acc, made


def _pattern_height(nt, kind, amp, size):
    """Height socket (metres) of the micro relief."""
    N = nt.nodes.new
    L = nt.links.new
    tc = N('ShaderNodeTexCoord')
    made = [tc]
    if kind == 'noise':
        nz = N('ShaderNodeTexNoise'); nz.inputs['Scale'].default_value = 1.0 / size
        nz.inputs['Detail'].default_value = 3.0
        L(tc.outputs['Object'], nz.inputs['Vector'])
        sub = N('ShaderNodeMath'); sub.operation = 'MULTIPLY_ADD'
        L(nz.outputs['Fac'], sub.inputs[0]); sub.inputs[1].default_value = amp * 2; sub.inputs[2].default_value = -amp
        made += [nz, sub]
        return sub.outputs[0], made
    a = 2 * math.pi / size
    outs = []
    for v in ((1, 1, 1), (1, -1, -1)):
        d = N('ShaderNodeVectorMath'); d.operation = 'DOT_PRODUCT'; d.inputs[1].default_value = v
        L(tc.outputs['Object'], d.inputs[0])
        m = N('ShaderNodeMath'); m.operation = 'MULTIPLY'; m.inputs[1].default_value = a
        L(d.outputs['Value'], m.inputs[0])
        sn = N('ShaderNodeMath'); sn.operation = 'SINE'; L(m.outputs[0], sn.inputs[0])
        made += [d, m, sn]; outs.append(sn.outputs[0])
    pr = N('ShaderNodeMath'); pr.operation = 'MULTIPLY'; L(outs[0], pr.inputs[0]); L(outs[1], pr.inputs[1])
    sc = N('ShaderNodeMath'); sc.operation = 'MULTIPLY'; sc.inputs[1].default_value = amp; L(pr.outputs[0], sc.inputs[0])
    made += [pr, sc]
    if kind == 'grip':
        # Checkering only on the flat side panels (|normal.x| high), stipple elsewhere.
        geo = N('ShaderNodeNewGeometry'); sxyz = N('ShaderNodeSeparateXYZ'); L(geo.outputs['Normal'], sxyz.inputs[0])
        ab = N('ShaderNodeMath'); ab.operation = 'ABSOLUTE'; L(sxyz.outputs['X'], ab.inputs[0])
        gt = N('ShaderNodeMath'); gt.operation = 'GREATER_THAN'; gt.inputs[1].default_value = 0.6; L(ab.outputs[0], gt.inputs[0])
        mm = N('ShaderNodeMath'); mm.operation = 'MULTIPLY'; L(sc.outputs[0], mm.inputs[0]); L(gt.outputs[0], mm.inputs[1])
        made += [geo, sxyz, ab, gt, mm]
        return mm.outputs[0], made
    return sc.outputs[0], made


def sweep(part, path, w, t, m, up=(1, 0, 0)):
    """Flat strap (sling webbing) swept along a 3D polyline: width w in the plane normal to `up`, thickness t."""
    rings = []
    P = [Vector(p) for p in path]
    U = Vector(up)
    for i, p in enumerate(P):
        T = (P[min(i + 1, len(P) - 1)] - P[max(i - 1, 0)]).normalized()
        side = T.cross(U).normalized()
        nrm = side.cross(T).normalized()
        rings.append([tuple(p + side * sw * w / 2 + nrm * st * t / 2) for sw, st in ((1, 1), (-1, 1), (-1, -1), (1, -1))])
    part.loft(rings, m)


def bake_weapon(gid, objs, size=1024, samples=6, ao_dist=0.012, edge_r=0.0012, log=print, decals=None):
    """Smart-UV the weapon's meshes into one atlas and bake with Cycles: AO / edge mask, material IDs, decal +
    up-facing masks, and a tangent-space normal map from procedural micro relief (per-material PATTERNS, knurling,
    grip checkering, stamped markings) on bevel-rounded edges. Composite base colour + metallic-roughness with
    grime, dust, oil smudges and broken-up edge wear. Baked materials become one '<gid>_finish' material."""
    import time
    t0 = time.time()
    meshes = [o for o in objs if o.type == 'MESH']
    for o in meshes:
        o.pass_index = 1 if o.name == 'body' else 0
    vl = bpy.context.view_layer
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:
        o.select_set(True)
    vl.objects.active = meshes[0]
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(62), island_margin=0.0035, area_weight=0.0, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    s = bpy.context.scene
    s.render.engine = 'CYCLES'
    s.cycles.device = 'CPU'
    s.cycles.use_denoising = False
    s.render.bake.margin = 6
    s.render.bake.use_clear = True
    mats = []
    for o in meshes:
        for sl in o.material_slots:
            if sl.material and sl.material not in mats:
                mats.append(sl.material)
    def newimg(name, flt=True):
        im = bpy.data.images.new(name, size, size, alpha=False, float_buffer=flt)
        im.colorspace_settings.name = 'Non-Color'
        return im
    masks, ids, masks2, nrm = newimg(gid + '_masks'), newimg(gid + '_ids'), newimg(gid + '_masks2'), newimg(gid + '_nrm')
    decs = decal_images(gid, decals) if decals else []
    nid = max(1, len(mats))

    def setup(kind):
        added = []
        for i, m in enumerate(mats):
            nt = m.node_tree
            L = nt.links.new
            out_old = [n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL' and n.is_active_output]
            tex = nt.nodes.new('ShaderNodeTexImage'); tex.image = {'masks': masks, 'ids': ids, 'masks2': masks2, 'normal': nrm}[kind]
            new = [tex]
            if kind == 'normal':
                f = FINISH.get(m.name, {})
                pk, amp, size_ = PATTERNS[f.get('pattern', 'smooth')]
                h, made = _pattern_height(nt, pk, amp, size_)
                new += made
                if decs:
                    (eng, fil), made = _decal_nodes(nt, decs)
                    new += made
                    sub = nt.nodes.new('ShaderNodeMath'); sub.operation = 'MULTIPLY_ADD'
                    L(eng, sub.inputs[0]); sub.inputs[1].default_value = -1.3e-4; L(h, sub.inputs[2])
                    h = sub.outputs[0]; new.append(sub)
                bev = nt.nodes.new('ShaderNodeBevel'); bev.samples = 6; bev.inputs['Radius'].default_value = 0.0007
                bump = nt.nodes.new('ShaderNodeBump'); bump.inputs['Strength'].default_value = 1.0
                bump.inputs['Distance'].default_value = 1.0
                L(h, bump.inputs['Height']); L(bev.outputs['Normal'], bump.inputs['Normal'])
                bsdf = nt.nodes.get('Principled BSDF')
                L(bump.outputs['Normal'], bsdf.inputs['Normal'])
                new += [bev, bump]
                nt.nodes.active = tex
                added.append((m, new, []))
                continue
            em = nt.nodes.new('ShaderNodeEmission'); out = nt.nodes.new('ShaderNodeOutputMaterial')
            new += [em, out]
            if kind == 'masks':
                aon = nt.nodes.new('ShaderNodeAmbientOcclusion'); aon.samples = 12; aon.inside = False
                aon.inputs['Distance'].default_value = ao_dist
                bev = nt.nodes.new('ShaderNodeBevel'); bev.samples = 6; bev.inputs['Radius'].default_value = edge_r
                geo = nt.nodes.new('ShaderNodeNewGeometry')
                dot = nt.nodes.new('ShaderNodeVectorMath'); dot.operation = 'DOT_PRODUCT'
                comb = nt.nodes.new('ShaderNodeCombineXYZ')
                L(bev.outputs['Normal'], dot.inputs[0]); L(geo.outputs['Normal'], dot.inputs[1])
                L(aon.outputs['AO'], comb.inputs['X']); L(dot.outputs['Value'], comb.inputs['Y'])
                L(comb.outputs['Vector'], em.inputs['Color'])
                new += [aon, bev, geo, dot, comb]
            elif kind == 'masks2':
                geo = nt.nodes.new('ShaderNodeNewGeometry'); sx = nt.nodes.new('ShaderNodeSeparateXYZ')
                comb = nt.nodes.new('ShaderNodeCombineXYZ')
                L(geo.outputs['Normal'], sx.inputs[0]); L(sx.outputs['Z'], comb.inputs['Z'])
                new += [geo, sx, comb]
                if decs:
                    (eng, fil), made = _decal_nodes(nt, decs)
                    new += made
                    L(eng, comb.inputs['X']); L(fil, comb.inputs['Y'])
                L(comb.outputs['Vector'], em.inputs['Color'])
            else:
                em.inputs['Color'].default_value = ((i + 0.5) / nid, 0, 0, 1)
            L(em.outputs['Emission'], out.inputs['Surface'])
            for n in out_old:
                n.is_active_output = False
            out.is_active_output = True
            nt.nodes.active = tex
            added.append((m, new, out_old))
        return added

    def teardown(added):
        for m, new, out_old in added:
            for n in new:
                m.node_tree.nodes.remove(n)
            for n in out_old:
                n.is_active_output = True

    for kind, smp in (('masks', samples), ('ids', 1), ('masks2', 2), ('normal', 4)):
        s.cycles.samples = smp
        added = setup(kind)
        if kind == 'normal':
            bpy.ops.object.bake(type='NORMAL', normal_space='TANGENT', margin=6, use_clear=True)
        else:
            bpy.ops.object.bake(type='EMIT', margin=6, use_clear=True)
        teardown(added)
    log(f'  baked {size}px masks + normals in {time.time() - t0:.0f}s')
    M = np.array(masks.pixels[:], np.float32).reshape(size, size, 4)
    I = np.array(ids.pixels[:], np.float32).reshape(size, size, 4)
    M2 = np.array(masks2.pixels[:], np.float32).reshape(size, size, 4)
    ao = np.clip(_blur(M[..., 0], 1), 0, 1)
    edge = np.clip((1 - _blur(M[..., 1], 1)) * 9.0, 0, 1)
    dec, fil, up = np.clip(M2[..., 0], 0, 1), np.clip(M2[..., 1], 0, 1), np.clip(M2[..., 2], -1, 1)
    mid = np.clip(np.floor(I[..., 0] * nid), 0, nid - 1).astype(np.int32)
    n_lo = tile_noise(size, 11, 1.3)
    n_md = tile_noise(size, 12, 0.9, 0)
    n_hi = tile_noise(size, 13, 0.2, 0)
    n_bl = tile_noise(size, 14, 1.8)
    col = np.zeros((size, size, 3), np.float32)
    rgh = np.zeros((size, size), np.float32)
    mtl = np.zeros((size, size), np.float32)
    grime_c = np.array((0.016, 0.015, 0.013), np.float32)
    dust_c = np.array((0.2, 0.175, 0.135), np.float32)
    for i, m in enumerate(mats):
        f = FINISH.get(m.name)
        if not f:
            continue
        sel = mid == i
        if not sel.any():
            continue
        base = np.array(f['rgb'], np.float32)
        worn = np.array(f['worn'], np.float32)
        A, E = ao[sel], edge[sel]
        nl, nm, nh, nb = n_lo[sel], n_md[sel], n_hi[sel], n_bl[sel]
        # Gentle edge wear: only convex, exposed edges, broken up by two noise scales.
        wear = np.clip((E * (0.5 + 0.5 * A) - 0.32 + 0.5 * nl + 0.2 * nh) * 2.2, 0, 1) * f['wear']
        tone = 1 + f['grain'] * (0.6 * nm + 0.4 * nh)
        c = base[None, :] * tone[:, None]
        c = c * (1 - wear[:, None]) + worn[None, :] * wear[:, None]
        g = np.clip((1 - A) ** 1.4 * (0.8 + 0.4 * nm), 0, 1) * f['grime']
        c = c * (1 - g[:, None]) + grime_c[None, :] * g[:, None]
        aof = (1 - f['ao']) + f['ao'] * A
        c = c * aof[:, None]
        d = np.clip((up[sel] - 0.5) * 2.5, 0, 1) * np.clip(0.45 + 0.8 * nl, 0, 1) * (0.5 + 0.5 * A) * f['dust']
        c = c * (1 - d[:, None]) + dust_c[None, :] * d[:, None]
        sm = np.clip((nb - 0.15) * 3.0, 0, 1) * f['smudge']
        c = c * (1 - 0.12 * sm[:, None])
        ds = dec[sel]
        c = c * (1 - 0.3 * ds[:, None])
        fl = fil[sel]
        c = c * (1 - fl[:, None]) + np.array(f['fill'], np.float32)[None, :] * fl[:, None]
        col[sel] = c
        r = f['rough'] * (1 - wear) + f['worn_rough'] * wear + 0.05 * nm + 0.03 * nh + 0.12 * g + 0.25 * d
        r = r * (1 - 0.4 * sm) + 0.1 * ds
        rgh[sel] = np.clip(r, 0.05, 1)
        mtl[sel] = np.clip(f['metal'] * (1 - wear) + f['worn_metal'] * wear - 0.3 * d, 0, 1)
    imc = _image(gid + '_basecolor', _srgb(col), 'sRGB')
    imr = _image(gid + '_metalrough', np.stack([np.zeros_like(rgh), rgh, mtl], -1), 'Non-Color')
    if size > 1024:
        imr.scale(1024, 1024)
        imr.pack()
    N_ = np.array(nrm.pixels[:], np.float32).reshape(size, size, 4)[..., :3]
    imn = _image(gid + '_normal', N_, 'Non-Color')
    fm = bpy.data.materials.new(gid + '_finish')
    fm.use_nodes = True
    nt = fm.node_tree
    b = nt.nodes['Principled BSDF']
    t1 = nt.nodes.new('ShaderNodeTexImage'); t1.image = imc
    t2 = nt.nodes.new('ShaderNodeTexImage'); t2.image = imr
    t3 = nt.nodes.new('ShaderNodeTexImage'); t3.image = imn
    nmap = nt.nodes.new('ShaderNodeNormalMap'); nmap.space = 'TANGENT'
    sep = nt.nodes.new('ShaderNodeSeparateColor')
    nt.links.new(t1.outputs['Color'], b.inputs['Base Color'])
    nt.links.new(t2.outputs['Color'], sep.inputs['Color'])
    nt.links.new(sep.outputs['Green'], b.inputs['Roughness'])
    nt.links.new(sep.outputs['Blue'], b.inputs['Metallic'])
    nt.links.new(t3.outputs['Color'], nmap.inputs['Color'])
    nt.links.new(nmap.outputs['Normal'], b.inputs['Normal'])
    for o in meshes:
        for sl in o.material_slots:
            if sl.material and FINISH.get(sl.material.name, {}).get('baked'):
                sl.material = fm
    dbg = os.environ.get('BAKE_DEBUG')
    if dbg:
        for img in (masks, masks2, imc, imr, imn):
            img.filepath_raw = os.path.join(dbg, img.name + '.png'); img.file_format = 'PNG'; img.save()
    for img in [masks, ids, masks2, nrm] + [d[0] for d in decs]:
        bpy.data.images.remove(img)
    log(f'  texture set done in {time.time() - t0:.0f}s')
    return fm


def add_decal_quads(obj, gid, decals, ppm=10.0, offset=0.00012, log=print):
    """Crisp stamped markings as decal geometry: each decal is a small grid ray-cast onto the body surface
    (conforms to flat and curved faces), sitting `offset` m above it, textured from one RGBA marking atlas
    (~0.1 mm per pixel) with an alpha-clipped material. Engraved marks render as lighter bare-metal grey,
    painted (fill) marks in their paint colour."""
    rast = []
    for d in decals:
        cell = d['h'] / 7.0
        px = max(2, int(round(cell * ppm)))
        m = matrix_mask(d['matrix'], px, d.get('seed', 3)) if 'matrix' in d else text_mask(d['text'], px)
        m = np.pad(m, 3)
        rast.append((d, m, px / cell))
    W = 1024
    x = y = rowh = 0
    pos = []
    for d, m, pp in rast:
        h, w = m.shape
        if x + w > W:
            x, y, rowh = 0, y + rowh, 0
        pos.append((x, y))
        x += w
        rowh = max(rowh, h)
    H = 1 << int(math.ceil(math.log2(max(16, y + rowh))))
    A = np.zeros((H, W, 4), np.float32)
    for (d, m, pp), (px0, py0) in zip(rast, pos):
        h, w = m.shape
        a = np.clip(_blur(m, 1) * 1.3, 0, 1)
        c = d.get('color') or ((0.6, 0.6, 0.56) if d.get('fill') else (0.11, 0.11, 0.105))
        sl = A[py0:py0 + h, px0:px0 + w]
        sl[..., 3] = np.maximum(sl[..., 3], a)
        sl[..., :3] = np.where(a[..., None] > 0.01, np.array(c, np.float32), sl[..., :3])
    A = A[::-1].copy()                                            # Blender image rows go bottom-up
    A[..., :3] = _srgb(A[..., :3])
    img = bpy.data.images.new(gid + '_marks', W, H, alpha=True)
    img.colorspace_settings.name = 'sRGB'
    img.pixels.foreach_set(A.ravel())
    img.pack()
    mt = bpy.data.materials.new(gid + '_marks')
    mt.use_nodes = True
    nt = mt.node_tree
    bsdf = nt.nodes['Principled BSDF']
    ti = nt.nodes.new('ShaderNodeTexImage'); ti.image = img
    gt = nt.nodes.new('ShaderNodeMath'); gt.operation = 'GREATER_THAN'; gt.inputs[1].default_value = 0.5
    nt.links.new(ti.outputs['Color'], bsdf.inputs['Base Color'])
    nt.links.new(ti.outputs['Alpha'], gt.inputs[0])
    nt.links.new(gt.outputs[0], bsdf.inputs['Alpha'])
    bsdf.inputs['Roughness'].default_value = 0.55
    bsdf.inputs['Metallic'].default_value = 0.4
    try:
        mt.surface_render_method = 'DITHERED'
    except Exception:
        pass
    obj.data.materials.append(mt)
    mi = len(obj.data.materials) - 1
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    uvl = bm.loops.layers.uv.active or bm.loops.layers.uv.new('UVMap')
    placed = 0
    for (d, m, pp), (px0, py0) in zip(rast, pos):
        h, w = m.shape
        wmm, hmm = w / pp, h / pp
        nu, nv = max(2, int(wmm / 3) + 1), max(2, int(hmm / 3) + 1)
        side = d['side']

        def at(i, j):
            return (d['y'] + (i / nu - 0.5) * wmm * side), (d['z'] + (j / nv - 0.5) * hmm)
        grid, hits = [], 0
        for j in range(nv + 1):
            row = []
            for i in range(nu + 1):
                yy, zz = at(i, j)
                ok, loc, nrm, _ = obj.ray_cast(Vector((side * 0.4, yy * MM, zz * MM)), Vector((-side, 0, 0)))
                if ok and nrm.x * side > 0.3:
                    row.append(Vector((loc.x + side * offset, loc.y, loc.z)))
                    hits += 1
                else:
                    row.append(None)
            grid.append(row)
        if hits < 0.7 * (nu + 1) * (nv + 1):
            log(f'  decal {d.get("text", "matrix")!r} skipped (surface not found)')
            continue
        xs = sorted(p.x for r in grid for p in r if p is not None)
        xm = xs[len(xs) // 2]
        V = []
        for j, r in enumerate(grid):
            vr = []
            for i, p in enumerate(r):
                if p is None:
                    yy, zz = at(i, j)
                    p = Vector((xm, yy * MM, zz * MM))
                vr.append(bm.verts.new(p))
            V.append(vr)
        for j in range(nv):
            for i in range(nu):
                corners = ((i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1))
                if side < 0:
                    corners = corners[::-1]
                f = bm.faces.new([V[jj][ii] for ii, jj in corners])
                f.material_index = mi
                f.smooth = True
                for lp, (ii, jj) in zip(f.loops, corners):
                    lp[uvl].uv = ((px0 + ii / nu * w) / W, 1 - (py0 + h - jj / nv * h) / H)
        placed += 1
    bm.to_mesh(obj.data)
    bm.free()
    log(f'  {placed}/{len(decals)} decals placed ({W}x{H} marking atlas)')

"""Modelled gear for the characters: plate carrier, pouches, radio, helmet, boots shafts, knee pads, chest rigs,
head wraps. Everything is built in the rest pose from parametric "soft boxes" (a coarse cage conformed to the body
by ray casts, then subdivided so the edges come out rounded and padded) and textured procedurally (texbake via
chbuild sources) from 3D position: camouflage, Cordura weave, MOLLE webbing rows, stitching."""
import math

import bpy
import bmesh
import numpy as np
from mathutils import Vector, Matrix, Euler, Quaternion
from mathutils.bvhtree import BVHTree

import chcommon as C
import chbuild as K
import texbake as T
from chbuild import smooth

# ---------------------------------------------------------------------------------------------- primitives


def _ticks(n, edge):
    """Lattice coordinates 0..1 with n cells; edge > 0 adds support loops at `edge` from both ends so the
    subdivided shape keeps crisp (slightly rounded) edges instead of turning into a pillow."""
    t = [i / n for i in range(n + 1)]
    if edge and n >= 1:
        inner = [edge + (1 - 2 * edge) * x for x in t]
        t = [0.0] + inner + [1.0]
    return t


def grid_box(name, f, nx=2, ny=2, nz=1, mat=None, edge=0.0, edge_z=None):
    """Surface of a box lattice (nx, ny, nz cells) whose lattice point (u, v, w) in [0,1]^3 maps to f(u, v, w)."""
    us, vs = _ticks(nx, edge), _ticks(ny, edge)
    ws = _ticks(nz, edge if edge_z is None else edge_z)
    nx, ny, nz = len(us) - 1, len(vs) - 1, len(ws) - 1
    bm = bmesh.new()
    vid = {}

    def V(i, j, k):
        key = (i, j, k)
        if key not in vid:
            vid[key] = bm.verts.new(tuple(f(us[i], vs[j], ws[k])))
        return vid[key]
    faces = []
    for i in range(nx):
        for j in range(ny):
            faces.append((V(i, j, 0), V(i, j + 1, 0), V(i + 1, j + 1, 0), V(i + 1, j, 0)))
            faces.append((V(i, j, nz), V(i + 1, j, nz), V(i + 1, j + 1, nz), V(i, j + 1, nz)))
    for i in range(nx):
        for k in range(nz):
            faces.append((V(i, 0, k), V(i + 1, 0, k), V(i + 1, 0, k + 1), V(i, 0, k + 1)))
            faces.append((V(i, ny, k), V(i, ny, k + 1), V(i + 1, ny, k + 1), V(i + 1, ny, k)))
    for j in range(ny):
        for k in range(nz):
            faces.append((V(0, j, k), V(0, j, k + 1), V(0, j + 1, k + 1), V(0, j + 1, k)))
            faces.append((V(nx, j, k), V(nx, j + 1, k), V(nx, j + 1, k + 1), V(nx, j, k + 1)))
    for fc in faces:
        try:
            bm.faces.new(fc)
        except ValueError:
            pass
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    if mat is not None:
        me.materials.append(mat)
    for p in me.polygons:
        p.use_smooth = True
    return o


def soft_box(name, f, nx=2, ny=2, nz=1, mat=None, sub=1, tile=1.0, edge=0.12, edge_z=None):
    o = grid_box(name, f, nx, ny, nz, mat, edge, edge_z)
    if sub:
        K.subsurf(o, sub)
    C.box_uv(o, tile)
    return o


def box_at(name, center, size, mat, rot=None, sub=1, n=(1, 1, 1), bulge=0.0, edge=0.15):
    """Axis box (size = full extents) around center, rotated by quaternion/matrix rot, soft edges."""
    c = Vector(center)
    R = rot.to_matrix() if isinstance(rot, Quaternion) else (rot or Matrix.Identity(3))
    sx, sy, sz = size

    def f(u, v, w):
        p = Vector(((u - 0.5) * sx, (w - 0.5) * sy, (v - 0.5) * sz))
        if bulge:
            p.y += bulge * sy * (1 - (2 * u - 1) ** 2) * (1 - (2 * v - 1) ** 2) * (1 if w > 0.5 else -0.3)
        return c + R @ p
    if max(size) < 0.07 and n == (1, 1, 1):
        edge = 0.0              # small items: a plain rounded box is enough (48 triangles)
    return soft_box(name, f, n[0], n[2], n[1], mat, sub, edge=edge, edge_z=0.25 if edge else 0.0)


def tube(name, pts, radius, mat, seg=8, closed=False, cap=True):
    """Round tube along points (antenna, hose, cords)."""
    bm = bmesh.new()
    rings = []
    n = len(pts)
    prev = None
    for i, p in enumerate(pts):
        p = Vector(p)
        a = Vector(pts[min(i + 1, n - 1)]) - Vector(pts[max(i - 1, 0)])
        a.normalize()
        ref = prev if prev is not None else (Vector((0, 0, 1)) if abs(a.z) < 0.9 else Vector((1, 0, 0)))
        u = (ref - a * ref.dot(a)).normalized()
        prev = u
        v = a.cross(u)
        r = radius(i / max(n - 1, 1)) if callable(radius) else radius
        rings.append([bm.verts.new(p + (u * math.cos(t) + v * math.sin(t)) * r)
                      for t in (2 * math.pi * k / seg for k in range(seg))])
    for i in range(n - 1):
        for k in range(seg):
            bm.faces.new((rings[i][k], rings[i][(k + 1) % seg], rings[i + 1][(k + 1) % seg], rings[i + 1][k]))
    if cap:
        bm.faces.new(rings[0][::-1])
        bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    me.materials.append(mat)
    for pl in me.polygons:
        pl.use_smooth = True
    C.box_uv(o, 1.0)
    return o


def ray(bvh, origin, d, dist=2.0):
    h = bvh.ray_cast(Vector(origin), Vector(d).normalized(), dist)
    return h[0], h[1]


def surf_front(bvh, x, z, sign=1, y0=1.0):
    """First surface point hit coming from +Y (sign=1) or -Y (sign=-1) at (x, z)."""
    p, n = ray(bvh, (x, sign * y0, z), (0, -sign, 0), 2 * y0)
    return p, n


def conform_panel(name, bvh, outline, z0, z1, gap, thick, mat, sign=1, nx=6, nz=6, curve=2.0, sub=1, lean=0.0):
    """A rigid curved panel (plate bag) in front of (sign=1) or behind (sign=-1) the body: outline(v) -> half width
    at relative height v (0 bottom .. 1 top); single-curvature plate (y = A - curve * x^2) pushed out until it
    clears the body by `gap`, then `thick` deep."""
    zs = np.linspace(z0, z1, 12)
    A = -1e9
    for z in zs:
        v = (z - z0) / (z1 - z0)
        hw = outline(v)
        for x in np.linspace(-hw, hw, 9):
            p, n = surf_front(bvh, x, z, sign)
            if p is not None:
                A = max(A, sign * p.y + curve * x * x - lean * (z - z0))
    A += gap

    def f(u, v, w):
        hw = outline(v)
        x = (u - 0.5) * 2 * hw
        z = z0 + v * (z1 - z0)
        y = A - curve * x * x + lean * (z - z0) + w * thick
        return Vector((x, sign * y, z))
    return soft_box(name, f, nx, nz, 1, mat, sub), A


def wrap_band(name, bvh, axis_xy, th0, th1, z0, z1, gap, thick, mat, n=10, nz=2, sub=1):
    """Band around the torso between angles th0..th1 (deg, 0 = front, 90 = +X/right side) from z0 to z1."""
    cx, cy = axis_xy
    R = {}
    for i in range(n + 1):
        th = math.radians(th0 + (th1 - th0) * i / n)
        d = Vector((math.sin(th), math.cos(th), 0))
        rr = 0
        for z in np.linspace(z0, z1, 5):
            o = Vector((cx, cy, z))
            p, nn = ray(bvh, o + d * 0.6, -d, 0.6)
            if p is not None:
                rr = max(rr, (p - o).length)
        R[i] = rr if rr > 0 else 0.15

    def f(u, v, w):
        i = int(round(u * n))
        th = math.radians(th0 + (th1 - th0) * u)
        d = Vector((math.sin(th), math.cos(th), 0))
        r = R[i] + gap + w * thick
        return Vector((cx, cy, z0 + v * (z1 - z0))) + d * r
    return soft_box(name, f, n, nz, 1, mat, sub)


def path_strap(name, pts, width, thick, up_fn, mat, sub=1):
    """Padded strap along pts; up_fn(p) = outward direction (strap face normal)."""
    n = len(pts)
    P = [Vector(p) for p in pts]

    def f(u, v, w):
        i = min(int(round(u * (n - 1))), n - 1)
        p = P[i]
        a = (P[min(i + 1, n - 1)] - P[max(i - 1, 0)]).normalized()
        up = Vector(up_fn(p))
        up = (up - a * up.dot(a)).normalized()
        s = a.cross(up).normalized()
        return p + s * (v - 0.5) * width + up * w * thick
    return soft_box(name, f, n - 1, 1, 1, mat, sub)

# ---------------------------------------------------------------------------------------------- gear textures


def cordura(P, scale=0.0006):
    return (T.vnoise(P, scale, 31) - 0.5) * 0.00006


def molle_height(P, N, z0=0.0, pitch=0.0381, band=0.0254, bar=0.0381):
    """MOLLE/PALS rows: 1 inch webbing every 1.5 inch, bar-tacked every 1.5 inch, on near-vertical faces."""
    z = (P[:, 2] - z0) % pitch
    on = 1 - smooth(band - 0.0012, band + 0.0004, z) * 1.0
    on *= smooth(0.0, 0.0008, z)
    vert = 1 - smooth(0.5, 0.8, np.abs(N[:, 2]))
    hor = np.arctan2(P[:, 0], P[:, 1]) * 0.2           # along the surface (approx.)
    s = np.abs(((P[:, 0] + P[:, 1] * 0.3) % bar) - bar / 2)
    tack = (1 - smooth(0.0010, 0.0016, s)) * on
    edge = (1 - smooth(0.0003, 0.0008, np.abs(z - 0.0015))) + (1 - smooth(0.0003, 0.0008, np.abs(z - band + 0.0015)))
    h = on * 0.0011 - tack * 0.0005 - edge * on * 0.00015
    return h * vert, on * vert


def src_nylon(seed=0, pattern='ocp', molle=False, rough=0.9, tint=None, wear=0.35, importance=1.0, z0=0.0):
    """Cordura nylon: OCP printed or a solid colour (tuple), optional MOLLE rows."""
    def fn(a):
        P, N = a['P'], a['N']
        if pattern == 'ocp':
            base = K.ocp(P, seed, 0.9)
        else:
            base = np.tile(np.array(pattern, np.float64), (len(P), 1))
            base *= (0.94 + 0.12 * T.fbm(P, 0.08, 3, seed + 3))[:, None]
        h = cordura(P)
        if molle:
            mh, on = molle_height(P, N, z0)
            h += mh
            base *= (1 - 0.10 * (1 - on) * (1 - smooth(0.5, 0.8, np.abs(N[:, 2]))))[:, None]
        base = K.dirt(P, base, wear, seed + 7, ground=1.6)
        if tint is not None:
            base *= np.array(tint)
        return {'base': base, 'rough': rough, 'height': h}
    return K.src_proc(fn, importance)


def src_solid(rgb, rough=0.6, noise=0.06, height=0.00005, scale=0.0008, importance=1.0, metal_edges=False):
    rgb = np.array(rgb, np.float64)

    def fn(a):
        P = a['P']
        base = rgb[None] * (1 - noise + 2 * noise * T.fbm(P, 0.05, 3, 41))[:, None]
        return {'base': base, 'rough': rough + 0.08 * (T.fbm(P, 0.02, 2, 42) - 0.5),
                'height': (T.vnoise(P, scale, 43) - 0.5) * height}
    return K.src_proc(fn, importance)

# ---------------------------------------------------------------------------------------------- US: plate carrier


def torso_bvh(kit, objs, zmin=0.9, zmax=1.6):
    return K.body_bvh(objs)


def bind_torso(kit, o, ref, bones=('pelvis', 'spine_01', 'spine_02', 'spine_03', 'clavicle_l', 'clavicle_r', 'neck_01')):
    K.weights_from(o, ref, filt=lambda b: b in bones)
    return K.bind(o, kit.arm)


def bind_rigid_avg(kit, o, ref, bones=('pelvis', 'spine_01', 'spine_02', 'spine_03', 'clavicle_l', 'clavicle_r')):
    """Same weights on every vertex (those of the body at the item's centre): pouches and radios stay rigid."""
    K.weights_from(o, ref, filt=lambda b: b in bones)
    acc = {}
    for v in o.data.vertices:
        for g in v.groups:
            nm = o.vertex_groups[g.group].name
            acc[nm] = acc.get(nm, 0) + g.weight
    tot = sum(acc.values()) or 1
    top = sorted(acc.items(), key=lambda t: -t[1])[:3]
    o.vertex_groups.clear()
    allv = list(range(len(o.data.vertices)))
    s = sum(w for b, w in top)
    for b, w in top:
        o.vertex_groups.new(name=b).add(allv, w / s, 'REPLACE')
    return K.bind(o, kit.arm)


def plate_carrier(kit, shirt, seed=1, layout='a'):
    """Plate carrier (SPCS / JPC style) with cummerbund, padded shoulder straps, front M4 magazine pouches,
    admin pouch, radio + antenna, IFAK, hydration carrier with drinking tube."""
    arm = kit.arm
    bvh = K.body_bvh([shirt])
    pc = kit.mat('pc_nylon', src_nylon(seed, 'ocp', molle=True, rough=0.92, wear=0.3), (0.6, 0.55, 0.42))
    plain = kit.mat('pc_plain', src_nylon(seed + 1, 'ocp', molle=False, rough=0.9, wear=0.3), (0.6, 0.55, 0.42))
    tan = kit.mat('webbing_tan', src_nylon(0, (0.50, 0.44, 0.33), rough=0.9, wear=0.2), (0.5, 0.44, 0.33))
    black = kit.mat('plastic_black', src_solid((0.06, 0.06, 0.06), 0.55, 0.1), (0.06, 0.06, 0.06))
    radio = kit.mat('radio', src_solid((0.20, 0.21, 0.18), 0.5, 0.08), (0.2, 0.21, 0.18))
    pmag = kit.mat('pmag', src_solid((0.55, 0.47, 0.34) if layout == 'a' else (0.07, 0.07, 0.07), 0.6, 0.05), (0.5, 0.45, 0.33))
    out = []
    sh = kit.rest['upperarm_l'][0]
    neck = kit.rest['neck_01'][0]
    zt = 1.395
    zb = 1.065
    # front and back plate bags (shooter's cut top corners)
    fo = lambda v: 0.128 - 0.045 * smooth(0.78, 1.0, v)
    front, Af = conform_panel('pc_front', bvh, fo, zb, zt, 0.008, 0.032, pc, 1, 4, 5, curve=1.6, lean=0.0)
    back, Ab = conform_panel('pc_back', bvh, lambda v: 0.135 - 0.03 * smooth(0.85, 1.0, v), zb - 0.01, zt + 0.02, 0.008, 0.03, pc, -1, 4, 5, curve=1.4)
    out += [front, back]
    # cummerbund around the sides
    for s in (-1, 1):
        th0, th1 = (35, 145) if s > 0 else (-145, -35)
        out.append(wrap_band('pc_cumm', bvh, (0, -0.01), th0, th1, zb + 0.005, zb + 0.175, 0.008, 0.016, pc, n=6, nz=1))
    # shoulder straps: from the front bag top over the shoulder to the back bag
    for s in (-1, 1):
        x = s * 0.092
        pts = []
        for t in np.linspace(0, 1, 7):
            ang = math.pi * t                       # 0 front .. pi back
            d = Vector((0, math.cos(ang), math.sin(ang)))
            c = Vector((x, -0.02, 1.36))
            p, nn = ray(bvh, c + d * 0.5, -d, 0.5)
            r = (p - c).length if p is not None else 0.14
            pts.append(c + d * (r + 0.006))
        pts[0] = Vector((x, Af + 0.004, zt - 0.02))
        pts[-1] = Vector((x, -(Ab + 0.004), zt - 0.01))
        out.append(path_strap('pc_strap', pts, 0.062, 0.014, lambda p, c=Vector((x, -0.02, 1.36)): p - c, plain, sub=1))
    # front pouches: three M4 magazine pouches across the lower front bag
    front_y = lambda x, z: Af + 0.032 - 1.6 * x * x
    pw, ph, pd = 0.074, 0.125, 0.058
    for i, x in enumerate((-0.078, 0.0, 0.078)):
        zc = zb + 0.07
        y = front_y(x, zc)
        o = box_at('mag_pouch', (x, y + pd / 2 - 0.004, zc), (pw, pd, ph), pc, n=(1, 1, 1))
        out.append(o)
        if layout == 'a' or i == 1:
            # flap over the top
            out.append(box_at('mag_flap', (x, y + pd / 2 - 0.002, zc + ph / 2 - 0.012), (pw + 0.006, pd + 0.006, 0.035), plain, sub=1))
        else:
            # open top with a PMAG floor plate showing and a pull tab
            out.append(box_at('pmag', (x, y + pd / 2 - 0.004, zc + ph / 2 + 0.012), (0.064, 0.024, 0.04), pmag, sub=1))
            out.append(box_at('pull_tab', (x, y + pd - 0.004, zc + ph / 2 + 0.004), (0.022, 0.006, 0.03), black, sub=1))
    # admin / map pouch on the upper front, name tape velcro
    zc = zt - 0.075
    y = front_y(0, zc)
    out.append(box_at('admin', (0, y + 0.016, zc), (0.17, 0.034, 0.10), plain, n=(1, 1, 1)))
    # radio pouch + radio on the left side, antenna up behind the shoulder
    side_x = -0.19
    p, nn = ray(bvh, (-0.6, -0.04, zb + 0.10), (1, 0, 0))
    sx = (p.x if p is not None else -0.17) - 0.034
    out.append(box_at('radio_pouch', (sx - 0.006, -0.05, zb + 0.10), (0.05, 0.075, 0.17), pc, n=(1, 1, 1)))
    out.append(box_at('radio', (sx - 0.006, -0.05, zb + 0.20), (0.042, 0.062, 0.06), radio, sub=1))
    out.append(tube('antenna', [(sx - 0.006, -0.06, zb + 0.23), (sx - 0.002, -0.07, zb + 0.36), (sx + 0.01, -0.09, zb + 0.48)],
                                            lambda t: 0.006 - 0.0035 * t, black, seg=6))
    # PTT cable to the right shoulder strap
    out.append(tube('ptt', [(sx + 0.01, -0.03, zb + 0.22), (-0.13, 0.02, 1.36), (-0.09, Af - 0.01, zt - 0.06)], 0.003, black, seg=5, cap=False))
    out.append(box_at('ptt_box', (-0.09, Af + 0.012, zt - 0.075), (0.035, 0.018, 0.05), black, sub=1))
    # IFAK + grenade/utility pouch on the right side
    p, nn = ray(bvh, (0.6, -0.04, zb + 0.08), (-1, 0, 0))
    sx = (p.x if p is not None else 0.17) + 0.03
    out.append(box_at('ifak', (sx, -0.07, zb + 0.08), (0.05, 0.12, 0.13), plain, n=(1, 1, 1)))
    out.append(box_at('util', (sx - 0.01, 0.04, zb + 0.09), (0.045, 0.06, 0.09), pc))
    # hydration carrier on the back, drinking tube over the right shoulder
    yb = -(Ab + 0.03)
    out.append(box_at('hydration', (0, yb - 0.025, 1.20), (0.21, 0.05, 0.36), pc, n=(2, 1, 2), bulge=0.25))
    hose = [(0.07, yb - 0.02, 1.37), (0.095, -0.12, 1.47), (0.10, 0.02, 1.49), (0.10, Af + 0.02, 1.40), (0.10, Af + 0.03, 1.33)]
    out.append(tube('hose', hose, 0.006, black, seg=6))
    for o in out:
        if o.name.startswith(('pc_front', 'pc_back', 'pc_cumm', 'pc_strap', 'hose', 'ptt')):
            bind_torso(kit, o, shirt)
        else:
            bind_rigid_avg(kit, o, shirt)
        o['decimate'] = 0.5
        kit.add(o, 'torso')
    return Af, Ab

# ---------------------------------------------------------------------------------------------- US: helmet


def head_surface(objs):
    return K.body_bvh(objs)


def helmet(kit, head_objs, seed=1, goggles=False, nvg=True):
    """ACH / ECH style helmet with OCP cover, rubber edge trim, NVG shroud, ARC side rails, four-point chin strap.
    The shell follows the skull (+hair) shape, ray cast from the centre of the head."""
    bvh = K.body_bvh(head_objs)
    H = kit.rest['Head'][0]
    c = Vector((H[0], H[1] + 0.012, H[2] + 0.085))
    nu, nv = 36, 13
    off = 0.026
    R = np.zeros((nv + 1, nu))
    for j in range(nv + 1):
        el = math.radians(90 - j * (115 / nv))         # 90 = top .. -25 below the centre
        for i in range(nu):
            az = 2 * math.pi * i / nu                  # 0 = front (+Y)
            d = Vector((math.cos(el) * math.sin(az), math.cos(el) * math.cos(az), math.sin(el)))
            p, nn = ray(bvh, c + d * 0.4, -d, 0.4)
            R[j, i] = ((p - c).length if p is not None else 0.1) + off
    # smooth into a clean shell (helmets are smooth): circular smoothing along az, then along el
    for _ in range(6):
        R = 0.5 * R + 0.25 * (np.roll(R, 1, 1) + np.roll(R, -1, 1))
        R[1:-1] = 0.5 * R[1:-1] + 0.25 * (R[:-2] + R[2:])
    R[0] = R[0].mean()
    R = np.maximum(R, R.max() * 0.0 + 0.0)

    def rim(az):
        # rim height relative to the centre: high at the brow, cut over the ears, low at the nape
        fa = math.cos(az)                               # +1 front, -1 back
        sa = abs(math.sin(az))
        z = -0.020 * (1 + fa) / 2 + (-0.075) * (1 - fa) / 2
        z += 0.022 * smooth(0.75, 0.97, sa) * (1 - abs(fa))    # ear cut
        return z
    cover = kit.mat('helmet_cover', src_nylon(seed + 4, 'ocp', rough=0.92, wear=0.25, importance=1.2), (0.6, 0.55, 0.42))
    rubber = kit.mat('helmet_trim', src_solid((0.10, 0.10, 0.09), 0.7, 0.05), (0.1, 0.1, 0.1))
    black = kit.mat('plastic_black', src_solid((0.06, 0.06, 0.06), 0.55, 0.1), (0.06, 0.06, 0.06))
    tan = kit.mat('webbing_tan', src_nylon(0, (0.50, 0.44, 0.33), rough=0.9, wear=0.2), (0.5, 0.44, 0.33))
    bm = bmesh.new()
    rows = []
    ELS = []
    for j in range(nv + 1):
        el = math.radians(90 - j * (115 / nv))
        row = []
        for i in range(nu):
            az = 2 * math.pi * i / nu
            d = Vector((math.cos(el) * math.sin(az), math.cos(el) * math.cos(az), math.sin(el)))
            p = c + d * R[j, i]
            zr = c.z + rim(az)
            if p.z < zr:
                # clamp onto the rim plane along the surface (slide up)
                p = c + d * R[j, i]
                p.z = zr
            row.append(bm.verts.new(p))
        rows.append(row)
    top = bm.verts.new(c + Vector((0, 0, R[0].mean())))
    for i in range(nu):
        bm.faces.new((top, rows[0][(i + 1) % nu], rows[0][i]))
    for j in range(nv):
        for i in range(nu):
            bm.faces.new((rows[j][i], rows[j][(i + 1) % nu], rows[j + 1][(i + 1) % nu], rows[j + 1][i]))
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=0.002)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    me = bpy.data.meshes.new('helmet')
    bm.to_mesh(me)
    bm.free()
    shell = bpy.data.objects.new('helmet', me)
    bpy.context.scene.collection.objects.link(shell)
    me.materials.append(cover)
    for p in me.polygons:
        p.use_smooth = True
    # drop degenerate faces collapsed onto the rim
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.dissolve_degenerate(bm, edges=bm.edges[:], dist=0.0015)
    bm.to_mesh(me)
    bm.free()
    m = shell.modifiers.new('sol', 'SOLIDIFY')
    m.thickness = 0.008
    m.offset = -1
    K.apply_mods(shell)
    C.box_uv(shell, 1.0)
    out = [shell]
    # rubber edge trim along the rim
    rp = []
    for i in range(nu * 2 + 1):
        az = 2 * math.pi * i / (nu * 2)
        el_lo, best = None, None
        # rim point: the shell radius at the rim height
        d = Vector((math.sin(az), math.cos(az), 0))
        zr = rim(az)
        # radius at that height from R by interpolating along el
        el = math.asin(max(min(zr / 0.13, 1), -1))
        j = (90 - math.degrees(el)) / (115 / nv)
        j0 = min(int(j), nv - 1)
        t = j - j0
        ii = (i / 2) % nu
        i0 = int(ii) % nu
        r = (R[j0, i0] * (1 - t) + R[j0 + 1, i0] * t)
        p = c + Vector((math.cos(el) * math.sin(az), math.cos(el) * math.cos(az), 0)) * r
        p.z = c.z + zr
        rp.append(p)
    out.append(tube('helmet_trim', rp[::2], 0.0055, rubber, seg=5, cap=False))
    # NVG shroud on the front, ARC rails on the sides
    if nvg:
        az = 0.0
        d = Vector((0, 1, 0.28)).normalized()
        p, nn = ray(K.body_bvh([shell]), c + d * 0.4, -d, 0.4)
        if p is not None:
            q = Quaternion(Vector((1, 0, 0)), -math.radians(18))
            out.append(box_at('nvg_shroud', p + nn * 0.006, (0.065, 0.012, 0.042), black, rot=q, sub=1))
            out.append(box_at('nvg_mount', p + nn * 0.016 + Vector((0, 0.004, -0.012)), (0.028, 0.018, 0.024), black, rot=q, sub=1))
    for s in (-1, 1):
        d = Vector((s, 0.05, 0.05)).normalized()
        p, nn = ray(K.body_bvh([shell]), c + d * 0.4, -d, 0.4)
        if p is not None:
            q = Quaternion(Vector((0, 0, 1)), 0)
            out.append(box_at('arc_rail', p + nn * 0.004 + Vector((0, 0.0, -0.005)), (0.010, 0.11, 0.018), black, sub=1))
    # counterweight / IR patch at the back
    d = Vector((0, -1, 0.15)).normalized()
    p, nn = ray(K.body_bvh([shell]), c + d * 0.4, -d, 0.4)
    if p is not None:
        out.append(box_at('helmet_patch', p + nn * 0.003, (0.06, 0.006, 0.04), kit.mat('helmet_cover'), sub=1))
    # chin strap: from the rim at the temple and the nape down under the chin
    hb = K.body_bvh(head_objs)
    for s in (-1, 1):
        pts = []
        for t in np.linspace(0, 1, 7):
            # from the rim just in front of the ear to under the chin
            ang = math.radians(90 - 85 * t)
            q = Vector((s * math.sin(math.radians(80)) * (1 - t * 0.85), 0.04 + 0.05 * t, -0.04 - 0.12 * t))
            o = Vector((H[0], H[1] + 0.03, H[2] + 0.02)) + Vector((0, 0, 0))
            dd = Vector((s * (1 - t) + 0.0, 0.25 + 0.6 * t, -0.2 - 0.9 * t)).normalized()
            pp, nn = ray(hb, o + dd * 0.4, -dd, 0.4)
            pts.append((pp + nn * 0.004) if pp is not None else o + dd * 0.1)
        out.append(path_strap('chinstrap', pts, 0.016, 0.003, lambda p, o=Vector((H[0], H[1] + 0.03, H[2])): p - o, tan, sub=0))
    for o in out:
        K.rigid(o, kit.arm, 'Head')
        o['decimate'] = 0.55
        kit.add(o, 'head')
    if goggles:
        pass
    return shell

# ---------------------------------------------------------------------------------------------- legs: boots, pads, pockets


def full_body(kit):
    """Temporary complete body (weights included) for ray casts and weight transfer."""
    o = kit.h.body('tmp_fullbody')
    return o, K.body_bvh([o])


def tuck_trousers(trousers, bvh, z_top=0.215, gap=0.007, blouse=0.007):
    """Trouser legs tucked into boots: below z_top hug the leg, just above it they balloon out a little."""
    for v in trousers.data.vertices:
        z = v.co.z
        if z > z_top + 0.06:
            continue
        loc, nrm, idx, d = bvh.find_nearest(v.co)
        if loc is None:
            continue
        dirv = (v.co - loc)
        if dirv.length < 1e-6:
            continue
        dirv.normalize()
        if z <= z_top:
            v.co = loc + dirv * min(d, gap)
        else:
            t = (z - z_top) / 0.06
            v.co = v.co + dirv * blouse * math.sin(math.pi * t) * (1 if d < 0.03 else 0.3)
    trousers.data.update()


def leg_shell(name, kit, bvh, side, z0, z1, gap, mat, nseg=16, nz=5, thick=0.004):
    """Boot shaft: ring band around the lower leg from z0 to z1, conformed to the leg."""
    sx = -1 if side == 'l' else 1
    knee = Vector(kit.rest['calf_' + side][0])
    ank = Vector(kit.rest['foot_' + side][0])
    bm = bmesh.new()
    rows = []
    for j in range(nz + 1):
        z = z0 + (z1 - z0) * j / nz
        t = (z - ank.z) / (knee.z - ank.z)
        c = ank.lerp(knee, max(t, 0.0))
        c.z = z
        row = []
        for i in range(nseg):
            a = 2 * math.pi * i / nseg
            d = Vector((math.sin(a), math.cos(a), 0))
            # from inside the leg outwards: rays from outside would hit the other leg first
            p, nn = ray(bvh, c, d, 0.12)
            r = (p - c).length if p is not None else 0.05
            row.append(bm.verts.new(c + d * (r + gap + 0.003 * (1 - j / nz))))
        rows.append(row)
    for j in range(nz):
        for i in range(nseg):
            bm.faces.new((rows[j][i], rows[j][(i + 1) % nseg], rows[j + 1][(i + 1) % nseg], rows[j + 1][i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    me.materials.append(mat)
    for p in me.polygons:
        p.use_smooth = True
    m = o.modifiers.new('sol', 'SOLIDIFY')
    m.thickness = thick
    m.offset = 1
    K.apply_mods(o)
    C.box_uv(o, 1.0)
    return o


def us_legs(kit, trousers, boot_mat, seed=1, knee_pads=True):
    fb, bvh = full_body(kit)
    tuck_trousers(trousers, bvh)
    out = []
    for s in 'lr':
        sh = leg_shell('boot_shaft', kit, bvh, s, 0.055, 0.215, 0.013, boot_mat)
        K.weights_from(sh, fb, filt=lambda b: b.startswith(('calf', 'foot')))
        K.bind(sh, kit.arm)
        sh['decimate'] = 1.0
        kit.add(sh, 'legs')
    tb = K.body_bvh([trousers])
    pad = kit.mat('kneepad', src_solid((0.36, 0.31, 0.24), 0.75, 0.08, 0.0002, 0.002), (0.5, 0.44, 0.33))
    pocket = kit.mat('ocp_pocket', src_nylon(seed + 9, 'ocp', rough=0.9, wear=0.4), (0.6, 0.55, 0.42))
    for s in 'lr':
        sx = -1 if s == 'l' else 1
        knee = Vector(kit.rest['calf_' + s][0])
        if knee_pads:
            p, nn = ray(tb, (knee.x, 0.5, knee.z + 0.01), (0, -1, 0))
            if p is not None:
                o = box_at('kneepad', p + Vector((0, 0.014, 0)), (0.10, 0.028, 0.15), pad, n=(2, 1, 2), bulge=0.4)
                o.vertex_groups.clear()
                allv = list(range(len(o.data.vertices)))
                o.vertex_groups.new(name='calf_' + s).add(allv, 0.65, 'REPLACE')
                o.vertex_groups.new(name='thigh_' + s).add(allv, 0.35, 'REPLACE')
                K.bind(o, kit.arm)
                o['decimate'] = 0.45
                kit.add(o, 'legs')
        # cargo pocket on the outer thigh
        z = 0.73
        p, nn = ray(tb, (sx * 0.6, -0.01, z), (-sx, 0, 0))
        if p is not None:
            q = Quaternion(Vector((0, 0, 1)), -sx * math.pi / 2)
            o = box_at('cargo', p + Vector((sx * 0.008, 0, 0)), (0.15, 0.018, 0.19), pocket, rot=q, n=(2, 1, 2), bulge=0.5)
            out.append((o, 'thigh_' + s))
            f = box_at('cargo_flap', p + Vector((sx * 0.018, 0, 0.085)), (0.155, 0.01, 0.05), pocket, rot=q)
            out.append((f, 'thigh_' + s))
    for o, bone in out:
        K.rigid(o, kit.arm, bone)
        o['decimate'] = 0.45
        kit.add(o, 'legs')
    bpy.data.objects.remove(fb, do_unlink=True)


def sleeve_pockets(kit, shirt, seed=1, flag=True):
    sb = K.body_bvh([shirt])
    pocket = kit.mat('ocp_pocket', src_nylon(seed + 9, 'ocp', rough=0.9, wear=0.4), (0.6, 0.55, 0.42))
    flagm = kit.mat('flag_patch', src_proc(lambda a: flag_patch(a)), (0.4, 0.38, 0.3))
    for s in 'lr':
        sx = -1 if s == 'l' else 1
        h = Vector(kit.rest['upperarm_' + s][0])
        t = Vector(kit.rest['lowerarm_' + s][0])
        c = h.lerp(t, 0.5)
        p, nn = ray(sb, (c.x, c.y, c.z + 0.4), (0, 0, -1))
        if p is None:
            continue
        o = box_at('sleeve_pocket', p + Vector((0, 0, 0.006)), (0.12, 0.012, 0.10), pocket,
                   rot=Quaternion(Vector((1, 0, 0)), math.pi / 2), n=(2, 1, 2), bulge=0.3)
        K.rigid(o, kit.arm, 'upperarm_' + s)
        o['decimate'] = 0.45
        kit.add(o)
        if flag and s == 'r':
            fp = box_at('flag', p + Vector((0, 0, 0.0135)), (0.085, 0.003, 0.052), flagm,
                        rot=Quaternion(Vector((1, 0, 0)), math.pi / 2), sub=0)
            C.box_uv(fp, 1.0)
            K.rigid(fp, kit.arm, 'upperarm_' + s)
            kit.add(fp)


def src_proc(fn):
    return K.src_proc(fn)


def flag_patch(a):
    """Subdued (OCP-coloured) reversed US flag patch: stripes and a star field, from rest position."""
    P = a['P']
    x = np.abs(P[:, 0])
    y = P[:, 1]
    base = np.tile(np.array([0.55, 0.50, 0.38]), (len(P), 1))
    stripes = ((y + 0.03) // (0.052 / 13)) % 2 == 0
    base[stripes] = [0.38, 0.35, 0.27]
    return {'base': base, 'rough': 0.9, 'height': None}

# ---------------------------------------------------------------------------------------------- US variant extras


def glasses(kit, lm):
    """Ballistic spectacles (wrap-around): dark smoked lens band in front of the eyes, black frame, temple arms
    back to the ears. Rigid on the head."""
    E = Vector(lm['eye'])
    frame = kit.mat('frame_black', src_solid((0.04, 0.04, 0.04), 0.4, 0.05), (0.04, 0.04, 0.04))
    lens = kit.mat('lens_smoke', src_solid((0.05, 0.05, 0.05), 0.05, 0.02, 0.0, 0.01), (0.05, 0.05, 0.05))
    hw = lm['eye_dx'] / 2 + 0.034
    pts = []
    for x in np.linspace(-hw, hw, 11):
        y = E.y + 0.024 - 3.2 * x * x
        pts.append(Vector((E.x + x, y, E.z + 0.002 - 0.004 * (abs(x) / hw) ** 2)))
    out = [path_strap('lens', pts, 0.038, 0.002, lambda p: Vector((p.x - E.x, 1.0, 0)), lens, sub=0)]
    top = [p + Vector((0, 0.001, 0.019)) for p in pts]
    out.append(tube('frame_top', top, 0.0025, frame, seg=5, cap=True))
    for s in (-1, 1):
        a = Vector((E.x + s * hw, E.y + 0.024 - 3.2 * hw * hw, E.z + 0.012))
        out.append(tube('temple', [a, a + Vector((s * 0.008, -0.04, 0.0)), a + Vector((s * 0.010, -0.095, -0.004))], 0.002, frame, seg=4))
    for o in out:
        K.rigid(o, kit.arm, 'Head')
        kit.add(o, 'head')


def neck_scarf(kit, ref_objs, mat):
    """Shemagh rolled loosely around the neck (over the collar)."""
    bvh = K.body_bvh(ref_objs)
    nk = Vector(kit.rest['neck_01'][0])
    o = wrap_band('neck_scarf', bvh, (nk.x, nk.y + 0.005), -178, 178, nk.z - 0.03, nk.z + 0.03, 0.012, 0.02, mat, n=16, nz=2, sub=1)
    # loose, bunched-up roll: a few lumps
    rng = np.random.default_rng(3)
    ph = rng.uniform(0, 6.3, 3)
    for v in o.data.vertices:
        d = v.co - Vector((nk.x, nk.y, v.co.z))
        a = math.atan2(d.x, d.y)
        k = 1 + 0.18 * math.sin(5 * a + ph[0]) + 0.1 * math.sin(9 * a + ph[1])
        v.co = Vector((nk.x, nk.y, v.co.z)) + d * (1 + (k - 1) * 0.15)
    for lp in o.data.uv_layers[0].data:
        lp.uv = (lp.uv[0] * 6, lp.uv[1] * 6)
    o.vertex_groups.clear()
    allv = list(range(len(o.data.vertices)))
    o.vertex_groups.new(name='neck_01').add(allv, 0.6, 'REPLACE')
    o.vertex_groups.new(name='spine_03').add(allv, 0.4, 'REPLACE')
    K.bind(o, kit.arm)
    o['decimate'] = 0.7
    kit.add(o, 'head')
    return o

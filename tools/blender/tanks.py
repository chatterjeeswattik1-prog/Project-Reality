"""Convert the user's tank models (Sketchfab, CC BY 4.0) to the vehicle contract (CLAUDE.md "Vehicles").
    blender -b --factory-startup --python tools/blender/tanks.py -- <srcDir> public/models/vehicles [--only m1a2,m2a3] [--preview dir]
Sources: abrams_m1a2.glb (coderslava402), m2_bradley_ifv.glb (42manako). Both are modelled facing -Y at an arbitrary
scale: they are turned to +Y forward and scaled to the real overall length (M1A2 9.83 m with the gun forward,
M2A3 6.55 m), the origin is put on the ground at the middle of the running gear, and they are split into
  <id> (root) > body (hull), track_l, track_r (material `track`, scrolled by the game), rw_l_<n>/rw_r_<n> (road wheels,
  origin at the hub; M1A2 only), turret (origin on the ring centre, traverse about Z) > gun (origin on the trunnion,
  elevation about X) > muzzle, coax; crew eye empties seat_driver (hull), seat_gunner / seat_commander / seat_loader
  (turret), weapon empties mg_cmdr / mg_loader / tow (turret), seat_cargo_<n> + exit_rear (M2A3), exit_l / exit_r.
The M1A2's 201k triangles are collapse-decimated to ~45k; the M2A3 is recoloured from woodland camouflage to desert tan."""
import os, sys, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy, bmesh
import numpy as np
from mathutils import Vector, Matrix
from vcommon import vexport, limit_tris, desel, kill
from common import preview

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
SRC = argv[0] if argv else 'C:/Users/Administrator/Downloads'
OUT = argv[1] if len(argv) > 1 else 'public/models/vehicles'
ONLY = argv[argv.index('--only') + 1].split(',') if '--only' in argv else None
PREV = argv[argv.index('--preview') + 1] if '--preview' in argv else None


def load(path, scale):
    """Import, bake every mesh's world transform into its data, turn to +Y forward and scale to metres."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path)
    bpy.context.view_layer.update()
    M = Matrix.Rotation(math.pi, 4, 'Z') @ Matrix.Scale(scale, 4)
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    for o in meshes:
        if o.data.users > 1:
            o.data = o.data.copy()
        mw = o.matrix_world.copy()
        o.parent = None
        o.data.transform(M @ mw)
        o.matrix_world = Matrix.Identity(4)
    kill([o for o in bpy.context.scene.objects if o.type != 'MESH'])
    return {o.name: o for o in meshes}


def bounds(objs):
    ps = [v.co for o in objs for v in o.data.vertices]
    return Vector((min(p.x for p in ps), min(p.y for p in ps), min(p.z for p in ps))), Vector((max(p.x for p in ps), max(p.y for p in ps), max(p.z for p in ps)))


def shift(objs, d):
    for o in objs:
        o.data.transform(Matrix.Translation(-d))


def join(objs, name):
    desel()
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    o.name = name; o.data.name = name
    return o


def loose_parts(o):
    bm = bmesh.new(); bm.from_mesh(o.data); bm.verts.ensure_lookup_table()
    seen, parts = set(), []
    for v in bm.verts:
        if v.index in seen:
            continue
        stack, ids = [v], []
        seen.add(v.index)
        while stack:
            a = stack.pop(); ids.append(a.index)
            for e in a.link_edges:
                b = e.other_vert(a)
                if b.index not in seen:
                    seen.add(b.index); stack.append(b)
        ps = [bm.verts[i].co for i in ids]
        lo = Vector((min(p.x for p in ps), min(p.y for p in ps), min(p.z for p in ps)))
        hi = Vector((max(p.x for p in ps), max(p.y for p in ps), max(p.z for p in ps)))
        parts.append((set(ids), lo, hi))
    bm.free()
    return parts


def keep_verts(o, keep):
    bm = bmesh.new(); bm.from_mesh(o.data); bm.verts.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.index not in keep], context='VERTS')
    bm.to_mesh(o.data); bm.free(); o.data.update()


def split(o, pred, name):
    """Move the loose parts of o for which pred(lo, hi) holds into a new object `name`."""
    parts = loose_parts(o)
    sel = set().union(*[p[0] for p in parts if pred(p[1], p[2])]) if parts else set()
    n = len(o.data.vertices)
    b = o.copy(); b.data = o.data.copy(); bpy.context.scene.collection.objects.link(b)
    b.name = name; b.data.name = name
    keep_verts(b, sel)
    keep_verts(o, set(range(n)) - sel)
    print(f'split {name}: {len(sel)} of {n} verts')
    return b


def by_x(o, name_l, name_r):
    """Split a mesh holding both sides into left (x < 0) and right parts."""
    r = split(o, lambda lo, hi: (lo.x + hi.x) / 2 > 0, name_r)
    o.name = name_l; o.data.name = name_l
    return o, r


def pivot(o, p, parent=None):
    """Put o's origin at p (world) and parent it keeping its world placement."""
    o.data.transform(Matrix.Translation(-p))
    o.matrix_world = Matrix.Translation(p)
    if parent is not None:
        o.parent = parent
        o.matrix_parent_inverse = parent.matrix_world.inverted()


def emp(name, p, parent):
    e = bpy.data.objects.new(name, None)
    e.empty_display_size = 0.15
    bpy.context.scene.collection.objects.link(e)
    e.matrix_world = Matrix.Translation(Vector(p))
    e.parent = parent
    e.matrix_parent_inverse = parent.matrix_world.inverted()
    return e


def ring_of(turret):
    """Turret ring centre: the middle of the turret's lowest vertices (the race)."""
    zs = [v.co.z for v in turret.data.vertices]
    z0 = min(zs)
    low = [v.co for v in turret.data.vertices if v.co.z < z0 + 0.06]
    return Vector(((min(p.x for p in low) + max(p.x for p in low)) / 2, (min(p.y for p in low) + max(p.y for p in low)) / 2, z0))


def roof_of(turret, q=0.8):
    zs = sorted(v.co.z for v in turret.data.vertices)
    return zs[int(len(zs) * q)]


def track_mat(objs):
    m = objs[0].data.materials[0] if objs[0].data.materials else bpy.data.materials.new('track')
    m.name = 'track'
    for o in objs:
        o.data.materials.clear(); o.data.materials.append(m)


def desert(mat_name):
    """Woodland camouflage → desert tan: keep the texture's light/dark detail (rivets, dirt, markings), drop its hues."""
    m = bpy.data.materials.get(mat_name)
    if not m or not m.use_nodes:
        return
    for n in m.node_tree.nodes:
        if n.type == 'TEX_IMAGE' and n.image and any(l.to_socket.name == 'Base Color' for l in n.outputs['Color'].links):
            img = n.image
            px = np.array(img.pixels[:], dtype=np.float32).reshape(-1, 4)
            lum = px[:, 0] * 0.3 + px[:, 1] * 0.55 + px[:, 2] * 0.15
            k = np.clip(lum / max(1e-3, float(np.median(lum))), 0.25, 2.6) ** 0.55
            tan = np.array([0.50, 0.40, 0.25], dtype=np.float32)  # linear (sRGB ~ 188, 170, 136)
            px[:, :3] = np.clip(tan[None, :] * k[:, None], 0, 1)
            img.pixels[:] = px.ravel()
            img.update()
            print('recoloured', img.name)


def finish(root_name, body, parts, prev_target):
    root = bpy.data.objects.new(root_name, None)
    bpy.context.scene.collection.objects.link(root)
    for o in [body] + parts:
        if o.parent is None:
            o.parent = root
    for o in bpy.context.scene.objects:
        if o.type == 'MESH':
            o.data.calc_loop_triangles()
    tris = sum(len(o.data.loop_triangles) for o in bpy.context.scene.objects if o.type == 'MESH')
    print(f'{root_name}: {tris} triangles')
    path = os.path.join(OUT, f'{root_name}.glb')
    vexport(path, root)
    print('wrote', path)
    if PREV:
        for name, az, el in (('q', -35, 20), ('side', 90, 8), ('front', 180, 12), ('rear', 0, 15)):
            preview(os.path.join(PREV, f'{root_name}_{name}.png'), target=prev_target, dist=13, az=az, el=el, res=(900, 560), samples=10)


# ---------------- M1A2 Abrams ----------------
def m1a2():
    L = 9.83 / 3.16  # overall length with the gun forward / model length
    o = load(os.path.join(SRC, 'abrams_m1a2.glb'), L)
    wheels = [o[f'Object_{i}'] for i in range(15, 50, 2)]
    track_a, track_b = join([o['Object_4'], o['Object_5']], 'tA'), join([o['Object_51'], o['Object_52']], 'tB')
    lo, hi = bounds(wheels + [track_a, track_b])
    origin = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
    everything = [x for x in bpy.context.scene.objects if x.type == 'MESH']
    shift(everything, origin)
    # Left/right after the turn: the track whose centre is at negative x is the left one.
    tl, tr = (track_a, track_b) if bounds([track_a])[0].x < 0 else (track_b, track_a)
    tl.name = tl.data.name = 'track_l'; tr.name = tr.data.name = 'track_r'
    for t in (tl, tr):
        limit_tris(t, 3200)
    track_mat([tl, tr])
    body = join([o['Object_7'], o['Object_11']], 'body')
    limit_tris(body, 16000)
    turret = o['Object_13']; turret.name = turret.data.name = 'turret'
    limit_tris(turret, 11000)
    gun = o['Object_9']; gun.name = gun.data.name = 'gun'
    limit_tris(gun, 1500)
    ring = ring_of(turret); roof = roof_of(turret, 0.7)
    # Commander's weapon station: the M2HB on its pintle in front of the cupola is cut out of the turret (every loose
    # part inside its box; the roof box to its left and the cupola behind stay) and made two parts the game moves:
    # `cws` (the post, traverses about its vertical axis) > `cws_gun` (receiver, barrel, ammo box; elevates about the
    # trunnion at the top of the post), with `cws_muzzle` and the commander's eye `cws_eye` (head out of the hatch,
    # behind the receiver, sighting over it). Measured in this model: barrel axis x 0.493, height 2.95; post at y 0.57.
    inbox = lambda a, b: a.x > 0.33 and b.x < 0.72 and a.y > 0.0 and b.y < 1.95 and a.z > 2.68 and b.z < 3.2
    post = lambda a, b: 0.5 < a.y and b.y < 0.645 and b.z < 2.99
    cws_gun = split(turret, lambda a, b: inbox(a, b) and not post(a, b), 'cws_gun')
    cws = split(turret, lambda a, b: inbox(a, b) and post(a, b), 'cws')
    # It traverses round the cupola (a ring mount: the gun stays in front of the commander's face whichever way it
    # points), so `cws` turns about the cupola's centre; the cradle elevates at the top of the post.
    cws_base, cws_trun = Vector((0.493, -0.04, 2.711)), Vector((0.493, 0.572, 2.95))
    glo, ghi = bounds([gun])
    axis = Vector(((glo.x + ghi.x) / 2, 0, (glo.z + ghi.z) / 2))
    trunnion = Vector((axis.x, glo.y - 0.35, axis.z))  # the barrel enters the mantlet; trunnions ~0.35 m behind
    print('ring', ring, 'roof', roof, 'gun', glo, ghi)
    pivot(turret, ring)
    pivot(gun, trunnion, turret)
    pivot(cws, cws_base, turret)
    pivot(cws_gun, cws_trun, cws)
    emp('cws_muzzle', (0.493, 1.745, 2.95), cws_gun)
    emp('cws_eye', (0.493, -0.2, 3.25), cws)
    emp('muzzle', (axis.x, ghi.y, axis.z), gun)
    emp('coax', (axis.x + 0.42, trunnion.y + 0.55, axis.z + 0.05), gun)
    # Crew: gunner right front (primary sight), commander right rear (cupola, pintle M2), loader left (hatch, M240).
    emp('seat_gunner', (ring.x + 0.55, ring.y + 1.15, roof + 0.12), turret)
    emp('seat_commander', (ring.x + 0.55, ring.y - 0.15, roof + 0.62), turret)
    emp('seat_loader', (ring.x - 0.62, ring.y - 0.05, roof + 0.55), turret)
    emp('mg_cmdr', (ring.x + 0.45, ring.y + 0.75, roof + 0.62), turret)
    emp('mg_loader', (ring.x - 0.6, ring.y + 0.65, roof + 0.42), turret)
    wl = []
    for i, w in enumerate(sorted(wheels, key=lambda w: (bounds([w])[0].x > 0, bounds([w])[0].y))):
        a, b = bounds([w]); side = 'r' if a.x > 0 else 'l'
        n = len([x for x in wl if x.name.startswith(f'rw_{side}')])
        w.name = w.data.name = f'rw_{side}_{n}'
        limit_tris(w, 320)
        pivot(w, (a + b) / 2)
        wl.append(w)
    root = bpy.data.objects.new('m1a2_root_tmp', None)
    bpy.context.scene.collection.objects.link(root)
    emp('seat_driver', (0, hi.y - origin.y - 1.55, 1.55), root)
    emp('exit_l', (-2.4, 0, 0.05), root); emp('exit_r', (2.4, 0, 0.05), root)
    kids = [c for c in root.children]
    for c in kids:
        mw = c.matrix_world.copy(); c.parent = None; c.matrix_world = mw
    kill([root])
    finish('m1a2', body, [tl, tr, turret] + wl + kids, (0, 0, 1.4))


# ---------------- M2A3 Bradley ----------------
def m2a3():
    L = 6.55 / 2.46
    o = load(os.path.join(SRC, 'm2_bradley_ifv.glb'), L)
    treads = o['treads_lod_02 - Default_0']
    belts = [o['Object03_02 - Default_0'], o['Object04_13 - Default_0']]
    lo, hi = bounds([treads] + belts)
    origin = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
    shift([x for x in bpy.context.scene.objects if x.type == 'MESH'], origin)
    tl, tr = by_x(treads, 'track_l', 'track_r')
    bl = [b for b in belts if bounds([b])[0].x < 0][0]; br = [b for b in belts if b is not bl][0]
    tl = join([tl, bl], 'track_l'); tr = join([tr, br], 'track_r')
    track_mat([tl, tr])
    body = join([o['body_lod0_01 - Default_0'], o['bagsbagsba_03 - Default_0'], o['Object05_03 - Default_0']], 'body')
    turret = o['turret_lod_01 - Default_0']; turret.name = turret.data.name = 'turret'
    tlo, thi = bounds([turret])
    print('turret bounds', tlo, thi)
    # The 25 mm Bushmaster (barrel, flash hider, mantlet) sits forward of the turret face on the left of its centre line.
    gun = split(turret, lambda a, b: a.y > thi.y - 1.85 and -0.05 < (a.x + b.x) / 2 < 0.45 and 2.25 < (a.z + b.z) / 2 < 2.85 and b.z - a.z < 0.4, 'gun')
    glo, ghi = bounds([gun])
    print('turret', tlo, thi, 'gun', glo, ghi)
    ring = ring_of(turret); roof = roof_of(turret, 0.75)
    axis = Vector(((glo.x + ghi.x) / 2, 0, (glo.z + ghi.z) / 2))
    trunnion = Vector((axis.x, glo.y + 0.05, axis.z))
    pivot(turret, ring)
    pivot(gun, trunnion, turret)
    emp('muzzle', (axis.x, ghi.y, axis.z), gun)
    emp('coax', (axis.x + 0.3, trunnion.y + 0.15, axis.z), gun)
    # Gunner left of the gun (ISU sight), commander right; the TOW twin launcher on the turret's left side.
    emp('seat_gunner', (ring.x - 0.35, ring.y + 0.75, roof + 0.18), turret)
    emp('seat_commander', (ring.x + 0.45, ring.y + 0.1, roof + 0.55), turret)
    emp('tow', (tlo.x + 0.22, ring.y + 0.55, roof + 0.25), turret)
    root = bpy.data.objects.new('tmp', None); bpy.context.scene.collection.objects.link(root)
    hlo, hhi = bounds([body])
    emp('seat_driver', (-0.62, hhi.y - 1.45, 1.75), root)
    for i in range(6):
        emp(f'seat_cargo_{i}', (-0.5 if i % 2 == 0 else 0.5, hlo.y + 0.9 + (i // 2) * 0.7, 1.35), root)
    emp('exit_rear', (0, hlo.y - 1.2, 0.05), root)
    emp('exit_l', (-2.3, 0, 0.05), root); emp('exit_r', (2.3, 0, 0.05), root)
    kids = [c for c in root.children]
    for c in kids:
        mw = c.matrix_world.copy(); c.parent = None; c.matrix_world = mw
    kill([root])
    for mname in ('01_-_Default',):  # hull and turret; tracks and road wheels keep their steel
        desert(mname)
    finish('m2a3', body, [tl, tr, turret] + kids, (0, 0, 1.3))


if not ONLY or 'm1a2' in ONLY:
    m1a2()
if not ONLY or 'm2a3' in ONLY:
    m2a3()

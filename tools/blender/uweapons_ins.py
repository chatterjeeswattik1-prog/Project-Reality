"""Insurgent weapons from the user-supplied models (E:/Terraform_Automation/New/Insurgent) -> public/models/weapons.
    blender -b --factory-startup --python tools/blender/uweapons_ins.py -- akm [ak47 ...] [--shots <dir>]
Each build_<id>() follows ucommon's pipeline; coordinates are read off uexplore.py's gridded renders (weapon space
before the grip is moved to the origin, unless noted). See CLAUDE.md "Weapons" for the node contract."""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
import ucommon as U
import math
from mathutils import Vector, Matrix

SHOTS, SHOT_PPM, SHOT_VIEWS = None, 2000, ('side', 'top')  # --shots <dir> [--ppm N] [--views side,top,front]


def finish(id_, body, grip, parts=(), nodes=None, tex=1024, ntex=None):
    """Move the grip to the origin, build the root with the body, the animated parts and the empties.
    parts: [(obj, origin)] child meshes with their origin (pre-move space); nodes: {name: (point, parent_name|None)}."""
    g = Vector(grip)
    if SHOTS:  # gridded check renders in pre-move space, every node marked (grip red, part origins blue, empties green)
        mk = [(g, (1, 0, 0))] + [(p, (0, 0.3, 1)) for o, p in parts if o is not None]
        mk += [(p, (0, 1, 0)) for p, _ in (nodes or {}).values()]
        for v in SHOT_VIEWS:
            U.ortho(os.path.join(SHOTS, f'{id_}_{v}.png'), v, ppm=SHOT_PPM, marks=mk)
    U.move(-g)
    r = U.root(id_)
    U.parent(body, r)
    objs = {id_: r, body.name: body}
    for o, p in parts:
        if o is None:
            continue
        U.set_origin(o, Vector(p) - g)
        U.parent(o, r)
        objs[o.name] = o
    for name, (p, par) in (nodes or {}).items():
        U.empty(name, Vector(p) - g, objs[par] if par else r)
    U.shrink_textures(tex, ntex)
    return r


def build_akm():
    U.load('Insurgent/akm.glb'); U.flatten()
    # Source: +Y muzzle, +Z up, 0.895 m long (real AKM 0.880 m with the slant brake): kept as is.
    mag = U.join([o for o in U.meshes() if 'mag' in o.name], 'mag')
    body = U.join([o for o in U.meshes() if o is not mag], 'akm_body')
    charge = U.split(body, (0.015, 0.195, 0.08), (0.05, 0.216, 0.1), 'charge')
    finish('akm', body, (0, 0.002, -0.03),
           parts=[(mag, (0, 0.195, 0.062)), (charge, (0.03, 0.206, 0.091))],
           # eye = rear-sight notch (rear tab of the leaf), measured at 4000 px/m; level with the front post tip
           nodes={'muzzle': ((0, 0.627, 0.077), None), 'eye': ((0, 0.201, 0.1315), None), 'cheek': ((0, -0.08, 0.1315), None),  # notch top (AK picture: post tip level with the shoulders)
                  'front_post': ((0, 0.582, 0.1266), None),
                  'grip_r': ((0, 0.002, -0.03), None), 'grip_l': ((0, 0.33, 0.06), None),
                  'eject': ((0.022, 0.16, 0.095), None), 'butt': ((0, -0.265, -0.02), None),
                  'hand_mag': ((-0.022, 0.17, -0.02), 'mag'),
                  'charge_back': ((0.03, 0.116, 0.091), None), 'hand_charge': ((0.042, 0.206, 0.091), 'charge')})
    U.export('akm')


def build_ak47():
    U.load('Insurgent/ak47-Type-56.glb'); U.flatten()
    # Source: Type 56-1 underfolder (stock extended), muzzle +X, up +Z, 0.518 m long -> real 0.874 m.
    U.orient('+X', '+Z'); U.scale_len(0.874)
    # A second magazine is jungle-clamped beside the one in the gun: drop it, its clamp and its loose rounds.
    U.delete(lambda o: o.name.startswith(('BALA', 'CASQUILLO', 'SOSTEN')) or o.name in (
        'Cargador_CARGADORES1_0', 'pCube15_CARGADORES1_0', 'pCube16_CARGADORES1_0'))
    for o in U.meshes():  # 38k -> ~33k tris: the ten 380-tri screws and the dense pistol grip
        if o.name.startswith('TUKI'):
            U.decimate(o, 0.3)
        elif o.name.startswith('Empu') and U.tris([o]) > 4000:
            U.decimate(o, 0.5)
    # The tangent leaf is modelled raised ~8 deg (long-range setting): lay it down on its base (battle setting) by
    # rotating the leaf + slider about the hinge pin (pCylinder2, y 0.0905 z 0.1045), rear end down.
    leaf = [o for o in U.meshes() if o.name.startswith(('pCube4_', 'pCube6_', 'pCube7_', 'pCube8_', 'pCylinder3_', 'pCylinder4_'))]
    h = Vector((0, 0.0905, 0.1045))
    U.xform(Matrix.Translation(h) @ Matrix.Rotation(math.radians(AK47_LEAF), 4, 'X') @ Matrix.Translation(-h), leaf)
    mag = U.join([o for o in U.meshes() if 'CARGADORES1' in o.name], 'mag')
    charge = U.join([o for o in U.meshes() if o.name.startswith('Cerrojo')], 'charge')
    body = U.join([o for o in U.meshes() if o not in (mag, charge)], 'ak47_body')
    grip = (0, -0.158, -0.035)
    eye, post = Vector((0, 0.041, 0.1093)), Vector((0, 0.422, 0.1078))  # notch top / post tip (sightcheck.py)  # notch (rear tab) and hooded post tip, 4000 px/m
    cheek = eye + (eye - post) * ((eye.y - (grip[1] - 0.08)) / (post.y - eye.y))
    finish('ak47', body, grip,
           parts=[(mag, MAG_AK47), (charge, (0.02, 0.039, 0.068))],
           nodes={'muzzle': ((0, 0.442, 0.06), None), 'eye': (eye, None), 'cheek': (cheek, None),
                  'front_post': (post, None),
                  'grip_r': (grip, None), 'grip_l': ((0, 0.15, 0.04), None),
                  'eject': ((0.02, -0.025, 0.075), None), 'butt': ((0, -0.43, -0.027), None),
                  'hand_mag': ((-0.02, MAG_AK47[1] - 0.025, MAG_AK47[2] - 0.08), 'mag'),
                  'charge_back': ((0.02, 0.039 - 0.09, 0.068), None), 'hand_charge': ((0.038, 0.039, 0.068), 'charge')})
    U.export('ak47')


MAG_AK47 = (0, 0.004, 0.02)
AK47_LEAF = 2.5
F1_SHELL = 0.15
IED_DEC = 0.28


def build_pkm():
    U.load('Insurgent/pkm.glb'); U.flatten()
    # Source: one mesh of unwelded triangles in centimetre-ish units, muzzle -Y, resting on its bipod pitched ~11.5 deg
    # muzzle-up. Level the bore, scale to 1.19 m. The bore sits at x = -0.0525 (centred by the grip move).
    U.orient('-Y', '+Z'); U.rot('X', -11.5); U.scale_len(1.19)
    body = U.meshes()[0]; body.name = 'pkm_body'
    X = -0.0525
    # Ammo box (crosswise under the feed) + the belt rising from it into the feed tray (cartridges + links).
    box = U.split_pos(body, lambda lo, hi: U.in_box(lo, hi, (-0.16, -0.05, 0.04), (0.08, 0.055, 0.15)) or
                      U.in_box(lo, hi, (-0.02, -0.05, 0.13), (0.02, 0.055, 0.241)), 'box')
    # Feed cover: the top plate ahead of the rear sight (y > -0.079), hinged at its front end (y 0.055).
    cover = U.split(body, (-0.085, -0.081, 0.2475), (-0.02, 0.06, 0.28), 'cover', 'vert')
    # Charging handle: lever on the right side of the receiver, forward position.
    charge = U.split_pos(body, lambda lo, hi: U.in_box(lo, hi, (-0.031, -0.08, 0.17), (0.01, -0.035, 0.21)), 'charge')
    grip = (X, -0.214, 0.11)
    eye, post = Vector((X, -0.110, 0.2732)), Vector((X, 0.526, 0.2836))  # notch bottom / post tip per sightcheck.py  # notch block on the raised leaf; post tip (front slice)
    cheek = eye + (eye - post) * ((eye.y - (grip[1] - 0.09)) / (post.y - eye.y))
    finish('pkm', body, grip,
           parts=[(box, (X, 0.002, 0.16)), (cover, (X, 0.055, 0.25)), (charge, (-0.031, -0.06, 0.19))],
           nodes={'muzzle': ((X, 0.665, 0.225), None), 'eye': (eye, None), 'cheek': (cheek, None),
                  'front_post': (post, None), 'grip_r': (grip, None), 'grip_l': ((X, 0.13, 0.19), None),
                  'eject': ((-0.078, 0.0, 0.2), None), 'butt': ((X, -0.525, 0.18), None),
                  'mag_dir': ((X, 0.002, 0.04), None), 'hand_mag': ((-0.15, 0.02, 0.1), 'box'),
                  'hand_cover': ((X, -0.075, 0.268), 'cover'),
                  'charge_back': ((-0.031, -0.21, 0.19), None), 'hand_charge': ((-0.004, -0.058, 0.19), 'charge')})
    U.export('pkm')


def build_rpd():
    U.load('Insurgent/rpd.glb'); U.flatten()
    # Source: muzzle +X, up +Z, bipod deployed; scaled to the real 1.037 m (muzzle to butt; the bipod feet stay inside).
    U.orient('+X', '+Z'); U.scale_len(1.037)
    def pick(names, name):
        return U.join([o for o in U.meshes() if o.name.split('_')[0] in names], name)
    # Drum (axis along Y, under the receiver), its latch hook and the belt rising from it into the left-side feed.
    box = pick({'Cylinder.037', 'Cube.015', 'Cylinder.024', 'Cylinder.026', 'Cylinder.027', 'Cylinder.025', 'Cylinder.030'}, 'box')
    # Feed cover: lid plates + front latch button + the tangent rear sight that sits on the lid. Front-hinged (pin boss
    # on the feed block at y -0.0425, z 0.082), latch end at the rear.
    cover = pick({'Cube.005', 'Cube.009', 'Cube.007', 'Cylinder.005', 'Cube.016', 'Cylinder.011', 'Cylinder.020',
                  'Cube.011', 'Cube.017'}, 'cover')
    # Folding charging handle on the RIGHT side. The source has it at the rear end of its slot (y -0.188..0.062); the
    # RPD fires from an open bolt and the handle rests forward, so it is moved 0.15 m forward to its rest position.
    charge = pick({'Cylinder.054', 'Cube.013'}, 'charge')
    U.move((0, 0.15, 0), [charge])
    body = U.join([o for o in U.meshes() if o not in (box, cover, charge)], 'rpd_body')
    grip = (0, -0.292, -0.04)
    eye, post = Vector((0, -0.149, 0.1111)), Vector((0, 0.44, 0.1064))  # notch bottom per sightcheck.py  # rear notch block; post tip (front slice)
    cheek = eye + (eye - post) * ((eye.y - (grip[1] - 0.09)) / (post.y - eye.y))
    finish('rpd', body, grip,
           parts=[(box, (0, -0.0855, -0.008)), (cover, (0, -0.0425, 0.082)), (charge, (0.02, -0.031, 0.04))],
           nodes={'muzzle': ((0, 0.46, 0.059), None), 'eye': (eye, None), 'cheek': (cheek, None),
                  'front_post': (post, None), 'grip_r': (grip, None), 'grip_l': ((0, 0.04, 0.04), None),
                  'eject': ((0.012, -0.16, 0.02), None), 'butt': ((0, -0.577, -0.02), None),
                  'mag_dir': ((0, -0.0855, -0.128), None), 'hand_mag': ((-0.085, -0.06, -0.09), 'box'),
                  'hand_cover': ((0, -0.145, 0.1), 'cover'),
                  'charge_back': ((0.02, -0.181, 0.04), None), 'hand_charge': ((0.027, -0.031, 0.095), 'charge')})
    U.export('rpd')


def build_svd():
    U.load('Insurgent/svd_dragunov.glb'); U.flatten()
    # Source: muzzle +Y, up +Z, 102k tris, 4096 px textures; scaled to the real 1.225 m. PSO-1 kept.
    U.scale_len(1.225)
    for o in U.meshes():  # ~102k -> ~34k: keep ~150 tris + 18 % of every piece (the slotted flash hider alone is 12.4k)
        n = U.tris([o])
        if n > 260:
            U.decimate(o, (150 + 0.18 * n) / n)
    base = lambda o: o.name.split('_low')[0]
    magp = {'mag', 'mag2', 'mag3', 'mag4', 'mag8', 'magBottom', 'magPart', 'pipe', 'pipe2', 'pipe3', 'pipeBottom'}
    mag = U.join([o for o in U.meshes() if base(o) in magp], 'mag')
    charge = U.join([o for o in U.meshes() if base(o) == 'bolt'], 'charge')  # charging handle, right side
    body = U.join([o for o in U.meshes() if o not in (mag, charge)], 'svd_body')
    X = -0.002
    grip = SVD['grip']
    eye = Vector(SVD['eye'])
    notch, post = Vector(SVD['notch']), Vector(SVD['post'])
    slope = (post.z - notch.z) / (post.y - notch.y)
    finish('svd', body, grip,
           parts=[(mag, SVD['mag']), (charge, (0.017, -0.034, 0.022))],
           nodes={'muzzle': ((X, 0.609, 0.022), None), 'eye': (eye, None), 'cheek': (eye - Vector((0, 0.07, 0)), None),
                  'eye_irons': (notch, None), 'cheek_irons': (notch - Vector((0, 0.3, 0.3 * slope)), None),
                  'front_post': (post, None), 'grip_r': (grip, None), 'grip_l': ((X, 0.12, 0.0), None),
                  'eject': ((0.018, -0.07, 0.035), None), 'butt': ((X, -0.616, -0.05), None),
                  'hand_mag': ((-0.026, SVD['mag'][1] - 0.025, SVD['mag'][2] - 0.07), 'mag'),
                  'charge_back': ((0.017, -0.034 - 0.08, 0.022), None), 'hand_charge': ((0.037, -0.034, 0.022), 'charge')})
    U.export('svd')


SVD = {'grip': (-0.002, -0.31, -0.05), 'eye': (0, -0.399, 0.088), 'notch': (-0.002, -0.0245, 0.0628),
       'post': (-0.002, 0.519, 0.0615), 'mag': (-0.002, -0.047, 0.01)}


def build_rpg7():
    U.load('Insurgent/rpg_7.glb'); U.flatten()
    # Source: muzzle +X, up +Z; a spare rocket with open fins and its booster lie beside the launcher (source y > 0.1):
    # keep only the launcher mesh and the loaded PG-7 warhead. Tube 0.677 source units -> 0.95 m (k = 1.403).
    U.delete(lambda o: not (o.name.startswith('RPG_7_WoodenHeatShield_RPG_7_WoodenHeatShiel') or
                            o.name.startswith('RPG_7_Grenade_RPG')))
    U.orient('+X', '+Z')
    tube = next(o for o in U.meshes() if o.name.startswith('RPG_7_WoodenHeatShield'))
    rocket = next(o for o in U.meshes() if o.name.startswith('RPG_7_Grenade'))
    k = 0.95 / (0.225 + 0.4517)  # tube muzzle face .. venturi rim (source launcher bbox)
    U.xform(Matrix.Scale(k, 4))
    rocket.name = rocket.data.name = 'rocket'
    tube.name = tube.data.name = 'rpg7_body'
    P = {n: Vector(v) * k for n, v in RPG7.items()}
    fwd = Vector((0, 0.12, 0))
    finish('rpg7', tube, P['grip'],
           parts=[(rocket, P['seat'])],
           nodes={'muzzle': (P['seat'], None), 'eye': (P['notch'], None), 'front_post': (P['post'], None),
                  'cheek': (P['notch'] - (P['post'] - P['notch']).normalized() * 0.1, None),
                  'grip_r': (P['grip'], None), 'grip_l': (P['grip_l'], None), 'grip_rear': (P['grip_rear'], None),
                  'butt': (P['butt'], None), 'backblast': (P['blast'], None),
                  'mag_dir': (P['seat'] + fwd, None), 'hand_mag': (P['hand_rocket'], 'rocket')})
    U.export('rpg7')


def build_f1():
    U.load('Insurgent/f1_grenade.glb'); U.flatten()
    # Source: fuze up +Z, lever (spoon) down the -X side, ring on +Y; 2.487 units tall -> 0.117 m with the UZRGM fuze.
    # Five meshes only (shell, fuze, lever, ring, pin): nothing stray to delete. 35k tris -> ~4k, textures 512.
    U.scale_len(0.117, axis=2)
    k = 0.117 / 2.4871
    ratio = {'F1Shell': F1_SHELL, 'F1Lever': 0.12, 'Ring': 0.2, 'F1Fuse': 0.3}
    for o in U.meshes():
        r = ratio.get(o.name.split('_')[0])
        if r:
            U.decimate(o, r)
    spoon = U.join([o for o in U.meshes() if o.name.startswith('F1Lever')], 'spoon')
    pin = U.join([o for o in U.meshes() if o.name.startswith(('Ring', 'SafetyPin'))], 'pin')
    body = U.join([o for o in U.meshes() if o not in (spoon, pin)], 'f1_body')
    s = lambda *v: Vector(v) * k
    grip = s(0, 0, 0.837)  # centre of the body (cast shell)
    finish('f1', body, grip, parts=[(spoon, s(-0.1235, 0, 2.36)), (pin, s(-0.1035, 0.008, 1.91))],
           nodes={'grip_r': (grip, None), 'fuze': (s(0, 0, 2.48), None)}, tex=512)
    U.export('f1')


def build_ied():
    U.load('Insurgent/improvised_explosive_device_ied.glb'); U.flatten()
    # Source: 155 mm shell STANDING nose-up (long axis = Z), wires into the fuze well, a detonator box taped on the -X
    # side. Object_2 is an empty line mesh. Shell 1.656 units across, 5.24 tall (with wires). The source is stubby
    # (length/diameter 3.2 vs ~3.9 for an M107): scale XY to the 155 mm calibre and Z to 0.6 m (Z stretched x1.22).
    U.delete(lambda o: not o.data.polygons)
    o = U.join_all('ied_body')
    cx, cy, z0 = -0.5006, -91.243, -8.2429
    U.move((-cx, -cy, -z0))
    U.xform(Matrix.Diagonal((0.155 / 1.656, 0.155 / 1.656, 0.6 / 5.2393, 1)))
    U.decimate(o, IED_DEC)
    r = U.root('ied')
    U.parent(o, r)
    U.empty('grip_r', (0, 0, 0.3), r)
    U.empty('nose', (0, 0, 0.59), r)
    U.shrink_textures(1024)
    U.export('ied')


# Source units, oriented (+Y muzzle), before scaling by k. Bore axis x 0.0141, z 0.1831; the iron sights sit 0.014
# (source) = 0.02 m left of the bore, as on the real launcher. No PGO-7 optic in the source.
RPG7 = {'grip': (0.0141, 0.072, 0.09), 'grip_rear': (-0.0119, -0.025, 0.134), 'grip_l': (-0.002, 0.16, 0.162),
        'seat': (0.0141, 0.225, 0.1831), 'blast': (0.0141, -0.4517, 0.1831), 'butt': (0.0141, -0.131, 0.157),
        'notch': (0, -0.0282, 0.260), 'post': (0, 0.2079, 0.251), 'hand_rocket': (-0.019, 0.40, 0.1831)}


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    opts = {'--shots', '--ppm', '--views'}
    if '--shots' in argv:
        SHOTS = argv[argv.index('--shots') + 1]
    if '--ppm' in argv:
        SHOT_PPM = int(argv[argv.index('--ppm') + 1])
    if '--views' in argv:
        SHOT_VIEWS = argv[argv.index('--views') + 1].split(',')
    skip = {argv[i + 1] for i, a in enumerate(argv) if a in opts and i + 1 < len(argv)}
    for wid in [a for a in argv if not a.startswith('--') and a not in skip]:
        globals()[f'build_{wid}']()

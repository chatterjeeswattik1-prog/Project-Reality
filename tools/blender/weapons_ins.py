"""Insurgent weapons for PROJECT REALISM, built from code and exported as one GLB per weapon.
    ~/blender-4.5.13-linux-x64/blender -b --factory-startup --python tools/blender/weapons_ins.py -- public/models/weapons \
        [--preview tools/blender/previews] [--views "side;34;fp"] [--only akm,pkm] [--nobake] [--tex 1024]

Contract (CLAUDE.md, "Weapons"): root <id>, +Y forward (muzzle), Z up, origin at the firing-hand grip point, empties
muzzle / eye / grip_r / grip_l / eject / butt as children of the root, animated child meshes mag / box / cover / rocket /
pin / spoon. Static parts are joined into one mesh <id>_body. Extra empties:
  cheek       where the shooter's eye is with a proper cheek weld, on the sight line (AKs 0.32 m behind the rear notch,
              PKM 0.30 m, SVD / RPG-7 0.07 m behind the optic eyepiece, Makarov 0.6 m = arm's length). The game puts the
              aiming camera exactly here.
  front_post  tip of the front sight post. Iron sights: the line cheek -> eye -> front_post passes 1.6 mm above the
              notch bottom (post tip centred in the U-notch) and slopes ~1.5-3 mrad down relative to the bore (zero).
  eye_irons / cheek_irons (SVD, RPG-7: iron sights besides the optic), pivot / base (DShK, SPG-9), backblast (RPG-7, SPG-9).
Proportions are measured from reference photos in tools/blender/src-assets/ref/ins/ (not shipped), see each builder.
Materials: procedural Cycles shaders (wear on edges from a Bevel-node curvature mask, AO grime, wood grain, laminate
plies, checkering) baked per weapon into a 1024 px (512 px for pistol / grenade / phone / rocket) base-colour + metallic-
roughness atlas, one glTF material per weapon (see wcommon_ins.bake_weapon).
"""
import os, sys, math, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy
from mathutils import Vector, Matrix
from wcommon_ins import (Build, chaikin, loft, loft_y, loft_z, loft_path, arc_path, se, arch, lathe, htube, xprism, zprism, sprism,
                         bx, cy, cy_between, tor, ball, rivet, wire, export_glb, tri_count, render_views, bake_weapon, skin_x, ring_plate)

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = argv[0] if argv and not argv[0].startswith('--') else 'public/models/weapons'
PREV = argv[argv.index('--preview') + 1] if '--preview' in argv else None
FP = argv[argv.index('--fp') + 1] if '--fp' in argv else None
VIEWS = tuple(argv[argv.index('--views') + 1].split(';')) if '--views' in argv else ('side', '34', 'fp')
ONLY = argv[argv.index('--only') + 1].split(',') if '--only' in argv else None
NOBAKE = '--nobake' in argv
TEX = int(argv[argv.index('--tex') + 1]) if '--tex' in argv else None
SMALL = {'makarov', 'f1', 'ied_phone', 'pg7v'}

D = math.radians


def lerp(a, b, t):
    return a + (b - a) * t


def interp(table, t):
    """Piecewise-linear lookup in [(t, value)]."""
    for (t0, v0), (t1, v1) in zip(table[:-1], table[1:]):
        if t <= t1:
            return lerp(v0, v1, (t - t0) / (t1 - t0) if t1 > t0 else 0)
    return table[-1][1]


def path_point(path, f):
    """Point at fraction f of a polyline path [(y, z)]."""
    L = [0.0]
    for a, b in zip(path[:-1], path[1:]):
        L.append(L[-1] + math.dist(a, b))
    s = f * L[-1]
    for i in range(len(path) - 1):
        if s <= L[i + 1]:
            t = (s - L[i]) / (L[i + 1] - L[i])
            return (lerp(path[i][0], path[i + 1][0], t), lerp(path[i][1], path[i + 1][1], t))
    return path[-1]


# =================================================================== AK family
# Build frame: bore on z = 0, y = 0 at the rear face of the receiver. Proportions measured from the Armemuseum AKM photo
# (src-assets/ref/ins/akm_bothsides.png, 0.728 mm/px at 880 mm overall): stock 245 mm, receiver 245 mm, rear sight
# notch 226 mm, front post 588 mm, brake exit 628 mm ahead of the receiver rear. Comb line ~0-6 mm below the bore,
# butt 95 mm tall, grip bottom 130 mm below the bore, magazine rear edge on a ~0.25 m radius.
AKN = dict(notch_y=0.2265, notch_z=0.0425, post_y=0.588, post_z=0.0431)
LOS = 0.0016   # sight line passes this far above the notch bottom: the post tip shows inside the U-notch


def ak_mag(b, kind, rear=0.139, ztop=-0.026):
    """Curved AK magazine: body following an arc, stamped side ribs (steel) or moulded ribs (polymer), floor plate,
    front and rear lugs, feed lips and the top round. Returns the mag origin (top centre)."""
    P = b.P
    spec = {
        '762': dict(R=0.28, L=0.208, d0=0.058, d1=0.069, w=0.029, phi0=8, m=P['mag_steel'], ribs='steel', cal=(0.0385, 0.0057, 0.018)),
        '545': dict(R=0.4, L=0.19, d0=0.056, d1=0.06, w=0.027, phi0=6, m=P['bakelite'], ribs='poly', cal=(0.0395, 0.0050, 0.0175)),
        'rpk40': dict(R=0.33, L=0.262, d0=0.058, d1=0.076, w=0.0295, phi0=6, m=P['bakelite'], ribs='poly', cal=(0.0385, 0.0057, 0.018)),
    }[kind]
    b.group('mag')
    n = 22
    d0, d1, w = spec['d0'], spec['d1'], spec['w']
    top = (rear + d0 / 2, ztop)
    path = arc_path(top, D(spec['phi0']), spec['R'] + d0 / 2, spec['L'], n)
    secs = [se(w, lerp(d0, d1, (i / n) ** 1.4), 7.0, 40) for i in range(n + 1)]
    loft_path(path, secs, spec['m'], 'mag_body')
    # Side ribs following the curve.
    offs = (-0.019, -0.0065, 0.0065, 0.019) if spec['ribs'] == 'steel' else (-0.016, 0.0, 0.016)
    for off in offs:
        sec = [(x, d + off) for x, d in se(w + 0.0016, 0.0034 if spec['ribs'] == 'steel' else 0.0045, 2.6, 16)]
        loft_path(path[2:n - 1], sec, spec['m'], 'mag_rib')
    # Floor plate with its lip.
    (y1, z1), (y0, z0) = path[-1], path[-2]
    t = Vector((y1 - y0, z1 - z0)).normalized()
    fp = [(y1 - t.x * 0.003, z1 - t.y * 0.003), (y1 + t.x * 0.004, z1 + t.y * 0.004)]
    loft_path(fp, se(w + 0.003, d1 + 0.006, 9.0, 32), spec['m'] if kind == '762' else P['plum_poly'], 'floorplate')
    nrm = Vector((-t.y, t.x))
    ty, tz = path[-1][0] + nrm.x * (d1 / 2 + 0.002), path[-1][1] + nrm.y * (d1 / 2 + 0.002)
    bx((w * 0.6, 0.004, 0.008), (0, ty, tz), spec['m'], (math.degrees(math.atan2(t.x, -t.y)), 0, 0), name='floor_lip')
    # Top: front lug, rear catch lug, feed lips and a round.
    ry, rz = top
    bx((w * 0.5, 0.007, 0.01), (0, ry + d0 / 2 + 0.003, rz - 0.008), spec['m'], name='front_lug')
    bx((w * 0.6, 0.004, 0.007), (0, ry - d0 / 2 - 0.0015, rz - 0.014), spec['m'], name='rear_lug')
    for sd in (-1, 1):
        bx((0.004, d0 * 0.8, 0.003), (sd * (w / 2 - 0.002), ry - 0.004, rz + 0.0015), spec['m'], name='feed_lip')
    cl, cr, bl = spec['cal']
    cartridge(b, ry - d0 / 2 + 0.003, 0.0035, rz + 0.0005, cl * 0.82, cr, bl, P['steel_case'], P['copper'], 14)
    b.group('body')
    return (0, ry, rz)


def ak_receiver(b, kind):
    """Stamped (AKM / RPK / AKS-74U) or milled (Type 56) receiver with dust cover, selector, charging handle, rivets,
    ejection port and (except the AKS-74U) the tangent rear sight block."""
    P = b.P
    st, br = P['steel'], P['bright']
    milled = kind == 'ak47'
    front = 0.245
    # Core body (port region recessed on the right so the bolt carrier shows through the ejection port).
    prof_rear = [(0.0, -0.027), (0.003, -0.03), (0.125, -0.03), (0.125, 0.016), (0.0, 0.016)]
    prof_front = [(0.205, -0.03), (0.21, -0.032), (front, -0.032), (front, 0.016), (0.205, 0.016)]
    sprism(prof_rear, 0.028, st, bevel=0.0012, name='rcv_core')
    sprism(prof_front, 0.028, st, bevel=0.0012, name='rcv_core')
    sprism([(0.125, -0.03), (0.205, -0.03), (0.205, 0.0012), (0.125, 0.0012)], 0.028, st, bevel=0.0008, name='rcv_core')
    sprism([(0.125, 0.0), (0.205, 0.0), (0.205, 0.016), (0.125, 0.016)], 0.0225, st, x=-0.00275, name='rcv_core')
    bx((0.003, 0.082, 0.0138), (0.0095, 0.166, 0.0088), br, name='bolt_carrier')
    bx((0.0035, 0.03, 0.006), (0.0096, 0.15, 0.0125), P['steel'], name='carrier_cut')
    xs = 0.0148
    def dimple(y, z):
        if kind not in ('akm', 'rpk'):
            return 0.0
        return -0.0009 * math.exp(-((y - 0.166) / 0.0075) ** 2 - ((z + 0.0125) / 0.0035) ** 2)
    if not milled:
        for sd in (-1, 1):
            port = (lambda y, z: 0.125 < y < 0.205 and z > 0.0012) if sd > 0 else None
            skin_x(sd, xs, 0.002, front - 0.001, -0.0285, 0.0158, st, 0.0025, dimple, port, name='rcv_skin')
    else:
        # Milled: long lightening cut above the magazine well (recessed panel) on both sides.
        for sd in (-1, 1):
            cut = lambda y, z: 0.142 < y < 0.198 and -0.0235 < z < -0.0075
            port = (lambda y, z: (0.125 < y < 0.205 and z > 0.0012) or cut(y, z)) if sd > 0 else cut
            skin_x(sd, xs, 0.002, front - 0.001, -0.0285, 0.0158, st, 0.0025, None, port, name='rcv_skin')
            skin_x(sd, xs - 0.0016, 0.142, 0.198, -0.0235, -0.0075, st, 0.004, name='cut_floor')
    # Dust cover: rounded crown, transverse ribs on the stamped guns, recoil-spring guide tab at the rear.
    def cs(k=1.0):
        return arch(0.0325 * k, 0.0085, 0.0085 + 0.025 * k, 0.0215, 14, 2.8)
    secs = [(0.0025, arch(0.028, 0.0085, 0.029, 0.02, 14, 2.8)), (0.004, cs(0.985)), (0.0075, cs(1.0))]
    if kind != 'ak47':
        for yr in (0.03, 0.052, 0.074, 0.096, 0.118):
            secs += [(yr - 0.005, cs(1.0)), (yr - 0.0025, cs(1.022)), (yr + 0.0025, cs(1.022)), (yr + 0.005, cs(1.0))]
    secs += [(0.222, cs(1.0))]
    loft_y(secs, st, 'dust_cover')
    loft_y([(-0.004, se(0.0105, 0.006, 3, 16, 0, 0.0265)), (0.006, se(0.0105, 0.006, 3, 16, 0, 0.0265))], st, 'guide_tab')
    # Rivets and pins (rear trunnion, front trunnion, trigger group), shepherd's-crook spring on the right.
    for sd in (-1, 1):
        for y, z in ((0.009, 0.003), (0.03, -0.0095), (0.011, -0.02), (0.218, 0.003), (0.236, 0.003), (0.234, -0.0085),
                     (0.218, -0.021), (0.236, -0.022)):
            rivet(y, z, sd, st, 0.0021, xs)
        for y, z in ((0.098, -0.009), (0.117, -0.009), (0.111, -0.021)):
            ball(0.0024, (sd * xs, y, z), br, (0.45, 1, 1), 10, 5, 'pin')
    wire([(0.0153, 0.096, -0.009), (0.0157, 0.104, -0.012), (0.0157, 0.112, -0.012), (0.0153, 0.118, -0.009)], 0.0006, br, 6, 'crook')
    # Selector / safety lever (right side, on 'safe' covering the charging-handle slot), pivot hub, detent notches.
    sprism([(0.042, -0.009), (0.056, -0.0095), (0.075, -0.004), (0.13, 0.0025), (0.205, 0.006), (0.216, 0.004), (0.228, 0.0045),
            (0.228, 0.0185), (0.205, 0.0185), (0.13, 0.0115), (0.058, 0.004), (0.044, 0.002), (0.04, -0.004)], 0.0016, st,
           x=xs + 0.0011, bevel=0.0004, name='selector')
    bx((0.0035, 0.007, 0.012), (xs + 0.003, 0.225, 0.0115), st, name='selector_tab')
    cy(0.0068, 0.0022, (xs + 0.0013, 0.05, -0.004), st, 'X', 24, bevel=0.0004)
    cy(0.0024, 0.0035, (xs + 0.002, 0.05, -0.004), br, 'X', 12)
    for k in range(3):
        bx((0.001, 0.0012, 0.003), (xs + 0.0004, 0.064 + k * 0.0045, -0.012 + k * 0.0022), P['shadow'], (k * 8.0, 0, 0), 0, 'detent')
    # Charging handle on the bolt carrier.
    cy_between((0.012, 0.218, 0.0095), (0.031, 0.218, 0.0125), 0.0033, br, 12)
    ball(0.0062, (0.0355, 0.218, 0.013), br, (1.25, 1.0, 0.95), 16, 10)
    if kind != 'aks74u':
        ak_rear_sight(b, kind)


def ak_rear_sight(b, kind):
    """Rear sight block on the front trunnion and the tangent leaf: hinge at the front, slider with spring buttons,
    range ticks, U-notch plate at the rear end."""
    P = b.P
    st, br = P['steel'], P['bright']
    ny, nz = AKN['notch_y'], AKN['notch_z']
    sprism([(0.218, -0.012), (0.29, -0.012), (0.29, 0.026), (0.278, 0.0305), (0.232, 0.0315), (0.222, 0.029), (0.218, 0.024)],
           0.0275, st, bevel=0.0015, name='rs_block')
    # Leaf: thin plate rising from the hinge (front) to the notch plate (rear).
    sprism([(0.284, 0.0305), (0.284, 0.0335), (0.231, 0.039), (0.228, 0.039), (0.228, 0.0355)], 0.016, st, bevel=0.0004, name='rs_leaf')
    cy(0.0025, 0.02, (0, 0.283, 0.0315), st, 'X', 12)
    # Notch plate (front view outline extruded along Y): U-notch 2.4 mm wide, bottom at notch_z.
    w2, top = 0.0082, nz + 0.0022
    pts = [(-w2, 0.0345), (w2, 0.0345), (w2, top), (0.0012, top)]
    for k in range(7):
        a = math.pi * k / 6
        pts.append((0.0012 * math.cos(a), nz + 0.0012 - 0.0012 * math.sin(a)))
    pts += [(-0.0012, top), (-w2, top)]
    xprism(pts, ny - 0.0015, ny + 0.0015, st, 'notch_plate', bevel=0.0002)
    # Slider and range scale ticks (100 m steps) on both edges of the leaf.
    bx((0.02, 0.008, 0.0062), (0, 0.252, 0.0365), st, name='rs_slider')
    for sd in (-1, 1):
        cy(0.0026, 0.004, (sd * 0.011, 0.252, 0.0365), br, 'X', 12, bevel=0.0003)
    for k in range(9):
        y = 0.236 + k * 0.0052
        z = 0.0335 + (0.284 - y) / (0.284 - 0.231) * (0.039 - 0.0335) + 0.0002
        for sd in (-1, 1):
            bx((0.0028, 0.0007, 0.0006), (sd * 0.0052, y, z), P['white'], bevel=0, name='tick')
    bx((0.004, 0.014, 0.006), (0.0155, 0.282, 0.02), st, name='gas_tube_lever')
    cy(0.003, 0.004, (0.0165, 0.276, 0.02), br, 'X', 10)
    if kind == 'rpk':
        cy(0.004, 0.007, (0.012, 0.236, 0.0375), st, 'X', 16, bevel=0.0005)  # windage knob


def ak_grip(b, m, top=(0.031, -0.026), bot=(0.013, -0.127)):
    """AK pistol grip (bakelite with checkered side panels / wood), slight rake, flared heel, grip screw."""
    n = 12
    path = [(lerp(top[0], bot[0], i / n), lerp(top[1], bot[1], i / n)) for i in range(n + 1)]
    secs = []
    for i in range(n + 1):
        f = i / n
        w = interp([(0, 0.0275), (0.2, 0.029), (0.6, 0.0305), (0.92, 0.031), (1, 0.0315)], f)
        d = interp([(0, 0.05), (0.15, 0.047), (0.5, 0.044), (0.85, 0.045), (0.95, 0.047), (1, 0.046)], f)
        # Finger swell on the front strap and a fuller palm swell at the back (AKM bakelite grip profile).
        off = interp([(0, 0.0), (0.5, -0.001), (0.9, -0.002), (1, -0.002)], f)
        d += 0.003 * math.exp(-((f - 0.3) / 0.12) ** 2) + 0.002 * math.exp(-((f - 0.75) / 0.15) ** 2)
        secs.append([(x, dd + off) for x, dd in se(w, d, 2.5 if f < 0.95 else 3.0, 40)])
    loft_path(path, secs, m, 'grip')
    cy(0.0045, 0.003, (0, bot[0] - 0.002, bot[1] - 0.0012), b.P['steel'], 'Z', 16)
    return path


def ak_trigger_group(b):
    P = b.P
    gp = [(0.121, -0.028), (0.121, -0.05), (0.117, -0.0595), (0.106, -0.0645), (0.076, -0.0645), (0.066, -0.0605), (0.062, -0.049),
          (0.061, -0.029)]
    loft_path(chaikin(gp, 3), se(0.0105, 0.0026, 6.0, 16), P['steel'], 'trigger_guard')
    loft_path([(0.083, -0.028), (0.086, -0.039), (0.0855, -0.049), (0.081, -0.0565)],
              [se(0.0065, 0.0055, 3, 12), se(0.006, 0.005, 3, 12), se(0.0055, 0.0045, 3, 12), se(0.005, 0.0035, 3, 12)], P['steel'], 'trigger')
    sprism([(0.123, -0.03), (0.137, -0.03), (0.135, -0.05), (0.129, -0.0605), (0.12, -0.063), (0.12, -0.058), (0.126, -0.055), (0.128, -0.04)],
           0.012, P['steel'], bevel=0.0008, name='mag_catch')


def ak_stock(b, wood, top, bot, width, L, sling=True):
    """Fixed buttstock lofted from tables of (y, z) for the comb and lower lines, steel butt plate with trap door."""
    P = b.P
    secs = []
    ys = [0.0, -0.004, -0.012] + [-0.02 - (L - 0.035) * k / 14 for k in range(15)] + [-L + 0.008, -L + 0.003, -L]
    for y in ys:
        zt, zb, w = interp_y(top, y), interp_y(bot, y), interp_y(width, y)
        sh = max(0.0, (y + L - 0.008) / -0.008) * 0.002 if y < -L + 0.008 else 0.0
        sh0 = 0.0012 if y > -0.003 else 0.0
        p = lerp(2.5, 3.0, -y / L)
        secs.append((y, se(w - 2 * (sh + sh0), zt - zb - 2 * (sh + sh0), p, 48, 0, (zt + zb) / 2)))
    loft_y(secs, wood, 'stock')
    zt, zb, w = interp_y(top, -L), interp_y(bot, -L), interp_y(width, -L)
    plate = se(w + 0.0008, zt - zb + 0.0008, 3.2, 48, 0, (zt + zb) / 2)
    loft_y([(-L + 0.0015, plate), (-L - 0.0045, plate), (-L - 0.0058, se(w - 0.002, zt - zb - 0.002, 3.2, 48, 0, (zt + zb) / 2))], P['steel'], 'butt_plate')
    zc = (zt + zb) / 2
    loft_y([(-L - 0.0057, se(0.022, 0.034, 3.0, 24, 0, zc - 0.012)), (-L - 0.0068, se(0.02, 0.032, 3.0, 24, 0, zc - 0.012))], P['steel'], 'trap_door')
    for z in (zt - 0.012, zb + 0.012):
        cy(0.0032, 0.0016, (0, -L - 0.0062, z), P['bright'], 'Y', 12)
    if sling:
        y = -L + 0.025
        zc = interp_y(bot, y) + 0.008
        x = -(interp_y(width, y) / 2) - 0.0008
        bx((0.0016, 0.03, 0.012), (x, y, zc), P['steel'], name='sling_plate')
        tor(0.0085, 0.0016, (x - 0.0012, y, zc - 0.01), P['steel'], 'X', 20, 8)
    return (0, -L - 0.006, (zt + zb) / 2)


def interp_y(table, y):
    """Lookup in [(y, value)] given in descending y (from the receiver rearwards)."""
    t = sorted(table)
    return interp([(-q[0], q[1]) for q in reversed(t)], -y) if False else _lin_tab(t, y)


def _lin_tab(t, y):
    if y <= t[0][0]:
        return t[0][1]
    for (y0, v0), (y1, v1) in zip(t[:-1], t[1:]):
        if y <= y1:
            return lerp(v0, v1, (y - y0) / (y1 - y0))
    return t[-1][1]


def ak_lower_handguard(b, wood, y0, y1, zb_tab, w_tab, ztop=0.0165, groove=True):
    secs = []
    ys = [y0, y0 + 0.002, y0 + 0.006] + [lerp(y0 + 0.012, y1 - 0.012, k / 14) for k in range(15)] + [y1 - 0.006, y1 - 0.002, y1]
    for y in ys:
        e = min((y - y0) / 0.006, (y1 - y) / 0.006, 1.0)
        zb, w = _lin_tab(zb_tab, y), _lin_tab(w_tab, y)
        h = ztop - zb
        cz = (ztop + zb) / 2
        g = groove and (y0 + 0.05 < y < y1 - 0.01)
        pts = []
        for x, z in se(w * (0.93 + 0.07 * e), h * (0.95 + 0.05 * e), 2.4, 48, 0, cz):
            k = 1.0
            if g:
                k -= 0.045 * math.exp(-((z + 0.0035) / 0.0022) ** 2) * min(1.0, (y - y0 - 0.05) / 0.01)
            pts.append((x * k, z))
        secs.append((y, pts))
    loft_y(secs, wood, 'lower_handguard')
    return secs


def ak_front(b, kind, P):
    """Barrel, handguards, gas system, front sight and muzzle device for the full-length AKs. Returns the muzzle y."""
    st, br = P['steel'], P['bright']
    wood = {'akm': P['plum'], 'ak47': P['wood_dark'], 'rpk': P['plum']}[kind]
    breech = 0.185
    barrel = 0.415 if kind != 'rpk' else 0.59
    bend = breech + barrel                         # barrel end
    cy(0.0105, 0.47 - 0.2, (0, 0.335, 0), st, 'Y', 24)
    cy(0.0078 if kind != 'rpk' else 0.0098, bend - 0.465, (0, (bend + 0.465) / 2, 0), st, 'Y', 32)
    # Front-trunnion handguard retainer, lower and upper handguards, gas tube with vent holes.
    sc = 1.08 if kind == 'rpk' else 1.0
    zb = [(0.245, -0.026 * sc), (0.25, -0.034 * sc), (0.27, -0.0365 * sc), (0.29, -0.0355 * sc), (0.31, -0.031 * sc), (0.33, -0.029 * sc), (0.407, -0.0283 * sc)]
    ww = [(0.245, 0.036), (0.255, 0.043 * sc), (0.285, 0.044 * sc), (0.31, 0.0405 * sc), (0.407, 0.038 * sc)]
    if kind == 'ak47':
        zb = [(0.245, -0.026), (0.252, -0.031), (0.407, -0.029)]
        ww = [(0.245, 0.036), (0.255, 0.039), (0.407, 0.037)]
    secs = ak_lower_handguard(b, wood, 0.247, 0.407, zb, ww)
    loft_y([(0.239, se(0.0375, 0.046, 3.0, 32, 0, -0.008)), (0.2485, se(0.0375, 0.046, 3.0, 32, 0, -0.008))], st, 'hg_retainer')
    bx((0.0035, 0.006, 0.012), (0.019, 0.243, -0.012), st, name='hg_retainer_lever')
    last = secs[-1][1]
    loft_y([(0.4065, [(x * 1.06, z * 1.05 + 0.0002) for x, z in last]), (0.4135, [(x * 1.06, z * 1.05 + 0.0002) for x, z in last])], st, 'hg_ferrule')
    cy(0.0095, 0.19, (0, 0.383, 0.0229), st, 'Y', 32)
    secs = []
    for y in (0.29, 0.2915, 0.295, 0.32, 0.35, 0.38, 0.402, 0.4055, 0.407):
        e = min((y - 0.29) / 0.005, (0.407 - y) / 0.005, 1.0)
        secs.append((y, arch(0.033 * (0.93 + 0.07 * e), 0.0105, 0.0105 + 0.0275 * (0.94 + 0.06 * e), 0.0255, 16, 2.4)))
    loft_y(secs, wood, 'upper_handguard')
    for yv in (0.446, 0.453, 0.46):
        for sd in (-1, 1):
            cy(0.0021, 0.0016, (sd * 0.0093, yv, 0.0229), P['shadow'], 'X', 12)
    # Gas block (45 deg front on the AKM / RPK, 90 deg on the AK-47) with the front sling loop.
    gb = [(0.468, -0.011), (0.5, -0.011), (0.5, 0.003), (0.485, 0.0315), (0.468, 0.0315)] if kind != 'ak47' else \
         [(0.468, -0.011), (0.5, -0.011), (0.5, 0.0315), (0.468, 0.0315)]
    sprism(gb, 0.0235, st, bevel=0.0015, name='gas_block')
    cy(0.0118, 0.032, (0, 0.484, 0), st, 'Y', 32, bevel=0.0012)
    cy(0.004, 0.006, (-0.0125, 0.484, -0.003), st, 'X', 12)
    tor(0.0065, 0.0015, (-0.0175, 0.484, -0.0085), st, 'Y', 20, 8)
    # Front sight base: collar, tower, hood ring, post; bayonet lug; cleaning rod.
    fy = bend - 0.012 if kind != 'ak47' else bend - 0.012
    fz = AKN['post_z']
    cy(0.0118, 0.025, (0, fy, 0), st, 'Y', 32, bevel=0.0012)
    sprism([(fy - 0.011, 0.004), (fy + 0.011, 0.004), (fy + 0.0085, fz - 0.009), (fy - 0.008, fz - 0.009)], 0.011, st, bevel=0.0012, name='fs_tower')
    htube(0.0095, 0.0077, fy - 0.006, fy + 0.006, st, 0, fz - 0.002, 32, name='fs_hood')
    bx((0.0018, 0.0022, 0.012), (0, fy, fz - 0.006), st, bevel=0.0002, name='fs_post')
    cy(0.0035, 0.008, (0, fy, fz - 0.0115), st, 'Z', 16)
    bx((0.008, 0.022, 0.0075), (0, fy, -0.0155), st, name='bayonet_lug')
    if kind != 'ak47':
        cy(0.0026, fy + 0.012 - 0.41, (0, (fy + 0.012 + 0.41) / 2, -0.0184), st, 'Y', 12)
        cy(0.0034, 0.008, (0, fy + 0.012, -0.0184), st, 'Y', 12, bevel=0.0005)
    if kind == 'akm':
        htube(0.0095, 0.0047, bend - 0.004, bend + 0.028, st, 0, 0, 32, slant=0.45, name='slant_brake')
        return bend + 0.028
    htube(0.0088, 0.0048, bend - 0.002, bend + 0.012, st, 0, 0, 32, name='thread_nut')
    if kind == 'ak47':
        # Type 56 folding spike bayonet, folded back under the barrel (cruciform blade, hinge at the front sight).
        for a in (0, 90):
            sp = loft_path([(fy - 0.012, -0.0205), (fy - 0.16, -0.0205)], [se(0.0062, 0.0016, 2.5, 8), se(0.0012, 0.0008, 2.5, 8)], br, 'spike')
            sp.data.transform(Matrix.Translation((0, 0, -0.0205)) @ Matrix.Rotation(math.radians(a), 4, 'Y') @ Matrix.Translation((0, 0, 0.0205)))
        cy(0.0062, 0.02, (0, fy - 0.022, -0.0205), st, 'Y', 20, bevel=0.0008)
        bx((0.011, 0.016, 0.012), (0, fy + 0.002, -0.019), st, name='bayonet_hinge')
        bx((0.008, 0.012, 0.01), (0, fy - 0.168, -0.0185), st, name='bayonet_catch')
    if kind == 'rpk':
        # Bipod clamp behind the front sight; legs folded back and clipped together under the barrel.
        cy(0.0125, 0.016, (0, fy - 0.045, 0), st, 'Y', 32, bevel=0.001)
        bx((0.016, 0.016, 0.012), (0, fy - 0.045, -0.015), st, name='bipod_hinge')
        for sd in (-1, 1):
            cy_between((sd * 0.0055, fy - 0.045, -0.02), (sd * 0.0075, 0.455, -0.0245), 0.0042, st, 12)
            bx((0.007, 0.022, 0.0035), (sd * 0.0085, 0.46, -0.0285), st, name='bipod_foot')
        bx((0.024, 0.008, 0.007), (0, 0.49, -0.0245), st, name='bipod_clip')
    return bend + 0.012


def ak_family(kind):
    """akm, ak47 (Type 56), rpk, aks74u."""
    b = Build(kind)
    P = b.P
    st = P['steel']
    ak_receiver(b, kind)
    gripm = {'akm': P['grip_ak'], 'ak47': P['wood_dark'], 'rpk': P['grip_ak'], 'aks74u': P['plum_poly']}[kind]
    gpath = ak_grip(b, gripm)
    ak_trigger_group(b)
    top = [(0.0, 0.0105), (-0.012, 0.0055), (-0.03, 0.0005), (-0.06, -0.005), (-0.1, -0.0055), (-0.16, -0.004), (-0.25, -0.0026)]
    if kind in ('akm', 'ak47'):
        L = 0.239 if kind == 'akm' else 0.25
        bot = [(0.0, -0.031), (-0.006, -0.044), (-0.02, -0.0475), (-0.06, -0.0545), (-0.1, -0.067), (-0.15, -0.081), (-0.2, -0.094), (-0.25, -0.099)]
        width = [(0.0, 0.0305), (-0.03, 0.033), (-0.12, 0.038), (-0.25, 0.041)]
        butt = ak_stock(b, P['plum'] if kind == 'akm' else P['wood_dark'], top, bot, width, L)
        muzzle = ak_front(b, kind, P)
    elif kind == 'rpk':
        L = 0.25
        bot = [(0.0, -0.031), (-0.006, -0.044), (-0.03, -0.049), (-0.07, -0.054), (-0.12, -0.072), (-0.165, -0.105), (-0.205, -0.128), (-0.25, -0.134)]
        width = [(0.0, 0.0305), (-0.03, 0.032), (-0.12, 0.037), (-0.25, 0.042)]
        butt = ak_stock(b, P['plum'], top, bot, width, L)
        muzzle = ak_front(b, kind, P)
    else:
        muzzle, butt = aks74u_front_and_stock(b, P)
    morigin = ak_mag(b, {'akm': '762', 'ak47': '762', 'rpk': 'rpk40', 'aks74u': '545'}[kind])
    gy, gz = path_point(gpath, 0.45)
    if kind == 'aks74u':
        ny, nz, py, pz = AKS74U['notch_y'], AKS74U['notch_z'], AKS74U['post_y'], AKS74U['post_z']
        back = 0.32
    else:
        ny, nz, py, pz = AKN['notch_y'], AKN['notch_z'], AKN['post_y'], AKN['post_z']
        if kind == 'rpk':
            py = muzzle - 0.024
        back = 0.32
    lz = nz + LOS
    slope = (pz - lz) / (py - ny)
    b.E('muzzle', (0, muzzle, 0))
    b.E('eye', (0, ny, lz))
    b.E('cheek', (0, ny - back, lz - slope * back))
    b.E('front_post', (0, py, pz))
    b.E('grip_r', (0, gy, gz))
    b.E('grip_l', (0, 0.33 if kind == 'aks74u' else gy + 0.31, -0.026))
    b.E('eject', (0.0155, 0.165, 0.009))
    b.E('butt', butt)
    root = b.finish((0, gy, gz), {'mag': morigin})
    return root, [kind]


AKS74U = dict(notch_y=0.16, notch_z=0.058, post_y=0.412, post_z=0.0586)


def aks74u_front_and_stock(b, P):
    """AKS-74U (from src-assets/ref/ins/aks74u_side.jpg, 0.593 mm/px at 730 mm): hinged top cover with the flip rear sight
    ~0.16 m from the receiver rear, cover hinge block 0.245-0.267 m, short handguards to 0.397 m, combined gas block /
    front sight 0.397-0.427 m, conical muzzle booster to 0.507 m, side-folding skeleton stock (extended) to -0.222 m."""
    st, br = P['steel'], P['bright']
    wood = P['plum']
    bend = 0.432
    cy(0.0105, 0.16, (0, 0.3, 0), st, 'Y', 24)
    cy(0.0085, bend - 0.38, (0, (bend + 0.38) / 2, 0), st, 'Y', 32)
    sprism([(0.218, -0.012), (0.268, -0.012), (0.268, 0.026), (0.256, 0.031), (0.222, 0.031), (0.218, 0.026)], 0.0275, st, bevel=0.0015, name='hinge_block')
    cy(0.0035, 0.03, (0, 0.226, 0.026), st, 'X', 12)
    # Flip rear sight on its base riveted to the cover (two leaves, short- and long-range notch).
    ny, nz = AKS74U['notch_y'], AKS74U['notch_z']
    sprism([(0.148, 0.031), (0.19, 0.031), (0.19, 0.036), (0.178, 0.038), (0.158, 0.038), (0.148, 0.035)], 0.02, st, bevel=0.0008, name='flip_base')
    sprism([(0.155, 0.036), (0.167, 0.036), (0.164, nz - 0.004), (0.157, nz - 0.004)], 0.0155, st, bevel=0.0004, name='flip_leaf')
    ak_style_notch(ny, nz, 0.0075, nz - 0.0055, st, 0.0013, 0.0016)
    sprism([(0.168, 0.036), (0.188, 0.036), (0.186, 0.041), (0.17, 0.047)], 0.0125, st, bevel=0.0004, name='flip_leaf2')
    # Short handguards (lower with palm swells, upper on the gas tube), retainer.
    zb = [(0.267, -0.026), (0.272, -0.035), (0.3, -0.036), (0.36, -0.033), (0.397, -0.031)]
    ww = [(0.267, 0.036), (0.275, 0.044), (0.33, 0.044), (0.397, 0.041)]
    ak_lower_handguard(b, wood, 0.268, 0.395, zb, ww, groove=True)
    loft_y([(0.26, se(0.0375, 0.046, 3.0, 32, 0, -0.008)), (0.2685, se(0.0375, 0.046, 3.0, 32, 0, -0.008))], st, 'hg_retainer')
    cy(0.0095, 0.14, (0, 0.335, 0.0229), st, 'Y', 32)
    secs = []
    for y in (0.268, 0.2695, 0.273, 0.3, 0.33, 0.365, 0.39, 0.3935, 0.395):
        e = min((y - 0.268) / 0.005, (0.395 - y) / 0.005, 1.0)
        secs.append((y, arch(0.036 * (0.93 + 0.07 * e), 0.0105, 0.0105 + 0.032 * (0.94 + 0.06 * e), 0.028, 16, 2.6)))
    loft_y(secs, wood, 'upper_handguard')
    for sd in (-1, 1):
        bx((0.004, 0.06, 0.0035), (sd * 0.0168, 0.33, 0.0305), P['shadow'], bevel=0.001, name='vent_slot')
    # Combined gas block and front sight with protective ears and post, sling loop.
    py, pz = AKS74U['post_y'], AKS74U['post_z']
    sprism([(0.395, -0.015), (0.428, -0.015), (0.428, 0.012), (0.422, 0.03), (0.4, 0.035), (0.395, 0.035)], 0.0245, st, bevel=0.0016, name='gas_fsb')
    cy(0.012, 0.034, (0, 0.411, 0), st, 'Y', 32, bevel=0.0012)
    for sd in (-1, 1):
        sprism([(0.402, 0.028), (0.424, 0.028), (0.421, pz + 0.004), (0.407, pz + 0.004)], 0.0028, st, x=sd * 0.0075, bevel=0.0005, name='fs_ear')
    sprism([(0.404, 0.028), (0.422, 0.028), (0.419, 0.036), (0.407, 0.036)], 0.0178, st, bevel=0.0006, name='fs_base')
    bx((0.0018, 0.0022, pz - 0.034), (0, py, (pz + 0.034) / 2), st, bevel=0.0002, name='fs_post')
    tor(0.0065, 0.0015, (-0.0175, 0.411, -0.009), st, 'Y', 20, 8)
    # Muzzle booster: expansion chamber and flared cone, wrench flats.
    lathe([(0.0055, bend - 0.006), (0.0135, bend - 0.006), (0.0142, bend - 0.002), (0.0142, bend + 0.048), (0.0195, bend + 0.072),
           (0.0185, bend + 0.075), (0.0098, bend + 0.075), (0.0098, bend + 0.062), (0.0062, bend + 0.048)], st, 'Y', (0, 0, 0), 40, 'booster', closed=True)
    for sd in (-1, 1):
        bx((0.0015, 0.014, 0.012), (sd * 0.014, bend + 0.008, 0), st, name='booster_flat')
    # Side-folding stamped skeleton stock (extended), hinge on the left of the rear trunnion.
    L = 0.222
    bx((0.03, 0.014, 0.046), (0, -0.006, -0.011), st, bevel=0.002, name='stock_trunnion')
    bx((0.009, 0.026, 0.034), (-0.019, 0.004, -0.012), st, bevel=0.0015, name='stock_hinge')
    cy(0.0045, 0.04, (-0.019, 0.004, -0.012), br, 'Z', 12)
    loft_path([(-0.012, 0.003), (-0.12, -0.005), (-L + 0.004, -0.012)], se(0.016, 0.009, 5, 20), st, 'stock_top')
    loft_path([(-0.012, -0.03), (-0.05, -0.048), (-L + 0.012, -0.1)], se(0.016, 0.009, 5, 20), st, 'stock_bottom')
    sprism([(-L + 0.009, -0.006), (-L, -0.006), (-L, -0.116), (-L + 0.009, -0.116), (-L + 0.017, -0.1), (-L + 0.017, -0.022)], 0.032, st,
           bevel=0.0025, name='butt_plate')
    return bend + 0.075, (0, -L, -0.06)


def rot_y(o, deg):
    """Rotate a part's mesh about the build-frame Y axis (the bore)."""
    o.data.transform(Matrix.Rotation(math.radians(deg), 4, 'Y'))
    return o


def cartridge(b, y, x, z, case_len, case_r, bullet_len, m_case=None, m_bullet=None, seg=10):
    """Rifle round lying along +Y (bullet forward), rear face at y."""
    P = b.P
    lathe([(0, y), (case_r * 1.06, y), (case_r * 1.06, y + 0.002), (case_r, y + 0.003), (case_r, y + case_len * 0.8),
           (case_r * 0.62, y + case_len * 0.9), (case_r * 0.6, y + case_len), (0, y + case_len)], m_case or P['steel_case'], 'Y',
          (x, 0, z), seg, 'case')
    lathe([(case_r * 0.58, y + case_len - 0.001), (case_r * 0.58, y + case_len + bullet_len * 0.35), (case_r * 0.3, y + case_len + bullet_len * 0.85),
           (0, y + case_len + bullet_len)], m_bullet or P['copper'], 'Y', (x, 0, z), seg, 'bullet')


def slotted_hider(b, y0, y1, r, m, slots=5, collar=0.008):
    """Flash hider with long slots: rear collar, prongs, front ring (SVD / PKM)."""
    cy(r, collar, (0, y0 + collar / 2, 0), m, 'Y', 20, bevel=0.001)
    ring = 0.009
    htube(r, r * 0.65, y1 - ring, y1, m, 0, 0, 20, name='hider_ring')
    L = (y1 - ring) - (y0 + collar) + 0.002
    for k in range(slots):
        a = 360.0 * k / slots
        x, z = r * 0.82 * math.sin(math.radians(a)), r * 0.82 * math.cos(math.radians(a))
        bx((r * 0.62, L, r * 0.36), (x, (y0 + collar + y1 - ring) / 2, z), m, (0, a, 0), 0.0006, 'prong')
    cy(r * 0.5, L, (0, (y0 + collar + y1 - ring) / 2, 0), b.P['shadow'], 'Y', 12)


def fluted(y0, y1, R, m, flutes=8, depth=0.0016):
    pts = []
    for k in range(48):
        a = 2 * math.pi * k / 48
        r = R - depth * max(0.0, math.cos(flutes * a)) ** 2
        pts.append((r * math.cos(a), r * math.sin(a)))
    return xprism(pts, y0, y1, m, 'fluted_barrel')


# =================================================================== PKM
# Build frame: bore z = 0, y = 0 at the receiver rear. Proportions from the de-rotated DD-ST-85-01257 photo
# (1.12 mm/px at 1173 mm): stock 0.28 m, receiver 0.36 m, rear sight 0.145 m ahead of the receiver rear, gas block 0.62 m,
# front sight 0.795 m, muzzle 0.895 m. Rear notch 56.5 mm and front post 55.5 mm above the bore; feed cover top 37-43 mm,
# so the sight line clears the cover by > 12 mm.
PKN = dict(notch_y=0.145, notch_z=0.0565, post_y=0.795, post_z=0.0571)


def obround(y0, y1, z0, z1, n=28):
    r = (z1 - z0) / 2
    cz = (z0 + z1) / 2
    pts = []
    for k in range(n // 2 + 1):
        a = -math.pi / 2 + math.pi * k / (n // 2)
        pts.append((y1 - r + r * math.cos(a), cz + r * math.sin(a)))
    for k in range(n // 2 + 1):
        a = math.pi / 2 + math.pi * k / (n // 2)
        pts.append((y0 + r + r * math.cos(a), cz + r * math.sin(a)))
    return pts


def ak_style_notch(ny, nz, half_w, bottom, m, notch_w=0.0013, t=0.0015):
    top = nz + 0.0024
    pts = [(-half_w, bottom), (half_w, bottom), (half_w, top), (notch_w, top)]
    for k in range(7):
        a = math.pi * k / 6
        pts.append((notch_w * math.cos(a), nz + notch_w - notch_w * math.sin(a)))
    pts += [(-notch_w, top), (-half_w, top)]
    return xprism(pts, ny - t, ny + t, m, 'notch_plate', bevel=0.0002)


def pkm():
    b = Build('pkm')
    P = b.P
    st, st2, br = P['steel'], P['steel2'], P['bright']
    ny, nz, py, pz = PKN['notch_y'], PKN['notch_z'], PKN['post_y'], PKN['post_z']
    # Receiver: core plus stamped side skins with two long pressed ribs, feed opening (right) and ejection port (left).
    sprism([(0.0, -0.05), (0.006, -0.054), (0.3, -0.054), (0.3, 0.026), (0.0, 0.026)], 0.044, st2, bevel=0.0015, name='rcv_core')
    def ribs(y, z):
        if not (0.03 < y < 0.27):
            return 0.0
        f = min(1.0, (y - 0.03) / 0.01, (0.27 - y) / 0.01)
        return 0.0009 * f * (math.exp(-((z + 0.012) / 0.0028) ** 2) + math.exp(-((z + 0.036) / 0.0028) ** 2))
    for sd in (-1, 1):
        if sd > 0:
            hole = lambda y, z: 0.17 < y < 0.265 and z > 0.004
        else:
            hole = lambda y, z: 0.19 < y < 0.25 and -0.012 < z < 0.012
        skin_x(sd, 0.0235, 0.002, 0.299, -0.0525, 0.0255, st2, 0.0028, ribs, hole, name='rcv_skin')
        for y, z in ((0.012, 0.012), (0.012, -0.024), (0.012, -0.045), (0.288, 0.012), (0.288, -0.024), (0.288, -0.045), (0.15, -0.046)):
            rivet(y, z, sd, st2, 0.0026, 0.0237)
    bx((0.0015, 0.095, 0.022), (0.021, 0.2175, 0.015), P['shadow'], bevel=0, name='feed_opening')
    bx((0.0015, 0.06, 0.024), (-0.021, 0.22, 0.0), P['shadow'], bevel=0, name='eject_port')
    bx((0.05, 0.01, 0.078), (0, -0.002, -0.014), st2, bevel=0.002, name='rear_plate')
    # Receiver top behind the sight with the cover latch button, rear sight base and raised tangent leaf.
    sprism([(0.002, 0.024), (0.128, 0.024), (0.128, 0.035), (0.012, 0.035), (0.002, 0.031)], 0.047, st2, bevel=0.0015, name='rcv_top_rear')
    cy(0.0045, 0.006, (0, 0.006, 0.03), br, 'Y', 16)
    sprism([(0.127, 0.024), (0.168, 0.024), (0.168, 0.04), (0.127, 0.04)], 0.032, st2, bevel=0.0015, name='rs_base')
    sprism([(0.166, 0.0385), (0.166, 0.0415), (ny + 0.003, nz - 0.0045), (ny, nz - 0.0045), (ny, nz - 0.0075)], 0.016, st2, bevel=0.0004, name='rs_leaf')
    cy(0.0026, 0.022, (0, 0.166, 0.04), st2, 'X', 12)
    ak_style_notch(ny, nz, 0.0085, nz - 0.0095, st2)
    bx((0.021, 0.008, 0.0065), (0, 0.157, 0.048), st2, name='rs_slider')
    for sd in (-1, 1):
        cy(0.0026, 0.004, (sd * 0.0115, 0.157, 0.048), br, 'X', 12, bevel=0.0003)
    for k in range(6):
        y = 0.149 + k * 0.0028
        z = 0.0415 + (0.166 - y) / (0.166 - ny) * (nz - 0.0045 - 0.0415) + 0.0002
        for sd in (-1, 1):
            bx((0.0028, 0.0006, 0.0006), (sd * 0.0052, y, z), P['white'], bevel=0, name='tick')
    # Cocking handle (right), trigger housing, guard, trigger, grip, safety.
    cy_between((0.022, 0.205, -0.03), (0.042, 0.205, -0.03), 0.0042, br, 12)
    lathe([(0, 0.199), (0.007, 0.199), (0.008, 0.205), (0.007, 0.211), (0, 0.211)], br, 'Y', (0.047, 0, -0.03), 16, 'cocking_knob')
    sprism([(0.0, -0.053), (0.152, -0.053), (0.152, -0.062), (0.075, -0.068), (0.0, -0.064)], 0.03, st2, bevel=0.0015, name='trigger_housing')
    gp = chaikin([(0.15, -0.061), (0.15, -0.084), (0.143, -0.094), (0.096, -0.094), (0.088, -0.088), (0.085, -0.066)], 3)
    loft_path(gp, se(0.011, 0.003, 6.0, 16), st2, 'trigger_guard')
    loft_path([(0.112, -0.062), (0.115, -0.072), (0.114, -0.081), (0.109, -0.088)],
              [se(0.0065, 0.0055, 3, 12), se(0.006, 0.005, 3, 12), se(0.0055, 0.0045, 3, 12), se(0.005, 0.0035, 3, 12)], st2, 'trigger')
    gpath = ak_grip(b, P['plum_poly'], top=(0.047, -0.056), bot=(0.024, -0.157))
    sprism([(0.062, -0.06), (0.078, -0.058), (0.08, -0.062), (0.064, -0.066)], 0.003, st2, x=-0.017, bevel=0.0005, name='safety')
    cy(0.004, 0.003, (-0.016, 0.062, -0.062), br, 'X', 12)
    # Front trunnion / barrel lock, handle collar with the carry handle swung down to the left.
    sprism([(0.3, -0.046), (0.362, -0.046), (0.362, 0.019), (0.3, 0.024)], 0.042, st2, bevel=0.002, name='trunnion')
    bx((0.006, 0.03, 0.014), (-0.022, 0.335, -0.01), st2, name='barrel_lock')
    cy(0.0165, 0.016, (0, 0.37, 0), st2, 'Y', 32, bevel=0.001)
    h = loft_path(chaikin([(0.372, 0.014), (0.375, 0.04), (0.36, 0.06), (0.34, 0.068)], 2), se(0.013, 0.008, 3.0, 16), st2, 'handle_arm')
    h2 = cy(0.0105, 0.085, (0, 0.3, 0.068), P['plum_poly'], 'Y', 24, bevel=0.002)
    h3 = cy(0.0062, 0.1, (0, 0.3, 0.068), st2, 'Y', 12)
    for o in (h, h2, h3):
        rot_y(o, -78)
    # Barrel (fluted at the rear), gas tube and block with regulator, bipod folded forward, front sight, flash hider.
    fluted(0.362, 0.6, 0.0125, st, 8, 0.0018)
    cy(0.0105, 0.23, (0, 0.715, 0), st, 'Y', 32)
    cy(0.0075, 0.26, (0, 0.488, -0.031), st2, 'Y', 24)
    cy(0.011, 0.04, (0, 0.38, -0.031), st2, 'Y', 24, bevel=0.0012)
    sprism([(0.605, -0.046), (0.64, -0.046), (0.64, 0.0125), (0.605, 0.0125)], 0.026, st2, bevel=0.002, name='gas_block')
    cy(0.0072, 0.012, (-0.017, 0.623, -0.031), st2, 'X', 16, bevel=0.001)
    bx((0.022, 0.024, 0.014), (0, 0.623, -0.053), st2, bevel=0.0015, name='bipod_hinge')
    cy(0.004, 0.03, (0, 0.623, -0.053), br, 'X', 12)
    for sd in (-1, 1):
        cy_between((sd * 0.008, 0.625, -0.056), (sd * 0.0115, 0.865, -0.026), 0.0055, st2, 12)
        cy_between((sd * 0.0115, 0.865, -0.026), (sd * 0.012, 0.885, -0.022), 0.0042, st2, 10)
        bx((0.007, 0.03, 0.012), (sd * 0.0135, 0.872, -0.031), st2, (14, 0, 0), name='bipod_foot')
    bx((0.03, 0.009, 0.006), (0, 0.76, -0.0215), st2, name='bipod_clip')
    bx((0.006, 0.009, 0.016), (0, 0.76, -0.0125), st2, name='bipod_clip_post')
    cy(0.012, 0.025, (0, py, 0), st2, 'Y', 32, bevel=0.0012)
    sprism([(py - 0.011, 0.006), (py + 0.011, 0.006), (py + 0.008, pz - 0.014), (py - 0.007, pz - 0.014)], 0.012, st2, bevel=0.0012, name='fs_tower')
    for sd in (-1, 1):
        sprism([(py - 0.008, pz - 0.018), (py + 0.008, pz - 0.018), (py + 0.006, pz + 0.004), (py - 0.005, pz + 0.004)], 0.0026, st2,
               x=sd * 0.0072, bevel=0.0005, name='fs_ear')
    bx((0.0019, 0.0022, 0.016), (0, py, pz - 0.008), st2, bevel=0.0002, name='fs_post')
    slotted_hider(b, 0.822, 0.895, 0.0112, st2)
    # Skeletonised laminated stock (real hole), steel butt plate with the folding shoulder rest, sling swivel.
    outer = [(0.004, 0.02), (-0.02, 0.006), (-0.27, 0.002), (-0.277, 0.008), (-0.284, 0.004), (-0.284, -0.112), (-0.276, -0.118),
             (-0.24, -0.111), (-0.2, -0.107), (-0.172, -0.114), (-0.15, -0.111), (-0.125, -0.099), (-0.095, -0.08), (-0.065, -0.064),
             (-0.035, -0.057), (0.004, -0.054)]
    outer = chaikin(outer + [outer[0]], 2)[:-1]
    ring_plate(outer, obround(-0.228, -0.123, -0.061, -0.015), 0.036, P['plum'], n=96, bevel=0.0065, name='stock')
    sprism([(-0.2825, 0.006), (-0.2905, 0.006), (-0.2905, -0.116), (-0.2825, -0.116)], 0.039, st2, bevel=0.002, name='butt_plate')
    sprism([(-0.29, 0.004), (-0.296, 0.004), (-0.296, -0.06), (-0.29, -0.06)], 0.03, st2, bevel=0.0015, name='shoulder_rest')
    cy(0.003, 0.034, (0, -0.293, 0.002), br, 'X', 10)
    tor(0.0085, 0.0017, (-0.019, -0.24, -0.102), st2, 'X', 20, 8)
    # Feed cover (hinged at its front pin as on the real PK), feed-lever hump, rear latch tab.
    b.group('cover')
    sprism([(0.169, 0.0255), (0.305, 0.0255), (0.305, 0.034), (0.298, 0.038), (0.176, 0.038), (0.169, 0.035)], 0.05, st2, bevel=0.0015, name='feed_cover')
    sprism([(0.2, 0.0375), (0.29, 0.0375), (0.284, 0.0435), (0.21, 0.0435)], 0.026, st2, bevel=0.002, name='cover_hump')
    bx((0.03, 0.008, 0.006), (0, 0.173, 0.04), st2, name='cover_latch')
    for sd in (-1, 1):
        bx((0.0015, 0.12, 0.0035), (sd * 0.0252, 0.24, 0.031), st2, bevel=0, name='cover_lip')
    cy(0.0045, 0.052, (0, 0.302, 0.03), st2, 'X', 16)
    # 100-round box under the right side, ribbed, with lid, latch, handle and the belt rising into the feed opening.
    b.group('box')
    bc = (0.014, 0.24, -0.115)
    bx((0.072, 0.15, 0.1), bc, P['olive'], bevel=0.004, name='ammo_box')
    def box_ribs(y, z):
        return 0.0014 * sum(math.exp(-((z - zz) / 0.003) ** 2) for zz in (-0.095, -0.115, -0.135)) * min(1.0, (y - 0.172) / 0.008, (0.308 - y) / 0.008, 1.0) if 0.172 < y < 0.308 else 0.0
    for sd in (-1, 1):
        sk = skin_x(sd, 0.0365, 0.168, 0.312, -0.162, -0.068, P['olive'], 0.004, box_ribs, name='box_skin')
        sk.data.transform(Matrix.Translation((bc[0], 0, 0)))
    bx((0.076, 0.154, 0.01), (bc[0], bc[1], -0.0605), P['olive'], bevel=0.002, name='box_lid')
    bx((0.012, 0.03, 0.006), (bc[0] - 0.02, bc[1], -0.058), st2, name='box_mount')
    bx((0.014, 0.012, 0.018), (bc[0], bc[1] + 0.078, -0.07), st2, name='box_latch')
    tor(0.02, 0.0024, (bc[0], bc[1] - 0.077, -0.085), P['canvas'], 'Y', 20, 8, arc=180, rot=(90, 0, 0))
    belt = chaikin([(0.03, -0.062), (0.046, -0.05), (0.05, -0.032), (0.046, -0.014), (0.036, 0.0), (0.026, 0.012)], 1)
    for x, z in belt[::1][:7]:
        cartridge(b, 0.19, x, z, 0.054, 0.0061, 0.024, P['steel_case'], P['copper'], 12)
        bx((0.007, 0.012, 0.012), (x - 0.001, 0.208, z), st2, bevel=0.0006, name='link')
    b.group('body')
    gy, gz = path_point(gpath, 0.45)
    back = 0.3
    lz = nz + LOS
    slope = (pz - lz) / (py - ny)
    b.E('muzzle', (0, 0.895, 0))
    b.E('eye', (0, ny, lz))
    b.E('cheek', (0, ny - back, lz - slope * back))
    b.E('front_post', (0, py, pz))
    b.E('grip_r', (0, gy, gz))
    b.E('grip_l', (0, 0.33, -0.052))
    b.E('eject', (-0.024, 0.22, 0.0))
    b.E('butt', (0, -0.2905, -0.055))
    return b.finish((0, gy, gz), {'cover': (0, 0.302, 0.03), 'box': (0.014, 0.24, -0.06)}), ['pkm']


# =================================================================== SVD
# Build frame: bore z = 0, y = 0 at the receiver rear. From src-assets/ref/ins/svd_side.jpg (0.98 mm/px at 1225 mm):
# stock 0.243 m, receiver 0.30 m, handguard 0.30-0.58 m, gas block 0.58-0.675 m, front sight 0.875 m, flash hider to 0.982 m.
# PSO-1 axis 71 mm above the bore, offset left; eyecup rear 74 mm behind the receiver rear.
SVDN = dict(sx=-0.028, sz=0.071, eyecup=-0.074, notch_y=0.288, notch_z=0.0385, post_y=0.875, post_z=0.0391)


def svd():
    b = Build('svd')
    P = b.P
    st, br, wood = P['steel'], P['bright'], P['wood']
    # Receiver core, side skins with the ejection port, dust cover, spring-guide tab, safety lever, charging handle.
    sprism([(0.0, -0.042), (0.004, -0.045), (0.3, -0.045), (0.3, 0.006), (0.0, 0.006)], 0.029, st, bevel=0.0012, name='rcv_core')
    for sd in (-1, 1):
        hole = (lambda y, z: 0.15 < y < 0.235 and z > -0.006) if sd > 0 else None
        skin_x(sd, 0.0152, 0.002, 0.299, -0.0435, 0.0055, st, 0.0028, None, hole, name='rcv_skin')
        for y, z in ((0.012, -0.004), (0.012, -0.03), (0.288, -0.004), (0.288, -0.03), (0.27, -0.038)):
            rivet(y, z, sd, st, 0.0021, 0.0153)
    sprism([(0.15, -0.006), (0.235, -0.006), (0.235, 0.006), (0.15, 0.006)], 0.022, st, x=-0.0035, name='rcv_core_port')
    bx((0.003, 0.085, 0.011), (0.0095, 0.1925, 0.0), br, name='bolt_carrier')
    loft_y([(0.002, arch(0.027, -0.0005, 0.011, 0.005, 14, 2.8)), (0.005, arch(0.0315, -0.0005, 0.0137, 0.006, 14, 2.8)),
            (0.25, arch(0.0315, -0.0005, 0.0137, 0.006, 14, 2.8))], st, 'dust_cover')
    loft_y([(-0.004, se(0.01, 0.0055, 3, 16, 0, 0.007)), (0.005, se(0.01, 0.0055, 3, 16, 0, 0.007))], st, 'guide_tab')
    sprism([(0.03, -0.022), (0.044, -0.023), (0.06, -0.016), (0.2, -0.008), (0.226, -0.009), (0.236, -0.008), (0.236, 0.004), (0.2, 0.004),
            (0.06, -0.008), (0.032, -0.012)], 0.0016, st, x=0.0163, bevel=0.0004, name='safety')
    cy(0.0062, 0.0022, (0.0162, 0.037, -0.017), st, 'X', 24, bevel=0.0004)
    cy_between((0.012, 0.245, -0.0), (0.03, 0.245, 0.002), 0.0033, br, 12)
    ball(0.0058, (0.0345, 0.245, 0.0025), br, (1.25, 1, 0.95), 16, 10)
    # Rear sight block (front of the receiver) with tangent leaf and notch.
    ny, nz, py, pz = SVDN['notch_y'], SVDN['notch_z'], SVDN['post_y'], SVDN['post_z']
    sprism([(0.27, -0.016), (0.33, -0.016), (0.33, 0.022), (0.318, 0.027), (0.28, 0.028), (0.27, 0.022)], 0.027, st, bevel=0.0015, name='rs_block')
    sprism([(0.326, 0.027), (0.326, 0.03), (ny + 0.003, nz - 0.0035), (ny, nz - 0.0035), (ny, nz - 0.0065)], 0.015, st, bevel=0.0004, name='rs_leaf')
    ak_style_notch(ny, nz, 0.0075, nz - 0.0085, st)
    bx((0.019, 0.007, 0.006), (0, 0.305, 0.0335), st, name='rs_slider')
    # PSO-1 side mount on the left rail and the scope.
    sx, sz, ec = SVDN['sx'], SVDN['sz'], SVDN['eyecup']
    bx((0.004, 0.14, 0.014), (-0.0168, 0.115, -0.016), st, name='side_rail')
    sprism([(0.06, -0.024), (0.165, -0.024), (0.158, sz - 0.016), (0.07, sz - 0.016)], 0.011, P['phos'], x=-0.024, bevel=0.002, name='scope_mount')
    sprism([(0.075, sz - 0.022), (0.155, sz - 0.022), (0.155, sz - 0.012), (0.075, sz - 0.012)], 0.03, P['phos'], x=sx, bevel=0.002, name='mount_saddle')
    cy_between((-0.03, 0.13, -0.017), (-0.044, 0.13, -0.017), 0.0045, P['phos'], 12)
    bx((0.006, 0.05, 0.009), (-0.046, 0.115, -0.017), P['phos'], name='mount_lever')
    ribs = [(0.012, ec), (0.0195, ec)]
    for k in range(5):
        y = ec + 0.006 + k * 0.0075
        ribs += [(0.0205, y), (0.019, y + 0.0035)]
    ribs += [(0.0185, -0.03), (0.012, -0.03)]
    lathe(ribs, P['rubber'], 'Y', (sx, 0, sz), 40, 'eyecup', closed=True)
    cy(0.012, 0.002, (sx, -0.031, sz), P['glass'], 'Y', 32)
    lathe([(0.0, -0.032), (0.0175, -0.032), (0.0185, -0.02), (0.0185, -0.005), (0.0138, 0.005), (0.0138, 0.1), (0.0, 0.1)], P['phos'], 'Y', (sx, 0, sz), 48, 'eyepiece')
    loft_y([(0.098, se(0.031, 0.034, 3.6, 40, sx, sz)), (0.102, se(0.034, 0.037, 3.6, 40, sx, sz)), (0.168, se(0.034, 0.037, 3.6, 40, sx, sz)),
            (0.172, se(0.031, 0.034, 3.6, 40, sx, sz))], P['phos'], 'turret_block')
    cy(0.016, 0.018, (sx, 0.135, sz + 0.027), P['phos'], 'Z', 40, bevel=0.0015)
    cy(0.012, 0.004, (sx, 0.135, sz + 0.0375), P['phos'], 'Z', 32, bevel=0.0008)
    cy(0.015, 0.016, (sx - 0.025, 0.135, sz), P['phos'], 'X', 40, bevel=0.0015)
    cy(0.007, 0.012, (sx - 0.02, 0.112, sz + 0.012), P['phos'], 'X', 20, bevel=0.001)
    lathe([(0.0, 0.17), (0.0138, 0.17), (0.0138, 0.24), (0.021, 0.262), (0.021, 0.345), (0.0, 0.345)], P['phos'], 'Y', (sx, 0, sz), 48, 'objective')
    htube(0.0212, 0.0185, 0.335, 0.352, P['phos'], sx, sz, 48, name='sunshade')
    cy(0.0185, 0.002, (sx, 0.338, sz), P['glass'], 'Y', 40)
    # Handguards (one oval loft split by a seam) with staggered horizontal vent slots; ferrule; gas block; barrel; front
    # sight; flash hider with five long slots.
    cy(0.0098, 0.59, (0, 0.575, 0), st, 'Y', 32)
    secs = []
    for y in [0.3, 0.302, 0.307] + [0.32 + 0.24 * k / 8 for k in range(9)] + [0.573, 0.578, 0.58]:
        e = min((y - 0.3) / 0.007, (0.58 - y) / 0.007, 1.0)
        f = 1.0 - 0.08 * (y - 0.3) / 0.28
        secs.append((y, se(0.05 * (0.93 + 0.07 * e) * f, 0.049 * (0.94 + 0.06 * e), 2.3, 48, 0, 0.0015)))
    loft_y(secs, wood, 'handguard')
    for sd in (-1, 1):
        bx((0.0012, 0.278, 0.0012), (sd * 0.0242, 0.44, 0.003), P['shadow'], bevel=0, name='hg_seam')
        for k in range(4):
            bx((0.006, 0.026, 0.0052), (sd * 0.0225, 0.335 + k * 0.058, 0.012), P['shadow'], bevel=0.0012, name='vent')
            if k < 3:
                bx((0.006, 0.026, 0.0052), (sd * 0.0225, 0.364 + k * 0.058, -0.009), P['shadow'], bevel=0.0012, name='vent')
    xprism(se(0.047, 0.05, 2.5, 32, 0, 0.0015), 0.578, 0.586, st, 'ferrule')
    sprism([(0.584, -0.014), (0.675, -0.014), (0.675, 0.008), (0.665, 0.02), (0.6, 0.026), (0.584, 0.026)], 0.024, st, bevel=0.002, name='gas_block')
    cy(0.0125, 0.09, (0, 0.63, 0), st, 'Y', 32, bevel=0.0012)
    cy(0.009, 0.08, (0, 0.625, 0.017), st, 'Y', 24)
    tor(0.0085, 0.0017, (0, 0.6, -0.021), st, 'X', 20, 8)
    cy(0.0118, 0.024, (0, py, 0), st, 'Y', 32, bevel=0.0012)
    sprism([(py - 0.011, 0.004), (py + 0.011, 0.004), (py + 0.008, pz - 0.009), (py - 0.007, pz - 0.009)], 0.011, st, bevel=0.0012, name='fs_tower')
    htube(0.0092, 0.0075, py - 0.006, py + 0.006, st, 0, pz - 0.002, 32, name='fs_hood')
    bx((0.0018, 0.0022, 0.012), (0, py, pz - 0.006), st, bevel=0.0002, name='fs_post')
    bx((0.008, 0.02, 0.0075), (0, py, -0.0155), st, name='bayonet_lug')
    slotted_hider(b, 0.889, 0.982, 0.0108, st, slots=5, collar=0.012)
    # Trigger guard, trigger, thumbhole skeleton stock with the cheek pad, butt plate, rear sling swivel.
    gp = chaikin([(0.118, -0.044), (0.118, -0.07), (0.11, -0.078), (0.08, -0.078), (0.071, -0.07), (0.069, -0.045)], 3)
    loft_path(gp, se(0.011, 0.0028, 6.0, 16), st, 'trigger_guard')
    loft_path([(0.093, -0.044), (0.096, -0.055), (0.095, -0.064), (0.09, -0.071)],
              [se(0.0065, 0.0055, 3, 12), se(0.006, 0.005, 3, 12), se(0.0055, 0.0045, 3, 12), se(0.005, 0.0035, 3, 12)], st, 'trigger')
    outer = [(0.001, -0.002), (-0.03, -0.02), (-0.21, -0.021), (-0.243, -0.023), (-0.2475, -0.03), (-0.2475, -0.126), (-0.24, -0.133),
             (0.018, -0.134), (0.038, -0.131), (0.045, -0.11), (0.052, -0.072), (0.06, -0.0465), (0.001, -0.0465)]
    outer = chaikin(outer + [outer[0]], 2)[:-1]
    hole = chaikin([(-0.002, -0.038), (-0.15, -0.038), (-0.163, -0.05), (-0.163, -0.09), (-0.152, -0.101), (0.02, -0.101), (0.013, -0.075),
                    (0.006, -0.048), (-0.002, -0.038)], 2)[:-1]
    ring_plate(outer, hole, 0.034, wood, n=110, bevel=0.007, name='stock', c=(-0.07, -0.07))
    loft_y([(-0.05, se(0.03, 0.022, 3.0, 32, 0, -0.008)), (-0.055, se(0.034, 0.026, 3.0, 32, 0, -0.008)), (-0.168, se(0.034, 0.026, 3.0, 32, 0, -0.008)),
            (-0.173, se(0.03, 0.022, 3.0, 32, 0, -0.008))], P['rubber'], 'cheek_pad')
    sprism([(-0.2465, -0.024), (-0.2525, -0.024), (-0.2525, -0.134), (-0.2465, -0.134)], 0.036, st, bevel=0.002, name='butt_plate')
    tor(0.0085, 0.0017, (-0.019, -0.2, -0.124), st, 'X', 20, 8)
    # 10-round magazine with its stamped ribs.
    b.group('mag')
    d0 = 0.085
    path = arc_path((0.175 + d0 / 2, -0.04), D(3), 0.6, 0.098, 12)
    loft_path(path, [se(0.027, lerp(d0, 0.088, i / 12), 7, 40) for i in range(13)], st, 'mag_body')
    for off in (-0.026, -0.009, 0.009, 0.026):
        loft_path(path[2:11], [(x, d + off) for x, d in se(0.0286, 0.007, 3, 16)], st, 'mag_rib')
    loft_path([path[-1], (path[-1][0] + 0.0004, path[-1][1] - 0.006)], se(0.03, 0.094, 8, 32), st, 'floorplate')
    b.group('body')
    gy, gz = 0.03, -0.088
    lz = nz + LOS
    slope = (pz - lz) / (py - ny)
    b.E('muzzle', (0, 0.982, 0))
    b.E('eye', (sx, ec, sz))
    b.E('cheek', (sx, ec - 0.07, sz))
    b.E('eye_irons', (0, ny, lz))
    b.E('cheek_irons', (0, ny - 0.3, lz - slope * 0.3))
    b.E('front_post', (0, py, pz))
    b.E('grip_r', (0, gy, gz))
    b.E('grip_l', (0, 0.4, -0.026))
    b.E('eject', (0.016, 0.19, 0.0))
    b.E('butt', (0, -0.2525, -0.08))
    return b.finish((0, gy, gz), {'mag': (0, 0.175 + d0 / 2, -0.04)}), ['svd']


# =================================================================== RPG-7 and PG-7V
# Build frame: tube axis z = 0, muzzle at y = 0, venturi rim at y = -0.95. Layout from the RPG-7(D) photo
# (src-assets/ref/ins/rpg7_side.jpg, 0.85 mm/px): front sight 0.02-0.075 m behind the muzzle, trigger grip ~0.15 m,
# sight/optic block 0.205-0.33 m, rear grip ~0.3 m, wooden heat guard 0.33-0.71 m (thick at the front, tapering rearwards),
# bands, flared venturi 0.76-0.95 m (rim ~130 mm). Right hand on the front (trigger) grip, left hand on the rear grip.
RPGN = dict(post_y=-0.05, post_z=0.0525, notch_y=-0.255, notch_z=0.0545, optic_x=-0.062, optic_z=0.062, eyecup_y=-0.372)

PG7V_PROFILE = [(0, 0), (0.0058, 0.0), (0.0074, 0.004), (0.0074, 0.008), (0.0095, 0.009), (0.0095, 0.03), (0.0108, 0.031),
                (0.0305, 0.105), (0.0425, 0.158), (0.0425, 0.19), (0.0415, 0.215), (0.038, 0.24), (0.0305, 0.268), (0.024, 0.29),
                (0.0215, 0.3)]


def pg7v_parts(b, nose_y, z=0.0, deployed=False):
    """PG-7V(M) grenade, nose at nose_y, axis along Y: brass-capped piezo nose fuze, conical 85 mm HEAT warhead, ogive
    boat-tail, nozzle ring with six angled nozzles, sustainer motor, four fins (folded along the motor or deployed) and
    the small tail vanes."""
    P = b.P
    prof = [(r, nose_y - d) for r, d in PG7V_PROFILE[4:]] + [(0.0, nose_y - 0.3)]
    lathe([(0, nose_y - 0.009)] + prof, P['warhead'], 'Y', (0, 0, z), 48, 'warhead')
    lathe([(0, nose_y), (0.0058, nose_y), (0.0074, nose_y - 0.004), (0.0074, nose_y - 0.0095), (0, nose_y - 0.0095)], P['brass'], 'Y', (0, 0, z), 24, 'fuze_cap')
    for d in (0.16, 0.188):
        htube(0.0428, 0.04, nose_y - d - 0.002, nose_y - d + 0.002, P['shadow'], 0, z, 48, name='seam')
    lathe([(0, nose_y - 0.299), (0.0222, nose_y - 0.299), (0.0228, nose_y - 0.304), (0.0228, nose_y - 0.33), (0.0205, nose_y - 0.335), (0, nose_y - 0.335)],
          P['bright'], 'Y', (0, 0, z), 32, 'nozzle_ring')
    for k in range(6):
        a = 2 * math.pi * (k + 0.5) / 6
        cy_between((0.0175 * math.cos(a), nose_y - 0.306, z + 0.0175 * math.sin(a)), (0.0232 * math.cos(a), nose_y - 0.326, z + 0.0232 * math.sin(a)),
                   0.0034, P['shadow'], 10, r2=0.0044)
    lathe([(0, nose_y - 0.334), (0.0194, nose_y - 0.334), (0.0194, nose_y - 0.56), (0.016, nose_y - 0.575), (0, nose_y - 0.575)], P['phos'], 'Y',
          (0, 0, z), 24, 'motor')
    for k in range(4):
        a = 90.0 * k + 45
        if deployed:
            fin = sprism([(nose_y - 0.49, 0.0192), (nose_y - 0.565, 0.0192), (nose_y - 0.574, 0.09), (nose_y - 0.532, 0.09)], 0.0016, P['phos'], name='fin')
        else:
            fin = sprism([(nose_y - 0.455, 0.0192), (nose_y - 0.565, 0.0192), (nose_y - 0.565, 0.0208), (nose_y - 0.455, 0.0208)], 0.012, P['phos'], name='fin_folded')
        fin.data.transform(Matrix.Translation((0, 0, z)) @ Matrix.Rotation(math.radians(a), 4, 'Y'))
        vane = sprism([(nose_y - 0.56, 0.0), (nose_y - 0.578, 0.0), (nose_y - 0.578, 0.026), (nose_y - 0.566, 0.026)], 0.0014, P['phos'], name='vane')
        vane.data.transform(Matrix.Translation((0, 0, z)) @ Matrix.Rotation(math.radians(a + 45), 4, 'Y'))


def rpg_grip(b, m, top, bot, w0=0.027, d0=0.043):
    n = 10
    path = [(lerp(top[0], bot[0], i / n), lerp(top[1], bot[1], i / n)) for i in range(n + 1)]
    secs = []
    for i in range(n + 1):
        f = i / n
        w = interp([(0, w0), (0.5, w0 + 0.002), (1, w0 + 0.002)], f)
        d = interp([(0, d0), (0.85, d0 - 0.002), (1, d0 - 0.004)], f)
        secs.append(se(w, d, 3.2 if f < 0.96 else 4.0, 40))
    loft_path(path, secs, m, 'grip')
    return path


def rpg7():
    b = Build('rpg7')
    P = b.P
    st, st2, br = P['steel'], P['steel2'], P['bright']
    wood = P['wood_rpg']
    # Launch tube with the 40 mm bore, rear nozzle throat and flared venturi (hollow, so the blast cone is open).
    outer = [(0.0258, 0.0), (0.0258, -0.012), (0.0236, -0.0135), (0.0236, -0.2), (0.0245, -0.2), (0.0245, -0.33), (0.026, -0.335),
             (0.026, -0.715), (0.03, -0.72), (0.03, -0.76), (0.033, -0.765), (0.036, -0.79), (0.045, -0.85), (0.056, -0.915), (0.0615, -0.94),
             (0.065, -0.942), (0.065, -0.95)]
    inner = [(0.0605, -0.95), (0.0575, -0.94), (0.051, -0.9), (0.04, -0.84), (0.028, -0.79), (0.019, -0.765), (0.0175, -0.75), (0.02, -0.72), (0.02, 0.0)]
    lathe(outer + inner, st2, 'Y', (0, 0, 0), 48, 'tube', closed=True)
    for y in (-0.728, -0.75):
        htube(0.0345, 0.0295, y - 0.005, y + 0.005, st2, 0, 0, 48, name='rear_band')
    # Front sight (folding post with base) near the muzzle; sling swivel under it.
    sprism([(-0.022, 0.02), (-0.078, 0.02), (-0.078, 0.03), (-0.07, 0.035), (-0.03, 0.035), (-0.022, 0.03)], 0.02, st2, bevel=0.0015, name='fs_base')
    for sd in (-1, 1):
        sprism([(-0.04, 0.033), (-0.06, 0.033), (-0.058, RPGN['post_z'] + 0.003), (-0.044, RPGN['post_z'] + 0.003)], 0.0026, st2, x=sd * 0.0075,
               bevel=0.0004, name='fs_ear')
    bx((0.0022, 0.0024, RPGN['post_z'] - 0.034), (0, RPGN['post_y'], (RPGN['post_z'] + 0.034) / 2), st2, bevel=0.0002, name='fs_post')
    tor(0.009, 0.0018, (0, -0.07, -0.032), st2, 'X', 20, 8)
    bx((0.01, 0.014, 0.008), (0, -0.07, -0.026), st2, name='swivel_base')
    # Trigger mechanism: housing, large guard, trigger, external hammer, safety, front (trigger) grip.
    sprism([(-0.095, -0.021), (-0.205, -0.021), (-0.205, -0.05), (-0.19, -0.058), (-0.105, -0.058), (-0.095, -0.046)], 0.026, st2, bevel=0.0018, name='trigger_housing')
    gp = chaikin([(-0.148, -0.058), (-0.108, -0.059), (-0.099, -0.066), (-0.1, -0.082), (-0.11, -0.09), (-0.145, -0.088)], 3)
    loft_path(gp, se(0.013, 0.003, 6.0, 16), br, 'trigger_guard')
    loft_path([(-0.126, -0.057), (-0.123, -0.067), (-0.124, -0.076), (-0.129, -0.082)],
              [se(0.007, 0.0055, 3, 12), se(0.0065, 0.005, 3, 12), se(0.006, 0.0045, 3, 12), se(0.0055, 0.0035, 3, 12)], br, 'trigger')
    sprism([(-0.2, -0.026), (-0.212, -0.028), (-0.218, -0.02), (-0.21, -0.016), (-0.2, -0.019)], 0.008, br, bevel=0.0006, name='hammer')
    cy(0.0035, 0.034, (0, -0.15, -0.035), br, 'X', 12)
    gpath = rpg_grip(b, wood, (-0.168, -0.056), (-0.186, -0.165))
    # Sight / optic block on the chamber with the rear iron sight and the PGO-7 bracket rail on the left.
    cy(0.031, 0.125, (0, -0.2675, 0), st2, 'Y', 48, bevel=0.002)
    sprism([(-0.212, 0.026), (-0.322, 0.026), (-0.322, 0.035), (-0.212, 0.035)], 0.024, st2, bevel=0.0015, name='block_top')
    for k in range(3):
        for sd in (-1, 1):
            bx((0.004, 0.018, 0.009), (sd * 0.029, -0.23 - k * 0.032, 0.008), P['shadow'], bevel=0.0005, name='block_window')
    ny, nz = RPGN['notch_y'], RPGN['notch_z']
    sprism([(ny + 0.012, 0.034), (ny - 0.012, 0.034), (ny - 0.012, 0.04), (ny + 0.012, 0.04)], 0.02, st2, bevel=0.001, name='rs_base')
    ak_style_notch(ny, nz, 0.0085, 0.039, st2)
    bx((0.0035, 0.06, 0.022), (-0.0325, -0.268, 0.008), st2, bevel=0.001, name='optic_rail')
    # PGO-7 optic: tall body, objective with sun shade, rubber eyecup, elevation and illumination knobs, mount clamp.
    ox, oz = RPGN['optic_x'], RPGN['optic_z']
    sprism([(-0.23, 0.0), (-0.3, 0.0), (-0.3, 0.03), (-0.23, 0.03)], 0.016, st2, x=-0.042, bevel=0.002, name='optic_mount')
    cy(0.006, 0.02, (-0.046, -0.265, 0.0), br, 'X', 12)
    loft_y([(-0.335, se(0.036, 0.052, 3.4, 32, ox, oz - 0.004)), (-0.33, se(0.04, 0.056, 3.4, 32, ox, oz - 0.004)), (-0.215, se(0.04, 0.056, 3.4, 32, ox, oz - 0.004)),
            (-0.21, se(0.036, 0.052, 3.4, 32, ox, oz - 0.004))], P['phos'], 'pgo7_body')
    lathe([(0.0145, -0.21), (0.019, -0.207), (0.019, -0.178), (0.017, -0.178), (0.017, -0.205), (0.0145, -0.205)], P['phos'], 'Y', (ox, 0, oz), 32, 'pgo7_shade', closed=True)
    cy(0.0165, 0.002, (ox, -0.204, oz), P['glass'], 'Y', 32)
    cy(0.013, 0.012, (ox, -0.341, oz), P['phos'], 'Y', 32)
    lathe([(0.0095, eyc := RPGN['eyecup_y']), (0.02, eyc), (0.0205, eyc + 0.006), (0.017, eyc + 0.02), (0.014, eyc + 0.025), (0.0095, eyc + 0.025)],
          P['rubber'], 'Y', (ox, 0, oz), 32, 'eyecup', closed=True)
    cy(0.0095, 0.002, (ox, eyc + 0.023, oz), P['glass'], 'Y', 24)
    cy(0.0115, 0.014, (ox, -0.29, oz + 0.032), P['phos'], 'Z', 24, bevel=0.0012)
    cy(0.0085, 0.012, (ox - 0.024, -0.255, oz), P['phos'], 'X', 20, bevel=0.001)
    cy(0.006, 0.008, (ox + 0.022, -0.3, oz + 0.01), P['phos'], 'X', 16)
    # Rear grip, wooden heat guard (two bands) and the rear sling swivel.
    rgp = rpg_grip(b, wood, (-0.292, -0.028), (-0.31, -0.126), 0.026, 0.04)
    rr = [(-0.333, 0.0275), (-0.338, 0.033), (-0.35, 0.038), (-0.375, 0.041), (-0.45, 0.042), (-0.52, 0.041), (-0.55, 0.0385), (-0.6, 0.0355),
          (-0.65, 0.034), (-0.7, 0.033), (-0.708, 0.031), (-0.712, 0.028)]
    loft_y([(y, se(2 * r, 2 * r, 2.0, 48)) for y, r in reversed(rr)], wood, 'heat_guard')
    for y, r in ((-0.6, 0.0366), (-0.336, 0.034), (-0.709, 0.0335)):
        loft_y([(y - 0.005, se(2 * r, 2 * r, 2.0, 48)), (y + 0.005, se(2 * r, 2 * r, 2.0, 48))], st2, 'guard_band')
    tor(0.009, 0.0018, (0, -0.74, -0.04), st2, 'X', 20, 8)
    # The PG-7V round in the muzzle (whole round as one child mesh).
    b.group('rocket')
    nose = 0.005 + 0.3175
    pg7v_parts(b, nose)
    b.group('body')
    gy, gz = path_point(gpath, 0.45)
    ly, lz = path_point(rgp, 0.45)
    b.E('muzzle', (0, 0.0, 0))
    b.E('eye', (ox, eyc, oz))
    b.E('cheek', (ox, eyc - 0.07, oz))
    b.E('eye_irons', (0, ny, nz))
    b.E('front_post', (0, RPGN['post_y'], RPGN['post_z']))
    b.E('grip_r', (0, gy, gz))
    b.E('grip_l', (0, ly, lz))
    b.E('butt', (0, -0.5, -0.042))
    b.E('backblast', (0, -0.95, 0))
    return b.finish((0, gy, gz), {'rocket': (0, nose - 0.25, 0)}), ['rpg7']


def pg7v():
    b = Build('pg7v')
    pg7v_parts(b, 0.25, 0.0, deployed=True)
    b.E('nose', (0, 0.25, 0))
    b.E('exhaust', (0, 0.25 - 0.575, 0))
    return b.finish((0, 0, 0)), ['pg7v']


# =================================================================== Makarov PM
# Build frame: bore z = 0. From src-assets/ref/ins/makarov_side.jpg (0.145 mm/px at 161 mm): slide 157 mm, slide
# -0.011..+0.0125 around the bore, trigger guard 22-79 mm ahead of the grip front strap top, grip raked ~12 deg,
# grip bottom 111 mm below the bore.
def makarov():
    b = Build('makarov')
    P = b.P
    st, br = P['steel'], P['bright']
    y0, y1 = -0.031, 0.1265
    secs = []
    ys = [y0, y0 + 0.0015, y0 + 0.004] + [lerp(y0 + 0.008, y1 - 0.014, k / 10) for k in range(11)] + [y1 - 0.008, y1 - 0.004, y1 - 0.0015, y1]
    for y in ys:
        e = min((y - y0) / 0.004, 1.0)
        f = 1.0 if y < y1 - 0.014 else 1.0 - ((y - (y1 - 0.014)) / 0.014) ** 2 * 0.22
        k = (0.95 + 0.05 * e) * f
        secs.append((y, arch(0.0285 * k, -0.011 + (1 - f) * 0.004, 0.0125 - (1 - f) * 0.006, -0.001, 18, 2.1)))
    loft_y(secs, st, 'slide')
    for i in range(11):
        for sd in (-1, 1):
            bx((0.0009, 0.0011, 0.0135), (sd * 0.0141, -0.0265 + i * 0.0026, 0.0005), P['shadow'], (0, 0, 0), 0, 'serration')
    bx((0.0016, 0.024, 0.0085), (0.0137, 0.043, 0.0055), P['shadow'], (0, 0, 0), 0, 'eject_port')
    htube(0.0056, 0.0046, y1 - 0.004, y1 + 0.0003, br, 0, 0, 24, name='barrel')
    # Sights.
    ny, nz, py, pz = -0.0275, 0.0165, 0.121, 0.0181
    sprism([(-0.031, 0.011), (-0.023, 0.011), (-0.023, nz + 0.0022), (-0.031, nz + 0.0022)], 0.0105, st, bevel=0.0004, name='rear_sight')
    ak_style_notch(ny, nz, 0.0049, 0.0125, st, 0.0012, 0.0012)
    sprism([(0.113, 0.011), (0.122, 0.011), (0.1215, pz), (0.117, pz)], 0.0026, st, bevel=0.0003, name='front_sight')
    # Safety lever paddle on the left of the slide, hammer with spur, slide stop.
    cy(0.0045, 0.002, (-0.0149, -0.019, 0.002), st, 'X', 20, bevel=0.0003)
    sprism([(-0.026, -0.002), (-0.012, -0.003), (-0.004, 0.006), (-0.006, 0.0085), (-0.022, 0.007), (-0.027, 0.003)], 0.0018, st,
           x=-0.0152, bevel=0.0004, name='safety')
    sprism([(-0.03, -0.006), (-0.035, -0.006), (-0.039, -0.001), (-0.039, 0.006), (-0.035, 0.0105), (-0.031, 0.009), (-0.029, 0.002)],
           0.0075, st, bevel=0.0006, name='hammer')
    for k in range(4):
        bx((0.008, 0.0007, 0.0007), (0, -0.0392, -0.0005 + k * 0.0018), P['shadow'], bevel=0, name='hammer_ridge')
    sprism([(0.018, -0.0115), (0.034, -0.0115), (0.034, -0.0075), (0.018, -0.0075)], 0.0016, st, x=-0.0137, bevel=0.0004, name='slide_stop')
    # Frame: dust cover under the slide, oval trigger guard, trigger, grip frame, one-piece checkered wrap-around grip.
    sprism([(-0.031, -0.011), (0.1, -0.011), (0.1, -0.0175), (0.08, -0.019), (0.02, -0.021), (-0.031, -0.02)], 0.0258, st, bevel=0.0016, name='frame')
    tg = []
    for k in range(25):
        a = math.pi * k / 24
        tg.append((0.0505 + 0.0295 * math.cos(a), -0.018 - 0.032 * math.sin(a) ** 0.55))
    loft_path(tg, se(0.0085, 0.0034, 4, 16), st, 'trigger_guard')
    loft_path([(0.051, -0.017), (0.054, -0.027), (0.052, -0.037), (0.045, -0.044)],
              [se(0.0065, 0.0048, 3, 12), se(0.006, 0.0042, 3, 12), se(0.0055, 0.0036, 3, 12), se(0.0045, 0.003, 3, 12)], st, 'trigger')
    gtop, gbot = (-0.0085, -0.014), (-0.025, -0.11)
    path = [(lerp(gtop[0], gbot[0], i / 12), lerp(gtop[1], gbot[1], i / 12)) for i in range(13)]
    loft_path(path, [se(0.0235, lerp(0.05, 0.043, i / 12), 3.6, 40) for i in range(13)], st, 'grip_frame')
    gsecs = []
    for i in range(13):
        f = i / 12
        w = 0.0305 if 0.05 < f < 0.97 else 0.027
        gsecs.append([(x, d - 0.001) for x, d in se(w, lerp(0.049, 0.042, f) - 0.002, 2.6, 48)])
    loft_path(path[1:12], gsecs[1:12], P['grip_pm'], 'grip_panel')
    for sd in (-1, 1):
        cy(0.0046, 0.0012, (sd * 0.0156, -0.0185, -0.083), P['grip_pm'], 'X', 24)
        star = []
        for k in range(10):
            a = math.pi / 2 + math.pi * k / 5
            r = 0.0036 if k % 2 == 0 else 0.0015
            star.append((-0.0185 + r * math.cos(a), -0.083 + r * math.sin(a)))
        sprism(star, 0.0009, P['grip_pm'], x=sd * 0.0163, name='star')
    tor(0.0045, 0.0011, (-0.0155, -0.03, -0.106), st, 'X', 16, 6)
    bx((0.012, 0.004, 0.009), (0, -0.0418, -0.104), st, name='heel_catch')
    b.group('mag')
    path = [(lerp(-0.008, -0.022, i / 6), lerp(-0.015, -0.106, i / 6)) for i in range(7)]
    loft_path(path, se(0.0195, 0.03, 4, 24), st, 'mag_body')
    sprism([(0.0, -0.1085), (-0.037, -0.1085), (-0.0375, -0.1115), (-0.034, -0.1135), (0.0025, -0.1135), (0.004, -0.111)], 0.0215, st, bevel=0.0012, name='mag_floor')
    b.group('body')
    gy, gz = lerp(gtop[0], gbot[0], 0.4), lerp(gtop[1], gbot[1], 0.4)
    back = 0.6
    lz = nz + 0.0013
    slope = (pz - lz) / (py - ny)
    b.E('muzzle', (0, y1 + 0.0003, 0))
    b.E('eye', (0, ny, lz))
    b.E('cheek', (0, ny - back, lz - slope * back))
    b.E('front_post', (0, py, pz))
    b.E('grip_r', (0, gy, gz))
    b.E('grip_l', (-0.013, gy - 0.002, gz - 0.01))
    b.E('eject', (0.0142, 0.043, 0.006))
    return b.finish((0, gy, gz), {'mag': (0, -0.008, -0.015)}), ['makarov']


# =================================================================== F1 grenade
def f1():
    b = Build('f1')
    P = b.P
    H, R = 0.046, 0.0278
    def rz(z):
        return max(0.0105, R * math.sqrt(max(0.0, 1 - (z / H) ** 2)))
    rings = []
    zs = [-0.0425 + 0.0835 * i / 40 for i in range(41)]
    for z in zs:
        ring = []
        for k in range(64):
            a = 2 * math.pi * k / 64
            dv = abs(((a / (2 * math.pi / 8)) % 1.0) - 0.5) * (2 * math.pi / 8) * R      # distance to the nearest vertical groove
            dh = abs((((z + 0.04) / 0.0138) % 1.0) - 0.5) * 0.0138
            g = max(math.exp(-((0.5 * (2 * math.pi / 8) * R - dv) / 0.0012) ** 2), math.exp(-((0.5 * 0.0138 - dh) / 0.0011) ** 2))
            g *= min(1.0, (0.038 - abs(z)) / 0.004) if abs(z) < 0.038 else 0.0
            r = rz(z) - 0.0022 * g
            ring.append(Vector((r * math.cos(a), r * math.sin(a), z)))
        rings.append(ring)
    loft(rings, P['olive'], 'f1_body')
    cy(0.0125, 0.003, (0, 0, -0.043), P['olive'], 'Z', 24)
    # UZRGM fuze.
    cy(0.0108, 0.006, (0, 0, 0.0435), P['grey_paint'], 'Z', 24, bevel=0.0008)
    cy(0.0092, 0.02, (0, 0, 0.056), P['grey_paint'], 'Z', 24)
    cy(0.0075, 0.008, (0, 0, 0.07), P['grey_paint'], 'Z', 20, bevel=0.001)
    bx((0.012, 0.01, 0.008), (0, -0.008, 0.071), P['grey_paint'], name='lever_hinge')
    b.group('spoon')
    pts = [(0.0, 0.0755), (-0.008, 0.0765), (-0.0125, 0.073), (-0.0125, 0.06), (-0.0135, 0.05)]
    for z in (0.04, 0.032, 0.022, 0.012, 0.0, -0.01):
        pts.append((-(rz(z) + 0.0018), z))
    loft_path(pts, se(0.011, 0.0016, 6, 12), P['grey_paint'], 'spoon')
    b.group('pin')
    cy(0.001, 0.028, (0, 0, 0.062), P['bright'], 'X', 8)
    tor(0.0115, 0.0011, (0.025, 0, 0.062), P['bright'], 'Y', 24, 6)
    b.group('body')
    b.E('grip_r', (0, 0, 0))
    b.E('fuze', (0, 0, 0.074))
    return b.finish((0, 0, 0), {'spoon': (0, -0.006, 0.073), 'pin': (0, 0, 0.062)}), ['f1']


# =================================================================== IED and its trigger phone
def phone(b, c=(0, 0, 0), rot=None, worn=False):
    """Cheap candy-bar mobile phone, long axis along Y (top +Y), keypad facing +Z, centred on c."""
    P = b.P
    objs = []
    cx, cyy, cz = c
    secs = []
    for y in (-0.055, -0.053, -0.05, 0.0, 0.05, 0.053, 0.055):
        e = min((y + 0.055) / 0.005, (0.055 - y) / 0.005, 1.0)
        secs.append((y, se(0.046 * (0.9 + 0.1 * e), 0.016 * (0.85 + 0.15 * e), 3.2, 24, 0, 0)))
    objs.append(loft_y(secs, P['plastic_g'] if not worn else P['plastic'], 'phone_body'))
    objs.append(bx((0.042, 0.06, 0.0016), (0, 0.015, 0.0076), P['plastic'], name='phone_face'))
    objs.append(bx((0.03, 0.026, 0.001), (0, 0.028, 0.0086), P['screen'], bevel=0, name='screen'))
    objs.append(bx((0.012, 0.008, 0.0016), (0, 0.006, 0.0088), P['plastic_g'], name='nav'))
    for r in range(4):
        for k in range(3):
            objs.append(bx((0.0095, 0.0055, 0.0016), ((k - 1) * 0.0115, -0.012 - r * 0.0085, 0.0084), P['plastic_g'], name='key'))
    objs.append(bx((0.008, 0.005, 0.0016), (-0.0145, 0.004, 0.0086), P['plastic_g'], name='key'))
    objs.append(bx((0.008, 0.005, 0.0016), (0.0145, 0.004, 0.0086), P['plastic_g'], name='key'))
    objs.append(cy(0.003, 0.01, (0.016, 0.059, 0.0), P['plastic'], 'Y', 10))
    M = Matrix.Translation(c) @ (rot if rot is not None else Matrix.Identity(4))
    for o in objs:
        o.data.transform(M)
    return objs


def ied():
    b = Build('ied')
    P = b.P
    R = 0.0775
    zc = R
    # 155 mm M107-type HE shell lying on its side, nose +Y (olive drab, yellow HE band, copper driving band).
    prof = [(0, -0.3), (0.072, -0.3), (0.0765, -0.296), (0.0765, -0.255)]
    prof += [(R, -0.25), (R, 0.04)]
    for i in range(1, 11):
        t = i / 10
        prof.append((0.0245 + (R - 0.0245) * math.sqrt(1 - t * t), 0.04 + 0.235 * t))
    prof += [(0.0215, 0.276), (0.0215, 0.282), (0.017, 0.282), (0.017, 0.27), (0, 0.27)]
    lathe(prof, P['olive'], 'Y', (0, 0, zc), 40, 'shell')
    htube(0.0798, 0.075, -0.245, -0.22, P['copper'], 0, zc, 40, name='driving_band')
    htube(0.0779, 0.075, 0.0, 0.03, P['yellow'], 0, zc, 40, name='he_band')
    htube(0.0612, 0.058, 0.16, 0.172, P['yellow'], 0, zc, 40, name='he_band2')
    # Explosive putty and blasting cap in the fuze well, taped.
    ball(0.02, (0, 0.285, zc), P['white'], (1, 0.8, 1), 14, 8)
    cy(0.0035, 0.05, (0.004, 0.3, zc + 0.006), P['bright'], rot=(-70, 0, 15), seg=10)
    htube(0.0225, 0.0205, 0.268, 0.286, P['tape'], 0, zc, 24, name='nose_tape')
    # Phone receiver and a 9 V battery taped on top of the shell, wires running to the cap.
    for y in (-0.13, -0.06):
        htube(R + 0.0035, R - 0.001, y - 0.012, y + 0.012, P['tape'], 0, zc, 40, name='tape_band')
    phone(b, (0, -0.095, 2 * R + 0.012), Matrix.Rotation(math.radians(8), 4, 'Y'), True)
    bx((0.026, 0.048, 0.017), (0.035, -0.12, 2 * R - 0.006), P['plastic'], (0, -28, 0), name='battery_9v')
    bx((0.02, 0.01, 0.006), (0.04, -0.093, 2 * R - 0.001), P['brass'], (0, -28, 0), name='battery_snap')
    for k, m in enumerate((P['red'], P['wire_y'])):
        dx = 0.004 * (k * 2 - 1)
        pts = [(dx, -0.04, 2 * R + 0.01), (dx + 0.01, -0.01, 2 * R + 0.012), (dx + 0.015, 0.04, 2 * R + 0.006), (dx + 0.012, 0.12, zc + 0.065),
               (dx + 0.008, 0.2, zc + 0.045), (dx + 0.006, 0.25, zc + 0.03), (dx + 0.006, 0.29, zc + 0.022), (dx + 0.004, 0.31, zc + 0.016)]
        wire(pts, 0.0016, m, 6, 'wire')
        pts2 = [(0.03 + dx, -0.11, 2 * R + 0.003), (0.05 + dx, -0.08, 2 * R - 0.01), (0.06 + dx, -0.06, 2 * R - 0.03),
                (0.005 + dx, -0.06, 2 * R + 0.012)]
        wire(pts2, 0.0014, m, 6, 'wire')
    # Command wire trailing off the back (spare) lying on the ground.
    wire([(0.06, -0.12, 2 * R - 0.02), (0.09, -0.2, R), (0.1, -0.3, 0.02), (0.14, -0.42, 0.003), (0.22, -0.5, 0.003)], 0.0016, P['red'], 6, 'wire')
    b.E('charge', (0, 0.0, zc))
    return b.finish((0, 0, 0)), ['ied']


def ied_phone():
    b = Build('ied_phone')
    phone(b)
    b.E('grip_r', (0, 0, 0))
    b.E('screen', (0, 0.028, 0.0092))
    return b.finish((0, 0, 0)), ['ied_phone']


# =================================================================== DShK(M) on a pedestal mount
def dshk():
    b = Build('dshk')
    P = b.P
    st, st2 = P['steel'], P['steel2']
    sprism([(0, -0.075), (0.46, -0.075), (0.46, 0.04), (0, 0.04)], 0.09, st2, bevel=0.004, name='receiver')
    for sd in (-1, 1):
        bx((0.004, 0.4, 0.012), (sd * 0.046, 0.23, -0.035), st2, name='side_rib')
        for y in (0.03, 0.12, 0.34, 0.43):
            rivet(y, -0.06, sd, st2, 0.004, 0.0455)
    bx((0.002, 0.08, 0.03), (-0.0455, 0.21, 0.02), P['shadow'], name='feed_opening')
    bx((0.03, 0.09, 0.002), (0, 0.22, -0.0755), P['shadow'], name='eject_chute')
    # Back plate, buffer and spade grips with the butterfly trigger.
    bx((0.104, 0.03, 0.11), (0, -0.015, -0.02), st2, bevel=0.004, name='back_plate')
    cy(0.026, 0.03, (0, -0.04, -0.02), st2, 'Y', 20, bevel=0.003)
    for sd in (-1, 1):
        bx((0.02, 0.06, 0.016), (sd * 0.052, -0.055, 0.032), st2, name='grip_arm')
        bx((0.02, 0.06, 0.016), (sd * 0.052, -0.055, -0.072), st2, name='grip_arm')
        cy(0.016, 0.104, (sd * 0.065, -0.082, -0.02), P['wood_dark'], 'Z', 16, bevel=0.003)
        cy(0.01, 0.12, (sd * 0.065, -0.082, -0.02), st2, 'Z', 12)
    bx((0.07, 0.008, 0.022), (0, -0.065, -0.02), st2, (10, 0, 0), name='butterfly_trigger')
    # Folding ladder rear sight on the receiver front.
    bx((0.04, 0.04, 0.012), (0, 0.4, 0.046), st2, name='rs_base')
    for sd in (-1, 1):
        cy_between((sd * 0.012, 0.392, 0.05), (sd * 0.012, 0.384, 0.104), 0.0025, st2, 8)
    bx((0.03, 0.006, 0.01), (0, 0.3835, 0.104), st2, name='rs_bar')
    for sd in (-1, 1):
        bx((0.007, 0.005, 0.006), (sd * 0.005, 0.383, 0.111), st2, name='rs_ear')
    # Barrel with cooling fins, carry handle, gas cylinder and block, AA ring sight, front sight, muzzle brake.
    cy(0.026, 0.56, (0, 0.74, 0), st, 'Y', 24)
    cy(0.022, 0.5, (0, 1.2, 0), st, 'Y', 24)
    for k in range(23):
        cy(0.042, 0.0035, (0, 0.475 + k * 0.0142, 0), st, 'Y', 20)
    cy(0.03, 0.02, (0, 0.47, 0), st2, 'Y', 24, bevel=0.002)
    cy(0.03, 0.03, (0, 0.86, 0), st2, 'Y', 24, bevel=0.002)
    h = loft_path([(0.84, 0.026), (0.84, 0.07), (0.86, 0.09), (0.94, 0.09), (0.96, 0.07), (0.96, 0.02)], se(0.012, 0.012, 3, 12), st2, 'handle')
    rot_y(h, 70)
    cy(0.014, 0.66, (0, 0.79, -0.052), st2, 'Y', 16)
    sprism([(1.1, -0.068), (1.14, -0.068), (1.14, 0.024), (1.1, 0.024)], 0.04, st2, bevel=0.003, name='gas_block')
    cy(0.009, 0.014, (0.024, 1.12, -0.052), st2, 'X', 14)
    cy(0.028, 0.02, (0, 1.0, 0), st2, 'Y', 24, bevel=0.002)
    # AA ring foresight folded flat on its bracket (stowed), clear of the ground-sight line.
    bx((0.03, 0.02, 0.012), (0.03, 1.0, 0.03), st2, name='aa_bracket')
    tor(0.058, 0.0025, (0.075, 1.0, 0.036), st2, 'Z', 40, 8)
    tor(0.03, 0.002, (0.075, 1.0, 0.036), st2, 'Z', 32, 8)
    for a in (0, 90):
        bx((0.116, 0.0025, 0.002), (0.075, 1.0, 0.036), st2, (0, 0, a), 0, 'aa_spoke')
    sprism([(1.33, -0.024), (1.37, -0.024), (1.37, 0.03), (1.345, 0.04), (1.33, 0.03)], 0.03, st2, bevel=0.002, name='fs_base')
    for sd in (-1, 1):
        sprism([(1.335, 0.03), (1.368, 0.03), (1.362, 0.104), (1.348, 0.104)], 0.004, st2, x=sd * 0.012, bevel=0.0008, name='fs_ear')
    bx((0.003, 0.004, 0.07), (0, 1.355, 0.065), st2, name='fs_post')
    cy(0.03, 0.016, (0, 1.458, 0), st2, 'Y', 24, bevel=0.002)
    for sd in (-1, 1):
        bx((0.07, 0.07, 0.012), (0, 1.495, sd * 0.032), st2, bevel=0.002, name='brake_bar')
    bx((0.084, 0.02, 0.084), (0, 1.525, 0), st2, bevel=0.004, name='brake_front')
    cy(0.012, 0.022, (0, 1.526, 0), P['shadow'], 'Y', 16)
    bx((0.07, 0.008, 0.07), (0, 1.49, 0), st2, bevel=0.002, name='brake_baffle')
    # Cradle (yoke): traverses with the gun about the post; trunnion pins at the pivot.
    b.group('yoke')
    bx((0.13, 0.14, 0.02), (0, 0.3, -0.155), st2, bevel=0.003, name='yoke_base')
    for sd in (-1, 1):
        sprism([(0.24, -0.165), (0.36, -0.165), (0.335, -0.02), (0.265, -0.02)], 0.012, st2, x=sd * 0.057, bevel=0.002, name='yoke_arm')
        cy(0.014, 0.02, (sd * 0.067, 0.3, -0.035), st2, 'X', 16, bevel=0.002)
    cy(0.045, 0.04, (0, 0.3, -0.185), st2, 'Z', 24, bevel=0.003)
    bx((0.06, 0.02, 0.02), (0.06, 0.3, -0.185), st2, name='traverse_lock')
    cy(0.006, 0.05, (0.1, 0.3, -0.185), st2, 'X', 10)
    # Pedestal post and base plate (bolted to the truck bed).
    b.group('mount')
    cy(0.035, 0.75, (0, 0.3, -0.58), st2, 'Z', 20)
    cy(0.05, 0.03, (0, 0.3, -0.215), st2, 'Z', 24, bevel=0.003)
    cy(0.17, 0.016, (0, 0.3, -0.947), st2, 'Z', 32, bevel=0.003)
    for k in range(4):
        g = sprism([(0.035, -0.94), (0.16, -0.94), (0.035, -0.78)], 0.01, st2, bevel=0.002, name='gusset')
        g.data.transform(Matrix.Translation((0, 0.3, 0)) @ Matrix.Rotation(math.radians(90 * k + 45), 4, 'Z') @ Matrix.Rotation(math.radians(-90), 4, 'Z'))
    for k in range(4):
        a = math.radians(90 * k)
        cy(0.012, 0.01, (0.14 * math.cos(a), 0.3 + 0.14 * math.sin(a), -0.936), st2, 'Z', 6)
    # Feed cover (hinged at the front) with the slide-feed lever.
    b.group('cover')
    sprism([(0.08, 0.04), (0.34, 0.04), (0.34, 0.066), (0.31, 0.078), (0.1, 0.078), (0.08, 0.06)], 0.096, st2, bevel=0.003, name='feed_cover')
    sprism([(0.12, 0.078), (0.3, 0.078), (0.28, 0.096), (0.14, 0.092)], 0.016, st2, x=0.03, bevel=0.002, name='feed_lever')
    bx((0.04, 0.014, 0.016), (0, 0.09, 0.07), st2, name='cover_latch')
    cy(0.007, 0.1, (0, 0.335, 0.05), st2, 'X', 12)
    # 50-round belt box on the left bracket and the belt into the feed opening.
    b.group('box')
    bx((0.045, 0.06, 0.012), (-0.07, 0.21, -0.07), st2, name='box_bracket')
    bc = (-0.15, 0.21, -0.075)
    bx((0.11, 0.3, 0.19), bc, P['olive_dk'], bevel=0.005, name='belt_box')
    bx((0.114, 0.304, 0.014), (bc[0], bc[1], bc[2] + 0.096), P['olive_dk'], bevel=0.003, name='box_lid')
    for yy in (0.1, 0.32):
        bx((0.114, 0.014, 0.17), (bc[0], yy, bc[2]), P['olive_dk'], bevel=0.003, name='box_rib')
    tor(0.035, 0.004, (bc[0], bc[1], bc[2] + 0.105), st2, 'X', 16, 6, arc=180, rot=(0, 90, 90))
    for x, z in [(-0.13, 0.03), (-0.112, 0.036), (-0.094, 0.038), (-0.076, 0.036), (-0.06, 0.03)]:
        cartridge(b, 0.15, x, z, 0.108, 0.0105, 0.045, P['brass'], P['copper'], 12)
        bx((0.014, 0.02, 0.022), (x, 0.17, z), st2, bevel=0.001, name='link')
    b.group('body')
    grip = (0.065, -0.082, -0.02)
    b.E('muzzle', (0, 1.535, 0))
    b.E('eye', (0, 0.3835, 0.111))
    b.E('cheek', (0, 0.3835 - 0.32, 0.111 + 0.011 / 0.97 * 0.32))
    b.E('front_post', (0, 1.355, 0.1))
    b.E('grip_r', grip)
    b.E('grip_l', (-0.065, -0.082, -0.02))
    b.E('eject', (0, 0.22, -0.076))
    b.E('pivot', (0, 0.3, -0.035))
    b.E('base', (0, 0.3, -0.955))
    return b.finish(grip, {'cover': (0, 0.335, 0.05), 'box': (-0.07, 0.21, -0.064), 'yoke': (0, 0.3, -0.165), 'mount': (0, 0.3, -0.955)}), ['dshk']


# =================================================================== SPG-9 on its tripod
def spg9():
    b = Build('spg9')
    P = b.P
    ol, st = P['olive'], P['steel2']
    zt = 0.085  # bore axis above the trunnion pivot
    outer = [(0.05, 1.1), (0.05, 1.075), (0.044, 1.068), (0.044, 0.25), (0.05, 0.2), (0.05, -0.25), (0.056, -0.45), (0.074, -0.52), (0.075, -0.85),
             (0.066, -0.87), (0.07, -0.875), (0.07, -0.905), (0.06, -0.915), (0.066, -0.95), (0.08, -0.995), (0.084, -1.01)]
    inner = [(0.079, -1.01), (0.062, -0.96), (0.048, -0.92), (0.04, -0.88), (0.0365, -0.85), (0.0365, 1.1)]
    lathe(outer + inner, ol, 'Y', (0, 0, zt), 36, 'tube', closed=True)
    for y in (0.6, 0.0, -0.3):
        htube(0.053 if y > -0.1 else 0.06, 0.04, y - 0.01, y + 0.01, ol, 0, zt, 36, name='tube_band')
    bx((0.02, 0.1, 0.02), (0.075, -0.93, zt), st, name='breech_handle_arm')
    cy(0.012, 0.06, (0.11, -0.95, zt), P['rubber'], 'Z', 12)
    bx((0.03, 0.04, 0.04), (0.066, -0.89, zt), st, name='breech_hinge')
    # Cradle with trunnions, elevating arc, firing mechanism with handle and trigger under the tube.
    htube(0.064, 0.05, -0.22, 0.2, ol, 0, zt, 36, name='cradle')
    sprism([(-0.2, 0.02), (0.18, 0.02), (0.15, -0.03), (-0.17, -0.03)], 0.06, ol, bevel=0.004, name='cradle_bottom')
    for sd in (-1, 1):
        cy(0.022, 0.03, (sd * 0.075, 0, 0), st, 'X', 20, bevel=0.002)
    bx((0.03, 0.12, 0.05), (0, -0.33, zt - 0.06), ol, bevel=0.004, name='firing_housing')
    gpath = ak_grip(b, P['plum_poly'], top=(-0.33, zt - 0.08), bot=(-0.36, zt - 0.19))
    loft_path([(-0.29, zt - 0.085), (-0.292, zt - 0.1), (-0.302, zt - 0.11), (-0.33, zt - 0.11), (-0.336, zt - 0.09)], se(0.01, 0.003, 6, 12), st, 'trigger_guard')
    loft_path([(-0.306, zt - 0.085), (-0.304, zt - 0.095), (-0.308, zt - 0.104)], se(0.006, 0.004, 3, 10), st, 'trigger')
    # PGO-9 sight on the left bracket.
    sx, sz = -0.13, zt + 0.07
    bx((0.07, 0.05, 0.02), (-0.08, -0.12, zt + 0.02), ol, bevel=0.003, name='sight_bracket')
    xprism(se(0.05, 0.08, 4, 24, sx, sz), -0.2, -0.06, P['olive_dk'], 'pgo9_body')
    xprism(se(0.044, 0.05, 4, 24, sx, sz + 0.005), -0.06, -0.04, P['olive_dk'], 'pgo9_head')
    bx((0.036, 0.002, 0.032), (sx, -0.039, sz + 0.005), P['glass'], bevel=0, name='pgo9_window')
    cy(0.016, 0.04, (sx, -0.22, sz), P['olive_dk'], 'Y', 20)
    lathe([(0.011, -0.285), (0.022, -0.285), (0.022, -0.275), (0.018, -0.245), (0.016, -0.24), (0.011, -0.24)], P['rubber'], 'Y', (sx, 0, sz), 24, 'eyecup')
    cy(0.012, 0.002, (sx, -0.243, sz), P['glass'], 'Y', 16)
    cy(0.012, 0.02, (sx, -0.12, sz + 0.05), P['olive_dk'], 'Z', 20, bevel=0.001)
    cy(0.012, 0.02, (sx - 0.034, -0.12, sz), P['olive_dk'], 'X', 20, bevel=0.001)
    # Tripod (static): head, traverse bearing, elevating screw and handwheels, three legs with feet.
    b.group('mount')
    cy(0.06, 0.05, (0, 0, -0.1), ol, 'Z', 28, bevel=0.004)
    bx((0.2, 0.12, 0.03), (0, 0, -0.06), ol, bevel=0.004, name='head_plate')
    for sd in (-1, 1):
        sprism([(-0.07, -0.05), (0.07, -0.05), (0.04, 0.025), (-0.04, 0.025)], 0.014, ol, x=sd * 0.095, bevel=0.003, name='yoke_cheek')
    cy(0.012, 0.16, (0, -0.16, -0.04), st, rot=(-60, 0, 0), seg=12)
    tor(0.05, 0.005, (0.13, -0.08, -0.08), st, 'X', 24, 8)
    cy(0.008, 0.04, (0.15, -0.08, -0.13), P['rubber'], 'X', 10)
    tor(0.045, 0.005, (-0.13, -0.08, -0.08), st, 'X', 24, 8)
    ground = -0.64
    feet = [(0.0, 0.62), (-0.48, -0.42), (0.48, -0.42)]
    for fx, fy in feet:
        cy_between((fx * 0.08, fy * 0.08, -0.12), (fx, fy, ground + 0.02), 0.02, ol, 14)
        cy_between((fx * 0.5, fy * 0.5, -0.38), (fx * 0.5 + 0.0, fy * 0.5, -0.32), 0.026, st, 14)
        bx((0.07, 0.09, 0.012), (fx, fy, ground + 0.006), st, (0, 0, math.degrees(math.atan2(fx, fy))), 0.002, 'foot')
        bx((0.006, 0.06, 0.05), (fx, fy, ground - 0.015), st, (0, 0, math.degrees(math.atan2(fx, fy))), 0.001, 'spade')
    b.group('body')
    b.E('pivot', (0, 0, 0))
    b.E('muzzle', (0, 1.1, zt))
    b.E('eye', (sx, -0.285, sz))
    b.E('cheek', (sx, -0.355, sz))
    gy, gz = path_point(gpath, 0.42)
    b.E('grip_r', (0, gy, gz))
    b.E('grip_l', (0.15, -0.08, -0.1))
    b.E('backblast', (0, -1.01, zt))
    b.E('base', (0, 0, ground))
    return b.finish((0, 0, 0), {'mount': (0, 0, 0)}), ['spg9']


# =================================================================== driver
BUILDERS = {
    'akm': lambda: ak_family('akm'),
    'ak47': lambda: ak_family('ak47'),
    'aks74u': lambda: ak_family('aks74u'),
    'rpk': lambda: ak_family('rpk'),
    'pkm': pkm,
    'svd': svd,
    'rpg7': rpg7,
    'pg7v': pg7v,
    'makarov': makarov,
    'f1': f1,
    'ied': ied,
    'ied_phone': ied_phone,
    'dshk': dshk,
    'spg9': spg9,
}


def main():
    os.makedirs(OUT, exist_ok=True)
    if PREV:
        os.makedirs(PREV, exist_ok=True)
    for wid, fn in BUILDERS.items():
        if ONLY and wid not in ONLY:
            continue
        t0 = time.time()
        root, names = fn()
        r = bpy.data.objects[names[0]]
        if not NOBAKE:
            tb = time.time()
            bake_weapon(r, TEX or (512 if wid in SMALL else 1024))
            print(f'[weapons_ins] {wid}: baked in {time.time() - tb:.1f}s')
        path = os.path.join(OUT, f'{wid}.glb')
        export_glb(path, names)
        r = bpy.data.objects[names[0]]
        print(f'[weapons_ins] {wid}: {tri_count(r)} tris -> {path} ({time.time() - t0:.1f}s)')
        if PREV:
            render_views(r, PREV, views=VIEWS)
        if FP:
            os.makedirs(FP, exist_ok=True)
            render_views(r, FP, views=('fp',))


main()

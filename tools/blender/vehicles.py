"""Build the vehicles (and their wrecks) from code and export them as GLB.
    ~/blender-4.5.13-linux-x64/blender -b --factory-startup --python tools/blender/vehicles.py -- public/models/vehicles \
        [--preview tools/blender/previews] [--only m1114]
Contract (CLAUDE.md "Vehicles"): root <id>, +Y forward, origin on the ground at the wheelbase centre, wheels wheel_fl/fr/rl/rr
(origin at the wheel centre, axle along X), seat empties at the occupants' eye points, exit_l/exit_r on the ground beside
the doors, turret (traverse about Z, origin at the ring/swivel centre) > gun (pitch about X, origin at the trunnion) > muzzle,
turret_eye (child of turret). Main hull mesh `body`, windows `glass` (material `glass`).
Dimensions follow published overall figures (length, width, height, wheelbase, tyre size); detail is approximate."""
import os, sys, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy
from mathutils import Vector, Matrix
from common import reset, clear_mats, box, cyl, tube_y, empty, preview, attach
from vcommon import (plate, sp, xz_prism, xy_prism, bev, bake, boolean, dup, kill, smooth, set_mat, group, strut, pipe,
                     round_poly, offset_poly, MB, T, R, S, AX_Y, AX_Z, pmat, reset_cache, grime_image, auto_uv,
                     tri_count, vexport, desel, limit_tris)

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = argv[0] if argv else 'public/models/vehicles'
PREV = argv[argv.index('--preview') + 1] if '--preview' in argv else None
ONLY = argv[argv.index('--only') + 1].split(',') if '--only' in argv else None
VIEWS = argv[argv.index('--views') + 1].split(',') if '--views' in argv else ['front', 'side', 'rear']
NOPREV = '--noprev' in argv

def lin(r, g, b):
    """sRGB 0-255 to linear."""
    f = lambda c: ((c / 255 + 0.055) / 1.055) ** 2.4 if c / 255 > 0.04045 else c / 255 / 12.92
    return (f(r), f(g), f(b))

def common_mats():
    return dict(
        glass=pmat('glass', (0.045, 0.07, 0.055), 0.04, 0.0, alpha=0.42, cull=True),
        rubber=pmat('tyre_rubber', (0.032, 0.03, 0.028), 0.9),
        black=pmat('black_plastic', (0.018, 0.018, 0.018), 0.55),
        dark=pmat('dark_metal', (0.035, 0.034, 0.032), 0.6, 0.5),
        steel=pmat('gun_steel', (0.03, 0.03, 0.03), 0.42, 0.85),
        parked=pmat('parkerized', (0.045, 0.045, 0.042), 0.62, 0.7),
        chrome=pmat('chrome', (0.75, 0.75, 0.75), 0.12, 1.0),
        lens=pmat('lens_clear', (0.42, 0.44, 0.45), 0.04, 0.3),
        red=pmat('lens_red', (0.35, 0.01, 0.01), 0.15),
        amber=pmat('lens_amber', (0.6, 0.22, 0.01), 0.15),
        brass=pmat('brass', (0.5, 0.34, 0.1), 0.35, 1.0),
        under=pmat('underbody', (0.06, 0.05, 0.04), 0.9),
        rust=pmat('rust', (0.14, 0.05, 0.018), 0.9, 0.2),
        char=pmat('char', (0.02, 0.018, 0.016), 0.95),
        od=pmat('olive_drab', lin(78, 82, 54), 0.7),
        canvas=pmat('seat_canvas', lin(52, 50, 38), 0.95),
        wood=pmat('grip_wood', lin(60, 38, 22), 0.6),
        dshk_box=pmat('dshk_green', lin(62, 70, 52), 0.65, 0.3),
    )

# ------------------------------------------------------------------ wheels
def make_wheel(name, c, s, r, w, rim_r, tyre_m, rim_m, hub_m, style='hmmwv', segs=40, lugs=True, burnt=False, nuts=8,
               rust_m=None):
    """Wheel built in place; s = +1 for a right wheel (outer face +X), -1 for a left wheel. Origin at the centre."""
    mb = MB()
    M0 = T(*c) @ S(s, 1, 1)
    hw = w / 2
    lug_h = 0.02 if lugs else 0.0
    R0 = r - lug_h
    sh = R0 - rim_r
    if not burnt:
        if style == 'hmmwv' or lugs:
            tread = [(R0, -hw * 0.8), (R0, hw * 0.8)]
        else:  # road tyre: two circumferential grooves
            g = 0.007
            tread = [(R0, -hw * 0.82), (R0, -hw * 0.36), (R0 - g, -hw * 0.34), (R0 - g, -hw * 0.2), (R0, -hw * 0.18),
                     (R0, hw * 0.18), (R0 - g, hw * 0.2), (R0 - g, hw * 0.34), (R0, hw * 0.36), (R0, hw * 0.82)]
        prof = [(rim_r - 0.004, -hw * 0.8), (rim_r + sh * 0.25, -hw * 0.96), (rim_r + sh * 0.62, -hw),
                (R0 - sh * 0.1, -hw * 0.95)] + tread + [(R0 - sh * 0.1, hw * 0.95), (rim_r + sh * 0.62, hw),
                (rim_r + sh * 0.25, hw * 0.96), (rim_r - 0.004, hw * 0.8)]
        mb.lathe(prof, segs, M0, tyre_m, closed=True)
        if lugs:
            n = 20 if r > 0.4 else 18
            pitch = 2 * math.pi * R0 / n
            for i in range(n):
                for row in (-1, 1):
                    th = 360.0 * (i + (0.5 if row < 0 else 0)) / n
                    a = row * hw * 0.45
                    M = M0 @ R('X', th) @ T(a, 0, R0 + lug_h / 2 - 0.004) @ R('Z', row * 14) @ S(hw * 0.86, pitch * 0.52, lug_h + 0.008)
                    mb.box(M, tyre_m)
                    # shoulder block running down the sidewall
                    M = M0 @ R('X', th) @ T(row * hw * 0.93, 0, R0 - 0.03) @ S(0.03, pitch * 0.42, 0.07)
                    mb.box(M, tyre_m)
    else:
        # Burnt off: only the steel-belt and bead wires remain, sagging onto the rim.
        rr = rim_r + 0.03
        mb.lathe([(rr, -hw * 0.7), (rr + 0.012, -hw * 0.6), (rr + 0.012, hw * 0.6), (rr, hw * 0.7)], segs, M0, rust_m or rim_m, closed=True)
    # Rim barrel and flanges.
    mb.lathe([(rim_r + 0.012, -hw * 0.86), (rim_r + 0.012, -hw * 0.78), (rim_r, -hw * 0.74), (rim_r, hw * 0.74),
              (rim_r + 0.012, hw * 0.78), (rim_r + 0.012, hw * 0.86), (rim_r - 0.012, hw * 0.86),
              (rim_r - 0.012, -hw * 0.86)], segs, M0, rim_m, closed=True)
    if style == 'hmmwv':
        # Two-piece beadlock rim: bolt ring, dished centre, raised hub with eight nuts, hub cap.
        mb.lathe([(rim_r - 0.012, hw * 0.66), (rim_r * 0.58, hw * 0.48), (rim_r * 0.58, hw * 0.4), (rim_r - 0.012, hw * 0.56)],
                 segs, M0, rim_m, closed=True)
        for k in range(10):
            th = 360 * k / 10
            mb.cyl(0.008, 0.03, 6, M0 @ R('X', th) @ T(hw * 0.86, 0, rim_r - 0.004), hub_m)
        mb.lathe([(rim_r * 0.58, hw * 0.44), (rim_r * 0.52, hw * 0.62), (rim_r * 0.36, hw * 0.66), (rim_r * 0.3, hw * 0.92),
                  (0.0001, hw * 0.98)], segs, M0, rim_m, cap0=False)
        for k in range(nuts):
            th = 360 * k / nuts + 11
            mb.cyl(0.014, 0.05, 6, M0 @ R('X', th) @ T(hw * 0.62, 0, rim_r * 0.45), hub_m)
        mb.cyl(0.04, 0.05, 12, M0 @ T(hw * 0.98, 0, 0), hub_m)
    elif style == 'steel':
        # Pressed steel wheel: dished centre, vent holes, nuts, small cap.
        mb.lathe([(rim_r - 0.012, hw * 0.3), (rim_r * 0.7, hw * 0.42), (rim_r * 0.42, hw * 0.62), (rim_r * 0.42, hw * 0.55),
                  (rim_r * 0.7, hw * 0.35), (rim_r - 0.012, hw * 0.22)], segs, M0, rim_m, closed=True)
        mb.lathe([(rim_r * 0.42, hw * 0.6), (rim_r * 0.2, hw * 0.66), (0.0001, hw * 0.72)], max(12, segs // 2), M0, rim_m)
        for k in range(6):
            th = 360 * k / 6 + 30
            mb.cyl(0.03, 0.01, 10, M0 @ R('X', th) @ T(hw * 0.4, 0, rim_r * 0.72), hub_m)   # dark vent hole
            th2 = th + 30
            mb.cyl(0.011, 0.04, 6, M0 @ R('X', th2) @ T(hw * 0.66, 0, rim_r * 0.3), hub_m)
        mb.cyl(0.045, 0.05, 14, M0 @ T(hw * 0.72, 0, 0), rim_m)
    elif style == 'hubcap':
        mb.lathe([(rim_r - 0.012, hw * 0.3), (rim_r * 0.72, hw * 0.4), (rim_r * 0.72, hw * 0.3), (rim_r - 0.012, hw * 0.2)],
                 segs, M0, rim_m, closed=True)
        mb.lathe([(rim_r * 0.86, hw * 0.55), (rim_r * 0.78, hw * 0.7), (rim_r * 0.4, hw * 0.78), (rim_r * 0.2, hw * 0.86),
                  (0.0001, hw * 0.88)], segs, M0, hub_m)
        for k in range(10):
            th = 360 * k / 10
            mb.box(M0 @ R('X', th) @ T(hw * 0.72, 0, rim_r * 0.6) @ S(0.012, 0.025, rim_r * 0.3), rim_m)
    o = mb.obj(name, c)
    return o

# ------------------------------------------------------------------ guns
def build_m2(tx, ty, tz, P, GU):
    """M2HB on a cradle; bore at tz + 0.08, trunnion at (tx, ty, tz). Appends parts to GU and returns the muzzle point."""
    zb = tz + 0.08
    st, pk = P['steel'], P['parked']
    GU.append(box((0.15, 0.52, 0.17), (tx, ty - 0.14, zb - 0.005), pk, bevel=0.006))                       # receiver
    GU.append(box((0.165, 0.09, 0.15), (tx, ty + 0.115, zb - 0.01), pk, bevel=0.006))                      # front trunnion block
    GU.append(box((0.158, 0.30, 0.035), (tx, ty - 0.02, zb + 0.09), pk, bevel=0.008))                      # feed cover
    GU.append(box((0.05, 0.05, 0.02), (tx, ty + 0.12, zb + 0.105), st, bevel=0.004))                       # cover latch
    for sx in (-1, 1):
        for k in range(4):                                                                                  # side plate rivets
            GU.append(cyl(0.006, 0.01, (tx + sx * 0.077, ty - 0.33 + k * 0.1, zb + 0.04), st, rot=(0, 90, 0), verts=6))
    GU.append(box((0.02, 0.03, 0.07), (tx, ty - 0.33, zb + 0.11), st, bevel=0.003))                        # rear sight leaf
    GU.append(box((0.17, 0.04, 0.16), (tx, ty - 0.42, zb - 0.01), pk, bevel=0.008))                        # back plate
    for sx in (-1, 1):
        GU.append(box((0.022, 0.1, 0.022), (tx + sx * 0.06, ty - 0.47, zb + 0.05), pk, bevel=0.004))
        GU.append(box((0.022, 0.1, 0.022), (tx + sx * 0.06, ty - 0.47, zb - 0.07), pk, bevel=0.004))
        GU.append(cyl(0.018, 0.15, (tx + sx * 0.06, ty - 0.52, zb - 0.01), P['black'], rot=(-12, 0, 0), verts=10))   # spade grips
    GU.append(box((0.07, 0.02, 0.05), (tx, ty - 0.455, zb - 0.01), st, bevel=0.004))                       # butterfly trigger
    GU.append(box((0.03, 0.06, 0.025), (tx + 0.09, ty - 0.12, zb - 0.02), st, bevel=0.004))                # retracting slide
    GU.append(strut((tx + 0.09, ty - 0.12, zb - 0.02), (tx + 0.13, ty - 0.17, zb - 0.0), 0.015, 0.015, st))
    # Perforated barrel support with carrying handle, barrel, flash hider.
    GU.append(tube_y(0.042, 0.18, ty + 0.12, tx, zb, pk, verts=18))
    for k in range(3):
        for a in (-50, 0, 50):
            p = Vector((tx + 0.043 * math.sin(math.radians(a)), ty + 0.16 + k * 0.05, zb + 0.043 * math.cos(math.radians(a))))
            GU.append(cyl(0.011, 0.004, tuple(p), P['black'], rot=(0, a, 0), verts=8))
    GU.append(tube_y(0.032, 0.78, ty + 0.3, tx, zb, st, r2=0.027, verts=16))
    GU.append(tube_y(0.031, 0.04, ty + 0.3, tx, zb, st, verts=16))
    GU.append(tube_y(0.026, 0.08, ty + 1.08, tx, zb, st, r2=0.034, verts=16))
    GU.append(tube_y(0.022, 0.012, ty + 1.148, tx, zb, P['black'], verts=16))
    GU.append(pipe(round_poly([(tx, ty + 0.36, zb + 0.03), (tx, ty + 0.36, zb + 0.1), (tx, ty + 0.5, zb + 0.1), (tx, ty + 0.5, zb + 0.03)], 0.03), 0.009, st, 6))
    GU.append(box((0.008, 0.015, 0.05), (tx, ty + 0.28, zb + 0.065), st, bevel=0.002))                    # front sight
    # Cradle (MK93-style) and ammunition can on its tray (left side), belt into the feedway.
    GU.append(box((0.2, 0.34, 0.03), (tx, ty - 0.02, tz - 0.035), P['dark'], bevel=0.005))
    for sx in (-1, 1):
        GU.append(box((0.02, 0.14, 0.12), (tx + sx * 0.09, ty + 0.02, tz + 0.01), P['dark'], bevel=0.004))
    GU.append(box((0.2, 0.3, 0.02), (tx - 0.2, ty - 0.02, tz - 0.07), P['dark'], bevel=0.004))
    GU.append(box((0.13, 0.29, 0.19), (tx - 0.21, ty - 0.02, tz + 0.035), P['od'], bevel=0.008))           # M2A1 can
    GU.append(box((0.135, 0.295, 0.02), (tx - 0.21, ty - 0.02, tz + 0.13), P['od'], bevel=0.004))
    GU.append(box((0.02, 0.1, 0.012), (tx - 0.21, ty - 0.02, tz + 0.145), P['black'], bevel=0.003))
    GU.append(strut((tx - 0.2, ty + 0.01, tz + 0.14), (tx - 0.08, ty + 0.01, zb + 0.01), 0.1, 0.022, P['brass'], out=(0, 0, 1)))
    return (tx, ty + 1.16, zb)

def build_dshk(tx, ty, tz, P, GU):
    """DShKM: finned barrel, big muzzle brake, gas tube below, spade grips, ladder sight, belt box on the left."""
    zb = tz + 0.08
    st, pk = P['steel'], P['parked']
    GU.append(box((0.12, 0.5, 0.15), (tx, ty - 0.12, zb - 0.01), pk, bevel=0.006))                         # receiver
    GU.append(box((0.135, 0.3, 0.05), (tx, ty - 0.06, zb + 0.08), pk, bevel=0.012))                        # feed cover
    GU.append(box((0.03, 0.25, 0.02), (tx + 0.05, ty - 0.05, zb + 0.115), st, bevel=0.004))                # feed lever arm
    GU.append(box((0.13, 0.05, 0.16), (tx, ty - 0.38, zb - 0.01), pk, bevel=0.008))                        # back plate
    for sx in (-1, 1):
        GU.append(box((0.02, 0.09, 0.02), (tx + sx * 0.055, ty - 0.43, zb + 0.05), pk, bevel=0.003))
        GU.append(box((0.02, 0.09, 0.02), (tx + sx * 0.055, ty - 0.43, zb - 0.07), pk, bevel=0.003))
        GU.append(cyl(0.017, 0.15, (tx + sx * 0.055, ty - 0.48, zb - 0.01), P['wood'], rot=(-10, 0, 0), verts=10))
    GU.append(box((0.06, 0.02, 0.045), (tx, ty - 0.415, zb - 0.01), st, bevel=0.003))
    # Ladder (frame) rear sight, raised.
    for sx in (-1, 1):
        GU.append(box((0.006, 0.012, 0.09), (tx + sx * 0.02, ty + 0.08, zb + 0.15), st, bevel=0.0))
    GU.append(box((0.046, 0.012, 0.008), (tx, ty + 0.08, zb + 0.195), st, bevel=0.0))
    GU.append(box((0.046, 0.012, 0.008), (tx, ty + 0.08, zb + 0.13), st, bevel=0.0))
    GU.append(box((0.05, 0.05, 0.03), (tx, ty + 0.08, zb + 0.1), pk, bevel=0.004))
    # Barrel: plain section, cooling fins, plain to the brake.
    GU.append(tube_y(0.03, 0.95, ty + 0.13, tx, zb, st, r2=0.024, verts=16))
    for k in range(16):
        GU.append(tube_y(0.047, 0.008, ty + 0.2 + k * 0.026, tx, zb, st, verts=16))
    GU.append(tube_y(0.034, 0.03, ty + 0.13, tx, zb, pk, verts=16))
    # Gas cylinder under the barrel with the gas block.
    GU.append(tube_y(0.016, 0.62, ty + 0.13, tx, zb - 0.06, pk, verts=10))
    GU.append(box((0.04, 0.05, 0.08), (tx, ty + 0.76, zb - 0.035), pk, bevel=0.005))
    GU.append(box((0.008, 0.015, 0.07), (tx, ty + 0.98, zb + 0.06), st, bevel=0.002))                     # front sight post
    GU.append(box((0.03, 0.03, 0.03), (tx, ty + 0.98, zb + 0.03), st, bevel=0.003))
    GU.append(pipe(round_poly([(tx, ty + 0.62, zb + 0.03), (tx, ty + 0.62, zb + 0.1), (tx, ty + 0.72, zb + 0.1), (tx, ty + 0.72, zb + 0.03)], 0.03), 0.009, st, 6))
    # Muzzle brake (DShKM flat multi-baffle type).
    GU.append(tube_y(0.044, 0.15, ty + 1.08, tx, zb, st, verts=16))
    for k in range(3):
        for sx in (-1, 1):
            GU.append(box((0.012, 0.025, 0.05), (tx + sx * 0.04, ty + 1.11 + k * 0.04, zb), P['black'], bevel=0.0))
    GU.append(tube_y(0.02, 0.005, ty + 1.229, tx, zb, P['black'], verts=12))
    # Cradle and belt box on the left with the belt.
    GU.append(box((0.17, 0.3, 0.03), (tx, ty - 0.05, tz - 0.04), P['dark'], bevel=0.005))
    for sx in (-1, 1):
        GU.append(box((0.02, 0.12, 0.11), (tx + sx * 0.075, ty, tz + 0.0), P['dark'], bevel=0.004))
    GU.append(box((0.13, 0.32, 0.24), (tx - 0.2, ty - 0.08, tz + 0.03), P['dshk_box'], bevel=0.008))
    GU.append(box((0.135, 0.325, 0.02), (tx - 0.2, ty - 0.08, tz + 0.15), P['dshk_box'], bevel=0.004))
    GU.append(box((0.18, 0.12, 0.02), (tx - 0.12, ty - 0.08, tz - 0.08), P['dark'], bevel=0.003))
    GU.append(strut((tx - 0.19, ty - 0.03, tz + 0.155), (tx - 0.06, ty - 0.03, zb + 0.02), 0.11, 0.024, P['brass'], out=(0, 0, 1)))
    return (tx, ty + 1.235, zb)

# ------------------------------------------------------------------ M1114 up-armoured HMMWV
def build_m1114(wreck=False):
    vid = 'm1114_wreck' if wreck else 'm1114'
    P = common_mats()
    H, Wd = 1.95, 2.3
    if wreck:
        img = grime_image('char_tex', lin(184, 162, 124), 1024, 11, char=True)
        paint = pmat('paint_burnt', (1, 1, 1), 0.92, 0.1, img=img)
        tan_plain = pmat('char_plain', (0.03, 0.025, 0.02), 0.95)
        P['canvas'] = P['char']; P['od'] = P['char']
        P['lens'] = P['amber'] = P['red'] = pmat('lens_burnt', (0.03, 0.03, 0.03), 0.3)
        P['chrome'] = P['dark']
        tyre_m, rim_m = P['rust'], pmat('rim_burnt', (0.06, 0.04, 0.03), 0.9, 0.3)
    else:
        img = grime_image('tan_686a', lin(184, 162, 124), 1024, 3, dirt=lin(96, 78, 56), dust=lin(200, 184, 152),
                          dirt_amt=0.9, dust_amt=0.4)
        paint = pmat('carc_tan_686a', (1, 1, 1), 0.76, 0.0, img=img)
        tan_plain = pmat('carc_tan_plain', lin(170, 150, 114), 0.8)
        tyre_m, rim_m = P['rubber'], tan_plain
    B, G, TU, TG, GU = [], [], [], [], []
    YF, YR, WX, WR, WW = 1.65, -1.65, 0.91, 0.47, 0.32
    yr = -0.30                      # ring centre
    ZROOF = 1.905

    # ---- front clip (hood, fenders, grille; tilts forward as one piece on the real vehicle)
    fc_prof = [(0.90, 0.66), (2.30, 0.66), (2.40, 0.70), (2.25, 1.12), (2.19, 1.18), (2.08, 1.205), (1.5, 1.22), (0.90, 1.235)]
    fc = sp(fc_prof, 2.16, paint, 0, 0, 'front_clip')
    fview = [(-1.08, 0.5), (1.08, 0.5), (1.08, 1.15), (1.065, 1.195), (1.02, 1.225), (0.9, 1.245), (-0.9, 1.245), (-1.02, 1.225), (-1.065, 1.195), (-1.08, 1.15)]
    boolean(fc, xz_prism(fview, 0.8, 2.5), 'INTERSECT')
    phi = math.atan2(0.15, 0.42)
    phd = math.degrees(phi)
    def fpt(x, z, n=0.0):
        return (x, 2.40 - (z - 0.70) * math.tan(phi) + n * math.cos(phi), z + n * math.sin(phi))
    # Grille: thirteen vertical slots punched in the sloped nose, radiator behind.
    slots = [box((0.042, 0.14, 0.3), fpt(-0.42 + i * 0.07, 0.92), None, rot=(phd, 0, 0), bevel=0) for i in range(13)]
    cutter = group('slot_cut', slots)
    # Headlight recesses.
    hl = [cyl(0.105, 0.12, fpt(sx * 0.71, 0.9), None, rot=(phd - 90, 0, 0), verts=24) for sx in (-1, 1)]
    for o in hl:
        bake(o)
    boolean(fc, [cutter] + hl)
    bev(fc, 0.025, 2)
    B.append(fc)
    B.append(box((0.94, 0.01, 0.34), fpt(0, 0.92, -0.05), P['black'], rot=(phd, 0, 0), bevel=0))
    for sx in (-1, 1):
        x = sx * 0.71
        B.append(cyl(0.09, 0.02, fpt(x, 0.9, -0.04), P['lens'], rot=(phd - 90, 0, 0), verts=20))
        mb = MB()
        mb.lathe([(0.095, -0.01), (0.104, -0.01), (0.104, 0.01), (0.095, 0.01)], 20, Matrix.Translation(fpt(x, 0.9, -0.02)) @ R('X', phd - 90) @ AX_Z, P['chrome'], closed=True)
        B.append(mb.obj('bezel', fpt(x, 0.9)))
        B.append(box((0.09, 0.03, 0.05), fpt(x, 1.07, 0.01), P['amber'], rot=(phd, 0, 0), bevel=0.004))
        B.append(box((0.11, 0.03, 0.07), fpt(x, 1.07, 0.0), P['black'], rot=(phd, 0, 0), bevel=0.004))
        # Brush guard: tube cage over the headlight and turn signal.
        o = Vector(fpt(x, 0.96, 0))
        U = Vector((0, -math.sin(phi), math.cos(phi)))
        N = Vector((0, math.cos(phi), math.sin(phi)))
        X = Vector((1, 0, 0))
        L = lambda a, u, n: tuple(o + a * X + u * U + n * N)
        loop = [L(0, -0.17, 0.1), L(-0.15, -0.17, 0.1), L(-0.15, 0.17, 0.1), L(0.15, 0.17, 0.1), L(0.15, -0.17, 0.1), L(0.0, -0.17, 0.1)]
        B.append(pipe(round_poly(loop, 0.05), 0.012, P['dark'], 8))
        for a in (-0.15, 0.15):
            for u in (-0.17, 0.17):
                B.append(pipe([L(a, u, 0.0), L(a, u, 0.1)], 0.012, P['dark'], 8))
        for a in (-0.05, 0.05):
            B.append(pipe([L(a, -0.17, 0.1), L(a, 0.17, 0.1)], 0.009, P['dark'], 6))
        # Hood latch straps on the fender sides, side marker lights, fender top blackout light.
        B.append(box((0.02, 0.05, 0.12), (sx * 1.085, 2.08, 1.1), P['black'], bevel=0.004))
        B.append(box((0.02, 0.07, 0.04), (sx * 1.085, 2.25, 0.9), P['amber'], bevel=0.004))
    B.append(box((0.1, 0.07, 0.06), (-0.85, 2.12, 1.24), P['black'], bevel=0.008))                         # blackout drive light
    # Raised hood centre and the hood seam ahead of the windshield.
    B.append(sp([(0.98, 1.215), (2.08, 1.19), (2.13, 1.205), (2.06, 1.232), (0.98, 1.252)], 1.3, paint, 0, 0.014))
    for sx in (-1, 1):   # hood seam lines either side of the raised centre
        B.append(box((0.008, 1.05, 0.006), (sx * 0.66, 1.55, 1.238), P['black'], bevel=0))
    # Engine air intake on the right cowl.
    B.append(box((0.34, 0.28, 0.12), (0.62, 1.12, 1.28), paint, bevel=0.015))
    for k in range(5):
        B.append(box((0.3, 0.02, 0.012), (0.62, 1.01 + k * 0.05, 1.343), P['black'], bevel=0))
    # Front bumper with lifting / towing shackles.
    B.append(box((2.08, 0.13, 0.17), (0, 2.435, 0.62), P['dark'] if not wreck else P['rust'], bevel=0.012))
    for sx in (-1, 1):
        B.append(strut((sx * 0.48, 2.5, 0.56), (sx * 0.48, 2.5, 0.68), 0.02, 0.06, P['dark']))
        mb = MB()
        mb.lathe([(0.045 + 0.012 * math.cos(t * 2 * math.pi / 6), 0.012 * math.sin(t * 2 * math.pi / 6)) for t in range(6)], 14,
                 T(sx * 0.48, 2.5, 0.62), P['dark'], closed=True, a0=-90, a1=90)
        B.append(mb.obj('shackle', (sx * 0.48, 2.52, 0.62)))

    # ---- arches
    def arch_prof(yc, grow=0.0):
        g = grow
        return [(yc - 0.59 - g, 0.38), (yc - 0.51 - g, 0.98 + g * 0.6), (yc - 0.37 - g * 0.4, 1.08 + g), (yc + 0.37 + g * 0.4, 1.08 + g),
                (yc + 0.51 + g, 0.98 + g * 0.6), (yc + 0.59 + g, 0.38)]
    def arch_cut(yc):
        return [sp(arch_prof(yc), 0.75, None, sx * 0.97) for sx in (-1, 1)]
    boolean(fc, arch_cut(YF))

    # ---- cab and rear cargo shell (hollow, armoured)
    cab_prof = [(0.96, 0.6), (0.96, 1.24), (0.82, 1.88), (0.78, ZROOF), (-1.08, ZROOF), (-1.14, 1.88), (-2.40, 1.40),
                (-2.44, 1.34), (-2.44, 0.62), (-2.40, 0.60)]
    shell = sp(cab_prof, 2.3, paint, 0, 0, 'shell')
    cview = [(-1.05, 0.5), (1.05, 0.5), (1.05, 1.8), (1.035, 1.86), (0.99, 1.895), (0.95, ZROOF), (-0.95, ZROOF), (-0.99, 1.895), (-1.035, 1.86), (-1.05, 1.8)]
    boolean(shell, xz_prism(cview, -2.6, 1.1), 'INTERSECT')
    inner = sp(offset_poly(cab_prof, 0.05), 2.0, None, 0, 0)
    boolean(shell, inner)
    boolean(shell, arch_cut(YR))
    # Wheel housings closing the rear arches inside the cargo area.
    for sx in (-1, 1):
        hs = sp(arch_prof(YR, 0.05), 0.47, tan_plain, sx * 0.785)
        boolean(hs, sp(arch_prof(YR), 0.6, None, sx * 0.93))
        B.append(hs)
    # Doors: thick bolt-on armour plates; small thick windows.
    doors = []
    for sx in (-1, 1):
        doors.append(box((0.035, 0.955, 1.2), (sx * 1.066, 0.44, 1.24), paint, bevel=0))
        doors.append(box((0.035, 0.91, 1.2), (sx * 1.066, -0.52, 1.24), paint, bevel=0))
    win = [((-0.02, 0.62), (1.36, 1.78)), ((-0.9, -0.28), (1.36, 1.78))]
    wcut = []
    for sx in (-1, 1):
        for (y0, y1), (z0, z1) in win:
            wcut.append(box((0.4, y1 - y0, z1 - z0), (sx * 1.05, (y0 + y1) / 2, (z0 + z1) / 2), None, bevel=0))
            if not wreck:
                G.append(box((0.06, y1 - y0 + 0.02, z1 - z0 + 0.02), (sx * 1.035, (y0 + y1) / 2, (z0 + z1) / 2), P['glass'], bevel=0.004))
    # Windshield: two flat ballistic panes in thick frames, flat centre plate.
    psi = math.atan2(0.14, 0.64)
    psd = math.degrees(psi)
    def wpt(x, z, n=0.0):
        return (x, 0.96 - (z - 1.24) * math.tan(psi) + n * math.cos(psi), z + n * math.sin(psi))
    hz = 0.5 / math.cos(psi)
    for sx in (-1, 1):
        wcut.append(box((0.84, 0.3, hz), wpt(sx * 0.53, 1.56), None, rot=(psd, 0, 0), bevel=0))
        if not wreck:
            G.append(box((0.86, 0.07, hz + 0.02), wpt(sx * 0.53, 1.56, -0.03), P['glass'], rot=(psd, 0, 0), bevel=0.004))
        for dx, sz in ((-0.44, (0.05, 0.035, hz + 0.1)), (0.44, (0.05, 0.035, hz + 0.1))):
            B.append(box(sz, wpt(sx * 0.53 + dx, 1.56, 0.012), paint, rot=(psd, 0, 0), bevel=0.006))
        for dz in (-0.27, 0.27):
            B.append(box((0.93, 0.035, 0.05), wpt(sx * 0.53, 1.56 + dz, 0.012), paint, rot=(psd, 0, 0), bevel=0.006))
        B.append(strut(wpt(sx * 0.5 - 0.22, 1.315, 0.03), wpt(sx * 0.5 + 0.2, 1.33, 0.03), 0.02, 0.012, P['black']))  # wiper
    B.append(box((0.14, 0.03, hz + 0.08), wpt(0, 1.56, 0.012), paint, rot=(psd, 0, 0), bevel=0.006))
    for o in wcut:
        bake(o)
    for d in doors:
        boolean(d, wcut, keep=True)
    boolean(shell, wcut + [cyl(0.47, 0.3, (0, yr, 1.9), None, verts=36)])
    bev(shell, 0.012, 2)
    B.append(shell)
    for d in doors:
        bev(d, 0.012, 2)
    B.extend(doors)
    # Door hardware: hinges at the front edges, handles, combat lock plates.
    for sx in (-1, 1):
        for yd0, yd1 in ((-0.035, 0.915), (-0.975, -0.065)):
            for z in (0.9, 1.6):
                B.append(cyl(0.024, 0.14, (sx * 1.09, yd1 - 0.02, z), P['dark'] if not wreck else P['char'], verts=10))
                B.append(box((0.02, 0.12, 0.07), (sx * 1.088, yd1 - 0.09, z), paint, bevel=0.006))
            B.append(box((0.03, 0.12, 0.035), (sx * 1.095, yd0 + 0.13, 1.3), P['black'], bevel=0.008))
            B.append(box((0.012, 0.16, 0.1), (sx * 1.088, yd0 + 0.13, 1.3), paint, bevel=0.004))
        # Mirror on an arm from the A-pillar base.
        B.append(pipe([(sx * 1.06, 0.93, 1.3), (sx * 1.15, 0.97, 1.36), (sx * 1.15, 0.97, 1.45)], 0.012, P['dark'], 6))
        B.append(box((0.04, 0.13, 0.24), (sx * 1.15, 0.97, 1.56), P['black'], bevel=0.01))
        B.append(box((0.03, 0.06, 0.6), (sx * 1.06, 0.96, 0.92), paint, bevel=0.006))  # A-pillar step plate
    # Gunner's ring (fixed race).
    mb = MB()
    mb.lathe([(0.47, -0.0), (0.58, 0.0), (0.58, 0.03), (0.47, 0.03)], 40, T(0, yr, ZROOF) @ AX_Z, paint, closed=True)
    B.append(mb.obj('ring_fixed', (0, yr, ZROOF)))
    # Roof lifting eyes.
    for sx in (-1, 1):
        for y in (0.6, -0.95):
            B.append(box((0.05, 0.08, 0.05), (sx * 0.9, y, ZROOF + 0.02), P['dark'], bevel=0.01))
    # Rear deck: trunk lid, hinges, tail lights, bumperettes, pintle, antennas, mudflaps.
    th = math.atan2(0.48, 1.26)
    thd = math.degrees(th)
    def dpt(x, y, n=0.0):
        z = 1.40 + (y + 2.40) * math.tan(th)
        return (x, y - n * math.sin(th), z + n * math.cos(th))
    B.append(box((1.7, 1.0 / math.cos(th), 0.02), dpt(0, -1.85, 0.005), paint, rot=(thd, 0, 0), bevel=0.008))
    for sx in (-1, 1):
        B.append(box((0.12, 0.05, 0.03), dpt(sx * 0.6, -1.35, 0.01), P['dark'], rot=(thd, 0, 0), bevel=0.006))
        B.append(box((0.16, 0.03, 0.26), (sx * 0.9, -2.455, 1.08), P['black'], bevel=0.008))
        B.append(box((0.1, 0.02, 0.06), (sx * 0.9, -2.47, 1.16), P['red'], bevel=0.004))
        B.append(box((0.1, 0.02, 0.06), (sx * 0.9, -2.47, 1.08), P['amber'], bevel=0.004))
        B.append(box((0.1, 0.02, 0.05), (sx * 0.9, -2.47, 1.0), P['red'], bevel=0.004))
        B.append(box((0.3, 0.06, 0.22), (sx * 0.82, -2.465, 0.72), P['dark'] if not wreck else P['rust'], bevel=0.012))
        B.append(box((0.3, 0.012, 0.32), (sx * 0.91, -2.15, 0.36), P['black'], bevel=0.0))
        if not wreck:
            B.append(box((0.08, 0.08, 0.1), dpt(sx * 0.82, -2.2, 0.05), P['black'], bevel=0.01))
            B.append(cyl(0.018, 0.12, Vector(dpt(sx * 0.82, -2.2, 0.15)), P['black'], verts=8))
            B.append(pipe([dpt(sx * 0.82, -2.2, 0.2), (sx * 0.86, -2.45, 3.6)], 0.005, P['black'], 4))
    B.append(box((0.16, 0.08, 0.12), (0, -2.47, 0.68), P['dark'], bevel=0.01))
    mb = MB()
    mb.lathe([(0.05 + 0.014 * math.cos(t * math.pi / 3), 0.014 * math.sin(t * math.pi / 3)) for t in range(6)], 12,
             T(0, -2.52, 0.68) @ R('Z', 90) @ R('Y', 90), P['dark'], closed=True, a0=0, a1=270)
    B.append(mb.obj('pintle', (0, -2.52, 0.68)))
    B.append(box((0.5, 0.012, 0.18), (0, -2.448, 0.95), paint, bevel=0.004))  # rear panel stiffener

    # ---- running gear / frame
    for sx in (-1, 1):
        B.append(box((0.09, 4.5, 0.17), (sx * 0.45, 0, 0.55), P['under'], bevel=0.005))
    for yc in (YF, YR):
        B.append(box((0.38, 0.32, 0.3), (0, yc, 0.53), P['under'], bevel=0.02))
        for sx in (-1, 1):
            B.append(cyl(0.035, 0.6, (sx * 0.5, yc, 0.56), P['under'], rot=(0, 90, 0), verts=10))
            B.append(box((0.55, 0.14, 0.05), (sx * 0.55, yc - 0.06, 0.42), P['under'], bevel=0.008))
            B.append(box((0.5, 0.1, 0.05), (sx * 0.55, yc + 0.05, 0.72), P['under'], bevel=0.008))
            B.append(cyl(0.11, 0.18, (sx * 0.7, yc, 0.55), P['under'], rot=(0, 90, 0), verts=14))   # geared hub housing
            B.append(strut((sx * 0.6, yc + 0.12, 0.45), (sx * 0.45, yc + 0.2, 0.85), 0.05, 0.05, P['under']))
    B.append(box((0.65, 1.2, 0.32), (0, 1.0, 0.72), P['under'], bevel=0.03))                    # engine / transmission
    B.append(box((0.5, 0.7, 0.25), (0.62, -1.0, 0.55), P['under'], bevel=0.02))                 # fuel tank
    B.append(cyl(0.05, 1.6, (-0.62, -0.5, 0.5), P['dark'], rot=(90, 0, 0), verts=10))          # exhaust

    # ---- interior
    B.append(box((1.96, 3.2, 0.02), (0, -0.7, 0.66), P['black'], bevel=0))
    B.append(box((0.44, 1.9, 0.36), (0, -0.05, 0.84), tan_plain, bevel=0.03))                   # transmission tunnel
    B.append(box((1.94, 0.3, 0.24), (0, 0.78, 1.17), P['black'], bevel=0.03))                    # dashboard
    B.append(box((0.6, 0.02, 0.16), (-0.5, 0.63, 1.2), P['dark'], bevel=0.005))
    for k in range(4):
        B.append(cyl(0.035, 0.01, (-0.68 + k * 0.12, 0.62, 1.21), P['lens'], rot=(90, 0, 0), verts=10))
    B.append(cyl(0.02, 0.4, (-0.5, 0.6, 1.2), P['black'], rot=(60, 0, 0), verts=8))             # steering column
    mb = MB()
    mb.lathe([(0.19 + 0.016 * math.cos(t * math.pi / 3), 0.016 * math.sin(t * math.pi / 3)) for t in range(6)], 20,
             T(-0.5, 0.45, 1.3) @ R('X', 30) @ AX_Z, P['black'], closed=True)
    B.append(mb.obj('wheel', (-0.5, 0.45, 1.3)))
    for sx in (-1, 1):
        for yc in (0.22, -0.7):
            B.append(box((0.5, 0.48, 0.12), (sx * 0.5, yc, 0.88), P['canvas'], bevel=0.03))
            B.append(box((0.48, 0.1, 0.56), (sx * 0.5, yc - 0.27, 1.2), P['canvas'], rot=(-10, 0, 0), bevel=0.03))
            B.append(box((0.4, 0.4, 0.2), (sx * 0.5, yc, 0.74), P['black'], bevel=0.01))
    B.append(box((0.42, 0.42, 0.42), (0, -1.05, 1.24), P['od'], bevel=0.01))                     # radio rack (SINCGARS)
    for k in range(2):
        B.append(box((0.36, 0.02, 0.17), (0, -0.835, 1.13 + k * 0.2), P['black'], bevel=0.004))
        for j in range(3):
            B.append(cyl(0.015, 0.03, (-0.1 + j * 0.08, -0.82, 1.15 + k * 0.2), P['dark'], rot=(90, 0, 0), verts=8))
    B.append(box((0.4, 0.3, 0.03), (0, yr - 0.05, 1.06), P['canvas'], bevel=0.01))                  # gunner's platform
    B.append(cyl(0.012, 0.42, (0.15, -1.3, 1.6), P['dark'], verts=6))
    for k in range(3):                                                                              # stowed kit in the cargo bay
        B.append(box((0.3, 0.16, 0.2), (0.5 - k * 0.32, -1.8, 0.77), P['od'], bevel=0.01))

    # ---- turret (O-GPK style), pintle and M2
    tz = 2.16
    ty = yr + 0.32
    mb = MB()
    mb.lathe([(0.48, 0.03), (0.6, 0.03), (0.6, 0.1), (0.48, 0.1)], 40, T(0, yr, ZROOF) @ AX_Z, paint, closed=True)
    TU.append(mb.obj('ring_rot', (0, yr, ZROOF)))
    TU.append(cyl(0.035, tz - 0.06 - (ZROOF + 0.1), (0, ty, (ZROOF + 0.1 + tz - 0.06) / 2), P['dark'], verts=12))   # pintle post
    TU.append(cyl(0.055, 0.07, (0, ty, tz - 0.07), P['dark'], verts=14))
    for sx in (-1, 1):
        TU.append(strut((sx * 0.4, yr + 0.42, ZROOF + 0.1), (sx * 0.04, ty, tz - 0.09), 0.04, 0.03, P['dark']))
    zb0 = ZROOF + 0.06
    # (angle, width, top at front edge, top at rear edge, [(u_rear, z, w, h) openings])
    plates = [(0, 0.56, 2.66, 2.66, [(0, 2.2, 0.17, 0.28), (0, 2.52, 0.3, 0.18)]),
              (45, 0.56, 2.66, 2.62, [(0, 2.46, 0.36, 0.24)]), (-45, 0.56, 2.66, 2.62, [(0, 2.46, 0.36, 0.24)]),
              (90, 0.56, 2.62, 2.44, [(-0.06, 2.4, 0.28, 0.16)]), (-90, 0.56, 2.62, 2.44, [(-0.06, 2.4, 0.28, 0.16)]),
              (135, 0.5, 2.42, 2.28, []), (-135, 0.5, 2.42, 2.28, [])]
    d = 0.66
    bent = {45: 14, 135: -25}
    def place(o, ang, cx, cy):
        bake(o)
        o.matrix_world = Matrix.Translation((cx, cy, 0)) @ Matrix.Rotation(math.radians(-ang), 4, 'Z') @ o.matrix_world
        return o
    for ang, wdt, zf, zr, holes in plates:
        a = math.radians(ang)
        cx, cy = math.sin(a) * d, yr + math.cos(a) * d
        sg = 1 if ang > 0 else -1
        ztop = lambda u: zf + (zr - zf) * (u * sg + wdt / 2) / wdt
        outline = [(-wdt / 2, zb0), (wdt / 2, zb0), (wdt / 2, ztop(wdt / 2)), (-wdt / 2, ztop(-wdt / 2))]
        cuts = [(u * sg, z, w, h) for u, z, w, h in holes]
        pl = plate(outline, 0.028, cx, cy, ang, paint, cuts, 0.006)
        parts = [pl]
        parts.append(place(box((0.08, 0.14, 0.12), (0, -0.07, zb0 + 0.06), P['dark'], bevel=0.006), ang, cx, cy))
        for k, (u, z, w, h) in enumerate(cuts):
            if ang == 0 and k == 0:
                continue                       # gun slot stays open
            if not wreck:
                TG.append(place(box((w + 0.01, 0.05, h + 0.01), (u, 0, z), P['glass'], bevel=0.003), ang, cx, cy))
            for dz in (-1, 1):
                parts.append(place(box((w + 0.06, 0.05, 0.03), (u, 0, z + dz * (h / 2 + 0.015)), paint, bevel=0.004), ang, cx, cy))
            for du in (-1, 1):
                parts.append(place(box((0.03, 0.05, h), (u + du * (w / 2 + 0.015), 0, z), paint, bevel=0.004), ang, cx, cy))
        if wreck and ang in bent:
            # Blast-bent plate: rotate about its bottom edge.
            piv = Vector((cx, cy, zb0))
            Mr = Matrix.Translation(piv) @ Matrix.Rotation(math.radians(bent[ang]), 4, Vector((math.cos(a), -math.sin(a), 0))) @ Matrix.Translation(-piv)
            for p in parts:
                bake(p)
                p.matrix_world = Mr @ p.matrix_world
        if wreck and ang == -90:
            kill(parts)
            continue
        TU.extend(parts)
    # Gun
    if not wreck:
        muz = build_m2(0, ty, tz, P, GU)
    else:
        muz = None
        TU.append(box((0.2, 0.34, 0.03), (0, ty - 0.02, tz - 0.035), P['char'], bevel=0.005))

    # ---- wheels
    wheels = []
    for nm, (sx, yc) in {'wheel_fl': (-1, YF), 'wheel_fr': (1, YF), 'wheel_rl': (-1, YR), 'wheel_rr': (1, YR)}.items():
        if wreck:
            zc = 0.21 + 0.045
            wheels.append(make_wheel(nm, (sx * WX, yc, zc), sx, 0.25, WW, 0.21, P['rust'], rim_m, P['char'], 'hmmwv', 32, False, True, rust_m=P['rust']))
        else:
            wheels.append(make_wheel(nm, (sx * WX, yc, WR), sx, WR, WW, 0.21, tyre_m, rim_m, P['dark'], 'hmmwv', 32, True))

    # ---- assemble
    root = empty(vid)
    if wreck:
        # Sitting on its rims: drop the hull, slight list to the left and nose down.
        drop = WR - 0.255
        Mw = Matrix.Translation((0, 0, -drop)) @ Matrix.Rotation(math.radians(-2.0), 4, 'Y') @ Matrix.Rotation(math.radians(-0.8), 4, 'X')
        allp = B + TU + GU
        for p in allp:
            bake(p)
            p.matrix_world = Mw @ p.matrix_world
        for p in B + TU:
            pass
        body = group('body', B + TU + wheels, (0, 0, 0), root)
        limit_tris(body, 14800)
        auto_uv(body, H, Wd)
        return root, body
    body = group('body', B, (0, 0, 0), root)
    auto_uv(body, H, Wd)
    glass = group('glass', G, (0, 0, 0), root)
    for w in wheels:
        attach(w, root)
    turret = group('turret', TU, (0, yr, ZROOF), root)
    auto_uv(turret, H, Wd)
    group('glass_turret', TG, (0, yr, ZROOF), turret)
    gun = group('gun', GU, (0, ty, tz), turret)
    empty('muzzle', muz, gun)
    eye = (0, yr - 0.42, ZROOF + 0.46)
    empty('turret_eye', eye, turret)
    empty('seat_driver', (-0.5, 0.06, 1.62), root)
    empty('seat_passenger', (0.5, 0.06, 1.62), root)
    empty('seat_rear_l', (-0.5, -0.86, 1.62), root)
    empty('seat_rear_r', (0.5, -0.86, 1.62), root)
    empty('seat_gunner', eye, root)
    empty('exit_l', (-1.6, 0.3, 0.0), root)
    empty('exit_r', (1.6, 0.3, 0.0), root)
    return root, body

# ------------------------------------------------------------------ shared civilian-car pieces
def burn_drop(parts, drop, roll=0.0, pitch=0.0):
    """Lower (and tilt) wreck parts so the hull sits on its rims."""
    Mw = Matrix.Translation((0, 0, -drop)) @ Matrix.Rotation(math.radians(roll), 4, 'Y') @ Matrix.Rotation(math.radians(pitch), 4, 'X')
    for p in parts:
        bake(p)
        p.matrix_world = Mw @ p.matrix_world

def greenhouse(prof, trap, inset=0.0, m=None):
    """Cabin greenhouse: side profile (y, z) intersected with a front-view trapezoid (x, z); optional inset."""
    if inset:
        prof = offset_poly(prof, inset)
        trap = offset_poly(trap, inset)
    g = sp(prof, 3.0, m, 0, 0)
    boolean(g, xz_prism(trap, -6, 6), 'INTERSECT')
    return g

def lamp(B, size, loc, lens_m, frame_m, P, depth_y=1):
    """Rectangular lamp facing +Y (depth_y=1) or -Y: frame plus lens."""
    sx, sz = size
    B.append(box((sx + 0.03, 0.04, sz + 0.03), loc, frame_m, bevel=0.008))
    B.append(box((sx, 0.04, sz), (loc[0], loc[1] + depth_y * 0.008, loc[2]), lens_m, bevel=0.006))

# ------------------------------------------------------------------ Toyota Hilux style pickup (technical, civilian, wreck)
def build_hilux(kind='dshk'):
    vid = {'dshk': 'hilux_dshk', 'civil': 'pickup', 'wreck': 'pickup_wreck'}[kind]
    wreck = kind == 'wreck'
    P = common_mats()
    H, Wd = 1.75, 1.7
    if wreck:
        img = grime_image('char_tex', lin(200, 200, 195), 1024, 21, char=True)
        paint = pmat('paint_burnt', (1, 1, 1), 0.92, 0.1, img=img)
        trim = P['char']; chrome = P['rust']; P['canvas'] = P['char']
        P['seatfab'] = P['char']
    elif kind == 'dshk':
        img = grime_image('white_faded', lin(214, 211, 200), 1024, 5, dirt=lin(120, 100, 76), dust=lin(196, 180, 150),
                          dirt_amt=0.85, dust_amt=0.42, rust=0.55, fade=0.1)
        paint = pmat('paint_white_faded', (1, 1, 1), 0.62, 0.0, img=img)
        trim, chrome = P['black'], pmat('chrome_dull', (0.5, 0.5, 0.48), 0.3, 1.0)
        P['seatfab'] = pmat('seat_vinyl', lin(70, 60, 50), 0.7)
    else:
        img = grime_image('blue_faded', lin(88, 116, 140), 1024, 7, dirt=lin(120, 100, 76), dust=lin(196, 180, 150),
                          dirt_amt=0.75, dust_amt=0.45, rust=0.35, fade=0.28)
        paint = pmat('paint_blue_faded', (1, 1, 1), 0.6, 0.0, img=img)
        trim, chrome = P['black'], pmat('chrome_dull', (0.5, 0.5, 0.48), 0.3, 1.0)
        P['seatfab'] = pmat('seat_vinyl', lin(70, 60, 50), 0.7)
    B, G, TU, GU = [], [], [], []
    YF, YR, WX, WR, WW, RIM = 1.5, -1.5, 0.725, 0.37, 0.25, 0.19
    HW = 0.845
    def arch(yc, g=0.0):
        return [(yc - 0.48 - g, 0.3), (yc - 0.45 - g, 0.62 + g * 0.5), (yc - 0.34 - g * 0.8, 0.79 + g * 0.8), (yc - 0.12, 0.855 + g),
                (yc + 0.12, 0.855 + g), (yc + 0.34 + g * 0.8, 0.79 + g * 0.8), (yc + 0.45 + g, 0.62 + g * 0.5), (yc + 0.48 + g, 0.3)]
    def arch_cut(yc, x0=0.5):
        w = 1.2 - x0
        return [sp(arch(yc), w, None, sx * (x0 + w / 2)) for sx in (-1, 1)]
    # ---- front clip
    fc = sp([(0.96, 0.55), (2.31, 0.55), (2.355, 0.62), (2.365, 1.02), (2.3, 1.085), (2.15, 1.12), (0.96, 1.15)], 2.0, paint, 0, 0)
    boolean(fc, xy_prism([(-HW, 0.9), (HW, 0.9), (HW, 2.05), (0.83, 2.28), (0.77, 2.4), (-0.77, 2.4), (-0.83, 2.28), (-HW, 2.05)], 0.3, 1.4), 'INTERSECT')
    boolean(fc, xz_prism([(-HW, 0.4), (HW, 0.4), (HW, 1.07), (0.83, 1.125), (0.75, 1.155), (-0.75, 1.155), (-0.83, 1.125), (-HW, 1.07)], 0.8, 2.5), 'INTERSECT')
    boolean(fc, arch_cut(YF, 0.52))
    bev(fc, 0.012, 2)
    B.append(fc)
    # Grille, headlights, corner lamps, bumper.
    B.append(box((0.62, 0.04, 0.2), (0, 2.355, 0.86), chrome, bevel=0.01))
    B.append(box((0.58, 0.05, 0.17), (0, 2.36, 0.86), P['black'], bevel=0.004))
    for k in range(4):
        B.append(box((0.58, 0.02, 0.014), (0, 2.385, 0.79 + k * 0.045), chrome if not wreck else P['char'], bevel=0.0))
    for sx in (-1, 1):
        lamp(B, (0.3, 0.13), (sx * 0.5, 2.35, 0.87), P['lens'] if not wreck else P['char'], chrome, P)
        B.append(box((0.07, 0.11, 0.13), (sx * 0.8, 2.31, 0.87), P['amber'] if not wreck else P['char'], bevel=0.01))
        # Fender flares (4x4) and mud flaps.
        fl = sp(arch(YF, 0.05), 0.07, trim, sx * (HW + 0.01))
        boolean(fl, sp(arch(YF), 0.3, None, sx * HW))
        B.append(fl)
        fl = sp(arch(YR, 0.05), 0.07, trim, sx * (HW + 0.01))
        boolean(fl, sp(arch(YR), 0.3, None, sx * HW))
        B.append(fl)
        B.append(box((0.24, 0.01, 0.28), (sx * 0.73, YR - 0.52, 0.32), P['black'], bevel=0))
        B.append(box((0.26, 0.01, 0.25), (sx * 0.73, YF - 0.52, 0.33), P['black'], bevel=0))
        # Inner wings closing the front arches.
    B.append(box((1.72, 0.13, 0.15), (0, 2.38, 0.5), chrome, bevel=0.025))
    B.append(box((1.6, 0.02, 0.05), (0, 2.448, 0.5), P['black'], bevel=0.005))
    if not wreck:
        B.append(box((0.42, 0.01, 0.11), (0, 2.45, 0.63), pmat('plate_white', (0.7, 0.7, 0.66), 0.5), bevel=0.003))
    B.append(box((1.3, 0.3, 0.12), (0, 2.25, 0.38), P['under'], bevel=0.01))
    # ---- cab lower (hollow tub; doors)
    cab = sp([(1.0, 0.55), (1.0, 1.15), (-0.42, 1.15), (-0.42, 0.55)], 2.0, paint, 0, 0)
    boolean(cab, xz_prism([(-0.81, 0.5), (0.81, 0.5), (HW, 0.72), (HW, 1.02), (0.83, 1.155), (-0.83, 1.155), (-HW, 1.02), (-HW, 0.72)], -0.5, 1.1), 'INTERSECT')
    boolean(cab, box((1.58, 1.32, 1.0), (0, 0.29, 1.12), None, bevel=0))
    boolean(cab, arch_cut(YF, 0.52))
    bev(cab, 0.01, 2)
    B.append(cab)
    for sx in (-1, 1):
        for y in (0.99, -0.36):
            B.append(box((0.004, 0.006, 0.58), (sx * (HW + 0.002), y, 0.86), P['black'], bevel=0))
        B.append(box((0.004, 1.35, 0.006), (sx * (HW - 0.002), 0.32, 0.585), P['black'], bevel=0))
        B.append(box((0.025, 0.12, 0.035), (sx * (HW + 0.01), -0.22, 1.05), trim, bevel=0.008))      # door handle
        B.append(box((0.012, 1.2, 0.03), (sx * (HW + 0.004), 0.35, 0.75), trim, bevel=0.004))       # body side moulding
        B.append(pipe([(sx * 0.82, 0.85, 1.18), (sx * 0.93, 0.86, 1.22)], 0.012, trim, 6))
        B.append(box((0.03, 0.12, 0.16), (sx * 0.96, 0.85, 1.28), trim, bevel=0.012))                 # mirror
    # ---- greenhouse: glass volume with pillars and roof over it
    gh = [(0.99, 1.13), (0.6, 1.675), (0.53, 1.705), (-0.33, 1.705), (-0.4, 1.68), (-0.415, 1.13)]
    tr = [(-0.83, 1.13), (0.83, 1.13), (0.67, 1.71), (-0.67, 1.71)]
    if not wreck:
        G.append(greenhouse(gh, tr, 0.012, P['glass']))
    roof = greenhouse(gh, [(-0.84, 1.12), (0.84, 1.12), (0.675, 1.72), (-0.675, 1.72)], 0.0, paint)
    boolean(roof, box((3, 3, 1), (0, 0, 1.13), None, bevel=0))
    bev(roof, 0.015, 2)
    B.append(roof)
    # Back panel with the small rear window.
    bp = xz_prism([(-0.83, 1.13), (0.83, 1.13), (0.68, 1.68), (-0.68, 1.68)], -0.425, -0.39, paint)
    boolean(bp, box((1.05, 0.3, 0.26), (0, -0.4, 1.42), None, bevel=0))
    bev(bp, 0.006, 1)
    B.append(bp)
    for sx in (-1, 1):
        B.append(strut((sx * 0.825, 0.985, 1.14), (sx * 0.668, 0.585, 1.69), 0.075, 0.035, paint, out=(sx, 0, 0.27), bevel=0.008))   # A
        B.append(strut((sx * 0.828, -0.38, 1.14), (sx * 0.672, -0.36, 1.69), 0.1, 0.035, paint, out=(sx, 0, 0.27), bevel=0.008))   # B
        B.append(strut((sx * 0.67, 0.6, 1.692), (sx * 0.67, -0.38, 1.692), 0.03, 0.03, trim, out=(sx, 0, 0)))                      # drip rail
        B.append(strut((sx * 0.832, 0.98, 1.14), (sx * 0.832, -0.38, 1.14), 0.03, 0.02, trim, out=(sx, 0, 0)))                     # belt seal
        B.append(strut((sx * 0.8, 0.86, 1.14), (sx * 0.69, 0.68, 1.6), 0.02, 0.02, trim, out=(sx, 0, 0.27)))                       # vent window divider
    B.append(strut((-0.8, 0.99, 1.135), (0.8, 0.99, 1.135), 0.05, 0.03, trim, out=(0, 1, 0.6)))                                  # cowl
    B.append(strut((-0.66, 0.6, 1.677), (0.66, 0.6, 1.677), 0.05, 0.03, paint, out=(0, 1, 0.6)))
    if not wreck:
        for sx in (-0.3, 0.25):
            B.append(strut((sx - 0.2, 0.975, 1.16), (sx + 0.2, 0.99, 1.165), 0.015, 0.01, P['black']))                           # wipers
    # ---- bed
    bed = box((2 * HW, 1.96, 0.66), (0, -1.44, 0.91), paint, bevel=0)
    boolean(bed, box((2 * HW - 0.14, 1.84, 1.0), (0, -1.44, 0.86 + 0.5), None, bevel=0))
    boolean(bed, arch_cut(YR, 0.55))
    bev(bed, 0.01, 2)
    B.append(bed)
    for sx in (-1, 1):
        hump = box((0.22, 0.95, 0.3), (sx * 0.665, YR, 0.97), paint, bevel=0)
        boolean(hump, sp(arch(YR), 0.5, None, sx * 0.8))
        bev(hump, 0.01, 2)
        B.append(hump)
        B.append(box((0.08, 0.05, 0.25), (sx * 0.8, -2.44, 1.06), P['red'] if not wreck else P['char'], bevel=0.008))
        B.append(box((0.08, 0.05, 0.08), (sx * 0.8, -2.44, 0.89), P['amber'] if not wreck else P['char'], bevel=0.008))
        for k in range(3):
            B.append(box((0.02, 0.02, 0.05), (sx * 0.86, -0.7 - k * 0.6, 1.2), trim, bevel=0.003))  # rope hooks
    B.append(box((1.5, 0.02, 0.4), (0, -2.432, 1.0), paint, bevel=0.006))                              # tailgate skin
    for k in range(2):
        B.append(box((1.3, 0.012, 0.03), (0, -2.444, 0.92 + k * 0.17), paint, bevel=0.004))
    B.append(box((0.14, 0.02, 0.04), (0, -2.445, 1.17), trim, bevel=0.006))
    B.append(box((1.7, 0.14, 0.12), (0, -2.47, 0.55), chrome if kind != 'civil' else P['black'], bevel=0.02))  # step bumper
    if not wreck:
        B.append(box((0.4, 0.01, 0.12), (0, -2.42, 0.72), pmat('plate_white', (0.7, 0.7, 0.66), 0.5), bevel=0.003))
    # ---- chassis and running gear
    for sx in (-1, 1):
        B.append(box((0.07, 4.4, 0.16), (sx * 0.43, -0.05, 0.5), P['under'], bevel=0.005))
        B.append(box((0.07, 1.3, 0.05), (sx * 0.55, YR, 0.43), P['under'], bevel=0.005))               # leaf spring
        B.append(box((0.5, 0.08, 0.06), (sx * 0.45, YF, 0.36), P['under'], bevel=0.005))              # IFS arm
    B.append(cyl(0.04, 1.3, (0, YR, WR), P['under'], rot=(0, 90, 0), verts=10))                        # live axle
    B.append(sphere_ish(0.13, (0, YR, WR), P['under']))
    B.append(box((0.3, 0.25, 0.22), (0, YF, 0.44), P['under'], bevel=0.02))
    B.append(cyl(0.035, 2.6, (0, -0.1, 0.45), P['under'], rot=(90, 0, 0), verts=8))                  # drive shaft
    B.append(box((0.6, 1.0, 0.3), (0, 1.25, 0.62), P['under'], bevel=0.03))                            # engine
    B.append(box((0.5, 0.6, 0.22), (-0.55, -0.9, 0.5), P['under'], bevel=0.02))                       # fuel tank
    B.append(cyl(0.025, 2.2, (0.3, -1.3, 0.38), P['dark'], rot=(90, 0, 0), verts=8))                  # exhaust
    # Spare wheel under the bed rear.
    spare = make_wheel('spare', (0, -2.0, 0.45), 1, WR, WW, RIM, P['rubber'] if not wreck else P['rust'],
                       P['dark'] if not wreck else P['rust'], P['dark'], 'steel', 20, False, burnt=wreck)
    bake(spare)
    spare.matrix_world = Matrix.Translation((0, -2.0, 0.42)) @ Matrix.Rotation(math.radians(90), 4, 'Y')
    B.append(spare)
    # ---- interior
    B.append(box((1.56, 1.25, 0.02), (0, 0.32, 0.6), P['black'], bevel=0))
    B.append(box((1.6, 0.35, 0.2), (0, 0.8, 1.05), P['black'], bevel=0.04))                            # dash
    B.append(box((0.4, 0.06, 0.12), (-0.38, 0.65, 1.12), P['dark'], bevel=0.02))                       # binnacle
    B.append(cyl(0.02, 0.35, (-0.38, 0.62, 1.0), P['black'], rot=(58, 0, 0), verts=8))
    mb = MB()
    mb.lathe([(0.18 + 0.014 * math.cos(t * math.pi / 3), 0.014 * math.sin(t * math.pi / 3)) for t in range(6)], 18,
             T(-0.38, 0.5, 1.1) @ R('X', 32) @ AX_Z, P['black'], closed=True)
    B.append(mb.obj('steer', (-0.38, 0.5, 1.1)))
    B.append(box((1.5, 0.5, 0.14), (0, -0.05, 0.8), P['seatfab'], bevel=0.04))                         # bench
    B.append(box((1.5, 0.12, 0.55), (0, -0.33, 1.1), P['seatfab'], rot=(-12, 0, 0), bevel=0.04))
    B.append(box((1.3, 0.4, 0.15), (0, -0.05, 0.67), P['black'], bevel=0.01))
    # ---- seats / gun
    eye_d = (-0.38, -0.12, 1.5)
    if kind == 'dshk':
        # Welded pipe pedestal in the bed, braced to the floor.
        pz0, pz1, py = 0.87, 1.6, -1.42
        B.append(box((0.3, 0.3, 0.012), (0, py, pz0 + 0.006), P['dark'], bevel=0.002))
        B.append(cyl(0.05, pz1 - pz0, (0, py, (pz0 + pz1) / 2), P['dark'], verts=12))
        for a in (45, 135, 225, 315):
            dx, dy = math.sin(math.radians(a)) * 0.55, math.cos(math.radians(a)) * 0.5
            B.append(strut((dx, py + dy, pz0 + 0.01), (0, py, pz0 + 0.42), 0.035, 0.035, P['dark']))
            B.append(box((0.08, 0.08, 0.01), (dx, py + dy, pz0 + 0.005), P['dark'], bevel=0.002))
        tz, ty = 1.92, py + 0.12
        TU.append(cyl(0.065, 0.12, (0, py, pz1 + 0.04), P['dark'], verts=14))                         # swivel collar
        TU.append(box((0.22, 0.1, 0.05), (0, py + 0.04, pz1 + 0.12), P['dark'], bevel=0.006))
        for sx in (-1, 1):
            TU.append(strut((sx * 0.1, py + 0.04, pz1 + 0.12), (sx * 0.095, ty, tz), 0.06, 0.02, P['dark'], out=(1, 0, 0)))
        TU.append(cyl(0.015, 0.24, (0, ty, tz), P['steel'], rot=(0, 90, 0), verts=8))                  # trunnion pin
        TU.append(cyl(0.015, 0.4, (-0.06, py - 0.12, pz1 + 0.1), P['dark'], rot=(70, 0, 0), verts=8))  # traverse handle
        muz = build_dshk(0, ty, tz, P, GU)
        # Spare ammunition boxes and a jerrycan loose in the bed.
        for k, (x, y, rz) in enumerate(((0.45, -2.15, 10), (0.5, -1.85, -6), (-0.5, -2.2, 80))):
            B.append(box((0.16, 0.36, 0.22), (x, y, 0.98), P['dshk_box'], rot=(0, 0, rz), bevel=0.01))
            B.append(box((0.04, 0.12, 0.02), (x, y, 1.1), P['dark'], rot=(0, 0, rz), bevel=0.004))
        B.append(box((0.17, 0.35, 0.47), (-0.62, -0.75, 1.1), pmat('jerry_green', lin(70, 82, 52), 0.6), bevel=0.02))
        eye_g = (0, ty - 0.68, 2.22)
    else:
        if kind == 'civil':
            # Load under a tarp: lumpy cover tied down, sacks and a jerrycan.
            tarp = pmat('tarp', lin(96, 84, 60), 0.95)
            lump = box((1.4, 1.2, 0.35), (0, -1.6, 1.04), tarp, bevel=0)
            bev(lump, 0.12, 3, 30)
            B.append(lump)
            for k in range(3):
                B.append(box((0.5, 0.32, 0.22), (-0.35 + k * 0.35, -0.75, 0.97), pmat('sack', lin(170, 150, 112), 0.95), rot=(0, 0, 8 * k - 8), bevel=0.06))
            B.append(box((0.17, 0.35, 0.47), (0.62, -0.75, 1.1), pmat('jerry_green', lin(70, 82, 52), 0.6), bevel=0.02))
            for y in (-1.25, -1.95):
                B.append(pipe([(-0.79, y, 1.2), (-0.62, y, 1.215), (0.62, y, 1.215), (0.79, y, 1.2)], 0.01, P['black'], 6))
    # ---- wheels
    wheels = []
    for nm, (sx, yc) in {'wheel_fl': (-1, YF), 'wheel_fr': (1, YF), 'wheel_rl': (-1, YR), 'wheel_rr': (1, YR)}.items():
        if wreck:
            wheels.append(make_wheel(nm, (sx * WX, yc, RIM + 0.03), sx, RIM + 0.03, WW, RIM, P['rust'], P['rust'], P['char'], 'steel', 24, False, True, rust_m=P['rust']))
        else:
            wheels.append(make_wheel(nm, (sx * WX, yc, WR), sx, WR, WW, RIM, P['rubber'], P['dark'] if kind == 'dshk' else pmat('wheel_white', (0.6, 0.6, 0.58), 0.5, 0.3),
                                     P['dark'], 'steel', 28, kind == 'dshk'))
    root = empty(vid)
    if wreck:
        burn_drop(B, WR - RIM - 0.03, 1.5, -0.6)
        body = group('body', B + wheels, (0, 0, 0), root)
        limit_tris(body, 14800)
        auto_uv(body, H, Wd)
        return root, body
    body = group('body', B, (0, 0, 0), root)
    auto_uv(body, H, Wd)
    group('glass', G, (0, 0, 0), root)
    for w in wheels:
        attach(w, root)
    empty('seat_driver', eye_d, root)
    empty('seat_passenger', (0.38, -0.12, 1.5), root)
    if kind == 'dshk':
        turret = group('turret', TU, (0, py, pz1), root)
        gun = group('gun', GU, (0, ty, tz), turret)
        empty('muzzle', muz, gun)
        empty('turret_eye', eye_g, turret)
        empty('seat_gunner', eye_g, root)
        empty('seat_rear_l', (-0.72, -2.1, 1.98), root)
        empty('seat_rear_r', (0.72, -2.1, 1.98), root)
    else:
        empty('seat_rear_l', (-0.72, -1.9, 1.98), root)
        empty('seat_rear_r', (0.72, -1.9, 1.98), root)
    empty('exit_l', (-1.35, 0.2, 0.0), root)
    empty('exit_r', (1.35, 0.2, 0.0), root)
    return root, body

def sphere_ish(r, loc, m):
    mb = MB()
    prof = [(r * math.sin(math.pi * k / 6), -r * math.cos(math.pi * k / 6)) for k in range(7)]
    prof[0] = (0.0001, prof[0][1]); prof[-1] = (0.0001, prof[-1][1])
    mb.lathe(prof, 12, T(*loc), m)
    return mb.obj('sph', loc)


# ------------------------------------------------------------------ 1980s saloon (generic, no badges)
def build_sedan(wreck=False):
    vid = 'sedan_wreck' if wreck else 'sedan'
    P = common_mats()
    H, Wd = 1.45, 1.75
    if wreck:
        img = grime_image('char_tex', lin(220, 210, 185), 1024, 31, char=True)
        paint = pmat('paint_burnt', (1, 1, 1), 0.92, 0.1, img=img)
        trim = chrome = P['char']
        seat = P['char']
        rust_frame = P['rust']
    else:
        img = grime_image('beige_faded', lin(222, 212, 186), 1024, 9, dirt=lin(120, 100, 76), dust=lin(196, 180, 150),
                          dirt_amt=0.7, dust_amt=0.4, rust=0.25, fade=0.15)
        paint = pmat('paint_beige_faded', (1, 1, 1), 0.55, 0.0, img=img)
        trim = P['black']
        chrome = pmat('chrome_dull', (0.55, 0.55, 0.53), 0.25, 1.0)
        seat = pmat('seat_cloth', lin(96, 70, 50), 0.9)
    B, G = [], []
    YF, YR, WX, WR, WW, RIM = 1.4, -1.4, 0.745, 0.325, 0.19, 0.178
    HW = 0.875
    def arch(yc, g=0.0):
        return [(yc - 0.43 - g, 0.15), (yc - 0.41 - g, 0.5 + g * 0.5), (yc - 0.32 - g * 0.8, 0.66 + g * 0.8), (yc - 0.13, 0.73 + g),
                (yc + 0.13, 0.73 + g), (yc + 0.32 + g * 0.8, 0.66 + g * 0.8), (yc + 0.41 + g, 0.5 + g * 0.5), (yc + 0.43 + g, 0.15)]
    # ---- lower body: side, plan and front outlines intersected; cabin well cut out
    prof = [(2.27, 0.3), (2.31, 0.42), (2.32, 0.74), (2.26, 0.79), (1.6, 0.845), (0.84, 0.9), (0.8, 0.925), (-1.3, 0.94),
            (-1.5, 0.955), (-2.18, 0.95), (-2.28, 0.9), (-2.31, 0.76), (-2.31, 0.42), (-2.26, 0.3)]
    lb = sp(prof, 2.0, paint, 0, 0)
    boolean(lb, xy_prism([(-0.84, -2.33), (0.84, -2.33), (HW, -2.22), (HW, 2.18), (0.84, 2.33), (-0.84, 2.33), (-HW, 2.18), (-HW, -2.22)], 0.0, 1.2), 'INTERSECT')
    boolean(lb, xz_prism([(-0.83, 0.25), (0.83, 0.25), (HW, 0.48), (HW, 0.76), (0.86, 0.9), (0.83, 0.97), (-0.83, 0.97), (-0.86, 0.9), (-HW, 0.76), (-HW, 0.48)], -2.5, 2.5), 'INTERSECT')
    cuts = [sp(arch(yc), 0.6, None, sx * 0.85) for yc in (YF, YR) for sx in (-1, 1)]
    cuts.append(box((1.6, 2.1, 1.0), (0, -0.24, 0.92), None, bevel=0))
    boolean(lb, cuts)
    bev(lb, 0.015, 2)
    B.append(lb)
    for yc in (YF, YR):
        for sx in (-1, 1):
            hs = sp(arch(yc, 0.03), 0.3, P['under'], sx * 0.68)
            boolean(hs, sp(arch(yc), 0.3, None, sx * 0.72))
            B.append(hs)
    # ---- greenhouse
    gh = [(0.84, 0.92), (0.16, 1.4), (0.08, 1.43), (-0.02, 1.445), (-0.84, 1.445), (-0.96, 1.43), (-1.03, 1.405), (-1.42, 0.94)]
    tr = [(-0.85, 0.92), (0.85, 0.92), (0.66, 1.445), (-0.66, 1.445)]
    if not wreck:
        G.append(greenhouse(gh, tr, 0.012, P['glass']))
    roof = greenhouse(gh, [(-0.86, 0.91), (0.86, 0.91), (0.665, 1.455), (-0.665, 1.455)], 0.0, paint)
    boolean(roof, box((3, 4, 1), (0, 0, 0.87), None, bevel=0))
    bev(roof, 0.015, 2)
    B.append(roof)
    zb = 0.93
    for sx in (-1, 1):
        o = (sx, 0, 0.36)
        B.append(strut((sx * 0.845, 0.83, zb), (sx * 0.668, 0.13, 1.425), 0.07, 0.03, paint, out=o, bevel=0.008))      # A
        B.append(strut((sx * 0.85, -0.3, zb), (sx * 0.67, -0.3, 1.43), 0.08, 0.03, paint, out=o, bevel=0.008))         # B
        # C pillar: wide, filling the rear quarter.
        cp = xz_prism([(0, 0), (0.001, 0), (0.001, 0.001)], 0, 0.001)
        kill([cp])
        mb = MB()
        pts = [Vector((sx * 0.852, -1.0, zb)), Vector((sx * 0.852, -1.44, zb)), Vector((sx * 0.67, -1.02, 1.425)), Vector((sx * 0.67, -0.74, 1.425))]
        bm = mb.bm
        nrm = Vector((sx * 0.02, 0, 0))
        vs = [bm.verts.new(p) for p in pts] + [bm.verts.new(p - nrm * 1.5) for p in pts]
        bm.faces.new(vs[0:4]); bm.faces.new(vs[4:8][::-1])
        for k in range(4):
            bm.faces.new((vs[k], vs[(k + 1) % 4], vs[4 + (k + 1) % 4], vs[4 + k]))
        for f in bm.faces:
            f.material_index = mb.mi(paint)
        B.append(mb.obj('cpillar', (0, 0, 0)))
        B.append(strut((sx * 0.67, 0.13, 1.432), (sx * 0.67, -1.0, 1.432), 0.02, 0.025, chrome, out=(sx, 0, 0)))     # drip rail
        B.append(strut((sx * 0.858, 0.83, zb + 0.005), (sx * 0.858, -1.25, zb + 0.005), 0.025, 0.012, chrome, out=(sx, 0, 0)))  # belt trim
        # Door shut lines, handles, rubbing strip.
        for y in (0.83, -0.3, -1.27):
            B.append(box((0.004, 0.006, 0.6), (sx * 0.876, y, 0.62), P['black'], bevel=0))
        B.append(box((0.004, 2.1, 0.006), (sx * 0.874, -0.22, 0.33), P['black'], bevel=0))
        for y in (0.15, -0.95):
            B.append(box((0.02, 0.13, 0.03), (sx * 0.884, y, 0.85), chrome, bevel=0.008))
        B.append(box((0.014, 1.86, 0.04), (sx * 0.879, 0, 0.6), trim, bevel=0.005))
    B.append(pipe([(-0.84, 0.75, 0.96), (-0.93, 0.76, 0.99)], 0.01, trim, 6))
    B.append(box((0.03, 0.14, 0.1), (-0.95, 0.76, 1.04), trim, bevel=0.012))                                        # driver mirror
    B.append(strut((-0.8, 0.84, 0.925), (0.8, 0.84, 0.925), 0.05, 0.025, trim, out=(0, 1, 0.9)))
    B.append(strut((-0.64, 0.13, 1.425), (0.64, 0.13, 1.425), 0.04, 0.02, paint, out=(0, 1, 1.4)))
    if not wreck:
        for sx in (-0.32, 0.28):
            B.append(strut((sx - 0.24, 0.82, 0.945), (sx + 0.22, 0.86, 0.94), 0.015, 0.01, P['black']))
    # ---- front / rear
    B.append(box((0.5, 0.04, 0.2), (0, 2.32, 0.6), chrome, bevel=0.01))                                             # grille frame
    B.append(box((0.46, 0.04, 0.16), (0, 2.328, 0.6), P['black'], bevel=0.0))
    for k in range(5):
        B.append(box((0.46, 0.02, 0.012), (0, 2.345, 0.535 + k * 0.032), chrome, bevel=0.0))
    for sx in (-1, 1):
        lamp(B, (0.3, 0.15), (sx * 0.52, 2.315, 0.62), P['lens'] if not wreck else P['char'], chrome, P)
        B.append(box((0.1, 0.08, 0.1), (sx * 0.8, 2.27, 0.62), P['amber'] if not wreck else P['char'], bevel=0.01))
        lamp(B, (0.36, 0.14), (sx * 0.6, -2.315, 0.78), P['red'] if not wreck else P['char'], trim, P, -1)
        B.append(box((0.12, 0.03, 0.12), (sx * 0.38, -2.33, 0.78), P['amber'] if not wreck else P['char'], bevel=0.005))
    for yb, s in ((2.33, 1), (-2.33, -1)):
        B.append(box((1.8, 0.1, 0.13), (0, yb, 0.43), chrome, bevel=0.02))
        B.append(box((1.7, 0.02, 0.05), (0, yb + s * 0.05, 0.43), P['black'], bevel=0.005))
        for sx in (-1, 1):
            B.append(box((0.08, 0.1, 0.13), (sx * 0.88, yb - s * 0.05, 0.43), chrome, bevel=0.02))
    if not wreck:
        B.append(box((0.5, 0.01, 0.12), (0, 2.385, 0.43), pmat('plate_white', (0.7, 0.7, 0.66), 0.5), bevel=0.003))
        B.append(box((0.5, 0.01, 0.12), (0, -2.305, 0.6), pmat('plate_white', (0.7, 0.7, 0.66), 0.5), bevel=0.003))
    B.append(cyl(0.025, 0.25, (-0.5, -2.3, 0.3), P['dark'], rot=(90, 0, 0), verts=8))                               # exhaust
    B.append(box((1.4, 4.0, 0.08), (0, -0.05, 0.27), P['under'], bevel=0.01))                                       # floor pan
    # ---- interior
    B.append(box((1.6, 2.1, 0.02), (0, -0.24, 0.42), P['black'], bevel=0))
    B.append(box((1.6, 0.4, 0.2), (0, 0.72, 0.82), P['black'], bevel=0.05))
    B.append(cyl(0.02, 0.35, (-0.38, 0.55, 0.85), P['black'], rot=(60, 0, 0), verts=8))
    mb = MB()
    mb.lathe([(0.19 + 0.014 * math.cos(t * math.pi / 3), 0.014 * math.sin(t * math.pi / 3)) for t in range(6)], 18,
             T(-0.38, 0.42, 0.95) @ R('X', 30) @ AX_Z, P['black'], closed=True)
    B.append(mb.obj('steer', (-0.38, 0.42, 0.95)))
    for sx in (-1, 1):
        B.append(box((0.52, 0.5, 0.13), (sx * 0.38, 0.0, 0.55), seat, bevel=0.04))
        B.append(box((0.5, 0.12, 0.6), (sx * 0.38, -0.27, 0.86), seat, rot=(-14, 0, 0), bevel=0.04))
        B.append(box((0.26, 0.1, 0.18), (sx * 0.38, -0.33, 1.24), seat, rot=(-14, 0, 0), bevel=0.03))
    B.append(box((1.45, 0.5, 0.14), (0, -0.9, 0.54), seat, bevel=0.04))
    B.append(box((1.45, 0.14, 0.52), (0, -1.18, 0.84), seat, rot=(-18, 0, 0), bevel=0.04))
    B.append(box((1.45, 0.4, 0.02), (0, -1.36, 0.94), P['black'], bevel=0))
    # ---- wheels
    wheels = []
    for nm, (sx, yc) in {'wheel_fl': (-1, YF), 'wheel_fr': (1, YF), 'wheel_rl': (-1, YR), 'wheel_rr': (1, YR)}.items():
        if wreck:
            wheels.append(make_wheel(nm, (sx * WX, yc, RIM + 0.03), sx, RIM + 0.03, WW, RIM, P['rust'], P['rust'], P['char'], 'steel', 24, False, True, rust_m=P['rust']))
        else:
            wheels.append(make_wheel(nm, (sx * WX, yc, WR), sx, WR, WW, RIM, P['rubber'], P['dark'], chrome, 'hubcap', 24, False))
    root = empty(vid)
    if wreck:
        burn_drop(B, WR - RIM - 0.03, -1.2, 0.8)
        body = group('body', B + wheels, (0, 0, 0), root)
        limit_tris(body, 14800)
        auto_uv(body, H, Wd)
        return root, body
    body = group('body', B, (0, 0, 0), root)
    auto_uv(body, H, Wd)
    group('glass', G, (0, 0, 0), root)
    for w in wheels:
        attach(w, root)
    empty('seat_driver', (-0.38, -0.1, 1.2), root)
    empty('seat_passenger', (0.38, -0.1, 1.2), root)
    empty('seat_rear_l', (-0.4, -0.98, 1.18), root)
    empty('seat_rear_r', (0.4, -0.98, 1.18), root)
    empty('exit_l', (-1.3, 0.1, 0.0), root)
    empty('exit_r', (1.3, 0.1, 0.0), root)
    return root, body

# ------------------------------------------------------------------ burnt-out minibus (Coaster-like), static
def build_bus_wreck():
    P = common_mats()
    H, Wd = 2.65, 2.05
    img = grime_image('char_tex', lin(225, 225, 220), 1024, 41, char=True)
    paint = pmat('paint_burnt', (1, 1, 1), 0.92, 0.1, img=img)
    B = []
    YF, YR, WX, RIM = 1.9675, -1.9675, 0.86, 0.21
    HW = 1.015
    def arch(yc):
        return [(yc - 0.5, 0.2), (yc - 0.48, 0.8), (yc - 0.36, 0.96), (yc + 0.36, 0.96), (yc + 0.48, 0.8), (yc + 0.5, 0.2)]
    prof = [(3.12, 0.42), (3.13, 1.05), (3.09, 1.22), (2.86, 2.4), (2.72, 2.6), (2.5, 2.64), (-3.7, 2.64), (-3.84, 2.55),
            (-3.87, 2.3), (-3.87, 0.42)]
    sh = sp(prof, 2.4, paint, 0, 0)
    boolean(sh, xz_prism([(-HW, 0.3), (HW, 0.3), (HW, 2.4), (0.98, 2.55), (0.88, 2.63), (0.8, 2.645), (-0.8, 2.645), (-0.88, 2.63), (-0.98, 2.55), (-HW, 2.4)], -4, 3.5), 'INTERSECT')
    boolean(sh, sp(offset_poly(prof, 0.05), 2 * HW - 0.08, None, 0, 0))
    cuts = [sp(arch(yc), 0.7, None, sx * 0.95) for yc in (YF, YR) for sx in (-1, 1)]
    # Side windows, windshield, rear window, door (right front), driver's window.
    ys = [1.75 - k * 0.78 for k in range(7)]
    for sx in (-1, 1):
        for k, y in enumerate(ys):
            if sx > 0 and k == 0:
                continue
            cuts.append(box((0.4, 0.66, 0.62), (sx * HW, y - 0.35, 1.82), None, bevel=0))
    cuts.append(box((0.4, 0.62, 0.66), (-HW, 2.45, 1.82), None, bevel=0))
    cuts.append(box((0.4, 0.75, 1.9), (HW, 2.25, 1.3), None, bevel=0))                     # door opening
    psi = math.atan2(0.23, 1.18)
    cuts.append(box((1.8, 0.4, 1.1), (0, 2.97, 1.84), None, rot=(math.degrees(psi), 0, 0), bevel=0))
    cuts.append(box((1.7, 0.4, 0.7), (0, -3.87, 1.85), None, bevel=0))
    boolean(sh, cuts)
    bev(sh, 0.015, 1)
    B.append(sh)
    # Roof sag and holes burnt through: a few rust patches; roof skin partly collapsed inward.
    B.append(box((1.6, 1.2, 0.03), (0.1, -1.0, 2.5), P['rust'], rot=(4, -6, 0), bevel=0))
    # Bumpers, lamp holes, grille, step.
    for yb in (3.16, -3.9):
        B.append(box((2.0, 0.12, 0.22), (0, yb, 0.5), P['rust'], bevel=0.02))
    B.append(box((0.9, 0.03, 0.25), (0, 3.135, 0.85), P['char'], bevel=0.005))
    for sx in (-1, 1):
        B.append(box((0.26, 0.03, 0.16), (sx * 0.72, 3.135, 0.86), P['char'], bevel=0.005))
    B.append(box((0.5, 0.6, 0.04), (0.75, 2.25, 0.45), P['rust'], bevel=0.005))
    # Interior: floor, seat frames (rows), dash.
    B.append(box((1.9, 6.8, 0.03), (0, -0.4, 0.5), P['char'], bevel=0))
    B.append(box((1.9, 0.5, 0.35), (0, 2.75, 1.05), P['char'], bevel=0.02))
    for k in range(6):
        y = 1.3 - k * 0.82
        for sx in (-1, 1):
            if sx > 0 and k == 0:
                continue
            x = sx * 0.6
            B.append(box((0.8, 0.42, 0.04), (x, y, 0.92), P['rust'], rot=(0, 0, 0), bevel=0))
            B.append(box((0.8, 0.04, 0.5), (x, y - 0.22, 1.2), P['rust'], rot=(-8 - 6 * (k % 2), 0, 0), bevel=0))
            for lx in (-0.35, 0.35):
                B.append(box((0.03, 0.03, 0.42), (x + lx, y, 0.71), P['rust'], bevel=0))
    B.append(box((0.5, 0.5, 0.4), (-0.6, 2.3, 0.95), P['rust'], bevel=0.02))       # driver's seat remains
    # Chassis.
    for sx in (-1, 1):
        B.append(box((0.08, 6.4, 0.2), (sx * 0.5, -0.4, 0.38), P['rust'], bevel=0.005))
    B.append(cyl(0.05, 1.6, (0, YR, RIM + 0.03), P['rust'], rot=(0, 90, 0), verts=8))
    wheels = []
    for sx in (-1, 1):
        for yc in (YF, YR):
            wheels.append(make_wheel('w', (sx * WX, yc, RIM + 0.03), sx, RIM + 0.03, 0.22, RIM, P['rust'], P['rust'], P['char'], 'steel', 20, False, True, rust_m=P['rust']))
            if yc == YR:
                wheels.append(make_wheel('w', (sx * (WX - 0.25), yc, RIM + 0.03), sx, RIM + 0.03, 0.22, RIM, P['rust'], P['rust'], P['char'], 'steel', 20, False, True, rust_m=P['rust']))
    burn_drop(B, 0.39 - RIM - 0.03, 0.8, 0.5)
    root = empty('bus_wreck')
    body = group('body', B + wheels, (0, 0, 0), root)
    auto_uv(body, H, Wd)
    return root, body


# ------------------------------------------------------------------ driver
BUILDS = {
    'm1114': (lambda: build_m1114(False), (0, 0, 1.0), 10.5),
    'm1114_wreck': (lambda: build_m1114(True), (0, 0, 0.9), 10.5),
    'hilux_dshk': (lambda: build_hilux('dshk'), (0, 0, 0.95), 9.5),
    'pickup': (lambda: build_hilux('civil'), (0, 0, 0.85), 9.5),
    'pickup_wreck': (lambda: build_hilux('wreck'), (0, 0, 0.8), 9.5),
    'sedan': (lambda: build_sedan(False), (0, 0, 0.7), 9.0),
    'sedan_wreck': (lambda: build_sedan(True), (0, 0, 0.6), 9.0),
    'bus_wreck': (build_bus_wreck, (0, -0.3, 1.2), 13.0),
}

def run():
    os.makedirs(OUT, exist_ok=True)
    for vid, (fn, tgt, dist) in BUILDS.items():
        if ONLY and vid not in ONLY:
            continue
        reset()
        clear_mats()
        reset_cache()
        root, body = fn()
        n = tri_count(root)
        print('TRIS', vid, n)
        if PREV and not NOPREV:
            os.makedirs(PREV, exist_ok=True)
            for tag, az, el in (('front', 145, 14), ('side', -90, 6), ('rear', -35, 18), ('top', -60, 55), ('fl', -150, 10)):
                if tag not in VIEWS:
                    continue
                preview(os.path.join(PREV, f'{vid}_{tag}.png'), tgt, dist, az, el, res=(960, 540), lens=40, samples=12)
        vexport(os.path.join(OUT, f'{vid}.glb'), root)
        print('EXPORTED', vid)

run()

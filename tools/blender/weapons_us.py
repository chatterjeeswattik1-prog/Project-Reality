"""US Army small arms for PROJECT REALISM, built from code and exported one GLB per weapon.
    ~/blender-4.5.13-linux-x64/blender -b --factory-startup --python tools/blender/weapons_us.py -- public/models/weapons \
        [--preview tools/blender/previews] [--only m4a1,m249] [--fast] [--nobake]

Contract (CLAUDE.md, "Weapons"): root object <id>, +Y = muzzle forward, origin = firing-hand grip point, empties
muzzle / eye / cheek / grip_r / grip_l / eject / butt as children of the root, animated child meshes mag / box /
cover / bolt / pin / spoon. `eye` sits at the rear aperture / optic eyepiece on the sight line, `cheek` is where the
shooter's eye really is with a cheek weld (same line, eye relief behind `eye`); the game puts the camera there.

Every weapon is modelled in millimetres in a "weapon frame" (bore on the Y axis, z = 0 on the bore, y = 0 at the
rear of the receiver) and shifted so the grip point lands on the origin. Proportions were matched to side-view
photographs in tools/blender/src-assets/ref/us/ (US Army PEO Soldier / Wikimedia Commons) and public dimensions.
After building, each weapon is Smart-UV unwrapped into one atlas and a texture set is baked (wcommon_us.bake_weapon,
2048 px base colour + normal for the long guns, metal-rough capped at 1024):
ambient occlusion + edge-wear mask -> parkerised / anodised / polymer finishes with worn edges and roughness
variation, packed into the GLB as base colour + metallic-roughness."""
import os, sys, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy
from mathutils import Vector
from common import reset
from wcommon_us import (Part, TM, rr_pts, offset_path, wmat, clear_mats, make_object, make_empty, tri_count,
                        export_glb, render_views, bake_weapon, FINISH, sweep, add_decal_quads)

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = argv[0] if argv and not argv[0].startswith('--') else 'public/models/weapons'
PREV = argv[argv.index('--preview') + 1] if '--preview' in argv else None
ONLY = argv[argv.index('--only') + 1].split(',') if '--only' in argv else None
FAST = '--fast' in argv
SMALL = '--small' in argv
NOBAKE = '--nobake' in argv


def mats():
    """Finishes (linear RGB, no pure blacks). Parkerised steel is grey-green and rough, hard-anodised aluminium
    satin with a slight sheen, polymer matte; wear = how much lighter metal shows on exposed edges; pattern = the
    micro relief baked into the normal map (wcommon_us.PATTERNS)."""
    W = wmat
    anod = dict(rough=0.5, metal=0.15, wear=0.55, worn=(0.2, 0.2, 0.2), worn_rough=0.3, worn_metal=0.85, dust=0.15)
    park = dict(rough=0.62, metal=0.45, wear=0.55, worn=(0.22, 0.22, 0.21), worn_rough=0.3, worn_metal=0.95, dust=0.18)
    poly = dict(rough=0.76, metal=0.0, wear=0.12, worn=(0.075, 0.075, 0.072), worn_rough=0.62, ao=0.5, dust=0.2)
    acog = dict(rough=0.45, metal=0.3, wear=0.3, worn=(0.15, 0.15, 0.15), worn_rough=0.35, worn_metal=0.75)
    return dict(
        anod=W('anodized_black', (0.022, 0.022, 0.023), pattern='anod', **anod),
        knurl_a=W('anodized_knurled', (0.022, 0.022, 0.023), pattern='knurl', **anod),
        park=W('parkerized', (0.028, 0.029, 0.026), pattern='park', **park),
        knurl_p=W('parkerized_knurled', (0.028, 0.029, 0.026), pattern='knurl', **park),
        poly=W('polymer_black', (0.04, 0.04, 0.039), pattern='poly', **poly),
        stip=W('polymer_stippled', (0.042, 0.042, 0.041), pattern='stipple', **poly),
        grip=W('polymer_grip', (0.04, 0.04, 0.039), pattern='grip', smudge=0.7, **poly),
        acog=W('acog_anodized', (0.045, 0.046, 0.049), pattern='sand', **acog),
        knurl_g=W('acog_knurled', (0.045, 0.046, 0.049), pattern='knurl', **acog),
        rubber=W('rubber', (0.028, 0.028, 0.028), 0.9, 0.0, wear=0.05, worn=(0.05, 0.05, 0.05), ao=0.5, pattern='rubber', smudge=0.3),
        steel=W('bolt_steel', (0.07, 0.07, 0.068), 0.34, 0.85, wear=0.5, worn=(0.3, 0.3, 0.28), worn_rough=0.22, worn_metal=1.0, pattern='smooth', dust=0.05),
        dark=W('cavity', (0.015, 0.015, 0.014), 0.85, 0.0, ao=0.3, grain=0.0, dust=0.0),
        glass=W('lens', (0.01, 0.014, 0.02), 0.04, 0.2, baked=False),
        glass_amber=W('lens_coated', (0.03, 0.02, 0.012), 0.04, 0.4, baked=False),
        fiber=W('fiber_red', (0.5, 0.03, 0.02), 0.3, 0.0, emit=(1.0, 0.06, 0.02, 0.8)),
        tan=W('tan_polymer', (0.2, 0.165, 0.11), 0.7, 0.0, wear=0.2, worn=(0.3, 0.26, 0.19), pattern='poly', dust=0.15),
        od=W('olive_drab', (0.1, 0.11, 0.062), 0.62, 0.0, wear=0.25, worn=(0.2, 0.2, 0.16), worn_rough=0.5, pattern='poly', fill=(0.02, 0.02, 0.018)),
        od_poly=W('olive_polymer', (0.085, 0.095, 0.06), 0.72, 0.0, wear=0.2, worn=(0.15, 0.16, 0.12), grain=0.12, pattern='stipple', smudge=0.3),
        brass=W('brass', (0.62, 0.43, 0.15), 0.3, 1.0, ao=0.4, pattern='smooth', dust=0.05),
        copper=W('copper', (0.6, 0.3, 0.15), 0.35, 1.0, ao=0.4, pattern='smooth', dust=0.05),
        mag=W('mag_aluminium', (0.055, 0.056, 0.052), 0.5, 0.3, wear=0.35, worn=(0.2, 0.2, 0.19), worn_rough=0.35, worn_metal=0.8, pattern='sand'),
        canvas=W('canvas_coyote', (0.2, 0.19, 0.15), 0.93, 0.0, wear=0.15, worn=(0.3, 0.28, 0.22), grain=0.12, pattern='canvas', dust=0.25),
        nylon=W('nylon_webbing', (0.028, 0.027, 0.025), 0.9, 0.0, wear=0.08, worn=(0.06, 0.058, 0.054), grain=0.1, pattern='weave', dust=0.08),
        red=W('red_paint', (0.45, 0.035, 0.025), 0.5),
        yellow=W('yellow_paint', (0.55, 0.42, 0.04), 0.55),
        white=W('white_paint', (0.6, 0.6, 0.56), 0.6),
        green=W('green_paint', (0.08, 0.38, 0.08), 0.55),
        wood=W('grip_black', (0.04, 0.038, 0.035), 0.68, 0.0, wear=0.15, worn=(0.08, 0.075, 0.07), pattern='grip', smudge=0.6),
    )


class Gun:
    def __init__(self, gid):
        self.id = gid
        self.parts = {}
        self.E = {}
        self.grip = Vector((0, 0, 0))
        self.body = self.part('body')
        self.tex = 2048 if gid in ('m4a1', 'm4a1_m203', 'm16a4', 'm249', 'm240b', 'm24') else 1024
        self.hip = True       # render the hip view (camera 0.18 m right, 0.12 m up, 0.25 m behind the grip)
        self.decals = []      # stamped markings (wcommon_us.decal_images)

    def mark(self, text, y, z, h, side, fill=False, **kw):
        """Stamped marking (wcommon_us.add_decal_quads); obj='charge' etc. puts it on a moving part instead of the body."""
        d = dict(text=text, y=y, z=z, h=h, side=side, fill=fill); d.update(kw)
        self.decals.append(d)

    def sling(self, P, a, b_, sag, bow, w=32.0, n=28):
        """Loose 1.25 in nylon sling hanging between two attachment points (catenary-ish, bowing sideways)."""
        a, b_ = Vector(a), Vector(b_)
        pts = []
        for i in range(n + 1):
            t = i / n
            p = a.lerp(b_, t)
            p.z -= sag * 4 * t * (1 - t) * (1 - 0.15 * t)
            p.x += bow * math.sin(math.pi * t)
            pts.append(tuple(p))
        sweep(self.body, pts, w, 1.6, P['nylon'])
        for q in (a, b_):
            self.body.torus(5, 1.4, tuple(q), P['park'], (0, 0, 90), 12, 6)

    def part(self, name, pivot=(0, 0, 0)):
        p = Part(name, pivot)
        self.parts[name] = p
        return p

    def e(self, name, p, parent=None):
        """Empty at p (mm, weapon frame). parent = name of a part (e.g. 'mag', 'charge'): the empty becomes a child of
        that part's object and follows it when the game animates it."""
        self.E[name] = (tuple(p), parent)

    def cheek(self, eye, back, name='cheek'):
        """Cheek-weld eye point: `back` mm behind `eye` along the bore direction (sight lines are bore-parallel)."""
        c = (eye[0], eye[1] - back, eye[2])
        self.e(name, c)
        return c

    def build(self):
        root = bpy.data.objects.new(self.id, None)
        bpy.context.scene.collection.objects.link(root)
        root.empty_display_size = 0.05
        objs = [make_object(p, self.grip, root) for p in self.parts.values() if p.F]
        by = {o.name: o for o in objs}
        for n, (p, parent) in self.E.items():
            if parent:
                make_empty(n, p, self.parts[parent].pivot, by[parent])
            else:
                make_empty(n, p, self.grip, root)
        return root, objs


# =====================================================================================================
# Shared parts
# =====================================================================================================
def aperture(b, m, x, y, zc, R=6.0, rh=1.6, th=2.5, base_z=None, w=None):
    """Peep-sight aperture: a washer you can see through, on an optional plate below it."""
    b.lathe_y([(y - th / 2, rh), (y - th / 2, R), (y + th / 2, R), (y + th / 2, rh)], x=x, z=zc, m=m, n=20, closed=True)
    if base_z is not None:
        h = zc - R * 0.7 - base_z
        b.box((w or R * 1.6, th, h), (x, y, base_z + h / 2), m, bevel=0.5)


def a2_grip(b, top, P, ang=27.0, m=None):
    """A2 pistol grip: finger nub between middle and ring finger, palm swell, rounded bottom. Returns palm point."""
    secs = [(-8, 36, 24, 9, 0.5), (4, 35, 25.5, 10, 0), (20, 31.5, 26.5, 11, -1.8), (34, 33.5, 27, 11.5, 0.6),
            (46, 36.5, 27.5, 12, 2.2), (57, 33, 27.5, 11.5, 0.2), (72, 32, 28, 11.5, -1.0), (88, 34.5, 28.5, 12, 0.6),
            (99, 35, 28, 12, 0.6), (106, 32, 26, 10, 0), (109.5, 23, 19, 7, 0)]
    b.loft_axis_spline(top, ang, secs, m or P['grip'], steps=2, n=4)
    return Vector(b.axis_pt(top, ang, 50, -2))


def a2_flash_hider(b, y0, m, r=11.0, slots=(0, 60, 120, 240, 300), slot_w=16.0, L=42.0):
    """A2 'birdcage': solid rear, slotted front (closed bottom on the A2), front ring."""
    b.lathe_y([(y0 - 3, 8.5), (y0 - 3, r - 0.3), (y0, r - 0.3), (y0, 8.5)], m=m, n=24, closed=True)
    s0, s1 = y0 + L * 0.38, y0 + L * 0.86
    b.lathe_y([(y0, 4.6), (y0, r - 0.6), (y0 + 1.2, r), (s0, r), (s0, 6.4)], m=m, n=24, closed=True)
    angs = sorted(a % 360 for a in slots)
    for i, a in enumerate(angs):
        a_next = angs[(i + 1) % len(angs)] + (360 if i == len(angs) - 1 else 0)
        b.lathe_y([(s0, 6.4), (s0, r), (s1, r), (s1, 7.0)], m=m, n=max(2, int((a_next - a) / 10)), closed=True,
                  a0=a + slot_w / 2, a1=a_next - slot_w / 2)
    b.lathe_y([(s1, 7.0), (s1, r), (y0 + L - 1, r), (y0 + L, r - 0.9), (y0 + L, 7.4)], m=m, n=24, closed=True)
    return y0 + L


def stanag(g, P, top, L=172.0):
    """30-round aluminium STANAG magazine (part 'mag'): straight top, ~14 deg curve, stamped side ribs."""
    mg = g.part('mag', (0, top[0], top[1]))

    def frame(t):
        y, z, phi, tt = top[0], top[1], 0.0, 0.0
        while tt < t - 1e-6:
            dt = min(2.0, t - tt)
            phi = math.radians(max(0.0, (tt - 55) / (L - 55) * 14.0))
            y += math.sin(phi) * dt
            z -= math.cos(phi) * dt
            tt += dt
        return Vector((0, y, z)), Vector((0, math.cos(phi), math.sin(phi)))

    def ring(t, dep, w, r, sh=0.0, n=3):
        c, nf = frame(t)
        c = c + nf * sh
        return [tuple(c + nf * u + Vector((v, 0, 0))) for u, v in rr_pts(dep, w, r, n)]

    ts = [0, 20, 40, 60, 80, 100, 120, 140, 160, L]
    mg.loft([ring(t, 63, 22.2, 3) for t in ts], P['mag'])
    for sh in (-22, -9, 13):                                     # stamped ribs, both sides
        mg.loft([ring(t, 5, 23.4, 2.2, sh, 2) for t in ts[3:-1] + [L - 7]], P['mag'])
    mg.loft([ring(L - 2, 67.5, 25.5, 4), ring(L + 2, 68, 26, 4.5), ring(L + 6, 66, 25, 4)], P['poly'])
    mg.loft([ring(1, 46, 20, 3), ring(-4, 44, 18, 3)], P['steel'])  # feed lips
    mg.loft([ring(-3.5, 40, 12, 3), ring(-6, 36, 10, 3)], P['dark'])  # follower / top round
    # Reload nodes: origin = top centre (straight top section, inserted straight up), withdrawn straight down.
    g.e('mag_dir', (0, top[0], top[1] - 120))
    c, nf = frame(80)
    g.e('hand_mag', (-(22.2 / 2 + 12), c.y + 8, c.z), 'mag')
    return mg


def acog_ta31(b, P, ye, A, deck=30.0):
    """Trijicon TA31 4x32 ACOG on its flat-top mount. ye = rear face of the eyepiece, A = optical axis height.
    Shape after the PEO M150 photo: big objective tube, prism housing whose top slopes down to the eyepiece,
    fibre-optic housing on top of the front, elevation cap on top and windage cap on the right, rear behind them."""
    m, gl, kn = P['acog'], P['glass'], P['knurl_g']
    b.lathe_y([(ye, 12.2), (ye, 16.6), (ye + 1.5, 17.4), (ye + 9, 17.4), (ye + 11, 15.8), (ye + 24, 15.4),
               (ye + 24, 12.2)], z=A, m=m, n=32, closed=True)
    b.lathe_y([(ye + 1.5, 17.3), (ye + 1.5, 17.9), (ye + 8.5, 17.9), (ye + 8.5, 17.3)], z=A, m=kn, n=32, closed=True)
    # Rubber eye guard.
    b.lathe_y([(ye - 9, 14.6), (ye - 9, 18.4), (ye - 7.5, 19.3), (ye - 3, 18.9), (ye + 0.5, 17.6), (ye + 3, 17.0),
               (ye + 3, 14.6)], z=A, m=P['rubber'], n=32, closed=True)
    b.tube(13.5, ye + 3.5, ye + 4.2, 0, A, gl, 24)
    b.loft_spline([(ye + 20, A + 15.5, A - 15.5, 31, 10), (ye + 40, A + 16.5, A - 17, 35, 10),
                   (ye + 72, A + 19.5, A - 18, 37.5, 10), (ye + 100, A + 21.5, A - 18, 38.5, 11),
                   (ye + 108, A + 21, A - 18, 38, 15)], m, steps=3, n=4)
    b.lathe_y([(ye + 100, 17), (ye + 100, 20.8), (ye + 124, 21.3), (ye + 131, 22.7), (ye + 147, 22.9),
               (ye + 147, 19.2), (ye + 142, 18.8)], z=A, m=m, n=32, closed=True)
    b.lathe_y([(ye + 138, 22.8), (ye + 138, 23.4), (ye + 144, 23.4), (ye + 144, 22.8)], z=A, m=m, n=32, closed=True)
    b.tube(18.9, ye + 141.2, ye + 141.8, 0, A, P['glass_amber'], 28)
    # Fibre-optic housing on the front top, with the exposed red fibre and its slotted guard.
    top = [(ye + 52, A + 16.5), (ye + 108, A + 19)]
    b.extrude([(ye + 50, A + 14), (ye + 109, A + 16), (ye + 109, A + 25.5), (ye + 100, A + 27), (ye + 60, A + 22.5),
               (ye + 50, A + 19)], 13, m, 'x', 0, bevel=2.0)
    b.rod((0, ye + 58, A + 22.9), (0, ye + 101, A + 27.6), 1.7, P['fiber'], 10)      # fibre-optic tube
    for i in range(5):
        y = ye + 64 + i * 8.5
        b.box((14, 4.5, 3.2), (0, y, A + 23.4 + (y - ye - 60) * 0.11), m, bevel=0.6)
    # Adjuster caps (knurled) and the tritium/fibre window.
    b.cyl(9.4, 10, (0, ye + 38, A + 18), kn, n=32, bevel=1.2)
    b.cyl(8.2, 2.5, (0, ye + 38, A + 23.5), m, n=32, bevel=0.6)
    b.cylx(9.4, 16, 25.5, ye + 38, A - 1, kn, 32, bevel=1.2)
    b.cylx(8.2, 25, 27.5, ye + 38, A - 1, m, 32, bevel=0.6)
    # Mount: rail clamp base with recoil lugs, riser, two knurled thumb nuts on the left.
    b.box2((-12.5, ye + 26, deck), (12.5, ye + 112, deck + 11), m, bevel=1.5)
    b.box2((-11, ye + 32, deck + 10), (11, ye + 106, A - 17), m, bevel=1.5)
    b.box2((-15, ye + 28, deck + 1), (-12, ye + 110, deck + 9), m, bevel=1.0)         # clamp bar
    for yy in (ye + 44, ye + 94):
        b.cylx(8.5, -22, -14.5, yy, deck + 5, kn, 24, bevel=0.8)
        b.cylx(3.2, 12.4, 14.5, yy, deck + 5, P['park'], 10)
    return (0, ye - 9, A)


def buis_folded(b, P, y0, deck):
    """Flip-up rear back-up iron sight (KAC style), folded flat behind the optic."""
    m = P['anod']
    b.box2((-11, y0, deck), (11, y0 + 16, deck + 6), m, bevel=1.2)
    b.box2((-13.5, y0 + 1, deck + 0.5), (-11, y0 + 15, deck + 5), m, bevel=0.8)
    b.extrude([(y0 + 1, deck + 6), (y0 + 22, deck + 6), (y0 + 22, deck + 9.5), (y0 + 3, deck + 10)], 17, m, 'x', 0,
              bevel=1.0)
    b.cylx(3.6, 9.5, 12.5, y0 + 4, deck + 7.5, m, 12, bevel=0.5)
    b.cylx(5.5, -17, -13.5, y0 + 8, deck + 3, P['knurl_a'], 16, bevel=0.6)


def peq15(b, P, y0, deck):
    """AN/PEQ-15 ATPIAL on the top rail (tan)."""
    m = P['tan']
    b.loft_spline([(y0, deck + 31, deck + 4, 52, 5, 5), (y0 + 6, deck + 32, deck + 4, 54, 6, 5),
                   (y0 + 100, deck + 32, deck + 4, 54, 6, 5), (y0 + 106, deck + 31, deck + 4, 52, 5, 5)], m, steps=1, n=3)
    b.box2((-12, y0 + 22, deck), (12, y0 + 80, deck + 5), m, bevel=1)
    b.cylx(5, -17, -12, y0 + 52, deck + 2.5, m, 14, bevel=0.6)
    for x, z, r in ((-10, deck + 22, 6.5), (11, deck + 22, 6.5), (22, deck + 11, 4.5)):
        b.tube(r + 1.5, y0 + 104, y0 + 107.5, x + 5, z, m, 20, bevel=0.6)
        b.tube(r, y0 + 107, y0 + 107.8, x + 5, z, P['glass'], 20)
    b.box2((-8, y0 + 104, deck + 6), (6, y0 + 108, deck + 14), P['glass'], bevel=0.8)
    for i in range(3):
        b.cyl(3.4, 3, (-8 + i * 11, y0 + 20, deck + 33), P['rubber'], n=12, bevel=0.6)
    b.cyl(5.5, 5, (18, y0 + 40, deck + 33.5), m, n=18, bevel=1)


# =====================================================================================================
# AR family (M4A1, M4A1 + M203, M16A4)
# =====================================================================================================
RT = 30.0  # rail top above the bore (flat-top upper and RAS)


AR_CHARGE = (0.0, -4.5, 15.0)   # charging-handle T centre at rest (part 'charge' origin); travel 70 mm


def ar_upper(g, b, P):
    an, dk, st = P['anod'], P['dark'], P['steel']
    pc = b.sub()
    sec = [(-13, -15), (13, -15), (13.2, 7), (11.6, 13), (9.4, 16.6), (9.4, 21.6), (-9.4, 21.6), (-9.4, 16.6),
           (-11.6, 13), (-13.2, 7)]
    pc.extrude(sec, 181, an, 'y', -1, bevel=1.0)
    ct = b.sub()
    ct.box2((9.0, 72, -8.5), (16, 128, 7.5), dk, bevel=0)               # ejection port
    ct.box2((-6.5, -4, 9.5), (6.5, 30, 19), dk, bevel=0)                # charging handle channel
    b.add_cut(pc, ct)
    b.pic_rail(0.5, 179.5, TM((0, 0, 21.6)), an)
    # Bolt carrier + bolt inside, seen through the port (part 'charge': travels back with the charging handle).
    ch = g.part('charge', AR_CHARGE)
    ch.lathe_y([(4, 0), (4, 12.3), (118, 12.3), (118, 0)], m=st, n=24)
    ch.lathe_y([(118, 0), (118, 9.6), (160, 9.6), (160, 0)], m=st, n=18)
    ch.box((3, 6, 5), (8.6, 96, 10.5), st, bevel=0.6)                    # cam pin head
    ch.box((3, 18, 4), (9.4, 140, 0), st, bevel=0.5)                     # extractor
    # Dust cover, open (hanging from its hinge rod below the port), with its stiffening ribs.
    b.tube(1.4, 69, 131, 13.8, -10, P['park'], 10)
    b.extrude([(13.4, -9.2), (15.3, -10.2), (18.8, -25.0), (16.9, -25.6)], 58, an, 'y', 71, bevel=0.4)
    for y in (84, 116):
        b.extrude([(16.9, -12), (18.0, -12), (20.6, -23.4), (19.4, -23.8)], 4, an, 'y', y, bevel=0.3)
    # Brass deflector, forward assist (teardrop housing angled out, round plunger).
    b.extrude([(12.5, 49), (12.5, 71), (18.6, 68.5), (18.6, 60)], 18, an, 'z', -3.5, bevel=1.6)
    for s_ in (-1, 1):                                                    # side ridges above the port line
        b.box2((s_ * 12.4 - 1.2, 14, 7.6), (s_ * 12.4 + 1.2, 177, 10.4), an, bevel=0.6) if s_ < 0 else \
            b.box2((11.6, 20, 7.6), (14.0, 177, 10.4), an, bevel=0.6)
    b.lathe([(0, 0), (0, 7.8), (5, 8.3), (24, 7.9), (34, 6), (42, 0)], an, (17, 6, 9), (0, 0, 8), 24)
    b.lathe([(-7.5, 0), (-7.5, 5.0), (-7, 6.6), (-6, 7.3), (1, 7.3), (1, 0)], P['knurl_p'], (17, 6, 9), (0, 0, 8), 24)
    for yy in (-4.5, -2):
        b.lathe([(yy, 7.1), (yy, 7.5), (yy + 0.8, 7.5), (yy + 0.8, 7.1)], dk, (17, 6, 9), (0, 0, 8), 24, closed=True)
    b.box2((12, 10, 0.5), (14.6, 46, 12), an, bevel=1.2)
    # Charging handle (T) with its latch, the shaft in the channel.
    ch.extrude([(-24, -6.5), (-24, -2), (-7, 0.5), (7, 0.5), (24, -2), (24, -6.5), (7, -9.5), (-7, -9.5)], 7, an, 'z', 11.5,
               bevel=1.3)
    ch.box2((-5.5, -3, 12), (5.5, 30, 18.5), an, bevel=0.6)
    ch.extrude([(-24, -3), (-19, -1), (-12, -1), (-12, -6), (-24, -6)], 3, P['knurl_a'], 'z', 18.6, bevel=0.6)
    g.e('charge_back', (AR_CHARGE[0], AR_CHARGE[1] - 70, AR_CHARGE[2]))
    g.e('hand_charge', (0, -5, 15), 'charge')
    # Barrel nut + delta ring with its weld-spring cap.
    b.lathe_y([(176, 0), (176, 16.5), (197, 16.5), (197, 0)], m=P['park'], n=24)
    b.lathe_y([(181, 0), (181, 24), (183, 28.6), (192, 28.6), (194, 25.5), (196, 24), (196, 0)], m=an, n=32)
    for k in range(16):
        a = k * 22.5
        ar = math.radians(a)
        b.box((2, 9, 1.2), (28.8 * math.sin(ar), 187.5, 28.8 * math.cos(ar)), dk, (0, a, 0), bevel=0)


def ar_lower(b, P, g):
    an, pk, dk = P['anod'], P['park'], P['dark']
    b.extrude([(-3, -15), (186, -15), (186, -21), (181, -29), (108, -29), (104, -40), (50, -40), (46, -44), (14, -44),
               (4, -41), (-3, -33)], 24, an, 'x', 0, bevel=1.0)
    mw = b.sub()
    mw.extrude([(105, -18), (178, -18), (179.5, -68), (107.5, -68), (105, -63)], 29.5, an, 'x', 0, bevel=1.2)
    mw.extrude([(103, -61), (181, -61), (182, -69), (179, -75.5), (107, -75.5), (103, -71)], 32.4, an, 'x', 0, bevel=1.5)
    ct = b.sub()
    ct.box2((-11.7, 108.6, -95), (11.7, 175.6, -26), dk, bevel=0)
    b.add_cut(mw, ct)
    # Magazine release (right) with its fence, bolt catch (left), selector at SAFE (left).
    b.cylx(4.8, 11.5, 16.0, 99, -30, P['knurl_p'], 16, bevel=0.6)
    for zz in (-22.5, -37.5):
        b.box((3, 16, 3.2), (14.5, 99, zz), an, bevel=0.8)
    b.extrude([(86, -18), (98, -18), (98, -33), (92, -36), (86, -30)], 2.4, P['knurl_a'], 'x', -13.6, bevel=0.6)
    b.cylx(2, -14.8, -12, 92, -20, pk, 8)
    b.cylx(5.6, -14.0, -11.5, 33, -29, an, 18, bevel=0.6)
    b.extrude([(30, -26.8), (52, -27.6), (53.5, -30.6), (30, -31.2)], 2.2, an, 'x', -15, bevel=0.6)
    b.cylx(4.0, 11.5, 13.2, 33, -29, an, 14, bevel=0.4)
    for yy, zz, r in ((6, -21, 3.3), (182, -21, 3.3), (52, -29, 2.3), (68, -31, 2.3)):
        b.cylx(r, -12.9, 12.9, yy, zz, pk, 12, bevel=0.3)
    b.extrude([(103, -40), (101, -58), (95, -63.5), (52, -63.5), (46, -58), (44, -42), (49, -42), (51, -56), (56, -59.5),
               (93, -59.5), (97, -55), (99, -40)], 12.6, an, 'x', 0, bevel=0.8)
    b.cylx(2, -6.6, 6.6, 100, -42, pk, 8)
    b.extrude([(64, -40), (69, -40), (70, -47), (67.5, -54), (62.5, -58.5), (63.5, -53.5), (65, -47)], 6, pk, 'x', 0, bevel=0.5)
    g.grip = a2_grip(b, (24, -42), P)
    g.e('grip_r', g.grip)


def ar_buffer_m4stock(b, P, YB):
    an, po, dk = P['anod'], P['poly'], P['dark']
    b.lathe_y([(YB + 50, 0), (YB + 50, 14.6), (-3, 14.6), (-3, 0)], z=-2, m=an, n=28)
    b.box2((-3.6, YB + 55, -19.5), (3.6, -14, -15), an, bevel=0.8)       # indexing rib with the 6 position holes
    for i in range(6):
        b.cyl(1.7, 1.4, (0, YB + 70 + i * 19, -19.6), dk, n=10)
    b.lathe_y([(-13, 14.6), (-13, 17.8), (-4, 17.8), (-4, 14.6)], z=-2, m=an, n=24, closed=True)   # castle nut
    for k in range(6):
        a = math.radians(k * 60 + 30)
        b.box((3.4, 4, 3.4), (17.9 * math.sin(a), -11, -2 + 17.9 * math.cos(a)), dk, (0, k * 60 + 30, 0), bevel=0)
    b.box2((-16, -4.5, -26), (16, -1.5, 8), an, bevel=1)                 # receiver end plate
    b.torus(6.5, 1.8, (-21, -3, -6), P['park'], (0, 0, 0), 14, 8)        # sling loop
    # Original M4 6-position telestock, fully extended minus one position (from the PEO photo, ~100 mm butt).
    st = b.sub()
    st.loft_spline([(YB + 2, 16.5, -86, 40.5, 8), (YB + 30, 16.5, -79, 40, 9), (YB + 80, 16, -57, 38, 9),
                    (YB + 108, 15.5, -36, 36, 9), (YB + 128, 15.5, -30, 34, 9), (YB + 166, 15, -27, 33, 9),
                    (YB + 180, 14.5, -20, 32, 10)], po, steps=2, n=4)
    ct = b.sub()
    for s in (-1, 1):
        ct.extrude([(YB + 12, -11), (YB + 100, -11), (YB + 100, -31), (YB + 64, -50), (YB + 12, -72)], 4, po, 'x', s * 21.3)
    ct.extrude([(YB + 7, -64), (YB + 17, -60), (YB + 17, -76), (YB + 7, -80)], 60, dk, 'x', 0)
    b.add_cut(st, ct)
    b.loft_spline([(YB - 8, 16, -85, 40, 9), (YB - 5, 17.2, -87, 41, 9.5), (YB + 3, 17.2, -87, 41, 9.5)], P['rubber'], steps=1, n=4)
    for i in range(6):
        b.box((32, 0.8, 2), (0, YB - 8.3, 8 - i * 15), dk, bevel=0)
    b.box2((-7.5, YB + 128, -33), (7.5, YB + 170, -25), po, bevel=2.2)  # adjustment lever housing
    b.box2((-5, YB + 140, -37), (5, YB + 162, -32), po, bevel=1.5)


def ar_a2_stock(b, P, YB):
    an, po, pk, dk = P['anod'], P['poly'], P['park'], P['dark']
    b.loft_spline([(-1, 15, -43, 32, 8), (-40, 16, -48, 34.5, 9), (-160, 18, -71, 38, 11), (YB + 14, 20, -96, 42, 12),
                   (YB + 7, 20, -98, 42.5, 12)], po, steps=2, n=4)
    b.loft_spline([(YB, 21, -100, 43.5, 12), (YB + 4, 21.2, -100.5, 43.6, 12), (YB + 8, 21, -99, 43, 12)], po, steps=1, n=4)
    b.box2((-14, YB - 0.6, -46), (14, YB + 1, -12), dk, bevel=0)          # trapdoor outline
    b.box2((-12.5, YB - 1.2, -44.5), (12.5, YB + 1, -13.5), po, bevel=0.8)
    for i in range(7):
        b.box((38, 1.2, 1.6), (0, YB - 0.8, 12 - i * 3), po, bevel=0)
    b.box((9, 16, 7), (0, YB + 30, -99), pk, bevel=1.5)
    b.torus(10, 1.8, (0, YB + 30, -110), pk, (0, 0, 90), 16, 8)
    b.lathe_y([(-3, 0), (-3, 16), (0, 16), (0, 0)], z=-2, m=an, n=20)


def ras(b, P, R0, R1, covers=False):
    """KAC RAS: octagonal hollow shell, rails on the four flats, round vent holes in the four chamfers."""
    an, po, dk = P['anod'], P['poly'], P['dark']
    oct_o = [(-11, -22), (11, -22), (22, -11), (22, 11), (11, 22), (-11, 22), (-22, 11), (-22, -11)]
    oct_i = [(x * 0.86, z * 0.86) for x, z in oct_o]
    pc = b.sub()
    pc.extrude(oct_o, R1 - R0, an, 'y', R0, bevel=1.2)
    ct = b.sub()
    ct.extrude(oct_i, R1 - R0 + 20, dk, 'y', R0 - 10, bevel=0)
    n = int((R1 - R0 - 24) // 18)
    y0 = R0 + (R1 - R0 - (n - 1) * 18) / 2
    for a in (45, 135, 225, 315):
        ar = math.radians(a)
        d = Vector((math.sin(ar), 0, math.cos(ar)))
        for i in range(n):
            c = Vector((0, y0 + i * 18, 0))
            ct.rod(tuple(c + d * 10), tuple(c + d * 30), 4.6, dk, 14)
    b.add_cut(pc, ct)
    for yy in (R0, R1 - 6):
        b.extrude([(x * 1.07, z * 1.07) for x, z in oct_o], 6, an, 'y', yy, bevel=1.2)
    rails = {'top': TM((0, 0, 21.6)), 'bot': TM((0, 0, -21.6), (0, 180, 0)),
             'right': TM((21.6, 0, 0), (0, 90, 0)), 'left': TM((-21.6, 0, 0), (0, -90, 0))}
    for side, fr in rails.items():
        if covers and side != 'top':
            # KAC ladder rail covers.
            b.extrude([(-10.8, 0), (10.8, 0), (10.8, 6.8), (8.4, 9.6), (-8.4, 9.6), (-10.8, 6.8)], R1 - R0 - 20, P['stip'],
                      'y', R0 + 10, mat=fr, bevel=0.8)
            k = int((R1 - R0 - 26) // 10)
            for i in range(k):
                b.extrude([(-8.5, 9.0), (8.5, 9.0), (8.5, 10.6), (-8.5, 10.6)], 5, po, 'y', R0 + 13 + i * 10, mat=fr,
                          bevel=0.4)
        else:
            b.pic_rail(R0 + 7, R1 - 7, fr, an)


def a2_fsb(b, P, FS):
    """A2 front sight base: barrel clamp, gas block, bayonet lug, sling swivel, open A-frame with the ears and
    the square post (tip 66 mm above the bore = the 2.6 in AR sight height)."""
    pk, dk = P['park'], P['dark']
    b.lathe_y([(FS, 9.6), (FS, 13.8), (FS + 2, 14.6), (FS + 36, 14.6), (FS + 38, 13.8), (FS + 38, 9.6)], m=pk, n=24,
              closed=True)
    b.box2((-10, FS + 2, 6), (10, FS + 36, 17), pk, bevel=2.0)             # gas block top
    b.box2((-4.5, FS + 22, -26), (4.5, FS + 38, -12), pk, bevel=1.2)       # bayonet lug
    b.box2((-5, FS + 4, -22), (5, FS + 14, -12), pk, bevel=1.2)
    b.cylx(1.6, -5.4, 5.4, FS + 9, -18, dk, 8)
    b.torus(8.5, 1.8, (0, FS + 9, -28.5), pk, (0, 0, 90), 16, 8)          # sling swivel
    for s in (-1, 1):
        b.cylx(1.5, s * 10.2 - 0.6, s * 10.2 + 0.6, FS + 8, 12, dk, 8)    # taper pins
        b.cylx(1.5, s * 10.2 - 0.6, s * 10.2 + 0.6, FS + 30, 12, dk, 8)
    # A-frame: sloped rear leg, near-vertical front leg, apex with the two protective ears.
    b.extrude([(FS + 2, 14), (FS + 13, 14), (FS + 25, 50), (FS + 17, 54)], 12, pk, 'x', 0, bevel=1.4)
    b.extrude([(FS + 26, 14), (FS + 38, 14), (FS + 36.5, 54), (FS + 28, 54)], 12, pk, 'x', 0, bevel=1.4)
    b.extrude([(FS + 17, 48), (FS + 36.5, 48), (FS + 36.5, 53), (FS + 18, 54)], 12, pk, 'x', 0, bevel=1.0)
    for s in (-1, 1):
        b.extrude([(FS + 18, 50), (FS + 36.5, 50), (FS + 35.5, 64.5), (FS + 23, 64.5)], 2.6, pk, 'x', s * 4.9, bevel=0.6)
    b.cyl(3.2, 3, (0, FS + 29, 54.5), pk, n=14, bevel=0.5)                 # detent / post base
    b.box((2.2, 2.2, 11), (0, FS + 29, 60.5), pk, bevel=0.3)               # front sight post, tip z = 66
    b.tube(2.5, 175, FS + 3, 0, 13, pk, 10)                                # gas tube
    return (0, FS + 29, 66)


def vfg(b, P, yf):
    po, an = P['poly'], P['anod']
    b.box2((-11.5, yf - 22, -36), (11.5, yf + 22, -30), po, bevel=1.5)
    b.box2((-13.5, yf - 18, -35), (-11, yf + 18, -31), an, bevel=0.8)
    b.cylx(4.5, -18, -13.5, yf, -33, an, 14, bevel=0.6)
    gp = P['grip']
    b.lathe([(0, 0), (0, 15.6), (8, 16.2), (80, 15.4), (90, 14.6), (95, 11), (96, 0)], gp, (0, yf, -35), (-90, 0, 0), 28)
    for i in range(9):
        b.lathe([(0, 15.3), (0, 16.6), (3.2, 16.6), (3.2, 15.3)], gp, (0, yf, -48 - i * 7), (-90, 0, 0), 28, closed=True)
    return (0, yf, -78)


def ar15(g, P, kind):
    b = g.body
    carbine = kind != 'm16a4'
    FS = 340.0 if carbine else 490.0           # front sight base, rear face
    YMZ = 161 + (368 if carbine else 508)      # barrel muzzle (bolt face at y=161)
    YB = -255.0 if carbine else -295.0         # rear of the butt
    R0, R1 = 197.0, FS - 2
    an, pk, po = P['anod'], P['park'], P['poly']
    ar_upper(g, b, P)
    ar_lower(b, P, g)
    if carbine:
        ar_buffer_m4stock(b, P, YB)
        g.e('butt', (0, YB - 8, (17 - 87) / 2))
    else:
        ar_a2_stock(b, P, YB)
        g.e('butt', (0, YB - 1, -40))
    ras(b, P, R0, R1, covers=(kind == 'm16a4'))
    b.lathe_y([(176, 0), (176, 9.6), (FS + 52, 9.6), (FS + 52, 8.0), (FS + 62, 8.0), (FS + 62, 9.2), (YMZ - 6, 9.2),
               (YMZ - 6, 7.8), (YMZ, 7.8), (YMZ, 0)], m=pk, n=24)
    a2_fsb(b, P, FS)
    yfh = a2_flash_hider(b, YMZ - 2, pk)
    g.e('muzzle', (0, yfh, 0))
    g.e('eject', (14.5, 100, 0))
    stanag(g, P, (141.5, -16))
    buis_folded(b, P, 1, RT)
    eye = acog_ta31(b, P, 22, 68)
    g.e('eye', eye)
    g.cheek(eye, 61)                                  # = 70 mm behind the eyepiece face
    sel = 'AUTO' if kind != 'm16a4' else 'BURST'
    g.mark('SAFE', 47, -36, 2.4, -1, True); g.mark('SEMI', 33, -19.6, 2.4, -1, True); g.mark(sel, 16, -29.5, 2.4, -1, True)
    g.mark(('M4A1 CARBINE' if carbine else 'M16A4 RIFLE') + '\nCAL 5.56 MM\nU.S. GOVT PROPERTY', 141, -41, 2.4, -1)
    g.mark('W 1048%03d' % (7 if carbine else 3), 141, -60, 2.0, -1)
    g.mark('F', FS + 8, 0, 4.0, 1)
    g.mark('TA31\n4X32', 22 + 60, 68 - 8, 3.0, -1)
    g.mark('', 22 + 85, 68 + 4, 1.0, -1, matrix=12)
    g.decals[-1]['h'] = 9.0
    g.e('detail', (0, 60, -20))
    if kind == 'm4a1':
        peq15(b, P, R1 - 114, RT)
        g.e('grip_l', vfg(b, P, R0 + 78))
    elif kind == 'm16a4':
        g.e('grip_l', (0, 320, -31))
    # Loose sling: rear from the receiver end plate loop (carbine) / A2 butt swivel, front from the FSB swivel.
    rear = (-21, -3, -12) if carbine else (0, YB + 30, -112)
    g.sling(P, rear, (0, FS + 9, -37), 170 if carbine else 120, -30 if carbine else -22)
    if kind == 'm4a1_m203':
        m203(g, P, FS)
    return g


def m203(g, P, FS):
    """M203 40 mm launcher under the RAS (12 in barrel), with its folding leaf sight on the top rail ahead of the
    ACOG. The leaf's aperture and the rifle's front sight post form the grenade sight line (raised ~7 deg, i.e.
    the ~200 m graduation); the line clears the ACOG."""
    b = g.body
    an, pk, po, dk = P['anod'], P['park'], P['poly'], P['dark']
    zc, r = -63.0, 24.5
    b.loft_spline([(186, -30, -88, 52, 7), (196, -30, -90, 54, 8), (270, -30, -90, 54, 8), (276, -31, -88, 52, 7)], an,
                  steps=1, n=4)
    b.box2((-20, 190, -36), (20, 268, -29), an, bevel=1.5)
    b.cylx(5, 26, 29.5, 252, -70, pk, 14, bevel=0.6)                        # barrel latch
    b.cylx(3, -29.5, -26, 210, -60, pk, 10)
    b.extrude([(190, -88), (232, -88), (230, -110), (224, -116), (196, -116), (190, -112), (188, -96), (194, -96),
               (196, -110), (223, -110), (226, -96), (226, -90), (194, -90)], 12, an, 'x', 0, bevel=0.8)
    b.extrude([(209, -88), (214, -88), (214, -95), (212, -102), (208, -105), (209, -98)], 6, pk, 'x', 0, bevel=0.4)
    b.box((5, 10, 6), (0, 222, -92), pk, bevel=0.8)                          # safety
    yb0, yb1 = 272.0, 572.0
    b.lathe_y([(yb0, 20.3), (yb0, r), (yb1 - 6, r), (yb1 - 4, r + 0.8), (yb1, r + 0.8), (yb1, 20.3)], z=zc, m=an, n=36,
              closed=True)
    for k in range(14):
        a = k * 360 / 14
        if 140 < a < 220:
            continue
        ar = math.radians(a)
        b.box((3.4, 130, 1.8), (r * math.sin(ar), yb0 + 80, zc + r * math.cos(ar)), an, (0, a, 0), bevel=0.5)
    b.box2((-5, yb0, zc + r - 2), (5, yb1 - 8, zc + r + 6), an, bevel=1.5)  # top guide rail
    b.box2((-8, 470, -38), (8, 490, zc + r + 2), an, bevel=1.5)             # barrel front support
    # Leaf sight: base clamp on the rail, two uprights, range bars, aperture slider.
    ys = 201.0
    b.box2((-13, ys - 11, RT), (13, ys + 11, RT + 7), an, bevel=1.2)
    for s in (-1, 1):
        b.box((3, 3.5, 72), (s * 10, ys, RT + 42), an, bevel=0.6)
    b.box((23, 3.5, 3.5), (0, ys, RT + 78), an, bevel=0.6)
    for k in range(6):
        b.box((17, 1.2, 1.0), (0, ys + 1.2, RT + 20 + k * 10), P['white'], bevel=0)
    za = RT + 64.0
    b.box((17, 2.5, 2.5), (0, ys, za - 6.5), an, bevel=0.4)
    aperture(b, an, 0, ys, za, 4.6, 1.5, 2.5)
    front = (0, FS + 29, 66)
    g.e('muzzle_gl', (0, yb1, zc))
    g.e('eye_gl', (0, ys - 1.5, za))
    g.e('front_gl', front)
    d = Vector((0, ys - 1.5, za)) - Vector(front)
    g.e('cheek_gl', tuple(Vector((0, ys - 1.5, za)) + d.normalized() * 240))
    g.e('grip_l', (0, 340, zc - r))


# =====================================================================================================
# Belt-fed and other weapons
# =====================================================================================================
def cartridge(b, P, y0, x, z, cal='556'):
    """A belted cartridge lying along +Y (bullet forward) with its link."""
    L, r = {'556': (57.4, 4.8), '762': (71.0, 6.0), '50': (138.0, 10.2)}[cal]
    k = L / 57.4
    b.lathe_y([(y0, 0), (y0, r * 0.97), (y0 + 1.2 * k, r), (y0 + 36 * k, r * 0.95), (y0 + 39.5 * k, r * 0.66),
               (y0 + 44.7 * k, r * 0.66), (y0 + 44.7 * k, 0)], x=x, z=z, m=P['brass'], n=10)
    b.lathe_y([(y0 + 44.7 * k, r * 0.6), (y0 + 50 * k, r * 0.55), (y0 + L, r * 0.12), (y0 + L, 0)], x=x, z=z,
              m=P['copper'], n=10)
    b.box((r * 1.2, 7 * k, r * 2.3), (x, y0 + 14 * k, z), P['park'])
    b.box((r * 1.2, 6 * k, r * 2.3), (x, y0 + 33 * k, z), P['park'])


def belt(b, P, pts, y0, cal):
    for x, z in pts:
        cartridge(b, P, y0, x, z, cal)


def folded_handle(b, P, y, r0, ang, L, gy0, gy1, m_grip):
    """Barrel carrying handle folded ang degrees to the left of vertical."""
    a = math.radians(ang)
    d = (-math.sin(a), math.cos(a))
    b.rod((d[0] * r0, y, d[1] * r0), (d[0] * (r0 + L), y, d[1] * (r0 + L)), 6, P['park'], 10)
    b.tube(10, gy0, gy1, d[0] * (r0 + L + 6), d[1] * (r0 + L + 6), m_grip, 14, bevel=2)


def saw_grip(b, top, P, ang=14.0):
    """FN SAW pistol grip: deep, three finger grooves, flat ribbed sides."""
    secs = [(-6, 46, 28, 9, 0), (6, 45, 29, 10, 0), (18, 41, 30, 11, -2.5), (29, 45, 30.5, 11, 1.2),
            (40, 41, 30.5, 11, -2.2), (51, 45, 31, 11, 1.2), (62, 41, 31, 11, -2.0), (74, 45, 31, 11, 1.0),
            (88, 46, 31, 11, 0.6), (98, 44, 30, 11, 0), (103, 34, 24, 8, 0)]
    b.loft_axis_spline(top, ang, secs, P['grip'], steps=2, n=4)
    for i in range(7):
        for s in (-1, 1):
            p = b.axis_pt(top, ang, 16 + i * 11, -6)
            b.box((1.2, 26, 2.2), (s * 15.6, p[1], p[2]), P['grip'], (-ang, 0, 0), bevel=0.4)
    return Vector(b.axis_pt(top, ang, 48, -4))


def m249(P):
    """M249 SAW with the collapsible (para-type) stock extended and the standard 465 mm barrel.
    Proportions from the PEO M249 photo: tall stamped receiver with the bore near its top, ~180 mm feed cover,
    rear sight on the receiver's rear top, perforated heat shield, railed handguard, stock below the bore line."""
    g = Gun('m249'); b = g.body
    pk, po, dk, st = P['park'], P['poly'], P['dark'], P['steel']
    # ---- receiver
    b.loft_y([(0, 17, -80, 58, 4), (288, 17, -80, 58, 4)], pk, n=3)
    b.box2((-29.5, -6, -98), (29.5, 1, 16), pk, bevel=2.5)                 # rear plate (stock interface)
    for s in (-1, 1):
        for zz in (2, -30):
            b.box2((s * 29 - 1.4, 8, zz - 2.6), (s * 29 + 1.4, 282, zz + 2.6), pk, bevel=0.8)
        b.box2((s * 29 - 1.0, 120, -62), (s * 29 + 1.0, 282, -48), pk, bevel=0.6)
        for yy in range(16, 285, 30):
            b.cylx(2.4, s * 29 - 1.6, s * 29 + 1.6, yy, -72, pk, 8)
            b.cylx(2.4, s * 29 - 1.6, s * 29 + 1.6, yy, 11, pk, 8)
    b.box2((-46, 172, 8), (-28, 252, 17), pk, bevel=1.2)                  # feed tray tongue (left)
    b.box2((28, 176, 8), (38, 248, 15), pk, bevel=1.0)                    # link exit (right)
    mw = b.sub()
    mw.box((34, 74, 58), (-40, 231, -98), pk, (0, 32, 0), bevel=2.5)      # magazine well, canted left
    ct = b.sub(); ct.box((24, 64, 60), (-48, 231, -116), dk, (0, 32, 0), bevel=0)
    b.add_cut(mw, ct)
    b.box2((29, 150, -24), (32, 256, -14), pk, bevel=0.6)                 # charging handle track (right)
    ch = g.part('charge', (30, 236, -20))                                # charging handle (pulled back 80 mm)
    ch.box2((30, 226, -30), (40, 246, -10), pk, bevel=2)
    ch.cylx(5.5, 38, 50, 236, -20, po, 14, bevel=1)
    g.e('charge_back', (30, 236 - 80, -20))
    g.e('hand_charge', (47, 236, -20), 'charge')
    ct = b.sub()
    pc = b.sub(); pc.box2((10, 180, -82), (29.5, 252, -74), pk, bevel=0.5)
    ct.box2((14, 186, -90), (26, 246, -76), dk, bevel=0)
    b.add_cut(pc, ct)                                                     # ejection port (bottom right)
    # ---- trigger housing, guard, trigger, safety, grip
    b.box2((-17, 60, -97), (17, 200, -78), pk, bevel=2.5)
    b.extrude([(194, -95), (192, -116), (184, -123), (148, -123), (140, -117), (138, -95), (144, -95), (146, -113),
               (151, -117.5), (182, -117.5), (187, -112), (188, -95)], 15, pk, 'x', 0, bevel=1.0)
    b.extrude([(156, -95), (162, -95), (163, -103), (160, -111), (154, -116), (155, -109), (158, -102)], 7, pk, 'x', 0, bevel=0.5)
    b.cylx(5, -19.5, 19.5, 133, -88, pk, 14, bevel=0.8)                   # cross-bolt safety
    g.grip = saw_grip(b, (110, -96), P)
    g.e('grip_r', g.grip)
    # ---- rear sight on the receiver's rear top: base, leaf with a see-through aperture, knobs
    b.box2((-13, 20, 15), (13, 62, 25), pk, bevel=1.8)
    for s in (-1, 1):
        b.box((3.5, 5, 30), (s * 9, 40, 39), pk, bevel=0.8)
    b.box((21.5, 5, 4), (0, 40, 56), pk, bevel=0.8)
    b.box((15, 3.5, 5), (0, 40, 44.5), pk, bevel=0.5)
    aperture(b, pk, 0, 40, 51, 5.2, 1.5, 3.5)
    b.cylx(6.5, 13, 19, 44, 21, pk, 16, bevel=0.8)
    b.cylx(5.5, -19, -13, 30, 20, pk, 16, bevel=0.8)
    g.e('eye', (0, 38, 51))
    g.cheek((0, 38, 51), 110)
    # ---- barrel group
    b.lathe_y([(258, 0), (258, 11.5), (480, 11.5), (490, 11), (668, 10.5), (668, 9), (674, 9), (674, 0)], m=pk, n=20)
    b.lathe_y([(288, 0), (288, 20), (306, 20), (309, 15), (309, 0)], m=pk, n=24)
    yfh = a2_flash_hider(b, 672, pk, r=12.5, slots=(0, 60, 120, 180, 240, 300), slot_w=14, L=80)
    hs = b.sub()
    hs.lathe_y([(298, 19.5), (298, 21.5), (455, 21.5), (455, 19.5)], m=pk, n=18, closed=True, a0=-82, a1=82)
    ct = b.sub()
    for i in range(8):
        y = 314 + i * 18.5
        ct.rod((0, y, 10), (0, y, 30), 4.6, dk, 12)
        for s in (-1, 1):
            ct.rod((s * 12, y + 9, 8), (s * 26, y + 9, 22), 3.2, dk, 10)
    b.add_cut(hs, ct)
    for y in (298, 449):
        b.lathe_y([(y, 11.5), (y, 21.5), (y + 6, 21.5), (y + 6, 11.5)], m=pk, n=18, closed=True, a0=-95, a1=95)
    # Carrying handle, swung to the left so it clears the sight line.
    b.lathe_y([(312, 11.5), (312, 17), (330, 17), (330, 11.5)], m=pk, n=18, closed=True)
    a = math.radians(68)
    d = Vector((-math.sin(a), 0, math.cos(a)))
    b.rod(tuple(Vector((0, 321, 0)) + d * 15), tuple(Vector((0, 321, 0)) + d * 62), 6, pk, 12)
    b.rod(tuple(Vector((0, 321, 0)) + d * 62), tuple(Vector((0, 395, 0)) + d * 74), 6, pk, 12)
    b.rod(tuple(Vector((0, 395, 0)) + d * 74), tuple(Vector((0, 458, 0)) + d * 70), 10, po, 14)
    # Handguard under the barrel with the bottom rail and vent slots.
    hg = b.sub()
    hg.loft_y([(288, -17, -73, 52, 9), (296, -16, -75, 55, 10), (420, -16, -75, 55, 10), (428, -18, -72, 50, 9)], po, n=3)
    ct = b.sub()
    for i in range(6):
        for s in (-1, 1):
            ct.box((10, 11, 14), (s * 28, 314 + i * 19, -36), dk, bevel=0)
    b.add_cut(hg, ct)
    b.pic_rail(300, 420, TM((0, 0, -75), (0, 180, 0)), pk)
    # Gas cylinder, gas block with the front sight, regulator, bipod (folded forward).
    b.tube(11, 420, 500, 0, -32, pk, 16)
    b.box2((-13, 488, -46), (13, 532, 12), pk, bevel=3)
    b.tube(9, 532, 548, 0, -32, pk, 16)
    b.box((5, 7, 30), (12, 540, -42), pk, bevel=1)
    b.extrude([(512, 10), (532, 10), (530, 40), (517, 40)], 11, pk, 'x', 0, bevel=1.0)
    b.box((2.6, 3, 12), (0, 523.5, 45), pk, bevel=0.3)                   # front post, tip z=51
    for s in (-1, 1):
        b.extrude([(514, 34), (532, 34), (531, 53), (520, 53)], 2.6, pk, 'x', s * 6.5, bevel=0.5)
    b.lathe_y([(470, 10.5), (470, 16.5), (486, 16.5), (486, 10.5)], z=-32, m=pk, n=16, closed=True)
    b.box2((-17, 472, -60), (17, 486, -46), pk, bevel=2)
    for s in (-1, 1):
        b.rod((s * 12, 480, -58), (s * 15, 600, -61), 6.5, pk, 12)
        b.rod((s * 15, 600, -61), (s * 17, 700, -63), 5, pk, 12)
        b.box((11, 18, 8), (s * 17, 706, -64), pk, bevel=2)
    # ---- collapsible stock (extended): two guide tubes, ribbed butt body, rubber butt plate, latch
    for zz in (-38, -88):
        b.tube(6.5, -150, -4, 0, zz, pk, 14)
    stk = b.sub()
    stk.loft_spline([(-255, -14, -128, 44, 8), (-215, -15, -126, 44, 9), (-160, -15, -112, 42, 9),
                     (-128, -15, -96, 40, 9), (-112, -16, -90, 38, 8)], po, steps=2, n=4)
    ct = b.sub()
    for s in (-1, 1):
        ct.extrude([(-246, -58), (-140, -58), (-140, -100), (-168, -116), (-246, -120)], 4, po, 'x', s * 22.6)
    b.add_cut(stk, ct)
    for s in (-1, 1):
        x = s * 20.4
        for y0, y1 in ((-246, -142), (-142, -246)):
            p0, p1 = Vector((x, y0, -60)), Vector((x, y1, -112))
            b.rod(tuple(p0), tuple(p1), 2.2, po, 8)
        b.rod((x, -246, -86), (x, -142, -86), 2.0, po, 8)
    b.loft_spline([(-265, -10, -133, 46, 9), (-261, -9, -134, 46.5, 9.5), (-254, -10, -132, 46, 9)], P['rubber'], steps=1, n=4)
    b.box2((-8, -170, -134), (8, -120, -126), po, bevel=2)
    # ---- feed cover (hinged at its front) with rail, rear latches
    cv = g.part('cover', (0, 255, 18))
    cv.loft_y([(75, 34, 15, 60, 6), (258, 34, 15, 60, 6)], pk, n=3)
    cv.pic_rail(92, 246, TM((0, 0, 34)), pk)
    for s in (-1, 1):
        cv.box2((s * 30 - 3, 78, 18), (s * 30 + 3, 94, 30), pk, bevel=1.2)
    cv.box2((-12, 252, 20), (12, 262, 32), pk, bevel=1.5)
    g.e('hand_cover', (0, 88, 38), 'cover')                               # rear latches: lift here (hinge at the front)
    # ---- 200-round soft pack on the magazine well, belt rising into the feed tray (left)
    bx = g.part('box', (-12, 236, -100))
    cn = P['canvas']
    prof = [(190, -104), (340, -104)]
    for k in range(1, 12):
        t = math.radians(k * 180 / 12)
        prof.append((265 + 75 * math.cos(t), -170 - 82 * math.sin(t) * 1.0 + 0 * t))
    prof = [(190, -100), (340, -100), (340, -170)] + [(265 + 75 * math.cos(math.radians(a)), -170 - 85 * math.sin(math.radians(a)))
                                                        for a in range(15, 180, 15)] + [(190, -170)]
    bx.extrude(prof, 72, cn, 'x', -10, bevel=9)
    bx.extrude(offset_path([(p[0], p[1]) for p in prof[2:]], 1.0), 74, P['dark'], 'x', -10, bevel=0)
    bx.box2((-46, 196, -104), (26, 334, -92), po, bevel=2.5)              # plastic top frame
    bx.box2((-30, 205, -94), (6, 262, -82), po, bevel=2)                  # adapter into the magwell
    pts = [(-40, -88 + i * 14.5) for i in range(7)]
    belt(bx, P, pts, 205, '556')
    g.e('hand_mag', (-50, 262, -150), 'box')
    g.e('mag_dir', (-12, 236, -220))
    g.e('muzzle', (0, yfh, 0))
    g.e('eject', (20, 216, -84))
    g.e('butt', (0, -265, -72))
    g.e('grip_l', (0, 395, -76))
    g.mark('M249 SAW\nCAL 5.56 MM\nU.S.', 150, -40, 3.0, -1)
    g.mark('MACHINE GUN 5.56MM M249', 150, -52, 2.6, 1)
    g.mark('F   S', 133, -88, 2.4, -1, True)
    g.sling(P, (-23, -150, -122), (-29, 478, -52), 150, -42)
    g.e('detail', (0, 120, -30))
    return g


def m240b(P):
    """M240B: 1245 mm, 627 mm barrel. Layout from the PEO photo: stock ~220 mm dropping to a tall ribbed butt,
    tall riveted receiver (405 mm) with the feed cover on its middle and the folding rear sight leaf ahead of it,
    perforated handguard / heat shield with side rails, gas cylinder and bipod under the barrel."""
    g = Gun('m240b'); b = g.body
    pk, po, dk = P['park'], P['poly'], P['dark']
    RX = 405.0
    # ---- receiver
    b.loft_y([(0, 28, -80, 54, 4), (RX, 28, -80, 54, 4)], pk, n=3)
    b.box2((-28, -5, -84), (28, 2, 26), pk, bevel=2.5)
    for s in (-1, 1):
        for zz in (-6, -42):
            b.box2((s * 27 - 1.3, 10, zz - 2.5), (s * 27 + 1.3, RX - 12, zz + 2.5), pk, bevel=0.6)
        for yy in range(18, int(RX) - 5, 30):
            for zz in (-70, 18):
                b.cylx(2.6, s * 27 - 1.5, s * 27 + 1.5, yy, zz, pk, 10)
        for yy in (60, 120, 250, 330):
            b.cylx(4.2, s * 27 - 2, s * 27 + 2, yy, -24, pk, 12, bevel=0.5)
    b.box2((-46, 300, 8), (-27, 372, 26), pk, bevel=2)                      # feed tray, left
    b.box2((27, 305, 10), (40, 368, 24), pk, bevel=2)                       # link chute, right
    pc = b.sub(); pc.box2((-14, 250, -82), (14, 345, -76), pk, bevel=0.5)
    ct = b.sub(); ct.box2((-11, 256, -90), (11, 339, -77), dk, bevel=0)
    b.add_cut(pc, ct)                                                       # ejection port (bottom)
    b.box2((27, 290, -36), (31, 378, -26), pk, bevel=0.6)                   # charging handle (right, folded)
    ch = g.part('charge', (30, 356, -31))                                # charging handle (pulled back 150 mm)
    ch.box2((30, 340, -40), (40, 372, -22), pk, bevel=2)
    ch.cylx(7, 38, 52, 362, -31, po, 14, bevel=1)
    g.e('charge_back', (30, 356 - 150, -31))
    g.e('hand_charge', (48, 362, -31), 'charge')
    # Rear sight on the receiver front, ahead of the cover: base, leaf folded flat, battle notch (line 60 mm).
    b.box2((-15, 378, 26), (15, 404, 46), pk, bevel=2)
    b.box2((-11, 386, 46), (11, 428, 49), pk, bevel=0.8)
    for s in (-1, 1):
        x0, x1 = (3.2, 8.5) if s > 0 else (-8.5, -3.2)
        b.box2((x0, 380, 45), (x1, 385, 62), pk, bevel=0.5)
    b.box2((-8.5, 380, 45), (8.5, 385, 56.5), pk, bevel=0.4)
    # ---- trigger housing, guard, grip
    b.box2((-17, 40, -97), (17, 190, -78), pk, bevel=2.5)
    b.extrude([(184, -95), (182, -122), (173, -130), (114, -130), (105, -122), (104, -95), (110, -95), (111, -117),
               (117, -124), (170, -124), (176, -117), (178, -95)], 14, pk, 'x', 0, bevel=1.0)
    b.extrude(offset_path([(126, -96), (127, -106), (124, -115), (118, -121)], 2.2, 2.0), 7, pk, 'x', 0, bevel=0.5)
    b.cylx(5, -19.5, 19.5, 64, -88, pk, 14, bevel=0.8)
    g.grip = saw_grip(b, (80, -97), P, 16)
    g.e('grip_r', g.grip)
    # ---- barrel group
    b.lathe_y([(380, 0), (380, 15), (540, 14.5), (860, 13), (965, 12), (965, 0)], m=pk, n=20)
    b.lathe_y([(RX, 0), (RX, 22), (RX + 34, 22), (RX + 38, 17), (RX + 38, 0)], m=pk, n=24)
    b.lathe_y([(962, 5), (962, 15), (985, 15), (985, 7)], m=pk, n=20, closed=True)
    for k in range(5):
        a = k * 72
        b.lathe_y([(985, 7.2), (985, 15), (1019, 18.5), (1019, 15.5)], m=pk, n=3, closed=True, a0=a + 9, a1=a + 63)
    b.lathe_y([(1019, 15.5), (1019, 18.8), (1025, 18.8), (1025, 16)], m=pk, n=24, closed=True)
    # Handguard / heat shield: hollow box shell with round vents, rails on both sides and underneath.
    hg = b.sub()
    hg.loft_y([(450, 26, -50, 50, 8), (660, 26, -50, 50, 8)], pk, n=3)
    ct = b.sub()
    ct.loft_y([(440, 23, -47, 44, 6), (670, 23, -47, 44, 6)], dk, n=3)
    for i in range(10):
        y = 468 + i * 20
        ct.rod((-35, y, 10), (35, y, 10), 5, dk, 12)
        ct.rod((0, y + 10, 10), (0, y + 10, 35), 4, dk, 10)
    b.add_cut(hg, ct)
    for s in (-1, 1):
        b.pic_rail(500, 650, TM((s * 25, 0, -24), (0, s * 90, 0)), pk)
    b.pic_rail(470, 650, TM((0, 0, -50), (0, 180, 0)), pk)
    for y in (450, 654):
        b.loft_y([(y, 27, -51, 52, 9), (y + 6, 27, -51, 52, 9)], pk, n=3)
    # Carrying handle (swung left), gas cylinder and block, regulator, bipod folded back, front sight.
    b.lathe_y([(RX + 40, 14.5), (RX + 40, 20), (RX + 44, 20), (RX + 44, 14.5)], m=pk, n=18, closed=True)
    a = math.radians(64)
    d = Vector((-math.sin(a), 0, math.cos(a)))
    b.rod(tuple(Vector((0, RX + 42, 0)) + d * 18), tuple(Vector((0, RX + 42, 0)) + d * 70), 7, pk, 12)
    b.rod(tuple(Vector((0, RX + 42, 0)) + d * 70), tuple(Vector((0, RX - 60, 0)) + d * 86), 11, po, 16)
    b.tube(12.5, RX, 790, 0, -34, pk, 18)
    b.box2((-14, 764, -50), (14, 798, 14), pk, bevel=3)
    b.tube(10, 798, 818, 0, -34, pk, 16)
    b.box((5, 8, 30), (12, 808, -42), pk, bevel=1)
    b.box2((-18, 768, -64), (18, 792, -48), pk, bevel=2)
    for s in (-1, 1):
        b.extrude(offset_path([(770, -60), (660, -62), (540, -64)], 4, 4), 12, pk, 'x', s * 16, bevel=1.5)
        b.box2((s * 16 - 8, 528, -72), (s * 16 + 8, 548, -60), pk, bevel=2)
    b.lathe_y([(916, 11.5), (916, 17), (936, 17), (936, 11.5)], m=pk, n=18, closed=True)
    b.extrude([(918, 14), (934, 14), (932, 52), (921, 52)], 9, pk, 'x', 0, bevel=1)
    b.box((2.6, 3, 9), (0, 926.5, 55.5), pk, bevel=0.3)                    # front sight blade, tip z=60
    for s in (-1, 1):
        b.extrude([(919, 46), (934, 46), (933, 62), (923, 62)], 2.4, pk, 'x', s * 6.4, bevel=0.5)
    # ---- buttstock: top drops toward the butt, narrow wrist, tall butt with vertical ribs
    b.loft_spline([(0, 6, -78, 46, 6), (-25, 3, -80, 44, 8), (-70, -4, -72, 40, 10), (-120, -12, -100, 42, 12),
                   (-180, -22, -140, 46, 12), (-212, -26, -150, 47, 12)], po, steps=3, n=4)
    b.loft_spline([(-221, -25, -152, 48, 12), (-217, -24.5, -152.5, 48.5, 12), (-212, -25, -151, 48, 12)], P['rubber'],
                  steps=1, n=4)
    for s in (-1, 1):
        for i in range(6):
            b.box((1.4, 4, 60), (s * 23.4, -200 + i * 8, -90), po, bevel=0.4)
    b.torus(8, 1.8, (-24, -40, -30), pk, (0, 0, 0), 14, 6)                   # sling loop
    # ---- feed cover (hinged at its front), rail on top, rear latch
    cv = g.part('cover', (0, 374, 30))
    cv.loft_y([(175, 46, 26, 56, 6), (376, 46, 26, 56, 6)], pk, n=3)
    cv.pic_rail(192, 362, TM((0, 0, 46)), pk)
    cv.box2((-21, 172, 30), (21, 186, 44), pk, bevel=2)
    g.e('hand_cover', (0, 180, 47), 'cover')                              # rear latch: lift here (hinge at the front)
    # ---- 100-round soft pouch hanging on the left, belt into the feed tray
    bx = g.part('box', (-45, 335, -6))
    cn = P['canvas']
    bx.box2((-104, 268, -150), (-34, 404, -14), cn, bevel=11)
    bx.box2((-106, 270, -24), (-32, 402, -10), cn, bevel=4)
    bx.box2((-40, 318, -22), (-26, 352, 8), pk, bevel=2)
    pts = [(-58 + 4 * i, -8 + 9 * i) for i in range(4)]
    belt(bx, P, pts, 300, '762')
    g.e('hand_mag', (-114, 340, -80), 'box')
    g.e('mag_dir', (-45, 335, -126))
    g.e('eye', (0, 381, 60))
    g.cheek((0, 381, 60), 320)
    g.e('muzzle', (0, 1025, 0))
    g.e('eject', (0, 297, -82))
    g.e('butt', (0, -221, -88))
    g.e('grip_l', (0, 455, -52))
    g.mark('M240B\nCAL 7.62 MM\nU.S.', 220, -30, 3.2, -1)
    g.mark('MACHINE GUN 7.62MM M240B', 150, -58, 2.6, 1)
    g.sling(P, (-24, -40, -30), (-18, 780, -56), 165, -46)
    g.e('detail', (0, 250, -20))
    return g


def m24(P):
    g = Gun('m24'); b = g.body
    pk, an, st = P['park'], P['anod'], P['od_poly']
    A = 52.0
    # ---- receiver, scope base and rings, barrel
    b.lathe_y([(0, 0), (0, 15.5), (2, 17), (222, 17), (222, 0)], m=pk, n=24)
    b.box((30, 8, 36), (0, 214, -10), pk)                                    # recoil lug
    b.box((15, 220, 7), (0, 111, 19.5), pk, bevel=1)
    for yr in (50, 172):
        b.box((22, 18, 12), (0, yr, 28), pk, bevel=2)
        b.lathe_y([(yr - 9, 15.4), (yr - 9, 19.5), (yr + 9, 19.5), (yr + 9, 15.4)], z=A, m=pk, n=20, closed=True)
        for s in (-1, 1):
            b.box((6, 14, 6), (s * 20, yr, A), pk, bevel=1)
    b.lathe_y([(200, 0), (200, 16), (240, 16), (330, 14.5), (785, 11.2), (785, 4), (781, 3.9), (781, 0)], m=pk, n=20)
    # ---- H-S Precision style stock (olive, speckled), vertical-ish pistol grip
    secs = [(515, -3, -40, 48, 13), (470, 0, -44, 52, 14), (300, 2, -50, 54, 14), (190, 3, -55, 54, 13),
            (60, 3, -57, 54, 13), (18, 4, -58, 50, 13), (-8, 5, -60, 44, 12), (-26, 6, -96, 40, 14),
            (-60, 6, -102, 40, 14), (-84, 6, -98, 40, 14), (-98, 6, -66, 40, 12), (-140, 6, -72, 42, 12),
            (-210, 6, -92, 44, 12), (-262, 6, -104, 44, 12), (-268, 6, -105, 44, 12)]
    b.loft_y(secs, st, n=4)
    # Adjustable butt plate on two guide rods with the length-of-pull screw (as on the M24 in the PEO photo).
    for zz in (-14, -90):
        b.tube(4, -302, -266, 0, zz, pk, 12)
    b.tube(5, -300, -266, 0, -52, pk, 12)
    b.lathe_y([(-288, 5), (-288, 11), (-282, 11), (-282, 5)], z=-52, m=pk, n=16, closed=True)
    b.loft_y([(-302, 8, -108, 42, 10), (-297, 8, -108, 42, 10)], pk, n=3)
    b.loft_y([(-310, 9, -110, 44, 11), (-302, 9, -110, 44, 11)], P['rubber'], n=3)
    b.extrude([(68, -58), (66, -80), (58, -84), (14, -84), (6, -76), (4, -58), (9, -58), (11, -73), (16, -79),
               (56, -79), (62, -75), (63, -58)], 12, pk, 'x', 0, bevel=0.8)
    b.extrude([(30, -40), (35, -40), (36, -50), (33, -58), (27, -63), (28, -57), (31, -50)], 6, pk, 'x', 0)
    b.box((4, 5, 4), (0, 66, -60), pk)
    for y, z in ((480, -43), (-236, -99)):
        b.cyl(3.5, 8, (0, y, z - 3), pk, n=8)
        b.torus(7, 1.6, (0, y, z - 12), pk, (0, 0, 90), 12, 6)
    # Harris bipod folded forward under the forend.
    b.box((30, 36, 14), (0, 470, -52), pk, bevel=2)
    for s in (-1, 1):
        b.rod((s * 12, 480, -56), (s * 14, 600, -59), 6, pk, 10)
        b.rod((s * 14, 600, -59), (s * 15, 700, -61), 4.5, pk, 10)
        b.box((10, 14, 9), (s * 15, 705, -62), P['rubber'], bevel=2)
    # ---- Leupold Mk4 M3 10x40 scope
    b.lathe_y([(-50, 0), (-50, 16.5), (-55, 17.5), (-55, 20.5), (-52, 21.8), (-30, 21.8), (-27, 21), (-14, 21),
               (-4, 15.5), (185, 15.5), (210, 23.5), (270, 24.5), (276, 24.5), (278, 23.5), (278, 19), (275, 19),
               (275, 0)], z=A, m=an, n=28)
    b.lathe_y([(-44, 21.6), (-44, 22.4), (-34, 22.4), (-34, 21.6)], z=A, m=P['rubber'], n=28, closed=True)
    b.tube(16.5, -50.7, -50.2, 0, A, P['glass'], 24)
    b.tube(19, 275.2, 275.7, 0, A, P['glass_amber'], 24)
    b.loft_y([(70, A + 20, A - 19, 38, 10), (112, A + 20, A - 19, 38, 10)], an)
    b.cyl(18, 6, (0, 91, A + 22), an, n=28, bevel=1)
    b.cyl(17.5, 16, (0, 91, A + 33), an, n=28)
    for k in range(16):
        a = math.radians(k * 22.5)
        b.box((1.4, 3, 12), (18 * math.sin(a), 91 + 18 * math.cos(a), A + 33), an, (0, 0, -k * 22.5))
    b.cyl(12, 3, (0, 91, A + 42.5), an, n=20)
    b.cylx(16, 19, 26, 91, A, an, 24)
    b.cylx(15.5, 26, 40, 91, A, an, 24)
    b.cylx(10, -25, -19, 91, A, an, 16)
    # ---- bolt (shroud, body seen in the port, handle with knob)
    bo = g.part('bolt', (0, 0, 0))
    bo.lathe_y([(-46, 0), (-46, 7), (-42, 11), (-12, 13.5), (2, 13.5), (2, 0)], m=pk, n=20)
    bo.box((8, 14, 8), (0, -40, -10), pk, bevel=1.5)
    bo.lathe_y([(6, 14), (6, 17.5), (24, 17.5), (24, 14)], m=pk, n=20, closed=True, a0=40, a1=150)
    bo.rod((14, 15, -4), (44, 9, -24), 4.5, pk, 10)
    bo.sphere(9, (48, 8, -27), pk, u=14, v=8)
    bo.box((1.2, 70, 15), (16.8, 128, 2), P['steel'])
    g.e('charge_back', (0, -100, 0))                                       # bolt origin on the bore: lift = rotate about Y
    g.e('hand_charge', (48, 8, -27), 'bolt')
    # ---- floorplate (hinged magazine floorplate)
    mg = g.part('mag', (0, 165, -58))
    mg.box2((-11, 70, -63), (11, 166, -57), pk, bevel=1.2)
    g.grip = Vector((0, -50, -80))
    g.e('grip_r', g.grip)
    g.e('eye', (0, -55.5, A))
    g.e('muzzle', (0, 785, 0))
    g.e('eject', (18, 128, 4))
    g.e('butt', (0, -310, -50))
    g.cheek((0, -55.5, A), 80)
    g.mark('M24 SWS 7.62 MM', 110, 2, 2.6, -1)
    g.mark('SN 1049217', 110, 2, 2.2, 1)
    g.e('grip_l', (0, 330, -50))
    return g


def m136(P):
    g = Gun('m136'); b = g.body
    od, po, pk = P['od'], P['poly'], P['park']
    b.lathe_y([(60, 0), (60, 50), (955, 50), (955, 0)], m=od, n=32)
    b.lathe_y([(0, 40), (0, 58), (5, 60.5), (75, 60.5), (85, 53), (85, 45)], m=po, n=32, closed=True)
    b.lathe_y([(8, 30), (8, 40), (70, 44), (70, 26)], m=pk, n=24, closed=True)
    b.tube(44, 69, 70, 0, 0, P['dark'], 24)
    b.lathe_y([(948, 44), (948, 57), (956, 59.5), (1012, 59.5), (1020, 56), (1020, 44)], m=po, n=32, closed=True)
    b.tube(44.5, 1004, 1006, 0, 0, P['dark'], 24)
    for yy in (230, 600, 880):
        b.lathe_y([(yy, 49.5), (yy, 51.5), (yy + 12, 51.5), (yy + 12, 49.5)], m=od, n=32, closed=True)
    # Firing mechanism on top (cocking lever, red safety catch, red trigger button).
    b.loft_y([(326, 64, 30, 40, 10, 14), (340, 72, 30, 46, 11, 14), (440, 76, 30, 46, 11, 14),
              (466, 66, 30, 42, 10, 14)], od)
    b.box((10, 84, 7), (4, 400, 79), po, bevel=2.5)                          # cocking lever (folded forward)
    b.cylx(6, -3, 12, 360, 77, po, 12)
    b.box((14, 12, 10), (4, 440, 82), po, bevel=2)
    b.cyl(7, 8, (22, 468, 62), P['red'], (-60, 0, 0), 14, bevel=1)           # trigger button
    b.box((10, 16, 9), (-8, 452, 64), P['red'], bevel=2)                     # safety catch
    # Folding sights on the upper left, raised.
    b.box((14, 30, 30), (-30, 322, 52), od, bevel=2)
    aperture(b, po, -30, 318, 80, 7, 2.0, 3, 64, 16)
    b.cylx(7, -42, -36, 324, 58, po, 12)
    b.box((12, 20, 18), (-30, 700, 46), od, bevel=2)
    b.box((14, 3, 22), (-30, 700, 62), po, bevel=1)
    b.box((2.4, 2.4, 10), (-30, 700, 75), po)
    for s in (-1, 1):
        b.box((2.2, 3, 12), (-30 + s * 6, 700, 76), po, bevel=0.5)
    # Sight covers slid back, shoulder stop, sling loops.
    b.box((26, 50, 3), (-26, 268, 47), od, (0, -30, 0), bevel=1)
    b.box((26, 50, 3), (-26, 752, 47), od, (0, -30, 0), bevel=1)
    b.box((44, 14, 34), (0, 300, -62), po, bevel=3)
    for yy in (120, 900):
        b.box((10, 14, 8), (0, yy, -52), po, bevel=1.5)
        b.torus(7, 1.6, (0, yy, -60), pk, (0, 0, 90), 12, 6)
    g.grip = Vector((34, 440, -32))
    g.e('grip_r', g.grip)
    g.e('muzzle', (0, 1020, 0))
    g.e('eye', (-30, 315, 80))
    g.cheek((-30, 315, 80), 60)
    g.mark('M136 AT4\nHEAT 84 MM', 610, 0, 12, 1, True)
    g.mark('FRONT', 860, -4, 9, -1, True)
    g.e('grip_l', (-22, 690, -46))
    g.e('butt', (0, 300, -52))
    return g


def m9(P):
    """Beretta M9 (92FS): 217 mm long, 125 mm barrel, ~140 mm high. Measured off a side photograph at 0.25 mm/px:
    bore only ~9 mm under the slide top, open-top slide over the barrel, deep squared trigger guard, grip raked
    ~10 deg with a curved back strap. y=0 at the slide's rear face, bore z=0."""
    g = Gun('m9'); b = g.body
    g.tex = 512
    an, pk, po, dk = P['anod'], P['park'], P['poly'], P['dark']
    # ---- slide (part 'charge', origin at its rear face on the bore; travels back 40 mm)
    ch = g.part('charge', (0, 0, 0))
    sl = ch.sub()
    sl.extrude([(0, -16), (202, -15), (203, 3), (201, 8.75), (190, 8.75), (186, 6), (180, 3.75), (84, 3.75),
                (80, 6.5), (76, 8.75), (2, 8.75), (0, 6)], 25, an, 'x', 0, bevel=1.4)
    ct = ch.sub()
    for i in range(17):
        for s in (-1, 1):
            ct.box((1.4, 1.1, 12), (s * 12.7, 38 + i * 2.6, -7.5), an, bevel=0)    # rear cocking serrations
    ct.box2((-6.5, 150, -12), (6.5, 210, 2), dk, bevel=0)                      # nose cavity around the barrel
    ch.add_cut(sl, ct)
    b.lathe_y([(60, 0), (60, 8), (203.5, 8), (203.5, 6.5), (203.5, 4.4), (199, 4.4), (199, 0)], m=pk, n=24)
    b.box2((-7.5, 62, -2), (7.5, 92, 7.5), pk, bevel=1)                        # chamber hood
    b.box((1.2, 22, 4), (12.6, 66, 4.5), pk, bevel=0.3)                        # extractor
    for s in (-1, 1):
        ch.extrude([(18, -4), (36, -3), (37, 2.5), (24, 3.5), (18, 1.5)], 3.6, an, 'x', s * 13.6, bevel=0.8)  # safety-decocker
        ch.cylx(3.2, s * 12.4, s * 15, 22, 0, an, 12)
    ch.box2((-9, 21, 8.2), (9, 30, 10.5), an, bevel=0.6)                       # rear sight
    for s in (-1, 1):
        x0, x1 = (3.3, 8.6) if s > 0 else (-8.6, -3.3)                      # rear sight ears, 6.6 mm notch
        ch.box2((x0, 22, 10), (x1, 29, 13.6), an, bevel=0.4)
        ch.box((1.5, 0.3, 1.5), (s * 5.9, 21.9, 12.2), P['white'], bevel=0)
    ch.extrude([(185, 8.5), (197, 8.5), (196, 13.6), (189, 13.6)], 3.2, an, 'x', 0, bevel=0.6)  # front sight blade
    ch.box((1.5, 0.3, 1.5), (0, 188.7, 12.2), P['white'], bevel=0)
    g.e('charge_back', (0, -40, 0))
    g.e('hand_charge', (0, 58, 8.75), 'charge')
    b.extrude([(-1, -7), (5, -7), (5, 3), (1, 7.5), (-5.5, 6), (-6.5, -1)], 6.4, an, 'x', 0, bevel=0.8)   # hammer
    # ---- frame: dust cover, deep squared trigger guard, trigger, grip with the curved back strap
    b.extrude([(3, -15.5), (196, -15.5), (196, -21), (192, -26), (112, -26), (110, -24), (60, -24), (56, -30),
               (14, -30), (-10, -30), (-14, -22), (-12, -15.5)], 22.5, an, 'x', 0, bevel=1.0)
    b.extrude(offset_path([(110.5, -25), (111, -56), (108, -62.5), (102, -64.5), (70, -64.5), (64, -61), (60, -52),
                           (58, -36)], 2.2), 10, an, 'x', 0, bevel=0.8)
    b.extrude(offset_path([(88, -25), (88.5, -34), (86.5, -43), (82.5, -50), (77, -55)], 2.4, 2.0), 6.5, pk, 'x', 0, bevel=0.6)
    top, ang = (28, -26), 10.0
    b.loft_axis_spline(top, ang, [(-4, 47, 24, 9, 0), (30, 49, 24, 10, -1), (70, 51, 24, 10, -3), (97, 52, 24, 9, -4)],
                       an, steps=2, n=4)
    b.loft_axis_spline(top, ang, [(6, 40, 32.5, 7, 0.5), (50, 42, 33, 7, -1.5), (90, 44, 32.5, 7, -3.5)], P['grip'], steps=2, n=4)
    for tt in (12, 82):
        p = b.axis_pt(top, ang, tt, -1)
        b.cylx(2.8, -17.4, 17.4, p[1], p[2], pk, 12, bevel=0.3)
    p = b.axis_pt(top, ang, 48, -2)
    b.cylx(7, -17.0, 17.0, p[1], p[2], an, 20, bevel=0.6)                     # medallions
    b.cylx(4.4, -12.6, 12.6, 51, -55, an, 14, bevel=0.5)                      # magazine release
    b.extrude([(86, -16), (112, -16), (114, -20), (108, -25), (86, -23)], 2.2, an, 'x', -12.3, bevel=0.5)  # slide stop
    b.extrude([(104, -20), (114, -20), (114, -29), (106, -29)], 2.0, an, 'x', -12.2, bevel=0.5)   # takedown lever
    p = b.axis_pt(top, ang, 95, -27)
    b.torus(4, 1.2, p, pk, (0, 0, 90), 12, 6)                                 # lanyard loop
    g.grip = Vector(b.axis_pt(top, ang, 48, -2))
    # ---- 15-round magazine
    mg = g.part('mag', b.axis_pt(top, ang, 4))
    mg.loft_axis(top, ang, [(4, 34, 21, 4, -1), (97, 34, 21, 4, -3)], P['mag'])
    mg.loft_axis_spline(top, ang, [(97, 52, 28, 7, -4), (100, 53, 28.5, 7, -4), (104, 51, 27, 6, -4)], po, steps=1, n=4)
    mg.box((7, 6, 3), (0, top[0] + 4, top[1] - 2.5), P['brass'])
    g.e('mag_dir', b.axis_pt(top, ang, 4 + 120))
    hp = b.axis_pt(top, ang, 50)
    g.e('hand_mag', (-(21 / 2 + 12), hp[1], hp[2]), 'mag')
    g.e('grip_r', g.grip)
    g.e('grip_l', (-18, g.grip.y + 8, g.grip.z - 8))
    g.e('eye', (0, 21.5, 12.8))
    g.mark('U.S. 9MM M9', 125, -5, 2.6, -1, obj='charge')
    g.mark('SN M9-1049217', 130, -21, 2.0, 1)
    g.mark('F', 28, 1, 2.6, -1, True, obj='charge')
    g.cheek((0, 21.5, 12.8), 600)
    g.e('muzzle', (0, 203.5, 0))
    g.e('eject', (12, 130, 6))
    return g


def m67(P):
    g = Gun('m67'); b = g.body
    od, pk = P['od'], P['park']
    prof = [(-32, 0)]
    for k in range(1, 12):
        th = math.radians(-90 + k * 15)
        prof.append((32 * math.sin(th), 32 * math.cos(th)))
    prof += [(31.2, 10), (32.5, 9.5), (32.5, 0)]
    b.lathe(prof, od, (0, 0, 0), (90, 0, 0), 24)
    b.lathe([(20, 24.6), (20, 25.4), (24, 22.8), (24, 21.9)], P['yellow'], (0, 0, 0), (90, 0, 0), 24, closed=True)
    b.lathe([(29, 0), (29, 9.2), (40, 9.4), (41, 8.2), (46, 8.2), (48, 6.5), (48, 0)], pk, (0, 0, 0), (90, 0, 0), 18)
    # Spoon (safety lever): over the fuze head, down its side and along the body.
    sp = g.part('spoon', (0, 9.6, 48))
    path = [(-3, 48.6), (9.6, 48.6), (10.8, 47), (10.8, 37), (14, 32)]
    for deg in (60, 50, 40, 30, 20, 10, 0, -8):
        th = math.radians(deg)
        path.append((33.4 * math.cos(th), 33.4 * math.sin(th)))
    sp.extrude(offset_path(path, 0.6), 13, od, 'x', 0)
    sp.extrude(offset_path(path[:5], 0.6), 3, od, 'x', 7.5)
    sp.extrude(offset_path(path[:5], 0.6), 3, od, 'x', -7.5)
    # Pin and pull ring (left side), safety clip.
    pn = g.part('pin', (0, 4, 42))
    pn.cylx(1.2, -18, 12, 4, 42, pk, 8)
    pn.torus(11, 1.3, (-28, 4, 42), pk, (0, 90, 90), 20, 6)
    pn.rod((-9, 4, 42), (-17, 4, 42), 1.6, pk, 8)
    g.e('grip_r', (0, 0, 0))
    g.e('grip_l', (-28, 4, 42))
    g.tex = 512
    g.e('cheek', (-90, -380, 170))                 # eye while holding the grenade ready to throw (approx.)
    g.hip = False
    return g


def m18(P):
    g = Gun('m18'); b = g.body
    od, pk = P['od'], P['park']
    H = 57.0
    b.lathe([(-H, 0), (-H, 30.4), (-H + 1.4, 31.75), (H - 1.4, 31.75), (H, 30.4), (H, 0)], od, (0, 0, 0), (90, 0, 0), 28)
    for z in (-H + 2, H - 5):
        b.lathe([(z, 31.6), (z, 32.8), (z + 3, 32.8), (z + 3, 31.6)], od, (0, 0, 0), (90, 0, 0), 28, closed=True)
    b.lathe([(H - 26, 31.7), (H - 26, 32.0), (H - 6, 32.0), (H - 6, 31.7)], P['green'], (0, 0, 0), (90, 0, 0), 28, closed=True)
    b.cyl(30, 0.6, (0, 0, H + 0.2), P['green'], n=28)
    b.lathe([(-20, 31.7), (-20, 31.95), (-8, 31.95), (-8, 31.7)], P['white'], (0, 0, 0), (90, 0, 0), 28, closed=True, a0=200, a1=340)
    for k in range(4):
        a = math.radians(45 + k * 90)
        b.cyl(3.2, 0.8, (17 * math.sin(a), 17 * math.cos(a), H + 0.4), P['dark'], n=10)
    b.lathe([(H - 1, 0), (H - 1, 9.5), (H + 12, 9.6), (H + 13, 8.2), (H + 19, 8.2), (H + 21, 6.5), (H + 21, 0)], pk,
            (0, 0, 0), (90, 0, 0), 18)
    zt = H + 21.6
    sp = g.part('spoon', (0, 9.6, zt))
    path = [(-3, zt), (9.6, zt), (10.8, zt - 1.5), (10.8, H + 9), (16, H + 2), (32.4, H + 1), (32.6, H - 4),
            (32.6, -30), (31.4, -36)]
    sp.extrude(offset_path(path, 0.6), 13, od, 'x', 0)
    pn = g.part('pin', (0, 4, H + 14))
    pn.cylx(1.2, -18, 12, 4, H + 14, pk, 8)
    pn.torus(11, 1.3, (-28, 4, H + 14), pk, (0, 90, 90), 20, 6)
    g.e('grip_r', (0, 0, 0))
    g.e('grip_l', (-28, 4, H + 14))
    g.tex = 512
    g.e('cheek', (-90, -380, 170))                 # eye while holding the grenade ready to throw (approx.)
    g.hip = False
    return g


def m2(P):
    g = Gun('m2'); b = g.body
    pk, po, od = P['park'], P['poly'], P['od']
    # ---- receiver, back plate, spade grips, butterfly trigger
    b.box2((-60, 0, -110), (60, 560, 62), pk, bevel=3)
    b.box2((-64, 480, -114), (64, 560, 64), pk, bevel=3)
    b.box2((-64, -40, -108), (64, 0, 64), pk, bevel=4)
    for s in (-1, 1):
        b.box((3, 470, 10), (s * 61.4, 245, -30), pk, bevel=1)
        for yy in range(30, 470, 40):
            for zz in (-95, 50):
                b.cylx(3.2, s * 60 - 1.6, s * 60 + 1.6, yy, zz, pk, 8)
        b.box((1.5, 150, 32), (s * 60.3, 455, 34), P['dark'])               # feedway
        b.cyl(15, 100, (s * 55, -105, -28), P['wood'], n=16, bevel=3)
        for zz in (25, -80):
            b.box((16, 72, 15), (s * 55, -72, zz), pk, bevel=3)
    b.box((50, 6, 26), (0, -58, -25), pk, bevel=2)
    b.box((10, 22, 10), (0, -47, -25), pk, bevel=1)
    b.box((14, 10, 10), (0, -45, 56), pk, bevel=1.5)
    b.box((5, 260, 14), (63, 260, -20), pk, bevel=1)                         # retracting slide (right)
    b.box((16, 20, 30), (72, 300, -20), pk, bevel=2)
    b.cylx(8, 78, 96, 300, -10, po, 12, bevel=1)
    # Rear sight leaf (up) on the receiver top, rear left.
    b.box((30, 44, 10), (-28, 60, 67), pk, bevel=2)
    for s in (-1, 1):
        b.box((3.5, 4, 42), (-28 + s * 10.5, 58, 91), pk, bevel=0.8)
    b.box((24.5, 4, 3), (-28, 58, 111.5), pk, bevel=0.6)
    b.box((21, 3, 3), (-28, 58, 92), pk)
    aperture(b, pk, -28, 58, 100, 5.5, 1.5, 3)
    b.cylx(6, -50, -43, 60, 67, pk, 12)
    # ---- barrel support (perforated), barrel, carrying handle, flash hider, front sight
    b.lathe_y([(560, 0), (560, 44), (568, 44), (570, 42), (720, 42), (722, 40), (722, 0)], m=pk, n=28)
    for i in range(4):
        for k in range(10):
            a = k * 36 + (18 if i % 2 else 0)
            ar = math.radians(a)
            b.cyl(5.5, 0.8, (42.2 * math.sin(ar), 592 + i * 34, 42.2 * math.cos(ar)), P['dark'], (0, a, 0), 8)
    b.lathe_y([(400, 0), (400, 24), (722, 24), (760, 23), (800, 22), (1440, 16.5), (1495, 16.5), (1495, 0)], m=pk, n=20)
    b.lathe_y([(780, 21.8), (780, 28), (802, 28), (802, 21.8)], m=pk, n=18, closed=True)
    for yy in (783, 799):
        b.box((10, 8, 34), (0, yy, 44), pk, bevel=1.5)
    b.tube(9, 760, 822, 0, 64, P['wood'], 14, bevel=2)
    b.lathe_y([(1490, 8), (1490, 18), (1540, 21.5), (1540, 13), (1500, 10)], m=pk, n=20, closed=True)
    b.box((14, 22, 50), (-28, 600, 52), pk, bevel=2)
    b.box((3, 3, 24), (-28, 600, 88), pk)                                    # front post (tip z=100)
    for s in (-1, 1):
        b.box((2.5, 16, 26), (-28 + s * 6.5, 600, 88), pk, bevel=0.5)
    # ---- cradle, trunnion yoke, pintle
    b.box2((-72, 120, -140), (72, 560, -112), pk, bevel=4)
    for s in (-1, 1):
        b.box((12, 90, 60), (s * 78, 470, -140), pk, bevel=3)
        b.box((14, 60, 76), (s * 92, 470, -182), pk, bevel=3)
    b.cylx(10, -101, 101, 470, -150, P['steel'], 16)
    b.box((200, 60, 20), (0, 470, -218), pk, bevel=4)
    b.cyl(30, 16, (0, 470, -236), pk, n=20, bevel=2)
    b.cyl(22, 140, (0, 470, -312), pk, n=20)
    b.box((24, 40, 40), (0, 150, -160), pk, bevel=3)
    b.box2((-236, 340, -148), (-72, 660, -140), pk, bevel=2)                 # ammo can tray
    b.box((10, 300, 20), (-236, 500, -132), pk, bevel=2)
    # ---- top cover (hinged at its front)
    cv = g.part('cover', (0, 552, 64))
    cv.box2((-56, 300, 62), (56, 556, 84), pk, bevel=4)
    cv.box((30, 18, 14), (0, 308, 88), pk, bevel=2)
    cv.box((44, 130, 10), (0, 470, 87), pk, bevel=3)
    # ---- M2A1 ammunition can on the left, belt into the feedway
    bx = g.part('box', (-150, 500, 56))
    bx.box2((-228, 345, -138), (-76, 650, 46), od, bevel=3)
    bx.box2((-231, 343, 42), (-73, 652, 56), od, bevel=3)
    for zz in (-90, -30):
        bx.box((3, 280, 6), (-229, 497, zz), od, bevel=1)
    bx.box((10, 40, 24), (-233, 497, 34), pk, bevel=2)
    bx.torus(16, 3, (-152, 497, 58), pk, (0, 0, 90), 14, 6)
    belt(bx, P, [(-120, 74), (-98, 72), (-78, 60)], 385, '50')
    g.grip = Vector((0, -105, -28))
    g.e('grip_r', (55, -105, -28))
    g.e('grip_l', (-55, -105, -28))
    g.e('muzzle', (0, 1540, 0))
    g.e('eye', (-28, 53, 100))
    g.cheek((-28, 53, 100), 300)
    g.mark('M2 HB\nCAL .50', 300, -40, 7, -1)
    g.e('eject', (0, 400, -112))
    g.e('pivot', (0, 470, -150))
    return g



# =====================================================================================================
BUILDS = {
    'm4a1': lambda P: ar15(Gun('m4a1'), P, 'm4a1'),
    'm4a1_m203': lambda P: ar15(Gun('m4a1_m203'), P, 'm4a1_m203'),
    'm16a4': lambda P: ar15(Gun('m16a4'), P, 'm16a4'),
    'm249': m249, 'm240b': m240b, 'm24': m24, 'm136': m136, 'm9': m9, 'm67': m67, 'm18': m18, 'm2': m2,
}


def main():
    os.makedirs(OUT, exist_ok=True)
    for gid, fn in BUILDS.items():
        if ONLY and gid not in ONLY:
            continue
        reset(); clear_mats(); FINISH.clear()
        P = mats()
        g = fn(P)
        root, objs = g.build()
        bpy.context.view_layer.update()
        print(f'BUILT {gid}: {tri_count(objs)} tris, children {sorted(o.name for o in root.children)}', flush=True)
        if not NOBAKE:
            bake_weapon(gid, objs, 512 if FAST else g.tex, samples=4 if FAST else 6, log=lambda s: print(s, flush=True))
        for on in sorted({d.get('obj', 'body') for d in g.decals}):
            ob = [o for o in objs if o.name == on][0]
            add_decal_quads(ob, gid if on == 'body' else f'{gid}_{on}', [d for d in g.decals if d.get('obj', 'body') == on],
                            log=lambda s: print(s, flush=True))
        if PREV:
            os.makedirs(PREV, exist_ok=True)
            emp = {o.name: o.matrix_world.translation.copy() for o in root.children if o.type == 'EMPTY'}
            fp = None
            if 'cheek' in emp and g.hip:
                fp = (emp['cheek'], emp['cheek'] + Vector((0, 1, 0)))
            res, smp = ((640, 360), 8) if FAST else (((640, 360), 16) if SMALL else ((960, 540), 16))
            extra = {}
            if 'detail' in emp:
                extra['detail'] = (Vector((0.8, -0.35, 0.45)), emp['detail'], 0.38)
                extra['marks'] = (Vector((-1, 0.05, 0.12)), emp['detail'], 0.3)
                bpy.data.objects.remove(bpy.data.objects['detail'], do_unlink=True)
            if g.hip:
                # Hip view: camera 0.18 m right, 0.12 m above, 0.25 m behind the grip, looking forward.
                hp = Vector((0.18, -0.25, 0.12))
                extra['hip'] = ('at', hp, hp + Vector((0, 1, 0)), 35)
            render_views(os.path.join(PREV, gid), objs, fp, res=res, samples=smp, extra=extra)
            if 'cheek_gl' in emp:
                render_views(os.path.join(PREV, gid + '_gl'), objs, (emp['cheek_gl'], emp['front_gl']), res=res,
                             samples=smp, views_only_fp=True)
        export_glb(os.path.join(OUT, f'{gid}.glb'), root)
        print('EXPORTED', gid, flush=True)


main()

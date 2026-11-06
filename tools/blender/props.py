"""Props kit for the insurgency city: vegetation, rooftop and street clutter, US FOB pieces, weapon caches and mosque
architecture. Everything is built from code (procedural numpy textures packed into a few atlas pages) and exported as
ONE file with one root object per prop id:
    ~/blender-4.5.13-linux-x64/blender -b --factory-startup --python tools/blender/props.py -- public/models [--preview tools/blender/previews] [--only id,id]
Conventions (see CLAUDE.md): metres, Blender Z up, +Y forward, origin at the base centre (z = 0 is the ground),
transforms applied. Each root is a single mesh with one material per atlas page it uses (1-2 draw calls):
  props_city / props_mil / props_arch  opaque pages (base colour + metallic-roughness)
  props_veg / props_cloth              alpha-clipped, double-sided pages (foliage, mesh, nets, canvas, flags)
Wall-mounted props (awning_shop, sign_shop, shop_shutter) have their back on the wall plane y = 0 and face +Y."""
import os, sys, math, random, tempfile, shutil
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import bpy
from mathutils import Vector, Matrix
from pcommon import (Atlas, MB, T, look, fbm, resize, col, mix, seg, polyline, disc, fill_poly, rect, script_strokes,
                     stencil_glyphs, empty_at, tri_count, bounds, preview_sheet, preview_cam, setup_preview_scene)

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = argv[0] if argv and not argv[0].startswith('--') else 'public/models'
PREV = argv[argv.index('--preview') + 1] if '--preview' in argv else None
ONLY = set(argv[argv.index('--only') + 1].split(',')) if '--only' in argv else None
SHEETS = set(argv[argv.index('--sheets') + 1].split(',')) if '--sheets' in argv else None
ATLAS_DUMP = argv[argv.index('--atlas') + 1] if '--atlas' in argv else None

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.scene.unit_settings.system = 'METRIC'
A = Atlas(1024, seed=7)
for g in ('city', 'mil', 'arch', 'home'):
    A.group(g)
for g in ('veg', 'cloth'):
    A.group(g, cutout=True)

def R(rng):
    """Python Random seeded from a numpy generator (painters use both)."""
    return random.Random(int(rng.integers(1 << 30)))

def grime(c, rng, amt=0.25, scale=24, streaks=0.0, bottom=0.0):
    """Generic weathering: blotchy darkening, vertical rain streaks, dirt rising from the bottom (v = 0)."""
    h, w = c.shape[:2]
    n = fbm(h, w, rng, scale, 4)
    c = c * (1 - amt * np.clip(n - 0.45, 0, 1)[..., None] * 1.8)
    if streaks:
        s = fbm(h, w, rng, max(6, w / 6), 3, aspect=0.15)
        c = c * (1 - streaks * 0.9 * np.clip(s - 0.55, 0, 1)[..., None] * 2)
    if bottom:
        y = np.linspace(0, 1, h)[:, None]
        d = np.clip(1 - y / 0.25, 0, 1) * (0.6 + 0.4 * fbm(h, w, rng, 8, 2))
        c = mix(c, c * 0.55 + np.array([0.16, 0.12, 0.08]), d * bottom)
    return c

# ============================================================================================ swatches (all opaque pages)
SW = dict(
    black_plastic=((0.07, 0.07, 0.07), 0.55, 0, 0.5), white_plastic=((0.80, 0.78, 0.72), 0.5, 0, 0.7),
    cream_metal=((0.80, 0.78, 0.70), 0.45, 0, 0.5), galv=((0.60, 0.61, 0.60), 0.45, 0.85, 0.4),
    steel_dark=((0.17, 0.17, 0.17), 0.5, 0.8, 0.3), grey_paint=((0.45, 0.46, 0.45), 0.6, 0, 0.5),
    olive=((0.31, 0.32, 0.20), 0.7, 0, 0.4), od_green=((0.25, 0.28, 0.17), 0.65, 0, 0.3),
    tan_paint=((0.62, 0.53, 0.38), 0.7, 0, 0.5), desert_tan=((0.70, 0.60, 0.44), 0.85, 0, 0.4),
    red_paint=((0.55, 0.11, 0.07), 0.55, 0, 0.4), blue_paint=((0.13, 0.26, 0.45), 0.55, 0, 0.4),
    green_paint=((0.20, 0.34, 0.22), 0.55, 0, 0.4), yellow_paint=((0.85, 0.64, 0.12), 0.55, 0, 0.5),
    rubber=((0.045, 0.045, 0.045), 0.9, 0, 0.2), wood_dark=((0.30, 0.20, 0.12), 0.8, 0, 0.4),
    wood_light=((0.60, 0.46, 0.30), 0.8, 0, 0.4), rust=((0.42, 0.21, 0.10), 0.9, 0.2, 0.6),
    copper=((0.70, 0.42, 0.26), 0.4, 1.0, 0.3), glass_dark=((0.05, 0.07, 0.08), 0.1, 0, 0),
    lamp=((0.95, 0.93, 0.84), 0.2, 0, 0), ceramic=((0.86, 0.85, 0.80), 0.25, 0, 0.3),
    ceramic_brown=((0.36, 0.20, 0.11), 0.25, 0, 0.2), gold=((0.86, 0.66, 0.28), 0.3, 1.0, 0.1),
    concrete=((0.62, 0.60, 0.56), 0.9, 0, 0.5), sand=((0.78, 0.68, 0.50), 0.95, 0, 0.3),
    dirt=((0.42, 0.35, 0.26), 1.0, 0, 0.4), ash=((0.12, 0.11, 0.10), 1.0, 0, 0.3),
    orange=((0.90, 0.48, 0.08), 0.5, 0, 0.1), tomato=((0.70, 0.10, 0.06), 0.4, 0, 0.1),
    green_veg=((0.24, 0.44, 0.12), 0.5, 0, 0.2), melon=((0.36, 0.50, 0.20), 0.5, 0, 0.3),
    cardboard=((0.62, 0.48, 0.32), 0.95, 0, 0.6), bag_black=((0.05, 0.05, 0.055), 0.35, 0, 0.3),
    bag_blue=((0.20, 0.35, 0.60), 0.4, 0, 0.3), bag_white=((0.80, 0.80, 0.78), 0.45, 0, 0.5),
    turquoise=((0.12, 0.58, 0.60), 0.3, 0, 0.2), cobalt=((0.10, 0.20, 0.52), 0.3, 0, 0.2),
    plaster=((0.84, 0.80, 0.70), 0.9, 0, 0.5), water=((0.12, 0.24, 0.22), 0.05, 0, 0),
    gunmetal=((0.10, 0.10, 0.11), 0.45, 0.7, 0.2), stock_wood=((0.34, 0.17, 0.08), 0.55, 0, 0.35),
    bakelite=((0.35, 0.12, 0.06), 0.4, 0, 0.2), rpg_green=((0.27, 0.30, 0.18), 0.6, 0, 0.3),
    canvas_tan=((0.66, 0.56, 0.40), 0.95, 0, 0.5), aluminium=((0.75, 0.76, 0.76), 0.35, 0.9, 0.3),
    insulation=((0.25, 0.25, 0.25), 0.8, 0, 0.3), brick_red=((0.56, 0.32, 0.22), 0.9, 0, 0.5), fuel_red=((0.62, 0.12, 0.06), 0.5, 0, 0.4),
)
for k, (c, ro, me, d) in SW.items():
    A.swatch(k, c, ro, me, 0.06, 6, d)

# ============================================================================================ vegetation (cutout 'veg')
FROND_L, FROND_W = 3.6, 0.36       # metres covered by a frond cell (length, half-width)
def p_frond(green=True, variant=0):
    """One half-frond: u along the frond (base -> tip, 3.6 m), v from the rachis (0) out to 0.30 m (1).
    Date palm leaflets: stiff, narrow (2-2.5 cm), folded, glaucous grey-green, 25-45 cm long, pointing forward at
    ~30-45 degrees, in loose groups; short spines on the petiole. Drawn in metres then scaled (anisotropic px)."""
    def p(w, h, rng):
        r = R(rng)
        sx, sy = w / FROND_L, h / FROND_W
        k = (sx + sy) / 2
        rgb = np.zeros((h, w, 3)); a = np.zeros((h, w))
        P = lambda x, y: (x * sx, y * sy)
        xm = 0.42
        while xm < FROND_L * 0.99:
            t = xm / FROND_L
            ang = math.radians(r.uniform(28, 40) + 10 * t)
            ln = (0.26 + 0.30 * math.sin(math.pi * min(1.0, t * 1.1))) * r.uniform(0.85, 1.08)
            if not green and r.random() < 0.3:
                ln *= r.uniform(0.4, 0.8)                      # broken dry leaflets
            reach = min(ln * math.sin(ang), FROND_W * 0.97)
            along = reach / math.tan(ang)
            hw = r.uniform(0.010, 0.014)
            if green:
                base = np.array([0.31, 0.39, 0.23]) * r.uniform(0.78, 1.12)
                base = base + np.array([0.05, 0.04, 0.0]) * (1 - t)
                if r.random() < 0.05:
                    base = np.array([0.56, 0.50, 0.36]) * r.uniform(0.8, 1.0)
            else:
                base = np.array([0.58, 0.48, 0.34]) * r.uniform(0.72, 1.1)
            x0, y0 = P(xm, 0.004); xm_, ym_ = P(xm + along * 0.4, reach * 0.4); x1, y1 = P(xm + along, reach)
            seg(rgb, a, (x0, y0), (xm_, ym_), hw * 0.45 * k, hw * k, base, shade=0.5)
            seg(rgb, a, (xm_, ym_), (x1, y1), hw * k, 0.4, base * 0.96, shade=0.5)
            if green and r.random() < 0.2:                     # dry, split tip
                tx, ty = P(xm + along * 0.8, reach * 0.8)
                seg(rgb, a, (tx, ty), (x1, y1), hw * 0.6 * k, 0.4, (0.52, 0.45, 0.31))
            xm += r.uniform(0.05, 0.075) if r.random() > 0.35 else r.uniform(0.012, 0.02)
        xm = 0.03
        while xm < 0.42:                                       # spines on the petiole
            ln = r.uniform(0.05, 0.11); ang = math.radians(r.uniform(25, 45))
            x0, y0 = P(xm, 0.0); x1, y1 = P(xm + ln * math.cos(ang), ln * math.sin(ang))
            seg(rgb, a, (x0, y0), (x1, y1), 0.006 * k, 0.4, (0.64, 0.60, 0.42) if green else (0.55, 0.47, 0.33), shade=0.3)
            xm += r.uniform(0.03, 0.07)
        n = fbm(h, w, rng, 40, 3)
        rgb = rgb * (0.9 + 0.2 * n[..., None])
        return dict(rgb=rgb, a=a)
    return p
A.cell('frond_a', 'veg', 1016, 128, p_frond(True, 0))
A.cell('frond_b', 'veg', 1016, 128, p_frond(True, 1))
A.cell('frond_dry', 'veg', 1016, 96, p_frond(False))

def p_palm_bark(w, h, rng):
    """Date palm trunk: diamond lattice of cut leaf bases (boots) - lit upper cut face, shadowed lower lip - with
    dark fibre in the gaps. Tiles in u (around) and v (up)."""
    r = R(rng)
    c = col((0.24, 0.19, 0.14), h, w) * (0.75 + 0.5 * fbm(h, w, rng, 5, 3, aspect=0.4)[..., None])
    cols, rows = 4, 7
    cw, rh = w / cols, h / rows
    for j in range(-1, 2 * rows + 2):
        for i in range(-1, cols + 1):
            cx = (i + 0.5 * (j % 2)) * cw + r.uniform(-2, 2)
            cy = j * rh / 2 + r.uniform(-2, 2)
            hw = cw * 0.5 * r.uniform(0.80, 0.9); hh = rh * 0.5 * r.uniform(0.78, 0.9)
            tone = np.array([0.46, 0.38, 0.29]) * r.uniform(0.80, 1.12)
            for ox in (-w, 0, w):
                for oy in (-h, 0, h):
                    X, Y = cx + ox, cy + oy
                    if Y < -rh or Y > h + rh:
                        continue
                    fill_poly(c, None, [(X - hw, Y), (X, Y - hh), (X + hw, Y)], tone * 0.72, ss=1)            # lower lip (shade)
                    fill_poly(c, None, [(X - hw, Y), (X + hw, Y), (X, Y + hh)], tone * 0.95, ss=1)            # upper cut face
                    fill_poly(c, None, [(X - hw * 0.5, Y + hh * 0.1), (X + hw * 0.5, Y + hh * 0.1), (X, Y + hh * 0.55)], tone * 1.04, 0.5, ss=1)
                    seg(c, None, (X - hw, Y), (X + hw, Y), 1.2, 1.2, tone * 0.5)
    s = fbm(h, w, rng, 3, 2, aspect=0.25)
    c = c * (0.8 + 0.32 * s[..., None])
    c = mix(c, np.array([0.50, 0.46, 0.40]), 0.25 * fbm(h, w, rng, 60, 2))   # dusty grey cast
    return dict(rgb=c)
A.cell('palm_bark', 'veg', 256, 512, p_palm_bark)

def p_palm_boots(w, h, rng):
    """Crown base: big fresh leaf bases with brown fibre mesh."""
    r = R(rng)
    c = col((0.22, 0.16, 0.10), h, w)
    for _ in range(900):                                   # fibre
        x, y = r.uniform(0, w), r.uniform(0, h); a = r.uniform(-0.6, 0.6) + math.pi / 2
        L = r.uniform(8, 30)
        seg(c, None, (x, y), (x + math.cos(a) * L, y + math.sin(a) * L), 0.7, 0.5, np.array((0.45, 0.33, 0.20)) * r.uniform(0.6, 1.2))
    for i in range(5):
        cx = (i + 0.5) * w / 5 + r.uniform(-4, 4)
        tone = np.array([0.40, 0.31, 0.20]) * r.uniform(0.85, 1.05)
        fill_poly(c, None, [(cx - 18, 0), (cx + 18, 0), (cx + 13, h * 0.75), (cx, h * 0.95), (cx - 13, h * 0.75)], tone)
        seg(c, None, (cx - 14, h * 0.05), (cx - 10, h * 0.72), 1.5, 1.0, tone * 0.7)
    return dict(rgb=c * (0.85 + 0.3 * fbm(h, w, rng, 16, 3)[..., None]))
A.cell('palm_boots', 'veg', 128, 128, p_palm_boots)

def p_flat(rgb, var=0.1, scale=8):
    def p(w, h, rng):
        return dict(rgb=col(rgb, h, w) * (1 - var + 2 * var * fbm(h, w, rng, scale, 3)[..., None]))
    return p
A.cell('rachis', 'veg', 32, 64, p_flat((0.60, 0.58, 0.40), 0.12))
A.cell('dates', 'veg', 32, 32, p_flat((0.58, 0.30, 0.09), 0.3, 3))
A.cell('leaf_core', 'veg', 32, 32, p_flat((0.13, 0.20, 0.08), 0.25, 3))

def p_deadwood(w, h, rng):
    c = col((0.42, 0.38, 0.33), h, w)
    s = fbm(h, w, rng, 5, 3, aspect=0.12)
    c = c * (0.7 + 0.5 * s[..., None])
    cr = fbm(h, w, rng, 10, 2, aspect=0.1)
    c = mix(c, np.array([0.18, 0.15, 0.12]), np.clip((cr - 0.75) * 4, 0, 1))
    return dict(rgb=c)
A.cell('deadwood', 'veg', 64, 256, p_deadwood)

def p_shrub_dry(w, h, rng):
    """Dry desert shrub card: woody twigs fanning up from the base, sparse grey-olive leaves."""
    r = R(rng)
    rgb = np.zeros((h, w, 3)); a = np.zeros((h, w))
    def branch(x, y, ang, L, rad, depth):
        x2 = x + math.cos(ang) * L; y2 = y + math.sin(ang) * L
        if y2 > h * 0.97: y2 = h * 0.97
        seg(rgb, a, (x, y), (x2, y2), rad, rad * 0.65, np.array((0.40, 0.33, 0.25)) * r.uniform(0.7, 1.1))
        if depth > 0:
            for _ in range(r.randint(2, 3)):
                branch(x2, y2, ang + r.uniform(-0.7, 0.7), L * r.uniform(0.55, 0.8), rad * 0.65, depth - 1)
        else:
            for _ in range(r.randint(2, 5)):
                lx, ly = x2 + r.uniform(-6, 6), y2 + r.uniform(-6, 6)
                disc(rgb, a, (lx, ly), r.uniform(1.4, 2.6), np.array((0.47, 0.46, 0.33)) * r.uniform(0.75, 1.15))
    for _ in range(9):
        branch(w / 2 + r.uniform(-14, 14), 0, math.pi / 2 + r.uniform(-1.1, 1.1), h * r.uniform(0.22, 0.32), 3.0, 4)
    return dict(rgb=rgb, a=a)
A.cell('shrub_dry', 'veg', 256, 256, p_shrub_dry)

def p_oleander(w, h, rng):
    """Oleander card: dense lanceolate dark leaves in whorls, pink flower clusters, dome silhouette."""
    r = R(rng)
    rgb = np.zeros((h, w, 3)); a = np.zeros((h, w))
    for _ in range(14):
        x = w / 2 + r.uniform(-30, 30)
        seg(rgb, a, (x, 0), (x + r.uniform(-90, 90), h * r.uniform(0.5, 0.85)), 2.5, 1.2, (0.30, 0.25, 0.18))
    for _ in range(950):
        ang = r.uniform(0, 2 * math.pi); rad = math.sqrt(r.random())
        cx = w / 2 + math.cos(ang) * rad * w * 0.46
        cy = h * 0.45 + math.sin(ang) * rad * h * 0.5
        if cy < h * 0.08: continue
        la = r.uniform(0, 2 * math.pi); L = r.uniform(12, 22)
        tone = np.array((0.16, 0.30, 0.11)) * r.uniform(0.7, 1.35)
        seg(rgb, a, (cx, cy), (cx + math.cos(la) * L, cy + math.sin(la) * L), 2.6, 0.5, tone, shade=0.4)
    for _ in range(26):
        ang = r.uniform(0.2, math.pi - 0.2); rad = r.uniform(0.55, 0.95)
        cx = w / 2 + math.cos(ang) * rad * w * 0.44; cy = h * 0.45 + math.sin(ang) * rad * h * 0.48
        pink = np.array((0.88, 0.45, 0.58)) if r.random() < 0.8 else np.array((0.92, 0.9, 0.85))
        for _ in range(6):
            disc(rgb, a, (cx + r.uniform(-6, 6), cy + r.uniform(-5, 5)), r.uniform(2.5, 4.0), pink * r.uniform(0.8, 1.05), shade=0.3)
    return dict(rgb=rgb, a=a)
A.cell('oleander', 'veg', 256, 256, p_oleander)

def p_euca_foliage(w, h, rng):
    """Eucalyptus (E. camaldulensis, the river red gum planted in Iraqi windbreaks): a loose, drooping spray of narrow
    sickle-shaped grey-green leaves hanging from thin twigs; ragged, see-through outline."""
    r = R(rng)
    rgb = np.zeros((h, w, 3)); a = np.zeros((h, w))
    for _ in range(9):
        x0, y0 = w / 2 + r.uniform(-40, 40), h * r.uniform(0.55, 0.8)
        x1, y1 = x0 + r.uniform(-100, 100), y0 + r.uniform(-60, 40)
        seg(rgb, a, (x0, y0), (x1, y1), 1.6, 0.8, (0.36, 0.28, 0.22))
    for _ in range(700):
        ang = r.uniform(0, 2 * math.pi); rad = math.sqrt(r.random())
        cx = w / 2 + math.cos(ang) * rad * w * 0.47
        cy = h * 0.52 + math.sin(ang) * rad * h * 0.46
        if r.random() < 0.18: continue
        L = r.uniform(14, 26); la = -math.pi / 2 + r.uniform(-0.7, 0.7)  # hanging
        tone = np.array((0.34, 0.40, 0.27)) * r.uniform(0.7, 1.25)
        if r.random() < 0.15: tone = np.array((0.46, 0.44, 0.30)) * r.uniform(0.8, 1.1)
        seg(rgb, a, (cx, cy), (cx + math.cos(la) * L * 0.4, cy + math.sin(la) * L), 2.2, 0.4, tone, shade=0.35)
    return dict(rgb=rgb, a=a)
A.cell('euca_foliage', 'veg', 256, 256, p_euca_foliage)

def p_euca_bark(w, h, rng):
    """Smooth pale eucalyptus bark with darker strips peeling away."""
    c = col((0.70, 0.66, 0.58), h, w)
    s = fbm(h, w, rng, 6, 3, aspect=0.15)
    c = c * (0.88 + 0.2 * s[..., None])
    pe = fbm(h, w, rng, 4, 2, aspect=0.12)
    c = mix(c, np.array([0.55, 0.47, 0.38]), np.clip((pe - 0.6) * 3, 0, 0.8))
    return dict(rgb=c)
A.cell('euca_bark', 'veg', 64, 256, p_euca_bark)

def p_orchard_foliage(w, h, rng):
    """Citrus orchard tree card: dense glossy dark-green oval leaves, a few oranges, rounded outline."""
    r = R(rng)
    rgb = np.zeros((h, w, 3)); a = np.zeros((h, w))
    for _ in range(1100):
        ang = r.uniform(0, 2 * math.pi); rad = math.sqrt(r.random())
        cx = w / 2 + math.cos(ang) * rad * w * 0.46; cy = h * 0.5 + math.sin(ang) * rad * h * 0.46
        la = r.uniform(0, 2 * math.pi); L = r.uniform(9, 15)
        tone = np.array((0.10, 0.22, 0.07)) * r.uniform(0.7, 1.45)
        seg(rgb, a, (cx, cy), (cx + math.cos(la) * L, cy + math.sin(la) * L), 3.4, 1.2, tone, shade=0.45)
    for _ in range(18):
        ang = r.uniform(0, 2 * math.pi); rad = r.uniform(0.2, 0.9)
        disc(rgb, a, (w / 2 + math.cos(ang) * rad * w * 0.42, h * 0.5 + math.sin(ang) * rad * h * 0.42), r.uniform(3.5, 5.0), np.array((0.85, 0.45, 0.06)) * r.uniform(0.85, 1.05), shade=0.3)
    return dict(rgb=rgb, a=a)
A.cell('orchard_foliage', 'veg', 256, 256, p_orchard_foliage)

def p_tamarisk(w, h, rng):
    """Tamarisk: feathery sprays of tiny scale leaves, grey-green with pale pink flower plumes at the tips."""
    r = R(rng)
    rgb = np.zeros((h, w, 3)); a = np.zeros((h, w))
    for _ in range(60):
        x0, y0 = w / 2 + r.uniform(-25, 25), h * r.uniform(0.0, 0.3)
        ang = math.pi / 2 + r.uniform(-1.0, 1.0); L = h * r.uniform(0.4, 0.8)
        pts = [(x0, y0)]
        for k in range(6):
            ang += r.uniform(-0.18, 0.18)
            pts.append((pts[-1][0] + math.cos(ang) * L / 6, pts[-1][1] + math.sin(ang) * L / 6))
        for (xa, ya), (xb, yb) in zip(pts, pts[1:]):
            seg(rgb, a, (xa, ya), (xb, yb), 1.0, 0.6, (0.40, 0.34, 0.28))
            for _ in range(5):
                t = r.random(); x, y = xa + (xb - xa) * t, ya + (yb - ya) * t
                la = ang + r.uniform(-1.4, 1.4); L2 = r.uniform(6, 14)
                seg(rgb, a, (x, y), (x + math.cos(la) * L2, y + math.sin(la) * L2), 1.6, 0.7, np.array((0.40, 0.46, 0.34)) * r.uniform(0.75, 1.2), shade=0.3)
        if r.random() < 0.5:
            for _ in range(5):
                disc(rgb, a, (pts[-1][0] + r.uniform(-5, 5), pts[-1][1] + r.uniform(-5, 5)), r.uniform(1.8, 3.0), np.array((0.86, 0.66, 0.70)) * r.uniform(0.85, 1.05), shade=0.25)
    return dict(rgb=rgb, a=a)
A.cell('tamarisk', 'veg', 256, 256, p_tamarisk)

def p_reeds(w, h, rng):
    """Common reed (Phragmites) clump: tall stems with long tapering blades and purple-brown plumes."""
    r = R(rng)
    rgb = np.zeros((h, w, 3)); a = np.zeros((h, w))
    for _ in range(46):
        x0 = w / 2 + r.gauss(0, w * 0.12); top = h * r.uniform(0.6, 0.97); lean = r.uniform(-0.18, 0.18)
        stem = np.array((0.55, 0.52, 0.32)) * r.uniform(0.75, 1.1)
        pts = [(x0 + lean * (top * t) + 8 * lean * t * t * h / 100, top * t) for t in np.linspace(0, 1, 6)]
        polyline(rgb, a, pts, 1.6, 0.8, stem)
        for k in range(r.randint(3, 6)):
            t = r.uniform(0.2, 0.8); bx, by = pts[int(t * 5)]
            side = r.choice((-1, 1)); L = r.uniform(30, 70)
            ex = bx + side * L * 0.7; ey = by + L * r.uniform(0.1, 0.6)
            ex2 = ex + side * L * 0.25; ey2 = ey - L * 0.25
            leaf = np.array((0.42, 0.50, 0.26)) * r.uniform(0.7, 1.15) if r.random() < 0.6 else np.array((0.62, 0.56, 0.36))
            seg(rgb, a, (bx, by), (ex, ey), 1.0, 2.8, leaf, shade=0.3)
            seg(rgb, a, (ex, ey), (ex2, ey2), 2.8, 0.3, leaf, shade=0.3)
        if r.random() < 0.7:   # plume
            px, py = pts[-1]
            for _ in range(30):
                ang = math.pi / 2 + r.uniform(-0.5, 0.5) + lean
                L = r.uniform(10, 34)
                seg(rgb, a, (px, py - 25 + r.uniform(0, 25)), (px + math.cos(ang) * L, py - 25 + math.sin(ang) * L), 1.2, 0.4, np.array((0.48, 0.38, 0.33)) * r.uniform(0.8, 1.2))
    return dict(rgb=rgb, a=a)
A.cell('reeds', 'veg', 256, 448, p_reeds)

def p_grass_dry(w, h, rng):
    r = R(rng)
    rgb = np.zeros((h, w, 3)); a = np.zeros((h, w))
    for _ in range(80):
        x0 = w / 2 + r.gauss(0, w * 0.12); L = h * r.uniform(0.4, 0.97); ang = math.pi / 2 + r.uniform(-0.8, 0.8)
        mx = x0 + math.cos(ang) * L * 0.5; my = math.sin(ang) * L * 0.5
        ex = x0 + math.cos(ang) * L + (ang - math.pi / 2) * 25; ey = math.sin(ang) * L * 0.9
        c = np.array((0.72, 0.62, 0.40)) * r.uniform(0.7, 1.12) if r.random() < 0.85 else np.array((0.48, 0.48, 0.30))
        seg(rgb, a, (x0, 0), (mx, my), 1.8, 1.3, c, shade=0.3)
        seg(rgb, a, (mx, my), (ex, ey), 1.3, 0.3, c, shade=0.3)
    return dict(rgb=rgb, a=a)
A.cell('grass_dry', 'veg', 256, 128, p_grass_dry)

# ============================================================================================ cloth / mesh (cutout 'cloth')
def p_canvas(c1, c2, stripes=8):
    """Market canvas: faded alternating stripes along u, scalloped valance in the bottom 14 % of v."""
    def p(w, h, rng):
        r = R(rng)
        x = np.arange(w)[None, :]
        band = ((x * stripes // w) % 2).astype(float)
        c = mix(col(c1, h, w), col(c2, h, w), np.broadcast_to(band, (h, w)))
        n = fbm(h, w, rng, 30, 4)
        c = c * (0.85 + 0.25 * n[..., None])
        c = mix(c, np.array((0.80, 0.74, 0.62)), 0.25 + 0.2 * fbm(h, w, rng, 60, 2))   # sun bleaching and dust
        c = grime(c, rng, 0.3, 30, streaks=0.15)
        a = np.ones((h, w))
        vh = int(h * 0.14)
        yy, xx = np.mgrid[0:vh, 0:w]
        sc = w / (stripes * 2)
        y_edge = vh * 0.6 * (1 - np.abs(np.sin((xx + 0.5) / sc * math.pi)) ** 0.7)
        a[:vh] = np.clip(yy + 0.5 - y_edge + 0.5, 0, 1)
        rect(c, 0, vh - 3, w, vh, np.array(c1) * 0.6)
        return dict(rgb=c, a=a)
    return p
A.cell('canvas_rw', 'cloth', 256, 256, p_canvas((0.62, 0.14, 0.10), (0.85, 0.82, 0.74)))
A.cell('canvas_gw', 'cloth', 256, 256, p_canvas((0.16, 0.38, 0.22), (0.85, 0.82, 0.72), 10))
A.cell('canvas_bl', 'cloth', 256, 256, p_canvas((0.14, 0.30, 0.52), (0.80, 0.72, 0.45), 6))

def p_tarp(base, grommets=True, folds=0.5):
    def p(w, h, rng):
        c = col(base, h, w)
        f = fbm(h, w, rng, 40, 4)
        g = fbm(h, w, rng, 12, 2, aspect=4)
        c = c * (0.75 + 0.35 * f[..., None]) * (0.9 + folds * 0.2 * g[..., None])
        c = grime(c, rng, 0.35, 20, bottom=0.6)
        if grommets:
            for k in range(8):
                for x, y in ((k * w / 8 + 8, 6), (k * w / 8 + 8, h - 6), (6, k * h / 8 + 8), (w - 6, k * h / 8 + 8)):
                    disc(c, None, (x, y), 2.5, (0.7, 0.68, 0.6))
                    disc(c, None, (x, y), 1.2, (0.05, 0.05, 0.05))
        rect(c, 0, 0, w, 3, np.array(base) * 0.7); rect(c, 0, h - 3, w, h, np.array(base) * 0.7)
        return dict(rgb=c)
    return p
A.cell('tarp_olive', 'cloth', 256, 256, p_tarp((0.32, 0.33, 0.22)))
A.cell('tarp_blue', 'cloth', 256, 256, p_tarp((0.14, 0.32, 0.58)))

def p_tent(w, h, rng):
    """GP medium canvas: tan duck with seams, darker roof dust bands, faded patches (u along the tent, v up)."""
    c = col((0.66, 0.57, 0.41), h, w) * (0.86 + 0.24 * fbm(h, w, rng, 40, 4)[..., None])
    for x in range(0, w, 32):
        rect(c, x, 0, x + 2, h, (0.48, 0.41, 0.29), 0.8)
    for y in (h // 3, 2 * h // 3):
        rect(c, 0, y, w, y + 2, (0.50, 0.43, 0.30), 0.7)
    c = grime(c, rng, 0.3, 30, streaks=0.2, bottom=0.8)
    return dict(rgb=c)
A.cell('tent', 'cloth', 256, 256, p_tent)

def p_flag(w, h, rng):
    """US flag (13 stripes, canton with star dots), slightly faded."""
    c = np.zeros((h, w, 3))
    for k in range(13):
        y0 = h - (k + 1) * h / 13
        rect(c, 0, y0, w, y0 + h / 13 + 1, (0.66, 0.10, 0.15) if k % 2 == 0 else (0.92, 0.90, 0.86))
    cw, ch = w * 0.4, h * 7 / 13
    rect(c, 0, h - ch, cw, h, (0.12, 0.15, 0.36))
    for j in range(9):
        for i in range(11 if j % 2 == 0 else 10):
            if (i + j) % 2 == 0 or True:
                x = (i + (0.5 if j % 2 == 0 else 1.0)) * cw / 12; y = h - (j + 0.75) * ch / 9.5
                if x < cw - 2:
                    disc(c, None, (x, y), 1.4, (0.92, 0.92, 0.9))
    c = c * (0.88 + 0.18 * fbm(h, w, rng, 30, 3)[..., None])
    return dict(rgb=c)
A.cell('flag_us', 'cloth', 256, 136, p_flag)

def p_clothes(w, h, rng):
    """Four garments on a line (64 px slots): shirt, trousers, dishdasha, towel. Alpha silhouettes."""
    r = R(rng)
    rgb = np.zeros((h, w, 3)); a = np.zeros((h, w))
    def S(i, pts, c):
        fill_poly(rgb, a, [(i * 64 + x * 64, y * h) for x, y in pts], c)
    S(0, [(0.05, 1), (0.95, 1), (0.98, 0.72), (0.80, 0.70), (0.80, 0.30), (0.20, 0.30), (0.20, 0.70), (0.02, 0.72)], (0.55, 0.62, 0.70))
    S(1, [(0.12, 1), (0.88, 1), (0.92, 0.05), (0.58, 0.05), (0.5, 0.62), (0.42, 0.05), (0.08, 0.05)], (0.20, 0.20, 0.24))
    S(2, [(0.1, 1), (0.9, 1), (0.95, 0.8), (0.85, 0.78), (0.82, 0.02), (0.18, 0.02), (0.15, 0.78), (0.05, 0.8)], (0.86, 0.85, 0.80))
    S(3, [(0.04, 1), (0.96, 1), (0.95, 0.42), (0.05, 0.40)], (0.75, 0.35, 0.22))
    rect(rgb, 3 * 64, h * 0.5, 4 * 64, h * 0.55, (0.9, 0.85, 0.6))
    rgb = rgb * (0.8 + 0.3 * fbm(h, w, rng, 10, 3, aspect=0.3)[..., None])
    return dict(rgb=rgb, a=a)
A.cell('clothes', 'cloth', 256, 128, p_clothes)

def p_camonet(w, h, rng):
    """Desert camouflage net: knotted string grid with cut garnish patches in sand/ brown/ khaki, ~70 % cover."""
    r = R(rng)
    rgb = np.zeros((h, w, 3)); a = np.zeros((h, w))
    pal = [np.array(c) for c in ((0.72, 0.62, 0.44), (0.55, 0.44, 0.30), (0.62, 0.55, 0.40), (0.42, 0.35, 0.25), (0.78, 0.70, 0.52))]
    for _ in range(260):
        cx, cy = r.uniform(-10, w + 10), r.uniform(-10, h + 10)
        rad = r.uniform(5, 14); n = r.randint(5, 8)
        pts = [(cx + math.cos(2 * math.pi * k / n + r.uniform(-0.3, 0.3)) * rad * r.uniform(0.5, 1.3),
                cy + math.sin(2 * math.pi * k / n + r.uniform(-0.3, 0.3)) * rad * r.uniform(0.5, 1.3)) for k in range(n)]
        fill_poly(rgb, a, pts, r.choice(pal) * r.uniform(0.85, 1.1), ss=1)
    for k in range(0, w, 16):                                # string grid (diamond)
        seg(rgb, a, (k, 0), (k + h, h), 0.8, 0.8, (0.3, 0.27, 0.2))
        seg(rgb, a, (k, 0), (k - h, h), 0.8, 0.8, (0.3, 0.27, 0.2))
        seg(rgb, a, (k - w, 0), (k - w + h, h), 0.8, 0.8, (0.3, 0.27, 0.2))
        seg(rgb, a, (k + w, 0), (k + w - h, h), 0.8, 0.8, (0.3, 0.27, 0.2))
    holes = fbm(h, w, rng, 10, 2)
    a = a * (holes > 0.3)
    return dict(rgb=rgb, a=a)
A.cell('camonet', 'cloth', 256, 256, p_camonet)

def p_hesco_mesh(w, h, rng):
    """Welded galvanised mesh of a HESCO MIL1 cell face: 14 x 18 squares of ~76 mm, 4-5 mm wire."""
    rgb = np.zeros((h, w, 3)); a = np.zeros((h, w))
    nx, ny = 14, 18
    for i in range(nx + 1):
        x = 1 + i * (w - 2) / nx
        seg(rgb, a, (x, 0), (x, h), 1.8, 1.8, (0.62, 0.62, 0.60), shade=0.5)
    for j in range(ny + 1):
        y = 1 + j * (h - 2) / ny
        seg(rgb, a, (0, y), (w, y), 1.8, 1.8, (0.66, 0.66, 0.63), shade=0.5)
    rgb = rgb * (0.8 + 0.3 * fbm(h, w, rng, 30, 3)[..., None])
    rgb = mix(rgb, np.array((0.48, 0.32, 0.2)), 0.25 * fbm(h, w, rng, 20, 2))     # a little rust
    return dict(rgb=rgb, a=a)
A.cell('hesco_mesh', 'cloth', 256, 320, p_hesco_mesh)

def p_razor(w, h, rng):
    """Razor wire ribbon: core wire along u with barbs every ~28 px."""
    rgb = np.zeros((h, w, 3)); a = np.zeros((h, w))
    seg(rgb, a, (0, h / 2), (w, h / 2), 1.6, 1.6, (0.7, 0.7, 0.68), shade=0.4)
    for x in np.arange(8, w, 28):
        fill_poly(rgb, a, [(x - 9, h / 2), (x - 3, h / 2 + h * 0.42), (x, h / 2), (x + 3, h / 2 - h * 0.42), (x + 9, h / 2)], (0.75, 0.75, 0.72))
    return dict(rgb=rgb, a=a)
A.cell('razor', 'cloth', 256, 32, p_razor)

def p_lattice(w, h, rng):
    """Openwork stone balustrade (8-point star / cross lattice), one panel per 64 px."""
    rgb = col((0.80, 0.70, 0.52), h, w) * (0.85 + 0.2 * fbm(h, w, rng, 10, 2)[..., None])
    a = np.ones((h, w))
    yy, xx = np.mgrid[0:h, 0:w] + 0.5
    lx = (xx % 64) - 32; ly = yy - h / 2
    star = (np.abs(lx) + np.abs(ly) < 20) | ((np.abs(lx) < 14) & (np.abs(ly) < 14))
    inner = (np.abs(lx) + np.abs(ly) < 15) | ((np.abs(lx) < 10) & (np.abs(ly) < 10))
    hole = star & ~((np.abs(lx) < 3) | (np.abs(ly) < 3)) & ~(inner & ~((np.abs(lx) + np.abs(ly) < 9)))
    hole |= (np.abs(lx) > 26) & (np.abs(ly) < 22) & (np.abs(lx) < 30)
    a[hole] = 0
    a[:6] = 1; a[-6:] = 1
    return dict(rgb=rgb, a=a)
A.cell('lattice', 'cloth', 256, 64, p_lattice)

def p_soot(w, h, rng):
    yy, xx = np.mgrid[0:h, 0:w] + 0.5
    d = np.hypot(xx - w / 2, yy - h / 2) / (w / 2)
    n = fbm(h, w, rng, 12, 3)
    a = np.clip((1 - d) * 2.2 + (n - 0.5) * 1.2 - 0.3, 0, 1)
    a = (a > 0.5).astype(float)
    c = col((0.06, 0.055, 0.05), h, w) * (0.7 + 0.6 * n[..., None])
    return dict(rgb=c, a=a)
A.cell('soot', 'cloth', 128, 128, p_soot)

# ============================================================================================ city (opaque)
def p_concrete(base=(0.62, 0.60, 0.56), scale=30, streaks=0.25, bottom=0.6, pores=0.03, cracks=0):
    def p(w, h, rng):
        r = R(rng)
        c = col(base, h, w) * (0.86 + 0.22 * fbm(h, w, rng, scale, 5)[..., None])
        c = c * (1 - 0.25 * (rng.random((h, w)) < pores)[..., None])
        c = grime(c, rng, 0.25, scale, streaks=streaks, bottom=bottom)
        for _ in range(cracks):
            x, y = r.uniform(0, w), r.uniform(0, h); pts = [(x, y)]
            for _ in range(8):
                x += r.uniform(-12, 12); y += r.uniform(-14, 4); pts.append((x, y))
            polyline(c, None, pts, 0.9, 0.4, (0.25, 0.24, 0.22))
        return dict(rgb=c, rough=0.92)
    return p
A.shared('concrete_c', ('city', 'mil'), 128, 128, p_concrete())

def p_concrete_broken(w, h, rng):
    """Fracture faces: exposed aggregate (pebbles), dust, scorch."""
    r = R(rng)
    c = col((0.60, 0.58, 0.54), h, w) * (0.8 + 0.3 * fbm(h, w, rng, 20, 4)[..., None])
    for _ in range(int(w * h / 60)):
        disc(c, None, (r.uniform(0, w), r.uniform(0, h)), r.uniform(1, 3.5), np.array((0.55, 0.50, 0.44)) * r.uniform(0.6, 1.2), shade=0.5)
    c = mix(c, np.array((0.15, 0.13, 0.11)), 0.35 * np.clip(fbm(h, w, rng, 50, 2) - 0.55, 0, 1) * 2.5)
    return dict(rgb=c, rough=0.95)
A.cell('concrete_broken', 'city', 128, 128, p_concrete_broken)

def p_rubble(w, h, rng):
    """Rubble heap seen from above: broken concrete chunks, bricks, plaster dust, bits of rebar and trash."""
    r = R(rng)
    c = col((0.55, 0.51, 0.45), h, w) * (0.8 + 0.35 * fbm(h, w, rng, 16, 4)[..., None])
    for _ in range(420):
        cx, cy, rad = r.uniform(0, w), r.uniform(0, h), r.uniform(3, 12)
        n = r.randint(4, 6)
        pts = [(cx + math.cos(2 * math.pi * k / n + r.uniform(-.4, .4)) * rad * r.uniform(.6, 1.2), cy + math.sin(2 * math.pi * k / n + r.uniform(-.4, .4)) * rad * r.uniform(.6, 1.2)) for k in range(n)]
        tone = r.choice([np.array((0.62, 0.60, 0.56)), np.array((0.70, 0.66, 0.58)), np.array((0.58, 0.36, 0.25)), np.array((0.78, 0.74, 0.66)), np.array((0.45, 0.43, 0.40))]) * r.uniform(0.8, 1.1)
        fill_poly(c, None, [(x + 1.5, y - 1.5) for x, y in pts], (0.12, 0.11, 0.1), 0.6, ss=1)
        fill_poly(c, None, pts, tone, ss=1)
    for _ in range(14):
        x, y = r.uniform(0, w), r.uniform(0, h); a = r.uniform(0, 6.3); L = r.uniform(20, 60)
        seg(c, None, (x, y), (x + math.cos(a) * L, y + math.sin(a) * L), 1.2, 1.2, (0.30, 0.16, 0.08))
    c = mix(c, np.array((0.72, 0.68, 0.60)), 0.3 * fbm(h, w, rng, 40, 2))
    return dict(rgb=c, rough=0.95)
A.cell('rubble', 'city', 256, 256, p_rubble)

def p_trash(w, h, rng):
    r = R(rng)
    c = col((0.36, 0.30, 0.24), h, w) * (0.8 + 0.3 * fbm(h, w, rng, 12, 3)[..., None])
    pal = [(0.85, 0.85, 0.82), (0.08, 0.08, 0.08), (0.2, 0.35, 0.65), (0.62, 0.48, 0.32), (0.75, 0.15, 0.1), (0.25, 0.5, 0.25), (0.9, 0.75, 0.2), (0.5, 0.5, 0.52)]
    for _ in range(500):
        cx, cy, rad = r.uniform(0, w), r.uniform(0, h), r.uniform(2, 9)
        n = r.randint(3, 6)
        pts = [(cx + math.cos(2 * math.pi * k / n + r.uniform(-.5, .5)) * rad * r.uniform(.4, 1.3), cy + math.sin(2 * math.pi * k / n) * rad * r.uniform(.4, 1.3)) for k in range(n)]
        fill_poly(c, None, pts, np.array(r.choice(pal)) * r.uniform(0.6, 1.0), ss=1)
    c = mix(c, np.array((0.40, 0.34, 0.26)), 0.35 * fbm(h, w, rng, 20, 2))
    return dict(rgb=c, rough=0.8)
A.cell('trash', 'city', 256, 256, p_trash)

def p_tyre(w, h, rng):
    """Tyre tread band (u around, v across the tread): blocks and grooves, worn and dusty."""
    c = col((0.06, 0.06, 0.06), h, w)
    xx = np.arange(w)[None, :]; yy = np.arange(h)[:, None]
    groove = (((xx + (yy > h / 2) * 4) % 8) < 2) & (np.abs(yy - h / 2) > 3) & (np.abs(yy - h / 2) < h * 0.4)
    c[np.broadcast_to(groove, (h, w))] = 0.02
    c[np.broadcast_to(np.abs(yy - h / 2) < 1.5, (h, w))] = 0.025
    c = mix(c, np.array((0.35, 0.30, 0.24)), 0.35 * fbm(h, w, rng, 10, 2))
    return dict(rgb=c, rough=0.92)
A.shared('tyre', ('city', 'mil'), 128, 32, p_tyre)

def p_painted_metal(base, rust=0.3, scratches=60, streaks=0.3, band=None):
    def p(w, h, rng):
        r = R(rng)
        c = col(base, h, w) * (0.88 + 0.2 * fbm(h, w, rng, 20, 4)[..., None])
        rm = fbm(h, w, rng, 18, 5)
        edge = np.maximum(np.clip(1 - np.linspace(0, 1, h) / 0.12, 0, 1), np.clip((np.linspace(0, 1, h) - 0.88) / 0.12, 0, 1))[:, None]
        rr = np.clip((rm + edge * 0.5 - (1 - rust)) * 4, 0, 1)
        rc = col((0.45, 0.22, 0.10), h, w) * (0.6 + 0.6 * fbm(h, w, rng, 4, 2)[..., None])
        c = mix(c, rc, rr)
        for _ in range(scratches):
            x, y = r.uniform(0, w), r.uniform(0, h); a = r.uniform(0, 6.3); L = r.uniform(3, 20)
            seg(c, None, (x, y), (x + math.cos(a) * L, y + math.sin(a) * L), 0.6, 0.4, (0.55, 0.53, 0.5), 0.6)
        if band:
            y0, y1, bc = band
            rect(c, 0, y0 * h, w, y1 * h, bc, 0.85)
        c = grime(c, rng, 0.2, 20, streaks=streaks, bottom=0.4)
        return dict(rgb=c, rough=0.6 + 0.3 * rr, metal=0.25 * rr)
    return p
A.cell('drum_blue', 'city', 256, 128, p_painted_metal((0.13, 0.27, 0.50), 0.25))
A.cell('drum_rust', 'city', 256, 128, p_painted_metal((0.30, 0.32, 0.22), 0.85, streaks=0.5))
A.cell('gas_cyl', 'city', 128, 64, p_painted_metal((0.55, 0.62, 0.66), 0.25, 30, band=(0.62, 0.7, (0.75, 0.2, 0.1))))
A.shared('galv_rust', ('city', 'mil'), 128, 128, p_painted_metal((0.50, 0.51, 0.50), 0.12, 20, 0.6))
A.cell('tank_white', 'city', 128, 64, p_painted_metal((0.82, 0.80, 0.74), 0.2, 20, 0.5))

def p_shutter(w, h, rng):
    """Roller shutter curtain: ~25 mm slats (v up), faded green paint, rust, graffiti scribbles, lock plate."""
    r = R(rng)
    c = col((0.32, 0.44, 0.40), h, w) * (0.85 + 0.25 * fbm(h, w, rng, 30, 4)[..., None])
    yy = np.arange(h)[:, None] % 6
    rib = np.where(yy < 1, 0.55, np.where(yy < 3, 1.08, 0.92))
    c = c * rib[..., None]
    rm = fbm(h, w, rng, 14, 4)
    c = mix(c, col((0.45, 0.24, 0.12), h, w), np.clip((rm - 0.62) * 4, 0, 1))
    c = mix(c, np.array((0.75, 0.72, 0.62)), 0.25 * fbm(h, w, rng, 60, 2))       # dust/ sun fade
    script_strokes(c, w * 0.1, h * 0.35, w * 0.7, h * 0.65, (0.08, 0.08, 0.08), r, 2.2)
    script_strokes(c, w * 0.45, h * 0.12, w * 0.95, h * 0.3, (0.6, 0.1, 0.08), r, 1.8)
    c = grime(c, rng, 0.2, 20, streaks=0.4, bottom=0.6)
    return dict(rgb=c, rough=0.6 + 0.3 * np.clip((rm - 0.6) * 4, 0, 1), metal=0.2)
A.cell('shutter', 'city', 256, 256, p_shutter)

def p_sign(bg, fg, accent):
    def p(w, h, rng):
        r = R(rng)
        c = col(bg, h, w) * (0.9 + 0.15 * fbm(h, w, rng, 20, 3)[..., None])
        rect(c, 0, 0, w, 4, accent); rect(c, 0, h - 4, w, h, accent); rect(c, 0, 0, 4, h, accent); rect(c, w - 4, 0, w, h, accent)
        script_strokes(c, w * 0.22, h * 0.25, w * 0.95, h * 0.9, fg, r, 2.6)
        disc(c, None, (w * 0.11, h * 0.5), h * 0.3, accent)
        disc(c, None, (w * 0.11, h * 0.5), h * 0.2, fg)
        script_strokes(c, w * 0.3, h * 0.06, w * 0.8, h * 0.28, accent, r, 1.2)
        c = mix(c, np.array((0.78, 0.74, 0.66)), 0.3 * fbm(h, w, rng, 40, 2))      # faded
        c = grime(c, rng, 0.25, 20, streaks=0.4)
        return dict(rgb=c, rough=0.5)
    return p
A.cell('sign_a', 'city', 256, 64, p_sign((0.12, 0.38, 0.22), (0.93, 0.92, 0.85), (0.80, 0.15, 0.10)))

def p_billboard(w, h, rng):
    """Faded, peeling poster: colour fields, big abstract script, torn strips showing grey backing paper."""
    r = R(rng)
    c = np.zeros((h, w, 3))
    yy = np.linspace(0, 1, h)[:, None, None]
    c[:] = np.array((0.25, 0.45, 0.65)) * (1 - yy) + np.array((0.85, 0.82, 0.75)) * yy
    fill_poly(c, None, [(0, 0), (w * 0.55, 0), (w * 0.35, h), (0, h)], (0.80, 0.25, 0.12))
    disc(c, None, (w * 0.75, h * 0.55), h * 0.3, (0.92, 0.80, 0.30))
    script_strokes(c, w * 0.05, h * 0.45, w * 0.5, h * 0.95, (0.98, 0.97, 0.92), r, 5)
    script_strokes(c, w * 0.45, h * 0.08, w * 0.95, h * 0.35, (0.1, 0.1, 0.12), r, 3)
    c = mix(c, np.array((0.80, 0.78, 0.72)), 0.35)
    for _ in range(9):
        x = r.uniform(0, w); y = r.uniform(0, h * 0.6); wd = r.uniform(15, 60); ht = r.uniform(30, 120)
        fill_poly(c, None, [(x, y), (x + wd, y + r.uniform(-10, 10)), (x + wd * 0.8, y + ht), (x + wd * 0.1, y + ht * 0.8)], (0.55, 0.55, 0.52))
    c = grime(c, rng, 0.3, 30, streaks=0.5)
    return dict(rgb=c, rough=0.75)
A.cell('billboard', 'city', 512, 256, p_billboard)

def p_ac_front(w, h, rng):
    """Split AC outdoor unit front: cream casing, round fan grille (left), louvred side panel."""
    c = col((0.82, 0.80, 0.73), h, w) * (0.92 + 0.1 * fbm(h, w, rng, 20, 3)[..., None])
    cx, cy, rr = w * 0.36, h * 0.5, h * 0.42
    disc(c, None, (cx, cy), rr, (0.12, 0.12, 0.12))
    yy, xx = np.mgrid[0:h, 0:w] + 0.5
    d = np.hypot(xx - cx, yy - cy)
    ring = (d < rr) & ((d % 7) < 1.6)
    c[ring] = (0.75, 0.74, 0.70)
    for a in np.linspace(0, math.pi, 7)[:-1]:
        seg(c, None, (cx - math.cos(a) * rr, cy - math.sin(a) * rr), (cx + math.cos(a) * rr, cy + math.sin(a) * rr), 1.0, 1.0, (0.7, 0.7, 0.66))
    disc(c, None, (cx, cy), 8, (0.3, 0.3, 0.3))
    for y in range(8, h - 8, 6):
        rect(c, w * 0.76, y, w * 0.94, y + 2, (0.45, 0.45, 0.42))
    c = grime(c, rng, 0.3, 20, streaks=0.4, bottom=0.5)
    return dict(rgb=c, rough=0.5)
A.cell('ac_front', 'city', 256, 128, p_ac_front)

def p_ac_window(w, h, rng):
    """Window AC rear: rusty fin grille. Left half = rear (fins), right half = side louvres."""
    c = col((0.78, 0.76, 0.68), h, w) * (0.92 + 0.1 * fbm(h, w, rng, 20, 3)[..., None])
    for x in range(4, w // 2 - 4, 3):
        rect(c, x, 4, x + 1, h - 4, (0.35, 0.30, 0.25))
    for y in range(10, h - 10, 8):
        rect(c, w // 2 + 8, y, w - 8, y + 3, (0.25, 0.24, 0.22))
    c = grime(c, rng, 0.35, 20, streaks=0.5, bottom=0.5)
    c = mix(c, np.array((0.45, 0.24, 0.1)), 0.4 * np.clip(fbm(h, w, rng, 10, 3) - 0.55, 0, 1) * 3)
    return dict(rgb=c, rough=0.6)
A.cell('ac_window', 'city', 128, 64, p_ac_window)

def p_solar(w, h, rng):
    """Flat-plate collector under glass: black absorber with vertical copper risers and an aluminium frame."""
    c = col((0.04, 0.05, 0.07), h, w)
    for x in np.linspace(8, w - 8, 9):
        rect(c, x - 1.5, 6, x + 1.5, h - 6, (0.30, 0.18, 0.12))
    rect(c, 0, 0, w, 6, (0.6, 0.6, 0.6)); rect(c, 0, h - 6, w, h, (0.6, 0.6, 0.6)); rect(c, 0, 0, 5, h, (0.6, 0.6, 0.6)); rect(c, w - 5, 0, w, h, (0.6, 0.6, 0.6))
    c = mix(c, np.array((0.65, 0.60, 0.50)), 0.3 * fbm(h, w, rng, 30, 3))
    return dict(rgb=c, rough=0.15, metal=0.0)
A.cell('solar', 'city', 128, 192, p_solar)

def p_elec_box(w, h, rng):
    r = R(rng)
    c = col((0.42, 0.48, 0.42), h, w) * (0.9 + 0.15 * fbm(h, w, rng, 20, 3)[..., None])
    for y in range(int(h * 0.65), int(h * 0.9), 5):
        rect(c, w * 0.15, y, w * 0.85, y + 2, (0.2, 0.22, 0.2))
    rect(c, w * 0.48, h * 0.1, w * 0.52, h * 0.6, (0.25, 0.28, 0.25))
    fill_poly(c, None, [(w * 0.3, h * 0.35), (w * 0.4, h * 0.52), (w * 0.2, h * 0.52)], (0.9, 0.75, 0.1))
    script_strokes(c, w * 0.58, h * 0.3, w * 0.9, h * 0.5, (0.1, 0.1, 0.1), r, 1.2)
    c = mix(c, np.array((0.45, 0.23, 0.1)), np.clip(fbm(h, w, rng, 10, 3) - 0.6, 0, 1) * 2)
    c = grime(c, rng, 0.25, 20, streaks=0.5, bottom=0.7)
    return dict(rgb=c, rough=0.6)
A.cell('elec_box', 'city', 128, 128, p_elec_box)

def p_wood_old(base=(0.52, 0.44, 0.34), planks=4, paint=None):
    def p(w, h, rng):
        r = R(rng)
        g = fbm(h, w, rng, 4, 3, aspect=12)
        c = col(base, h, w) * (0.7 + 0.45 * g[..., None])
        for k in range(1, planks):
            y = k * h / planks + r.uniform(-1, 1)
            rect(c, 0, y - 1, w, y + 1, np.array(base) * 0.3)
        for k in range(planks):
            for x in (6, w - 6):
                disc(c, None, (x, (k + 0.5) * h / planks), 1.4, (0.2, 0.18, 0.16))
        if paint:
            pm = fbm(h, w, rng, 12, 4)
            c = mix(c, col(paint, h, w) * (0.9 + 0.15 * g[..., None]), np.clip((pm - 0.35) * 3, 0, 1))
        c = mix(c, np.array((0.6, 0.58, 0.55)), 0.2 * fbm(h, w, rng, 40, 2))
        return dict(rgb=c, rough=0.85)
    return p
A.cell('wood_old', 'city', 256, 128, p_wood_old())
A.cell('wood_blue', 'city', 256, 128, p_wood_old(paint=(0.25, 0.42, 0.55)))

def p_crate_slats(w, h, rng):
    """Produce crate side: 3 slats with gaps (dark)."""
    c = col((0.10, 0.08, 0.06), h, w)
    g = fbm(h, w, rng, 4, 3, aspect=10)
    for k in range(3):
        y0 = 4 + k * (h - 8) / 3
        rect(c, 0, y0, w, y0 + (h - 8) / 3 - 6, (0.66, 0.54, 0.38))
    c = c * (0.75 + 0.4 * g[..., None])
    return dict(rgb=c, rough=0.85)
A.cell('crate_slats', 'city', 128, 64, p_crate_slats)

def p_produce(kind):
    """Crate top filled with produce (tight packing of shaded fruit)."""
    def p(w, h, rng):
        r = R(rng)
        c = col((0.08, 0.06, 0.04), h, w)
        if kind == 'tomato': base, rad = (0.72, 0.10, 0.06), 9
        elif kind == 'orange': base, rad = (0.92, 0.50, 0.08), 11
        elif kind == 'potato': base, rad = (0.66, 0.52, 0.34), 10
        elif kind == 'onion': base, rad = (0.72, 0.42, 0.25), 10
        else: base, rad = (0.24, 0.10, 0.20), 12
        if kind in ('cucumber', 'aubergine'):
            for _ in range(70):
                x, y = r.uniform(0, w), r.uniform(0, h); a = r.uniform(-0.4, 0.4) + (0 if r.random() < 0.5 else math.pi / 2)
                L = r.uniform(18, 28)
                cc = np.array((0.20, 0.36, 0.10) if kind == 'cucumber' else base) * r.uniform(0.8, 1.15)
                seg(c, None, (x - math.cos(a) * L / 2, y - math.sin(a) * L / 2), (x + math.cos(a) * L / 2, y + math.sin(a) * L / 2), rad * 0.55, rad * 0.75, cc, shade=0.6)
                if kind == 'aubergine':
                    disc(c, None, (x - math.cos(a) * L / 2, y - math.sin(a) * L / 2), 3, (0.25, 0.4, 0.15))
        else:
            for _ in range(int(w * h / (rad * rad * 2.2))):
                x, y = r.uniform(0, w), r.uniform(0, h)
                disc(c, None, (x, y), rad * r.uniform(0.85, 1.1), np.array(base) * r.uniform(0.8, 1.12), shade=0.55, hl=0.35)
        return dict(rgb=c, rough=0.45)
    return p
for k in ('tomato', 'orange', 'potato', 'onion', 'aubergine', 'cucumber'):
    A.cell('prod_' + k, 'city', 128, 128, p_produce(k))

def p_stripes(c1, c2, n=6, diag=True):
    def p(w, h, rng):
        yy, xx = np.mgrid[0:h, 0:w]
        band = (((xx + (yy if diag else 0)) * n // w) % 2).astype(float)
        c = mix(col(c1, h, w), col(c2, h, w), band)
        c = c * (0.85 + 0.2 * fbm(h, w, rng, 20, 3)[..., None])
        c = mix(c, np.array((0.6, 0.58, 0.54)), 0.4 * fbm(h, w, rng, 15, 3))   # chipped, faded paint
        c = grime(c, rng, 0.3, 15, bottom=0.6)
        return dict(rgb=c, rough=0.85)
    return p
A.cell('kerb_stripe', 'city', 256, 64, p_stripes((0.85, 0.70, 0.15), (0.10, 0.10, 0.10), 8))

def p_gen_panel(w, h, rng):
    c = col((0.15, 0.15, 0.15), h, w)
    for x in (0.25, 0.6):
        disc(c, None, (w * x, h * 0.4), 7, (0.05, 0.05, 0.05)); disc(c, None, (w * x - 2, h * 0.4), 1.2, (0.6, 0.6, 0.6)); disc(c, None, (w * x + 2, h * 0.4), 1.2, (0.6, 0.6, 0.6))
    rect(c, w * 0.75, h * 0.3, w * 0.9, h * 0.55, (0.7, 0.1, 0.1))
    rect(c, w * 0.1, h * 0.75, w * 0.6, h * 0.85, (0.85, 0.75, 0.2))
    return dict(rgb=c, rough=0.5)
A.shared('gen_panel', ('city', 'mil'), 64, 64, p_gen_panel)

# ============================================================================================ military (opaque)
A.cell('concrete_m', 'mil', 128, 128, p_concrete((0.66, 0.63, 0.57)))

def p_twall(w, h, rng):
    """T-wall face: cast concrete with form lines, rust drips from the lifting loops, a stencilled unit marking,
    sand-blasted lower part."""
    r = R(rng)
    c = p_concrete((0.68, 0.65, 0.58), 40, 0.45, 0.9, cracks=3)(w, h, rng)['rgb']
    for y in np.arange(h / 6, h, h / 6):
        rect(c, 0, y, w, y + 1, (0.5, 0.48, 0.44), 0.4)
    for x in (w * 0.25, w * 0.75):
        s = fbm(h, 12, rng, 8, 3, aspect=0.1)
        for dx in range(12):
            col_ = np.clip(1 - np.linspace(1, 0, h) * 2.5, 0, 1) * s[:, dx] * 0.5
            xi = int(x - 6 + dx)
            c[:, xi] = mix(c[:, xi], np.array((0.45, 0.28, 0.16)), col_[:, None] * (1 - abs(dx - 6) / 7))
    stencil_glyphs(c, w * 0.18, h * 0.55, h * 0.05, 4, (0.12, 0.12, 0.12), r, alpha=0.85)
    stencil_glyphs(c, w * 0.18, h * 0.47, h * 0.035, 6, (0.12, 0.12, 0.12), r, alpha=0.85)
    return dict(rgb=c, rough=0.92)
A.cell('twall', 'mil', 256, 512, p_twall)

def p_conex_side(w, h, rng):
    """20 ft container side, desert tan, rust bleeding from the rails, faded abstract owner code top right."""
    r = R(rng)
    c = p_painted_metal((0.64, 0.53, 0.36), 0.35, 120, 0.6)(w, h, rng)['rgb']
    stencil_glyphs(c, w * 0.62, h * 0.8, h * 0.07, 4, (0.15, 0.13, 0.1), r)
    stencil_glyphs(c, w * 0.62, h * 0.68, h * 0.06, 7, (0.15, 0.13, 0.1), r)
    return dict(rgb=c, rough=0.65, metal=0.1)
A.cell('conex_side', 'mil', 512, 256, p_conex_side)

def p_conex_door(w, h, rng):
    r = R(rng)
    c = p_painted_metal((0.64, 0.53, 0.36), 0.3, 80, 0.5)(w, h, rng)['rgb']
    for x in np.arange(0, w, w / 10):
        rect(c, x, 0, x + 2, h, (0.45, 0.36, 0.24), 0.6)
    rect(c, w * 0.49, 0, w * 0.51, h, (0.12, 0.10, 0.08))
    stencil_glyphs(c, w * 0.58, h * 0.82, h * 0.05, 4, (0.12, 0.1, 0.08), r)
    stencil_glyphs(c, w * 0.58, h * 0.74, h * 0.04, 7, (0.12, 0.1, 0.08), r)
    rect(c, w * 0.6, h * 0.15, w * 0.8, h * 0.3, (0.85, 0.85, 0.8))
    stencil_glyphs(c, w * 0.62, h * 0.2, h * 0.04, 3, (0.2, 0.2, 0.2), r)
    return dict(rgb=c, rough=0.65, metal=0.1)
A.cell('conex_door', 'mil', 256, 256, p_conex_door)

def p_geotex(w, h, rng):
    """HESCO liner seen through the mesh: tan non-woven geotextile bulging as a pillow out of every 76 mm mesh square
    (lit top, shaded bottom), dark creases and the galvanised wires (with their shadow) baked in so the grid still
    reads at distance when the alpha mesh has mipped away; dark seam creases at the cell edges, dirt at the bottom."""
    c = col((0.80, 0.68, 0.48), h, w) * (0.88 + 0.22 * fbm(h, w, rng, 6, 4)[..., None])
    yy, xx = np.mgrid[0:h, 0:w] + 0.5
    fx = (xx * 14 / w) % 1 - 0.5; fy = (yy * 18 / h) % 1 - 0.5
    pillow = np.clip(1 - (fx ** 2 + fy ** 2) * 2.2, 0, 1)
    light = 0.86 + 0.22 * pillow + 0.28 * fy * pillow - 0.1 * fx * pillow
    c = c * light[..., None]
    crease = np.minimum(np.abs(fx), np.abs(fy))
    c = c * (0.72 + 0.28 * np.clip(crease / 0.07, 0, 1))[..., None]
    wire = (np.abs(fx) > 0.475) | (np.abs(fy) > 0.47)
    shadow = (np.abs(((xx - 2.5) * 14 / w) % 1 - 0.5) > 0.46) | (np.abs(((yy + 2.5) * 18 / h) % 1 - 0.5) > 0.46)
    c[shadow & ~wire] *= 0.72
    c[wire] = c[wire] * 0.4 + np.array((0.62, 0.62, 0.6)) * 0.6
    u = xx / w
    c = c * (0.5 + 0.5 * np.clip(np.minimum(u, 1 - u) / 0.03, 0, 1))[..., None]
    c = grime(c, rng, 0.2, 30, streaks=0.2, bottom=0.8)
    return dict(rgb=c, rough=0.95)
A.cell('geotex', 'mil', 256, 320, p_geotex)

def p_sand(w, h, rng):
    c = col((0.78, 0.67, 0.49), h, w) * (0.8 + 0.3 * fbm(h, w, rng, 10, 5)[..., None])
    c = c * (1 - 0.15 * (rng.random((h, w)) < 0.08))[..., None]
    return dict(rgb=c, rough=1.0)
A.cell('sand_fill', 'mil', 128, 128, p_sand)

def p_hessian(w, h, rng):
    """Sandbag: woven polypropylene/ hessian with a seam at the ends and dust."""
    yy, xx = np.mgrid[0:h, 0:w]
    weave = 0.9 + 0.1 * ((xx % 3 == 0) | (yy % 3 == 0))
    c = col((0.62, 0.55, 0.40), h, w) * weave[..., None] * (0.8 + 0.3 * fbm(h, w, rng, 16, 4)[..., None])
    rect(c, 0, 0, 4, h, (0.45, 0.38, 0.27)); rect(c, w - 4, 0, w, h, (0.45, 0.38, 0.27))
    c = grime(c, rng, 0.35, 20, bottom=0.5)
    return dict(rgb=c, rough=1.0)
A.shared('hessian', ('mil', 'home'), 128, 64, p_hessian)

def p_crate_ru(paint, stencil=(0.9, 0.88, 0.8), stripe=None):
    """Soviet-style ammunition crate side: 3 planks, painted, worn to wood at the edges, Cyrillic-ish stencil
    blocks (no real words), optional coloured band."""
    def p(w, h, rng):
        r = R(rng)
        g = fbm(h, w, rng, 4, 3, aspect=12)
        wood = col((0.55, 0.42, 0.28), h, w) * (0.75 + 0.4 * g[..., None])
        c = col(paint, h, w) * (0.85 + 0.25 * g[..., None])
        wear = fbm(h, w, rng, 10, 4)
        e = np.maximum(np.abs(np.linspace(-1, 1, w))[None, :], np.abs(np.linspace(-1, 1, h))[:, None])
        c = mix(c, wood, np.clip((wear * 0.5 + e ** 3 * 0.7 - 0.85) * 5, 0, 1))
        for k in (1, 2):
            rect(c, 0, k * h / 3 - 1, w, k * h / 3 + 1, (0.12, 0.10, 0.07))
        if stripe:
            rect(c, w * 0.08, 0, w * 0.13, h, stripe, 0.9)
        x = stencil_glyphs(c, w * 0.2, h * 0.62, h * 0.16, 3, stencil, r, alpha=0.9)
        stencil_glyphs(c, x + 6, h * 0.62, h * 0.16, 2, stencil, r, alpha=0.9)
        stencil_glyphs(c, w * 0.2, h * 0.3, h * 0.11, 7, stencil, r, alpha=0.85)
        stencil_glyphs(c, w * 0.2, h * 0.08, h * 0.09, 5, stencil, r, alpha=0.8)
        c = grime(c, rng, 0.3, 15, bottom=0.4)
        return dict(rgb=c, rough=0.8)
    return p
A.cell('crate_ru', 'mil', 256, 128, p_crate_ru((0.30, 0.33, 0.20), stripe=(0.1, 0.1, 0.1)))
A.cell('crate_ru2', 'mil', 256, 128, p_crate_ru((0.36, 0.38, 0.24), (0.05, 0.05, 0.05), (0.75, 0.15, 0.1)))
A.cell('crate_wood', 'mil', 256, 128, p_crate_ru((0.58, 0.46, 0.30), (0.08, 0.08, 0.08)))
A.cell('crate_top', 'mil', 128, 128, p_wood_old((0.33, 0.35, 0.22), 4))

def p_ammo_can(w, h, rng):
    """M2A1 can side: OD green paint, yellow stencil lines, embossed rim."""
    r = R(rng)
    c = col((0.25, 0.28, 0.17), h, w) * (0.88 + 0.2 * fbm(h, w, rng, 10, 3)[..., None])
    rect(c, 0, h - 8, w, h - 6, (0.15, 0.17, 0.10))
    for k, y in enumerate((0.62, 0.48, 0.36)):
        x = w * 0.14
        for _ in range(r.randint(2, 4)):
            ww = r.uniform(8, 22)
            rect(c, x, h * y, x + ww, h * y + 3.2, (0.85, 0.75, 0.25), 0.9)
            x += ww + 4
    c = mix(c, np.array((0.5, 0.48, 0.42)), 0.25 * np.clip(fbm(h, w, rng, 6, 3) - 0.5, 0, 1) * 3)
    return dict(rgb=c, rough=0.55, metal=0.1)
A.cell('ammo_can', 'mil', 128, 64, p_ammo_can)

A.cell('wood_pallet', 'mil', 256, 64, p_wood_old((0.66, 0.55, 0.40), 1))
A.cell('plywood', 'mil', 256, 256, p_wood_old((0.66, 0.54, 0.38), 2))
A.cell('timber', 'mil', 256, 32, p_wood_old((0.58, 0.47, 0.33), 1))

def p_tin(w, h, rng):
    """Corrugated galvanised roof sheet (ridges along v), rust patches."""
    xx = np.arange(w)[None, :]
    ridge = 0.8 + 0.3 * np.sin(xx / w * 2 * math.pi * 12)
    c = col((0.58, 0.59, 0.58), h, w) * ridge[..., None]
    rm = fbm(h, w, rng, 14, 4)
    c = mix(c, col((0.45, 0.24, 0.12), h, w), np.clip((rm - 0.55) * 3, 0, 1))
    return dict(rgb=c, rough=0.5, metal=0.6 * (1 - np.clip((rm - 0.55) * 3, 0, 1)))
A.shared('tin', ('city', 'mil'), 128, 128, p_tin)

# ============================================================================================ architecture (opaque)
def p_brick(base=(0.80, 0.67, 0.47), rows=16, cols=8, mortar=(0.86, 0.80, 0.68), pattern=True):
    """Yellow baked brick (Iraqi minarets): running bond, thick mortar, a band of decorative basket-weave."""
    def p(w, h, rng):
        r = R(rng)
        c = col(mortar, h, w) * (0.9 + 0.15 * fbm(h, w, rng, 10, 3)[..., None])
        bh = h / rows; bw = w / cols
        for j in range(rows):
            off = (bw / 2) * (j % 2)
            deco = pattern and j in (rows // 2, rows // 2 + 1)
            for i in range(-1, cols + 1):
                x0 = i * bw + off; y0 = j * bh
                tone = np.array(base) * r.uniform(0.82, 1.1)
                if deco:
                    for k in range(2):     # vertical/ horizontal alternating bricks (hazarbaf style)
                        if (i + j) % 2 == 0:
                            rect(c, x0 + 1 + k * bw / 2, y0 + 1, x0 + bw / 2 - 1 + k * bw / 2, y0 + bh - 1, tone * (0.92 if k else 1.0))
                        else:
                            rect(c, x0 + 1, y0 + 1 + k * bh / 2, x0 + bw - 1, y0 + bh / 2 - 1 + k * bh / 2, tone)
                else:
                    rect(c, x0 + 1.2, y0 + 1.2, x0 + bw - 1.2, y0 + bh - 1.2, tone)
        c = c * (0.85 + 0.2 * fbm(h, w, rng, 4, 2)[..., None])
        c = grime(c, rng, 0.2, 40, streaks=0.3)
        return dict(rgb=c, rough=0.9)
    return p
A.cell('brick_y', 'arch', 256, 256, p_brick())

def p_brick_win(w, h, rng):
    """Brick band with an arched lancet window (dark) and a turquoise tile frame."""
    c = p_brick(rows=16, cols=4, pattern=False)(w, h, rng)['rgb']
    cx = w / 2; y0 = h * 0.18; y1 = h * 0.62; hw = w * 0.16
    pts = [(cx - hw - 6, y0 - 6), (cx + hw + 6, y0 - 6), (cx + hw + 6, y1)] + \
          [(cx + (hw + 6) * math.cos(a), y1 + (hw + 6) * 1.6 * math.sin(a)) for a in np.linspace(0, math.pi, 9)[1:-1]] + [(cx - hw - 6, y1)]
    fill_poly(c, None, pts, (0.12, 0.50, 0.55))
    pts = [(cx - hw, y0), (cx + hw, y0), (cx + hw, y1)] + [(cx + hw * math.cos(a), y1 + hw * 1.7 * math.sin(a)) for a in np.linspace(0, math.pi, 9)[1:-1]] + [(cx - hw, y1)]
    fill_poly(c, None, pts, (0.05, 0.04, 0.04))
    seg(c, None, (cx, y0), (cx, y1 + hw * 1.5), 1.5, 1.5, (0.2, 0.18, 0.15))
    return dict(rgb=c, rough=0.85)
A.cell('brick_win', 'arch', 128, 256, p_brick_win)

def p_tile_band(w, h, rng):
    """Tile frieze: cobalt ground, interlaced turquoise 8-point stars, white/ yellow borders."""
    c = col((0.08, 0.18, 0.48), h, w)
    rect(c, 0, 0, w, 5, (0.92, 0.88, 0.75)); rect(c, 0, h - 5, w, h, (0.92, 0.88, 0.75))
    rect(c, 0, 5, w, 7, (0.85, 0.65, 0.2)); rect(c, 0, h - 7, w, h - 5, (0.85, 0.65, 0.2))
    s = (h - 16) / 2
    for k in range(int(w / (2 * s)) + 1):
        cx, cy = k * 2 * s + s, h / 2
        for rot in (0, math.pi / 4):
            pts = [(cx + s * 0.9 * math.cos(rot + a), cy + s * 0.9 * math.sin(rot + a)) for a in np.linspace(0, 2 * math.pi, 5)[:-1]]
            fill_poly(c, None, pts, (0.12, 0.62, 0.64))
        disc(c, None, (cx, cy), s * 0.38, (0.92, 0.88, 0.75))
        disc(c, None, (cx, cy), s * 0.2, (0.85, 0.6, 0.15))
    c = c * (0.9 + 0.15 * fbm(h, w, rng, 6, 2)[..., None])
    c = grime(c, rng, 0.2, 20, streaks=0.2)
    return dict(rgb=c, rough=0.25)
A.cell('tile_band', 'arch', 256, 64, p_tile_band)

def p_kufic(w, h, rng):
    """Square-Kufic-like angular white strokes on turquoise (abstract, not real text)."""
    r = R(rng)
    c = col((0.10, 0.52, 0.56), h, w)
    rect(c, 0, 0, w, 4, (0.08, 0.16, 0.42)); rect(c, 0, h - 4, w, h, (0.08, 0.16, 0.42))
    x = 6
    u = (h - 12) / 6
    while x < w - 6:
        for _ in range(r.randint(2, 4)):
            ht = r.choice((3, 4, 5, 6)) * u
            rect(c, x, 6, x + u, 6 + ht, (0.95, 0.93, 0.85))
            if r.random() < 0.5:
                rect(c, x, 6, x + u * r.randint(2, 3), 6 + u, (0.95, 0.93, 0.85))
            x += u * 2
        x += u
    c = c * (0.9 + 0.15 * fbm(h, w, rng, 6, 2)[..., None])
    return dict(rgb=c, rough=0.25)
A.cell('kufic', 'arch', 256, 64, p_kufic)

def p_muqarnas(w, h, rng):
    """Stalactite corbel band: three tiers of small pointed niches with deep shadows (u around, v up)."""
    c = col((0.82, 0.72, 0.54), h, w) * (0.9 + 0.12 * fbm(h, w, rng, 8, 2)[..., None])
    tiers = 3
    for t in range(tiers):
        n = 8 + 4 * t
        y0 = t * h / tiers; y1 = (t + 1) * h / tiers
        for i in range(n):
            x0 = (i + 0.5 * (t % 2)) * w / n; x1 = x0 + w / n
            cx = (x0 + x1) / 2; hw = (x1 - x0) * 0.4
            pts = [(cx - hw, y0 + 1), (cx + hw, y0 + 1), (cx + hw, y1 - (y1 - y0) * 0.45), (cx, y1 - 2), (cx - hw, y1 - (y1 - y0) * 0.45)]
            fill_poly(c, None, pts, (0.35, 0.28, 0.20))
            fill_poly(c, None, [(cx - hw, y0 + 1), (cx, y0 + 1), (cx, y1 - 2), (cx - hw, y1 - (y1 - y0) * 0.45)], (0.55, 0.45, 0.33), 0.6)
            if t == tiers - 1:
                fill_poly(c, None, pts, (0.10, 0.45, 0.50), 0.5)
    return dict(rgb=c, rough=0.85)
A.cell('muqarnas', 'arch', 256, 64, p_muqarnas)

def p_dome_tile(w, h, rng):
    """One gore of a tiled dome (u across the gore, v base -> apex): turquoise field with dark-blue arabesque
    scrolls and white/ yellow blossoms, a kufic frieze at the base, ribs at the gore edges."""
    r = R(rng)
    c = col((0.13, 0.58, 0.62), h, w) * (0.9 + 0.12 * fbm(h, w, rng, 8, 3)[..., None])
    yy, xx = np.mgrid[0:h, 0:w] + 0.5
    tiles = ((xx % 16) < 1) | ((yy % 16) < 1)
    c[tiles] *= 0.8
    for k in range(-2, 3):
        pts = [(w / 2 + k * w * 0.25 + math.sin(y / h * 2 * math.pi * 3 + k) * w * 0.18, y) for y in np.linspace(h * 0.12, h * 0.95, 40)]
        polyline(c, None, pts, 3.0, 2.0, (0.07, 0.17, 0.45))
        for y in np.linspace(h * 0.15, h * 0.9, 9):
            x = w / 2 + k * w * 0.25 + math.sin(y / h * 2 * math.pi * 3 + k) * w * 0.18
            disc(c, None, (x + 10, y), 6, (0.92, 0.90, 0.80)); disc(c, None, (x + 10, y), 2.5, (0.85, 0.6, 0.15))
    rect(c, 0, 0, w, h * 0.1, (0.07, 0.17, 0.45))
    x = 4; u = h * 0.012
    while x < w - 4:
        rect(c, x, h * 0.02, x + u * 1.5, h * 0.02 + u * r.choice((3, 5, 6)), (0.95, 0.93, 0.85)); x += u * 3
    rect(c, 0, h * 0.1, w, h * 0.105, (0.85, 0.65, 0.2))
    rect(c, 0, 0, 3, h, (0.85, 0.82, 0.70)); rect(c, w - 3, 0, w, h, (0.85, 0.82, 0.70))
    c = grime(c, rng, 0.15, 30, streaks=0.25)
    return dict(rgb=c, rough=0.22)
A.cell('dome_tile', 'arch', 256, 512, p_dome_tile)

def p_drum(w, h, rng):
    """Dome drum bay: plaster with a tiled frame around an arched window with a grille."""
    c = col((0.84, 0.79, 0.68), h, w) * (0.9 + 0.12 * fbm(h, w, rng, 12, 3)[..., None])
    cx = w / 2; y0 = h * 0.12; y1 = h * 0.62; hw = w * 0.2
    def arch(hw2, k=1.25):
        return [(cx - hw2, y0), (cx + hw2, y0), (cx + hw2, y1)] + [(cx + hw2 * math.cos(a), y1 + hw2 * k * math.sin(a) ** 0.8) for a in np.linspace(0, math.pi, 11)[1:-1]] + [(cx - hw2, y1)]
    fill_poly(c, None, arch(hw + 8), (0.10, 0.50, 0.56))
    fill_poly(c, None, arch(hw + 3), (0.85, 0.80, 0.68))
    fill_poly(c, None, arch(hw), (0.05, 0.05, 0.06))
    for x in np.linspace(cx - hw, cx + hw, 6):
        seg(c, None, (x, y0), (x, y1 + hw), 1.0, 1.0, (0.35, 0.33, 0.30))
    for y in np.linspace(y0, y1, 5):
        seg(c, None, (cx - hw, y), (cx + hw, y), 1.0, 1.0, (0.35, 0.33, 0.30))
    rect(c, 0, h * 0.9, w, h, (0.08, 0.18, 0.48))
    c = grime(c, rng, 0.25, 20, streaks=0.4)
    return dict(rgb=c, rough=0.8)
A.cell('drum', 'arch', 128, 128, p_drum)

A.cell('plaster_d', 'arch', 128, 128, p_concrete((0.86, 0.82, 0.72), 30, 0.35, 0.5, 0.01))

def p_ashlar(base=(0.80, 0.70, 0.52)):
    def p(w, h, rng):
        r = R(rng)
        c = col(np.array(base) * 0.75, h, w)
        rows = 6
        for j in range(rows):
            x = -r.uniform(0, 40)
            while x < w:
                bw = r.uniform(36, 70)
                tone = np.array(base) * r.uniform(0.88, 1.08)
                rect(c, x + 1.5, j * h / rows + 1.5, x + bw - 1.5, (j + 1) * h / rows - 1.5, tone)
                x += bw
        c = c * (0.85 + 0.2 * fbm(h, w, rng, 8, 4)[..., None])
        c = grime(c, rng, 0.25, 30, streaks=0.35, bottom=0.5)
        return dict(rgb=c, rough=0.9)
    return p
A.cell('sandstone', 'arch', 256, 256, p_ashlar())

def p_spandrel(w, h, rng):
    """Gate spandrel/ panel: blue tile field with a turquoise/ white geometric star net."""
    c = col((0.08, 0.20, 0.50), h, w)
    s = 32
    for j in range(-1, int(h / s) + 2):
        for i in range(-1, int(w / s) + 2):
            cx, cy = i * s + (s / 2) * (j % 2), j * s * 0.87
            for rot in (0, math.pi / 4):
                pts = [(cx + 12 * math.cos(rot + a), cy + 12 * math.sin(rot + a)) for a in np.linspace(0, 2 * math.pi, 5)[:-1]]
                fill_poly(c, None, pts, (0.12, 0.60, 0.62))
            disc(c, None, (cx, cy), 4.5, (0.93, 0.90, 0.80))
    rect(c, 0, 0, w, 6, (0.92, 0.88, 0.75)); rect(c, 0, h - 6, w, h, (0.92, 0.88, 0.75)); rect(c, 0, 0, 6, h, (0.92, 0.88, 0.75)); rect(c, w - 6, 0, w, h, (0.92, 0.88, 0.75))
    c = grime(c, rng, 0.15, 20, streaks=0.2)
    return dict(rgb=c, rough=0.25)
A.cell('spandrel', 'arch', 256, 128, p_spandrel)

def p_door(w, h, rng):
    """Carved wooden door pair in an arched frame (brass studs)."""
    c = p_wood_old((0.38, 0.24, 0.13), 1)(w, h, rng)['rgb']
    for x0 in (0.08, 0.54):
        for y0 in (0.08, 0.40):
            rect(c, w * x0, h * y0, w * (x0 + 0.38), h * (y0 + 0.27), (0.26, 0.15, 0.07))
            rect(c, w * x0 + 3, h * y0 + 3, w * (x0 + 0.38) - 3, h * (y0 + 0.27) - 3, (0.40, 0.25, 0.13))
    rect(c, w * 0.495, 0, w * 0.505, h, (0.1, 0.06, 0.03))
    for y in np.linspace(h * 0.05, h * 0.7, 10):
        for x in (w * 0.04, w * 0.96):
            disc(c, None, (x, y), 1.8, (0.8, 0.62, 0.3))
    return dict(rgb=c, rough=0.7)
A.cell('door', 'arch', 128, 256, p_door)

def p_mosaic(w, h, rng):
    r = R(rng)
    c = col((0.10, 0.40, 0.55), h, w)
    for j in range(0, h, 8):
        for i in range(0, w, 8):
            rect(c, i + 1, j + 1, i + 7, j + 7, np.array(r.choice(((0.10, 0.45, 0.58), (0.15, 0.55, 0.62), (0.08, 0.30, 0.50), (0.85, 0.85, 0.80)))) * r.uniform(0.85, 1.1))
    return dict(rgb=c, rough=0.3)
A.cell('mosaic', 'arch', 128, 128, p_mosaic)

# ============================================================================================ geometry helpers
V = Vector

def sst(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)

def lerp(a, b, t):
    return a + (b - a) * t

def sub(mb):
    return MB(mb.A, mb.group)

def tiled(mb, o, u, v, nu, nv, cell, uv=(0, 0, 1, 1)):
    """Plane o + s*u + t*v split into nu x nv quads, each mapped to the full cell (texture tiling inside an atlas).
    Normal = u x v."""
    o, u, v = V(o), V(u), V(v)
    du, dv = u / nu, v / nv
    for i in range(nu):
        for j in range(nv):
            p = o + du * i + dv * j
            mb.quad(p, p + du, p + du + dv, p + dv, cell, uv)

def extrude_x(mb, prof, L, cellf, capcell, M=None, uvl=None, caps=True):
    """Extrude a (y, z) profile (CCW seen from +X) along X over length L, centred. Each face gets cellf(k) with u
    along X and v 'up' the edge; uvl = metres per full cell (keeps texel density) or None to stretch."""
    from mathutils.geometry import tessellate_polygon
    n = len(prof)
    for k in range(n):
        a = prof[k]; b = prof[(k + 1) % n]
        cell = cellf(k) if callable(cellf) else cellf
        el = math.hypot(b[0] - a[0], b[1] - a[1])
        U = min(1, L / uvl) if uvl else 1
        Vv = min(1, el / uvl) if uvl else 1
        p0 = (-L / 2, a[0], a[1]); p1 = (-L / 2, b[0], b[1]); p2 = (L / 2, b[0], b[1]); p3 = (L / 2, a[0], a[1])
        if b[1] >= a[1]:
            uvs = [(U, 0), (U, Vv), (0, Vv), (0, 0)]
        else:
            uvs = [(0, Vv), (0, 0), (U, 0), (U, Vv)]
        mb.poly([p0, p1, p2, p3], uvs, cell, False, M)
    if not caps:
        return
    ys = [p[0] for p in prof]; zs = [p[1] for p in prof]
    y0, z0 = min(ys), min(zs); wy, wz = max(ys) - y0, max(zs) - z0
    for tri in tessellate_polygon([[V((p[0], p[1], 0)) for p in prof]]):
        for x, sgn in ((L / 2, 1), (-L / 2, -1)):
            pts = [(x, prof[i][0], prof[i][1]) for i in tri]
            (_, y1, z1), (_, y2, z2), (_, y3, z3) = pts
            cr = (y2 - y1) * (z3 - z1) - (z2 - z1) * (y3 - y1)
            if (cr > 0) != (sgn > 0):
                pts = pts[::-1]
            mb.poly(pts, [((p[1] - y0) / wy, (p[2] - z0) / wz) for p in pts], capcell, False, M)

def band(mb, r0, r1, z0, z1, cell, segs, urep=1, tile_v=None, a0=0.0, smooth=True, sx=1.0, sy=1.0):
    """Cylindrical/ conical band split in rows so the texture can repeat vertically every ~tile_v metres."""
    rows = max(1, round((z1 - z0) / tile_v)) if tile_v else 1
    prof = [(lerp(r0, r1, k / rows), lerp(z0, z1, k / rows)) for k in range(rows + 1)]
    mb.lathe(prof, segs, cell, urep=urep, vrep=rows, smooth=smooth, a0=a0, sx=sx, sy=sy)

def ring_face(mb, r0, r1, z, cell, segs, up=True, a0=0.0):
    """Flat annulus at height z (r0 inner, r1 outer) facing up or down."""
    prof = [(r1, z), (r0, z)] if up else [(r0, z), (r1, z)]
    mb.lathe(prof, segs, cell, smooth=False, a0=a0)

def card(mb, c, w, h, rotz, cell, tilt=0.0, uv=(0, 0, 1, 1), z0=0.0):
    """Vertical billboard quad (double-sided material) centred on c (x, y), base at z0."""
    M = T((c[0], c[1], z0), (tilt, 0, rotz))
    mb.quad((w / 2, 0, 0), (-w / 2, 0, 0), (-w / 2, 0, h), (w / 2, 0, h), cell, uv, M)

def lumpy(rng, segs, rings, amt=0.1):
    tab = [[1 + rng.uniform(-amt, amt) for _ in range(rings + 1)] for _ in range(segs)]
    for i in range(segs):
        tab[i][0] = tab[i][rings] = 1.0
    def f(a, k):
        i = int(round(a / (2 * math.pi) * segs)) % segs
        return tab[i][min(k, rings)]
    return f

def tyre(mb, M, R=0.33, w=0.2, segs=12, cell='tyre'):
    Ri = R * 0.6
    prof = [(Ri, -w * 0.42), (R * 0.9, -w / 2), (R, -w * 0.3), (R, w * 0.3), (R * 0.9, w / 2), (Ri, w * 0.42), (Ri * 0.98, 0), (Ri, -w * 0.42)]
    mb.lathe(prof, segs, cell, M, smooth=True)

def sandbag(mb, c, yaw, r, size=(0.58, 0.30, 0.13), cell='hessian'):
    M = T(c, (r.uniform(-3, 3), r.uniform(-3, 3), yaw + r.uniform(-4, 4)))
    mb.chamfer_box(size, 0.045, cell, M, jitter=0.008, rng=r)

def chair(mb, M=None):
    """Monobloc plastic chair (white, dusty)."""
    s = sub(mb)
    s.chamfer_box((0.44, 0.42, 0.035), 0.012, 'white_plastic', T((0, 0, 0.44)))
    s.chamfer_box((0.42, 0.03, 0.40), 0.012, 'white_plastic', T((0, -0.23, 0.70), (-12, 0, 0)))
    for sx in (-1, 1):
        s.bar((sx * 0.25, 0.25, 0), (sx * 0.22, 0.19, 0.64), 0.018, 'white_plastic', 6)
        s.bar((sx * 0.25, -0.28, 0), (sx * 0.21, -0.20, 0.44), 0.018, 'white_plastic', 6)
        s.beam((sx * 0.225, -0.22, 0.64), (sx * 0.225, 0.21, 0.64), 0.045, 0.02, 'white_plastic')
    mb.merge(s, M)

def side_shape(mb, prof, width, cell, M=None):
    """extrude_x with the profile winding fixed automatically."""
    area = sum(prof[i][0] * prof[(i + 1) % len(prof)][1] - prof[(i + 1) % len(prof)][0] * prof[i][1] for i in range(len(prof)))
    extrude_x(mb, prof if area > 0 else prof[::-1], width, cell, cell, M)

def ak(mb, M):
    """AKM-like rifle, muzzle along +Y, origin at the pistol grip (~0.88 m long), magazine down (-Z)."""
    s = sub(mb)
    s.box((0.045, 0.30, 0.065), 'gunmetal', loc=(0, 0.06, 0.03))
    s.box((0.04, 0.25, 0.02), 'gunmetal', loc=(0, 0.04, 0.072))
    s.bar((0, 0.21, 0.045), (0, 0.54, 0.045), 0.010, 'gunmetal', 5)
    s.bar((0, 0.19, 0.078), (0, 0.42, 0.078), 0.011, 'gunmetal', 5)
    s.box((0.052, 0.20, 0.045), 'stock_wood', loc=(0, 0.31, 0.035))
    s.box((0.042, 0.12, 0.022), 'stock_wood', loc=(0, 0.26, 0.085))
    s.box((0.018, 0.025, 0.055), 'gunmetal', loc=(0, 0.50, 0.07))
    s.cyl(0.014, 0.05, 'gunmetal', T((0, 0.53, 0.045), (-90, 0, 0)), 6)
    side_shape(s, [(-0.36, -0.085), (-0.09, 0.0), (-0.09, 0.058), (-0.36, 0.035)], 0.04, 'stock_wood')
    side_shape(s, [(-0.01, 0.005), (0.03, 0.005), (0.004, -0.10), (-0.032, -0.093)], 0.032, 'bakelite')
    front = [(0.175 + 0.075 * (t / 4) ** 1.3, -0.215 * t / 4) for t in range(5)]
    rear = [(0.11 + 0.075 * (t / 4) ** 1.3, -0.235 * t / 4) for t in range(5)]
    side_shape(s, rear + front[::-1], 0.03, 'bakelite')
    s.box((0.012, 0.09, 0.02), 'gunmetal', loc=(0, 0.13, -0.005))
    mb.merge(s, M)

def rpg_round(mb, M):
    """PG-7V-like round, nose along +Y, origin at the tail (~0.93 m)."""
    s = sub(mb)
    prof = [(0.0, 0.93), (0.012, 0.91), (0.03, 0.83), (0.042, 0.72), (0.042, 0.62), (0.02, 0.56), (0.02, 0.40, 'S'), (0.028, 0.40), (0.028, 0.0)]
    prof = [(p[0], p[1]) + tuple(p[2:]) for p in prof[::-1]]
    s.lathe(prof, 7, 'rpg_green', cap0=True)
    s.lathe([(0.0281, 0.05), (0.0281, 0.38)], 7, 'cardboard', smooth=True)
    mb.merge(s, T(rot=(-90, 0, 0)) if M is None else M @ T(rot=(-90, 0, 0)))

def rpg7(mb, M):
    """RPG-7 launcher, muzzle along +Y, origin at the grip."""
    s = sub(mb)
    s.cyl(0.035, 0.95, 'gunmetal', T((0, -0.55, 0.06), (-90, 0, 0)), 8)
    s.cyl(0.045, 0.30, 'stock_wood', T((0, -0.15, 0.06), (-90, 0, 0)), 8)
    s.cyl(0.035, 0.22, 'gunmetal', T((0, -0.55, 0.06), (90, 0, 0)), 8, r2=0.06)
    s.beam((0, 0.0, 0.03), (0, -0.02, -0.08), 0.025, 0.035, 'stock_wood')
    s.beam((0, 0.25, 0.03), (0, 0.24, -0.08), 0.025, 0.035, 'stock_wood')
    s.box((0.03, 0.12, 0.05), 'gunmetal', loc=(-0.05, 0.05, 0.11))
    mb.merge(s, M)

def ru_crate(mb, size, M, side='crate_ru', top='crate_top', open_top=False, r=None):
    """Wooden ammunition crate: stencilled long sides, plank top, end battens."""
    sx, sy, sz = size
    s = sub(mb)
    s.box(size, side, T((0, 0, sz / 2)), faces='yY')
    s.box(size, top, T((0, 0, sz / 2)), faces='xX' + ('' if open_top else 'Z'))
    for x in (-1, 1):
        s.box((0.035, sy + 0.025, sz * 0.9), top, T((x * (sx / 2 - 0.06), 0, sz / 2)), faces='xXyYZ')
    if open_top:
        s.box((sx - 0.04, sy - 0.04, 0.01), top, T((0, 0, sz * 0.25)), faces='Z')
        s.box((sx - 0.03, sy - 0.03, sz), side, T((0, 0, sz / 2)), faces='xXyY')   # inner walls (seen from above)
        s.F[-4:] = [(ids[::-1], uvs[::-1], pg, sm) for ids, uvs, pg, sm in s.F[-4:]]
    mb.merge(s, M)

def tarp(mb, x0, x1, y0, y1, nx, ny, boxes, cell, r, slope=1.6):
    """Tarp draped over axis-aligned boxes [(bx0, bx1, by0, by1, top)], hanging down past their edges."""
    def hgt(x, y):
        z = 0.02
        for bx0, bx1, by0, by1, top in boxes:
            dx = max(bx0 - x, 0, x - bx1); dy = max(by0 - y, 0, y - by1)
            z = max(z, top + 0.015 - slope * math.hypot(dx, dy) - 0.6 * (math.hypot(dx, dy)) ** 2)
        return z
    P = [[V((lerp(x0, x1, i / nx), lerp(y0, y1, j / ny), 0)) for j in range(ny + 1)] for i in range(nx + 1)]
    H = [[hgt(p.x, p.y) for p in row] for row in P]
    for _ in range(2):   # soften the drape
        H = [[(H[i][j] * 2 + H[max(0, i - 1)][j] + H[min(nx, i + 1)][j] + H[i][max(0, j - 1)] + H[i][min(ny, j + 1)]) / 6 for j in range(ny + 1)] for i in range(nx + 1)]
    for i in range(nx + 1):
        for j in range(ny + 1):
            P[i][j].z = max(0.01, H[i][j] + r.uniform(-0.015, 0.02))
            P[i][j].x += r.uniform(-0.02, 0.02); P[i][j].y += r.uniform(-0.02, 0.02)
    mb.surf(P, cell, False, smooth=True)

# ============================================================================================ vegetation
def frond(mb, base, az, e0, droop, L, cells, r, layers=((32, 1.0), (4, 0.9)), segs=8, rachis='rachis', wscale=1.0, curl=25):
    """Pinnate date-palm frond: tapered 3-sided rachis plus two leaflet layers per side (a V of alpha-cut strips).
    e0/ droop in degrees (start elevation, total bend towards the tip)."""
    s = L / FROND_L
    W0 = FROND_W * s * wscale
    pts = []; dirs = []
    p = V(base)
    for i in range(segs + 1):
        t = i / segs
        e = math.radians(e0 - droop * t ** 1.4)
        d = V((math.cos(e) * math.cos(az), math.cos(e) * math.sin(az), math.sin(e)))
        pts.append(p.copy()); dirs.append(d)
        p = p + d * (L / segs)
    lat0 = V((-math.sin(az), math.cos(az), 0))
    for side in (1, -1):
        for li, (ang, wm) in enumerate(layers):
            edge = []
            for i in range(segs + 1):
                t = i / segs
                up = dirs[i].cross(lat0).normalized()
                a = math.radians(ang - curl * t)
                Wt = W0 * wm * (0.38 + 0.62 * sst(0.0, 0.22, t)) * (1 - 0.3 * sst(0.75, 1.0, t))
                edge.append(pts[i] + (lat0 * side * math.cos(a) + up * math.sin(a)) * Wt)
            mb.ribbon(pts, edge, cells[li % len(cells)])
    mb.tube(pts, [lerp(0.035, 0.006, i / segs) * max(0.6, s) for i in range(segs + 1)], rachis, sides=3)

def palm(mb, H, lean, nfr, seed, skirt=0, dates=0, flen=3.4, trunk_r=0.23, boots=False):
    r = random.Random(seed)
    phi = r.uniform(0, 2 * math.pi)
    ln = math.tan(math.radians(lean)) * H
    vrep = max(2, round(H / 1.5)); N = vrep * 4
    pts, radii = [], []
    for k in range(N + 1):
        t = k / N; z = H * t
        off = ln * (1 - (1 - t) ** 2) / 2
        pts.append(V((math.cos(phi) * off, math.sin(phi) * off, z)))
        rad = trunk_r * (1 + 0.45 * max(0.0, 1 - z / 0.7) ** 2) * (1 + 0.05 * (k % 2)) * (1 + 0.12 * sst(0.85, 1.0, t))
        radii.append(rad)
    mb.tube(pts, radii, 'palm_bark', sides=10, urep=2, vrep=vrep)
    top = pts[-1]
    # crown base: fibrous leaf bases
    mb.lathe([(trunk_r * 1.05, -0.35), (trunk_r * 1.35, 0.2), (trunk_r * 1.3, 0.55), (trunk_r * 0.8, 0.85), (0.06, 1.0)],
             10, 'palm_boots', T(top), urep=3)
    if boots:   # pruned frond stubs in a ring under the crown
        for k in range(14):
            a = k / 14 * 2 * math.pi + r.uniform(-0.1, 0.1); zz = r.uniform(-0.45, -0.05)
            mb.box((0.10, 0.07, 0.30), 'palm_boots', T(top + V((math.cos(a) * trunk_r * 1.1, math.sin(a) * trunk_r * 1.1, zz + 0.1)), (0, 55 + r.uniform(-10, 10), math.degrees(a))), faces='xXyYZ')
    ga = math.radians(137.508)
    for k in range(nfr):
        f = k / (nfr - 1)
        az = phi + k * ga + r.uniform(-0.15, 0.15)
        zb = lerp(0.15, 0.85, f)
        base = top + V((math.cos(az) * trunk_r * lerp(1.3, 0.4, f), math.sin(az) * trunk_r * lerp(1.3, 0.4, f), zb))
        e0 = lerp(-12, 80, f ** 0.75) + r.uniform(-8, 8)
        droop = lerp(75, 14, f) + r.uniform(-12, 12)
        L = flen * lerp(1.0, 0.6, f ** 2) * r.uniform(0.9, 1.08)
        cells = ('frond_a', 'frond_b') if k % 2 else ('frond_b', 'frond_a')
        frond(mb, base, az, e0, droop, L, cells, r)
    for k in range(skirt):
        az = phi + r.uniform(0, 2 * math.pi)
        base = top + V((math.cos(az) * trunk_r * 1.25, math.sin(az) * trunk_r * 1.25, r.uniform(-0.3, 0.1)))
        frond(mb, base, az, r.uniform(-58, -78), r.uniform(-5, 8), flen * r.uniform(0.7, 0.9), ('frond_dry',), r,
              layers=((14, 0.8), (-12, 0.7)), segs=6, rachis='deadwood', curl=5)
    for k in range(dates):
        az = phi + r.uniform(0, 2 * math.pi)
        b = top + V((math.cos(az) * trunk_r, math.sin(az) * trunk_r, 0.25))
        m = b + V((math.cos(az) * 0.55, math.sin(az) * 0.55, 0.05))
        e = b + V((math.cos(az) * 0.85, math.sin(az) * 0.85, -0.55))
        e = b + V((math.cos(az) * 0.55, math.sin(az) * 0.55, -0.45))
        mb.tube([b, m, e], [0.025, 0.02, 0.015], 'rachis', sides=4)
        rr = random.Random(seed * 10 + k)
        mb.sphere(0.13, 'dates', T(e + V((0, 0, -0.2))), 6, 4, (1, 1, 2.0), rfun=lumpy(rr, 6, 4, 0.2))

def b_palm_a(mb):
    palm(mb, 9.5, 3, 38, 11, skirt=0, dates=0, flen=3.6, boots=True)
def b_palm_b(mb):
    palm(mb, 7.0, 9, 34, 12, skirt=8, dates=4, flen=3.3, trunk_r=0.25)
def b_palm_c(mb):
    palm(mb, 11.5, 12, 36, 13, skirt=4, dates=3, flen=3.4, trunk_r=0.21)

def b_shrub_dry(mb):
    r = random.Random(3)
    for k in range(4):
        card(mb, (r.uniform(-0.05, 0.05), r.uniform(-0.05, 0.05)), 1.25, 1.0, k * 45 + r.uniform(-8, 8), 'shrub_dry', tilt=r.uniform(-6, 6), z0=-0.03)
    for k in range(2):
        card(mb, (r.uniform(-0.3, 0.3), r.uniform(-0.3, 0.3)), 0.8, 0.65, r.uniform(0, 180), 'shrub_dry', z0=-0.03)

def b_bush_oleander(mb):
    r = random.Random(4)
    mb.sphere(0.48, 'leaf_core', T((0, 0, 0.85)), 8, 5, (1, 0.95, 1.1), rfun=lumpy(r, 8, 5, 0.15))
    for k in range(4):
        card(mb, (0, 0), 2.1, 2.0, k * 45 + r.uniform(-10, 10), 'oleander', z0=-0.05)
    for k in range(14):
        a = k / 14 * 2 * math.pi + r.uniform(-0.2, 0.2); rr = r.uniform(0.45, 0.65)
        card(mb, (math.cos(a) * rr, math.sin(a) * rr), 1.2, 1.1, math.degrees(a) + 90 + r.uniform(-25, 25), 'oleander', tilt=r.uniform(-15, 15), z0=r.uniform(0.2, 0.85))

def b_dead_tree(mb):
    r = random.Random(5)
    def branch(p, d, L, rad, depth):
        pts = [p.copy()]; segs = 3 if depth > 0 else 2
        for i in range(segs):
            d = (d + V((r.uniform(-0.3, 0.3), r.uniform(-0.3, 0.3), r.uniform(-0.1, 0.25)))).normalized()
            p = p + d * (L / segs); pts.append(p.copy())
        mb.tube(pts, [rad * (1 - 0.55 * i / segs) for i in range(segs + 1)], 'deadwood', sides=5 if depth > 1 else (4 if depth else 3), caps=False, vrep=1)
        if depth > 0:
            for _ in range(r.randint(2, 3)):
                a = r.uniform(0, 2 * math.pi)
                nd = (d + V((math.cos(a), math.sin(a), 0)) * r.uniform(0.5, 0.9)).normalized()
                k = r.randint(1, segs)
                branch(pts[k], nd, L * r.uniform(0.55, 0.75), rad * 0.55 * (1 - 0.4 * k / segs), depth - 1)
    trunk = [V((0, 0, -0.1)), V((0.05, 0.02, 0.8)), V((0.0, 0.1, 1.6)), V((0.12, 0.05, 2.4))]
    mb.tube(trunk, [0.2, 0.15, 0.13, 0.11], 'deadwood', sides=6, vrep=2)
    for k in range(3):
        a = k * 2.1 + r.uniform(-0.3, 0.3)
        branch(trunk[-1] - V((0, 0, 0.2 * k)), V((math.cos(a) * 0.7, math.sin(a) * 0.7, 0.75)).normalized(), r.uniform(1.6, 2.2), 0.09, 2)

def b_reeds(mb):
    r = random.Random(6)
    for k in range(6):
        card(mb, (r.uniform(-0.15, 0.15), r.uniform(-0.15, 0.15)), 1.3, 2.5 * r.uniform(0.85, 1.05), k * 30 + r.uniform(-6, 6), 'reeds', tilt=r.uniform(-4, 4), z0=-0.03)
    for k in range(4):
        a = r.uniform(0, 2 * math.pi)
        card(mb, (math.cos(a) * 0.45, math.sin(a) * 0.45), 1.0, 1.9 * r.uniform(0.8, 1.0), r.uniform(0, 180), 'reeds', z0=-0.03)

def _crown(mb, centres, size, cell, r, flat=0.35):
    """Leaf clusters: at each centre two crossed upright cards and one tilted towards horizontal."""
    for c in centres:
        s = size * r.uniform(0.8, 1.15); yaw = r.uniform(0, 180)
        for k in range(2):
            card(mb, (c.x, c.y), s, s * 0.9, yaw + k * 90, cell, tilt=r.uniform(-12, 12), z0=c.z - s * 0.45)
        M = T((c.x, c.y, c.z), (90 - flat * 90 + r.uniform(-10, 10), 0, yaw + 45))
        mb.quad((s / 2, 0, -s / 2), (-s / 2, 0, -s / 2), (-s / 2, 0, s / 2), (s / 2, 0, s / 2), cell, (0, 0, 1, 1), M)

def eucalyptus(mb, H, seed):
    """A river red gum: straight pale trunk to ~55 % of the height, two or three leaders, drooping open crown."""
    r = random.Random(seed)
    lean = V((r.uniform(-0.04, 0.04), r.uniform(-0.04, 0.04), 1)).normalized()
    trunk = [V((0, 0, -0.15))]
    for k in range(1, 5):
        trunk.append(trunk[-1] + lean * (H * 0.55 / 4) + V((r.uniform(-0.06, 0.06), r.uniform(-0.06, 0.06), 0)))
    R0 = 0.022 * H + 0.08
    mb.tube(trunk, [R0 * (1 - 0.35 * k / 4) for k in range(5)], 'euca_bark', sides=8, vrep=3)
    tips = []
    def branch(p, d, L, rad, depth):
        pts = [p.copy()]
        for i in range(3):
            d = (d + V((r.uniform(-0.25, 0.25), r.uniform(-0.25, 0.25), r.uniform(-0.05, 0.12)))).normalized()
            p = p + d * (L / 3); pts.append(p.copy())
        mb.tube(pts, [rad, rad * 0.8, rad * 0.6, rad * 0.4], 'euca_bark', sides=5 if depth else 4, caps=False, vrep=1)
        if depth > 0:
            for _ in range(2):
                a = r.uniform(0, 2 * math.pi)
                nd = (d + V((math.cos(a), math.sin(a), 0.1)) * r.uniform(0.5, 0.9)).normalized()
                branch(pts[r.randint(2, 3)], nd, L * r.uniform(0.55, 0.7), rad * 0.55, depth - 1)
        else:
            tips.append(p)
    top = trunk[-1]
    for k in range(r.randint(2, 3)):
        a = k * 2.3 + r.uniform(-0.4, 0.4)
        branch(top, V((math.cos(a) * 0.45, math.sin(a) * 0.45, 1)).normalized(), H * 0.32, R0 * 0.6, 3 if H > 13 else 2)
    # Hanging foliage at the tips, plus a few lower clusters along the leaders.
    cs = [t + V((0, 0, -0.6)) for t in tips]
    for t in tips[::3]:
        cs.append(t * 0.75 + top * 0.25 + V((r.uniform(-0.8, 0.8), r.uniform(-0.8, 0.8), -1.0)))
    _crown(mb, cs, H * (0.15 if H > 13 else 0.19), 'euca_foliage', r, flat=0.25)

def b_tree_eucalyptus(mb):
    eucalyptus(mb, 16.0, 21)
def b_tree_eucalyptus_b(mb):
    eucalyptus(mb, 11.5, 22)

def b_tree_orchard(mb):
    """Citrus orchard tree (~3.8 m): short trunk, three limbs, dense rounded crown."""
    r = random.Random(23)
    trunk = [V((0, 0, -0.1)), V((0.03, 0.0, 0.5)), V((0.0, 0.04, 0.95))]
    mb.tube(trunk, [0.11, 0.09, 0.08], 'deadwood', sides=6, vrep=1)
    for k in range(3):
        a = k * 2.1 + r.uniform(-0.3, 0.3)
        mb.tube([trunk[-1], trunk[-1] + V((math.cos(a) * 0.5, math.sin(a) * 0.5, 0.8))], [0.06, 0.035], 'deadwood', sides=4, caps=False)
    mb.sphere(1.25, 'leaf_core', T((0, 0, 2.3)), 8, 5, (1, 1, 0.85), rfun=lumpy(r, 8, 5, 0.18))
    cs = [V((math.cos(a) * 1.0, math.sin(a) * 1.0, 2.2 + r.uniform(-0.5, 0.6))) for a in [k * 2 * math.pi / 7 + r.uniform(-0.2, 0.2) for k in range(7)]] + [V((0, 0, 3.2))]
    _crown(mb, cs, 1.7, 'orchard_foliage', r, flat=0.5)

def b_tree_tamarisk(mb):
    """Tamarisk (salt cedar), ~5 m: several leaning stems from the base, feathery crown; ditch banks and hedgerows."""
    r = random.Random(24)
    tips = []
    for k in range(5):
        a = k * 1.3 + r.uniform(-0.3, 0.3); l = r.uniform(0.15, 0.4)
        p0 = V((r.uniform(-0.2, 0.2), r.uniform(-0.2, 0.2), -0.1)); p1 = p0 + V((math.cos(a) * l, math.sin(a) * l, 2.2)); p2 = p1 + V((math.cos(a) * l * 1.5, math.sin(a) * l * 1.5, 1.6))
        mb.tube([p0, p1, p2], [0.08, 0.06, 0.035], 'deadwood', sides=5, caps=False)
        tips.append(p2)
    for k in range(6):
        a = k * math.pi / 3 + r.uniform(-0.2, 0.2)
        card(mb, (math.cos(a) * 0.6, math.sin(a) * 0.6), 3.0, 3.6, math.degrees(a) + 90 + r.uniform(-20, 20), 'tamarisk', tilt=r.uniform(-10, 10), z0=1.3)
    _crown(mb, [t + V((0, 0, 0.3)) for t in tips], 2.4, 'tamarisk', r, flat=0.2)

def b_grass_tuft_dry(mb):
    for k in range(3):
        card(mb, (0, 0), 0.55, 0.38, k * 60 + 10, 'grass_dry', z0=-0.02)

# ============================================================================================ rooftop / facade
def b_water_tank(mb):
    """1000 L black polyethylene tank (1.1 m x 1.25 m) on a 1 m angle-iron stand."""
    h0 = 1.0
    for sx in (-1, 1):
        for sy in (-1, 1):
            mb.box((0.05, 0.05, h0), 'galv_rust', loc=(sx * 0.55, sy * 0.55, h0 / 2), faces='xXyYZ')
        mb.box((1.15, 0.05, 0.05), 'galv_rust', loc=(0, sx * 0.55, h0 - 0.025))
        mb.box((0.05, 1.15, 0.05), 'galv_rust', loc=(sx * 0.55, 0, h0 - 0.025))
        mb.beam((sx * 0.55, -0.53, 0.08), (sx * 0.55, 0.53, h0 - 0.06), 0.03, 0.03, 'galv_rust')
        mb.beam((-0.53, sx * 0.55, 0.08), (0.53, sx * 0.55, h0 - 0.06), 0.03, 0.03, 'galv_rust')
    mb.box((1.15, 1.15, 0.025), 'galv_rust', loc=(0, 0, h0 + 0.0125), faces='zZ')
    z0 = h0 + 0.025
    prof = [(0.52, z0), (0.55, z0 + 0.03)]
    for zz in (0.28, 0.6, 0.92):
        prof += [(0.55, z0 + zz - 0.03), (0.567, z0 + zz), (0.55, z0 + zz + 0.03)]
    prof += [(0.55, z0 + 1.1), (0.46, z0 + 1.2), (0.22, z0 + 1.25)]
    mb.lathe(prof, 16, 'black_plastic', cap0=True, cap1=True)
    mb.cyl(0.21, 0.07, 'black_plastic', T((0, 0, z0 + 1.25)), 16)
    mb.bar((0.45, 0.2, z0 + 0.06), (0.62, 0.2, z0 + 0.06), 0.02, 'white_plastic', 6)
    mb.bar((0.62, 0.2, z0 + 0.06), (0.62, 0.2, 0.0), 0.02, 'white_plastic', 6)

def b_water_tank_steel(mb):
    """~1200 L horizontal galvanised steel tank with dished ends on a saddle stand."""
    s = sub(mb)
    prof = [(0.0, -0.96), (0.22, -0.94), (0.38, -0.89), (0.45, -0.82), (0.45, -0.42), (0.462, -0.40), (0.45, -0.38),
            (0.45, 0.38), (0.462, 0.40), (0.45, 0.42), (0.45, 0.82), (0.38, 0.89), (0.22, 0.94), (0.0, 0.96)]
    s.lathe(prof, 16, 'galv_rust', urep=2)
    s.cyl(0.13, 0.12, 'galv', T((-0.42, 0, 0), (0, -90, 0)), 10, r2=0.12)   # manhole (local -X becomes +Z)
    mb.merge(s, T((0, 0, 1.05), (0, 90, 0)))
    for x in (-0.55, 0.55):
        mb.box((0.08, 0.7, 0.18), 'galv_rust', loc=(x, 0, 0.62))
        for y in (-0.32, 0.32):
            mb.box((0.05, 0.05, 0.62), 'galv_rust', loc=(x, y, 0.31), faces='xXyYZ')
        mb.beam((x, -0.3, 0.05), (x, 0.3, 0.55), 0.03, 0.03, 'galv_rust')
    mb.bar((0.6, 0.0, 0.7), (0.9, 0.0, 0.7), 0.02, 'galv', 6)
    mb.bar((0.9, 0.0, 0.7), (0.9, 0.0, 0.0), 0.02, 'galv', 6)

def b_ac_split(mb):
    """Split AC outdoor unit 0.80 x 0.30 x 0.55 m on rubber-footed rails; fan grille faces +Y."""
    z0 = 0.06
    mb.box((0.80, 0.30, 0.55), 'cream_metal', loc=(0, 0, z0 + 0.275), faces='xXyZ')
    mb.box((0.80, 0.30, 0.55), 'ac_front', loc=(0, 0, z0 + 0.275), faces='Y')
    for x in (-0.28, 0.28):
        mb.box((0.06, 0.38, 0.06), 'rubber', loc=(x, 0, 0.03), faces='xXyYZ')
    mb.bar((0.40, -0.04, z0 + 0.12), (0.47, -0.04, z0 + 0.12), 0.012, 'copper', 5)
    mb.bar((0.40, -0.09, z0 + 0.10), (0.47, -0.09, z0 + 0.10), 0.016, 'insulation', 5)
    mb.box((0.06, 0.12, 0.14), 'cream_metal', loc=(0.43, -0.06, z0 + 0.12), faces='xXyYZ')

def b_ac_window(mb):
    """Window AC unit 0.60 x 0.62 x 0.42 m. +Y = the outdoor end (rear fin grille), sticks out of the wall."""
    mb.box((0.60, 0.62, 0.42), 'cream_metal', loc=(0, 0, 0.21), faces='yzZ')
    mb.box((0.60, 0.62, 0.42), 'ac_window', loc=(0, 0, 0.21), faces='Y', uv=(0, 0, 0.5, 1))
    mb.box((0.60, 0.62, 0.42), 'ac_window', loc=(0, 0, 0.21), faces='xX', uv=(0.5, 0, 1, 1))
    mb.box((0.62, 0.04, 0.44), 'cream_metal', loc=(0, -0.12, 0.21), faces='xXYzZ')    # wall flange

def b_sat_dish(mb):
    """0.9 m offset dish on a roof pole mount, aimed +Y at ~30 degrees elevation."""
    mb.box((0.35, 0.35, 0.012), 'galv', loc=(0, 0, 0.006), faces='xXyYZ')
    mb.bar((0, 0, 0.012), (0, 0, 1.05), 0.024, 'galv', 8)
    for a in (0, 120, 240):
        ar = math.radians(a)
        mb.bar((math.cos(ar) * 0.15, math.sin(ar) * 0.15, 0.012), (0, 0, 0.35), 0.008, 'galv', 4, caps=False)
    f = 0.36
    prof = [(0.45 * k / 4, (0.45 * k / 4) ** 2 / (4 * f)) for k in range(5)]
    c = V((0, 0.16, 1.12)); el = math.radians(30)
    M = Matrix.Translation(c) @ Matrix.Rotation(-(math.pi / 2 - el), 4, 'X')
    mb.lathe(prof, 14, 'white_plastic', M, sy=1.1)
    back = [(p[0], p[1] - 0.012) for p in prof][::-1]
    mb.lathe(back, 14, 'white_plastic', M, sy=1.1)
    lnb = M @ V((0, 0, f))
    arm0 = M @ V((0, 0.48, prof[-1][1]))
    mb.bar(arm0, lnb, 0.012, 'galv', 4)
    mb.box((0.06, 0.06, 0.12), 'white_plastic', Matrix.Translation(lnb) @ M.to_3x3().to_4x4())
    mb.bar((0, 0, 1.0), M @ V((0, 0, -0.02)), 0.02, 'galv', 6)

def b_antenna_tv(mb):
    """Terrestrial TV antenna: 3.2 m mast on a tripod with a VHF and a UHF Yagi."""
    mb.bar((0, 0, 0), (0, 0, 3.25), 0.02, 'galv', 6)
    for a in (30, 150, 270):
        ar = math.radians(a)
        mb.bar((math.cos(ar) * 0.55, math.sin(ar) * 0.55, 0), (0, 0, 0.7), 0.012, 'galv', 4)
    for z, L, n, el0, rot in ((3.15, 1.5, 9, 0.62, 0), (2.6, 1.0, 10, 0.32, 25)):
        M = T((0, 0, z), (0, 0, rot))
        mb.bar(M @ V((0, -L * 0.3, 0)), M @ V((0, L * 0.7, 0)), 0.01, 'galv', 4)
        for k in range(n):
            y = -L * 0.3 + L * k / (n - 1)
            el = el0 * (1 - 0.45 * k / (n - 1))
            mb.box((el, 0.008, 0.008), 'galv', M @ T((0, y, 0)), faces='xXyYzZ')
    mb.box((0.08, 0.05, 0.1), 'grey_paint', loc=(0, 0.05, 2.5))

def b_solar_heater(mb):
    """Thermosiphon solar water heater: two 1 x 2 m flat collectors at 40 degrees facing +Y, 200 L tank on top."""
    ang = 40; s = V((0, -math.cos(math.radians(ang)), math.sin(math.radians(ang))))
    low = V((0, 0.85, 0.35))
    for x in (-0.52, 0.52):
        c = low + s * 1.0 + V((x, 0, 0))
        M = T(c, (-ang, 0, 0))
        mb.box((1.0, 2.0, 0.08), 'solar', M, faces='Z')
        mb.box((1.0, 2.0, 0.08), 'galv', M, faces='xXyYz')
    top = low + s * 2.0
    tc = top + V((0, -0.22, 0.32))
    mb.cyl(0.29, 2.1, 'tank_white', T(tc + V((-1.05, 0, 0)), (0, 90, 0)), 16, urep=1)
    for x in (-0.9, 0.9):
        mb.bar((x, low.y, 0), (x, low.y, low.z), 0.025, 'galv', 6)
        mb.bar((x, top.y, 0), (x, top.y, top.z), 0.025, 'galv', 6)
        mb.bar((x, tc.y, 0), (x, tc.y, tc.z - 0.25), 0.025, 'galv', 6)
        mb.bar((x, low.y, 0.05), (x, top.y, top.z - 0.1), 0.018, 'galv', 4)
        mb.bar((x, low.y, 0.0), (x, tc.y, 0.0), 0.02, 'galv', 4)
    for x in (-0.3, 0.3):
        mb.bar(top + V((x, 0, 0.04)), tc + V((x, 0, -0.2)), 0.015, 'galv', 4)

def b_generator_small(mb):
    """Open-frame petrol generator (~3 kW), 0.70 x 0.55 x 0.55 m."""
    for x in (-0.3, 0.3):
        loop = [V((x, -0.25, 0.02)), V((x, 0.25, 0.02)), V((x, 0.27, 0.06)), V((x, 0.27, 0.5)), V((x, 0.22, 0.55)), V((x, -0.22, 0.55)), V((x, -0.27, 0.5)), V((x, -0.27, 0.06)), V((x, -0.25, 0.02))]
        mb.tube(loop, 0.016, 'steel_dark', sides=5)
    for y, z in ((-0.25, 0.02), (0.25, 0.02), (0.22, 0.55), (-0.22, 0.55)):
        mb.bar((-0.3, y, z), (0.3, y, z), 0.014, 'steel_dark', 5, caps=False)
    mb.box((0.30, 0.32, 0.26), 'red_paint', loc=(-0.1, 0, 0.19))
    mb.cyl(0.13, 0.26, 'grey_paint', T((0.05, 0, 0.2), (0, 90, 0)), 12)
    mb.chamfer_box((0.50, 0.34, 0.14), 0.03, 'red_paint', T((0, 0, 0.45)))
    mb.cyl(0.035, 0.03, 'steel_dark', T((-0.12, 0.05, 0.52)), 8)
    mb.box((0.02, 0.18, 0.13), 'gen_panel', loc=(0.31, 0.0, 0.22), faces='X')
    mb.box((0.02, 0.18, 0.13), 'grey_paint', loc=(0.31, 0.0, 0.22), faces='xyYzZ')
    mb.cyl(0.06, 0.22, 'steel_dark', T((-0.18, -0.12, 0.36), (-90, 0, 0)), 8)
    mb.cyl(0.07, 0.04, 'steel_dark', T((-0.27, 0.06, 0.22), (0, -90, 0)), 10)

def b_roof_clutter(mb):
    """Pile of rooftop junk: lying fridge, planks, corrugated sheet, tyres, broken chair, cinder blocks, bucket."""
    r = random.Random(21)
    mb.box((1.45, 0.62, 0.62), 'white_plastic', T((0.2, -0.45, 0.31), (0, 0, 8)))
    mb.box((0.02, 0.5, 0.5), 'steel_dark', T((0.94, -0.35, 0.33), (0, 0, 8)), faces='X')
    for k in range(5):
        mb.box((2.2, 0.18, 0.035), 'wood_old', T((r.uniform(-0.3, 0.3), 0.45 + r.uniform(-0.15, 0.15), 0.02 + 0.035 * k), (0, r.uniform(-2, 2), r.uniform(-12, 12))))
    mb.box((1.8, 0.85, 0.012), 'tin', T((-0.15, -0.2, 0.9), (52, 0, 4)), faces='zZ')
    tyre(mb, T((-1.05, 0.55, 0.1)), 0.31, 0.19)
    tyre(mb, T((-1.15, -0.75, 0.32), (75, 0, 30)), 0.31, 0.19)
    chair(mb, T((1.05, 0.55, 0.22), (95, 0, 140)))
    for k in range(3):
        mb.box((0.4, 0.2, 0.2), 'concrete_c', T((-0.4 + k * 0.42, -1.05, 0.1), (0, 0, r.uniform(-8, 8))))
    mb.box((0.4, 0.2, 0.2), 'concrete_c', T((-0.2, -1.05, 0.3), (0, 0, 20)))
    mb.lathe([(0.13, 0), (0.16, 0.30)], 10, 'bag_blue', T((1.2, -0.6, 0)), cap0=True)
    mb.lathe([(0.15, 0.30), (0.13, 0.0)], 10, 'bag_blue', T((1.2, -0.6, 0)))
    mb.chamfer_box((0.35, 0.17, 0.46), 0.03, 'green_paint', T((0.7, 0.75, 0.23), (0, 0, 20)))
    mb.box((0.45, 0.35, 0.3), 'cardboard', T((0.2, 0.05, 0.77), (0, 0, 15)))

def b_clothesline(mb):
    """Two T-posts 4 m apart with three sagging lines and washing."""
    r = random.Random(8)
    for x in (-2.0, 2.0):
        mb.bar((x, 0, 0), (x, 0, 1.9), 0.025, 'galv', 6)
        mb.bar((x, -0.42, 1.88), (x, 0.42, 1.88), 0.018, 'galv', 5)
    k = 0
    for y in (-0.35, 0.0, 0.35):
        line = [V((lerp(-2.0, 2.0, i / 6), y, 1.9 - 0.12 * math.sin(math.pi * i / 6))) for i in range(7)]
        mb.tube(line, 0.004, 'grey_paint', sides=3)
        x = -1.75 + r.uniform(0, 0.3)
        while x < 1.4:
            g = r.randrange(4); w = (0.55, 0.45, 0.6, 0.5)[g]; h = (0.7, 0.9, 1.05, 0.55)[g]
            sag = lambda xx: 1.9 - 0.12 * math.sin(math.pi * (xx + 2.0) / 4.0)
            xa, xb = x, x + w
            wind = r.uniform(0.02, 0.08)
            pa = V((xa, y, sag(xa) + 0.01)); pb = V((xb, y, sag(xb) + 0.01))
            mb.quad(pa + V((0, wind, -h)), pb + V((0, wind, -h)), pb, pa, 'clothes', (g / 4 + 0.005, 0, (g + 1) / 4 - 0.005, 1))
            x += w + r.uniform(0.1, 0.45); k += 1

# ============================================================================================ street
def produce_crate(mb, M, kind, r, fruit_cell, fruit_r, size=(0.55, 0.38, 0.24), nfruit=3):
    s = sub(mb)
    sx, sy, sz = size
    s.box(size, 'crate_slats', T((0, 0, sz / 2)), faces='xXyY')
    s.quad((-sx / 2, -sy / 2, sz - 0.04), (sx / 2, -sy / 2, sz - 0.04), (sx / 2, sy / 2, sz - 0.04), (-sx / 2, sy / 2, sz - 0.04), 'prod_' + kind)
    for _ in range(nfruit):
        s.sphere(fruit_r, fruit_cell, T((r.uniform(-sx / 2 + fruit_r, sx / 2 - fruit_r), r.uniform(-sy / 2 + fruit_r, sy / 2 - fruit_r), sz - 0.04 + fruit_r * 0.6)), 5, 3, smooth=True)
    mb.merge(s, M)

def b_market_stall(mb):
    """Vegetable/ fruit stall 2.4 x 1.6 m: timber frame, striped canvas awning with scalloped valance, sloping
    display of produce crates, tarp back wall, melons and sacks on the ground."""
    r = random.Random(31)
    W, D = 2.4, 1.6
    for x in (-1.15, 1.15):
        mb.box((0.07, 0.07, 2.12), 'wood_old', loc=(x, D / 2 - 0.05, 1.06), faces='xXyYZ')
        mb.box((0.07, 0.07, 2.42), 'wood_old', loc=(x, -D / 2 + 0.05, 1.21), faces='xXyYZ')
        mb.beam((x, -D / 2 + 0.05, 2.38), (x, D / 2 - 0.05, 2.1), 0.06, 0.06, 'wood_old')
    mb.box((2.36, 0.06, 0.06), 'wood_old', loc=(0, D / 2 - 0.05, 2.1))
    mb.box((2.36, 0.06, 0.06), 'wood_old', loc=(0, -D / 2 + 0.05, 2.39))
    mb.box((2.36, 1.15, 0.04), 'wood_old', loc=(0, 0.17, 0.80))
    mb.box((2.36, 0.025, 0.55), 'wood_blue', loc=(0, D / 2 - 0.04, 0.52), faces='xXyYZ')
    mb.box((2.36, 0.42, 0.22), 'wood_old', loc=(0, -0.2, 0.93), faces='xXyYZ')
    for x in (-0.6, 0.6):
        mb.box((0.06, 0.06, 0.78), 'wood_old', loc=(x, -0.3, 0.39), faces='xXyYZ')
    kinds = [('tomato', 'tomato', 0.04), ('orange', 'orange', 0.045), ('aubergine', 'bakelite', 0.04), ('cucumber', 'green_veg', 0.03),
             ('potato', 'cardboard', 0.04), ('onion', 'ceramic_brown', 0.04)]
    for i in range(3):        # front row, tilted towards the customer
        k = kinds[i]
        produce_crate(mb, T((-0.76 + i * 0.76, 0.42, 0.82), (-14, 0, r.uniform(-2, 2))), k[0], r, k[1], k[2])
    for i in range(3):        # back row on the step
        k = kinds[3 + i]
        produce_crate(mb, T((-0.76 + i * 0.76, -0.2, 1.04), (-10, 0, r.uniform(-2, 2))), k[0], r, k[1], k[2])
    # ground: melons, crates and a sack
    for k in range(6):
        a = r.uniform(0, 2 * math.pi); rr = r.uniform(0, 0.28)
        mb.sphere(r.uniform(0.13, 0.17), 'melon', T((-0.75 + math.cos(a) * rr, 1.15 + math.sin(a) * rr * 0.6, 0.13 + (0.18 if k == 5 else 0))), 10, 6, (1.15, 1, 0.95))
    produce_crate(mb, T((0.75, 1.1, 0), (0, 0, 8)), 'orange', r, 'orange', 0.045)
    mb.box((0.55, 0.38, 0.24), 'crate_slats', T((0.72, 1.12, 0.36), (0, 0, -6)), faces='xXyYZ')
    mb.chamfer_box((0.45, 0.32, 0.55), 0.08, 'cardboard', T((1.35, 0.6, 0.27), (0, 0, 20)), jitter=0.02, rng=r)
    # awning: sagging canvas sloping to the front, overhanging 0.45 m, with scalloped valance
    nx, ny = 6, 4
    P = []
    for i in range(nx + 1):
        row = []
        for j in range(ny + 1):
            u, v = i / nx, j / ny
            x = lerp(-1.25, 1.25, u); y = lerp(-D / 2 - 0.05, D / 2 + 0.45, v)
            z = lerp(2.45, 2.06, v) - 0.07 * math.sin(math.pi * u) * math.sin(math.pi * min(1, v * 1.2)) + (0.02 if i in (0, nx) else 0)
            row.append(V((x, y, z)))
        P.append(row)
    mb.surf(P, 'canvas_rw', uv=(0, 0.15, 1, 1))
    front = [P[i][ny] for i in range(nx + 1)]
    mb.ribbon([p + V((0, 0, -0.28)) for p in front], front, 'canvas_rw', uv=(0, 0, 1, 0.14))
    for i0 in (0, nx):
        side = [P[i0][j] for j in range(ny + 1)]
        mb.ribbon([p + V((0, 0, -0.25)) for p in side], side, 'canvas_rw', uv=(0, 0, 0.35, 0.14))
    # tarp back wall
    BW = [[V((lerp(-1.18, 1.18, i / 4), -D / 2 + 0.02 + 0.03 * math.sin(math.pi * i / 4) * j / 2, lerp(0.95, 2.35, j / 2))) for j in range(3)] for i in range(5)]
    mb.surf(BW, 'tarp_blue')
    # hanging onion bags and a bulb
    for k, x in enumerate((-0.8, -0.55, 0.9)):
        mb.bar((x, D / 2 - 0.05, 2.07), (x, D / 2 - 0.05, 1.8), 0.004, 'dirt', 3)
        mb.sphere(0.07, 'tomato' if k < 2 else 'orange', T((x, D / 2 - 0.05, 1.73)), 8, 5, (1, 1, 1.5), rfun=lumpy(r, 8, 5, 0.12))
    mb.bar((0, 0.1, 2.25), (0, 0.1, 1.95), 0.004, 'steel_dark', 3)
    mb.sphere(0.04, 'lamp', T((0, 0.1, 1.92)), 6, 4)
    chair(mb, T((0.6, -1.2, 0), (0, 0, 160)))

def b_awning_shop(mb):
    """Shop canopy 3 m wide projecting 1.25 m; wall plane y = 0, mounted at the real height above a shopfront
    (wall line z = 3.0 m, front edge z = 2.55 m, valance to 2.27 m)."""
    nx, ny = 6, 2
    P = [[V((lerp(-1.5, 1.5, i / nx), lerp(0.05, 1.25, j / ny), lerp(3.0, 2.55, j / ny) - 0.035 * math.sin(math.pi * j / ny))) for j in range(ny + 1)] for i in range(nx + 1)]
    mb.surf(P, 'canvas_gw', uv=(0, 0.15, 1, 1))
    front = [P[i][ny] for i in range(nx + 1)]
    mb.ribbon([p + V((0, 0, -0.28)) for p in front], front, 'canvas_gw', uv=(0, 0, 1, 0.14))
    for i0, sgn in ((0, -1), (nx, 1)):
        a, b, c = V((sgn * 1.5, 0.05, 3.0)), V((sgn * 1.5, 1.25, 2.55)), V((sgn * 1.5, 1.25, 2.27))
        mb.poly([a, b, c], [(0, 1), (1, 0.15), (1, 0)], 'canvas_gw')
    mb.box((3.1, 0.16, 0.16), 'grey_paint', loc=(0, 0.08, 3.08))
    mb.box((3.05, 0.05, 0.05), 'aluminium', loc=(0, 1.25, 2.53))
    for x in (-1.3, 1.3):
        mb.beam((x, 0.03, 2.62), (x * 0.95, 1.22, 2.53), 0.04, 0.03, 'aluminium')
        mb.box((0.08, 0.06, 0.12), 'grey_paint', loc=(x, 0.03, 2.62))

def b_shop_shutter(mb):
    """Closed roller shutter 3.0 x 2.5 m with roll box, guide rails, bottom bar and padlocks. Wall plane y = 0."""
    W, H = 3.0, 2.5
    n = 20
    P = []
    for i in range(2):
        row = []
        for j in range(n + 1):
            z = H * j / n
            row.append(V(((1 - 2 * i) * -W / 2, 0.045 + (0.012 if j % 2 else 0.0), z)))
        P.append(row)
    mb.surf(P[::-1], 'shutter', vrep=1, smooth=False)
    mb.box((3.24, 0.32, 0.36), 'shutter', loc=(0, 0.16, H + 0.18), faces='xXYz', uv=(0, 0.85, 1, 1))
    mb.box((3.24, 0.32, 0.36), 'grey_paint', loc=(0, 0.16, H + 0.18), faces='Z')
    for x in (-1, 1):
        mb.box((0.07, 0.09, H), 'grey_paint', loc=(x * (W / 2 + 0.035), 0.045, H / 2), faces='xXYZ')
    mb.box((W, 0.07, 0.07), 'steel_dark', loc=(0, 0.06, 0.035), faces='xXyYZ')
    for x in (-0.6, 0.6):
        mb.box((0.06, 0.04, 0.09), 'steel_dark', loc=(x, 0.11, 0.06), faces='xXYZ')
        mb.box((0.05, 0.03, 0.06), 'copper', loc=(x, 0.14, 0.0 + 0.04), faces='xXYZz')

def b_sign_shop(mb):
    """Painted shop sign board 3.0 x 0.8 m (abstract Arabic-style lettering) with two goose-neck lamps; wall plane
    y = 0, mounted at its real height above a 3 m shopfront (board 3.15 - 3.95 m)."""
    z = 3.55
    mb.box((3.0, 0.05, 0.8), 'sign_a', loc=(0, 0.1, z), faces='Y')
    mb.box((3.0, 0.05, 0.8), 'galv_rust', loc=(0, 0.1, z), faces='xXyzZ')
    for x in (-1.2, 1.2):
        mb.box((0.05, 0.08, 0.05), 'steel_dark', loc=(x, 0.04, z + 0.2))
        mb.box((0.05, 0.08, 0.05), 'steel_dark', loc=(x, 0.04, z - 0.2))
        mb.tube([V((x * 0.8, 0.12, z + 0.4)), V((x * 0.8, 0.2, z + 0.62)), V((x * 0.8, 0.45, z + 0.65))], 0.012, 'steel_dark', sides=4)
        mb.box((0.18, 0.12, 0.06), 'steel_dark', T((x * 0.8, 0.5, z + 0.62), (-20, 0, 0)))

def b_cart_hand(mb):
    """Two-wheeled wooden hand cart (arabana): 1.5 x 0.9 m bed on car wheels, handles to +Y, resting on its legs."""
    r = random.Random(41)
    bz = 0.62
    mb.box((0.9, 1.5, 0.04), 'wood_old', loc=(0, 0, bz))
    for x in (-0.43, 0.43):
        mb.box((0.04, 1.5, 0.18), 'wood_blue', loc=(x, 0, bz + 0.11))
        mb.beam((x * 0.9, -0.75, bz - 0.04), (x * 0.75, 1.75, bz + 0.08), 0.06, 0.06, 'wood_old')
        mb.beam((x * 0.9, -0.65, bz - 0.04), (x * 0.9, -0.62, 0.0), 0.05, 0.05, 'wood_old')
        mb.bar((x * 0.75, 1.62, bz + 0.07), (x * 0.75, 1.80, bz + 0.09), 0.025, 'rubber', 5)
    mb.box((0.9, 0.04, 0.18), 'wood_blue', loc=(0, -0.73, bz + 0.11))
    mb.bar((-0.5, 0.05, 0.31), (0.5, 0.05, 0.31), 0.02, 'steel_dark', 5)
    for x in (-0.55, 0.55):
        tyre(mb, T((x, 0.05, 0.31), (0, 90, 0)), 0.31, 0.16, segs=12)
        mb.cyl(0.13, 0.12, 'grey_paint', T((x - 0.06, 0.05, 0.31), (0, 90, 0)), 10)
    mb.chamfer_box((0.6, 0.38, 0.28), 0.1, 'canvas_tan', T((-0.12, -0.35, bz + 0.16), (0, 0, 10)), jitter=0.02, rng=r)
    mb.chamfer_box((0.6, 0.38, 0.26), 0.1, 'canvas_tan', T((0.15, 0.15, bz + 0.15), (0, 0, -15)), jitter=0.02, rng=r)

def b_plastic_chair(mb):
    chair(mb)

def b_table_plastic(mb):
    mb.chamfer_box((0.80, 0.80, 0.04), 0.012, 'white_plastic', T((0, 0, 0.71)))
    for sx in (-1, 1):
        for sy in (-1, 1):
            mb.bar((sx * 0.36, sy * 0.36, 0), (sx * 0.33, sy * 0.33, 0.70), 0.024, 'white_plastic', 6)
    for a in range(4):
        mb.box((0.74, 0.015, 0.06), 'white_plastic', T((0, 0, 0.66), (0, 0, a * 90)) @ T((0, 0.37, 0)), faces='yYz')

def b_gas_cylinder(mb):
    """12.5 kg LPG cylinder (0.31 x 0.67 m) with foot ring, guard collar and valve."""
    prof = [(0.13, 0.0), (0.13, 0.05, 'S'), (0.14, 0.07), (0.155, 0.11), (0.155, 0.45), (0.14, 0.52), (0.10, 0.56), (0.05, 0.58)]
    mb.lathe(prof, 12, 'gas_cyl', cap1=True, vrep=1)
    mb.lathe([(0.095, 0.57), (0.095, 0.68)], 10, 'grey_paint')
    mb.lathe([(0.088, 0.68), (0.088, 0.57)], 10, 'grey_paint')
    mb.cyl(0.022, 0.07, 'copper', T((0, 0, 0.58)), 6)
    mb.box((0.02, 0.06, 0.02), 'copper', loc=(0, 0.03, 0.63))

def drum(mb, cell, r, dents=0.0):
    prof = [(0.282, 0.0), (0.287, 0.012), (0.28, 0.028)]
    for z in (0.285, 0.565):
        prof += [(0.28, z - 0.015), (0.291, z), (0.28, z + 0.015)]
    prof += [(0.28, 0.823), (0.287, 0.839), (0.282, 0.851), (0.262, 0.851, 'S'), (0.262, 0.835)]
    f = None
    if dents:
        tab = [r.uniform(1 - dents, 1) for _ in range(16)]
        f = lambda a, k: (tab[int(round(a / (2 * math.pi) * 16)) % 16] if 2 < k < len(prof) - 3 else 1.0)
    mb.lathe(prof, 16, cell, cap0=True, cap1=True, rfun=f)
    mb.cyl(0.03, 0.012, 'steel_dark', T((0.17, 0.05, 0.835)), 6)

def b_oil_drum(mb):
    drum(mb, 'drum_blue', random.Random(1), 0.0)

def b_oil_drum_rusty(mb):
    drum(mb, 'drum_rust', random.Random(2), 0.05)

def b_tyres_pile(mb):
    r = random.Random(9)
    for k in range(4):
        tyre(mb, T((r.uniform(-0.04, 0.04), r.uniform(-0.04, 0.04), 0.1 + k * 0.2), (r.uniform(-3, 3), r.uniform(-3, 3), 0)), 0.32, 0.2)
    tyre(mb, T((0.62, 0.15, 0.33), (78, 0, 70)), 0.33, 0.2)
    tyre(mb, T((-0.45, -0.55, 0.31), (82, 0, -30)), 0.31, 0.19)
    tyre(mb, T((-0.75, 0.35, 0.1), (4, 0, 0)), 0.30, 0.19)

def b_trash_pile(mb):
    """Street garbage heap ~2.4 x 2 m: mixed refuse mound, bags, crushed boxes, bottles."""
    r = random.Random(12)
    n = 8
    lumps = [(r.uniform(-0.7, 0.7), r.uniform(-0.5, 0.5), r.uniform(0.1, 0.25), r.uniform(0.3, 0.6)) for _ in range(6)]
    def hgt(x, y):
        rho = (x / 1.2) ** 2 + (y / 1.0) ** 2
        z = 0.35 * max(0.0, 1 - rho) ** 0.8
        for lx, ly, lh, lr in lumps:
            z += lh * math.exp(-((x - lx) ** 2 + (y - ly) ** 2) / (lr * lr)) * max(0.0, 1 - rho)
        return z - 0.02
    P = [[V((lerp(-1.25, 1.25, i / n), lerp(-1.05, 1.05, j / n), 0)) for j in range(n + 1)] for i in range(n + 1)]
    for row in P:
        for p in row:
            p.z = hgt(p.x, p.y)
    mb.surf(P, 'trash', urep=2, vrep=2)
    for k in range(4):
        x, y = r.uniform(-0.8, 0.8), r.uniform(-0.6, 0.6)
        mb.sphere(r.uniform(0.2, 0.28), r.choice(['bag_black', 'bag_black', 'bag_white', 'bag_blue']), T((x, y, hgt(x, y) + 0.12)), 7, 4, (1, 1, 0.75), rfun=lumpy(r, 7, 4, 0.15))
    for k in range(2):
        x, y = r.uniform(-0.9, 0.9), r.uniform(-0.7, 0.7)
        mb.chamfer_box((0.45, 0.32, 0.2), 0.02, 'cardboard', T((x, y, hgt(x, y) + 0.06), (r.uniform(-20, 20), r.uniform(-20, 20), r.uniform(0, 180))), jitter=0.04, rng=r)
    for k in range(5):
        x, y = r.uniform(-1.1, 1.1), r.uniform(-0.9, 0.9)
        z = max(0.03, hgt(x, y) + 0.03)
        a = r.uniform(0, 2 * math.pi)
        mb.bar((x, y, z), (x + math.cos(a) * 0.28, y + math.sin(a) * 0.28, z + r.uniform(-0.05, 0.05)), 0.04, r.choice(['bag_white', 'green_veg', 'bag_blue']), 6)

def b_trash_bags(mb):
    r = random.Random(14)
    spots = [(0, 0, 0, 1.0), (0.55, 0.15, 0, 0.9), (-0.5, 0.2, 0, 0.85), (0.15, -0.45, 0, 0.8), (0.1, 0.1, 0.4, 0.75)]
    for k, (x, y, z, s) in enumerate(spots):
        prof = [(0.0, 0.0), (0.24, 0.03), (0.29, 0.15), (0.26, 0.32), (0.14, 0.45), (0.04, 0.5), (0.03, 0.54), (0.07, 0.6), (0.0, 0.62)]
        M = T((x, y, z), (r.uniform(-15, 15) if k < 4 else 70, r.uniform(-10, 10), r.uniform(0, 360)), s)
        mb.lathe(prof, 8, 'bag_black' if k != 2 else 'bag_blue', M, rfun=lumpy(r, 8, len(prof) - 1, 0.13))

def mound(mb, R, H, n, r, cell='rubble', urep=2, sq=1.0):
    """Irregular rubble mound radius ~R, height H, n x n grid (multiple of urep). Returns the height function."""
    bumps = [(r.uniform(-R, R) * 0.7, r.uniform(-R, R) * 0.7 * sq, r.uniform(0.1, 0.35) * H, r.uniform(0.2, 0.45) * R) for _ in range(9)]
    lobes = [r.uniform(0.8, 1.2) for _ in range(5)]
    def rad(a):
        k = (a / (2 * math.pi) * 5) % 5; i = int(k); f = k - i
        return R * lerp(lobes[i], lobes[(i + 1) % 5], f)
    def hgt(x, y):
        a = math.atan2(y / sq, x) % (2 * math.pi)
        rho = math.hypot(x, y / sq) / rad(a)
        z = H * max(0.0, 1 - rho ** 1.6) ** 1.2
        for bx, by, bh, br in bumps:
            z += bh * math.exp(-((x - bx) ** 2 + (y - by) ** 2) / (br * br)) * max(0.0, 1 - rho)
        return z - 0.03
    E = R * 1.25
    P = [[V((lerp(-E, E, i / n), lerp(-E * sq, E * sq, j / n), 0)) for j in range(n + 1)] for i in range(n + 1)]
    for row in P:
        for p in row:
            p.z = hgt(p.x, p.y) + r.uniform(-0.03, 0.03) * (p.z > 0)
    # drop flat outer quads: build manually to skip fully buried faces
    mb.surf(P, cell, urep=urep, vrep=urep)
    return hgt

def rebar(mb, p, d, L, r, bends=2):
    pts = [V(p)]
    d = V(d).normalized()
    for i in range(bends + 1):
        d = (d + V((r.uniform(-0.5, 0.5), r.uniform(-0.5, 0.5), r.uniform(-0.4, 0.2)))).normalized()
        pts.append(pts[-1] + d * L / (bends + 1))
    mb.tube(pts, 0.011, 'rust', sides=4, caps=False)

def rubble(mb, R, H, n, seed, nch, nreb, slab=False):
    r = random.Random(seed)
    hgt = mound(mb, R, H, n, r)
    for k in range(nch):
        a = r.uniform(0, 2 * math.pi); rr = R * math.sqrt(r.random()) * 0.85
        x, y = math.cos(a) * rr, math.sin(a) * rr
        s = r.uniform(0.15, 0.55) * (R / 2) ** 0.4
        size = (s * r.uniform(0.8, 2.0), s * r.uniform(0.7, 1.4), s * r.uniform(0.25, 0.7))
        kind = r.random()
        if kind < 0.2:      # flat broken slab fragment
            size = (s * r.uniform(1.6, 2.6), s * r.uniform(1.0, 1.8), 0.12 * (R / 2) ** 0.3)
        elif kind < 0.32:   # brick/ block bits
            size = (0.24, 0.12, 0.08)
        mb.chamfer_box(size, min(size) * 0.25, 'brick_red' if kind >= 0.2 and kind < 0.32 else 'concrete_broken',
                       T((x, y, hgt(x, y) + size[2] * 0.1), (r.uniform(-35, 35), r.uniform(-35, 35), r.uniform(0, 360))), jitter=min(size) * 0.28, rng=r)
    for k in range(nreb):
        a = r.uniform(0, 2 * math.pi); rr = R * r.uniform(0.1, 0.7)
        x, y = math.cos(a) * rr, math.sin(a) * rr
        rebar(mb, (x, y, hgt(x, y) - 0.1), (math.cos(a) * 0.6, math.sin(a) * 0.6, 1.0), r.uniform(0.6, 1.4), r)
    if slab:
        outline = [(-1.3, -0.8), (1.1, -0.9), (1.3, -0.2), (0.9, 0.1), (1.15, 0.5), (0.4, 0.75), (-0.2, 0.6), (-0.7, 0.9), (-1.35, 0.7)]
        M = T((0.3, -0.2, hgt(0.3, -0.2) + 0.05), (24, -8, 30))
        mb.prism(outline, 0.2, 'concrete_broken', M @ T((0, 0, -0.1)), capcell='concrete_c')
        for k in range(6):
            t = k / 5
            p = M @ V((lerp(1.1, 1.3, t) - 0.05, lerp(-0.9, -0.2, t), 0))
            rebar(mb, p, (M.to_3x3() @ V((1, 0.1, 0))), r.uniform(0.3, 0.8), r, 1)

def b_rubble_a(mb):
    rubble(mb, 1.0, 0.65, 10, 51, 14, 5)
def b_rubble_b(mb):
    rubble(mb, 1.7, 1.0, 12, 52, 24, 8)
def b_rubble_c(mb):
    rubble(mb, 2.4, 1.5, 14, 53, 34, 12, slab=True)

def b_debris_slab(mb):
    """Broken floor slab ~2.7 x 1.9 x 0.2 m with jagged fracture edges and bent rebar, tilted on a chunk."""
    r = random.Random(61)
    outline = [(-1.35, -0.95), (1.35, -0.95), (1.35, -0.4), (1.1, -0.2), (1.25, 0.15), (0.95, 0.35), (1.05, 0.7),
               (0.6, 0.62), (0.3, 0.95), (-0.15, 0.78), (-0.55, 0.98), (-1.0, 0.8), (-1.35, 0.95)]
    M = T((0, 0, 0.26), (-9, 6, 0))
    mb.prism(outline, 0.2, 'concrete_broken', M @ T((0, 0, -0.1)), capcell='concrete_c')
    for k in range(len(outline)):
        a, b = outline[k], outline[(k + 1) % len(outline)]
        if k in (0, len(outline) - 1):
            continue
        for t in (0.3, 0.75):
            p = V((lerp(a[0], b[0], t), lerp(a[1], b[1], t), 0))
            out = V((b[1] - a[1], -(b[0] - a[0]), 0)).normalized()
            rebar(mb, M @ p, M.to_3x3() @ (out + V((0, 0, r.uniform(-0.4, 0.2)))), r.uniform(0.2, 0.6), r, 1)
    mb.chamfer_box((0.6, 0.5, 0.35), 0.05, 'concrete_broken', T((0.6, 0.4, 0.12), (0, 0, 20)), jitter=0.04, rng=r)
    mb.chamfer_box((0.4, 0.35, 0.25), 0.05, 'concrete_broken', T((-1.6, -0.6, 0.1), (10, 0, 50)), jitter=0.04, rng=r)

def b_burnt_tyre(mb):
    r = random.Random(71)
    s = sub(mb)
    tyre(s, T((0, 0, 0.07)), 0.33, 0.2, 14, cell='ash')
    s.deform(lambda p: V((p.x, p.y, p.z * (0.45 + 0.4 * (0.5 + 0.5 * math.sin(math.atan2(p.y, p.x) * 3 + 1))))))
    mb.merge(s)
    for k in range(7):
        a = r.uniform(0, 2 * math.pi)
        p = V((math.cos(a) * 0.3, math.sin(a) * 0.3, 0.05))
        mb.tube([p, p + V((math.cos(a) * 0.15, math.sin(a) * 0.15, 0.08)), p + V((math.cos(a + 0.5) * 0.3, math.sin(a + 0.5) * 0.3, 0.02))], 0.004, 'rust', sides=3)
    mb.quad((-0.85, -0.85, 0.008), (0.85, -0.85, 0.008), (0.85, 0.85, 0.008), (-0.85, 0.85, 0.008), 'soot')

def b_street_light(mb):
    """9 m galvanised octagonal street light with a cobra-head luminaire overhanging +Y."""
    mb.box((0.45, 0.45, 0.3), 'concrete_c', loc=(0, 0, 0.15), faces='xXyYZ')
    mb.lathe([(0.14, 0.3), (0.14, 0.75, 'S'), (0.11, 0.8), (0.055, 9.0)], 8, 'galv', a0=22.5, cap1=True, smooth=True)
    arm = [V((0, 0, 8.4)), V((0, 0.35, 8.8)), V((0, 0.9, 9.05)), V((0, 1.6, 9.12))]
    mb.tube(arm, 0.035, 'galv', sides=6, caps=True)
    mb.chamfer_box((0.26, 0.62, 0.14), 0.04, 'galv', T((0, 1.85, 9.08), (-5, 0, 0)))
    mb.box((0.18, 0.4, 0.02), 'lamp', T((0, 1.88, 9.0), (-5, 0, 0)), faces='z')
    mb.box((0.12, 0.05, 0.25), 'galv', loc=(0, 0.13, 1.1))

def b_power_pole(mb):
    """9 m tapered concrete pole with an 11 kV crossarm (3 pin insulators) and a LV crossarm (4). Empties
    wire_a ... wire_g mark the conductor seat on top of each insulator."""
    mb.lathe([(0.19, 0.0), (0.11, 9.0)], 4, 'concrete_c', a0=45, cap1=True, smooth=False, vrep=1)
    empties = {}
    names = iter('abcdefg')
    for z, L, xs in ((8.55, 2.3, (-1.0, -0.42, 1.0)), (7.75, 1.9, (-0.8, -0.27, 0.27, 0.8))):
        mb.box((L, 0.09, 0.1), 'galv_rust', loc=(0, 0.12, z))
        for sx in (-1, 1):
            mb.beam((sx * 0.06, 0.12, z - 0.65), (sx * L * 0.33, 0.12, z - 0.05), 0.04, 0.012, 'galv_rust')
        for x in xs:
            mb.bar((x, 0.12, z + 0.05), (x, 0.12, z + 0.12), 0.012, 'galv', 4)
            prof = [(0.025, 0.0), (0.065, 0.03), (0.07, 0.06), (0.045, 0.08), (0.055, 0.1), (0.035, 0.13), (0.0, 0.14)]
            mb.lathe([(p[0], p[1] + z + 0.1) for p in prof], 8, 'ceramic_brown', T((x, 0.12, 0)), cap0=True)
            empties['wire_' + next(names)] = (x, 0.12, z + 0.24)
    mb.box((0.25, 0.18, 0.35), 'grey_paint', loc=(0, 0.2, 3.2))
    return dict(empties=empties)

def b_transformer_box(mb):
    """Ground-mounted distribution transformer kiosk 1.4 x 0.9 x 1.45 m on a concrete plinth."""
    mb.box((1.6, 1.1, 0.15), 'concrete_c', loc=(0, 0, 0.075), faces='xXyYZ')
    mb.box((1.4, 0.9, 1.3), 'elec_box', loc=(0, 0, 0.8), faces='xXyY')
    mb.box((1.52, 1.02, 0.06), 'grey_paint', T((0, 0, 1.48)))
    for k in range(6):
        for sx in (-1, 1):
            mb.box((0.06, 0.02, 0.9), 'grey_paint', loc=(sx * (0.73), -0.3 + k * 0.12, 0.75), faces='xXyYZ')
    mb.bar((0.5, -0.3, 1.5), (0.5, -0.3, 1.75), 0.05, 'ceramic_brown', 8)

def b_kerb_barrier(mb):
    """Painted concrete kerb/ lane barrier block 1.5 m long, 0.45 m high (yellow-black)."""
    prof = [(-0.2, 0.0), (0.2, 0.0), (0.2, 0.06), (0.12, 0.45), (-0.12, 0.45), (-0.2, 0.06)]
    extrude_x(mb, prof, 1.5, lambda k: 'kerb_stripe' if k in (1, 2, 4, 5) else 'concrete_c', 'concrete_c')

def b_billboard_frame(mb):
    """Roadside billboard: 6 x 3 m panel on two steel columns (panel 4.5 - 7.5 m), catwalk and lamp arms."""
    for x in (-2.0, 2.0):
        mb.box((0.9, 0.9, 0.35), 'concrete_c', loc=(x, 0, 0.175), faces='xXyYZ')
        mb.box((0.25, 0.25, 7.6), 'galv_rust', loc=(x, 0, 3.8), faces='xXyYZ')
    mb.box((6.0, 0.12, 3.0), 'billboard', loc=(0, 0.25, 6.0), faces='Y')
    mb.box((6.0, 0.12, 3.0), 'galv_rust', loc=(0, 0.25, 6.0), faces='xXyzZ')
    for z in (4.75, 7.25):
        mb.box((6.0, 0.1, 0.1), 'galv_rust', loc=(0, 0.13, z))
    for x0 in (-3.0, 0.0):
        mb.beam((x0 + 0.1, 0.13, 4.8), (x0 + 2.9, 0.13, 7.2), 0.06, 0.06, 'galv_rust')
    mb.box((6.0, 0.8, 0.05), 'galv_rust', loc=(0, 0.75, 4.35))
    mb.box((6.0, 0.03, 0.03), 'galv_rust', loc=(0, 1.13, 5.35))
    for x in (-2.9, -1.5, 0, 1.5, 2.9):
        mb.bar((x, 1.13, 4.35), (x, 1.13, 5.35), 0.015, 'galv_rust', 4)
    for x in (-2.0, 0.0, 2.0):
        mb.tube([V((x, 1.1, 4.4)), V((x, 1.5, 4.9)), V((x, 1.6, 5.1))], 0.02, 'galv', sides=4)
        mb.box((0.3, 0.15, 0.1), 'steel_dark', T((x, 1.6, 5.12), (35, 0, 0)))

# ============================================================================================ military
def hesco_cell(mb, cx, sides, r, H=1.37, W=1.06):
    """One HESCO MIL1 cell (1.06 x 1.06 x 1.37 m): alpha-cut galvanised welded mesh on the outer faces, the tan
    geotextile liner bulging just behind it (pillows, creases and wires also baked into its texture), the liner
    rolled over the top edge, sand heaped slightly above the rim, coil hinges at the corners. sides: which outer
    faces get mesh + liner (x, X, y, Y); inner partitions of a wall are left out."""
    hw = W / 2
    h = H * r.uniform(0.985, 1.0)
    rim = h - 0.015
    faces = {'Y': (V((cx + hw, hw, 0)), V((-1, 0, 0))), 'y': (V((cx - hw, -hw, 0)), V((1, 0, 0))),
             'X': (V((cx + hw, -hw, 0)), V((0, 1, 0))), 'x': (V((cx - hw, hw, 0)), V((0, -1, 0)))}
    for k in sides:
        o, u = faces[k]
        n = u.cross(V((0, 0, 1)))                     # outward
        mb.quad(o + n * 0.004, o + u * W + n * 0.004, o + u * W + n * 0.004 + V((0, 0, h)), o + n * 0.004 + V((0, 0, h)), 'hesco_mesh')
        P = []
        for i in range(5):
            row = []
            for j in range(6):
                s_, t = i / 4, j / 5
                bul = 0.014 * math.sin(math.pi * s_) * math.sin(math.pi * min(1, t * 1.08)) + r.uniform(-0.002, 0.002) * (0 < i < 4) * (0 < j < 5)
                row.append(o + u * (W * s_) - n * (0.016 - bul) + V((0, 0, rim * t)))
            P.append(row)
        mb.surf(P, 'geotex')
        # liner rolled over the top edge and tucked in towards the sand
        a0 = o - n * 0.016; a1 = o + u * W - n * 0.016
        mb.quad(a0 + V((0, 0, rim)), a1 + V((0, 0, rim)), a1 - n * 0.07 + V((0, 0, rim + 0.02)), a0 - n * 0.07 + V((0, 0, rim + 0.02)), 'geotex', (0, 0.0, 1, 0.08))
    n = 5
    ex0 = -hw + (0.07 if 'x' in sides else 0.0); ex1 = hw - (0.07 if 'X' in sides else 0.0)
    P = [[V((cx + lerp(ex0, ex1, i / n), lerp(-hw + 0.07, hw - 0.07, j / n),
             rim + 0.02 + (0.085 * math.sin(math.pi * i / n) * math.sin(math.pi * j / n) + r.uniform(-0.015, 0.02)) * (0 < i < n) * (0 < j < n)))
          for j in range(n + 1)] for i in range(n + 1)]
    mb.surf(P, 'sand_fill')
    for sx in (-1, 1):
        for sy in (-1, 1):
            if ('x' if sx < 0 else 'X') in sides or ('y' if sy < 0 else 'Y') in sides:
                mb.bar((cx + sx * hw, sy * (hw + 0.004), 0), (cx + sx * hw, sy * (hw + 0.004), h), 0.009, 'galv', 5, caps=False)

def b_hesco_1(mb):
    hesco_cell(mb, 0.0, 'xXyY', random.Random(81))

def b_hesco_wall(mb):
    r = random.Random(82)
    for i in range(5):
        hesco_cell(mb, (i - 2) * 1.06, 'yY' + ('x' if i == 0 else '') + ('X' if i == 4 else ''), r)

def b_t_wall(mb):
    """Concrete T-wall (12 ft class): 3.6 m tall, 1.5 m long, 1.0 m deep base, with two lifting loops."""
    prof = [(-0.5, 0.0), (0.5, 0.0), (0.5, 0.25), (0.14, 0.42), (0.11, 3.6), (-0.11, 3.6), (-0.14, 0.42), (-0.5, 0.25)]
    extrude_x(mb, prof, 1.5, lambda k: 'twall' if k in (3, 5) else 'concrete_m', 'concrete_m', uvl=None)
    for x in (-0.42, 0.42):
        pts = [V((x + 0.11 * math.cos(a), 0, 3.6 + 0.11 * math.sin(a))) for a in np.linspace(0, math.pi, 5)]
        mb.tube(pts, 0.014, 'rust', sides=4)

def b_jersey_barrier(mb):
    """Concrete jersey barrier 3.0 m long, 0.81 m high, 0.61 m base."""
    prof = [(-0.305, 0.0), (0.305, 0.0), (0.305, 0.075), (0.25, 0.33), (0.075, 0.81), (-0.075, 0.81), (-0.25, 0.33), (-0.305, 0.075)]
    extrude_x(mb, prof, 3.0, 'concrete_m', 'concrete_m', uvl=1.5)

def b_sandbags_line(mb):
    """Curved row of sandbags, 3 layers, ~3.2 m along an arc of 3.5 m radius bulging to +Y."""
    r = random.Random(91)
    Rr = 3.5
    for layer in range(3):
        n = 6 if layer % 2 == 0 else 5
        span = 3.3 / Rr
        for i in range(n):
            t = (i + (0.5 if n == 5 else 0.0)) / 5.0 - 0.5 if n == 5 else i / 5.0 - 0.5
            a = t * span * (5 / 5.5)
            x, y = Rr * math.sin(a), Rr * math.cos(a) - Rr
            sandbag(mb, (x, y, 0.065 + layer * 0.125), -math.degrees(a), r)

def b_sandbag_bunker(mb):
    """Small sandbagged fighting position: horseshoe of bags (inner radius ~1 m) open to the rear (-Y), 6 layers,
    firing slit at the front, timber and plywood overhead cover with bags on top."""
    r = random.Random(92)
    Rr = 1.2
    gap = 70
    for layer in range(6):
        n = 10
        for i in range(n):
            a = math.radians(gap / 2 + (360 - gap) * (i + 0.5 * (layer % 2) + 0.25) / (n + 0.5))
            if layer == 4 and abs(math.degrees(a) - 180) < 20:
                continue
            x, y = Rr * math.sin(a), -Rr * math.cos(a)
            sandbag(mb, (x, y, 0.065 + layer * 0.125), -math.degrees(a) + 90, r)
    for x in (-0.55, 0.55):
        mb.box((0.1, 2.0, 0.1), 'timber', loc=(x, 0.35, 0.82))
    mb.box((1.7, 1.4, 0.02), 'plywood', loc=(0, 0.55, 0.885))
    for k, (x, y) in enumerate(((-0.4, 0.3), (0.3, 0.3), (-0.4, 0.75), (0.3, 0.75), (0, 0.52))):
        sandbag(mb, (x, y, 0.96 + (0.12 if k == 4 else 0)), 90 + r.uniform(-10, 10), r)

def b_guard_tower(mb):
    """FOB guard tower ~5.4 m: 4 timber legs with X bracing, plywood platform at 3.0 m with sandbagged plywood
    parapet, tin roof, ladder at the back. Empty 'post' on the platform floor where the sentry stands."""
    r = random.Random(93)
    zp = 3.0
    B, Tp = 1.3, 1.1     # half-widths at the base and at the platform
    for sx in (-1, 1):
        for sy in (-1, 1):
            mb.beam((sx * B, sy * B, 0), (sx * Tp, sy * Tp, zp), 0.15, 0.15, 'timber')
            mb.box((0.12, 0.12, 2.35), 'timber', loc=(sx * (Tp - 0.02), sy * (Tp - 0.02), zp + 1.2), faces='xXyYZ')
    for k in range(4):
        R4 = T(rot=(0, 0, 90 * k))
        for (z0, z1) in ((0.25, 1.6), (1.6, 2.9)):
            f0 = lerp(B, Tp, z0 / zp); f1 = lerp(B, Tp, z1 / zp)
            mb.beam(R4 @ V((-f0, f0, z0)), R4 @ V((f1, f1, z1)), 0.1, 0.04, 'timber', roll=math.pi / 2)
            mb.beam(R4 @ V((f0, f0, z0)), R4 @ V((-f1, f1, z1)), 0.1, 0.04, 'timber', roll=math.pi / 2)
        f = lerp(B, Tp, 1.6 / zp)
        mb.beam(R4 @ V((-f, f, 1.6)), R4 @ V((f, f, 1.6)), 0.1, 0.05, 'timber')
    mb.box((2.5, 2.5, 0.08), 'plywood', loc=(0, 0, zp + 0.04))
    for k in range(3):
        R4 = T(rot=(0, 0, 90 * (k - 1)))
        mb.box((2.5, 0.03, 1.05), 'plywood', R4 @ T((0, 1.24, zp + 0.08 + 0.525)))
        for layer in range(6):
            for i in range(4):
                x = -0.88 + i * 0.6 + (0.2 if layer % 2 else 0) - 0.1
                if x > 0.98:
                    continue
                sandbag(mb, R4 @ V((x, 1.05, zp + 0.08 + 0.065 + layer * 0.125)), 90 * (k - 1), r)
    mb.box((1.1, 0.03, 1.05), 'plywood', T((0.7, -1.24, zp + 0.6)))
    mb.box((2.9, 2.9, 0.04), 'plywood', T((0, 0, zp + 2.42), (5, 0, 0)))
    mb.box((3.0, 3.0, 0.015), 'tin', T((0, 0, zp + 2.455), (5, 0, 0)), faces='Z')
    for sx in (-0.25, 0.25):
        mb.beam((sx - 0.0, -1.75, 0), (sx, -1.18, zp + 0.1), 0.05, 0.08, 'timber')
    for k in range(9):
        t = (k + 0.7) / 10
        p = V((0, lerp(-1.75, -1.18, t), lerp(0, zp + 0.1, t)))
        mb.box((0.5, 0.05, 0.035), 'timber', loc=tuple(p))
    return dict(empties={'post': (0.0, 0.3, zp + 0.08)})

def b_tent_military(mb):
    """GP Medium tent 4.9 x 9.8 m (16 x 32 ft), 1.7 m walls, 3.0 m ridge with hip ends, door at +Y."""
    W, L, he, hr = 4.88, 9.75, 1.7, 3.0
    yr = L / 2 - W / 2
    nu = 8
    for sgn in (-1, 1):   # long roof slopes
        P = []
        for i in range(nu + 1):
            u = i / nu
            ye = lerp(-L / 2, L / 2, u); yrr = lerp(-yr, yr, u)
            row = []
            for j in range(4):
                v = j / 3
                p = V((lerp(sgn * W / 2, 0, v), lerp(ye, yrr, v), lerp(he, hr, v)))
                p.z -= 0.07 * math.sin(math.pi * v) * abs(math.sin(math.pi * u * 4))
                row.append(p)
            P.append(row if sgn < 0 else row)
        mb.surf(P if sgn > 0 else P[::-1], 'tent', urep=4, uv=(0, 0, 1, 1))
    for sgn in (-1, 1):   # hip ends
        P = []
        for i in range(5):
            u = i / 4
            row = [V((lerp(-W / 2, W / 2, u) * (1 - v), lerp(sgn * L / 2, sgn * yr, v), lerp(he, hr, v) - 0.05 * math.sin(math.pi * v) * math.sin(math.pi * u))) for v in (0, 1 / 3, 2 / 3, 1)]
            P.append(row)
        mb.surf(P if sgn < 0 else P[::-1], 'tent', urep=2)
    def wall(a, b, n, door=False):
        a, b = V(a), V(b)
        for i in range(n):
            if door and i in (n // 2 - 1, n // 2):
                p0 = a + (b - a) * (i / n); p1 = a + (b - a) * ((i + 1) / n)
                mb.quad(p0 + V((0, 0, 1.5)), p1 + V((0, 0, 1.5)), p1 + V((0, 0, he)), p0 + V((0, 0, he)), 'tent', (0, 0.88, 0.5, 1))
                continue
            p0 = a + (b - a) * (i / n); p1 = a + (b - a) * ((i + 1) / n)
            out = (b - a).cross(V((0, 0, 1))).normalized() * 0.12
            mb.quad(p0 + out, p1 + out, p1 + V((0, 0, he)), p0 + V((0, 0, he)), 'tent', (0, 0, 0.5, 0.75))
    wall((W / 2, -L / 2, 0), (W / 2, L / 2, 0), 6)
    wall((-W / 2, L / 2, 0), (-W / 2, -L / 2, 0), 6)
    wall((W / 2, L / 2, 0), (-W / 2, L / 2, 0), 4, door=True)
    wall((-W / 2, -L / 2, 0), (W / 2, -L / 2, 0), 4)
    mb.cyl(0.09, 1.25, 'canvas_tan', T((-0.62, L / 2 + 0.06, 1.42), (0, 90, 0)), 6)
    for y in (-yr, yr):
        mb.cyl(0.03, 0.25, 'wood_dark', T((0, y, hr - 0.02)), 5)
    for y in (-L / 2, -yr, 0, yr, L / 2):
        for sgn in (-1, 1):
            a = V((sgn * W / 2, y, he)); b = V((sgn * (W / 2 + 1.5), y, 0.05))
            mb.bar(a, b, 0.006, 'canvas_tan', 3, caps=False)
            mb.bar(b - V((0, 0, 0.1)), b + V((0, 0, 0.12)), 0.02, 'steel_dark', 4)

def b_camo_net(mb):
    """Desert camouflage net ~8 x 8 m draped over five poles (centre 3.2 m) and pegged near the ground."""
    r = random.Random(95)
    poles = [(0, 0, 3.0), (-2.2, -2.2, 2.55), (2.2, -2.2, 2.55), (-2.2, 2.2, 2.55), (2.2, 2.2, 2.55)]
    E = 4.0; n = 14
    def hgt(x, y):
        z = 0.0
        for px, py, ph in poles:
            d = max(0.0, math.hypot(x - px, y - py) - 0.35)
            z = max(z, ph - 0.12 * d - 0.07 * d * d)
        edge = min(E - abs(x), E - abs(y)) / 1.6
        e = min(1, max(0, edge))
        return max(0.05, z * (0.12 + 0.88 * e * (2 - e)))
    P = [[V((lerp(-E, E, i / n) + r.uniform(-0.05, 0.05), lerp(-E, E, j / n) + r.uniform(-0.05, 0.05), 0)) for j in range(n + 1)] for i in range(n + 1)]
    for row in P:
        for p in row:
            p.z = hgt(p.x, p.y) + r.uniform(-0.04, 0.04)
    mb.surf(P, 'camonet', urep=7, vrep=7)
    for px, py, ph in poles:
        mb.bar((px, py, 0), (px, py, ph - 0.03), 0.025, 'olive', 5)
        mb.cyl(0.18, 0.02, 'olive', T((px, py, ph - 0.05)), 6)

def b_flagpole(mb):
    """8 m flagpole on a concrete base. The flag is a separate child mesh 'flag' (US flag texture) so the game
    can swap/ hide it."""
    mb.box((0.6, 0.6, 0.3), 'concrete_c', loc=(0, 0, 0.15), faces='xXyYZ')
    mb.lathe([(0.06, 0.3), (0.035, 8.0)], 8, 'galv', cap1=True)
    mb.sphere(0.07, 'gold', T((0, 0, 8.06)), 8, 5)
    mb.bar((0.045, 0, 1.2), (0.045, 0, 7.95), 0.004, 'canvas_tan', 3)
    mb.box((0.03, 0.12, 0.03), 'galv', loc=(0.06, 0, 1.2))
    f = sub(mb)
    f.group = 'cloth'
    nx, ny = 8, 3
    P = [[V((0.05 + 1.52 * i / nx, 0.09 * math.sin(2 * math.pi * (i / nx) * 1.3) * (i / nx), 7.9 - 0.8 * j / ny - 0.12 * (i / nx) ** 2)) for j in range(ny + 1)] for i in range(nx + 1)]
    f.surf([row[::-1] for row in P], 'flag_us')
    return dict(children={'flag': f}, empties={'flag_top': (0.0, 0.0, 7.9)})

def b_conex(mb):
    """20 ft ISO container (6.058 x 2.438 x 2.591 m), desert tan with rust, corrugated walls, doors at +Y."""
    L, W, H = 6.058, 2.438, 2.591
    hw, hl = W / 2, L / 2
    pitch_n = 20; d = 0.036
    ys = []
    for i in range(pitch_n):
        y0 = lerp(-hl + 0.16, hl - 0.16, i / pitch_n); p = (L - 0.32) / pitch_n
        ys += [(y0, 0), (y0 + 0.3 * p, 0), (y0 + 0.5 * p, d), (y0 + 0.8 * p, d)]
    ys.append((hl - 0.16, 0))
    for sgn in (-1, 1):
        P = [[V((sgn * (hw - 0.01 - dd), y, z)) for z in (0.16, H - 0.16)] for y, dd in ys]
        if sgn < 0:
            P = P[::-1]
        mb.surf(P, 'conex_side', smooth=False, s=[k / (len(P) - 1) for k in range(len(P))])
    xs = []
    for i in range(8):
        x0 = lerp(-hw + 0.16, hw - 0.16, i / 8); p = (W - 0.32) / 8
        xs += [(x0, 0), (x0 + 0.3 * p, 0), (x0 + 0.5 * p, d), (x0 + 0.8 * p, d)]
    xs.append((hw - 0.16, 0))
    P = [[V((x, -hl + 0.01 + dd, z)) for z in (0.16, H - 0.16)] for x, dd in xs]
    mb.surf(P, 'conex_side', smooth=False, uv=(0, 0, 0.4, 1))
    mb.quad((-hw, -hl, H - 0.01), (hw, -hl, H - 0.01), (hw, hl, H - 0.01), (-hw, hl, H - 0.01), 'conex_side', (0, 0, 1, 0.45))
    for sx in (-1, 1):
        for sy in (-1, 1):
            mb.box((0.16, 0.16, H), 'tan_paint', loc=(sx * (hw - 0.08), sy * (hl - 0.08), H / 2), faces='xXyYZ')
        for z in (0.08, H - 0.08):
            mb.box((0.14, L - 0.32, 0.16), 'tan_paint', loc=(sx * (hw - 0.07), 0, z), faces='xXzZ')
    for sy in (-1, 1):
        for z in (0.08, H - 0.08):
            mb.box((W - 0.32, 0.14, 0.16), 'tan_paint', loc=(0, sy * (hl - 0.07), z), faces='yYzZ')
    for k, x in enumerate((-hw / 2 + 0.04, hw / 2 - 0.04)):
        mb.box((hw - 0.12, 0.04, H - 0.32), 'conex_door', loc=(x, hl - 0.03, H / 2), faces='Y', uv=(0.5 * k, 0, 0.5 * k + 0.5, 1))
    for x in (-0.95, -0.35, 0.35, 0.95):
        mb.bar((x, hl + 0.03, 0.12), (x, hl + 0.03, H - 0.12), 0.015, 'galv_rust', 5)
        mb.box((0.04, 0.08, 0.3), 'galv_rust', loc=(x + 0.06, hl + 0.06, 1.1), faces='xXyYZz')

def b_pallet(mb):
    """GMA wooden pallet 1.22 x 1.02 x 0.14 m."""
    for y in (-0.47, 0.0, 0.47):
        mb.box((1.22, 0.04, 0.09), 'wood_pallet', loc=(0, y, 0.061), uvscale=1.2, faces='xXyY')
    for k in range(7):
        x = lerp(-0.56, 0.56, k / 6)
        mb.box((0.09, 1.02, 0.016), 'wood_pallet', T((x, 0, 0.114)), uvscale=1.2, faces='xXyYZ')
    for x in (-0.56, 0.0, 0.56):
        mb.box((0.09, 1.02, 0.016), 'wood_pallet', T((x, 0, 0.008)), uvscale=1.2, faces='xXyYZ')

def b_crate_ammo(mb):
    """Stack of US M2A1 .50 cal ammunition cans (0.30 x 0.15 x 0.19 m each)."""
    r = random.Random(96)
    def can(x, y, z, yaw):
        M = T((x, y, z), (0, 0, yaw))
        mb.box((0.30, 0.15, 0.17), 'ammo_can', M @ T((0, 0, 0.085)), faces='yY')
        mb.box((0.30, 0.15, 0.17), 'od_green', M @ T((0, 0, 0.085)), faces='xX')
        mb.box((0.305, 0.155, 0.025), 'od_green', M @ T((0, 0, 0.18)), faces='xXyYZ')
        mb.box((0.12, 0.02, 0.012), 'steel_dark', M @ T((0, 0, 0.198)), faces='xXyYZ')
        mb.box((0.02, 0.05, 0.06), 'od_green', M @ T((0.158, 0, 0.15)), faces='xXyYZ')
    for layer in range(2):
        for i in range(3):
            for j in range(2):
                can(-0.31 + i * 0.31, -0.08 + j * 0.16, layer * 0.195, r.uniform(-2, 2))
    can(-0.15, 0.0, 0.39, 6)
    can(0.2, 0.02, 0.39, -4)

def b_wire_concertina(mb):
    """Single concertina coil (razor wire) ~5 m long, 0.9 m diameter, on three U-pickets."""
    r = random.Random(97)
    loops = 16; seg = 12; n = loops * seg; R = 0.45
    for helix, (sgn, ph) in enumerate(((1, 0.0), (-1, 0.5))):
        pts = []
        for k in range(n + 1):
            t = k / n
            a = sgn * 2 * math.pi * loops * t + ph
            rr = R * (1 + 0.04 * math.sin(k * 0.7 + helix))
            pts.append(V((-2.5 + 5 * t + 0.06 * math.sin(a), rr * math.cos(a), R * 0.95 + rr * 0.95 * math.sin(a))))
        radial = [V((0, p.y, p.z - R * 0.95)).normalized() * 0.035 for p in pts]
        mb.ribbon([p - q for p, q in zip(pts, radial)], [p + q for p, q in zip(pts, radial)], 'razor', urep=loops * 2)
        if helix == 0:
            mb.ribbon([p - V((0.03, 0, 0)) for p in pts], [p + V((0.03, 0, 0)) for p in pts], 'razor', urep=loops * 2)
    for x in (-2.4, 0.0, 2.4):
        mb.box((0.04, 0.03, 1.0), 'olive', loc=(x, -0.48, 0.45), faces='xXyYZ')

def b_floodlight_tower(mb):
    """Trailer-mounted light tower: 2.2 m trailer, outriggers, 3-stage mast to 8.6 m, four lamp heads."""
    mb.box((1.2, 2.2, 0.85), 'tan_paint', loc=(0, -0.2, 0.85))
    mb.box((1.22, 0.6, 0.3), 'gen_panel', loc=(0, 0.3, 0.9), faces='X')
    for x in (-0.72, 0.72):
        tyre(mb, T((x, -0.15, 0.32), (0, 90, 0)), 0.32, 0.18)
        mb.cyl(0.14, 0.14, 'grey_paint', T((x - 0.07 * (1 if x > 0 else -1) - 0.07, -0.15, 0.32), (0, 90, 0)), 10)
    for sx in (-1, 1):
        mb.beam((sx * 0.5, 0.85, 0.55), (0, 1.9, 0.5), 0.07, 0.07, 'tan_paint')
    mb.bar((0, 1.75, 0.55), (0, 1.75, 0.05), 0.03, 'steel_dark', 5)
    for sx in (-1, 1):
        for sy in (-1, 1):
            a = V((sx * 0.55, -0.2 + sy * 1.0, 0.5)); b = V((sx * 1.35, -0.2 + sy * 1.45, 0.5))
            mb.beam(a, b, 0.08, 0.08, 'yellow_paint')
            mb.bar(b, b - V((0, 0, 0.48)), 0.03, 'steel_dark', 5)
            mb.box((0.2, 0.2, 0.03), 'steel_dark', loc=(b.x, b.y, 0.015))
    mb.lathe([(0.10, 1.27), (0.10, 4.2, 'S'), (0.08, 4.2), (0.08, 6.5, 'S'), (0.065, 6.5), (0.065, 8.6)], 8, 'galv', T((0, -1.05, 0)), cap1=True)
    mb.box((1.6, 0.08, 0.08), 'galv', loc=(0, -1.05, 8.62))
    for x in (-0.6, -0.2, 0.2, 0.6):
        M = T((x, -0.95, 8.75), (-20, 0, 0))
        mb.box((0.36, 0.14, 0.3), 'steel_dark', M, faces='xXyzZ')
        mb.box((0.36, 0.14, 0.3), 'lamp', M, faces='Y')

# ============================================================================================ insurgent caches
def b_cache_crate(mb):
    """Weapon cache ~1.6 x 1.0 x 1.2 m: stacked olive ammunition crates with Cyrillic-style stencils, an open crate
    of PG-7 rockets, AK rifles leaning and lying on top, an olive tarp half-covering the stack."""
    r = random.Random(101)
    boxes = []
    def crate(size, x, y, z, yaw, side='crate_ru', open_top=False):
        ru_crate(mb, size, T((x, y, z), (0, 0, yaw)), side, open_top=open_top)
        boxes.append((x - size[0] / 2, x + size[0] / 2, y - size[1] / 2, y + size[1] / 2, z + size[2]))
    crate((1.05, 0.46, 0.36), -0.25, 0.24, 0.0, 0)
    crate((1.05, 0.46, 0.36), -0.25, -0.24, 0.0, 1)
    crate((0.44, 0.92, 0.30), 0.55, 0.0, 0.0, 0, side='crate_ru2')
    crate((0.88, 0.42, 0.32), -0.3, -0.21, 0.36, 3)
    crate((0.98, 0.44, 0.28), -0.24, 0.25, 0.36, -2, open_top=True)
    for k in range(4):
        rpg_round(mb, T((-0.24, 0.25 + (k - 1.5) * 0.092, 0.475), (0, 0, -92)) @ T((0, -0.465, 0)))
    for k in range(3):
        rpg_round(mb, T((-0.2, 0.25 + (k - 1) * 0.092, 0.555), (0, 0, -88)) @ T((0, -0.465, 0)))
    crate((0.52, 0.36, 0.24), -0.45, -0.2, 0.68, 5, side='crate_ru')
    crate((0.48, 0.32, 0.22), -0.42, -0.18, 0.92, 12, side='crate_ru2')
    crate((0.48, 0.32, 0.22), 0.5, -0.15, 0.30, -3, side='crate_wood')
    ak(mb, T((-0.2, -0.16, 1.165), (0, 90, 95)))
    for k, x in enumerate((-0.66, 0.14)):
        ak(mb, T((x, 0.71, 0.42), (110, 0, 8 - 14 * k)) @ T(rot=(0, 90 if k else -90, 0)))
    rpg_round(mb, T((0.5, -0.12, 0.565), (0, 90, -86)) @ T((0, -0.465, 0)))
    tarp(mb, -0.92, 0.25, -0.62, 0.02, 10, 7, boxes, 'tarp_olive', r)

def b_cache_crate_b(mb):
    """Weapon cache variant ~1.5 x 1.1 x 1.0 m: natural wood and green crates, open crate of 82 mm mortar bombs,
    RPG-7 launcher and rockets on top, blue tarp thrown over the back."""
    r = random.Random(102)
    boxes = []
    def crate(size, x, y, z, yaw, side='crate_wood', open_top=False):
        ru_crate(mb, size, T((x, y, z), (0, 0, yaw)), side, open_top=open_top)
        boxes.append((x - size[0] / 2, x + size[0] / 2, y - size[1] / 2, y + size[1] / 2, z + size[2]))
    crate((0.95, 0.5, 0.34), -0.25, -0.25, 0.0, 2)
    crate((0.95, 0.5, 0.34), -0.25, 0.28, 0.0, -2, side='crate_ru2')
    crate((0.5, 0.5, 0.4), 0.5, -0.2, 0.0, 6)
    crate((0.6, 0.4, 0.26), 0.45, 0.32, 0.0, 0, open_top=True)
    for k in range(6):
        x = 0.45 + (k % 3 - 1) * 0.17; y = 0.32 + (k // 3 - 0.5) * 0.17
        s = sub(mb)
        s.lathe([(0.0, 0.0), (0.03, 0.02), (0.041, 0.09), (0.038, 0.16), (0.02, 0.22), (0.012, 0.23, 'S'), (0.012, 0.36), (0.0, 0.37)], 7, 'od_green')
        mb.merge(s, T((x, y, 0.06), (0, 0, 0)))
    crate((0.85, 0.42, 0.3), -0.3, 0.0, 0.34, 5, side='crate_ru')
    rpg7(mb, T((-0.3, 0.05, 0.71), (0, 0, 70)))
    rpg_round(mb, T((0.45, -0.2, 0.42), (0, 0, 10)) @ T((0, -0.45, 0)))
    rpg_round(mb, T((0.55, -0.15, 0.45), (0, 0, 15)) @ T((0, -0.45, 0)))
    ak(mb, T((0.25, -0.76, 0.41), (70, 0, 6)) @ T(rot=(0, 90, 0)))
    tarp(mb, -0.85, 0.0, -0.65, 0.65, 8, 9, boxes, 'tarp_blue', r)

# ============================================================================================ religious / architecture
def crescent(mb, M, R=0.17):
    outer = [(R * math.cos(a), R * math.sin(a)) for a in np.linspace(math.radians(-90 - 140), math.radians(-90 + 140), 13)]
    inner = [(0.85 * R * math.cos(a), 0.42 * R + 0.85 * R * math.sin(a)) for a in np.linspace(math.radians(-90 + 128), math.radians(-90 - 128), 11)]
    mb.prism(outer + inner, R * 0.18, 'gold', M @ T((0, R * 0.09, 0), (90, 0, 0)))

def finial(mb, z, s=1.0):
    """Alem: rod, stacked gilded balls, crescent opening upwards (faces +Y)."""
    mb.lathe([(0.16 * s, z), (0.1 * s, z + 0.15 * s), (0.03 * s, z + 0.2 * s)], 10, 'gold', cap0=True)
    mb.bar((0, 0, z + 0.15 * s), (0, 0, z + 1.3 * s), 0.025 * s, 'gold', 6)
    mb.sphere(0.13 * s, 'gold', T((0, 0, z + 0.35 * s)), 10, 6)
    mb.sphere(0.1 * s, 'gold', T((0, 0, z + 0.68 * s)), 10, 6)
    crescent(mb, T((0, 0, z + 1.12 * s)), 0.2 * s)

def b_minaret(mb):
    """~29.5 m minaret: square ashlar plinth and brick base with crenellations, tapering brick shaft with tile and
    kufic bands, muqarnas corbel carrying a balcony (sherefe) with openwork balustrade at ~20 m, slimmer upper
    shaft with a loudspeaker cluster, turquoise onion cap and gilded crescent finial."""
    mb.box((4.4, 4.4, 0.6), 'sandstone', loc=(0, 0, 0.3), faces='Z')
    for k in range(4):
        R4 = T(rot=(0, 0, 90 * k))
        tiled(mb, R4 @ V((2.2, -2.2, 0)), R4.to_3x3() @ V((0, 4.4, 0)), V((0, 0, 0.6)), 4, 1, 'sandstone')
        tiled(mb, R4 @ V((1.9, -1.9, 0.6)), R4.to_3x3() @ V((0, 3.8, 0)), V((0, 0, 6.4)), 3, 5, 'brick_y')
        tiled(mb, R4 @ V((1.93, -1.9, 6.15)), R4.to_3x3() @ V((0, 3.8, 0)), V((0, 0, 0.6)), 3, 1, 'kufic')
        for i in range(6):
            y = -1.75 + i * 0.7
            mb.box((0.25, 0.42, 0.5), 'brick_y', R4 @ T((1.92, y, 7.45)), faces='xXyYZ', uv=(0, 0, 0.4, 0.4))
    mb.box((4.1, 4.1, 0.25), 'sandstone', loc=(0, 0, 7.075), faces='xXyYZ')
    mb.box((1.9, 0.05, 3.2), 'spandrel', loc=(0, 1.92, 2.2), faces='xXYZ')
    mb.box((1.3, 0.05, 2.5), 'door', loc=(0, 1.95, 1.85), faces='Y')
    S = 28
    band(mb, 1.85, 1.85, 7.2, 7.75, 'sandstone', 8, 4, a0=22.5, smooth=False)
    ring_face(mb, 1.45, 1.85, 7.75, 'sandstone', 8, a0=22.5)
    rr = lambda z: lerp(1.45, 1.25, (z - 7.75) / (18.6 - 7.75))
    for z0, z1, cell, ur, tv in ((7.75, 10.4, 'brick_y', 7, 1.3), (10.4, 11.7, 'brick_win', 4, None), (11.7, 13.5, 'brick_y', 7, 1.3),
                                 (13.5, 14.0, 'tile_band', 4, None), (14.0, 17.4, 'brick_y', 7, 1.2), (17.4, 18.0, 'kufic', 4, None), (18.0, 18.6, 'brick_y', 7, None)):
        off = 0.04 if cell in ('tile_band', 'kufic') else 0.0
        band(mb, rr(z0) + off, rr(z1) + off, z0, z1, cell, S, ur, tv)
        if off:
            ring_face(mb, rr(z1), rr(z1) + off, z1, 'sandstone', S)
            ring_face(mb, rr(z0), rr(z0) + off, z0, 'sandstone', S, up=False)
    mb.lathe([(1.25, 18.6), (1.42, 18.68), (1.42, 18.98, 'S'), (1.68, 19.06), (1.68, 19.36, 'S'), (1.95, 19.44), (1.95, 19.78)], S, 'muqarnas', urep=4)
    mb.lathe([(1.95, 19.78), (2.18, 19.82), (2.18, 20.0, 'S'), (1.0, 20.0)], S, 'sandstone', smooth=True)
    mb.lathe([(2.1, 20.0), (2.1, 21.0)], S, 'lattice', urep=4)
    mb.lathe([(2.05, 21.0), (2.17, 21.0, 'S'), (2.17, 21.1, 'S'), (2.05, 21.1, 'S'), (2.05, 21.0)], S, 'sandstone', smooth=False)
    S2 = 20
    band(mb, 1.0, 0.985, 20.0, 21.5, 'brick_y', S2, 5, 1.5)
    band(mb, 0.985, 0.97, 21.5, 22.6, 'brick_win', S2, 4)
    band(mb, 0.97, 0.96, 22.6, 23.8, 'brick_y', S2, 5)
    band(mb, 1.0, 1.0, 23.8, 24.3, 'tile_band', S2, 4)
    band(mb, 0.96, 0.95, 24.3, 25.0, 'brick_y', S2, 5)
    mb.box((0.7, 0.04, 1.9), 'door', loc=(0, 0.99, 20.95), faces='Y')
    for k in range(4):
        a = math.radians(45 + 90 * k)
        d = V((math.cos(a), math.sin(a), -0.18)).normalized()
        base = V((math.cos(a) * 1.0, math.sin(a) * 1.0, 22.9))
        mb.bar(base - V((math.cos(a), math.sin(a), 0)) * 0.05, base + d * 0.25, 0.02, 'steel_dark', 4)
        Mh = look(base + d * 0.22, base + d * 0.7)
        mb.lathe([(0.05, 0.0), (0.08, 0.2), (0.21, 0.46)], 8, 'grey_paint', Mh, cap0=True)
        mb.lathe([(0.205, 0.455), (0.06, 0.25)], 8, 'steel_dark', Mh)
    mb.lathe([(0.95, 25.0), (1.1, 25.12), (1.1, 25.3, 'S'), (1.28, 25.4)], S2, 'muqarnas', urep=2)
    mb.lathe([(1.28, 25.4), (1.3, 25.55, 'S'), (0.8, 25.55)], S2, 'sandstone')
    band(mb, 0.8, 0.8, 25.55, 26.25, 'kufic', S2, 4)
    mb.lathe([(0.92, 26.25), (1.0, 26.55), (0.96, 26.95), (0.78, 27.4), (0.45, 27.9), (0.18, 28.3), (0.0, 28.55)], 24, 'dome_tile', urep=8, cap0=True)
    finial(mb, 28.45, 1.0)

def b_dome_large(mb):
    """Mosque dome 12 m diameter: windowed drum (2.8 m), cornice, slightly pointed turquoise tiled dome with
    arabesque gores, gilded finial. Origin at the drum base (sits on the prayer hall roof); total ~12 m high."""
    S = 48
    R = 6.0
    band(mb, R, R, 0.0, 2.8, 'drum', S, 16)
    mb.lathe([(R, 2.8), (R + 0.22, 2.9), (R + 0.22, 3.1, 'S'), (R - 0.05, 3.12)], S, 'sandstone', smooth=False)
    c = 0.22 * R; rho = R - 0.05 + c
    phia = math.acos(c / rho)
    prof = [(-c + rho * math.cos(phia * k / 12), 3.12 + rho * math.sin(phia * k / 12)) for k in range(13)]
    prof[-1] = (0.0, prof[-1][1])
    mb.lathe(prof, S, 'dome_tile', urep=16)
    finial(mb, prof[-1][1] - 0.1, 2.0)

def b_dome_small(mb):
    """Small plaster dome 4 m diameter on a 0.8 m windowed drum (for shrines, gate houses, ablution blocks)."""
    S = 24; R = 2.0
    band(mb, R + 0.05, R + 0.05, 0.0, 0.8, 'drum', S, 8)
    mb.lathe([(R + 0.05, 0.8), (R + 0.15, 0.86), (R + 0.15, 0.95, 'S'), (R, 0.96)], S, 'plaster_d', smooth=False)
    prof = [(R * math.cos(a), 0.96 + R * 1.05 * math.sin(a)) for a in np.linspace(0, math.pi / 2, 9)]
    prof[-1] = (0.0, prof[-1][1])
    mb.lathe(prof, S, 'plaster_d', urep=4)
    finial(mb, prof[-1][1] - 0.05, 0.8)

def b_arch_gate(mb):
    """Decorative gateway 6 m wide, 7.3 m high, 1.2 m deep: pointed arch 3.4 m wide (springing 3.6 m, apex
    5.4 m), tiled spandrels, kufic frieze, cornice and stepped merlons."""
    Wt, Ht, D = 6.0, 6.4, 1.2
    a, zs = 1.7, 3.6
    c = 0.25 * 2 * a; rho = a + c
    phia = math.acos(c / rho)
    N = 8
    arch = [(-(rho * math.cos(phia * k / N) - c), zs + rho * math.sin(phia * k / N)) for k in range(N + 1)]
    arch = arch + [(-x, z) for x, z in arch[::-1][1:]]
    for sgn in (1, -1):
        y = sgn * D / 2
        for xs in ((-Wt / 2, -a), (a, Wt / 2)):
            x0, x1 = xs
            if sgn > 0:
                tiled(mb, (x1, y, 0), (x0 - x1, 0, 0), (0, 0, Ht), 1, 5, 'sandstone')
            else:
                tiled(mb, (x0, y, 0), (x1 - x0, 0, 0), (0, 0, Ht), 1, 5, 'sandstone')
        for k in range(len(arch) - 1):
            (xa, za), (xb, zb) = arch[k], arch[k + 1]
            pts = [(xa, y, za), (xb, y, zb), (xb, y, Ht), (xa, y, Ht)]
            uvs = [((x + a) / (2 * a), (z - zs) / (Ht - zs)) for x, _, z in pts]
            if sgn > 0:
                pts = pts[::-1]; uvs = uvs[::-1]
            mb.poly(pts, uvs, 'spandrel')
        # tile trim following the arch, slightly proud
        inner = [V((x, y + sgn * 0.03, z)) for x, z in arch]
        outer = []
        for k, (x, z) in enumerate(arch):
            p0 = V(arch[max(0, k - 1)] + (0,)); p1 = V(arch[min(len(arch) - 1, k + 1)] + (0,))
            t = (p1 - p0).normalized(); n = V((-t.y, t.x, 0))
            outer.append(V((x + n.x * 0.28, y + sgn * 0.03, z + n.y * 0.28)))
        if sgn > 0:
            mb.ribbon(outer, inner, 'tile_band', urep=4)
        else:
            mb.ribbon(inner, outer, 'tile_band', urep=4)
        fy = y + sgn * 0.02
        if sgn > 0:
            tiled(mb, (Wt / 2, fy, 5.85), (-Wt, 0, 0), (0, 0, 0.5), 3, 1, 'kufic')
        else:
            tiled(mb, (-Wt / 2, fy, 5.85), (Wt, 0, 0), (0, 0, 0.5), 3, 1, 'kufic')
        for px in (-2.35, 2.35):
            if sgn > 0:
                mb.quad((px + 0.4, fy, 0.9), (px - 0.4, fy, 0.9), (px - 0.4, fy, 3.2), (px + 0.4, fy, 3.2), 'spandrel')
            else:
                mb.quad((px - 0.4, fy, 0.9), (px + 0.4, fy, 0.9), (px + 0.4, fy, 3.2), (px - 0.4, fy, 3.2), 'spandrel')
    for k in range(len(arch) - 1):
        (xa, za), (xb, zb) = arch[k], arch[k + 1]
        mb.quad((xa, D / 2, za), (xb, D / 2, zb), (xb, -D / 2, zb), (xa, -D / 2, za), 'sandstone', (0, 0, 1, 0.3))
    for sx in (-1, 1):
        x = sx * a
        if sx < 0:
            tiled(mb, (x, -D / 2, 0), (0, D, 0), (0, 0, zs), 1, 3, 'sandstone')
            tiled(mb, (-Wt / 2, D / 2, 0), (0, -D, 0), (0, 0, Ht), 1, 5, 'sandstone')
        else:
            tiled(mb, (x, D / 2, 0), (0, -D, 0), (0, 0, zs), 1, 3, 'sandstone')
            tiled(mb, (Wt / 2, -D / 2, 0), (0, D, 0), (0, 0, Ht), 1, 5, 'sandstone')
    mb.box((Wt + 0.4, D + 0.3, 0.3), 'sandstone', loc=(0, 0, Ht + 0.15), faces='xXyYZ')
    for i in range(7):
        x = -2.7 + i * 0.9
        mb.box((0.5, D, 0.35), 'sandstone', loc=(x, 0, Ht + 0.475), faces='xXyYZ', uv=(0, 0, 0.5, 0.3))
        mb.box((0.28, D, 0.25), 'sandstone', loc=(x, 0, Ht + 0.775), faces='xXyYZ', uv=(0, 0, 0.3, 0.2))

def b_fountain_basin(mb):
    """Octagonal courtyard fountain 3.4 m across: ashlar wall, tiled inside, water, central pedestal bowl."""
    a0 = 22.5
    ro = 1.5 / math.cos(math.radians(22.5))
    mb.lathe([(ro, 0.0), (ro, 0.5)], 8, 'sandstone', a0=a0, urep=8, smooth=False)
    mb.lathe([(ro, 0.5), (ro + 0.08, 0.52, 'S'), (ro + 0.08, 0.62, 'S'), (ro - 0.3, 0.62, 'S'), (ro - 0.3, 0.55)], 8, 'sandstone', a0=a0, smooth=False)
    mb.lathe([(ro - 0.3, 0.55), (ro - 0.3, 0.38)], 8, 'mosaic', a0=a0, urep=8, smooth=False)
    pts = [((ro - 0.3) * math.cos(math.radians(a0 + 45 * k)), (ro - 0.3) * math.sin(math.radians(a0 + 45 * k)), 0.42) for k in range(8)]
    mb.poly(pts, [(0.5 + 0.5 * math.cos(math.radians(a0 + 45 * k)), 0.5 + 0.5 * math.sin(math.radians(a0 + 45 * k))) for k in range(8)], 'water')
    mb.lathe([(0.35, 0.42), (0.3, 0.5), (0.18, 0.6), (0.15, 1.0), (0.25, 1.05), (0.6, 1.15), (0.62, 1.22, 'S'), (0.55, 1.24, 'S'), (0.5, 1.2)], 16, 'sandstone')
    mb.lathe([(0.5, 1.19), (0.0, 1.19)], 16, 'water', smooth=False)
    mb.lathe([(0.08, 1.15), (0.06, 1.35), (0.1, 1.4), (0.0, 1.5)], 8, 'sandstone')

# ============================================================================================ interior kit (group 'home')
# Furnishing for the procedural buildings: lived-in Iraqi homes c. 2004 (majlis cushions, worn sofas, CRT TV,
# Persian rugs, metal beds, enamel cookers, clutter). +Y faces into the room; wall-mounted pieces put y = 0 on the wall.
def p_rug(w, h, rng):
    """Persian-style rug 3 x 2 m: madder-red field with scattered motifs, stepped central medallion, ivory and navy
    borders with a running motif, corner spandrels, worn/ faded traffic areas and dust."""
    r = R(rng)
    yy, xx = np.mgrid[0:h, 0:w] + 0.5
    X = (xx // 2) * 2 / w; Y = (yy // 2) * 2 / h            # knotted (stepped) look
    red, navy, ivory, gold, teal = map(np.array, ((0.50, 0.10, 0.09), (0.10, 0.13, 0.28), (0.82, 0.75, 0.60), (0.75, 0.55, 0.22), (0.18, 0.35, 0.36)))
    c = col(red, h, w)
    bx = np.minimum(X, 1 - X) * (w / h); by = np.minimum(Y, 1 - Y)
    d = np.minimum(bx, by)
    c[d < 0.17] = navy
    c[(d > 0.035) & (d < 0.045)] = ivory; c[(d > 0.155) & (d < 0.17)] = ivory
    # running motif in the main border
    t = np.where(bx < by, Y * h / w, X) * 18
    mot = (np.abs((t % 1) - 0.5) + np.abs((d - 0.1) / 0.05) * 0.5) < 0.35
    c[(d > 0.05) & (d < 0.15) & mot] = gold
    c[(d > 0.05) & (d < 0.15) & mot & ((np.abs((t % 1) - 0.5) + np.abs((d - 0.1) / 0.05) * 0.5) < 0.15)] = red
    cx, cy = X - 0.5, Y - 0.5
    for s, cc in ((0.30, navy), (0.25, ivory), (0.21, red), (0.15, gold), (0.10, navy), (0.05, ivory)):
        m = np.abs(cx) * (w / h) / (s * 1.5) + np.abs(cy) / s < 1
        c[m & (d > 0.17)] = cc
    for sx in (0, 1):            # corner spandrels
        for sy in (0, 1):
            m = (np.abs(X - sx) * (w / h) + np.abs(Y - sy)) < 0.42
            c[m & (d > 0.17) & ~((np.abs(X - sx) * (w / h) + np.abs(Y - sy)) < 0.38)] = ivory
            c[((np.abs(X - sx) * (w / h) + np.abs(Y - sy)) < 0.38) & (d > 0.17)] = navy
    fm = (d > 0.19) & ~((np.abs(cx) * (w / h) / 0.45 + np.abs(cy) / 0.3) < 1)
    for _ in range(70):
        px, py = r.uniform(0.1, 0.9) * w, r.uniform(0.1, 0.9) * h
        if not fm[int(py), int(px)]:
            continue
        cc = r.choice((ivory, gold, teal, navy))
        fill_poly(c, None, [(px - 6, py), (px, py + 6), (px + 6, py), (px, py - 6)], cc, ss=1)
        disc(c, None, (px, py), 1.8, red)
    pile = fbm(h, w, rng, 3, 2)
    c = c * (0.85 + 0.25 * pile[..., None])
    wear = fbm(h, w, rng, 60, 3)
    c = mix(c, c * 0.7 + np.array((0.25, 0.2, 0.15)), np.clip((wear - 0.5) * 1.6, 0, 0.6))
    c = grime(c, rng, 0.2, 40)
    return dict(rgb=c, rough=1.0)
A.cell('rug_persian', 'home', 512, 336, p_rug)

def p_kilim(w, h, rng):
    yy, xx = np.mgrid[0:h, 0:w] + 0.5
    pal = [np.array(c) for c in ((0.55, 0.12, 0.08), (0.80, 0.45, 0.12), (0.10, 0.08, 0.07), (0.82, 0.76, 0.62), (0.20, 0.30, 0.45))]
    band = ((yy / h) * 9).astype(int)
    c = np.zeros((h, w, 3))
    for k in range(9):
        c[band == k] = pal[(k * 2) % 5]
    lz = (np.abs(((xx / w) * 8) % 1 - 0.5) + np.abs(((yy / h) * 9) % 1 - 0.5)) < 0.32
    c[lz & (band % 2 == 1)] = pal[3]
    c[lz & (band % 2 == 0)] = pal[0]
    c = c * (0.85 + 0.25 * fbm(h, w, rng, 3, 2)[..., None])
    c = grime(c, rng, 0.3, 30)
    return dict(rgb=c, rough=1.0)
A.cell('kilim', 'home', 256, 128, p_kilim)

def p_cushion(w, h, rng):
    """Majlis cushion cloth (Sadu-like weave): maroon ground, black/ ivory/ orange bands with triangles and diamonds
    running along u."""
    yy, xx = np.mgrid[0:h, 0:w] + 0.5
    v = yy / h; u = xx / w
    c = col((0.48, 0.08, 0.08), h, w)
    for y0, y1, cc in ((0.0, 0.08, (0.08, 0.07, 0.07)), (0.92, 1.0, (0.08, 0.07, 0.07)), (0.30, 0.70, (0.10, 0.08, 0.08))):
        c[(v >= y0) & (v < y1)] = cc
    tri = (np.abs((u * 16) % 1 - 0.5) * 2 * 0.4 + 0.3) > v
    c[tri & (v > 0.08) & (v < 0.30)] = (0.80, 0.50, 0.12)
    tri2 = (1 - (np.abs((u * 16) % 1 - 0.5) * 2 * 0.4 + 0.3)) < v
    c[tri2 & (v > 0.70) & (v < 0.92)] = (0.80, 0.50, 0.12)
    dm = (np.abs((u * 10) % 1 - 0.5) * 2 + np.abs(v - 0.5) / 0.2) < 1
    c[dm & (v > 0.3) & (v < 0.7)] = (0.85, 0.80, 0.68)
    c[(np.abs((u * 10) % 1 - 0.5) * 2 + np.abs(v - 0.5) / 0.2) < 0.45] = (0.48, 0.08, 0.08)
    c = c * (0.85 + 0.22 * fbm(h, w, rng, 2, 2)[..., None])
    c = mix(c, np.array((0.55, 0.45, 0.38)), 0.3 * fbm(h, w, rng, 40, 3))
    return dict(rgb=c, rough=1.0)
A.cell('cushion', 'home', 256, 128, p_cushion)

def p_sofa(w, h, rng):
    """Worn velour upholstery: olive-brown with a faint damask flower repeat, shiny worn patches."""
    r = R(rng)
    c = col((0.30, 0.25, 0.15), h, w) * (0.9 + 0.15 * fbm(h, w, rng, 3, 2)[..., None])
    for j in range(3):
        for i in range(3):
            cx, cy = (i + 0.5 * (j % 2)) * w / 3 + 10, (j + 0.5) * h / 3
            for a in np.linspace(0, 2 * math.pi, 7)[:-1]:
                seg(c, None, (cx, cy), (cx + math.cos(a) * 15, cy + math.sin(a) * 15), 3.5, 1.0, (0.38, 0.31, 0.19))
            disc(c, None, (cx, cy), 4, (0.42, 0.33, 0.18))
    c = mix(c, np.array((0.52, 0.47, 0.38)), 0.4 * np.clip(fbm(h, w, rng, 30, 3) - 0.45, 0, 1) * 2)
    return dict(rgb=c, rough=0.95)
A.cell('sofa', 'home', 128, 128, p_sofa)

def p_ticking(w, h, rng):
    xx = np.arange(w)[None, :]
    c = col((0.86, 0.84, 0.78), h, w)
    st = (xx % 16) < 3
    c[np.broadcast_to(st, (h, w))] = (0.25, 0.32, 0.50)
    c = c * (0.9 + 0.12 * fbm(h, w, rng, 4, 2)[..., None])
    stain = fbm(h, w, rng, 30, 3)
    c = mix(c, np.array((0.62, 0.52, 0.32)), np.clip((stain - 0.6) * 3, 0, 0.7))
    return dict(rgb=c, rough=1.0)
A.cell('ticking', 'home', 128, 128, p_ticking)

def p_wood_furn(base=(0.30, 0.18, 0.09), scuffs=60):
    """Varnished furniture wood: grain, darker edges, light scuffs and scratches, dust."""
    def p(w, h, rng):
        r = R(rng)
        g = fbm(h, w, rng, 3, 3, aspect=14)
        c = col(base, h, w) * (0.72 + 0.45 * g[..., None])
        for _ in range(scuffs):
            x, y = r.uniform(0, w), r.uniform(0, h); a = r.uniform(-0.5, 0.5); L = r.uniform(3, 18)
            seg(c, None, (x, y), (x + math.cos(a) * L, y + math.sin(a) * L), 0.5, 0.4, np.array(base) * 1.9, 0.6)
        c = mix(c, np.array((0.55, 0.52, 0.48)), 0.18 * fbm(h, w, rng, 30, 2))
        return dict(rgb=c, rough=0.55)
    return p
A.cell('wood_furn', 'home', 256, 128, p_wood_furn())
A.cell('wood_pine', 'home', 256, 128, p_wood_furn((0.62, 0.46, 0.28), 30))

def p_wardrobe(w, h, rng):
    c = p_wood_furn()(w, h, rng)['rgb']
    for x0 in (0.06, 0.53):
        for y0, y1 in ((0.06, 0.55), (0.6, 0.92)):
            rect(c, w * x0, h * y0, w * (x0 + 0.41), h * y1, (0.18, 0.10, 0.05), 0.5)
            rect(c, w * x0 + 3, h * y0 + 3, w * (x0 + 0.41) - 3, h * y1 - 3, (0.42, 0.27, 0.14), 0.35)
    rect(c, w * 0.495, 0, w * 0.505, h, (0.05, 0.03, 0.02))
    disc(c, None, (w * 0.47, h * 0.55), 2, (0.75, 0.6, 0.3)); disc(c, None, (w * 0.53, h * 0.55), 2, (0.75, 0.6, 0.3))
    return dict(rgb=c, rough=0.55)
A.cell('wardrobe_front', 'home', 128, 256, p_wardrobe)

def p_drawers(w, h, rng):
    c = p_wood_furn()(w, h, rng)['rgb']
    for k in range(3):
        y0 = 6 + k * (h - 12) / 3
        rect(c, 6, y0, w - 6, y0 + (h - 12) / 3 - 5, (0.15, 0.08, 0.04), 0.5)
        for x in (0.3, 0.7):
            disc(c, None, (w * x, y0 + (h - 12) / 6), 3, (0.78, 0.62, 0.3), shade=0.3, hl=0.3)
    return dict(rgb=c, rough=0.55)
A.cell('drawers', 'home', 128, 128, p_drawers)

def p_cabinet(w, h, rng):
    """Kitchen base units: four painted (cream) doors, steel handles, grime around the handles and the kick plate."""
    c = col((0.80, 0.76, 0.66), h, w) * (0.92 + 0.1 * fbm(h, w, rng, 10, 3)[..., None])
    for k in range(4):
        x0 = k * w / 4
        rect(c, x0, 0, x0 + 2, h, (0.3, 0.27, 0.22))
        rect(c, x0 + w / 4 - 14, h * 0.75, x0 + w / 4 - 10, h * 0.9, (0.6, 0.6, 0.6))
        c[int(h * 0.6):int(h * 0.98), int(x0 + w / 4 - 22):int(x0 + w / 4 - 2)] *= 0.85
    rect(c, 0, 0, w, h * 0.08, (0.15, 0.13, 0.11))
    c = grime(c, rng, 0.15, 40, streaks=0.05, bottom=0.5)
    return dict(rgb=c, rough=0.5)
A.cell('cabinet_front', 'home', 256, 128, p_cabinet)

def p_tile(w, h, rng):
    r = R(rng)
    c = col((0.55, 0.53, 0.48), h, w)
    n = 8
    for j in range(n):
        for i in range(n):
            tone = np.array((0.88, 0.88, 0.84)) * r.uniform(0.92, 1.03)
            if j == 5:
                tone = np.array((0.20, 0.38, 0.62)) * r.uniform(0.9, 1.05)
            rect(c, i * w / n + 1, j * h / n + 1, (i + 1) * w / n - 1, (j + 1) * h / n - 1, tone)
    c = grime(c, rng, 0.35, 20, streaks=0.3, bottom=0.6)
    return dict(rgb=c, rough=0.2)
A.cell('tile_kitchen', 'home', 128, 128, p_tile)

def p_counter(w, h, rng):
    c = col((0.62, 0.60, 0.56), h, w) * (0.85 + 0.25 * fbm(h, w, rng, 4, 4)[..., None])
    c = c * (1 - 0.3 * (rng.random((h, w)) < 0.05))[..., None]
    c = mix(c, np.array((0.35, 0.28, 0.2)), np.clip((fbm(h, w, rng, 20, 3) - 0.62) * 3, 0, 0.6))
    return dict(rgb=c, rough=0.35)
A.cell('counter', 'home', 128, 128, p_counter)

def p_tv(w, h, rng):
    """CRT TV front: grey bezel, curved dark screen with a sky reflection, speaker slots and buttons."""
    c = col((0.24, 0.24, 0.25), h, w) * (0.95 + 0.08 * fbm(h, w, rng, 10, 2)[..., None])
    yy, xx = np.mgrid[0:h, 0:w] + 0.5
    sx0, sx1, sy0, sy1 = w * 0.08, w * 0.80, h * 0.22, h * 0.92
    m = (xx > sx0) & (xx < sx1) & (yy > sy0) & (yy < sy1)
    gy = (yy - sy0) / (sy1 - sy0)
    scr = np.array((0.05, 0.06, 0.06)) + np.array((0.12, 0.14, 0.15)) * np.clip(gy - 0.4, 0, 1)[..., None] * 1.4
    c[m] = scr[m]
    for y in np.arange(h * 0.3, h * 0.85, 5):
        rect(c, w * 0.85, y, w * 0.95, y + 2, (0.12, 0.12, 0.12))
    for k in range(4):
        disc(c, None, (w * 0.9, h * 0.12 + k * 0), 2.5, (0.5, 0.5, 0.5))
    rect(c, w * 0.30, h * 0.08, w * 0.55, h * 0.14, (0.6, 0.6, 0.62))
    c = grime(c, rng, 0.15, 20)
    return dict(rgb=c, rough=np.where(m, 0.08, 0.5))
A.cell('tv_front', 'home', 128, 128, p_tv)

def p_fridge(w, h, rng):
    c = col((0.85, 0.83, 0.74), h, w) * (0.93 + 0.08 * fbm(h, w, rng, 10, 3)[..., None])
    rect(c, 0, h * 0.70, w, h * 0.71, (0.25, 0.24, 0.22))
    rect(c, w * 0.82, h * 0.40, w * 0.88, h * 0.62, (0.65, 0.66, 0.66))
    rect(c, w * 0.82, h * 0.74, w * 0.88, h * 0.84, (0.65, 0.66, 0.66))
    rect(c, w * 0.3, h * 0.93, w * 0.6, h * 0.96, (0.7, 0.7, 0.72))
    rect(c, w * 0.2, h * 0.5, w * 0.4, h * 0.58, (0.85, 0.3, 0.2), 0.8)
    c = grime(c, rng, 0.15, 40, streaks=0.06, bottom=0.6)
    c = mix(c, np.array((0.45, 0.24, 0.1)), np.clip(1 - np.linspace(0, 1, h)[:, None] / 0.06, 0, 1) * 0.7 * fbm(h, w, rng, 6, 2))
    return dict(rgb=c, rough=0.35)
A.cell('fridge_front', 'home', 128, 256, p_fridge)

def p_stove_top(w, h, rng):
    c = col((0.86, 0.85, 0.80), h, w) * (0.95 + 0.06 * fbm(h, w, rng, 10, 2)[..., None])
    for x, y in ((0.28, 0.3), (0.72, 0.3), (0.28, 0.72), (0.72, 0.72)):
        disc(c, None, (w * x, h * y), w * 0.17, (0.08, 0.08, 0.08))
        disc(c, None, (w * x, h * y), w * 0.07, (0.25, 0.22, 0.2))
        for a in range(4):
            aa = a * math.pi / 2 + 0.785
            seg(c, None, (w * x, h * y), (w * x + math.cos(aa) * w * 0.2, h * y + math.sin(aa) * w * 0.2), 1.5, 1.5, (0.12, 0.12, 0.12))
    c = mix(c, np.array((0.45, 0.35, 0.2)), np.clip((fbm(h, w, rng, 12, 3) - 0.55) * 2.5, 0, 0.7))
    return dict(rgb=c, rough=0.4)
A.cell('stove_top', 'home', 128, 128, p_stove_top)

def p_oven(w, h, rng):
    c = col((0.86, 0.85, 0.80), h, w) * (0.95 + 0.06 * fbm(h, w, rng, 10, 2)[..., None])
    rect(c, w * 0.12, h * 0.15, w * 0.88, h * 0.65, (0.25, 0.24, 0.22))
    rect(c, w * 0.2, h * 0.22, w * 0.8, h * 0.58, (0.05, 0.05, 0.05))
    rect(c, w * 0.15, h * 0.7, w * 0.85, h * 0.74, (0.6, 0.6, 0.6))
    for k in range(5):
        disc(c, None, (w * (0.15 + 0.175 * k), h * 0.86), 5, (0.12, 0.12, 0.12))
    c = grime(c, rng, 0.3, 20, streaks=0.3, bottom=0.7)
    return dict(rgb=c, rough=0.4)
A.cell('oven_front', 'home', 128, 128, p_oven)

def p_cardbox(w, h, rng):
    r = R(rng)
    c = col((0.60, 0.46, 0.30), h, w) * (0.88 + 0.18 * fbm(h, w, rng, 10, 3)[..., None])
    rect(c, w * 0.44, 0, w * 0.56, h, (0.68, 0.58, 0.40), 0.7)
    stencil_glyphs(c, w * 0.08, h * 0.65, h * 0.1, 4, (0.15, 0.1, 0.07), r, alpha=0.8)
    script_strokes(c, w * 0.6, h * 0.2, w * 0.95, h * 0.45, (0.15, 0.1, 0.07), r, 1.2)
    c = grime(c, rng, 0.3, 20, bottom=0.6)
    return dict(rgb=c, rough=0.95)
A.cell('cardbox', 'home', 128, 128, p_cardbox)

def p_crate_plastic(w, h, rng):
    c = col((0.18, 0.32, 0.60), h, w) * (0.92 + 0.1 * fbm(h, w, rng, 10, 2)[..., None])
    for j in range(3):
        for i in range(6):
            rect(c, 6 + i * (w - 12) / 6 + 2, 8 + j * (h - 14) / 3 + 2, 6 + (i + 1) * (w - 12) / 6 - 2, 8 + (j + 1) * (h - 14) / 3 - 2, (0.03, 0.03, 0.04))
    c = grime(c, rng, 0.3, 20, bottom=0.6)
    return dict(rgb=c, rough=0.5)
A.cell('crate_plastic', 'home', 128, 64, p_crate_plastic)

def p_prayer(w, h, rng):
    yy, xx = np.mgrid[0:h, 0:w] + 0.5
    c = col((0.10, 0.32, 0.22), h, w)
    d = np.minimum(np.minimum(xx, w - xx), np.minimum(yy, h - yy))
    c[d < 10] = (0.55, 0.12, 0.10); c[(d > 3) & (d < 5)] = (0.85, 0.75, 0.45)
    cx = w / 2; top = h * 0.82; hw = w * 0.32
    arch = (np.abs(xx - cx) < hw) & (yy < top - hw * 0.0) & (yy > h * 0.12) & ((yy < top - hw) | (np.hypot(xx - cx, (yy - (top - hw)) * 0.8) < hw))
    c[arch] = (0.55, 0.12, 0.10)
    inner = (np.abs(xx - cx) < hw - 5) & (yy > h * 0.12 + 5) & ((yy < top - hw) | (np.hypot(xx - cx, (yy - (top - hw)) * 0.8) < hw - 5))
    c[inner] = (0.12, 0.36, 0.25)
    disc(c, None, (cx, top - hw * 0.6), 6, (0.85, 0.75, 0.45))
    for k in range(5):
        disc(c, None, (cx, h * 0.2 + k * 16), 3, (0.85, 0.75, 0.45))
    c = c * (0.88 + 0.2 * fbm(h, w, rng, 2, 2)[..., None])
    c = grime(c, rng, 0.25, 20)
    return dict(rgb=c, rough=1.0)
A.cell('prayer', 'home', 128, 256, p_prayer)

def p_picture(w, h, rng):
    """Framed landscape print (river, palms, hills) in a gilt frame; sun-faded."""
    r = R(rng)
    c = np.zeros((h, w, 3))
    yy = np.linspace(0, 1, h)[:, None, None]
    c[:] = np.array((0.85, 0.7, 0.45)) * (1 - yy) + np.array((0.35, 0.55, 0.75)) * yy
    fill_poly(c, None, [(0, h * 0.35), (w * 0.3, h * 0.55), (w * 0.55, h * 0.4), (w * 0.8, h * 0.6), (w, h * 0.42), (w, 0), (0, 0)], (0.45, 0.40, 0.30))
    fill_poly(c, None, [(0, h * 0.1), (w, h * 0.25), (w, h * 0.32), (0, h * 0.18)], (0.30, 0.45, 0.55))
    for x in (0.2, 0.75):
        seg(c, None, (w * x, h * 0.3), (w * x + 3, h * 0.65), 2, 1.5, (0.25, 0.18, 0.1))
        for a in np.linspace(0, math.pi, 7):
            seg(c, None, (w * x + 3, h * 0.65), (w * x + 3 + math.cos(a) * 16, h * 0.65 + math.sin(a) * 6 - 6), 2, 0.5, (0.15, 0.3, 0.12))
    c = mix(c, np.array((0.8, 0.75, 0.65)), 0.3)
    d = 8
    rect(c, 0, 0, w, d, (0.65, 0.50, 0.22)); rect(c, 0, h - d, w, h, (0.65, 0.50, 0.22)); rect(c, 0, 0, d, h, (0.65, 0.50, 0.22)); rect(c, w - d, 0, w, h, (0.65, 0.50, 0.22))
    return dict(rgb=c, rough=0.4)
A.cell('picture', 'home', 128, 112, p_picture)

def p_fabric_mix(w, h, rng):
    r = R(rng)
    c = col((0.3, 0.3, 0.3), h, w)
    pal = [(0.20, 0.25, 0.40), (0.75, 0.72, 0.65), (0.45, 0.10, 0.12), (0.30, 0.35, 0.25), (0.15, 0.15, 0.17), (0.65, 0.55, 0.35), (0.55, 0.60, 0.70)]
    for _ in range(40):
        x, y = r.uniform(0, w), r.uniform(0, h)
        fill_poly(c, None, [(x + r.uniform(-30, 30), y + r.uniform(-30, 30)) for _ in range(5)], np.array(r.choice(pal)) * r.uniform(0.8, 1.1), ss=1)
    f = fbm(h, w, rng, 8, 3, aspect=3)
    c = c * (0.7 + 0.45 * f[..., None])
    return dict(rgb=c, rough=1.0)
A.cell('fabric_mix', 'home', 128, 128, p_fabric_mix)

def p_books(w, h, rng):
    r = R(rng)
    c = col((0.1, 0.1, 0.1), h, w)
    x = 0
    while x < w:
        bw = r.uniform(4, 11)
        tone = np.array(r.choice(((0.45, 0.10, 0.08), (0.12, 0.25, 0.15), (0.15, 0.15, 0.35), (0.6, 0.5, 0.35), (0.1, 0.1, 0.1), (0.7, 0.68, 0.6)))) * r.uniform(0.8, 1.1)
        ht = h * r.uniform(0.7, 1.0)
        rect(c, x, 0, x + bw - 0.6, ht, tone)
        rect(c, x + 1, ht * 0.75, x + bw - 1.5, ht * 0.78, (0.8, 0.65, 0.3))
        x += bw
    return dict(rgb=c, rough=0.8)
A.cell('books', 'home', 128, 64, p_books)

# double-sided cloth (cutout page, opaque alpha)
def p_curtain(w, h, rng):
    """Printed curtain fabric: cream/ gold ground with rows of small maroon and green flowers, sun-faded at the top."""
    r = R(rng)
    c = col((0.80, 0.70, 0.48), h, w) * (0.92 + 0.12 * fbm(h, w, rng, 6, 3)[..., None])
    for j in range(8):
        for i in range(6):
            cx = (i + 0.5 * (j % 2)) * w / 6 + 8; cy = (j + 0.5) * h / 8
            for a in np.linspace(0, 2 * math.pi, 6)[:-1]:
                disc(c, None, (cx + math.cos(a) * 5, cy + math.sin(a) * 5), 3.5, (0.55, 0.15, 0.12))
            disc(c, None, (cx, cy), 2.5, (0.85, 0.65, 0.2))
            seg(c, None, (cx, cy - 6), (cx + 6, cy - 16), 1.2, 0.8, (0.25, 0.40, 0.20))
    rect(c, 0, h - 10, w, h, (0.55, 0.40, 0.22))
    c = mix(c, np.array((0.85, 0.80, 0.70)), np.linspace(0, 0.3, h)[:, None] * np.ones((1, w)))
    c = grime(c, rng, 0.25, 30, bottom=0.4)
    return dict(rgb=c)
A.cell('curtain', 'cloth', 192, 256, p_curtain)

def p_blanket(w, h, rng):
    """Plush polyester blanket: deep red with a big central flower and a dark border (very common in Iraqi homes)."""
    yy, xx = np.mgrid[0:h, 0:w] + 0.5
    c = col((0.52, 0.08, 0.10), h, w)
    d = np.minimum(np.minimum(xx, w - xx), np.minimum(yy, h - yy))
    c[d < 18] = (0.20, 0.05, 0.08)
    c[(d > 18) & (d < 22)] = (0.85, 0.62, 0.30)
    cx, cy = w / 2, h / 2
    ang = np.arctan2(yy - cy, xx - cx); rr = np.hypot(xx - cx, yy - cy)
    petal = rr < (55 + 25 * np.cos(ang * 8))
    c[petal] = (0.82, 0.35, 0.28)
    c[rr < (30 + 12 * np.cos(ang * 8 + 0.4))] = (0.92, 0.72, 0.42)
    c[rr < 10] = (0.45, 0.10, 0.10)
    c = c * (0.85 + 0.25 * fbm(h, w, rng, 5, 3)[..., None])
    return dict(rgb=c)
A.cell('blanket', 'cloth', 256, 256, p_blanket)

def p_bedsheet(w, h, rng):
    c = col((0.75, 0.74, 0.68), h, w) * (0.9 + 0.12 * fbm(h, w, rng, 8, 3)[..., None])
    xx = np.arange(w)[None, :]
    c[np.broadcast_to((xx % 32) < 10, (h, w))] *= np.array((0.85, 0.92, 1.05))
    c = mix(c, np.array((0.60, 0.52, 0.35)), np.clip((fbm(h, w, rng, 20, 3) - 0.6) * 3, 0, 0.6))
    c = grime(c, rng, 0.2, 20, streaks=0.3, bottom=0.6)
    return dict(rgb=c)
A.cell('bedsheet', 'cloth', 128, 128, p_bedsheet)

for k, (c_, ro, me, d) in dict(mirror=((0.78, 0.80, 0.82), 0.05, 1.0, 0.1), enamel=((0.86, 0.85, 0.80), 0.3, 0.0, 0.5),
                                fabric_cream=((0.78, 0.72, 0.60), 0.95, 0.0, 0.5), pot_alu=((0.68, 0.68, 0.68), 0.35, 0.9, 0.4),
                                glass_green=((0.25, 0.40, 0.30), 0.1, 0.0, 0.2), shoe_brown=((0.25, 0.15, 0.08), 0.6, 0.0, 0.4)).items():
    A.swatch(k, c_, ro, me, 0.06, 6, d)

# -------------------------------------------------------------------------------------------- furniture builders
def soft(mb, size, loc, cell, r, rot=(0, 0, 0), bev=None, jit=0.012):
    mb.chamfer_box(size, bev or min(size) * 0.35, cell, T(loc, rot), jitter=jit, rng=r)

def b_floor_cushions(mb):
    """Majlis floor seating 2.6 m along a wall (wall at -Y): three seat mattresses, a long back cushion and two
    round arm bolsters, in woven Sadu-style cloth."""
    r = random.Random(201)
    for k in range(3):
        soft(mb, (0.85, 0.72, 0.10), ((k - 1) * 0.87, 0.06, 0.05), 'cushion', r, (0, 0, r.uniform(-2, 2)))
    for k in range(3):
        soft(mb, (0.84, 0.18, 0.44), ((k - 1) * 0.87, -0.31, 0.30), 'cushion', r, (-10, 0, r.uniform(-2, 2)))
    for x in (-1.36, 1.36):
        mb.cyl(0.11, 0.62, 'cushion', T((x, -0.25, 0.2), (-90, 0, 0)), 10, smooth=True)

def b_sofa_old(mb):
    """Worn three-seat sofa 2.0 x 0.85 x 0.86 m, sagging cushions, dark legs."""
    r = random.Random(202)
    soft(mb, (2.0, 0.82, 0.30), (0, 0, 0.25), 'sofa', r, bev=0.05)
    soft(mb, (2.0, 0.22, 0.55), (0, -0.31, 0.62), 'sofa', r, (-6, 0, 0), bev=0.07)
    for k in range(3):
        soft(mb, (0.58, 0.62, 0.14), ((k - 1) * 0.58, 0.07, 0.46 - 0.015 * (k == 1)), 'sofa', r, (r.uniform(-2, 2), 0, r.uniform(-2, 2)), jit=0.015)
        soft(mb, (0.56, 0.16, 0.40), ((k - 1) * 0.58, -0.16, 0.70), 'sofa', r, (-14, 0, 0), jit=0.015)
    for x in (-0.93, 0.93):
        soft(mb, (0.16, 0.82, 0.30), (x, 0, 0.55), 'sofa', r, bev=0.06)
        for y in (-0.33, 0.33):
            mb.box((0.05, 0.05, 0.10), 'wood_dark', loc=(x * 0.98, y, 0.05), faces='xXyYZ')

def b_armchair(mb):
    r = random.Random(203)
    soft(mb, (0.82, 0.80, 0.30), (0, 0, 0.25), 'sofa', r, bev=0.05)
    soft(mb, (0.82, 0.22, 0.55), (0, -0.30, 0.62), 'sofa', r, (-6, 0, 0), bev=0.07)
    soft(mb, (0.56, 0.60, 0.14), (0, 0.07, 0.46), 'sofa', r, jit=0.015)
    for x in (-0.34, 0.34):
        soft(mb, (0.15, 0.80, 0.30), (x, 0, 0.55), 'sofa', r, bev=0.06)
        for y in (-0.32, 0.32):
            mb.box((0.05, 0.05, 0.10), 'wood_dark', loc=(x * 1.05, y, 0.05), faces='xXyYZ')

def rug(mb, W, D, cell, r):
    nx, ny = 8, 6
    P = [[V((lerp(-W / 2, W / 2, i / nx), lerp(-D / 2, D / 2, j / ny), 0.006 + (r.uniform(0, 0.012) if 0 < i < nx and 0 < j < ny else 0.0))) for j in range(ny + 1)] for i in range(nx + 1)]
    mb.surf(P, cell, smooth=True)
    for a, b in (((-W / 2, -D / 2), (W / 2, -D / 2)), ((W / 2, -D / 2), (W / 2, D / 2)), ((W / 2, D / 2), (-W / 2, D / 2)), ((-W / 2, D / 2), (-W / 2, -D / 2))):
        mb.quad((a[0], a[1], 0), (b[0], b[1], 0), (b[0], b[1], 0.006), (a[0], a[1], 0.006), cell, (0, 0, 1, 0.02))

def b_rug_large(mb):
    rug(mb, 3.0, 2.0, 'rug_persian', random.Random(204))

def b_rug_small(mb):
    rug(mb, 1.5, 0.9, 'kilim', random.Random(205))

def b_coffee_table_low(mb):
    """Low wooden coffee table 1.0 x 0.6 x 0.40 m with a lower shelf, steel tea tray, istikan glasses and an ashtray."""
    mb.box((1.0, 0.6, 0.035), 'wood_furn', loc=(0, 0, 0.385))
    mb.box((0.9, 0.5, 0.02), 'wood_furn', loc=(0, 0, 0.1))
    for sx in (-1, 1):
        for sy in (-1, 1):
            mb.box((0.045, 0.045, 0.37), 'wood_furn', loc=(sx * 0.46, sy * 0.26, 0.185), faces='xXyY')
    mb.cyl(0.17, 0.012, 'pot_alu', T((0.15, 0.02, 0.403)), 12)
    for k in range(4):
        a = k * 1.57 + 0.4
        mb.lathe([(0.02, 0.0), (0.026, 0.04), (0.02, 0.06), (0.026, 0.085)], 6, 'glass_green', T((0.15 + math.cos(a) * 0.09, 0.02 + math.sin(a) * 0.09, 0.415)), cap0=True)
    mb.lathe([(0.06, 0.0), (0.07, 0.03), (0.05, 0.03), (0.04, 0.01)], 8, 'steel_dark', T((-0.3, -0.1, 0.403)), cap0=True)

def b_tv_crt_stand(mb):
    """21-inch CRT TV (0.56 x 0.48 m, deep back) with rabbit-ear antenna and a satellite receiver on a small wooden
    cabinet (0.9 x 0.45 x 0.55 m)."""
    mb.box((0.9, 0.45, 0.55), 'wood_furn', loc=(0, 0, 0.275), faces='xXyZ')
    mb.box((0.9, 0.45, 0.55), 'drawers', loc=(0, 0, 0.275), faces='Y', uv=(0, 0, 1, 0.68))
    z0 = 0.55
    mb.box((0.30, 0.22, 0.06), 'steel_dark', loc=(0.22, 0.05, z0 + 0.03))
    mb.box((0.56, 0.18, 0.48), 'tv_front', loc=(0, 0.10, z0 + 0.24), faces='Y')
    mb.box((0.56, 0.18, 0.48), 'grey_paint', loc=(0, 0.10, z0 + 0.24), faces='xXZ')
    mb.lathe([(0.25, 0.0), (0.12, 0.30)], 4, 'grey_paint', T((0, 0.01, z0 + 0.24), (90, 45, 0)), cap1=True, smooth=False, sy=0.85)
    mb.box((0.04, 0.04, 0.02), 'grey_paint', loc=(0, -0.1, z0 + 0.49))
    for a in (-25, 25):
        mb.bar((0, -0.1, z0 + 0.5), (math.sin(math.radians(a)) * 0.45, -0.15, z0 + 0.5 + math.cos(math.radians(a)) * 0.45), 0.004, 'aluminium', 3)
    mb.box((0.4, 0.3, 0.003), 'bedsheet', loc=(0, 0.02, z0 + 0.0015), faces='Z')

def b_side_table_lamp(mb):
    mb.box((0.45, 0.45, 0.03), 'wood_furn', loc=(0, 0, 0.545))
    for sx in (-1, 1):
        for sy in (-1, 1):
            mb.box((0.035, 0.035, 0.53), 'wood_furn', loc=(sx * 0.19, sy * 0.19, 0.265), faces='xXyY')
    mb.lathe([(0.08, 0.56), (0.07, 0.58), (0.03, 0.62), (0.035, 0.80), (0.015, 0.82), (0.012, 0.88)], 10, 'gold', cap0=True)
    mb.lathe([(0.17, 0.82), (0.10, 1.02)], 12, 'fabric_cream', smooth=True)
    mb.lathe([(0.10, 1.02), (0.17, 0.82)], 12, 'fabric_cream', smooth=True)
    mb.sphere(0.04, 'lamp', T((0, 0, 0.92)), 6, 4)

def b_curtain_window(mb):
    """Curtain pair 1.2 m wide x 1.6 m drop with folds on a rod. Origin at the rod's bottom centre (z = 0); the cloth
    hangs to z = -1.6 and sits ~4 cm in front of the wall, which is at y = -0.08."""
    r = random.Random(206)
    mb.bar((-0.72, 0.0, 0.012), (0.72, 0.0, 0.012), 0.012, 'gold', 6)
    for x in (-0.72, 0.72):
        mb.box((0.02, 0.09, 0.03), 'gold', loc=(x, -0.04, 0.012))
    for side in (-1, 1):
        n = 18
        P = []
        for i in range(n + 1):
            t = i / n
            x0 = side * lerp(0.02, 0.66, t)
            row = []
            for j in range(4):
                z = -1.6 * j / 3
                gather = 1.0 - 0.35 * (j / 3) * (1 - t) if side else 1
                amp = 0.035 + 0.01 * j
                y = 0.04 + amp * math.sin(t * math.pi * 12 + side) + r.uniform(-0.004, 0.004) * (j > 0)
                row.append(V((x0 * (1 - 0.12 * j / 3) + side * 0.02 * (j / 3), y, z)))
            P.append(row[::-1])
        if side < 0:
            P = P[::-1]
        mb.surf(P, 'curtain', smooth=True, urep=2)

def b_bed_double(mb):
    """Double bed 1.6 x 2.05 m: dark wooden head/ footboards, mattress, plush blanket draped over, two pillows.
    Headboard against the wall at -Y."""
    r = random.Random(207)
    mb.box((1.66, 0.06, 1.05), 'wardrobe_front', loc=(0, -1.0, 0.525), faces='Y', uv=(0, 0.5, 1, 1))
    mb.box((1.66, 0.06, 1.05), 'wood_furn', loc=(0, -1.0, 0.525), faces='xXyZ')
    mb.box((1.66, 0.05, 0.55), 'wood_furn', loc=(0, 1.0, 0.275))
    for x in (-0.8, 0.8):
        mb.box((0.04, 1.95, 0.18), 'wood_furn', loc=(x, 0, 0.30))
    soft(mb, (1.52, 1.92, 0.20), (0, 0.0, 0.40), 'ticking', r, bev=0.05)
    # blanket: over the lower 2/3 of the mattress, hanging down the sides
    nx, ny = 8, 8
    P = []
    for i in range(nx + 1):
        row = []
        for j in range(ny + 1):
            u = i / nx; v = j / ny
            x = lerp(-0.98, 0.98, u); y = lerp(-0.45, 1.0, v)
            ax = abs(x)
            z = 0.515 if ax < 0.76 else 0.515 - (ax - 0.76) * 1.3
            z += 0.015 * math.sin(u * 9 + v * 5) + r.uniform(-0.006, 0.006)
            x = math.copysign(min(ax, 0.79 + max(0, ax - 0.76) * 0.15), x)
            if v > 0.96:
                y = 0.99
            row.append(V((x, y, max(0.3, z))))
        P.append(row)
    mb.surf(P, 'blanket', smooth=True)
    for x in (-0.38, 0.38):
        soft(mb, (0.62, 0.38, 0.13), (x, -0.72, 0.56), 'bedsheet', r, (8, 0, r.uniform(-4, 4)), jit=0.015)

def b_mattress_floor(mb):
    r = random.Random(208)
    soft(mb, (0.9, 1.9, 0.12), (0, 0, 0.06), 'ticking', r, bev=0.04)
    soft(mb, (0.85, 0.5, 0.08), (0, 0.35, 0.16), 'blanket', r, (0, 0, 5), jit=0.02)
    soft(mb, (0.55, 0.35, 0.11), (0, -0.7, 0.17), 'bedsheet', r, (6, 0, 0))

def b_wardrobe(mb):
    """Two-door wooden wardrobe 1.2 x 0.58 x 1.95 m with a cornice and plinth."""
    mb.box((1.2, 0.58, 1.85), 'wardrobe_front', loc=(0, 0, 1.025), faces='Y')
    mb.box((1.2, 0.58, 1.85), 'wood_furn', loc=(0, 0, 1.025), faces='xXy')
    mb.box((1.26, 0.62, 0.06), 'wood_furn', loc=(0, 0.01, 1.98))
    mb.box((1.2, 0.56, 0.10), 'wood_dark', loc=(0, 0, 0.05), faces='xXyYZ')
    for x in (-0.04, 0.04):
        mb.box((0.015, 0.03, 0.12), 'gold', loc=(x, 0.3, 1.05), faces='xXYZz')
    mb.box((0.5, 0.4, 0.3), 'cardbox', T((0.2, 0.0, 2.16), (0, 0, 8)))

def b_dresser_mirror(mb):
    mb.box((1.0, 0.45, 0.80), 'drawers', loc=(0, 0, 0.40), faces='Y')
    mb.box((1.0, 0.45, 0.80), 'wood_furn', loc=(0, 0, 0.40), faces='xXyZ')
    mb.box((0.72, 0.04, 0.92), 'wood_furn', loc=(0, -0.18, 1.26), faces='xXyZz')
    mb.box((0.62, 0.01, 0.82), 'mirror', loc=(0, -0.155, 1.26), faces='Y')
    for k, (x, hh, cell) in enumerate(((-0.3, 0.18, 'glass_green'), (-0.2, 0.12, 'gold'), (0.25, 0.2, 'white_plastic'), (0.33, 0.1, 'bag_blue'))):
        mb.lathe([(0.03, 0), (0.035, hh * 0.7), (0.012, hh * 0.85), (0.012, hh)], 6, cell, T((x, 0.05, 0.8)), cap0=True, cap1=True)
    mb.cyl(0.12, 0.008, 'bedsheet', T((0.0, 0.08, 0.8)), 10)

def b_clothes_pile(mb):
    r = random.Random(209)
    for k in range(9):
        a = r.uniform(0, 2 * math.pi); rr = r.uniform(0, 0.35)
        s = r.uniform(0.25, 0.5)
        mb.sphere(s, 'fabric_mix', T((math.cos(a) * rr, math.sin(a) * rr, 0.05 + 0.08 * (rr < 0.2))), 7, 4, (1.0, r.uniform(0.6, 1.0), 0.28), rfun=lumpy(r, 7, 4, 0.25))

def b_prayer_mat(mb):
    rug(mb, 0.68, 1.15, 'prayer', random.Random(210))

def b_kitchen_counter(mb):
    """Kitchen run 2.0 x 0.6 x 0.9 m: painted base units, stone-chip worktop, steel sink and tap, tiled backsplash
    (0.6 m) on the wall at -Y, kettle and a dish rack."""
    mb.box((2.0, 0.58, 0.86), 'cabinet_front', loc=(0, -0.01, 0.43), faces='Y')
    mb.box((2.0, 0.58, 0.86), 'enamel', loc=(0, -0.01, 0.43), faces='xX')
    sx0, sx1, sy0, sy1 = 0.25, 0.85, -0.2, 0.2
    top = 0.90
    for x0, x1 in ((-1.02, sx0), (sx1, 1.02)):
        mb.box((x1 - x0, 0.62, 0.04), 'counter', loc=((x0 + x1) / 2, 0, top - 0.02))
    mb.box((sx1 - sx0, sy0 + 0.31, 0.04), 'counter', loc=((sx0 + sx1) / 2, (-0.31 + sy0) / 2, top - 0.02), faces='yYZ')
    mb.box((sx1 - sx0, 0.31 - sy1, 0.04), 'counter', loc=((sx0 + sx1) / 2, (0.31 + sy1) / 2, top - 0.02), faces='yYZ')
    sk = sub(mb)
    sk.box((sx1 - sx0, sy1 - sy0, 0.18), 'pot_alu', loc=(0, 0, -0.09), faces='xXyYz')
    sk.F = [(ids[::-1], uvs[::-1], pg, sm) for ids, uvs, pg, sm in sk.F]
    mb.merge(sk, T(((sx0 + sx1) / 2, 0, top)))
    mb.tube([V((0.55, -0.27, top)), V((0.55, -0.27, top + 0.25)), V((0.55, -0.12, top + 0.27))], 0.012, 'pot_alu', sides=5)
    tiled(mb, (1.0, -0.305, top), (-2.0, 0, 0), (0, 0, 0.6), 5, 2, 'tile_kitchen')
    mb.lathe([(0.08, 0), (0.09, 0.1), (0.07, 0.18), (0.03, 0.2)], 10, 'pot_alu', T((-0.6, -0.1, top)), cap0=True, cap1=True)
    mb.bar((-0.52, -0.1, top + 0.12), (-0.46, -0.1, top + 0.17), 0.012, 'pot_alu', 4)
    mb.box((0.40, 0.25, 0.02), 'galv', loc=(-0.15, -0.12, top + 0.01))
    for k in range(4):
        mb.cyl(0.11, 0.012, 'enamel', T((-0.25 + k * 0.06, -0.12, top + 0.13), (0, 75, 0)), 10)

def b_fridge_old(mb):
    """Old enamel fridge-freezer 0.70 x 0.66 x 1.60 m with rounded edges, chrome handles, rust at the foot."""
    r = random.Random(211)
    mb.chamfer_box((0.70, 0.62, 1.58), 0.05, 'enamel', T((0, -0.02, 0.81)))
    mb.box((0.68, 0.02, 1.52), 'fridge_front', loc=(0, 0.30, 0.82), faces='Y')
    for z, hh in ((0.95, 0.35), (1.30, 0.16)):
        mb.box((0.03, 0.04, hh), 'aluminium', loc=(0.28, 0.33, z))
    mb.box((0.62, 0.05, 0.06), 'steel_dark', loc=(0, 0.27, 0.03))
    mb.box((0.35, 0.3, 0.25), 'cardbox', T((0.05, -0.05, 1.725), (0, 0, 12)))

def b_gas_stove(mb):
    """Free-standing 4-burner gas cooker with oven (0.55 x 0.55 x 0.85 m), pot on a burner, rubber hose to the
    floor where a gas cylinder stands: empty 'cylinder_spot' marks where to place the gas_cylinder prop."""
    mb.box((0.55, 0.55, 0.85), 'oven_front', loc=(0, 0, 0.425), faces='Y')
    mb.box((0.55, 0.55, 0.85), 'enamel', loc=(0, 0, 0.425), faces='xXy')
    mb.box((0.55, 0.55, 0.02), 'stove_top', loc=(0, 0, 0.86), faces='Z')
    mb.box((0.55, 0.04, 0.12), 'enamel', loc=(0, -0.26, 0.93))
    mb.lathe([(0.12, 0.0), (0.12, 0.15)], 10, 'pot_alu', T((-0.13, -0.11, 0.87)), cap0=True)
    mb.lathe([(0.115, 0.15), (0.115, 0.01)], 10, 'steel_dark', T((-0.13, -0.11, 0.87)))
    mb.cyl(0.125, 0.015, 'pot_alu', T((-0.13, -0.11, 1.02)), 10)
    hose = [V((0.27, -0.2, 0.3)), V((0.36, -0.2, 0.22)), V((0.45, -0.1, 0.08)), V((0.55, 0.0, 0.05)), V((0.62, 0.02, 0.35)), V((0.62, 0.0, 0.62))]
    mb.tube(hose, 0.008, 'rubber', sides=4)
    return dict(empties={'cylinder_spot': (0.62, 0.0, 0.0)})

def b_kitchen_shelf(mb):
    """Free-standing galvanised shelf 0.9 x 0.35 x 1.6 m with pots, jars, rice sacks and plates."""
    r = random.Random(212)
    for sx in (-1, 1):
        for sy in (-1, 1):
            mb.box((0.03, 0.03, 1.6), 'galv', loc=(sx * 0.435, sy * 0.16, 0.8), faces='xXyY')
    for z in (0.05, 0.45, 0.85, 1.25, 1.58):
        mb.box((0.9, 0.35, 0.02), 'galv', loc=(0, 0, z))
    for k in range(2):
        mb.lathe([(0.14, 0), (0.15, 0.2)], 10, 'pot_alu', T((-0.2 + k * 0.38, 0, 0.06)), cap0=True)
        mb.lathe([(0.145, 0.2), (0.135, 0.01)], 10, 'steel_dark', T((-0.2 + k * 0.38, 0, 0.06)))
    for k in range(5):
        hh = r.uniform(0.14, 0.24)
        mb.lathe([(0.05, 0), (0.055, hh * 0.85), (0.035, hh), (0.035, hh + 0.02)], 8, r.choice(['glass_green', 'tomato', 'orange', 'white_plastic']), T((-0.35 + k * 0.17, 0.02, 0.46)), cap0=True, cap1=True)
    soft(mb, (0.40, 0.28, 0.32), (-0.2, 0.0, 1.02), 'hessian', r, jit=0.02)
    soft(mb, (0.34, 0.25, 0.28), (0.22, 0.0, 1.0), 'cardboard', r, jit=0.01)
    for k in range(6):
        mb.cyl(0.11, 0.012, 'enamel', T((-0.15, 0.0, 1.27 + k * 0.014)), 10)
    mb.lathe([(0.06, 0), (0.07, 0.12), (0.03, 0.2), (0.02, 0.24)], 8, 'copper', T((0.25, 0, 1.27)), cap0=True, cap1=True)

def wood_chair(mb, M, r):
    s = sub(mb)
    s.box((0.42, 0.42, 0.03), 'wood_pine', loc=(0, 0, 0.45))
    for sx in (-1, 1):
        for sy in (-1, 1):
            hh = 0.45 if sy > 0 else 0.92
            s.box((0.035, 0.035, hh), 'wood_pine', loc=(sx * 0.19, sy * 0.19, hh / 2), faces='xXyYZ')
    for z in (0.62, 0.78, 0.9):
        s.box((0.38, 0.02, 0.05), 'wood_pine', loc=(0, -0.19, z))
    mb.merge(s, M)

def b_table_dining(mb):
    """Dining table 1.4 x 0.8 x 0.75 m with a plastic floral tablecloth and four wooden chairs pushed in unevenly."""
    r = random.Random(213)
    mb.box((1.4, 0.8, 0.035), 'wood_pine', loc=(0, 0, 0.735), faces='xXyYz')
    mb.box((1.42, 0.82, 0.004), 'curtain', loc=(0, 0, 0.755), faces='Z')
    for sx in (-1, 1):
        for sy in (-1, 1):
            mb.box((0.05, 0.05, 0.72), 'wood_pine', loc=(sx * 0.64, sy * 0.34, 0.36), faces='xXyY')
    for k, (x, y, yaw) in enumerate(((-0.35, 0.55, 180), (0.35, 0.62, 175), (-0.35, -0.6, 3), (0.38, -0.66, -8))):
        wood_chair(mb, T((x + r.uniform(-0.03, 0.03), y, 0), (0, 0, yaw + r.uniform(-4, 4))), r)
    mb.lathe([(0.1, 0), (0.12, 0.03)], 10, 'enamel', T((0.1, 0.05, 0.757)), cap0=True)

def b_water_cooler(mb):
    """Bottle water dispenser 0.32 x 0.32 x 1.0 m cabinet with a 19 L blue bottle on top (total 1.45 m)."""
    mb.chamfer_box((0.32, 0.32, 0.95), 0.02, 'white_plastic', T((0, 0, 0.475)))
    mb.box((0.18, 0.04, 0.12), 'steel_dark', loc=(0, 0.17, 0.75), faces='xXYZz')
    for x in (-0.05, 0.05):
        mb.box((0.03, 0.04, 0.04), 'tomato' if x < 0 else 'bag_blue', loc=(x, 0.19, 0.80))
    mb.lathe([(0.03, 0.95), (0.06, 1.0), (0.13, 1.05), (0.135, 1.30), (0.10, 1.36), (0.0, 1.38)], 10, 'bag_blue', smooth=True)

def b_cardboard_boxes(mb):
    r = random.Random(214)
    for k, (x, y, z, s, yaw) in enumerate(((0, 0, 0, (0.6, 0.45, 0.45), 3), (0.62, 0.05, 0, (0.5, 0.4, 0.35), -6),
                                             (0.05, 0.02, 0.45, (0.5, 0.4, 0.35), 12), (-0.55, -0.05, 0, (0.4, 0.35, 0.3), 25),
                                             (0.6, 0.1, 0.35, (0.35, 0.3, 0.25), -15))):
        mb.chamfer_box(s, 0.01, 'cardbox', T((x, y, z + s[2] / 2), (r.uniform(-1, 1), r.uniform(-1, 1), yaw)), jitter=0.008, rng=r)

def b_plastic_crates(mb):
    r = random.Random(215)
    def crate(x, y, z, yaw):
        s = sub(mb)
        s.box((0.53, 0.36, 0.30), 'crate_plastic', loc=(0, 0, 0.15), faces='xXyY')
        s.box((0.51, 0.34, 0.28), 'crate_plastic', loc=(0, 0, 0.15), faces='xXyY')
        s.F[-4:] = [(ids[::-1], uvs[::-1], pg, sm) for ids, uvs, pg, sm in s.F[-4:]]
        s.box((0.51, 0.34, 0.01), 'blue_paint', loc=(0, 0, 0.01), faces='Z')
        mb.merge(s, T((x, y, z), (0, 0, yaw)))
    crate(0, 0, 0, 2); crate(0.02, 0.01, 0.30, -4); crate(0.58, 0.05, 0, 10); crate(-0.1, 0.45, 0, 80)

def b_shoes_rack(mb):
    """Low shoe rack 0.8 x 0.3 x 0.6 m with three shelves of shoes, sandals left on the floor in front."""
    r = random.Random(216)
    for x in (-0.39, 0.39):
        mb.box((0.02, 0.3, 0.6), 'wood_pine', loc=(x, 0, 0.3))
    for z in (0.02, 0.21, 0.40, 0.59):
        mb.box((0.78, 0.3, 0.02), 'wood_pine', loc=(0, 0, z))
    for z in (0.03, 0.22, 0.41):
        for k in range(3):
            x = -0.26 + k * 0.26
            for dx in (-0.05, 0.05):
                mb.chamfer_box((0.09, 0.26, 0.07), 0.025, r.choice(['shoe_brown', 'steel_dark', 'white_plastic']), T((x + dx, 0.0, z + 0.045), (0, 0, r.uniform(-6, 6))), jitter=0.004, rng=r)
    for k in range(2):
        mb.box((0.10, 0.25, 0.02), 'rubber', T((-0.2 + k * 0.14, 0.4, 0.01), (0, 0, r.uniform(-20, 20))))

def b_wall_shelf_items(mb):
    """Wall shelf 1.0 x 0.25 m (wall plane y = 0, origin at the bracket bottom) with books, a radio, a clock, a vase
    and a framed photo."""
    mb.box((1.0, 0.25, 0.025), 'wood_furn', loc=(0, 0.125, 0.15))
    for x in (-0.38, 0.38):
        mb.beam((x, 0.01, 0.0), (x, 0.2, 0.14), 0.02, 0.02, 'steel_dark')
        mb.box((0.02, 0.02, 0.16), 'steel_dark', loc=(x, 0.01, 0.08))
    mb.box((0.35, 0.18, 0.22), 'books', loc=(-0.25, 0.11, 0.273), faces='Y')
    mb.box((0.35, 0.18, 0.22), 'wood_dark', loc=(-0.25, 0.11, 0.273), faces='xXZ')
    mb.box((0.26, 0.09, 0.15), 'steel_dark', loc=(0.12, 0.12, 0.238))
    mb.cyl(0.05, 0.01, 'grey_paint', T((0.06, 0.17, 0.24), (-90, 0, 0)), 8)
    mb.cyl(0.08, 0.04, 'enamel', T((0.38, 0.12, 0.163 + 0.08), (90, 0, 0)), 12)
    mb.lathe([(0.04, 0), (0.06, 0.08), (0.03, 0.16), (0.04, 0.2)], 8, 'cobalt', T((0.25, 0.15, 0.163)), cap0=True)
    mb.box((0.15, 0.015, 0.2), 'picture', T((-0.02, 0.06, 0.26), (-10, 0, 0)), faces='Y')

def b_ceiling_fan(mb):
    """Ceiling fan: origin at the ceiling mount (z = 0), hangs down 0.45 m, 1.2 m sweep, three blades."""
    mb.lathe([(0.08, 0.0), (0.06, -0.06)], 10, 'enamel', cap1=False)
    mb.bar((0, 0, -0.05), (0, 0, -0.33), 0.012, 'enamel', 6)
    mb.lathe([(0.04, -0.33), (0.12, -0.36), (0.13, -0.42), (0.06, -0.45), (0.0, -0.46)], 12, 'enamel', smooth=True)
    for k in range(3):
        a = k * 120
        mb.box((0.48, 0.12, 0.008), 'wood_pine', T((0, 0, -0.41), (0, 0, a)) @ T((0.36, 0, 0), (8, 0, 0)))
        mb.box((0.12, 0.03, 0.01), 'enamel', T((0, 0, -0.41), (0, 0, a)) @ T((0.12, 0, 0)))

def b_bulb_hanging(mb):
    """Bare bulb on a flex: origin at the ceiling (z = 0), bulb bottom at -0.62 m."""
    mb.cyl(0.03, 0.02, 'enamel', T((0, 0, -0.02)), 8)
    mb.bar((0, 0, -0.02), (0, 0, -0.48), 0.003, 'rubber', 3)
    mb.cyl(0.018, 0.05, 'steel_dark', T((0, 0, -0.53)), 8)
    mb.lathe([(0.012, -0.53), (0.03, -0.56), (0.03, -0.60), (0.0, -0.62)], 8, 'lamp', smooth=True)

def b_picture_frame(mb):
    """Framed print 0.50 x 0.44 m; wall plane y = 0, origin at the bottom centre of the frame."""
    mb.box((0.50, 0.025, 0.44), 'picture', loc=(0, 0.0125, 0.22), faces='Y')
    mb.box((0.50, 0.025, 0.44), 'gold', loc=(0, 0.0125, 0.22), faces='xXzZ')

def b_broken_furniture(mb):
    """Wrecked furniture: a split table top, broken chair parts and splinters on the floor (~1.6 x 1.2 m)."""
    r = random.Random(217)
    mb.box((0.65, 0.8, 0.03), 'wood_pine', T((-0.25, 0.1, 0.18), (18, -8, 12)))
    mb.box((0.6, 0.78, 0.03), 'wood_pine', T((0.35, 0.05, 0.04), (3, 4, -20)))
    for k in range(2):
        mb.box((0.05, 0.05, 0.72), 'wood_pine', T((-0.55 + k * 0.08, 0.5, 0.36), (0, 72 + k * 10, 30 * k)))
    wood_chair(mb, T((0.55, -0.35, 0.21), (85, 0, 160)), r)
    for k in range(10):
        a = r.uniform(0, 6.28); rr = r.uniform(0.2, 0.8)
        mb.box((r.uniform(0.1, 0.35), r.uniform(0.02, 0.05), 0.015), r.choice(['wood_pine', 'wood_furn']), T((math.cos(a) * rr, math.sin(a) * rr, 0.008), (0, 0, r.uniform(0, 180))))
    mb.box((0.3, 0.3, 0.02), 'cardboard', T((-0.6, -0.4, 0.01), (0, 0, 30)))

def b_mattress_upright(mb):
    """Mattress stood on its edge and leaned against a wall (wall at -Y) as improvised cover: 0.9 x 1.9 m, 0.16 thick."""
    r = random.Random(218)
    s = sub(mb)
    s.chamfer_box((0.9, 0.16, 1.9), 0.05, 'ticking', T((0, 0, 0.95)), jitter=0.01, rng=r)
    s.deform(lambda p: V((p.x, p.y + 0.06 * math.sin(math.pi * p.z / 1.9), p.z)))
    mb.merge(s, T((0, 0.25, 0), (-12, 0, 0)))

def b_sandbag_window(mb):
    """Sandbags stacked in a window opening 1.0 m wide (two bags deep for a 0.3 m wall), 6 courses (0.74 m) with a
    firing slit; origin at the sill centre, wall faces at y = +-0.15."""
    r = random.Random(219)
    for layer in range(6):
        for row in (-0.07, 0.07):
            for k in range(2):
                if layer == 5 and k == 1 and row > 0:
                    continue
                x = -0.25 + k * 0.5 + (0.03 if layer % 2 else -0.03)
                sandbag(mb, (x, row, 0.065 + layer * 0.123), r.uniform(-3, 3), r, size=(0.48, 0.15, 0.13))

def b_bedsheet_window(mb):
    """Bedsheet nailed over a window 1.2 x 1.4 m: wall plane y = 0, origin at the sheet's bottom centre, sagging
    between the nails."""
    r = random.Random(220)
    nx, ny = 6, 5
    nails = [-0.62, -0.2, 0.2, 0.62]
    P = []
    for i in range(nx + 1):
        row = []
        for j in range(ny + 1):
            u, v = i / nx, j / ny
            x = lerp(-0.66, 0.66, u)
            sag = 0.06 * abs(math.sin(math.pi * (x + 0.62) / 0.413)) * v ** 3
            y = 0.012 + 0.03 * math.sin(u * 11) * (1 - v) * 0.6 + r.uniform(0, 0.01)
            row.append(V((x, y, 1.42 * v - sag)))
        P.append(row)
    mb.surf(P, 'bedsheet', smooth=True)
    for x in nails:
        mb.cyl(0.008, 0.02, 'steel_dark', T((x, 0.02, 1.40), (-90, 0, 0)), 4)

INTERIOR_PROPS = {
    'floor_cushions': (b_floor_cushions, 'home', None), 'sofa_old': (b_sofa_old, 'home', None), 'armchair': (b_armchair, 'home', None),
    'rug_large': (b_rug_large, 'home', None), 'rug_small': (b_rug_small, 'home', None), 'coffee_table_low': (b_coffee_table_low, 'home', None),
    'tv_crt_stand': (b_tv_crt_stand, 'home', None), 'side_table_lamp': (b_side_table_lamp, 'home', None), 'curtain_window': (b_curtain_window, 'home', None),
    'bed_double': (b_bed_double, 'home', None), 'mattress_floor': (b_mattress_floor, 'home', None), 'wardrobe': (b_wardrobe, 'home', None),
    'dresser_mirror': (b_dresser_mirror, 'home', None), 'clothes_pile': (b_clothes_pile, 'home', 'xy'), 'prayer_mat': (b_prayer_mat, 'home', None),
    'kitchen_counter': (b_kitchen_counter, 'home', None), 'fridge_old': (b_fridge_old, 'home', None), 'gas_stove': (b_gas_stove, 'home', None),
    'kitchen_shelf': (b_kitchen_shelf, 'home', None), 'table_dining': (b_table_dining, 'home', None), 'water_cooler': (b_water_cooler, 'home', None),
    'cardboard_boxes': (b_cardboard_boxes, 'home', 'xy'), 'plastic_crates': (b_plastic_crates, 'home', 'xy'), 'shoes_rack': (b_shoes_rack, 'home', None),
    'wall_shelf_items': (b_wall_shelf_items, 'home', None), 'ceiling_fan': (b_ceiling_fan, 'home', None), 'bulb_hanging': (b_bulb_hanging, 'home', None),
    'picture_frame': (b_picture_frame, 'home', None), 'broken_furniture': (b_broken_furniture, 'home', 'xy'), 'mattress_upright': (b_mattress_upright, 'home', 'x'),
    'sandbag_window': (b_sandbag_window, 'home', None), 'bedsheet_window': (b_bedsheet_window, 'home', None),
}
INTERIOR_MEDIUM = {'kitchen_shelf', 'table_dining', 'bed_double', 'sofa_old', 'kitchen_counter', 'shoes_rack', 'sandbag_window', 'broken_furniture'}

# ============================================================================================ registry / build / export
# id: (builder, group, recentre)   recentre 'xy' moves the footprint centre to the origin, 'x' only along X
PROPS = {
    'palm_a': (b_palm_a, 'veg', None), 'palm_b': (b_palm_b, 'veg', None), 'palm_c': (b_palm_c, 'veg', None),
    'shrub_dry': (b_shrub_dry, 'veg', None), 'bush_oleander': (b_bush_oleander, 'veg', None), 'dead_tree': (b_dead_tree, 'veg', None),
    'reeds': (b_reeds, 'veg', None), 'grass_tuft_dry': (b_grass_tuft_dry, 'veg', None),
    'tree_eucalyptus': (b_tree_eucalyptus, 'veg', None), 'tree_eucalyptus_b': (b_tree_eucalyptus_b, 'veg', None),
    'tree_orchard': (b_tree_orchard, 'veg', None), 'tree_tamarisk': (b_tree_tamarisk, 'veg', None),
    'water_tank': (b_water_tank, 'city', None), 'water_tank_steel': (b_water_tank_steel, 'city', 'xy'), 'ac_split': (b_ac_split, 'city', 'xy'),
    'ac_window': (b_ac_window, 'city', 'xy'), 'sat_dish': (b_sat_dish, 'city', None), 'antenna_tv': (b_antenna_tv, 'city', None),
    'solar_heater': (b_solar_heater, 'city', 'xy'), 'generator_small': (b_generator_small, 'city', 'xy'), 'roof_clutter': (b_roof_clutter, 'city', 'xy'),
    'clothesline': (b_clothesline, 'city', 'xy'),
    'market_stall': (b_market_stall, 'city', 'xy'), 'awning_shop': (b_awning_shop, 'city', 'x'), 'shop_shutter': (b_shop_shutter, 'city', 'x'),
    'cart_hand': (b_cart_hand, 'city', 'xy'), 'plastic_chair': (b_plastic_chair, 'city', None), 'table_plastic': (b_table_plastic, 'city', None),
    'gas_cylinder': (b_gas_cylinder, 'city', None), 'oil_drum': (b_oil_drum, 'city', None), 'oil_drum_rusty': (b_oil_drum_rusty, 'city', None),
    'tyres_pile': (b_tyres_pile, 'city', 'xy'), 'trash_pile': (b_trash_pile, 'city', 'xy'), 'trash_bags': (b_trash_bags, 'city', 'xy'),
    'rubble_a': (b_rubble_a, 'city', 'xy'), 'rubble_b': (b_rubble_b, 'city', 'xy'), 'rubble_c': (b_rubble_c, 'city', 'xy'),
    'debris_slab': (b_debris_slab, 'city', 'xy'), 'burnt_tyre': (b_burnt_tyre, 'city', None), 'street_light': (b_street_light, 'city', None),
    'power_pole': (b_power_pole, 'city', None), 'transformer_box': (b_transformer_box, 'city', None), 'kerb_barrier': (b_kerb_barrier, 'city', None),
    'sign_shop': (b_sign_shop, 'city', 'x'), 'billboard_frame': (b_billboard_frame, 'city', 'x'),
    'hesco_1': (b_hesco_1, 'mil', None), 'hesco_wall': (b_hesco_wall, 'mil', None), 't_wall': (b_t_wall, 'mil', None),
    'jersey_barrier': (b_jersey_barrier, 'mil', None), 'sandbags_line': (b_sandbags_line, 'mil', 'xy'), 'sandbag_bunker': (b_sandbag_bunker, 'mil', 'xy'),
    'guard_tower': (b_guard_tower, 'mil', None), 'tent_military': (b_tent_military, 'mil', None), 'camo_net': (b_camo_net, 'mil', None),
    'flagpole': (b_flagpole, 'mil', None), 'conex': (b_conex, 'mil', None), 'pallet': (b_pallet, 'mil', None), 'crate_ammo': (b_crate_ammo, 'mil', 'xy'),
    'wire_concertina': (b_wire_concertina, 'mil', 'xy'), 'floodlight_tower': (b_floodlight_tower, 'mil', 'xy'),
    'cache_crate': (b_cache_crate, 'mil', 'xy'), 'cache_crate_b': (b_cache_crate_b, 'mil', 'xy'),
    'minaret': (b_minaret, 'arch', None), 'dome_large': (b_dome_large, 'arch', None), 'dome_small': (b_dome_small, 'arch', None),
    'arch_gate': (b_arch_gate, 'arch', None), 'fountain_basin': (b_fountain_basin, 'arch', None),
}
PROPS.update(INTERIOR_PROPS)
BUDGET = {'tree_eucalyptus': 3000, 'tree_eucalyptus_b': 3000, 'tree_orchard': 2000, 'tree_tamarisk': 2000, 'palm_a': 6000, 'palm_b': 6000, 'palm_c': 6000, 'minaret': 8000, 'dome_large': 8000, 'dome_small': 8000, 'guard_tower': 6000}
MEDIUM = {'market_stall', 'hesco_wall', 'sandbags_line', 'sandbag_bunker', 'tent_military', 'camo_net', 'conex', 'wire_concertina',
          'floodlight_tower', 'cache_crate', 'cache_crate_b', 'rubble_a', 'rubble_b', 'rubble_c', 'roof_clutter', 'billboard_frame',
          'arch_gate', 'fountain_basin', 'dead_tree', 'solar_heater', 'trash_pile', 'tyres_pile', 'power_pole', 'antenna_tv', 'cart_hand'}

def build_all():
    roots = {}
    for pid, (fn, group, rec) in PROPS.items():
        if ONLY and pid not in ONLY:
            continue
        mb = MB(A, group)
        res = fn(mb) or {}
        kids = res.get('children', {})
        if rec:
            allv = list(mb.V) + [v for k in kids.values() for v in k.V]
            xs = [v[0] for v in allv]; ys = [v[1] for v in allv]
            dx = -(min(xs) + max(xs)) / 2
            dy = -(min(ys) + max(ys)) / 2 if rec == 'xy' else 0.0
            M = Matrix.Translation((dx, dy, 0))
            mb.transform(M)
            for k in kids.values():
                k.transform(M)
            res['empties'] = {n: tuple(M @ V(p)) for n, p in res.get('empties', {}).items()}
        o = mb.build(pid)
        for name, k in kids.items():
            c = k.build(name)
            c.parent = o
        for name, p in res.get('empties', {}).items():
            empty_at(name, p, o)
        roots[pid] = o
    return roots

def report(roots):
    rows = []
    for pid, o in roots.items():
        n = tri_count(o); mn, mx = bounds(o)
        lim = BUDGET.get(pid, 4000 if pid in MEDIUM or pid in INTERIOR_MEDIUM else 1500)
        flag = '' if n <= lim else f'  OVER BUDGET ({lim})'
        mats = sorted({m.name for x in [o] + list(o.children_recursive) if x.type == 'MESH' for m in x.data.materials})
        emp = [c.name for c in o.children if c.type == 'EMPTY']
        rows.append(f'{pid:18s} {n:6d} tris  {mx.x - mn.x:6.2f} x {mx.y - mn.y:6.2f} x {mx.z - mn.z:6.2f} m  z {mn.z:+.2f}..{mx.z:.2f}  [{", ".join(mats)}]'
                    + (f'  empties: {" ".join(emp)}' if emp else '') + flag)
    print('\n'.join(rows))

SHEETS_DEF = {
    'palms': (['palm_a', 'palm_b', 'palm_c'], dict(lens=35, el=6, az=-20, gap=4.0, target_z=6.0, dist_mul=0.85)),
    'veg': (['shrub_dry', 'bush_oleander', 'dead_tree', 'reeds', 'grass_tuft_dry'], dict(lens=40, el=10, gap=1.0)),
    'trees': (['tree_eucalyptus', 'tree_eucalyptus_b', 'tree_orchard', 'tree_tamarisk'], dict(lens=35, el=6, az=-20, gap=3.0, target_z=6.0, dist_mul=0.85)),
    'roof': (['water_tank', 'water_tank_steel', 'ac_split', 'ac_window', 'sat_dish', 'antenna_tv', 'solar_heater', 'generator_small', 'roof_clutter', 'clothesline'], dict(lens=40, el=16, gap=0.8, rows=2)),
    'street': (['market_stall', 'awning_shop', 'shop_shutter', 'sign_shop', 'cart_hand', 'plastic_chair', 'table_plastic', 'gas_cylinder', 'oil_drum', 'oil_drum_rusty'], dict(lens=40, el=12, gap=0.7, rows=2)),
    'debris': (['tyres_pile', 'trash_pile', 'trash_bags', 'rubble_a', 'rubble_b', 'rubble_c', 'debris_slab', 'burnt_tyre', 'kerb_barrier', 'transformer_box'], dict(lens=40, el=20, gap=0.8, rows=2)),
    'poles': (['street_light', 'power_pole', 'billboard_frame', 'floodlight_tower', 'flagpole'], dict(lens=35, el=8, gap=2.0)),
    'mil': (['hesco_1', 'hesco_wall', 't_wall', 'jersey_barrier', 'sandbags_line', 'sandbag_bunker', 'guard_tower'], dict(lens=40, el=12, gap=1.0)),
    'fob': (['tent_military', 'camo_net', 'conex', 'pallet', 'crate_ammo', 'wire_concertina'], dict(lens=40, el=16, gap=1.0)),
    'cache': (['cache_crate', 'cache_crate_b'], dict(lens=45, el=22, gap=0.8, dist_mul=0.9)),
    'living': (['floor_cushions', 'sofa_old', 'armchair', 'rug_large', 'rug_small', 'coffee_table_low', 'tv_crt_stand', 'side_table_lamp', 'prayer_mat', 'picture_frame'], dict(lens=40, el=22, gap=0.4, rows=2)),
    'bedroom': (['bed_double', 'mattress_floor', 'wardrobe', 'dresser_mirror', 'clothes_pile', 'mattress_upright', 'sandbag_window', 'bedsheet_window'], dict(lens=40, el=18, gap=0.4, rows=2)),
    'kitchen': (['kitchen_counter', 'fridge_old', 'gas_stove', 'kitchen_shelf', 'table_dining', 'water_cooler', 'cardboard_boxes', 'plastic_crates', 'shoes_rack', 'wall_shelf_items', 'broken_furniture'], dict(lens=40, el=18, gap=0.4, rows=2)),
    'mosque': (['minaret', 'dome_large', 'dome_small', 'arch_gate', 'fountain_basin'], dict(lens=35, el=8, gap=3.0, target_z=9.0)),
}

def previews(roots):
    os.makedirs(PREV, exist_ok=True)
    allr = list(roots.values())
    setup_preview_scene()
    for name, (ids, kw) in SHEETS_DEF.items():
        if SHEETS and name not in SHEETS:
            continue
        rs = [roots[i] for i in ids if i in roots]
        if rs:
            preview_sheet(rs, os.path.join(PREV, f'props_{name}.png'), all_roots=allr, **kw)
    def close(name, ids, loc, tgt, lens=40, places=None):
        if SHEETS and name not in SHEETS:
            return
        rs = [roots[i] for i in ids if i in roots]
        if len(rs) == len(ids):
            preview_cam(rs, os.path.join(PREV, f'props_{name}.png'), loc, tgt, lens, allr, places={roots[k]: v for k, v in (places or {}).items()})
    close('palm_30m', ['palm_a', 'palm_b', 'palm_c'], (2, -30, 4), (0, 0, 6.5), 35, {'palm_a': (-6, 0, 0), 'palm_b': (1, 4, 0), 'palm_c': (7, -2, 0)})
    close('palm_crown', ['palm_a'], (4.5, -7.5, 9.0), (0, 0, 10.6), 35)
    close('minaret_top', ['minaret'], (6, -11, 21), (0, 0, 23.5), 40)
    close('hesco_close', ['hesco_wall', 'hesco_1'], (2.6, -4.2, 2.3), (0.3, 0, 0.8), 35, {'hesco_wall': (0, 0, 0), 'hesco_1': (3.4, 0.6, 15)})
    close('market_close', ['market_stall'], (2.4, 4.4, 2.1), (0, 0.2, 1.1), 35)
    close('cache_close', ['cache_crate'], (1.7, 2.3, 1.6), (0, 0, 0.55), 40)
    close('cache_b_close', ['cache_crate_b'], (-1.6, 2.2, 1.7), (0, 0, 0.5), 40)
    close('shopfront', ['shop_shutter', 'awning_shop', 'sign_shop'], (2.5, 6.5, 2.2), (0, 0, 2.2), 35)
    close('room_living', ['floor_cushions', 'rug_large', 'sofa_old', 'tv_crt_stand', 'coffee_table_low', 'curtain_window', 'side_table_lamp'], (2.2, 3.6, 1.7), (-0.2, -0.6, 0.5), 35,
          {'floor_cushions': (0.2, -1.45, 0), 'rug_large': (0, 0, 0), 'sofa_old': (-1.9, 0.1, -90), 'tv_crt_stand': (1.9, -0.4, 90), 'coffee_table_low': (0, 0.1, 0),
           'curtain_window': (0.4, -1.92, 0, 2.2), 'side_table_lamp': (-1.6, -1.35, 0)})
    close('room_bed', ['bed_double', 'wardrobe', 'dresser_mirror', 'prayer_mat', 'clothes_pile'], (1.9, 2.9, 1.7), (0, -0.4, 0.6), 35,
          {'bed_double': (0, -0.3, 0), 'wardrobe': (-1.7, -1.0, 0), 'dresser_mirror': (1.55, -1.05, 0), 'prayer_mat': (1.3, 0.9, 90), 'clothes_pile': (-1.2, 1.0, 0)})
    close('room_kitchen', ['kitchen_counter', 'fridge_old', 'gas_stove', 'kitchen_shelf', 'gas_cylinder', 'table_dining'], (0.9, 3.4, 1.7), (0, -0.2, 0.8), 35,
          {'kitchen_counter': (0, 0, 0), 'fridge_old': (1.42, 0.0, 0), 'gas_stove': (-1.4, 0.03, 0), 'gas_cylinder': (-0.78, 0.03, 0), 'kitchen_shelf': (-2.6, 0.12, 0), 'table_dining': (0.0, 1.9, 0)})
    close('mil_close', ['guard_tower', 'sandbag_bunker', 't_wall', 'jersey_barrier'], (6, -9, 3), (0, 0, 2.0), 35,
          {'guard_tower': (0, 0, 0), 'sandbag_bunker': (-3.5, -1, 0), 't_wall': (3.0, -1.5, 0), 'jersey_barrier': (2, -4, 20)})

def export(roots, path):
    bpy.ops.object.select_all(action='DESELECT')
    for o in roots.values():
        o.hide_set(False); o.hide_render = False
        o.select_set(True)
        for c in o.children_recursive:
            c.select_set(True)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=True, export_yup=True,
                              export_cameras=False, export_lights=False, export_materials='EXPORT', export_image_format='AUTO',
                              export_texcoords=True, export_normals=True, export_tangents=False, export_extras=False)
    print('EXPORTED', path, round(os.path.getsize(path) / 1e6, 2), 'MB', len(roots), 'props')

if __name__ == '__main__':
    tmp = tempfile.mkdtemp(prefix='props_tex_')
    try:
        A.pack(tmp)
        if ATLAS_DUMP:
            os.makedirs(ATLAS_DUMP, exist_ok=True)
            for f in os.listdir(tmp):
                shutil.copy(os.path.join(tmp, f), ATLAS_DUMP)
        roots = build_all()
        report(roots)
        if PREV:
            previews(roots)
        os.makedirs(OUT, exist_ok=True)
        export(roots, os.path.join(OUT, 'props.glb' if not ONLY else 'props_partial.glb'))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

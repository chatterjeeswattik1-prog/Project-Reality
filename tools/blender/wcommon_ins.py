"""Extra helpers for the insurgent weapon builder (tools/blender/weapons_ins.py).
Procedural Cycles materials (worn steel, laminated / solid wood, bakelite, paint) baked per weapon into base colour,
metallic-roughness and tangent-space normal maps packed into the GLB, stamped markings,
loft / lathe / path-loft mesh builders, grouping of parts into the animated child meshes, box-projected UVs,
and preview renders. Builds on tools/blender/common.py (not modified)."""
import math, os, tempfile
import numpy as np
import bpy
import bmesh
from mathutils import Vector, Matrix
from common import reset, mat, clear_mats, empty

# ------------------------------------------------------------------ materials (procedural, baked per weapon)
# Every part material is a Cycles node network whose base colour / roughness / metallic / micro-height end in reroute
# nodes named OUT_BASE / OUT_ROUGH / OUT_METAL / OUT_HEIGHT. bake_weapon() unwraps all meshes of a weapon into one UV
# atlas and bakes
#   - a tangent-space normal map: OUT_HEIGHT (metres: wood pores and grain, checkering, scratches, pitting, stamped
#     markings) through a Bump node on top of a Bevel-node normal (rounded edges on the low-poly mesh),
#   - base colour: edge wear from a Bevel-node curvature mask gated by AO (only exposed convex edges go silver),
#     handling polish on broad convex areas, scratches, cavity grime, wood grain / laminate plies, bakelite marbling,
#   - glTF metallic-roughness (G = roughness, B = metallic),
# then swaps in one plain Principled material per weapon (base colour + metal/rough + normal map).
# All noise is procedural (deterministic for a given mesh); per-material variety comes from fixed seeds.
TEXSCALE = {}


class _NT:
    def __init__(self, m):
        m.use_nodes = True
        self.nt = m.node_tree
        self.N = self.nt.nodes
        self.L = self.nt.links
        self.y = 0
        self._co = None

    def node(self, kind, **kw):
        n = self.N.new(kind)
        n.location = (-600 + 40 * len(self.N) % 400, self.y)
        self.y -= 60
        for k, v in kw.items():
            setattr(n, k, v)
        return n

    def link(self, a, b):
        self.L.new(a, b)

    def val(self, x, sock):
        if isinstance(x, (int, float)):
            sock.default_value = x
        elif isinstance(x, tuple):
            sock.default_value = (*x, 1.0) if len(x) == 3 else x
        else:
            self.link(x, sock)

    def math(self, op, a, b=0.0, clamp=False):
        n = self.node('ShaderNodeMath', operation=op, use_clamp=clamp)
        self.val(a, n.inputs[0]); self.val(b, n.inputs[1])
        return n.outputs[0]

    def mad(self, a, k, c, clamp=False):
        n = self.node('ShaderNodeMath', operation='MULTIPLY_ADD', use_clamp=clamp)
        self.val(a, n.inputs[0]); self.val(k, n.inputs[1]); self.val(c, n.inputs[2])
        return n.outputs[0]

    def mrange(self, x, a, b, c=0.0, d=1.0, smooth=True):
        """Map x from [a, b] to [c, d], clamped (smoothstep by default)."""
        n = self.node('ShaderNodeMapRange', interpolation_type='SMOOTHSTEP' if smooth else 'LINEAR', clamp=True)
        self.val(x, n.inputs[0])
        for i, v in zip((1, 2, 3, 4), (a, b, c, d)):
            n.inputs[i].default_value = v
        return n.outputs[0]

    def mix(self, fac, a, b):
        n = self.node('ShaderNodeMix', data_type='RGBA', clamp_factor=True)
        self.val(fac, n.inputs[0]); self.val(a, n.inputs[6]); self.val(b, n.inputs[7])
        return n.outputs[2]

    def ramp(self, fac, stops):
        n = self.node('ShaderNodeValToRGB')
        cr = n.color_ramp
        while len(cr.elements) > 1:
            cr.elements.remove(cr.elements[-1])
        cr.elements[0].position = stops[0][0]; cr.elements[0].color = (*stops[0][1], 1)
        for pos, col in stops[1:]:
            e = cr.elements.new(pos); e.color = (*col, 1)
        self.val(fac, n.inputs[0])
        return n.outputs[0]

    def coord(self, scale=(1, 1, 1), rot=(0, 0, 0), loc=(0, 0, 0)):
        """Object coordinates, rotated (degrees, before scaling) then scaled and offset."""
        tc = self.node('ShaderNodeTexCoord')
        v = tc.outputs['Object']
        if rot != (0, 0, 0):
            mr = self.node('ShaderNodeMapping')
            mr.inputs['Rotation'].default_value = tuple(math.radians(a) for a in rot)
            self.link(v, mr.inputs['Vector'])
            v = mr.outputs[0]
        if scale != (1, 1, 1) or loc != (0, 0, 0):
            mp = self.node('ShaderNodeMapping')
            mp.inputs['Scale'].default_value = scale
            mp.inputs['Location'].default_value = loc
            self.link(v, mp.inputs['Vector'])
            v = mp.outputs[0]
        return v

    def noise(self, scale, detail=3.0, rough=0.55, vec=None, out='Fac', distort=0.0):
        n = self.node('ShaderNodeTexNoise')
        n.inputs['Scale'].default_value = scale
        n.inputs['Detail'].default_value = detail
        n.inputs['Roughness'].default_value = rough
        n.inputs['Distortion'].default_value = distort
        self.link(vec if vec is not None else self.coord(), n.inputs['Vector'])
        return n.outputs[out]

    def edge(self, radius=0.0018, gain=4.0):
        """Curvature from the Bevel node: 0 on flat areas, -> 1 on sharp edges (convex and concave)."""
        bev = self.node('ShaderNodeBevel', samples=8)
        bev.inputs['Radius'].default_value = radius
        geo = self.node('ShaderNodeNewGeometry')
        d = self.node('ShaderNodeVectorMath', operation='DOT_PRODUCT')
        self.link(bev.outputs['Normal'], d.inputs[0]); self.link(geo.outputs['Normal'], d.inputs[1])
        return self.math('MULTIPLY', self.math('SUBTRACT', 1.0, d.outputs['Value']), gain, True)

    def ao(self, dist=0.006):
        n = self.node('ShaderNodeAmbientOcclusion', samples=8, only_local=True)
        n.inputs['Distance'].default_value = dist
        return n.outputs['AO']

    def cavity(self, dist=0.006, gain=1.6):
        return self.math('MULTIPLY', self.math('SUBTRACT', 1.0, self.ao(dist)), gain, True)

    def scratches(self, scale, width=0.012, density=0.45, seed=0.0, rot=(0, 0, 0), stretch=0.06):
        """Thin straight scratches: edges of a Voronoi cell field stretched along the (rotated) Y axis, so cells become
        long needles whose long edges are the scratch lines; only some cells (random cell colour) and patches (noise)
        are kept. scale = cells per metre across the scratch, width in cell units. Returns 0..1."""
        v = self.coord((scale, scale * stretch, scale), rot, (seed * 1.37, seed * 2.11, seed * 0.73))
        ve = self.node('ShaderNodeTexVoronoi', voronoi_dimensions='3D', feature='DISTANCE_TO_EDGE')
        ve.inputs['Scale'].default_value = 1.0
        self.link(v, ve.inputs['Vector'])
        vc = self.node('ShaderNodeTexVoronoi', voronoi_dimensions='3D', feature='F1')
        vc.inputs['Scale'].default_value = 1.0
        self.link(v, vc.inputs['Vector'])
        sx = self.node('ShaderNodeSeparateColor')
        self.link(vc.outputs['Color'], sx.inputs[0])
        line = self.mrange(ve.outputs['Distance'], width, width * 0.25)
        pick = self.mrange(sx.outputs[0], 1 - density, 1 - density + 0.05)
        # Fine patch mask breaks the lines into short segments (and hides most of the short cell-end edges).
        dens = self.mrange(self.noise(scale * 0.3, 2, 0.5, self.coord(loc=(seed * 3.1, seed, -seed))), 0.5, 0.6)
        dens = self.math('MULTIPLY', dens, self.mrange(self.noise(scale * 0.05, 2, 0.5, self.coord(loc=(-seed, seed * 2, seed))), 0.35, 0.55))
        return self.math('MULTIPLY', self.math('MULTIPLY', line, pick), dens)

    def finish(self, base, rough, metal, height=0.0):
        outs = []
        for name, sock in (('OUT_BASE', base), ('OUT_ROUGH', rough), ('OUT_METAL', metal), ('OUT_HEIGHT', height)):
            r = self.node('NodeReroute', name=name)
            if isinstance(sock, (int, float)):
                v = self.node('ShaderNodeValue'); v.outputs[0].default_value = sock; sock = v.outputs[0]
            self.val(sock, r.inputs[0])
            outs.append(r.outputs[0])
        b = self.N['Principled BSDF']
        self.link(outs[0], b.inputs['Base Color']); self.link(outs[1], b.inputs['Roughness']); self.link(outs[2], b.inputs['Metallic'])


def _lin(c):
    """sRGB triple -> linear."""
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c)


def _sc(c, k, add=0.0):
    return tuple(min(1.0, x * k + add) for x in c)


def m_steel(name, base=(0.18, 0.18, 0.175), worn=(0.6, 0.6, 0.59), wear=1.0, rough=0.45, metal=0.7, seed=0.0, pit=1.0):
    """Worn blued / phosphated steel (colours sRGB): neutral grey-black mottled finish, silver wear on exposed sharp
    edges (Bevel curvature gated by AO, broken up by noise), broad handling polish on convex areas, fine scratches in
    several directions, dark oily grime and a little rust in cavities, pitting in the normal map."""
    m = bpy.data.materials.new(name); t = _NT(m)
    m['bevel'] = 0.0007
    co = t.coord(loc=(seed, seed * 0.5, -seed))
    n_big = t.noise(7.0, 3, 0.5, co)
    n_mid = t.noise(55.0, 4, 0.62, co)
    n_fine = t.noise(420.0, 2, 0.5, co)
    open_ = t.mrange(t.ao(0.008), 0.55, 0.95)                    # 1 where nothing is close (exposed)
    e = t.edge(0.0009, 7.0)
    e_conv = t.math('MULTIPLY', e, open_)
    # Wear: exposed edges, broken by mid noise, grows with `wear`.
    wearm = t.mrange(t.mad(t.math('SUBTRACT', n_mid, 0.5), 0.8, t.math('MULTIPLY', e_conv, 1.3)), 0.36 - 0.12 * wear, 0.5 - 0.12 * wear)
    wearm = t.math('MULTIPLY', wearm, min(1.0, wear * 1.2))
    # Handling polish: broad convex regions (big bevel radius) lighten and get smoother.
    pol = t.math('MULTIPLY', t.mrange(t.edge(0.004, 2.2), 0.15, 0.6), t.mrange(n_big, 0.3, 0.7, 0.2, 0.7))
    pol = t.math('MULTIPLY', pol, open_)
    sc = t.math('MAXIMUM', t.math('MAXIMUM', t.scratches(150.0, 0.02, 0.22, seed + 1, (0, 0, 0), 0.16),
                                       t.scratches(120.0, 0.018, 0.16, seed + 2, (24, 0, 0), 0.2)),
                t.math('MAXIMUM', t.scratches(130.0, 0.016, 0.12, seed + 3, (-33, 0, 12), 0.22),
                       t.scratches(90.0, 0.016, 0.1, seed + 4, (75, 20, 0), 0.25)))
    sc = t.math('MULTIPLY', sc, 0.6 * wear)
    cav = t.cavity(0.007, 1.7)
    pitm = t.math('MULTIPLY', t.mrange(n_fine, 0.66, 0.74), pit)
    c0 = t.mix(n_big, _lin(_sc(base, 0.82)), _lin(_sc(base, 1.18)))
    c0 = t.mix(t.math('MULTIPLY', t.mrange(n_mid, 0.35, 0.7), 0.25), c0, _lin(_sc(base, 0.8)))         # bluing variation
    c1 = t.mix(t.math('MULTIPLY', pol, 0.3), c0, _lin(_sc(base, 1.45)))
    c2 = t.mix(t.math('MULTIPLY', sc, 0.9), c1, _lin(_sc(worn, 0.85)))
    c3 = t.mix(wearm, c2, _lin(worn))
    rust = t.math('MULTIPLY', t.mrange(t.noise(30.0, 3, 0.6, co), 0.62, 0.75), t.math('MULTIPLY', cav, 0.6))
    c4 = t.mix(t.math('MULTIPLY', cav, 0.7), c3, _lin((0.05, 0.045, 0.04)))
    c5 = t.mix(rust, c4, _lin((0.2, 0.1, 0.05)))
    c6 = t.mix(t.math('MULTIPLY', pitm, 0.5), c5, _lin(_sc(base, 0.55)))
    r = t.mad(t.math('SUBTRACT', n_big, 0.5), 0.14, rough)
    r = t.mad(pol, -0.12, r)
    r = t.mad(wearm, -0.2, t.mad(sc, -0.08, t.mad(cav, 0.22, t.mad(rust, 0.3, r))))
    mt = t.mad(wearm, 1.0 - metal, t.mad(cav, -0.25, t.mad(rust, -0.5, metal)))
    h = t.mad(sc, -4e-5, t.mad(pitm, -3e-5, t.math('MULTIPLY', t.math('SUBTRACT', n_fine, 0.5), 1.2e-5)))
    t.finish(c6, r, mt, h)
    return m


def m_paint(name, base, chip=(0.32, 0.31, 0.3), dirt=(0.22, 0.19, 0.14), rough=0.62, chips=1.0):
    """Painted metal: slight tonal variation, chipped edges showing steel, dust in cavities, scuffs."""
    m = bpy.data.materials.new(name); t = _NT(m)
    m['bevel'] = 0.0008
    co = t.coord()
    n_big = t.noise(6.0, 3, 0.5, co)
    n_c = t.noise(90.0, 4, 0.65, co)
    e = t.math('MULTIPLY', t.edge(0.0016, 4.0), t.mrange(t.ao(0.008), 0.55, 0.95))
    chipm = t.mrange(t.mad(e, 0.8, t.math('MULTIPLY', n_c, 0.6)), 1.0 - 0.38 * chips, 1.04 - 0.38 * chips)
    sc = t.math('MULTIPLY', t.scratches(120.0, 0.018, 0.15, 5, (20, 0, 0), 0.2), 0.6)
    cav = t.cavity(0.01, 1.5)
    c0 = t.mix(n_big, _lin(_sc(base, 0.88)), _lin(_sc(base, 1.12)))
    c1 = t.mix(t.math('MULTIPLY', cav, 0.6), c0, _lin(dirt))
    c1 = t.mix(sc, c1, _lin(_sc(base, 1.35)))
    c2 = t.mix(chipm, c1, _lin(chip))
    r = t.mad(chipm, -0.25, t.mad(t.math('SUBTRACT', n_big, 0.5), 0.12, t.mad(sc, 0.1, rough)))
    mt = t.math('MULTIPLY', chipm, 0.8)
    h = t.mad(chipm, -4e-5, t.mad(sc, -1e-5, t.math('MULTIPLY', t.math('SUBTRACT', n_c, 0.5), 6e-6)))
    t.finish(c2, r, mt, h)
    return m


def m_wood(name, light, dark, laminate=False, rough=0.3, ring_scale=95.0, seed=0.0, lacquer=1.0):
    """Lacquered wood (sRGB colours): growth rings around the length axis (grain runs along +Y), fibre streaks, open
    pores, laminate plies (AKM birch laminate: vertical veneers, so stripes show on curved and top / bottom faces),
    dents, lacquer worn through to lighter raw wood on exposed edges, dirt in corners. Grain, pores and dents also go
    into the height (normal map)."""
    m = bpy.data.materials.new(name); t = _NT(m)
    m['bevel'] = 0.0012
    co = t.coord(loc=(seed, -seed * 0.7, seed * 0.3))
    wave = t.node('ShaderNodeTexWave', wave_type='RINGS', rings_direction='Y', wave_profile='SAW')
    wave.inputs['Scale'].default_value = ring_scale
    wave.inputs['Distortion'].default_value = 2.5
    wave.inputs['Detail'].default_value = 2.0
    wave.inputs['Detail Scale'].default_value = 1.2
    t.link(t.coord((1.0, 0.08, 1.0), loc=(seed, 0, -seed)), wave.inputs['Vector'])
    fib = t.noise(160.0, 3, 0.6, t.coord((1, 0.02, 1), loc=(seed, 0, seed)))
    streak = t.mrange(t.noise(45.0, 2, 0.5, t.coord((1, 0.03, 1), loc=(-seed, 0, seed))), 0.45, 0.65)
    pores = t.noise(700.0, 1, 0.5, t.coord((1, 0.12, 1)))
    big = t.noise(3.0, 2, 0.5, co)
    late = t.mrange(wave.outputs['Fac'], 0.55, 0.95)                    # dark late-wood band of each ring
    g = t.mad(late, 0.35, t.mad(streak, 0.3, t.math('MULTIPLY', fib, 0.5)))
    ply = None
    if laminate:
        pw = t.node('ShaderNodeTexWave', wave_type='BANDS', bands_direction='X', wave_profile='SIN')
        pw.inputs['Scale'].default_value = 90.0
        pw.inputs['Distortion'].default_value = 0.6
        pw.inputs['Detail'].default_value = 1.0
        t.link(co, pw.inputs['Vector'])
        ply = t.mrange(pw.outputs['Fac'], 0.82, 0.98)
        g = t.mad(ply, 0.22, t.math('MULTIPLY', g, 0.9))
    mid = tuple((a + b) / 2 for a, b in zip(light, dark))
    col = t.ramp(t.mrange(g, 0.25, 0.8, 0.0, 1.0, False), [(0.0, _lin(light)), (0.4, _lin(mid)), (1.0, _lin(dark))])
    col = t.mix(t.mrange(big, 0.3, 0.75, 0.0, 0.45), col, _lin(_sc(dark, 0.85)))                     # board-to-board tone
    porem = t.mrange(pores, 0.64, 0.7)
    col = t.mix(t.math('MULTIPLY', porem, 0.45), col, _lin(_sc(dark, 0.5)))
    dents = t.mrange(t.noise(28.0, 2, 0.5, co), 0.7, 0.78)
    col = t.mix(t.math('MULTIPLY', dents, 0.3), col, _lin(_sc(dark, 0.6)))
    open_ = t.mrange(t.ao(0.01), 0.55, 0.95)
    e = t.math('MULTIPLY', t.edge(0.003, 3.0), open_)
    wearm = t.mrange(t.mad(t.math('SUBTRACT', t.noise(30.0, 3, 0.6, co), 0.5), 1.1, e), 0.45, 0.7)
    col = t.mix(t.math('MULTIPLY', wearm, 0.75), col, _lin(_sc(light, 1.18, 0.05)))
    sc = t.math('MAXIMUM', t.scratches(110.0, 0.018, 0.15, seed + 7, (25, 0, 0), 0.2), t.scratches(80.0, 0.016, 0.12, seed + 8, (-50, 0, 0), 0.2))
    col = t.mix(t.math('MULTIPLY', sc, 0.5), col, _lin(_sc(light, 1.25, 0.04)))
    cav = t.cavity(0.009, 1.6)
    col = t.mix(t.math('MULTIPLY', cav, 0.75), col, _lin((0.06, 0.035, 0.02)))
    grime = t.math('MULTIPLY', t.mrange(t.noise(12.0, 3, 0.6, co), 0.5, 0.8), 0.25)
    col = t.mix(grime, col, _lin(_sc(dark, 0.55)))
    r = t.mad(t.math('SUBTRACT', big, 0.5), 0.12, rough)
    r = t.mad(wearm, 0.35 * lacquer, t.mad(sc, 0.15, t.mad(porem, 0.1, t.mad(cav, 0.15, t.mad(grime, 0.2, r)))))
    h = t.mad(porem, -5e-5, t.mad(late, -2e-5, t.mad(fib, -2e-5, t.mad(dents, -8e-5, t.math('MULTIPLY', sc, -3e-5)))))
    if ply is not None:
        h = t.mad(ply, -6e-6, h)
    t.finish(col, r, 0.0, h)
    return m


def m_bakelite(name, a, b, rough=0.38, checker=False, marble=1.0):
    """Phenolic (bakelite) / polymer furniture (sRGB): swirled marbling, slightly glossy, rubbed lighter edges, scuffs,
    grime in grooves. checker=True adds the diamond checkering of AK / Makarov grip panels (pattern in the YZ plane,
    side faces only) to colour and height."""
    m = bpy.data.materials.new(name); t = _NT(m)
    m['bevel'] = 0.0009
    co = t.coord()
    n1 = t.noise(18.0, 4, 0.6, co, distort=1.6)
    n2 = t.noise(160.0, 2, 0.5, co)
    swirl = t.mrange(t.noise(9.0, 3, 0.55, t.coord((1, 0.4, 1)), distort=3.0), 0.35, 0.75)
    col = t.mix(t.mad(n1, 0.7, t.math('MULTIPLY', n2, 0.3)), _lin(a), _lin(b))
    col = t.mix(t.math('MULTIPLY', swirl, 0.35 * marble), col, _lin(_sc(b, 0.75)))
    h = t.math('MULTIPLY', t.math('SUBTRACT', n2, 0.5), 4e-6)
    side = None
    if checker:
        grooves = None
        for ang in (45.0, -45.0):
            w = t.node('ShaderNodeTexWave', wave_type='BANDS', bands_direction='Z', wave_profile='SIN')
            w.inputs['Scale'].default_value = 100.0
            w.inputs['Distortion'].default_value = 0.0
            t.link(t.coord(rot=(ang, 0, 0)), w.inputs['Vector'])
            g = t.mrange(w.outputs['Fac'], 0.62, 0.9)
            grooves = g if grooves is None else t.math('MAXIMUM', grooves, g)
        geo = t.node('ShaderNodeNewGeometry'); sx = t.node('ShaderNodeSeparateXYZ')
        t.link(geo.outputs['Normal'], sx.inputs[0])
        side = t.mrange(t.math('ABSOLUTE', sx.outputs['X']), 0.7, 0.85)
        gm = t.math('MULTIPLY', grooves, side)
        col = t.mix(t.math('MULTIPLY', gm, 0.55), col, _lin(_sc(b, 0.45)))
        h = t.mad(gm, -2.2e-4, h)
    open_ = t.mrange(t.ao(0.008), 0.55, 0.95)
    e = t.math('MULTIPLY', t.edge(0.0016, 4.0), open_)
    col = t.mix(t.math('MULTIPLY', e, 0.5), col, _lin(_sc(a, 1.3, 0.03)))
    sc = t.math('MAXIMUM', t.scratches(130.0, 0.018, 0.2, 11, (15, 0, 0), 0.18), t.scratches(90.0, 0.016, 0.15, 12, (-40, 0, 0), 0.2))
    col = t.mix(t.math('MULTIPLY', sc, 0.55), col, _lin(_sc(a, 1.35, 0.05)))
    cav = t.cavity(0.006, 1.6)
    col = t.mix(t.math('MULTIPLY', cav, 0.7), col, _lin((0.05, 0.03, 0.02)))
    dust = t.math('MULTIPLY', t.mrange(t.noise(10.0, 3, 0.6, co), 0.55, 0.8), 0.18)
    col = t.mix(dust, col, _lin((0.45, 0.38, 0.3)))
    r = t.mad(e, -0.08, t.mad(cav, 0.2, t.mad(sc, 0.18, t.mad(dust, 0.3, rough))))
    h = t.mad(sc, -3e-5, h)
    t.finish(col, r, 0.0, h)
    return m


def m_flat(name, rgb, rough=0.5, metal=0.0, var=0.08):
    m = bpy.data.materials.new(name); t = _NT(m)
    n = t.noise(40.0, 3, 0.5, t.coord())
    col = t.mix(n, _lin(_sc(rgb, 1 - var)), _lin(_sc(rgb, 1 + var)))
    cav = t.cavity(0.006, 1.2)
    col = t.mix(t.math('MULTIPLY', cav, 0.5), col, _lin(_sc(rgb, 0.4)))
    t.finish(col, t.mad(t.math('SUBTRACT', n, 0.5), 0.1, rough), metal, t.math('MULTIPLY', t.math('SUBTRACT', n, 0.5), 3e-6))
    return m


def palette():
    """Part materials (sRGB colours). Keys are used by the builders."""
    P = {}
    P['steel'] = m_steel('blued_steel', (0.18, 0.18, 0.176), (0.62, 0.62, 0.6), 1.0, 0.45, 0.7, 0.0)
    P['steel2'] = m_steel('black_steel', (0.16, 0.16, 0.158), (0.55, 0.55, 0.54), 0.8, 0.5, 0.65, 3.0)
    P['mag_steel'] = m_steel('mag_steel', (0.2, 0.2, 0.2), (0.6, 0.6, 0.6), 0.9, 0.45, 0.7, 6.0)
    P['bright'] = m_steel('bright_steel', (0.42, 0.42, 0.41), (0.68, 0.68, 0.67), 0.6, 0.32, 0.9, 9.0, 0.5)
    P['phos'] = m_steel('phosphate', (0.15, 0.15, 0.148), (0.4, 0.4, 0.39), 0.4, 0.58, 0.5, 12.0)
    # AKM laminated birch, orange-red lacquer; Type 56 darker solid birch; RPG heat guard; generic red wood.
    P['plum'] = m_wood('wood_laminate', (0.62, 0.21, 0.06), (0.3, 0.07, 0.022), laminate=True, rough=0.28)
    P['wood_dark'] = m_wood('wood_dark', (0.45, 0.22, 0.1), (0.17, 0.07, 0.03), rough=0.34, seed=4.0)
    P['wood'] = m_wood('wood_red', (0.58, 0.28, 0.12), (0.26, 0.1, 0.045), seed=2.0)
    P['wood_light'] = m_wood('wood_light', (0.62, 0.32, 0.15), (0.33, 0.13, 0.06), seed=3.0)
    P['wood_rpg'] = m_wood('wood_rpg', (0.52, 0.19, 0.08), (0.28, 0.07, 0.035), rough=0.3, ring_scale=60.0, seed=5.0)
    P['bakelite'] = m_bakelite('bakelite', (0.6, 0.21, 0.065), (0.44, 0.12, 0.04))
    P['plum_poly'] = m_bakelite('plum_polymer', (0.36, 0.13, 0.08), (0.23, 0.07, 0.045), 0.45)
    P['grip_ak'] = m_bakelite('grip_bakelite', (0.52, 0.17, 0.055), (0.34, 0.09, 0.035), 0.36, checker=True)
    P['grip_pm'] = m_bakelite('grip_pm', (0.2, 0.09, 0.05), (0.12, 0.05, 0.03), 0.45, checker=True, marble=0.5)
    P['olive'] = m_paint('olive_paint', (0.3, 0.32, 0.19))
    P['olive_dk'] = m_paint('olive_dark', (0.19, 0.21, 0.13))
    P['grey_paint'] = m_paint('grey_paint', (0.36, 0.36, 0.34))
    P['warhead'] = m_paint('warhead_paint', (0.16, 0.18, 0.12), chips=0.6)
    P['brass'] = m_flat('brass', (0.72, 0.52, 0.22), 0.3, 1.0)
    P['steel_case'] = m_flat('lacquered_case', (0.42, 0.34, 0.2), 0.35, 0.8)
    P['copper'] = m_flat('copper', (0.72, 0.4, 0.24), 0.32, 1.0)
    P['rubber'] = m_flat('rubber', (0.06, 0.06, 0.06), 0.85, 0.0, 0.05)
    P['glass'] = m_flat('lens', (0.05, 0.08, 0.12), 0.05, 0.5, 0.0)
    P['shadow'] = m_flat('shadow', (0.025, 0.025, 0.025), 0.9, 0.0, 0.0)
    P['yellow'] = m_paint('yellow_paint', (0.72, 0.6, 0.1), chips=0.5)
    P['red'] = m_flat('red_plastic', (0.6, 0.06, 0.05), 0.5)
    P['wire_y'] = m_flat('wire_yellow', (0.75, 0.62, 0.08), 0.45)
    P['tape'] = m_flat('black_tape', (0.06, 0.06, 0.065), 0.55)
    P['plastic'] = m_flat('black_plastic', (0.07, 0.07, 0.075), 0.5)
    P['plastic_g'] = m_flat('grey_plastic', (0.3, 0.3, 0.32), 0.45)
    P['screen'] = m_flat('screen', (0.2, 0.3, 0.22), 0.15, 0.0, 0.0)
    P['canvas'] = m_flat('canvas', (0.42, 0.38, 0.26), 0.9)
    P['white'] = m_flat('white_paint', (0.78, 0.76, 0.7), 0.6)
    return P


# ------------------------------------------------------------------ stamped markings (height + darker fill)
_GLYPHS = {
    'A': '01110100011000111111100011000110001', 'B': '11110100011000111110100011000111110',
    'C': '01110100011000010000100001000101110', 'D': '11110100011000110001100011000111110',
    'E': '11111100001000011110100001000011111', 'H': '10001100011000111111100011000110001',
    'K': '10001100101010011000101001001010001', 'M': '10001110111010110101100011000110001',
    'O': '01110100011000110001100011000101110', 'P': '11110100011000111110100001000010000',
    'T': '11111001000010000100001000010000100', 'X': '10001100010101000100010101000110001',
    'Y': '10001100010101000100001000010000100', 'C': '01110100011000010000100001000101110',
    'S': '01111100001000001110000010000111110', 'N': '10001100011100110101100111000110001',
    'Д': '00110010100101001010010101111110001', 'Ж': '10101101010111000100011101010110101',
    'И': '10001100011001110101110011000110001', 'Л': '00111010010100101001010010100110001',
    'П': '11111100011000110001100011000110001', 'Б': '11111100001000011110100011000111110',
    'Г': '11111100001000010000100001000010000', 'Ф': '00100011101010110101011100010000100',
    '0': '01110100011001110101110011000101110', '1': '00100011000010000100001000010001110',
    '2': '01110100010000100010001000100011111', '3': '11111000100010000010000011000101110',
    '4': '00010001100101010010111110001000010', '5': '11111100001111000001000011000101110',
    '6': '00110010001000011110100011000101110', '7': '11111000010001000100010000100001000',
    '8': '01110100011000101110100011000101110', '9': '01110100011000101111000010001001100',
    '.': '00000000000000000000000000110001100', '-': '00000000000000011111000000000000000',
    '*': '00100001001111101110011100110110001', '^': '00100001000101001010100011111100000',
    ' ': '0' * 35, '#': '1' * 35, '=': '11111000001111100000111110000011111',
}


_GLYPHS.update({'А': _GLYPHS['A'], 'В': _GLYPHS['B'], 'Е': _GLYPHS['E'], 'О': _GLYPHS['O'], 'С': _GLYPHS['C'],
                'Р': _GLYPHS['P'], 'Т': _GLYPHS['T'], 'Х': _GLYPHS['X'], 'Н': _GLYPHS['H'], 'К': _GLYPHS['K'],
                'М': _GLYPHS['M'], 'З': _GLYPHS['3']})


def _text_mask(text, px):
    """Rasterise text (lines separated by \\n) with a 5x7 stamp font (Latin, digits, some Cyrillic), px pixels per
    font cell. Returns an (h, w) array, row 0 at the top."""
    lines = text.split('\n')
    W = max(len(l) for l in lines) * 6 - 1
    H = len(lines) * 9 - 2
    g = np.zeros((H, W), np.float32)
    for li, line in enumerate(lines):
        for ci, ch in enumerate(line.upper()):
            bits = _GLYPHS.get(ch, _GLYPHS[' '])
            for r in range(7):
                for c in range(5):
                    if bits[r * 5 + c] == '1':
                        g[li * 9 + r, ci * 6 + c] = 1
    return np.kron(g, np.ones((px, px), np.float32))


def add_stamps(root, stamps, ppm=12000.0, depth=1.2e-4):
    """Stamped / engraved markings on the body mesh: each stamp dict(text, y, z, h, side) is placed in root space
    (metres, text centred on (y, z), letter height h, side +1 = right face, -1 = left face) and projected along X onto
    faces of the body whose normal points that way. Adds the mask to every body material: height -depth, base colour
    darker (oil in the recess). Must run before bake_weapon()."""
    body = next(o for o in root.children if o.type == 'MESH' and o.name.endswith('_body'))
    body.pass_index = 1
    for side in (1, -1):
        ss = [d for d in stamps if d['side'] == side]
        if not ss:
            continue
        rast = []
        for d in ss:
            px = max(1, int(round(d['h'] / 7.0 * ppm)))
            rast.append((d, _text_mask(d['text'], px)))
        y0 = min(d['y'] - m.shape[1] / ppm / 2 for d, m in rast) - 0.002
        y1 = max(d['y'] + m.shape[1] / ppm / 2 for d, m in rast) + 0.002
        z0 = min(d['z'] - m.shape[0] / ppm / 2 for d, m in rast) - 0.002
        z1 = max(d['z'] + m.shape[0] / ppm / 2 for d, m in rast) + 0.002
        Wp, Hp = int((y1 - y0) * ppm) + 1, int((z1 - z0) * ppm) + 1
        R = np.zeros((Hp, Wp), np.float32)
        for d, mk in rast:
            mh, mw = mk.shape
            cu = (d['y'] - y0) * ppm if side > 0 else (y1 - d['y']) * ppm
            cv = (d['z'] - z0) * ppm
            c0, r0 = int(cu - mw / 2), int(cv - mh / 2)
            R[r0:r0 + mh, c0:c0 + mw] = np.maximum(R[r0:r0 + mh, c0:c0 + mw], mk[::-1, :])
        # Soften (stamp edges are rounded) then store.
        Rb = R.copy()
        for ax in (0, 1):
            Rb = (np.roll(Rb, 1, ax) + Rb * 2 + np.roll(Rb, -1, ax)) / 4
        img = bpy.data.images.new(f'{root.name}_stamps_{side}', Wp, Hp, alpha=False, float_buffer=True)
        img.colorspace_settings.name = 'Non-Color'
        px = np.ones((Hp, Wp, 4), np.float32); px[..., 0] = Rb; px[..., 1] = Rb; px[..., 2] = Rb
        img.pixels.foreach_set(px.ravel())
        print(f'  stamps side {side:+d}: {len(ss)} marks, {Wp}x{Hp} px, y {y0:.4f}..{y1:.4f} z {z0:.4f}..{z1:.4f}, ink {float(R.mean()):.3f}')
        mats = {s.material for s in body.material_slots if s.material and 'OUT_HEIGHT' in s.material.node_tree.nodes}
        for m in mats:
            nt = m.node_tree
            N, L = nt.nodes, nt.links
            tc = N.new('ShaderNodeTexCoord'); sep = N.new('ShaderNodeSeparateXYZ'); L.new(tc.outputs['Object'], sep.inputs[0])
            mu = N.new('ShaderNodeMath'); mu.operation = 'MULTIPLY_ADD'; L.new(sep.outputs['Y'], mu.inputs[0])
            mu.inputs[1].default_value = side / (y1 - y0)
            mu.inputs[2].default_value = -y0 / (y1 - y0) if side > 0 else y1 / (y1 - y0)
            mv = N.new('ShaderNodeMath'); mv.operation = 'MULTIPLY_ADD'; L.new(sep.outputs['Z'], mv.inputs[0])
            mv.inputs[1].default_value = 1.0 / (z1 - z0); mv.inputs[2].default_value = -z0 / (z1 - z0)
            cb = N.new('ShaderNodeCombineXYZ'); L.new(mu.outputs[0], cb.inputs['X']); L.new(mv.outputs[0], cb.inputs['Y'])
            ti = N.new('ShaderNodeTexImage'); ti.image = img; ti.extension = 'CLIP'; ti.interpolation = 'Cubic'
            L.new(cb.outputs[0], ti.inputs['Vector'])
            geo = N.new('ShaderNodeNewGeometry'); sn = N.new('ShaderNodeSeparateXYZ'); L.new(geo.outputs['Normal'], sn.inputs[0])
            fx = N.new('ShaderNodeMath'); fx.operation = 'GREATER_THAN' if side > 0 else 'LESS_THAN'
            fx.inputs[1].default_value = 0.6 * side; L.new(sn.outputs['X'], fx.inputs[0])
            oi = N.new('ShaderNodeObjectInfo')
            cmp_ = N.new('ShaderNodeMath'); cmp_.operation = 'COMPARE'; cmp_.inputs[1].default_value = 1.0; cmp_.inputs[2].default_value = 0.2
            L.new(oi.outputs['Object Index'], cmp_.inputs[0])
            k1 = N.new('ShaderNodeMath'); k1.operation = 'MULTIPLY'; L.new(fx.outputs[0], k1.inputs[0]); L.new(cmp_.outputs[0], k1.inputs[1])
            k2 = N.new('ShaderNodeMath'); k2.operation = 'MULTIPLY'; L.new(k1.outputs[0], k2.inputs[0]); L.new(ti.outputs['Color'], k2.inputs[1])
            mask = k2.outputs[0]
            # Height: insert before OUT_HEIGHT.
            for name, kind in (('OUT_HEIGHT', 'h'), ('OUT_BASE', 'c'), ('OUT_ROUGH', 'r')):
                rr = N[name]
                src = rr.inputs[0].links[0].from_socket
                if kind == 'h':
                    n = N.new('ShaderNodeMath'); n.operation = 'MULTIPLY_ADD'; L.new(mask, n.inputs[0]); n.inputs[1].default_value = -depth
                    L.new(src, n.inputs[2]); out = n.outputs[0]
                elif kind == 'c':
                    k = N.new('ShaderNodeMath'); k.operation = 'MULTIPLY'; L.new(mask, k.inputs[0]); k.inputs[1].default_value = 0.85
                    n = N.new('ShaderNodeMix'); n.data_type = 'RGBA'; n.clamp_factor = True
                    L.new(k.outputs[0], n.inputs[0]); L.new(src, n.inputs[6]); n.inputs[7].default_value = (0.012, 0.011, 0.01, 1)
                    out = n.outputs[2]
                else:
                    n = N.new('ShaderNodeMath'); n.operation = 'MULTIPLY_ADD'; L.new(mask, n.inputs[0]); n.inputs[1].default_value = 0.15
                    L.new(src, n.inputs[2]); out = n.outputs[0]
                L.new(out, rr.inputs[0])


# ------------------------------------------------------------------ texel density
# Linear texel-density factor per part name (prefix match): the large visible faces seen at first-person distance get
# more of the atlas, hidden cores / internals less. Stored per face ('uvw') in Build.finish, applied per UV island.
UVW = [('rcv_core', 0.35), ('carrier_cut', 0.5), ('bolt_carrier', 0.7), ('rcv_skin', 1.7), ('dust_cover', 1.6),
       ('cut_floor', 1.2), ('guide_tab', 1.3), ('rs_', 1.5), ('notch_plate', 1.6), ('selector', 1.5), ('feed_cover', 1.5),
       ('cover_hump', 1.4), ('rcv_top_rear', 1.5), ('trunnion', 1.2), ('hg_retainer', 1.3), ('mag_body', 1.25),
       ('mag_rib', 1.1), ('upper_handguard', 1.15), ('lower_handguard', 1.15), ('handguard', 1.15), ('slide', 1.5),
       ('serration', 0.8), ('grip', 1.1), ('stock', 0.95), ('scope', 1.2), ('eyepiece', 1.3), ('turret', 1.2),
       ('fluted', 0.9), ('cyl', 1.0), ('ammo_box', 0.9), ('box_skin', 0.9), ('rivet', 1.0), ('tick', 0.6)]


def uv_weight(name):
    n = name.split('.')[0]
    for k, w in UVW:
        if n.startswith(k):
            return w
    return 1.0


def _scale_islands(o):
    """Scale each UV island about its centre by the mean 'uvw' of its faces (pack_islands keeps relative scale)."""
    me = o.data
    if 'uvw' not in me.attributes:
        return
    bm = bmesh.new()
    bm.from_mesh(me)
    uv = bm.loops.layers.uv.active
    wl = bm.faces.layers.float.get('uvw')
    if uv is None or wl is None:
        bm.free()
        return
    bm.faces.ensure_lookup_table()
    parent = list(range(len(bm.faces)))
    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for e in bm.edges:
        if len(e.link_faces) != 2:
            continue
        f1, f2 = e.link_faces
        def uvs(f):
            d = {}
            for lp in f.loops:
                d[lp.vert.index] = lp[uv].uv.copy()
            return d
        a, b_ = uvs(f1), uvs(f2)
        if all((a[v.index] - b_[v.index]).length < 1e-6 for v in e.verts):
            ra, rb = find(f1.index), find(f2.index)
            if ra != rb:
                parent[ra] = rb
    isl = {}
    for f in bm.faces:
        isl.setdefault(find(f.index), []).append(f)
    for fs in isl.values():
        w = sum(f[wl] for f in fs) / len(fs)
        if abs(w - 1.0) < 1e-3:
            continue
        c = Vector((0.0, 0.0)); n = 0
        for f in fs:
            for lp in f.loops:
                c += lp[uv].uv; n += 1
        c /= n
        done = set()
        for f in fs:
            for lp in f.loops:
                if id(lp) in done:
                    continue
                lp[uv].uv = c + (lp[uv].uv - c) * w
    bm.to_mesh(me)
    bm.free()


# ------------------------------------------------------------------ bake
def _materials(objs):
    mats = []
    for o in objs:
        for s in o.material_slots:
            if s.material and s.material not in mats:
                mats.append(s.material)
    return mats


def _clear_bake_nodes(m):
    N = m.node_tree.nodes
    for n in [n for n in N if n.name.startswith('BAKE_')]:
        N.remove(n)


def _bake_setup(objs, img, mode):
    for m in _materials(objs):
        nt = m.node_tree
        N, L = nt.nodes, nt.links
        _clear_bake_nodes(m)
        im = N.new('ShaderNodeTexImage'); im.name = 'BAKE_IMG'; im.image = img
        out = N['Material Output']
        bsdf = N['Principled BSDF']
        if mode == 'normal':
            bev = N.new('ShaderNodeBevel'); bev.name = 'BAKE_BEV'; bev.samples = 8
            bev.inputs['Radius'].default_value = m.get('bevel', 0.0008)
            bump = N.new('ShaderNodeBump'); bump.name = 'BAKE_BUMP'
            bump.inputs['Strength'].default_value = 1.0
            bump.inputs['Distance'].default_value = 1.0
            L.new(N['OUT_HEIGHT'].outputs[0], bump.inputs['Height'])
            L.new(bev.outputs['Normal'], bump.inputs['Normal'])
            L.new(bump.outputs['Normal'], bsdf.inputs['Normal'])
            L.new(bsdf.outputs[0], out.inputs['Surface'])
        else:
            for l in list(bsdf.inputs['Normal'].links):
                L.remove(l)
            em = N.new('ShaderNodeEmission'); em.name = 'BAKE_EM'
            if mode == 'base':
                L.new(N['OUT_BASE'].outputs[0], em.inputs['Color'])
            else:
                cc = N.new('ShaderNodeCombineColor'); cc.name = 'BAKE_CC'
                cc.inputs[0].default_value = 1.0
                L.new(N['OUT_ROUGH'].outputs[0], cc.inputs[1])
                L.new(N['OUT_METAL'].outputs[0], cc.inputs[2])
                L.new(cc.outputs[0], em.inputs['Color'])
            L.new(em.outputs[0], out.inputs['Surface'])
        for n in N:
            n.select = False
        im.select = True
        N.active = im


def _save_pack(img, name, fmt='PNG'):
    d = os.path.join(tempfile.gettempdir(), f'wins_{os.getpid()}')
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, f'{name}.png')
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()
    cs = img.colorspace_settings.name
    bpy.data.images.remove(img)
    out = bpy.data.images.load(path)
    out.name = name
    out.colorspace_settings.name = cs
    out.pack()
    return out


def _soften(img, size, centre=2.0):
    """Light 3x3 blur to remove bake sampling noise."""
    a = np.empty(size * size * 4, np.float32)
    img.pixels.foreach_get(a)
    a = a.reshape(size, size, 4)
    b = a.copy()
    acc = np.zeros_like(a[..., :3])
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            acc += np.roll(np.roll(a[..., :3], dy, 0), dx, 1) * (centre if dx == 0 and dy == 0 else 1.0)
    b[..., :3] = acc / (8.0 + centre)
    img.pixels.foreach_set(b.ravel())


def _renorm(img, size):
    a = np.empty(size * size * 4, np.float32)
    img.pixels.foreach_get(a)
    a = a.reshape(size, size, 4)
    v = a[..., :3] * 2 - 1
    n = np.linalg.norm(v, axis=-1, keepdims=True)
    v = np.where(n > 1e-4, v / np.maximum(n, 1e-4), np.array((0, 0, 1), np.float32))
    a[..., :3] = v * 0.5 + 0.5
    img.pixels.foreach_set(a.ravel())


def bake_weapon(root, size=1024, samples=12, margin=None, orm_size=None, log=print):
    """Unwrap all meshes under root into one atlas, bake normal + base colour + metallic/roughness, assign one glTF
    material. size = base colour / normal resolution, orm_size = metallic-roughness resolution (default = size, capped
    at 1024)."""
    import time
    t0 = time.time()
    objs = [o for o in root.children_recursive if o.type == 'MESH']
    s = bpy.context.scene
    s.render.engine = 'CYCLES'
    s.cycles.device = 'CPU'
    s.cycles.samples = samples
    s.cycles.use_denoising = False
    margin = margin if margin is not None else max(4, size // 256)
    s.render.bake.margin = margin
    s.render.bake.margin_type = 'EXTEND'
    for o in objs:
        me = o.data
        bm = bmesh.new()
        bm.from_mesh(me)
        ng = [f for f in bm.faces if len(f.verts) > 4]
        if ng:
            bmesh.ops.triangulate(bm, faces=ng, quad_method='BEAUTY', ngon_method='BEAUTY')
        bm.to_mesh(me)
        bm.free()
        while me.uv_layers:
            me.uv_layers.remove(me.uv_layers[0])
        me.uv_layers.new(name='UVMap')
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(52), island_margin=0.003, area_weight=0.0, correct_aspect=True,
                             scale_to_bounds=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    for o in objs:
        _scale_islands(o)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.select_all(action='SELECT')
    try:
        bpy.ops.uv.pack_islands(rotate=True, margin=0.004 if size > 1024 else 0.006)
    except Exception:
        pass
    bpy.ops.object.mode_set(mode='OBJECT')
    rid = root.name
    nrm = bpy.data.images.new(f'{rid}_normal', size, size, alpha=False, is_data=True)
    nrm.colorspace_settings.name = 'Non-Color'
    base = bpy.data.images.new(f'{rid}_basecolor', size, size, alpha=False)
    orm = bpy.data.images.new(f'{rid}_metalrough', size, size, alpha=False, is_data=True)
    orm.colorspace_settings.name = 'Non-Color'
    for img, mode in ((nrm, 'normal'), (base, 'base'), (orm, 'orm')):
        _bake_setup(objs, img, mode)
        if mode == 'normal':
            bpy.ops.object.bake(type='NORMAL', normal_space='TANGENT', use_clear=True, margin=margin)
            _soften(img, size, 4.0)
            _renorm(img, size)
        else:
            bpy.ops.object.bake(type='EMIT', use_clear=True, margin=margin)
            _soften(img, size)
        log(f'  baked {mode} {size}px in {time.time() - t0:.0f}s')
    osz = orm_size or min(size, 1024)
    if osz != size:
        orm.scale(osz, osz)
    nrm = _save_pack(nrm, f'{rid}_normal')
    base = _save_pack(base, f'{rid}_basecolor')
    orm = _save_pack(orm, f'{rid}_metalrough')
    for m in _materials(objs):
        _clear_bake_nodes(m)
    m = bpy.data.materials.new(f'{rid}_mat')
    m.use_nodes = True
    N, L = m.node_tree.nodes, m.node_tree.links
    b = N['Principled BSDF']
    tb = N.new('ShaderNodeTexImage'); tb.image = base
    tm = N.new('ShaderNodeTexImage'); tm.image = orm
    tn = N.new('ShaderNodeTexImage'); tn.image = nrm
    nm = N.new('ShaderNodeNormalMap'); nm.space = 'TANGENT'
    sep = N.new('ShaderNodeSeparateColor')
    L.new(tb.outputs['Color'], b.inputs['Base Color'])
    L.new(tm.outputs['Color'], sep.inputs['Color'])
    L.new(sep.outputs['Green'], b.inputs['Roughness'])
    L.new(sep.outputs['Blue'], b.inputs['Metallic'])
    L.new(tn.outputs['Color'], nm.inputs['Color'])
    L.new(nm.outputs['Normal'], b.inputs['Normal'])
    for o in objs:
        me = o.data
        me.materials.clear()
        me.materials.append(m)
        for p in me.polygons:
            p.material_index = 0
    bpy.ops.object.select_all(action='DESELECT')
    return m


# ------------------------------------------------------------------ mesh builders
def _new_obj(bm, name, m, bevel=0.0, seg=3, recalc=True):
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-7)
    if recalc:
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    if m is not None:
        me.materials.append(m)
    for p in me.polygons:
        p.use_smooth = True
    if bevel:
        mod = o.modifiers.new('bevel', 'BEVEL')
        mod.width = bevel
        mod.segments = seg
        mod.limit_method = 'ANGLE'
        mod.angle_limit = math.radians(35)
    return o


def loft(rings, m, name='loft', cap0=True, cap1=True, bevel=0.0, closed=False):
    """Skin a list of rings (each a list of 3D points with equal counts). Caps both ends with n-gons."""
    bm = bmesh.new()
    vr = [[bm.verts.new(p) for p in r] for r in rings]
    n = len(vr[0])
    pairs = list(zip(vr[:-1], vr[1:])) + ([(vr[-1], vr[0])] if closed else [])
    for a, b in pairs:
        for i in range(n):
            j = (i + 1) % n
            try:
                bm.faces.new((a[i], a[j], b[j], b[i]))
            except ValueError:
                pass
    if not closed:
        if cap0:
            bm.faces.new(vr[0])
        if cap1:
            bm.faces.new(list(reversed(vr[-1])))
    return _new_obj(bm, name, m, bevel)


def se(w, h, p=2.5, n=24, cx=0.0, cz=0.0, a0=-math.pi / 2):
    """Superellipse section (width w, height h, exponent p: 2 = ellipse, large = rectangle). Returns [(x, z)]."""
    out = []
    for k in range(n):
        t = a0 + 2 * math.pi * k / n
        c, s = math.cos(t), math.sin(t)
        out.append((cx + w / 2 * math.copysign(abs(c) ** (2 / p), c), cz + h / 2 * math.copysign(abs(s) ** (2 / p), s)))
    return out


def arch(w, z0, z1, zr, n=10, p=2.4, wb=None):
    """Flat-bottomed section with vertical sides and a rounded top: bottom z0, shoulder zr, crown z1. wb = bottom width."""
    a = w / 2
    ab = (wb if wb is not None else w) / 2
    pts = [(-ab, z0), (ab, z0)]
    for k in range(n + 1):
        t = math.pi * k / n
        c, s = math.cos(t), math.sin(t)
        pts.append((a * math.copysign(abs(c) ** (2 / p), c), zr + (z1 - zr) * abs(s) ** (2 / p)))
    return pts


def loft_y(secs, m, name='lofty', bevel=0.0, cap0=True, cap1=True, x=0.0):
    """secs: list of (y, [(x, z), ...]). Sections are XZ outlines placed at y."""
    return loft([[Vector((x + px, y, pz)) for px, pz in pts] for y, pts in secs], m, name, cap0, cap1, bevel)


def loft_z(secs, m, name='loftz', bevel=0.0):
    """secs: list of (z, [(x, y), ...])."""
    return loft([[Vector((px, py, z)) for px, py in pts] for z, pts in secs], m, name, True, True, bevel)


def loft_path(path, secs, m, name='loftp', bevel=0.0, x=0.0, cap0=True, cap1=True):
    """Sweep sections along a path in the YZ plane. path: [(y, z)], secs: [[(x, d)]] per path point (or a single one),
    where d is measured along the path normal (tangent rotated +90 deg: forward when the path runs down)."""
    rings = []
    N = len(path)
    for i, (py, pz) in enumerate(path):
        a = Vector(path[max(i - 1, 0)]); b = Vector(path[min(i + 1, N - 1)])
        t = (b - a).normalized()
        nrm = Vector((-t.y, t.x))
        per_point = isinstance(secs[0], list)
        sec = secs[i] if per_point else secs
        rings.append([Vector((x + sx, py + nrm.x * d, pz + nrm.y * d)) for sx, d in sec])
    return loft(rings, m, name, cap0, cap1, bevel)


def chaikin(pts, it=2, closed=False):
    """Corner-cutting smoothing of a 2D polyline (keeps the end points)."""
    for _ in range(it):
        out = [pts[0]]
        for a, b in zip(pts[:-1], pts[1:]):
            out.append((0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]))
            out.append((0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]))
        out.append(pts[-1])
        pts = out
    return pts


def arc_path(start, phi0, R, length, n=12, bend=1):
    """Path starting at start=(y, z) heading down, tilted phi0 radians forward, curving forward with radius R."""
    pts = []
    y, z = start
    ds = length / n
    for i in range(n + 1):
        s = i * ds
        phi = phi0 + bend * s / R
        if i == 0:
            pts.append((y, z))
        else:
            ph = phi0 + bend * (s - ds / 2) / R
            y += math.sin(ph) * ds
            z -= math.cos(ph) * ds
            pts.append((y, z))
    return pts


def lathe(profile, m, axis='Y', center=(0, 0, 0), seg=24, name='lathe', closed=False, bevel=0.0, a0=0.0):
    """Revolve [(r, s)] around an axis through center (s along the axis). r == 0 makes a pole.
    closed=True joins the last profile point to the first (hollow parts: outer surface then inner surface)."""
    cx, cy, cz = center
    def P(r, s, a):
        c, sn = r * math.cos(a), r * math.sin(a)
        if axis == 'Y':
            return Vector((cx + c, cy + s, cz + sn))
        if axis == 'Z':
            return Vector((cx + c, cy + sn, cz + s))
        return Vector((cx + s, cy + c, cz + sn))
    bm = bmesh.new()
    rings = []
    for r, s in profile:
        if r < 1e-7:
            rings.append([bm.verts.new(P(0, s, 0))])
        else:
            rings.append([bm.verts.new(P(r, s, a0 + 2 * math.pi * k / seg)) for k in range(seg)])
    pairs = list(zip(rings[:-1], rings[1:])) + ([(rings[-1], rings[0])] if closed else [])
    for A, B in pairs:
        if len(A) == 1 and len(B) == 1:
            continue
        if len(A) == 1:
            for k in range(seg):
                bm.faces.new((A[0], B[k], B[(k + 1) % seg]))
        elif len(B) == 1:
            for k in range(seg):
                bm.faces.new((A[k], B[0], A[(k + 1) % seg]))
        else:
            for k in range(seg):
                bm.faces.new((A[k], B[k], B[(k + 1) % seg], A[(k + 1) % seg]))
    if not closed:
        if len(rings[0]) > 1:
            bm.faces.new(rings[0])
        if len(rings[-1]) > 1:
            bm.faces.new(rings[-1])
    return _new_obj(bm, name, m, bevel)


def htube(r_out, r_in, y0, y1, m, x=0.0, z=0.0, seg=24, slant=0.0, name='htube', axis='Y'):
    """Hollow tube along an axis. slant shears the front face: y1 shifts by -slant * (z - z_axis) (AKM slant brake)."""
    if axis == 'Y':
        o = lathe([(r_in, y0), (r_out, y0), (r_out, y1), (r_in, y1)], m, 'Y', (x, 0, z), seg, name, closed=True)
        if slant:
            for v in o.data.vertices:
                if abs(v.co.y - y1) < 1e-6:
                    v.co.y -= slant * (v.co.z - z)
        return o
    return lathe([(r_in, y0), (r_out, y0), (r_out, y1), (r_in, y1)], m, axis, (x, 0, z) if axis == 'Z' else (0, x, z), seg, name, closed=True)


def xprism(pts_xz, y0, y1, m, name='xprism', bevel=0.0):
    """Extrude an XZ outline along Y from y0 to y1."""
    return loft([[Vector((px, y0, pz)) for px, pz in pts_xz], [Vector((px, y1, pz)) for px, pz in pts_xz]], m, name, True, True, bevel)


def zprism(pts_xy, z0, z1, m, name='zprism', bevel=0.0):
    """Extrude an XY outline along Z."""
    return loft([[Vector((px, py, z0)) for px, py in pts_xy], [Vector((px, py, z1)) for px, py in pts_xy]], m, name, True, True, bevel)


def sprism(profile, width, m, x=0.0, bevel=0.0, name='sprism'):
    """Side profile [(y, z)] extruded across X, centred on x (like common.side_prism, without operators)."""
    a = [Vector((x - width / 2, py, pz)) for py, pz in profile]
    b = [Vector((x + width / 2, py, pz)) for py, pz in profile]
    return loft([a, b], m, name, True, True, bevel)


def bx(size, loc, m, rot=(0, 0, 0), bevel=None, name='box'):
    """Box (no operators) with an optional bevel sized to the part."""
    sx, sy, sz = [s / 2 for s in size]
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
    R = (Matrix.Rotation(math.radians(rot[2]), 4, 'Z') @ Matrix.Rotation(math.radians(rot[1]), 4, 'Y') @
         Matrix.Rotation(math.radians(rot[0]), 4, 'X'))
    bmesh.ops.transform(bm, matrix=Matrix.Translation(loc) @ R, verts=bm.verts)
    if bevel is None:
        bevel = min(0.0015, min(size) * 0.18)
    return _new_obj(bm, name, m, bevel)


def cy(r, length, loc, m, axis='Y', seg=16, r2=None, name='cyl', bevel=0.0, rot=None):
    """Cylinder / cone centred at loc along an axis ('X', 'Y', 'Z'); rot (deg, XYZ) overrides the axis."""
    h = length / 2
    o = lathe([(0, -h), (r, -h), (r2 if r2 is not None else r, h), (0, h)], m, 'Z', (0, 0, 0), seg, name)
    if rot is None:
        rot = {'X': (0, 90, 0), 'Y': (-90, 0, 0), 'Z': (0, 0, 0)}[axis]
    R = (Matrix.Rotation(math.radians(rot[2]), 4, 'Z') @ Matrix.Rotation(math.radians(rot[1]), 4, 'Y') @
         Matrix.Rotation(math.radians(rot[0]), 4, 'X'))
    o.data.transform(Matrix.Translation(loc) @ R)
    if bevel:
        mod = o.modifiers.new('bevel', 'BEVEL'); mod.width = bevel; mod.segments = 2
        mod.limit_method = 'ANGLE'; mod.angle_limit = math.radians(35)
    return o


def cy_between(a, b, r, m, seg=12, name='rod', r2=None):
    """Cylinder from point a to point b."""
    a, b = Vector(a), Vector(b)
    d = b - a
    L = d.length
    o = lathe([(0, 0), (r, 0), (r2 if r2 is not None else r, L), (0, L)], m, 'Z', (0, 0, 0), seg, name)
    q = d.normalized().to_track_quat('Z', 'Y')
    o.data.transform(Matrix.Translation(a) @ q.to_matrix().to_4x4())
    return o


def tor(R, r, loc, m, axis='Z', seg=24, rseg=8, name='torus', arc=360.0, rot=None):
    """Torus (or partial torus arc) around an axis through loc."""
    bm = bmesh.new()
    full = arc >= 359.9
    n = seg if full else seg + 1
    rings = []
    for i in range(n):
        a = math.radians(arc) * i / seg
        ca, sa = math.cos(a), math.sin(a)
        ring = []
        for j in range(rseg):
            b = 2 * math.pi * j / rseg
            rr = R + r * math.cos(b)
            ring.append(bm.verts.new((rr * ca, rr * sa, r * math.sin(b))))
        rings.append(ring)
    pairs = list(zip(rings[:-1], rings[1:])) + ([(rings[-1], rings[0])] if full else [])
    for A, B in pairs:
        for j in range(rseg):
            k = (j + 1) % rseg
            bm.faces.new((A[j], B[j], B[k], A[k]))
    if not full:
        bm.faces.new(rings[0]); bm.faces.new(list(reversed(rings[-1])))
    if rot is None:
        rot = {'X': (0, 90, 0), 'Y': (90, 0, 0), 'Z': (0, 0, 0)}[axis]
    R4 = (Matrix.Rotation(math.radians(rot[2]), 4, 'Z') @ Matrix.Rotation(math.radians(rot[1]), 4, 'Y') @
          Matrix.Rotation(math.radians(rot[0]), 4, 'X'))
    bmesh.ops.transform(bm, matrix=Matrix.Translation(loc) @ R4, verts=bm.verts)
    return _new_obj(bm, name, m)


def ball(r, loc, m, scale=(1, 1, 1), seg=12, rings=8, name='ball'):
    prof = [(r * math.sin(math.pi * i / rings), -r * math.cos(math.pi * i / rings)) for i in range(rings + 1)]
    prof[0] = (0, -r); prof[-1] = (0, r)
    o = lathe(prof, m, 'Z', (0, 0, 0), seg, name)
    o.data.transform(Matrix.Translation(loc) @ Matrix.Diagonal((*scale, 1)))
    return o


def rivet(y, z, side, m, r=0.0024, x=0.0157):
    """Small dome-headed rivet on the side of a receiver (side = +1 right, -1 left)."""
    return ball(r, (side * x, y, z), m, (0.45, 1, 1), 8, 4, 'rivet')


def wire(points, r, m, seg=6, name='wire'):
    """Round wire through 3D points (simple sweep with averaged frames)."""
    pts = [Vector(p) for p in points]
    rings = []
    up = Vector((0, 0, 1))
    for i, p in enumerate(pts):
        a = pts[max(i - 1, 0)]; b = pts[min(i + 1, len(pts) - 1)]
        t = (b - a).normalized()
        ref = up if abs(t.dot(up)) < 0.9 else Vector((1, 0, 0))
        u = t.cross(ref).normalized(); v = t.cross(u).normalized()
        rings.append([p + (u * math.cos(2 * math.pi * k / seg) + v * math.sin(2 * math.pi * k / seg)) * r for k in range(seg)])
    return loft(rings, m, name)


def skin_x(side, x, y0, y1, z0, z1, m, step=0.003, disp=None, hole=None, zfn=None, name='skin', thick=0.0009):
    """Stamped sheet surface facing side*X at |x|, y0..y1 by z0..z1 (or zfn(y) -> (lo, hi)), solidified inwards by
    `thick` (so the sheet borders and port edges are real edges for the bevel / wear bake).
    disp(y, z) pushes vertices outward (+) / inward (-) for dimples and ribs; hole(y, z) skips cells (ports)."""
    sy, sz = step if isinstance(step, tuple) else (step, step)
    ny = max(2, int(round((y1 - y0) / sy))); nz = max(2, int(round((z1 - z0) / sz)))
    bm = bmesh.new(); V = {}
    for i in range(ny + 1):
        y = y0 + (y1 - y0) * i / ny
        lo, hi = zfn(y) if zfn else (z0, z1)
        for j in range(nz + 1):
            z = lo + (hi - lo) * j / nz
            dx = disp(y, z) if disp else 0.0
            V[i, j] = bm.verts.new((side * (x + dx), y, z))
    for i in range(ny):
        for j in range(nz):
            yc = y0 + (y1 - y0) * (i + 0.5) / ny
            lo, hi = zfn(yc) if zfn else (z0, z1)
            zc = lo + (hi - lo) * (j + 0.5) / nz
            if hole and hole(yc, zc):
                continue
            q = [V[i, j], V[i + 1, j], V[i + 1, j + 1], V[i, j + 1]]
            bm.faces.new(q if side > 0 else list(reversed(q)))
    if thick:
        # Rim only (no back face): extrude the boundary edges inwards so borders and port edges are real edges.
        bm.edges.ensure_lookup_table()
        inner = {}
        def iv(v):
            if v not in inner:
                inner[v] = bm.verts.new((v.co.x - side * thick, v.co.y, v.co.z))
            return inner[v]
        for e in [e for e in bm.edges if e.is_boundary]:
            f = e.link_faces[0]
            a, b_ = e.verts
            # Keep the winding consistent with the face: find the loop order of this edge in the face.
            for lp in f.loops:
                if lp.edge == e:
                    a, b_ = lp.vert, lp.link_loop_next.vert
                    break
            bm.faces.new((b_, a, iv(a), iv(b_)))
    return _new_obj(bm, name, m, recalc=False)


def _ray_poly(c, ang, poly):
    """Distance from c along direction ang to the far-most crossing of a closed polygon [(y, z)]."""
    dy, dz = math.cos(ang), math.sin(ang)
    best = None
    for (ay, az), (by, bz) in zip(poly, poly[1:] + poly[:1]):
        ey, ez = by - ay, bz - az
        den = dy * ez - dz * ey
        if abs(den) < 1e-12:
            continue
        t = ((ay - c[0]) * ez - (az - c[1]) * ey) / den
        u = ((ay - c[0]) * dz - (az - c[1]) * dy) / den
        if t > 0 and -1e-9 <= u <= 1 + 1e-9:
            best = t if best is None else max(best, t)
    return best


def ring_plate(outer, inner, width, m, x=0.0, n=72, bevel=0.0, name='ring_plate', c=None):
    """Side-profile plate with one hole (skeleton stocks), extruded across X. outer / inner: closed [(y, z)] outlines that
    are star-shaped about c (default: the hole centre). Both are resampled on the same rays so the face is a quad ring."""
    if c is None:
        c = (sum(p[0] for p in inner) / len(inner), sum(p[1] for p in inner) / len(inner))
    O, I = [], []
    for k in range(n):
        a = 2 * math.pi * k / n
        ro, ri = _ray_poly(c, a, outer), _ray_poly(c, a, inner)
        O.append((c[0] + ro * math.cos(a), c[1] + ro * math.sin(a)))
        I.append((c[0] + ri * math.cos(a), c[1] + ri * math.sin(a)))
    bm = bmesh.new()
    h = width / 2
    vo = [[bm.verts.new((x + sx * h, py, pz)) for py, pz in O] for sx in (-1, 1)]
    vi = [[bm.verts.new((x + sx * h, py, pz)) for py, pz in I] for sx in (-1, 1)]
    for k in range(n):
        j = (k + 1) % n
        for side in (0, 1):
            bm.faces.new((vo[side][k], vo[side][j], vi[side][j], vi[side][k]))
        bm.faces.new((vo[0][k], vo[1][k], vo[1][j], vo[0][j]))
        bm.faces.new((vi[0][k], vi[0][j], vi[1][j], vi[1][k]))
    return _new_obj(bm, name, m, bevel)


# ------------------------------------------------------------------ build / finalise
class Build:
    """Collects the parts of one weapon. Parts are modelled in a convenient build frame; finish() shifts everything so the
    origin sits at `offset` (the firing-hand grip point), joins parts per group into child meshes and adds the empties."""
    def __init__(self, rid):
        reset()
        clear_mats()
        self.rid = rid
        self.cur = 'body'
        self.empties = []
        self.stamps = []
        self.P = palette()

    def _tag(self):
        for o in bpy.context.scene.objects:
            if o.type == 'MESH' and 'grp' not in o:
                o['grp'] = self.cur

    def group(self, name):
        self._tag()
        self.cur = name

    def stamp(self, text, y, z, h, side):
        """Stamped marking on the body (build frame, see add_stamps)."""
        self.stamps.append(dict(text=text, y=y, z=z, h=h, side=side))

    def E(self, name, loc, parent=None):
        """Empty at loc (build frame). parent = name of a child-mesh group (e.g. 'mag', 'charge'): the empty becomes
        a child of that mesh so it follows it when animated."""
        self.empties.append((name, Vector(loc), parent))

    def finish(self, offset=(0, 0, 0), origins=None, smooth_angle=38.0):
        self._tag()
        origins = origins or {}
        off = Vector(offset)
        dg = bpy.context.evaluated_depsgraph_get()
        groups = {}
        for o in list(bpy.context.scene.objects):
            if o.type != 'MESH':
                continue
            g = o['grp']
            me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
            me.transform(Matrix.Translation(-off) @ o.matrix_world)
            at = me.attributes.new('uvw', 'FLOAT', 'FACE')
            w = uv_weight(o.name)
            at.data.foreach_set('value', [w] * len(me.polygons))
            n = bpy.data.objects.new(o.name + '_x', me)
            bpy.context.scene.collection.objects.link(n)
            groups.setdefault(g, []).append(n)
        for o in list(bpy.context.scene.objects):
            if o.type == 'MESH' and 'grp' in o:
                bpy.data.objects.remove(o, do_unlink=True)
        for o in list(bpy.context.scene.objects):
            if o.type == 'EMPTY':
                bpy.data.objects.remove(o, do_unlink=True)
        root = bpy.data.objects.new(self.rid, None)
        bpy.context.scene.collection.objects.link(root)
        out = {}
        for g, objs in groups.items():
            bpy.ops.object.select_all(action='DESELECT')
            for o in objs:
                o.select_set(True)
            bpy.context.view_layer.objects.active = objs[0]
            if len(objs) > 1:
                bpy.ops.object.join()
            j = bpy.context.view_layer.objects.active
            j.name = g if g != 'body' else f'{self.rid}_body'
            j.data.name = j.name
            _uv_and_normals(j, smooth_angle)
            if g in origins:
                o3 = Vector(origins[g]) - off
                j.data.transform(Matrix.Translation(-o3))
                j.location = o3
            j.parent = root
            out[g] = j
        for name, loc, parent in self.empties:
            e = bpy.data.objects.new(name, None)
            bpy.context.scene.collection.objects.link(e)
            e.empty_display_size = 0.02
            if parent:
                p = out[parent]
                e.parent = p
                e.location = loc - off - p.location
            else:
                e.location = loc - off
                e.parent = root
        bpy.ops.object.select_all(action='DESELECT')
        if self.stamps:
            add_stamps(root, [dict(d, y=d['y'] - off.y, z=d['z'] - off.z) for d in self.stamps])
        return root


def _uv_and_normals(o, angle):
    me = o.data
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    uv = bm.loops.layers.uv.verify()
    names = [s.name if s else '' for s in me.materials]
    for f in bm.faces:
        sc = TEXSCALE.get(names[f.material_index] if f.material_index < len(names) else '', 0.25)
        n = f.normal
        ax, ay, az = abs(n.x), abs(n.y), abs(n.z)
        for l in f.loops:
            c = l.vert.co
            if ax >= ay and ax >= az:
                u, v = c.y, c.z
            elif az >= ay:
                u, v = c.y, c.x
            else:
                u, v = c.x, c.z
            l[uv].uv = (u / sc, v / sc)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.shade_smooth_by_angle(angle=math.radians(angle), keep_sharp_edges=False)
    o.select_set(False)


def export_glb(path, root_names):
    bpy.ops.object.select_all(action='DESELECT')
    def sel(o):
        o.select_set(True)
        for c in o.children:
            sel(c)
    for n in root_names:
        sel(bpy.data.objects[n])
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=True, export_yup=True,
                              export_extras=False, export_cameras=False, export_lights=False, export_materials='EXPORT',
                              export_image_format='JPEG', export_jpeg_quality=92, export_texcoords=True, export_normals=True,
                              export_tangents=True)


def tri_count(root):
    t = 0
    for o in root.children_recursive:
        if o.type == 'MESH':
            for p in o.data.polygons:
                t += len(p.vertices) - 2
    return t


# ------------------------------------------------------------------ preview renders
def _bounds(root):
    lo = Vector((1e9, 1e9, 1e9)); hi = -lo
    for o in root.children_recursive:
        if o.type != 'MESH':
            continue
        for v in o.data.vertices:
            w = o.matrix_world @ v.co
            lo = Vector((min(lo[i], w[i]) for i in range(3))); hi = Vector((max(hi[i], w[i]) for i in range(3)))
    return lo, hi


def render_views(root, out_dir, views=('side', '34'), samples=16, res=(960, 540), extra=None):
    """Side (from +X), 3/4 (front-left-above) and optional first-person ('fp', from behind `eye`) renders."""
    s = bpy.context.scene
    s.render.engine = 'CYCLES'
    s.cycles.device = 'CPU'
    s.cycles.samples = samples
    s.cycles.use_denoising = True
    s.cycles.max_bounces = 4
    s.cycles.diffuse_bounces = 2
    s.cycles.glossy_bounces = 2
    s.cycles.transmission_bounces = 0
    s.cycles.caustics_reflective = s.cycles.caustics_refractive = False
    s.render.resolution_x, s.render.resolution_y = res
    s.render.film_transparent = False
    w = bpy.data.worlds.new('w'); s.world = w; w.use_nodes = True
    bg = w.node_tree.nodes['Background']; bg.inputs['Color'].default_value = (0.42, 0.45, 0.5, 1); bg.inputs['Strength'].default_value = 0.9
    sun = bpy.data.lights.new('sun', 'SUN'); sun.energy = 3.5; sun.angle = math.radians(8)
    so = bpy.data.objects.new('sun', sun); s.collection.objects.link(so)
    so.rotation_euler = (math.radians(40), math.radians(15), math.radians(60))
    lo, hi = _bounds(root)
    c = (lo + hi) / 2
    size = hi - lo
    gm = mat('preview_ground', (0.45, 0.43, 0.4), 0.9)
    bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 0, lo.z - 0.002))
    g = bpy.context.object; g.name = 'preview_ground'; g.data.materials.append(gm)
    cam = bpy.data.cameras.new('cam'); cam.lens = 50
    co = bpy.data.objects.new('cam', cam); s.collection.objects.link(co)
    s.camera = co
    th, tv = math.tan(math.radians(39.6) / 2), math.tan(math.radians(22.9) / 2)
    for v in views:
        if v == 'side':
            d = Vector((1, 0, 0.0)); dist = max(size.y / (2 * th), size.z / (2 * tv)) * 1.12 + size.x / 2
            tgt = c
        elif v == '34':
            d = Vector((-0.72, 0.5, 0.42)).normalized(); dist = max(size.y / (2 * th), size.z / (2 * tv)) * 1.05 + size.x / 2
            tgt = c
        elif v.startswith('close'):
            # close:<x>,<y>,<z>:<dist>:<az>:<el>  (target in root space, az from +X toward +Y, degrees)
            _, t3, dd, az, el = v.split(':')
            tgt = root.matrix_world @ Vector([float(q) for q in t3.split(',')])
            a, e = math.radians(float(az)), math.radians(float(el))
            d = Vector((math.cos(a) * math.cos(e), math.sin(a) * math.cos(e), math.sin(e)))
            co.location = tgt + d * float(dd)
            co.rotation_euler = (tgt - co.location).to_track_quat('-Z', 'Y').to_euler()
            s.render.filepath = os.path.join(out_dir, f'{root.name}_close{views.index(v)}.png')
            bpy.ops.render.render(write_still=True)
            continue
        elif v == 'sight':
            # Telephoto look from cheek down the sight line (checks notch / post alignment).
            e = bpy.data.objects.get('cheek')
            if e is None:
                continue
            co.location = e.matrix_world.translation
            fp_ = bpy.data.objects.get('front_post')
            tgt = fp_.matrix_world.translation if fp_ else co.location + Vector((0, 1, 0))
            co.rotation_euler = (tgt - co.location).to_track_quat('-Z', 'Y').to_euler()
            cam.lens = 200
            cam.clip_start = 0.01
            s.render.filepath = os.path.join(out_dir, f'{root.name}_sight.png')
            bpy.ops.render.render(write_still=True)
            cam.lens = 50
            continue
        elif v == 'fp':
            e = bpy.data.objects.get('cheek')
            if e is None and bpy.data.objects.get('eye') is None:
                continue
            if e is not None:
                co.location = e.matrix_world.translation
            else:
                co.location = bpy.data.objects['eye'].matrix_world.translation + Vector((0, -0.12, 0.0))
            co.rotation_euler = Vector((0, 1, 0)).to_track_quat('-Z', 'Y').to_euler()
            # Same as the game: camera exactly at `cheek`, looking along +Y, 55 deg vertical field of view.
            cam.sensor_fit = 'VERTICAL'
            cam.angle_y = math.radians(55)
            cam.clip_start = 0.01
            s.render.filepath = os.path.join(out_dir, f'{root.name}_fp.png')
            bpy.ops.render.render(write_still=True)
            cam.sensor_fit = 'AUTO'
            cam.lens = 50
            continue
        else:
            continue
        co.location = tgt + d * dist
        co.rotation_euler = (tgt - co.location).to_track_quat('-Z', 'Y').to_euler()
        s.render.filepath = os.path.join(out_dir, f'{root.name}_{v}.png')
        bpy.ops.render.render(write_still=True)
    for n in ('preview_ground', 'cam', 'sun'):
        o = bpy.data.objects.get(n)
        if o:
            bpy.data.objects.remove(o, do_unlink=True)

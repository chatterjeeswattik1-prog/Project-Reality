"""Extra helpers for the insurgent weapon builder (tools/blender/weapons_ins.py).
Procedural textures (wood grain, worn steel, bakelite, olive paint) generated with numpy and packed into the GLB,
loft / lathe / path-loft mesh builders, grouping of parts into the animated child meshes, box-projected UVs,
and preview renders. Builds on tools/blender/common.py (not modified)."""
import math, os, tempfile
import numpy as np
import bpy
import bmesh
from mathutils import Vector, Matrix
from common import reset, mat, clear_mats, empty

# ------------------------------------------------------------------ materials (procedural, baked per weapon)
# Every part material is a Cycles node network whose base colour / roughness / metallic end in reroute nodes named
# OUT_BASE / OUT_ROUGH / OUT_METAL. bake_weapon() unwraps all meshes of a weapon into one UV atlas and bakes those outputs
# (edge wear from a Bevel-node curvature mask, cavity grime from AO, wood grain, paint chips) into a base-colour texture and
# a glTF metallic-roughness texture, then swaps in one plain Principled material per weapon.
TEXSCALE = {}


class _NT:
    def __init__(self, m):
        m.use_nodes = True
        self.nt = m.node_tree
        self.N = self.nt.nodes
        self.L = self.nt.links
        self.y = 0

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

    def coord(self, scale=(1, 1, 1)):
        tc = self.node('ShaderNodeTexCoord')
        if scale == (1, 1, 1):
            return tc.outputs['Object']
        mp = self.node('ShaderNodeMapping')
        mp.inputs['Scale'].default_value = scale
        self.link(tc.outputs['Object'], mp.inputs['Vector'])
        return mp.outputs[0]

    def noise(self, scale, detail=3.0, rough=0.55, vec=None, out='Fac'):
        n = self.node('ShaderNodeTexNoise')
        n.inputs['Scale'].default_value = scale
        n.inputs['Detail'].default_value = detail
        n.inputs['Roughness'].default_value = rough
        self.link(vec if vec is not None else self.coord(), n.inputs['Vector'])
        return n.outputs[out]

    def edge(self, radius=0.0018, gain=4.0):
        bev = self.node('ShaderNodeBevel', samples=6)
        bev.inputs['Radius'].default_value = radius
        geo = self.node('ShaderNodeNewGeometry')
        d = self.node('ShaderNodeVectorMath', operation='DOT_PRODUCT')
        self.link(bev.outputs['Normal'], d.inputs[0]); self.link(geo.outputs['Normal'], d.inputs[1])
        return self.math('MULTIPLY', self.math('SUBTRACT', 1.0, d.outputs['Value']), gain, True)

    def cavity(self, dist=0.006, gain=1.6):
        ao = self.node('ShaderNodeAmbientOcclusion', samples=6, only_local=False)
        ao.inputs['Distance'].default_value = dist
        return self.math('MULTIPLY', self.math('SUBTRACT', 1.0, ao.outputs['AO']), gain, True)

    def finish(self, base, rough, metal):
        outs = []
        for name, sock in (('OUT_BASE', base), ('OUT_ROUGH', rough), ('OUT_METAL', metal)):
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


def m_steel(name, base=(0.11, 0.115, 0.125), worn=(0.5, 0.5, 0.5), wear=1.0, rough=0.42, metal=0.8, seed=0.0):
    """Blued / phosphated steel: mottled finish, bright polished edges, dark oily cavities, fine scratches."""
    m = bpy.data.materials.new(name); t = _NT(m)
    co = t.coord()
    n_big = t.noise(9.0, 3, 0.5, co)
    n_mid = t.noise(70.0, 4, 0.6, co)
    scr = t.noise(160.0, 2, 0.5, t.coord((3, 0.15, 3)))
    e = t.edge(0.0016, 5.0)
    wearm = t.math('MULTIPLY', t.mad(t.math('SUBTRACT', n_mid, 0.5), 1.1, t.math('SUBTRACT', e, 0.22)), 2.0 * wear, True)
    cav = t.cavity(0.007, 1.8)
    c0 = t.mix(n_big, _lin(base), _lin(tuple(min(1, x * 1.35) for x in base)))
    c1 = t.mix(t.math('MULTIPLY', t.math('GREATER_THAN', scr, 0.74), 0.18 * wear), c0, _lin(tuple(x * 0.6 for x in worn)))
    c2 = t.mix(wearm, c1, _lin(worn))
    c3 = t.mix(t.math('MULTIPLY', cav, 0.75), c2, _lin((0.03, 0.028, 0.025)))
    r = t.mad(t.math('SUBTRACT', n_big, 0.5), 0.18, t.mad(wearm, -0.16, t.mad(cav, 0.2, rough)))
    mt = t.mad(wearm, 1.0 - metal, metal)
    t.finish(c3, r, mt)
    return m


def m_paint(name, base, chip=(0.32, 0.31, 0.3), dirt=(0.22, 0.19, 0.14), rough=0.62, chips=1.0):
    """Painted metal: slight tonal variation, chipped edges showing steel, dust in cavities."""
    m = bpy.data.materials.new(name); t = _NT(m)
    co = t.coord()
    n_big = t.noise(6.0, 3, 0.5, co)
    n_c = t.noise(90.0, 4, 0.65, co)
    e = t.edge(0.002, 4.0)
    chipm = t.math('GREATER_THAN', t.mad(e, 0.8, t.math('MULTIPLY', n_c, 0.6)), 1.0 - 0.38 * chips)
    cav = t.cavity(0.01, 1.5)
    c0 = t.mix(n_big, _lin(tuple(x * 0.9 for x in base)), _lin(tuple(min(1, x * 1.1) for x in base)))
    c1 = t.mix(t.math('MULTIPLY', cav, 0.6), c0, _lin(dirt))
    c2 = t.mix(chipm, c1, _lin(chip))
    r = t.mad(chipm, -0.25, t.mad(t.math('SUBTRACT', n_big, 0.5), 0.12, rough))
    mt = t.math('MULTIPLY', chipm, 0.8)
    t.finish(c2, r, mt)
    return m


def m_wood(name, light, dark, laminate=False, rough=0.36, ring_scale=95.0, seed=0.0):
    """Varnished wood: rings around the length axis (grain runs along +Y), fibre streaks, pores, worn bare edges,
    dents and grime. laminate=True adds the stacked plies of AKM birch laminate."""
    m = bpy.data.materials.new(name); t = _NT(m)
    co = t.coord()
    wave = t.node('ShaderNodeTexWave', wave_type='RINGS', rings_direction='Y', wave_profile='SAW')
    wave.inputs['Scale'].default_value = ring_scale
    wave.inputs['Distortion'].default_value = 7.0
    wave.inputs['Detail'].default_value = 2.0
    wave.inputs['Detail Scale'].default_value = 1.2
    t.link(co, wave.inputs['Vector'])
    fib = t.noise(260.0, 2, 0.6, t.coord((1, 0.04, 1)))
    pores = t.noise(900.0, 1, 0.5, t.coord((1, 0.25, 1)))
    big = t.noise(4.0, 2, 0.5, co)
    g = t.mad(wave.outputs['Fac'], 0.55, t.math('MULTIPLY', fib, 0.45))
    if laminate:
        ply = t.node('ShaderNodeTexWave', wave_type='BANDS', bands_direction='X', wave_profile='SIN')
        ply.inputs['Scale'].default_value = 34.0
        ply.inputs['Distortion'].default_value = 1.5
        ply.inputs['Detail'].default_value = 1.0
        t.link(co, ply.inputs['Vector'])
        g = t.mad(t.math('POWER', ply.outputs['Fac'], 6.0), 0.55, t.math('MULTIPLY', g, 0.75))
    col = t.ramp(g, [(0.0, _lin(light)), (0.55, _lin(tuple((a + b) / 2 for a, b in zip(light, dark)))), (1.0, _lin(dark))])
    col = t.mix(t.math('MULTIPLY', t.math('GREATER_THAN', pores, 0.66), 0.5), col, _lin(tuple(x * 0.55 for x in dark)))
    col = t.mix(t.math('MULTIPLY', big, 0.35), col, _lin(tuple(x * 0.7 for x in dark)))
    dents = t.math('GREATER_THAN', t.noise(35.0, 2, 0.5, co), 0.72)
    col = t.mix(t.math('MULTIPLY', dents, 0.25), col, _lin(tuple(x * 0.5 for x in dark)))
    e = t.edge(0.003, 3.0)
    wearm = t.math('MULTIPLY', t.mad(t.math('SUBTRACT', t.noise(40.0, 3, 0.6, co), 0.5), 1.2, t.math('SUBTRACT', e, 0.2)), 1.8, True)
    col = t.mix(t.math('MULTIPLY', wearm, 0.7), col, _lin(tuple(min(1, x * 1.45 + 0.04) for x in light)))
    cav = t.cavity(0.008, 1.5)
    col = t.mix(t.math('MULTIPLY', cav, 0.7), col, _lin((0.05, 0.03, 0.02)))
    r = t.mad(wearm, 0.3, t.mad(t.math('SUBTRACT', big, 0.5), 0.15, t.mad(dents, 0.1, rough)))
    t.finish(col, r, 0.0)
    return m


def m_bakelite(name, a, b, rough=0.4, checker=False):
    """Phenolic / polymer furniture: soft mottling, slightly glossy, lighter rubbed edges, grime in grooves.
    checker=True adds the diamond checkering of AK / Makarov grip panels (pattern in the YZ plane)."""
    m = bpy.data.materials.new(name); t = _NT(m)
    co = t.coord()
    n1 = t.noise(25.0, 4, 0.55, co)
    n2 = t.noise(220.0, 2, 0.5, co)
    col = t.mix(t.mad(n1, 0.8, t.math('MULTIPLY', n2, 0.2)), _lin(a), _lin(b))
    if checker:
        grooves = None
        for ang in (45.0, -45.0):
            tc = t.node('ShaderNodeTexCoord'); mp = t.node('ShaderNodeMapping')
            mp.inputs['Rotation'].default_value = (math.radians(ang), 0, 0)
            t.link(tc.outputs['Object'], mp.inputs['Vector'])
            w = t.node('ShaderNodeTexWave', wave_type='BANDS', bands_direction='Z', wave_profile='SIN')
            w.inputs['Scale'].default_value = 75.0
            w.inputs['Distortion'].default_value = 0.0
            t.link(mp.outputs[0], w.inputs['Vector'])
            g = t.math('GREATER_THAN', w.outputs['Fac'], 0.8)
            grooves = g if grooves is None else t.math('MAXIMUM', grooves, g)
        geo = t.node('ShaderNodeNewGeometry'); sx = t.node('ShaderNodeSeparateXYZ')
        t.link(geo.outputs['Normal'], sx.inputs[0])
        side = t.math('GREATER_THAN', t.math('ABSOLUTE', sx.outputs['X']), 0.8)
        col = t.mix(t.math('MULTIPLY', t.math('MULTIPLY', grooves, side), 0.6), col, _lin(tuple(x * 0.45 for x in b)))
    e = t.edge(0.0016, 4.0)
    col = t.mix(t.math('MULTIPLY', e, 0.45), col, _lin(tuple(min(1, x * 1.35) for x in a)))
    cav = t.cavity(0.006, 1.6)
    col = t.mix(t.math('MULTIPLY', cav, 0.7), col, _lin((0.04, 0.025, 0.02)))
    t.finish(col, t.mad(e, -0.1, t.mad(cav, 0.2, rough)), 0.0)
    return m


def m_flat(name, rgb, rough=0.5, metal=0.0, var=0.08):
    m = bpy.data.materials.new(name); t = _NT(m)
    n = t.noise(40.0, 3, 0.5, t.coord())
    col = t.mix(n, _lin(tuple(x * (1 - var) for x in rgb)), _lin(tuple(min(1, x * (1 + var)) for x in rgb)))
    cav = t.cavity(0.006, 1.2)
    col = t.mix(t.math('MULTIPLY', cav, 0.5), col, _lin(tuple(x * 0.4 for x in rgb)))
    t.finish(col, t.mad(t.math('SUBTRACT', n, 0.5), 0.1, rough), metal)
    return m


def palette():
    """Part materials (sRGB colours). Keys are used by the builders."""
    P = {}
    P['steel'] = m_steel('blued_steel', (0.105, 0.11, 0.125), (0.52, 0.52, 0.53))
    P['steel2'] = m_steel('black_steel', (0.085, 0.085, 0.09), (0.45, 0.45, 0.45), 0.8, 0.5, 0.7)
    P['mag_steel'] = m_steel('mag_steel', (0.2, 0.21, 0.23), (0.55, 0.56, 0.58), 0.8, 0.45, 0.75)
    P['bright'] = m_steel('bright_steel', (0.36, 0.36, 0.37), (0.62, 0.62, 0.62), 0.6, 0.3, 0.9)
    P['phos'] = m_steel('phosphate', (0.075, 0.075, 0.08), (0.3, 0.3, 0.3), 0.4, 0.6, 0.5)
    P['plum'] = m_wood('wood_plum', (0.5, 0.2, 0.1), (0.2, 0.06, 0.035), laminate=True)
    P['wood_dark'] = m_wood('wood_dark', (0.36, 0.17, 0.08), (0.12, 0.05, 0.025))
    P['wood'] = m_wood('wood_red', (0.55, 0.27, 0.12), (0.26, 0.1, 0.045))
    P['wood_light'] = m_wood('wood_light', (0.6, 0.3, 0.14), (0.33, 0.13, 0.06))
    P['wood_rpg'] = m_wood('wood_rpg', (0.5, 0.17, 0.08), (0.28, 0.07, 0.035), rough=0.3, ring_scale=60.0)
    P['bakelite'] = m_bakelite('bakelite', (0.5, 0.2, 0.08), (0.34, 0.11, 0.045))
    P['plum_poly'] = m_bakelite('plum_polymer', (0.34, 0.12, 0.075), (0.22, 0.065, 0.045), 0.45)
    P['grip_ak'] = m_bakelite('grip_bakelite', (0.5, 0.2, 0.08), (0.36, 0.12, 0.05), 0.36, checker=True)
    P['grip_pm'] = m_bakelite('grip_pm', (0.2, 0.09, 0.05), (0.12, 0.05, 0.03), 0.45, checker=True)
    P['olive'] = m_paint('olive_paint', (0.3, 0.32, 0.19))
    P['olive_dk'] = m_paint('olive_dark', (0.19, 0.21, 0.13))
    P['grey_paint'] = m_paint('grey_paint', (0.36, 0.36, 0.34))
    P['warhead'] = m_paint('warhead_paint', (0.16, 0.18, 0.12), chips=0.6)
    P['brass'] = m_flat('brass', (0.72, 0.52, 0.22), 0.3, 1.0)
    P['steel_case'] = m_flat('lacquered_case', (0.42, 0.34, 0.2), 0.35, 0.8)
    P['copper'] = m_flat('copper', (0.72, 0.4, 0.24), 0.32, 1.0)
    P['rubber'] = m_flat('rubber', (0.05, 0.05, 0.05), 0.85, 0.0, 0.05)
    P['glass'] = m_flat('lens', (0.05, 0.08, 0.12), 0.05, 0.5, 0.0)
    P['shadow'] = m_flat('shadow', (0.02, 0.02, 0.02), 0.9, 0.0, 0.0)
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


def _bake_setup(objs, img, mode):
    mats = set()
    for o in objs:
        for s in o.material_slots:
            if s.material:
                mats.add(s.material)
    for m in mats:
        nt = m.node_tree
        N, L = nt.nodes, nt.links
        for n in [n for n in N if n.name.startswith('BAKE_')]:
            N.remove(n)
        im = N.new('ShaderNodeTexImage'); im.name = 'BAKE_IMG'; im.image = img
        em = N.new('ShaderNodeEmission'); em.name = 'BAKE_EM'
        out = N['Material Output']
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


def _save_pack(img, name):
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


def _soften(img, size):
    """Light 3x3 blur to remove bake sampling noise."""
    a = np.empty(size * size * 4, np.float32)
    img.pixels.foreach_get(a)
    a = a.reshape(size, size, 4)
    b = a.copy()
    acc = np.zeros_like(a[..., :3])
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            acc += np.roll(np.roll(a[..., :3], dy, 0), dx, 1) * (2.0 if dx == 0 and dy == 0 else 1.0)
    b[..., :3] = acc / 10.0
    img.pixels.foreach_set(b.ravel())


def bake_weapon(root, size=1024, samples=8, margin=3):
    """Unwrap all meshes under root into one atlas, bake base colour + metallic/roughness, assign one glTF material."""
    objs = [o for o in root.children_recursive if o.type == 'MESH']
    s = bpy.context.scene
    s.render.engine = 'CYCLES'
    s.cycles.device = 'CPU'
    s.cycles.samples = samples
    s.render.bake.margin = margin
    s.render.bake.margin_type = 'EXTEND'
    for o in objs:
        me = o.data
        while me.uv_layers:
            me.uv_layers.remove(me.uv_layers[0])
        me.uv_layers.new(name='UVMap')
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(52), island_margin=0.004, area_weight=0.0, correct_aspect=True,
                             scale_to_bounds=False)
    try:
        bpy.ops.uv.pack_islands(rotate=True, margin=0.007)
    except Exception:
        pass
    bpy.ops.object.mode_set(mode='OBJECT')
    rid = root.name
    base = bpy.data.images.new(f'{rid}_basecolor', size, size, alpha=False)
    orm = bpy.data.images.new(f'{rid}_metalrough', size, size, alpha=False, is_data=True)
    orm.colorspace_settings.name = 'Non-Color'
    for img, mode in ((base, 'base'), (orm, 'orm')):
        _bake_setup(objs, img, mode)
        bpy.ops.object.bake(type='EMIT', use_clear=True, margin=margin)
        _soften(img, size)
    base = _save_pack(base, f'{rid}_basecolor')
    orm = _save_pack(orm, f'{rid}_metalrough')
    m = bpy.data.materials.new(f'{rid}_mat')
    m.use_nodes = True
    N, L = m.node_tree.nodes, m.node_tree.links
    b = N['Principled BSDF']
    tb = N.new('ShaderNodeTexImage'); tb.image = base
    tm = N.new('ShaderNodeTexImage'); tm.image = orm
    sep = N.new('ShaderNodeSeparateColor')
    L.new(tb.outputs['Color'], b.inputs['Base Color'])
    L.new(tm.outputs['Color'], sep.inputs['Color'])
    L.new(sep.outputs['Green'], b.inputs['Roughness'])
    L.new(sep.outputs['Blue'], b.inputs['Metallic'])
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


def skin_x(side, x, y0, y1, z0, z1, m, step=0.003, disp=None, hole=None, zfn=None, name='skin'):
    """Stamped sheet surface facing side*X at |x| (one-sided), y0..y1 by z0..z1 (or zfn(y) -> (lo, hi)).
    disp(y, z) pushes vertices outward (+) / inward (-) for dimples and ribs; hole(y, z) skips cells (ports)."""
    ny = max(2, int(round((y1 - y0) / step))); nz = max(2, int(round((z1 - z0) / step)))
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
        self.P = palette()

    def _tag(self):
        for o in bpy.context.scene.objects:
            if o.type == 'MESH' and 'grp' not in o:
                o['grp'] = self.cur

    def group(self, name):
        self._tag()
        self.cur = name

    def E(self, name, loc):
        self.empties.append((name, Vector(loc)))

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
        for name, loc in self.empties:
            e = bpy.data.objects.new(name, None)
            bpy.context.scene.collection.objects.link(e)
            e.empty_display_size = 0.02
            e.location = loc - off
            e.parent = root
        bpy.ops.object.select_all(action='DESELECT')
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
                              export_image_format='JPEG', export_jpeg_quality=90)


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

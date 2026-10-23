"""Character definitions (bodies, faces, outfits) for tools/blender/characters.py. See chbuild.py / mhcommon.py."""
import math
import os

import bpy
import bmesh
import numpy as np
from mathutils import Vector, Matrix, Euler
from mathutils.bvhtree import BVHTree

import chcommon as C
import mhcommon as M
import mhchar as H
import texbake as T
import chbuild as K
import gear as G
from chbuild import smooth

SYS = M.SYS

# ---------------------------------------------------------------------------------------------- bodies / faces

FACES = {
    # face modifiers (MakeHuman targets) per character: varied, adult, masculine
    'us_rifleman': {'head/head-age|decr|incr': 0.3, 'head/head-square': 0.4, 'chin/chin-width|decr|incr': 0.3,
                    'chin/chin-prominent|decr|incr': 0.2, 'nose/nose-scale-horiz|decr|incr': 0.1,
                    'neck/neck-scale-horiz|decr|incr': 0.35},
    'us_rifleman_b': {'head/head-age|decr|incr': 0.4, 'head/head-rectangular': 0.4, 'nose/nose-flaring|decr|incr': 0.3,
                      'mouth/mouth-scale-horiz|decr|incr': 0.2, 'neck/neck-scale-horiz|decr|incr': 0.4,
                      'chin/chin-width|decr|incr': 0.4},
    'insurgent_a': {'head/head-age|decr|incr': 0.6, 'head/head-oval': 0.5, 'nose/nose-hump|decr|incr': 0.6,
                    'nose/nose-scale-vert|decr|incr': 0.35, 'nose/nose-point-width|decr|incr': 0.2,
                    'cheek/l-cheek-bones|decr|incr': 0.3, 'cheek/r-cheek-bones|decr|incr': 0.3},
    'insurgent_b': {'head/head-age|decr|incr': 0.2, 'head/head-triangular': 0.4, 'nose/nose-hump|decr|incr': 0.3,
                    'nose/nose-scale-vert|decr|incr': 0.2, 'chin/chin-prominent|decr|incr': -0.2,
                    'mouth/mouth-scale-horiz|decr|incr': -0.1},
    'insurgent_c': {'head/head-age|decr|incr': 0.5, 'head/head-square': 0.5, 'nose/nose-scale-horiz|decr|incr': 0.25,
                    'nose/nose-hump|decr|incr': 0.4, 'chin/chin-width|decr|incr': 0.3, 'neck/neck-scale-horiz|decr|incr': 0.3},
    'civilian_a': {'head/head-age|decr|incr': 0.9, 'head/head-oval': 0.3, 'nose/nose-hump|decr|incr': 0.5,
                   'nose/nose-scale-vert|decr|incr': 0.4, 'cheek/l-cheek-inner|decr|incr': -0.3,
                   'cheek/r-cheek-inner|decr|incr': -0.3},
}

BODIES = {
    # muscle, weight, height, race (african, asian, caucasian), age (0.5 = 25 y, 0.6 ~ 38 y)
    'us_rifleman': dict(muscle=0.68, weight=0.52, height=0.62, race=(0.0, 0.0, 1.0), age=0.5),
    'us_rifleman_b': dict(muscle=0.66, weight=0.55, height=0.58, race=(0.85, 0.0, 0.15), age=0.52),
    'insurgent_a': dict(muscle=0.5, weight=0.42, height=0.5, race=(0.1, 0.15, 0.75), age=0.56),
    'insurgent_b': dict(muscle=0.52, weight=0.40, height=0.55, race=(0.05, 0.15, 0.8), age=0.5),
    'insurgent_c': dict(muscle=0.6, weight=0.55, height=0.52, race=(0.1, 0.1, 0.8), age=0.55),
    'civilian_a': dict(muscle=0.45, weight=0.6, height=0.45, race=(0.1, 0.15, 0.75), age=0.68),
}

SKINS = {
    # skin texture and tint (multiplies the texture, sRGB)
    'us_rifleman': ('young_caucasian_male/young_lightskinned_male_diffuse.png', (1.0, 0.97, 0.94)),
    'us_rifleman_b': ('young_african_male/young_darkskinned_male_diffuse.png', (1.0, 0.98, 0.96)),
    'insurgent_a': ('middleage_caucasian_male/middleage_lightskinned_male_diffuse.png', (0.80, 0.68, 0.55)),
    'insurgent_b': ('young_caucasian_male2/young_lightskinned_male_diffuse2.png', (0.84, 0.72, 0.58)),
    'insurgent_c': ('middleage_caucasian_male/middleage_lightskinned_male_diffuse.png', (0.74, 0.62, 0.50)),
    'civilian_a': ('old_caucasian_male/old_lightskinned_male_diffuse.png', (0.80, 0.69, 0.57)),
}


def targets_for(cid):
    t = M.macro_targets(**BODIES[cid])
    for k, v in FACES.get(cid, {}).items():
        if '|' not in k and os.path.exists(os.path.join(M.MPFB, 'targets', k + '.target.gz')):
            t[k] = t.get(k, 0) + v
            continue
        for name, w in M.modifier(k, v).items():
            if os.path.exists(os.path.join(M.MPFB, 'targets', name + '.target.gz')):
                t[name] = t.get(name, 0) + w
            else:
                print('  (no target %s)' % name)
    return t


def landmarks(kit):
    """Face landmarks (rest, metres) from the mapped MakeHuman joint helpers."""
    b = H.base()[0]
    P = kit.h.P
    g = lambda n: P[b.groups[n]].mean(0)
    eye = (g('joint-l-eye') + g('joint-r-eye')) / 2
    return {'eye': eye, 'mouth': g('joint-mouth'), 'jaw': g('joint-jaw'), 'eye_dx': abs(g('joint-l-eye')[0] - g('joint-r-eye')[0])}


def skin_src(cid, beard=0.0, stubble=0.0, head=None, lm=None, beard_rgb=(0.07, 0.055, 0.045), roughness=0.5):
    """Skin from the MakeHuman texture (tinted) + pore relief; beard / stubble painted from face landmarks:
    jaw, chin, moustache and sideburns, lips kept clear, density thinning out at the edges."""
    path, tint = SKINS[cid]
    path = os.path.join(SYS, 'skins', path)
    tint = np.array(tint)
    beard_rgb = np.array(beard_rgb)

    def fn(a):
        P = a['P']
        base = T.sample(K.img(path, 2048)[..., :3], a['suv']) * tint
        hgt = (T.vnoise(P, 0.0012, 3) - 0.5) * 0.00005 + (T.fbm(P, 0.006, 2, 4) - 0.5) * 0.00010
        rough = roughness + 0.08 * T.fbm(P, 0.03, 2, 7)
        if lm is not None and (beard > 0 or stubble > 0):
            E, Mo = lm['eye'], lm['mouth']
            q = P - E
            m = P - Mo
            x = np.abs(q[:, 0])
            fwd = q[:, 1]                                   # + in front of the eyes' plane
            # cheeks: below a line sloping from the cheekbone (front) to the ear (back)
            cheek_top = -0.040 + 0.25 * np.clip(-fwd, 0, 0.1)
            w = 1 - smooth(cheek_top - 0.012, cheek_top + 0.006, q[:, 2])
            w *= smooth(-0.095, -0.075, fwd)                # in front of the ears
            w *= smooth(-0.115, -0.085, m[:, 2] - 0.0 * fwd)  # down to under the jaw, fading on the neck
            # sideburns up to the hair line
            sb = (1 - smooth(0.004, 0.012, np.abs(fwd + 0.082))) * (1 - smooth(0.02, 0.045, q[:, 2])) * smooth(0.055, 0.065, x)
            sb *= smooth(-0.07, -0.04, q[:, 2]) * (1 - smooth(0.085, 0.1, x))
            w = np.maximum(w, sb)
            # nose and the area under the eyes stay clear; moustache only near the lip
            nose = (1 - smooth(0.012, 0.022, x)) * smooth(m[:, 2] - 0.0, m[:, 2] + 0.001, Mo[2] + 0.016 + 0 * x)
            nose = (1 - smooth(0.014, 0.024, x)) * smooth(0.012, 0.02, m[:, 2])
            w *= 1 - nose
            lips = (1 - smooth(0.006, 0.011, np.abs(m[:, 2] + 0.0015))) * (1 - smooth(0.022, 0.03, x))
            w *= 1 - lips
            strands = smooth(0.3, 0.75, T.fbm(P * np.array([1, 1, 0.3]), 0.0012, 2, 11))
            edge = smooth(0.0, 0.6, w)
            dens = np.clip(edge * (stubble * 0.45 + beard * 0.9), 0, 1)
            amt = np.clip(dens * (0.55 + 0.45 * strands), 0, 0.92)
            base = base + (beard_rgb - base) * amt[:, None]
            hgt = hgt + beard * w * (T.fbm(P * np.array([1, 1, 0.4]), 0.0018, 2, 12) - 0.5) * 0.0012
            rough = rough + w * (0.25 * beard + 0.1 * stubble)
        return {'base': base, 'rough': np.clip(rough, 0.3, 0.95), 'height': hgt}
    return K.src_proc(fn, importance=1.0)

# ---------------------------------------------------------------------------------------------- gloves


def glove_src(kit, col=(0.50, 0.42, 0.30), palm=(0.33, 0.28, 0.21), pad=(0.30, 0.27, 0.22), cuff=(0.17, 0.15, 0.13)):
    """Mechanix-style tactical glove from 3D position: coyote stretch back, synthetic-leather palm and finger
    tips, moulded knuckle pads, side seams, elastic cuff with a hook-and-loop tab."""
    rest = kit.rest
    col, palm, pad, cuff = (np.array(c) for c in (col, palm, pad, cuff))

    def fn(a):
        P, N = a['P'], a['N']
        n = len(P)
        side = np.where(P[:, 0] < 0, 'l', 'r')
        base = np.tile(col, (n, 1))
        hgt = np.zeros(n)
        rough = np.full(n, 0.85)
        for s in 'lr':
            m = side == s
            if not m.any():
                continue
            p, nn = P[m], N[m]
            wrist = rest['hand_' + s][0]
            ax = rest['middle_01_' + s][0] - wrist
            L = np.linalg.norm(ax)
            ax /= L
            along = (p - wrist) @ ax                      # metres from the wrist towards the fingers
            back = nn[:, 2]                               # +1 back of the hand (T-pose palms down)
            b = base[m]
            h = np.zeros(len(p))
            r = rough[m]
            # palm / finger pads: leather, wraps the finger tips
            pw = smooth(0.15, -0.25, back)
            tip = np.zeros(len(p))
            for f in ('index', 'middle', 'ring', 'pinky', 'thumb'):
                t3 = rest['%s_03_%s' % (f, s)][0]
                tip = np.maximum(tip, 1 - smooth(0.012, 0.02, np.linalg.norm(p - t3, axis=1)))
            pw = np.maximum(pw, tip * smooth(-0.6, -0.2, back + 0.4))
            b = b + (palm - b) * pw[:, None]
            r = r * (1 - pw) + 0.62 * pw
            grain = T.vnoise(p, 0.0007, 21) - 0.5
            h += grain * 0.00008 * pw + (T.vnoise(p, 0.0005, 22) - 0.5) * 0.00005 * (1 - pw)
            # seam between back and palm
            seam = 1 - smooth(0.0, 0.08, np.abs(back - 0.05))
            h -= seam * 0.0005
            # knuckle pads (MCP) and finger pads on the back
            kp = np.zeros(len(p))
            for f in ('index', 'middle', 'ring', 'pinky'):
                for j, rr in (('01', 0.011), ('02', 0.008)):
                    c = rest['%s_%s_%s' % (f, j, s)][0] + (rest['%s_%s_%s' % (f, j, s)][1] - rest['%s_%s_%s' % (f, j, s)][0]) * (0.0 if j == '01' else 0.5)
                    d = np.linalg.norm(p - c, axis=1)
                    kp = np.maximum(kp, 1 - smooth(rr * 0.6, rr, d))
            c = rest['thumb_02_' + s][0]
            kp = np.maximum(kp, (1 - smooth(0.006, 0.010, np.linalg.norm(p - c, axis=1))))
            kp *= smooth(0.2, 0.5, back)
            h += kp * 0.0025
            b = b + (pad - b) * (kp > 0.5)[:, None] * 0.9
            r = np.where(kp > 0.5, 0.7, r)
            # back-of-hand panel stitching
            st = (1 - smooth(0.0006, 0.0012, np.abs(along - 0.035))) * smooth(0.3, 0.6, back)
            h -= st * 0.0002
            # elastic cuff with ribs, hook-and-loop tab on the back of the wrist
            cz = 1 - smooth(-0.012, -0.006, along)
            ribs = 0.5 + 0.5 * np.sin(along * 2 * math.pi / 0.003)
            h += cz * ribs * 0.0002 - cz * 0.0004
            b = b + (cuff - b) * cz[:, None]
            tab = (1 - smooth(-0.040, -0.032, along)) * smooth(-0.07, -0.05, along) * smooth(0.4, 0.7, back)
            tab *= 1 - smooth(0.012, 0.016, np.abs((p - wrist) @ np.array([0, 1.0, 0])))
            h += tab * 0.0012
            b = b + (pad * 0.8 - b) * tab[:, None]
            # wear: lighter, dusty on the knuckles and palm
            wear = smooth(0.55, 0.8, T.fbm(p, 0.01, 3, 23)) * 0.25
            b = b + (np.array([0.62, 0.56, 0.45]) - b) * wear[:, None]
            base[m], hgt[m], rough[m] = b, h, r
        return {'base': base, 'rough': rough, 'height': hgt}
    return K.src_proc(fn, importance=2.6)

# ---------------------------------------------------------------------------------------------- garments


def fit(kit, kind, name, mat, comps=None, push=0.0, hide=True, hide_dist=0.035, decim=1.0, part=None):
    """Fit a MakeHuman clothes asset; comps: callable(component vertex mask (MH coords)) -> keep?"""
    clo = M.Clo(M.asset(kind, name))
    o = kit.h.clo(clo, name=name, mat=mat, push=push)
    if comps is not None:
        keep = component_filter(clo, comps)
        drop = np.array([not keep[p.vertices[0]] for p in o.data.polygons])
        if drop.any():
            K.delete_faces(o, drop)
    if hide and len(clo.delete):
        dele = clo.delete
        if comps is not None:
            # only hide base vertices close to what is left of the garment
            from mathutils.kdtree import KDTree
            kd = KDTree(len(o.data.vertices))
            for v in o.data.vertices:
                kd.insert(v.co, v.index)
            kd.balance()
            P = kit.h.P
            dele = np.array([i for i in dele if kd.find(Vector(P[i]))[2] < hide_dist], np.int64)
        kit.hide.update(int(i) for i in dele)
    o['decimate'] = decim
    kit.add(o, part)
    return o, clo


def component_filter(clo, pred):
    f = clo.obj['faces']
    nv = len(clo.obj['v'])
    par = np.arange(nv)

    def find(x):
        while par[x] != x:
            par[x] = par[par[x]]
            x = par[x]
        return x
    for vi, ti, g, m in f:
        for v in vi[1:]:
            a, b = find(vi[0]), find(v)
            if a != b:
                par[a] = b
    roots = np.array([find(i) for i in range(nv)])
    keep = np.zeros(nv, bool)
    used = sorted({v for vi, ti, g, m in f for v in vi})
    for r in np.unique(roots):
        m = roots == r
        if pred(clo.obj['v'][m]):
            keep |= m
    # remap to the mesh's vertex order (make_mesh keeps used vertices in sorted order)
    return keep[used]


def is_top(v):
    return v[:, 1].min() > -1.0          # MakeHuman units: tops start above the crotch


def is_bottom(v):
    return v[:, 1].min() < -5.0

# ---------------------------------------------------------------------------------------------- body


def make_body(kit, skin_src, glove=None, hide_extra=None, hands_push=0.0, undershirt=None, keep_collar=False):
    """Body mesh minus what the garments hide. undershirt: Src for visible chest/collar faces (a T-shirt under an
    open collar); keep_collar keeps the throat / upper chest under an open collar from being hidden."""
    hide = set(kit.hide) | set(hide_extra or [])
    if keep_collar:
        P = kit.h.P
        nk = kit.rest['neck_01'][0]
        hide = {i for i in hide if not (P[i, 2] > nk[2] - 0.13 and P[i, 1] > nk[1] - 0.02 and abs(P[i, 0]) < 0.11)}
    skin = kit.mat('skin', skin_src, (0.8, 0.6, 0.5))
    body = kit.h.body('body', hide=np.array(sorted(hide), np.int64), mat=skin)
    fb, W, gn = K.face_bones(body)
    if glove is not None:
        g = kit.mat('glove', glove, (0.6, 0.5, 0.36))
        body.data.materials.append(g)
        gi = len(body.data.materials) - 1
        for i, p in enumerate(body.data.polygons):
            b = fb[i]
            gl = b.startswith(K.HAND_BONES)
            if b.startswith('lowerarm'):
                s = b[-1]
                wrist = kit.rest['hand_' + s][0]
                ax = kit.rest['hand_' + s][0] - kit.rest['lowerarm_' + s][0]
                ax /= np.linalg.norm(ax)
                gl = np.dot(np.array(p.center) - wrist, ax) > -0.055
            if gl:
                p.material_index = gi
        if hands_push:
            gv = {v for p in body.data.polygons if p.material_index == gi for v in p.vertices}
            for v in body.data.vertices:
                if v.index in gv:
                    v.co += v.normal * hands_push
    if undershirt is not None:
        u = kit.mat('undershirt', undershirt, (0.55, 0.48, 0.36))
        body.data.materials.append(u)
        ui = len(body.data.materials) - 1
        nk = kit.rest['neck_01'][0]
        for i, p in enumerate(body.data.polygons):
            if K.region_of(fb[i]) == 'torso' or (fb[i] == 'neck_01' and p.center.z < nk[2] - 0.005):
                p.material_index = ui
    # decimate head, hands and the rest separately (a global collapse would crush the face to keep the hands);
    # the cuts lie at the neck and the wrists, under the collar / glove cuff
    fb, W, gn = K.face_bones(body)
    lab = np.array([('head' if fb[i] in ('Head', 'neck_01') else 'hand' if (fb[i].startswith(K.HAND_BONES) or p.material_index == len(body.data.materials) and False) else 'rest')
                    for i, p in enumerate(body.data.polygons)])
    pieces = []
    for name, ratio in (('head', 0.32), ('hand', 0.42), ('rest', 0.45)):
        o = body.copy()
        o.data = body.data.copy()
        o.name = 'body_' + name
        bpy.context.scene.collection.objects.link(o)
        K.delete_faces(o, lab != name)
        if len(o.data.polygons) == 0:
            bpy.data.objects.remove(o, do_unlink=True)
            continue
        o['decimate'] = ratio
        kit.add(o)
        pieces.append(o)
    bpy.data.objects.remove(body, do_unlink=True)
    return pieces[0] if pieces else None


def head_objs(kit):
    return [o for o, p in kit.objs if o.name.startswith(('hair', 'body_head'))]


def full_body_bvh(kit):
    """BVH of the whole (unhidden) mapped body, for fitting garments."""
    b = kit.h.body('tmp_body')
    bvh = K.body_bvh([b])
    bpy.data.objects.remove(b, do_unlink=True)
    return bvh


def tighten(kit, o, bvh, gap=0.006, keep=0.25, bones=('upperarm', 'lowerarm', 'clavicle'), min_w=0.5):
    """Pull loose garment vertices in towards the body: where the cloth stands off more than `gap`, only `keep` of
    the excess remains (fitted sleeves, no balloon volume). Limited to vertices mainly weighted to `bones`."""
    names = {g.index: g.name for g in o.vertex_groups}
    n = 0
    for v in o.data.vertices:
        w = sum(g.weight for g in v.groups if names[g.group].startswith(bones))
        if w < min_w:
            continue
        loc, nrm, idx, d = bvh.find_nearest(v.co)
        if loc is None or d <= gap:
            continue
        t = min((w - min_w) / (1 - min_w + 1e-6) * 1.5, 1.0)
        nd = gap + (d - gap) * keep
        v.co = v.co.lerp(loc + (v.co - loc).normalized() * nd, t)
        n += 1
    o.data.update()
    return n


def eyes(kit, color='brown'):
    clo = M.Clo(M.asset('eyes', 'low-poly'))
    src = K.src_image(os.path.join(SYS, 'eyes', 'materials', color + '_eye.png'), rough=0.15, importance=1.5)
    m = kit.mat('eyes', src, (0.3, 0.2, 0.1))
    o = kit.h.clo(clo, name='eyes', mat=m)
    kit.add(o, 'head')
    return o


def alpha_mat(name, path, tint=(1, 1, 1), size=512, rough=0.7, alpha_scale=1.0):
    """Cut-out material (hair cards, eyebrows): baked small RGBA texture with tint."""
    a = T.load(path, size)
    a[..., :3] *= np.array(tint, np.float32)
    a[..., 3] = np.clip(a[..., 3] * alpha_scale, 0, 1)
    im = T.to_image(name + '_tex', a, os.path.join(K.TMP, name + '.png'))
    m = bpy.data.materials.new(K.ALPHA_PREFIX + name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes['Principled BSDF']
    t = nt.nodes.new('ShaderNodeTexImage')
    t.image = im
    nt.links.new(t.outputs['Color'], b.inputs['Base Color'])
    nt.links.new(t.outputs['Alpha'], b.inputs['Alpha'])
    b.inputs['Roughness'].default_value = rough
    m.blend_method = 'CLIP' if hasattr(m, 'blend_method') else None
    try:
        m.alpha_threshold = 0.5
    except AttributeError:
        pass
    return m


def hair(kit, name, tint=(0.35, 0.28, 0.22), part='head', alpha_scale=1.2):
    clo = M.Clo(M.asset('hair', name))
    mm = clo.material()
    m = alpha_mat('hair_' + name, mm['diffuse'], tint, 512, 0.75, alpha_scale)
    o = kit.h.clo(clo, name='hair', mat=m)
    o['decimate'] = 0.45
    kit.add(o, part)
    return o


def brows(kit, name='eyebrow001', tint=(0.5, 0.4, 0.35)):
    clo = M.Clo(M.asset('eyebrows', name))
    m = alpha_mat('brows_' + name, os.path.join(SYS, 'eyebrows', name, name + '.png'), tint, 256, 0.8, 1.0)
    o = kit.h.clo(clo, name='brows', mat=m)
    kit.add(o, 'head')
    lc = M.Clo(M.asset('eyelashes', 'eyelashes01'))
    mm = lc.material()
    lm = alpha_mat('lashes', mm['diffuse'], (0.3, 0.3, 0.3), 256, 0.8, 1.0) if 'diffuse' in mm else None
    if lm is not None:
        o2 = kit.h.clo(lc, name='lashes', mat=lm)
        kit.add(o2, 'head')
    return o

# ---------------------------------------------------------------------------------------------- characters


def new_kit(cid):
    C.reset()
    arm, meshes = C.load_base()
    for o in meshes.values():
        bpy.data.objects.remove(o, do_unlink=True)
    h = H.Human(arm, targets_for(cid))
    return K.Kit(cid, arm, h)


def build_us(cid):
    kit = new_kit(cid)
    seed = 1 if cid == 'us_rifleman' else 2
    maps = K.cloth_maps(M.Clo(M.asset('clothes', 'male_casualsuit01')), 2048)

    def ocp_col(a):
        return K.dirt(a['P'], K.ocp(a['P'], seed, 0.75), 0.45)
    uni = kit.mat('ocp_uniform', K.src_cloth(maps, ocp_col, rough=0.88, detail=0.35, ao=0.75, importance=1.6,
                                             height_fn=lambda a: K.fabric_height(a['P'], a['N'], seed=seed)), (0.6, 0.55, 0.42))
    shirt, clo = fit(kit, 'clothes', 'male_casualsuit01', uni, decim=0.2)
    fbvh = full_body_bvh(kit)
    tighten(kit, shirt, fbvh, gap=0.007, keep=0.3)
    smaps = K.cloth_maps(M.Clo(M.asset('clothes', 'shoes01')), 1024)

    def boot_col(a, base):
        lum = base @ np.array([0.3, 0.59, 0.11])
        return np.array([0.62, 0.52, 0.38])[None] * (0.55 + 0.9 * lum[:, None])
    bootm = kit.mat('boots', K.src_cloth(smaps, boot_col, rough=0.9, keep_diffuse=True, detail=0.0, ao=0.0), (0.6, 0.5, 0.36))
    boots, _ = fit(kit, 'clothes', 'shoes01', bootm, decim=0.25)
    G.us_legs(kit, shirt, bootm, seed)
    G.sleeve_pockets(kit, shirt, seed, flag=True)
    hair(kit, 'short04', (0.30, 0.24, 0.18) if seed == 1 else (0.10, 0.08, 0.07))
    brows(kit)
    eyes(kit, 'brown' if seed == 2 else 'bluegreen')
    head_rest = kit.rest['Head'][0]
    tee = K.src_proc(lambda a: {'base': K.dirt(a['P'], K.fabric_tint((0.52, 0.45, 0.34), 0.06)(a), 0.3),
                                'rough': 0.9, 'height': (T.vnoise(a['P'], 0.0008, 5) - 0.5) * 0.00005})
    make_body(kit, skin_src(cid, stubble=0.35, lm=landmarks(kit)), glove=glove_src(kit), hands_push=0.0012,
              undershirt=tee, keep_collar=True)
    G.helmet(kit, head_objs(kit), seed)
    G.plate_carrier(kit, shirt, seed, 'a' if seed == 1 else 'b')
    if seed == 2:
        import gear_ins as GI
        G.glasses(kit, landmarks(kit))
        sc = kit.mat('shemagh_tan', GI.src_keffiyeh((0.66, 0.60, 0.47), (0.36, 0.33, 0.25), cell=0.10, seed=7, dirt_amt=0.3), (0.6, 0.55, 0.45))
        G.neck_scarf(kit, [o for o in head_objs(kit) if o.name.startswith('body_head')], sc)
    return kit

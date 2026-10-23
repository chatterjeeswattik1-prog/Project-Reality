"""Insurgent and civilian outfits (see outfits.py for the shared body / head / garment helpers)."""
import numpy as np

import mhcommon as M
import texbake as T
import chbuild as K
import gear as G
import gear_ins as GI
import outfits as O
from chbuild import smooth
from outfits import (new_kit, fit, is_top, is_bottom, tighten, full_body_bvh, hair, brows, eyes, make_body,
                     skin_src, head_objs)


def plain_cloth(kit, name, clo_name, rgb, seed=0, detail=0.5, dirt=0.4, rough=0.9, folds=0.8, importance=1.0,
                keep=None):
    """Garment source: solid (slightly mottled) colour + the original's stitching / AO / normals, fabric relief,
    dirt. keep(a, base) -> recolour the original diffuse instead of a solid colour."""
    maps = K.cloth_maps(M.Clo(M.asset('clothes', clo_name)), 2048)
    if keep is None:
        def col(a):
            return K.dirt(a['P'], K.fabric_tint(rgb, 0.07, seed)(a), dirt, seed + 1)
        src = K.src_cloth(maps, col, rough=rough, detail=detail, ao=0.7, importance=importance,
                          height_fn=lambda a: K.fabric_height(a['P'], a['N'], folds=folds, ripstop=False, seed=seed))
    else:
        def col(a, base):
            return K.dirt(a['P'], keep(a, base), dirt, seed + 1)
        src = K.src_cloth(maps, col, rough=rough, detail=0.0, ao=0.5, importance=importance, keep_diffuse=True,
                          height_fn=lambda a: K.fabric_height(a['P'], a['N'], folds=folds * 0.6, ripstop=False, seed=seed))
    return kit.mat(name, src, tuple(rgb) if rgb else (0.5, 0.5, 0.5))


def robe_proc(kit, name, rgb, seed):
    """Procedural cotton for modelled cloth (no source UV): mottled colour, dust at the hem, fine weave."""
    def fn(a):
        P = a['P']
        base = K.dirt(P, K.fabric_tint(rgb, 0.06, seed)(a), 0.6, seed + 1)
        h = K.fabric_height(P, a['N'], folds=0.5, ripstop=False, seed=seed) + (T.vnoise(P, 0.0007, seed) - 0.5) * 0.00006
        return {'base': base, 'rough': 0.92, 'height': h}
    return kit.mat(name, K.src_proc(fn), rgb)


def finish_head(kit, cid, hair_name=None, hair_tint=(0.08, 0.07, 0.06), eye='brown', beard=0.0, stubble=0.0,
                beard_rgb=(0.07, 0.055, 0.045), robe=False):
    if hair_name:
        hair(kit, hair_name, hair_tint)
    brows(kit, 'eyebrow001', (0.25, 0.2, 0.17))
    eyes(kit, eye)
    hide = None
    if robe:
        # legs under the robe are never seen (and would poke through it when walking)
        P = kit.h.P
        hide = [i for i in range(M.NBODY) if 0.24 < P[i, 2] < 1.0 and abs(P[i, 0]) < 0.3]
    make_body(kit, skin_src(cid, beard=beard, stubble=stubble, lm=O.landmarks(kit), beard_rgb=beard_rgb), hide_extra=hide)


def wrap_targets(kit):
    return head_objs(kit) + [o for o, p in kit.objs if o.name.startswith('body_rest')]


def sandals(kit, strap_rgb):
    sole = kit.mat('sandal_sole', G.src_solid((0.16, 0.12, 0.09), 0.8, 0.1), (0.16, 0.12, 0.09))
    leather = kit.mat('sandal_leather', G.src_solid(strap_rgb, 0.6, 0.1, 0.0002), strap_rgb)
    GI.sandals(kit, sole, leather)


def lum(base):
    return base @ np.array([0.3, 0.59, 0.11])


def build_insurgent_a(cid):
    """Older fighter: grey-khaki dishdasha, red keffiyeh wrapped on the head, Type 56 chest rig, sandals."""
    kit = new_kit(cid)
    robe = plain_cloth(kit, 'robe', 'male_casualsuit02', (0.60, 0.57, 0.49), seed=11, detail=0.0, dirt=0.5)
    top, _ = fit(kit, 'clothes', 'male_casualsuit02', robe, comps=is_top, decim=0.6)
    tighten(kit, top, full_body_bvh(kit), gap=0.012, keep=0.5)
    GI.robe_skirt(kit, robe_proc(kit, 'robe_skirt_a', (0.60, 0.57, 0.49), 11), z0=1.02, z1=0.12, flare=0.09, seed=3)
    sandals(kit, (0.30, 0.20, 0.12))
    finish_head(kit, cid, None, eye='brown', beard=1.0, robe=True)
    wrap = kit.mat('keffiyeh', GI.src_keffiyeh((0.86, 0.84, 0.78), (0.60, 0.09, 0.08), seed=1), (0.8, 0.5, 0.5))
    GI.head_wrap(kit, wrap_targets(kit), wrap, 'wrap', seed=1)
    canvas = kit.mat('canvas', G.src_nylon(4, (0.52, 0.47, 0.34), rough=0.92, wear=0.6), (0.52, 0.47, 0.34))
    web = kit.mat('canvas_web', G.src_nylon(5, (0.44, 0.40, 0.29), rough=0.9, wear=0.5), (0.44, 0.4, 0.29))
    GI.chest_rig(kit, top, canvas, web, 3)
    return kit


def build_insurgent_b(cid):
    """Young fighter: dark track jacket with white stripes, dark jeans, worn sneakers, black-and-white shemagh
    over the face, AK magazine chest rig."""
    kit = new_kit(cid)

    def track(a, base):
        stripe = smooth(0.12, 0.25, base[:, 0] - base[:, 2])
        P = a['P']
        logo = (np.abs(P[:, 0]) < 0.2) & (P[:, 2] > 1.15) & (P[:, 1] > -0.02)
        stripe = np.where(logo, 0, stripe)
        navy = np.array([0.10, 0.11, 0.16]) * (0.85 + 0.3 * T.fbm(P, 0.1, 2, 3))[:, None]
        return navy + (np.array([0.78, 0.78, 0.76]) - navy) * stripe[:, None]
    jacket = plain_cloth(kit, 'track', 'male_casualsuit02', None, seed=21, dirt=0.35, rough=0.7, keep=track)
    top, _ = fit(kit, 'clothes', 'male_casualsuit02', jacket, comps=is_top, decim=0.6)
    tighten(kit, top, full_body_bvh(kit), gap=0.008, keep=0.4)
    trs = plain_cloth(kit, 'jeans', 'male_casualsuit02', None, seed=22, dirt=0.55,
                      keep=lambda a, b: np.array([0.16, 0.17, 0.19])[None] * (0.6 + 0.9 * lum(b)[:, None]))
    fit(kit, 'clothes', 'male_casualsuit02', trs, comps=is_bottom, decim=0.5)
    sh = plain_cloth(kit, 'sneakers', 'shoes05', None, seed=23, dirt=0.6, rough=0.75, folds=0,
                     keep=lambda a, b: b * np.array([0.62, 0.60, 0.56]))
    fit(kit, 'clothes', 'shoes05', sh, decim=0.35)
    finish_head(kit, cid, 'short04', eye='brownlight', stubble=0.7)
    wrap = kit.mat('shemagh_bw', GI.src_keffiyeh((0.84, 0.83, 0.80), (0.06, 0.06, 0.07), cell=0.09, seed=2), (0.5, 0.5, 0.5))
    GI.head_wrap(kit, wrap_targets(kit), wrap, 'mask', seed=2)
    canvas = kit.mat('rig_olive', G.src_nylon(6, (0.36, 0.36, 0.25), rough=0.9, wear=0.5), (0.36, 0.36, 0.25))
    web = kit.mat('rig_web', G.src_nylon(7, (0.28, 0.28, 0.20), rough=0.9, wear=0.4), (0.28, 0.28, 0.2))
    GI.chest_rig(kit, top, canvas, web, 4, z0=1.06, z1=1.27)
    return kit


def build_insurgent_c(cid):
    """Veteran fighter: olive military-surplus field jacket over a civilian shirt, khaki trousers, black shoes,
    olive shemagh wrapped on the head, beard, chest rig."""
    kit = new_kit(cid)
    jk = plain_cloth(kit, 'field_jacket', 'male_casualsuit05', None, seed=31, dirt=0.5,
                     keep=lambda a, b: np.array([0.36, 0.36, 0.25])[None] * (0.5 + 1.2 * lum(b)[:, None]))
    jacket, _ = fit(kit, 'clothes', 'male_casualsuit05', jk, comps=is_top, decim=0.45)
    tighten(kit, jacket, full_body_bvh(kit), gap=0.012, keep=0.5)
    trs = plain_cloth(kit, 'khaki', 'male_casualsuit05', None, seed=32, dirt=0.6,
                      keep=lambda a, b: np.array([0.50, 0.45, 0.34])[None] * (0.6 + 0.8 * lum(b)[:, None]))
    fit(kit, 'clothes', 'male_casualsuit05', trs, comps=is_bottom, decim=0.5)
    bt = plain_cloth(kit, 'boots_black', 'shoes03', None, seed=33, dirt=0.5, rough=0.6, folds=0,
                     keep=lambda a, b: b * 0.55)
    fit(kit, 'clothes', 'shoes03', bt, decim=0.35)
    finish_head(kit, cid, None, eye='brown', beard=0.85)
    wrap = kit.mat('shemagh_olive', GI.src_keffiyeh((0.70, 0.68, 0.58), (0.25, 0.27, 0.18), cell=0.10, seed=3), (0.6, 0.6, 0.5))
    GI.head_wrap(kit, wrap_targets(kit), wrap, 'wrap', seed=4)
    canvas = kit.mat('rig_canvas', G.src_nylon(8, (0.45, 0.42, 0.30), rough=0.92, wear=0.6), (0.45, 0.42, 0.3))
    web = kit.mat('rig_web', G.src_nylon(9, (0.35, 0.33, 0.24), rough=0.9, wear=0.5), (0.35, 0.33, 0.24))
    GI.chest_rig(kit, jacket, canvas, web, 3, z0=1.05, z1=1.27)
    return kit


def build_civilian_a(cid):
    """Older civilian: off-white dishdasha, red-checked ghutra with black agal, sandals, full grey beard."""
    kit = new_kit(cid)
    robe = plain_cloth(kit, 'robe_white', 'male_casualsuit02', (0.82, 0.80, 0.74), seed=41, detail=0.0, dirt=0.4)
    top, _ = fit(kit, 'clothes', 'male_casualsuit02', robe, comps=is_top, decim=0.6)
    tighten(kit, top, full_body_bvh(kit), gap=0.014, keep=0.55)
    GI.robe_skirt(kit, robe_proc(kit, 'robe_skirt_w', (0.82, 0.80, 0.74), 41), z0=1.02, z1=0.09, flare=0.11, seed=5)
    sandals(kit, (0.24, 0.15, 0.09))
    finish_head(kit, cid, None, hair_tint=(0.35, 0.33, 0.31), eye='brown', beard=1.0, beard_rgb=(0.42, 0.40, 0.37), robe=True)
    gh = kit.mat('ghutra', GI.src_keffiyeh((0.90, 0.88, 0.84), (0.66, 0.10, 0.10), cell=0.13, seed=6, dirt_amt=0.15), (0.8, 0.5, 0.5))
    w = GI.head_wrap(kit, wrap_targets(kit), gh, 'ghutra', seed=6, folds=0.004)
    GI.agal(kit, kit.mat('agal', G.src_solid((0.03, 0.03, 0.03), 0.5, 0.05), (0.03, 0.03, 0.03)), w)
    return kit

"""Insurgent / civilian gear: dishdasha skirt, shemagh / ghutra head wraps, Type 56 chest rig, sandals, agal.
Same conventions as gear.py (rest pose, soft boxes, procedural sources)."""
import math

import bpy
import bmesh
import numpy as np
from mathutils import Vector, Quaternion

import chcommon as C
import chbuild as K
import texbake as T
from chbuild import smooth
from gear import (ray, box_at, path_strap, wrap_band, conform_panel, full_body, bind_torso, bind_rigid_avg, tube)


def robe_skirt(kit, mat, z0=1.02, z1=0.10, flare=0.10, folds=13, depth=0.012, seed=0, nseg=40, nz=14):
    """Lower part of a dishdasha / thobe: hangs from the hips over both legs to the ankles with vertical drape
    folds that deepen towards the hem; weights blend pelvis -> thighs."""
    fb, bvh = full_body(kit)
    rng = np.random.default_rng(seed)
    ph = rng.uniform(0, 2 * math.pi, 3)
    cy = -0.01
    rows = []
    bm = bmesh.new()
    Rprev = None
    for j in range(nz + 1):
        t = j / nz
        z = z0 + (z1 - z0) * t
        c = Vector((0, cy, z))
        rr = np.zeros(nseg)
        for i in range(nseg):
            a = 2 * math.pi * i / nseg
            d = Vector((math.sin(a), math.cos(a), 0))
            p, nn = ray(bvh, c + d * 0.6, -d, 0.6)
            rr[i] = (p - c).length if p is not None else 0.12
        for _ in range(4):
            rr = np.maximum(rr, 0.5 * rr + 0.25 * (np.roll(rr, 1) + np.roll(rr, -1)))
        if Rprev is not None:
            rr = np.maximum(rr, Rprev * 0.97)            # the cloth falls, it does not cling between the legs
        Rprev = rr
        row = []
        for i in range(nseg):
            a = 2 * math.pi * i / nseg
            amp = depth * smooth(0.05, 0.6, t)
            fold = math.sin(folds * a + ph[0] + 0.6 * math.sin(3 * a + ph[1])) * amp
            fold += 0.4 * amp * math.sin(2 * folds * a + ph[2])
            r = rr[i] + 0.012 + flare * t ** 1.3 + fold
            zz = z + (0.012 * math.sin(2 * a + ph[1]) if j == nz else 0)
            row.append(bm.verts.new((math.sin(a) * r, cy + math.cos(a) * r, zz)))
        rows.append(row)
    for j in range(nz):
        for i in range(nseg):
            bm.faces.new((rows[j][i], rows[j + 1][i], rows[j + 1][(i + 1) % nseg], rows[j][(i + 1) % nseg]))
    me = bpy.data.meshes.new('robe_skirt')
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new('robe_skirt', me)
    bpy.context.scene.collection.objects.link(o)
    _outward(o, Vector((0, cy, 0)), axis_z=True)
    for p in me.polygons:
        p.use_smooth = True
    me.materials.append(mat)
    m = o.modifiers.new('sol', 'SOLIDIFY')
    m.thickness = 0.004
    m.offset = -1
    K.apply_mods(o)
    C.box_uv(o, 1.0)
    o.vertex_groups.clear()
    gp, gl, gr = (o.vertex_groups.new(name=n) for n in ('pelvis', 'thigh_l', 'thigh_r'))
    for v in o.data.vertices:
        t = min(max((z0 - 0.08 - v.co.z) / 0.5, 0.0), 1.0)
        centre = 1 - min(abs(v.co.x) / 0.14, 1.0)
        wp = max(1 - t * (0.62 - 0.30 * centre), 0.4)
        side = min(max(0.5 - v.co.x / 0.26, 0.0), 1.0)          # 1 = left (x < 0)
        rest = 1 - wp
        gp.add([v.index], wp, 'REPLACE')
        if rest * side > 1e-3:
            gl.add([v.index], rest * side, 'REPLACE')
        if rest * (1 - side) > 1e-3:
            gr.add([v.index], rest * (1 - side), 'REPLACE')
    K.bind(o, kit.arm)
    o['decimate'] = 0.7
    kit.add(o, 'legs')
    bpy.data.objects.remove(fb, do_unlink=True)
    return o


def _outward(o, c, axis_z=False):
    me = o.data
    flip = 0
    for p in me.polygons:
        d = p.center - c
        if axis_z:
            d.z = 0
        flip += 1 if p.normal.dot(d) < 0 else -1
    if flip > 0:
        for p in me.polygons:
            p.flip()
    me.update()


def head_wrap(kit, head_objs, mat, style='wrap', seed=0, off=0.010, folds=0.006):
    """Shemagh / keffiyeh: cloth shell over the skull and neck. style 'wrap' (turban-like, face open),
    'mask' (face covered up to the eyes), 'ghutra' (draped headdress over the shoulders, worn with an agal).
    The object's UV is the (azimuth, elevation) cloth parameterisation used for the check pattern."""
    bvh = K.body_bvh(head_objs)
    H = Vector(kit.rest['Head'][0])
    c = H + Vector((0, 0.01, 0.075))
    rng = np.random.default_rng(seed)
    ph = rng.uniform(0, 2 * math.pi, 4)
    nu = 40
    el_lo = {'wrap': -48, 'mask': -55, 'ghutra': -78}[style]
    nv = 16
    els = [90 - j * (90 - el_lo) / nv for j in range(nv + 1)]
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.new('UVMap')
    rows, keep = [], []
    for j, eld in enumerate(els):
        el = math.radians(eld)
        row, krow = [], []
        for i in range(nu):
            az = 2 * math.pi * i / nu
            d = Vector((math.cos(el) * math.sin(az), math.cos(el) * math.cos(az), math.sin(el)))
            p, nn = ray(bvh, c + d * 0.45, -d, 0.45)
            r = (p - c).length if p is not None else 0.11
            front = math.cos(az)
            wr = folds * (math.sin(7 * az + 3 * el + ph[0]) * 0.6 + math.sin(13 * az - 5 * el + ph[1]) * 0.4)
            o_ = off + abs(wr) * smooth(-45, -20, eld) * 0.5 + abs(wr) * (1 - smooth(-45, -20, eld)) * 0.0 + abs(wr) * 0.5 + 0.006 * smooth(0.0, -40, eld) * (1 - 0.6 * max(front, 0))
            if style == 'ghutra':
                o_ += 0.035 * smooth(10, -50, eld) * (1 - 0.5 * max(front, 0))
            if style == 'mask':
                o_ += 0.006 * smooth(-5, -40, eld) * max(front, 0)       # loose over the nose and mouth
            row.append(bm.verts.new(c + d * (r + o_)))
            azd = math.degrees(az)
            azd = azd - 360 if azd > 180 else azd
            face = abs(azd) < 58
            if style == 'wrap':
                hole = face and -60 < eld < 9
            elif style == 'mask':
                hole = abs(azd) < 54 and -10 < eld < 15
            else:
                hole = abs(azd) < 62 and eld < 22
            krow.append(not hole)
        rows.append(row)
        keep.append(krow)
    for j in range(nv):
        for i in range(nu):
            i2 = (i + 1) % nu
            if not (keep[j][i] and keep[j][i2] and keep[j + 1][i] and keep[j + 1][i2]):
                continue
            f = bm.faces.new((rows[j][i], rows[j + 1][i], rows[j + 1][i2], rows[j][i2]))
            for lp, (jj, ii) in zip(f.loops, ((j, i), (j + 1, i), (j + 1, i + 1), (j, i + 1))):
                lp[uvl].uv = (ii / nu * 4.0, (1 - jj / nv) * 1.6)
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context='VERTS')
    me = bpy.data.meshes.new('shemagh')
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new('shemagh', me)
    bpy.context.scene.collection.objects.link(o)
    me.materials.append(mat)
    for p in me.polygons:
        p.use_smooth = True
    _outward(o, c)
    m = o.modifiers.new('sol', 'SOLIDIFY')
    m.thickness = 0.003
    m.offset = -1
    K.apply_mods(o)
    o.vertex_groups.clear()
    gh, gn, gs = (o.vertex_groups.new(name=n) for n in ('Head', 'neck_01', 'spine_03'))
    for v in o.data.vertices:
        t = min(max((H.z + 0.0 - v.co.z) / 0.14, 0.0), 1.0)
        gh.add([v.index], 1 - t, 'REPLACE')
        if t > 0:
            gn.add([v.index], t * 0.6, 'REPLACE')
            gs.add([v.index], t * 0.4, 'REPLACE')
    K.bind(o, kit.arm)
    o['decimate'] = 0.55
    kit.add(o, 'head')
    if style in ('wrap', 'mask'):
        kn = box_at('wrap_knot', c + Vector((0.035, -0.118, -0.035)), (0.05, 0.03, 0.035), mat, sub=1)
        tail = path_strap('wrap_tail', [c + Vector((0.04, -0.125, -0.045)), c + Vector((0.05, -0.14, -0.10)),
                                        c + Vector((0.055, -0.145, -0.16)), c + Vector((0.05, -0.145, -0.21))],
                          0.075, 0.004, lambda p: Vector((0, -1, 0)), mat, sub=1)
        for x in (kn, tail):
            for lp in x.data.uv_layers[0].data:
                lp.uv = (lp.uv[0] * 8, lp.uv[1] * 8)
            K.rigid(x, kit.arm, 'Head')
            kit.add(x, 'head')
    return o


def src_keffiyeh(base=(0.88, 0.86, 0.80), line=(0.62, 0.08, 0.08), cell=0.11, seed=0, dirt_amt=0.3):
    """Keffiyeh / shemagh weave from the cloth UV (net of diagonal lines + small square motifs)."""
    base, line = np.array(base), np.array(line)

    def fn(a):
        uv = a['suv'] * (1.0 / cell)
        u, v = uv[:, 0], uv[:, 1]
        fu, fv = u % 1.0, v % 1.0
        d1 = np.abs(((u + v) % 1.0) - 0.5)
        d2 = np.abs(((u - v) % 1.0) - 0.5)
        net = (1 - smooth(0.04, 0.08, 0.5 - d1)) + (1 - smooth(0.04, 0.08, 0.5 - d2))
        motif = (1 - smooth(0.08, 0.12, np.maximum(np.abs(fu - 0.5), np.abs(fv - 0.5))))
        w = np.clip(net + motif * 0.9, 0, 1)
        col = base[None] + (line - base)[None] * w[:, None]
        col *= (0.92 + 0.12 * T.fbm(a['P'], 0.05, 3, seed))[:, None]
        col = K.dirt(a['P'], col, dirt_amt, seed + 3, ground=1.8)
        h = K.fabric_height(a['P'], a['N'], folds=0.6, ripstop=False, seed=seed) + (T.vnoise(a['P'], 0.0007, seed) - 0.5) * 0.00008
        return {'base': col, 'rough': 0.92, 'height': h}
    return K.src_proc(fn, 1.1)


def chest_rig(kit, ref, canvas, webbing, n_pockets=3, z0=1.04, z1=1.26):
    """Chinese Type 56 style chest rig: canvas panel with tall AK magazine pockets, two small side pockets,
    shoulder straps crossing on the back to the waist strap."""
    bvh = K.body_bvh([ref])
    out = []
    panel, A = conform_panel('rig_panel', bvh, lambda v: 0.16, z0, z1, 0.006, 0.012, canvas, 1, 6, 4, curve=1.8)
    out.append(('soft', panel))
    xs = {3: (-0.075, 0.0, 0.075), 4: (-0.105, -0.035, 0.035, 0.105)}[n_pockets]
    pw = 0.07 if n_pockets == 3 else 0.064
    for x in xs:
        zc = z0 + 0.10
        y = A + 0.012 - 1.8 * x * x
        out.append(('rigid', box_at('rig_mag', (x, y + 0.022, zc), (pw, 0.044, 0.17), canvas,
                                    rot=Quaternion(Vector((1, 0, 0)), math.radians(-6)), n=(1, 1, 2))))
        out.append(('rigid', box_at('rig_flap', (x, y + 0.028, zc + 0.08), (pw + 0.006, 0.05, 0.03), canvas)))
    for s in (-1, 1):
        x = s * 0.165
        y = A + 0.01 - 1.8 * x * x
        out.append(('rigid', box_at('rig_side', (x, y + 0.012, z0 + 0.06), (0.05, 0.035, 0.085), canvas)))
    for s in (-1, 1):
        x = s * 0.09
        pts = []
        for t in np.linspace(0, 1, 7):
            ang = math.pi * t
            d = Vector((0, math.cos(ang), math.sin(ang)))
            cc = Vector((x * (1 - 0.3 * t), -0.02, 1.36))
            p, nn = ray(bvh, cc + d * 0.5, -d, 0.5)
            r = (p - cc).length if p is not None else 0.14
            pts.append(cc + d * (r + 0.004))
        pts[0] = Vector((x, A + 0.004 - 1.8 * x * x, z1 - 0.01))
        p, nn = ray(bvh, (-s * 0.10, -0.6, z0 + 0.04), (0, 1, 0))
        yb = (p.y - 0.006) if p is not None else -0.15
        pts.append(Vector((-s * 0.05, yb, 1.17)))
        pts.append(Vector((-s * 0.12, yb, z0 + 0.04)))
        out.append(('soft', path_strap('rig_strap', pts, 0.035, 0.004, lambda p, cc=Vector((0, -0.02, 1.25)): p - cc, webbing, sub=0)))
    out.append(('soft', wrap_band('rig_belt', bvh, (0, -0.01), 60, 300, z0 - 0.005, z0 + 0.028, 0.004, 0.004, webbing, n=10, nz=1, sub=0)))
    for kind, o in out:
        if kind == 'soft':
            bind_torso(kit, o, ref)
        else:
            bind_rigid_avg(kit, o, ref)
        o['decimate'] = 0.7
        kit.add(o, 'torso')
    return A


def sandals(kit, sole_mat, strap_mat):
    fb, bvh = full_body(kit)
    for s in 'lr':
        ank = Vector(kit.rest['foot_' + s][0])
        toe = Vector(kit.rest['ball_leaf_' + s][1]) if ('ball_leaf_' + s) in kit.rest else Vector(kit.rest['ball_' + s][1])
        heel_y = ank.y - 0.075
        L = toe.y + 0.02 - heel_y
        cx = (ank.x + toe.x) / 2
        out = [box_at('sandal_sole', (cx, heel_y + L / 2, 0.008), (0.10, L, 0.016), sole_mat, n=(1, 2, 1))]
        for yy, w in ((ank.y + 0.075, 0.022), (ank.y + 0.01, 0.018)):
            pts = []
            cc = Vector((cx, yy, 0.025))
            for k in range(9):
                th = math.radians(k * 22.5)
                d = Vector((math.cos(th), 0, math.sin(th)))
                p, nn = ray(bvh, cc + d * 0.2, -d, 0.2)
                pts.append((p + d * 0.003) if p is not None else cc + d * 0.04)
            pts[0].z = pts[-1].z = 0.014
            out.append(path_strap('sandal_strap', pts, w, 0.003, lambda p, cc=cc: p - cc, strap_mat, sub=0))
        by = kit.rest['ball_' + s][0][1]
        for x in out:
            x.vertex_groups.clear()
            gf, gb = x.vertex_groups.new(name='foot_' + s), x.vertex_groups.new(name='ball_' + s)
            for v in x.data.vertices:
                t = min(max((v.co.y - (by - 0.03)) / 0.05, 0.0), 1.0)
                gf.add([v.index], 1 - t, 'REPLACE')
                if t > 0:
                    gb.add([v.index], t, 'REPLACE')
            K.bind(x, kit.arm)
            kit.add(x, 'legs')
    bpy.data.objects.remove(fb, do_unlink=True)


def agal(kit, mat, wrap_obj):
    """Black double cord ring on top of the ghutra (just above the brow, level all round)."""
    bvh = K.body_bvh([wrap_obj])
    H = Vector(kit.rest['Head'][0])
    for dz in (0.118, 0.134):
        c = Vector((H.x, H.y - 0.005, H.z + dz))
        pts = []
        for i in range(24):
            az = 2 * math.pi * i / 24
            d = Vector((math.sin(az), math.cos(az), 0.0))
            p, nn = ray(bvh, c + d * 0.3, -d, 0.3)
            pts.append((p + d * 0.007) if p is not None else c + d * 0.11)
        pts.append(pts[0])
        o = tube('agal', pts, 0.0075, mat, seg=6, cap=False)
        K.rigid(o, kit.arm, 'Head')
        kit.add(o, 'head')

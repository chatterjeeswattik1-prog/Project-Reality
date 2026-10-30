"""Contract weapon models m4a1 and aks74u, cut out of the user's animated first-person packs, plus the frame the game
needs to hang any contract weapon on the pack's weapon bone.
    blender -b --factory-startup --python tools/blender/fpweapons.py -- m4a1|aks74u [--explore <out_prefix>]
The pack is posed at its idle frame (first frame of the fire clip), the weapon meshes are baked there and moved into the
weapon bone's frame (location + rotation, no scale), then oriented / grip-centred like any other weapon (ucommon).
`FRAME <id>` prints the contract frame (origin, right, forward, up) in Blender world space at that idle frame; the game
converts it to three.js space (x, z, -y) and expresses it in the bone's frame (src/player/fprig.ts PACKS)."""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
import bpy
import ucommon as U
from mathutils import Vector, Matrix

PACKS = {
    # src, idle action, idle frame, weapon bone, arm meshes (deleted), weapon meshes to drop
    'm4a1': ('US-Forces/m4_-_fps_weapon_animations_pack_v.1.glb', 'Fire', 180.8, 'Main_j_049', ('Object_7', 'Object_8')),
    'aks74u': ('Insurgent/animated_aks-74u.glb', 'armature|Fire_single', 0.0, 'wpn_body_068', ('Object_9',)),
}


def pose_bake(id_):
    src, act_name, frame, wbone, arms = PACKS[id_]
    U.load(src)
    arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
    act = bpy.data.actions[act_name]
    arm.animation_data_create(); arm.animation_data.action = act
    if getattr(act, 'slots', None):
        arm.animation_data.action_slot = act.slots[0]
    bpy.context.scene.frame_set(int(frame), subframe=frame - int(frame))
    bpy.context.view_layer.update()
    bw = arm.matrix_world @ arm.pose.bones[wbone].matrix
    loc, rot, _ = bw.decompose()
    B = Matrix.Translation(loc) @ rot.to_matrix().to_4x4()
    for n in arms:
        bpy.data.objects.remove(bpy.data.objects[n], do_unlink=True)
    dg = bpy.context.evaluated_depsgraph_get()
    for o in U.meshes():
        mw = o.matrix_world.copy()
        if any(m.type == 'ARMATURE' for m in o.modifiers):
            me = bpy.data.meshes.new_from_object(o.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
            o.data = me
            for m in list(o.modifiers):
                o.modifiers.remove(m)
        elif o.data.users > 1:
            o.data = o.data.copy()
        o.parent = None
        o.matrix_world = Matrix.Identity(4)
        o.data.transform(mw)
        if mw.determinant() < 0:
            import bmesh
            bm = bmesh.new(); bm.from_mesh(o.data); bmesh.ops.reverse_faces(bm, faces=bm.faces); bm.to_mesh(o.data); bm.free()
    for o in list(bpy.data.objects):
        if o.type != 'MESH':
            bpy.data.objects.remove(o, do_unlink=True)
    # into the weapon bone's frame
    T = B.inverted()
    U.xform(T)
    return T


def frame_out(id_, T):
    """T: Blender world (idle) -> contract space. Print the contract frame in Blender world."""
    Ti = T.inverted()
    o = Ti @ Vector((0, 0, 0))
    ax = [(Ti.to_3x3() @ Vector(v)) for v in ((1, 0, 0), (0, 1, 0), (0, 0, 1))]
    k = ax[1].length
    print(f'FRAME {id_} origin {tuple(round(v, 5) for v in o)} right {tuple(round(v, 5) for v in ax[0].normalized())} '
          f'fwd {tuple(round(v, 5) for v in ax[1].normalized())} up {tuple(round(v, 5) for v in ax[2].normalized())} scale {k:.5f}')


class Track:
    """Accumulates the transforms applied after pose_bake so the contract frame can be printed."""
    def __init__(self, T): self.T = T
    def orient(self, fwd, up):
        f, u = U.AX[fwd], U.AX[up]; S = Matrix((f.cross(u), f, u)).to_4x4(); U.xform(S); self.T = S @ self.T
    def rot(self, axis, deg):
        import math
        R = Matrix.Rotation(math.radians(deg), 4, axis); U.xform(R); self.T = R @ self.T
    def scale_len(self, L):
        lo, hi = U.bounds(); k = L / (hi[1] - lo[1]); S = Matrix.Scale(k, 4); U.xform(S); self.T = S @ self.T; return k
    def move(self, v):
        M = Matrix.Translation(Vector(v)); U.xform(M); self.T = M @ self.T


def prep_m4a1(tr):
    # bone frame: muzzle +Z, magazine side -Y. Drop the spare magazine (Mag2 + its round) parked off the gun.
    U.delete(lambda o: o.name.startswith(('Mag2', 'Bullet5_56x45mm_Bullet5_56x45mm_D_0.001')))
    tr.orient('+Z', '+Y')


def prep_aks74u(tr):
    # bone frame: muzzle -Z, magazine side -Y. One skinned mesh holds both magazines: cut the spare (mag_2) away.
    for o in U.meshes():
        g = U.split_groups(o, ['wpn_magazine_2_074', 'wpn_bullets_2_075', 'wpn_magazine_rig_2_078', 'wpn_bullets_rig.001_079'], 'spare')
        if g:
            bpy.data.objects.remove(g, do_unlink=True)
    for o in list(U.meshes()):
        if not len(o.data.polygons):
            bpy.data.objects.remove(o, do_unlink=True)
    tr.orient('-Z', '+Y')


def finish(id_, tr, body, grip, parts, nodes, tex=1024):
    """Grip to the origin, root + parts + empties (as uweapons_ins.finish), export, print the contract frame."""
    g = Vector(grip)
    tr.move(-g)
    r = U.root(id_)
    U.parent(body, r)
    objs = {id_: r}
    for o, p in parts:
        U.set_origin(o, Vector(p) - g); U.parent(o, r); objs[o.name] = o
    for name, (p, par) in nodes.items():
        U.empty(name, Vector(p) - g, objs[par] if par else r)
    U.shrink_textures(tex)
    U.export(id_)
    frame_out(id_, tr.T)


def build_m4a1(tr):
    mag = U.join([o for o in U.meshes() if o.name.startswith(('Mag1', 'Bullet5'))], 'mag')
    charge = U.join([o for o in U.meshes() if o.name.startswith('Bolt_')], 'charge')
    body = U.join([o for o in U.meshes() if o not in (mag, charge)], 'm4a1_body')
    # Rear aperture centre and front post tip measured on a 5000 px/m render of the export: the sight line is level.
    # sight check (sightcheck.py): the aperture sits 3.3 mm left of the centreline, post 2.5 mm left
    eye = Vector((-0.0033, -0.0635, 0.0869))
    finish('m4a1', tr, body, (0, -0.077, -0.073),
           parts=[(mag, (-0.003, 0.072, 0.0)), (charge, (-0.003, 0.038, 0.02))],
           nodes={'muzzle': ((0, 0.513, 0.018), None), 'eye': (eye, None), 'cheek': (eye - Vector((0, 0.13, 0)), None),
                  'front_post': ((-0.0025, 0.346, 0.0868), None),
                  'grip_r': ((0, -0.077, -0.073), None), 'grip_l': ((0, 0.25, -0.02), None),
                  'eject': ((0.018, 0.03, 0.022), None), 'butt': ((0, -0.348, -0.03), None),
                  'mag_dir': ((-0.003, 0.08, -0.12), None), 'hand_mag': ((-0.02, 0.068, -0.09), 'mag'),
                  'charge_back': ((-0.003, -0.032, 0.02), None), 'hand_charge': ((0, -0.09, 0.046), 'charge')})


def build_aks74u(tr):
    mag, charge = [], []
    for o in list(U.meshes()):
        m = U.split_groups(o, ['wpn_magazine_072', 'wpn_bullets_073', 'wpn_magazine_rig_076', 'wpn_bullets_rig_077'], o.name + '_mag')
        if m: mag.append(m)
        c = U.split_groups(o, ['wpn_zatvor_069'], o.name + '_charge')
        if c: charge.append(c)
    for o in list(U.meshes()):
        if not len(o.data.polygons):
            bpy.data.objects.remove(o, do_unlink=True)
    mag = U.join(mag, 'mag'); charge = U.join(charge, 'charge')
    body = U.join([o for o in U.meshes() if o not in (mag, charge)], 'aks74u_body')
    lo, hi = U.bounds([charge]); print('CHARGE bounds', tuple(lo), tuple(hi))
    lo, hi = U.bounds([mag]); print('MAG bounds', tuple(lo), tuple(hi))
    # rear leaf (y 0.048 here) notch shoulders and front post tip, read off the mesh (AK picture: tip level with the shoulders)
    eye, post = Vector((0, 0.048, 0.0839)), Vector((0, 0.288, 0.0841))
    cheek = eye + (eye - post) * ((eye.y + 0.16) / (post.y - eye.y))
    hc = Vector((hi.x if False else 0.045, 0.11, 0.035))
    finish('aks74u', tr, body, (0, -0.082, -0.048),
           parts=[(mag, (0, 0.042, -0.004)), (charge, (0.03, 0.11, 0.035))],
           nodes={'muzzle': ((0, 0.382, 0.03), None), 'eye': (eye, None), 'cheek': (cheek, None), 'front_post': (post, None),
                  'grip_r': ((0, -0.082, -0.048), None), 'grip_l': ((0, 0.22, 0.0), None),
                  'eject': ((0.02, 0.06, 0.04), None), 'butt': ((0, -0.333, -0.03), None),
                  'hand_mag': ((-0.02, 0.02, -0.08), 'mag'),
                  'charge_back': ((0.03, 0.02, 0.035), None), 'hand_charge': (hc, 'charge')})


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:]
    wid = argv[0]
    T = pose_bake(wid)
    tr = Track(T)
    globals()[f'prep_{wid}'](tr)
    if '--explore' in argv:
        out = argv[argv.index('--explore') + 1]
        lo, hi = U.bounds()
        print('ALL', tuple(round(v, 4) for v in lo), tuple(round(v, 4) for v in hi))
        for o in sorted(U.meshes(), key=lambda o: o.name):
            a, b = U.bounds([o])
            print(f'MESH {o.name[:40]:40s} tris {U.tris([o]):6d} {tuple(round(v, 3) for v in a)} .. {tuple(round(v, 3) for v in b)} '
                  f'vg {[g.name for g in o.vertex_groups if g.name.startswith("wpn")]}')
        for v in ('side', 'top', 'back'):
            U.ortho(f'{out}_{v}.png', v, ppm=int(argv[argv.index('--ppm') + 1]) if '--ppm' in argv else 1400)
    else:
        globals()[f'build_{wid}'](tr)

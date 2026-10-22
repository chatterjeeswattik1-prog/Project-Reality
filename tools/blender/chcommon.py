"""Character helpers for tools/blender/characters.py (Blender 4.5, headless).

Conventions (see CLAUDE.md): metres, Blender Z up, characters face +Y (glTF/three.js -Z).
The Quaternius UBC male is the one skeleton used everywhere (65 bones, Unreal names). UAL clips are
retargeted onto it so that every joint gets the same *local rotation* as in the source clip (which is
what playing the UAL glTF clip directly would do), while bone lengths stay those of the UBC body. Only the
pelvis is translated (scaled by the leg-length ratio so the feet stay on the ground).
"""
import math
import os
import bpy
import bmesh
import numpy as np
from mathutils import Matrix, Quaternion, Vector, Euler
from mathutils.bvhtree import BVHTree

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'src-assets', 'quaternius')
UBC_DIR = os.path.join(SRC, 'UBC', 'Base Characters', 'Godot - UE')
UBC_TEX = os.path.join(SRC, 'UBC', 'Base Characters', 'Textures')
UBC_MALE = os.path.join(UBC_DIR, 'Superhero_Male_FullBody.gltf')
HAIR_DIR = os.path.join(SRC, 'UBC', 'Hairstyles', 'Rigged to Head Bone', 'glTF (Godot -Unreal)')
UAL1 = os.path.join(SRC, 'UAL1', 'Unreal-Godot', 'UAL1_Standard.glb')
UAL2 = os.path.join(SRC, 'UAL2', 'Unreal-Godot', 'UAL2_Standard.glb')
FPS = 30
TURN = Matrix.Rotation(math.pi, 4, 'Z')   # source assets face -Y; the game wants +Y forward
SCALE = 1.78 / 1.81                       # UBC male is 1.81 m to the top of the head; we want ~1.78 m
XFORM = Matrix.Scale(SCALE, 4) @ TURN

# ---------------------------------------------------------------------------------------------- scene

def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    s = bpy.context.scene
    s.unit_settings.system = 'METRIC'
    s.render.fps = FPS
    return s


def import_gltf(path):
    before = set(bpy.data.objects)
    acts = set(bpy.data.actions)
    bpy.ops.import_scene.gltf(filepath=path, bone_heuristic='BLENDER', import_shading='NORMALS')
    new = [o for o in bpy.data.objects if o not in before]
    new_acts = [a for a in bpy.data.actions if a not in acts]
    return new, new_acts


def set_active(o):
    if bpy.context.object and bpy.context.object.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.select_all(action='DESELECT')
    bpy.context.view_layer.objects.active = o
    o.select_set(True)


def turn_armature(arm, m=TURN):
    """Rotate the rest skeleton 180 degrees about Z (face +Y). Pose-space data stays valid."""
    set_active(arm)
    bpy.ops.object.mode_set(mode='EDIT')
    for eb in arm.data.edit_bones:
        eb.transform(m)
    bpy.ops.object.mode_set(mode='OBJECT')


def load_base():
    """Import the UBC male, face +Y, drop the helper sphere. Returns (armature, {name: mesh})."""
    objs, _ = import_gltf(UBC_MALE)
    arm = [o for o in objs if o.type == 'ARMATURE'][0]
    meshes = {}
    for o in objs:
        if o.type != 'MESH':
            continue
        if o.parent is not arm:
            bpy.data.objects.remove(o, do_unlink=True)
            continue
        o.data.transform(XFORM)
        meshes[o.name] = o
    turn_armature(arm, XFORM)
    arm.name = 'Armature'
    arm.data.name = 'Armature'
    return arm, meshes


def load_hair(name, arm):
    """Import a UBC hairstyle (rigged to Head) and bind it 100% to Head of our armature."""
    objs, _ = import_gltf(os.path.join(HAIR_DIR, name + '.gltf'))
    out = None
    for o in objs:
        if o.type == 'MESH' and out is None:
            mw = o.matrix_world.copy()
            o.parent = None
            o.matrix_world = mw
            set_active(o)
            bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
            o.data.transform(XFORM)
            out = o
    for o in objs:
        if o is not out:
            bpy.data.objects.remove(o, do_unlink=True)
    rigid_bind(out, arm, 'Head')
    return out

# ---------------------------------------------------------------------------------------------- rig math

class Rig:
    """Rest data of an armature and pose <-> basis conversions, all in armature space."""

    def __init__(self, arm):
        self.arm = arm
        bones = arm.data.bones
        self.rest = {b.name: b.matrix_local.copy() for b in bones}
        self.parent = {b.name: (b.parent.name if b.parent else None) for b in bones}
        self.rel = {}
        for b in bones:
            p = self.parent[b.name]
            self.rel[b.name] = (self.rest[p].inverted() @ self.rest[b.name]) if p else self.rest[b.name].copy()
        self.rrot = {n: m.to_quaternion() for n, m in self.rest.items()}
        self.order = []
        def walk(b):
            self.order.append(b.name)
            for c in b.children:
                walk(c)
        for b in bones:
            if b.parent is None:
                walk(b)

    def head(self, n):
        return self.rest[n].translation.copy()

    def seg(self, a, b):
        """Rest vector from joint a to joint b."""
        return self.rest[b].translation - self.rest[a].translation

    def fk(self, basis):
        pose = {}
        for n in self.order:
            p = self.parent[n]
            P = pose[p] if p else Matrix.Identity(4)
            pose[n] = P @ self.rel[n] @ basis.get(n, Matrix.Identity(4))
        return pose

    def to_basis(self, pose):
        out = {}
        for n in self.order:
            p = self.parent[n]
            P = pose[p] if p else Matrix.Identity(4)
            out[n] = (P @ self.rel[n]).inverted() @ pose[n]
        return out


def quat_fix(q, prev):
    if prev is not None and q.dot(prev) < 0:
        return -q
    return q


def write_action(arm, name, frames, loc_bones=('pelvis',), cyclic=False):
    """frames: list of {bone: Matrix4 basis}. Keys every frame (linear), rotation for all bones,
    location for loc_bones. Returns the action (with a fake user, so it survives for export)."""
    old = bpy.data.actions.get(name)
    if old:
        bpy.data.actions.remove(old)
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    if arm.animation_data is None:
        arm.animation_data_create()
    arm.animation_data.action = act
    n = len(frames)
    for b in arm.pose.bones:
        b.rotation_mode = 'QUATERNION'
    for bn in [b.name for b in arm.data.bones]:
        qs, prev = [], None
        for fr in frames:
            q = fr[bn].to_quaternion() if bn in fr else Quaternion()
            q = quat_fix(q, prev)
            q.normalize()
            qs.append(q)
            prev = q
        chans = [('rotation_quaternion', i, [q[i] for q in qs]) for i in range(4)]
        if bn in loc_bones:
            ls = [fr[bn].to_translation() if bn in fr else Vector() for fr in frames]
            chans += [('location', i, [l[i] for l in ls]) for i in range(3)]
        for prop, i, vals in chans:
            fc = act.fcurve_ensure_for_datablock(arm, 'pose.bones["%s"].%s' % (bn, prop), index=i)
            fc.keyframe_points.add(n)
            co = []
            for f, v in enumerate(vals):
                co += [float(f), float(v)]
            fc.keyframe_points.foreach_set('co', co)
            fc.keyframe_points.foreach_set('interpolation', [1] * n)   # LINEAR
            fc.update()
    return act

# ---------------------------------------------------------------------------------------------- retarget

def retarget(arm, rig, path, names, prefix=''):
    """Import a UAL file and rebuild the named clips on `arm` (rest = rig). Returns {name: action}."""
    objs, acts = import_gltf(path)
    src = [o for o in objs if o.type == 'ARMATURE'][0]
    for o in objs:
        if o.type == 'MESH':
            bpy.data.objects.remove(o, do_unlink=True)
    turn_armature(src)
    srig = Rig(src)
    byname = {}
    for a in acts:
        byname[a.name.split('.')[0]] = a
        a.name = 'src_' + a.name
    # Pelvis height mapping: hip-to-ankle scales with the leg-length ratio.
    leg_u = rig.seg('thigh_l', 'calf_l').length + rig.seg('calf_l', 'foot_l').length
    leg_a = srig.seg('thigh_l', 'calf_l').length + srig.seg('calf_l', 'foot_l').length
    s = leg_u / leg_a
    hip_u = rig.head('thigh_l').z - rig.head('pelvis').z
    hip_a = srig.head('thigh_l').z - srig.head('pelvis').z
    ank_u, ank_a = rig.head('foot_l').z, srig.head('foot_l').z
    feet = ('foot_l', 'foot_r', 'ball_l', 'ball_r')

    def clearance(r, pose):
        return min(pose[f].translation.z - r.head(f).z for f in feet)

    out = {}
    for nm in names:
        a = byname[nm]
        f0, f1 = int(round(a.frame_range[0])), int(round(a.frame_range[1]))
        curves = {}
        for fc in a.fcurves:
            curves[(fc.data_path, fc.array_index)] = fc
        frames = []
        for f in range(f0, f1 + 1):
            sb = {}
            for bn in srig.order:
                def ev(prop, i, d):
                    fc = curves.get(('pose.bones["%s"].%s' % (bn, prop), i))
                    return fc.evaluate(f) if fc else d
                q = Quaternion([ev('rotation_quaternion', i, (1, 0, 0, 0)[i]) for i in range(4)])
                l = Vector([ev('location', i, 0.0) for i in range(3)])
                sb[bn] = Matrix.LocRotScale(l, q, None)
            spose = srig.fk(sb)
            fr = {}
            for bn in rig.order:
                if bn not in sb:
                    continue
                local = srig.rel[bn] @ sb[bn]
                if bn in ('pelvis', 'root'):
                    p = srig.parent[bn]
                    w = spose[bn].translation
                    w = Vector((w.x * s, w.y * s, w.z * s))
                    Pu = rig.rest[p] if p else Matrix.Identity(4)
                    t = Pu.inverted() @ w
                else:
                    t = rig.rel[bn].translation
                M = Matrix.LocRotScale(t, local.to_quaternion(), None)
                fr[bn] = rig.rel[bn].inverted() @ M
            # Feet: when the body is up (standing, crouching), lift/lower the pelvis so foot clearance
            # matches the source (scaled). Lying poses keep the plain scaled height.
            pz = spose['pelvis'].translation.z
            wgt = min(max((pz - 0.25) / 0.2, 0.0), 1.0)
            if wgt > 0:
                upose = rig.fk(fr)
                dzf = wgt * (clearance(srig, spose) * s - clearance(rig, upose))
                wpos = upose['pelvis'].translation + Vector((0, 0, dzf))
                P = upose['root']
                M = Matrix.LocRotScale(P.inverted() @ wpos, (rig.rel['pelvis'] @ fr['pelvis']).to_quaternion(), None)
                fr['pelvis'] = rig.rel['pelvis'].inverted() @ M
            frames.append(fr)
        out[nm] = write_action(arm, prefix + nm, frames, loc_bones=('pelvis', 'root'))
    for a in acts:
        bpy.data.actions.remove(a)
    bpy.data.objects.remove(src, do_unlink=True)
    return out

# ---------------------------------------------------------------------------------------------- posing (authored clips)

def qe(x=0.0, y=0.0, z=0.0):
    """Quaternion from XYZ Euler degrees (rotation in the character's rest frame)."""
    return Euler((math.radians(x), math.radians(y), math.radians(z)), 'XYZ').to_quaternion()


def _frame(d, n):
    a1 = d.normalized()
    a2 = (n - a1 * n.dot(a1)).normalized()
    a3 = a1.cross(a2)
    return Matrix((a1, a2, a3)).transposed()


def align(d0, n0, d1, n1):
    """Rotation taking (d0, n0) onto (d1, n1) (directions, with n as the twist reference)."""
    return (_frame(d1, n1) @ _frame(d0, n0).transposed()).to_quaternion()


CHAINS = {
    # name: (upper, lower, end, hinge normal in rest = cross(upper_dir, lower_dir) when bent)
    'leg_l': ('thigh_l', 'calf_l', 'foot_l', Vector((-1, 0, 0))),
    'leg_r': ('thigh_r', 'calf_r', 'foot_r', Vector((-1, 0, 0))),
    'arm_l': ('upperarm_l', 'lowerarm_l', 'hand_l', Vector((0, 0, -1))),
    'arm_r': ('upperarm_r', 'lowerarm_r', 'hand_r', Vector((0, 0, 1))),
}


class Poser:
    """Builds poses from a compact spec and turns them into bases.

    spec = {
      'pelvis': (Vector position, Quaternion world rotation),
      'E': {bone: Quaternion},   # extra rotation in the character's rest frame, on top of the parent's
      'W': {bone: Quaternion},   # absolute world rotation delta from rest (feet, hands)
      'ik': {'leg_l': (target, pole), ...}  # target = end joint (ankle / wrist) position, pole = knee/elbow direction
    }
    Bones not mentioned keep `base` basis (e.g. relaxed fingers from Idle_Loop)."""

    def __init__(self, rig, base=None):
        self.rig = rig
        self.base = base or {}
        self.warn = []

    def pose(self, spec):
        rig = self.rig
        E = spec.get('E', {})
        W = spec.get('W', {})
        ik = spec.get('ik', {})
        pose, D = {}, {}
        solved = {}
        I4 = Matrix.Identity(4)
        for n in rig.order:
            p = rig.parent[n]
            P = pose[p] if p else I4
            fkm = P @ rig.rel[n]
            head = fkm.translation
            Dp = D[p] if p else Quaternion()
            if n == 'pelvis' and 'pelvis' in spec:
                pos, rot = spec['pelvis']
                d = rot
                head = Vector(pos)
            elif n in solved:
                d = solved[n]
            elif n in W:
                d = W[n]
            elif n in E:
                d = Dp @ E[n]
            else:
                m = fkm @ self.base.get(n, I4)
                pose[n] = m
                D[n] = m.to_quaternion() @ rig.rrot[n].inverted()
                self._maybe_ik(n, pose, D, ik, solved)
                continue
            D[n] = d.normalized()
            pose[n] = Matrix.Translation(head) @ (D[n] @ rig.rrot[n]).to_matrix().to_4x4()
            self._maybe_ik(n, pose, D, ik, solved)
        return pose

    def _maybe_ik(self, n, pose, D, ik, solved):
        # when we reach the parent of an IK chain's upper bone, nothing to do; we solve at the upper bone itself
        for cname, (up, lo, end, n0) in CHAINS.items():
            if cname in ik and self.rig.parent[up] == n:
                tgt, pole = ik[cname]
                if callable(tgt):
                    tgt = tgt(pose)
                if callable(pole):
                    pole = pole(pose)
                rig = self.rig
                p0 = (pose[n] @ rig.rel[up]).translation
                L1 = rig.seg(up, lo).length
                L2 = rig.seg(lo, end).length
                t = Vector(tgt) - p0
                dist = t.length
                mx = (L1 + L2) * 0.9995
                if dist > mx:
                    if dist > (L1 + L2) * 1.01:
                        self.warn.append('%s overreach %.3f' % (cname, dist - L1 - L2))
                    dist = mx
                dist = max(dist, abs(L1 - L2) + 1e-3)
                td = t.normalized()
                pp = Vector(pole)
                pp = (pp - td * pp.dot(td))
                if pp.length < 1e-6:
                    pp = Vector((0, 1, 0)) if 'arm' in cname else Vector((0, 1, 0))
                pp.normalize()
                a = (L1 * L1 - L2 * L2 + dist * dist) / (2 * dist)
                h = math.sqrt(max(L1 * L1 - a * a, 0.0))
                elbow = p0 + td * a + pp * h
                endp = p0 + td * dist
                nn = pp.cross(td)
                d_up = rig.seg(up, lo).normalized()
                d_lo = rig.seg(lo, end).normalized()
                solved[up] = align(d_up, n0, (elbow - p0).normalized(), nn)
                solved[lo] = align(d_lo, n0, (endp - elbow).normalized(), nn)

    def basis(self, spec):
        return self.rig.to_basis(self.pose(spec))


def lerp_spec(a, b, t):
    """Blend two specs (positions lerp, rotations slerp). Keys missing in one side use identity/rest."""
    out = {}
    if 'pelvis' in a or 'pelvis' in b:
        pa, ra = a['pelvis']
        pb, rb = b['pelvis']
        out['pelvis'] = (Vector(pa).lerp(Vector(pb), t), ra.slerp(rb, t))
    for k in ('E', 'W'):
        da, db = a.get(k, {}), b.get(k, {})
        keys = set(da) | set(db)
        out[k] = {n: da.get(n, Quaternion()).slerp(db.get(n, Quaternion()), t) for n in keys}
    ia, ib = a.get('ik', {}), b.get('ik', {})
    out['ik'] = {}
    for n in set(ia) | set(ib):
        ta, pa = ia[n]
        tb, pb = ib[n]
        out['ik'][n] = (_lerpv(ta, tb, t), _lerpv(pa, pb, t))
    return out


def _lerpv(a, b, t):
    if callable(a) or callable(b):
        fa = a if callable(a) else (lambda pose, v=Vector(a): v)
        fb = b if callable(b) else (lambda pose, v=Vector(b): v)
        return lambda pose: fa(pose).lerp(fb(pose), t)
    return Vector(a).lerp(Vector(b), t)


def smooth01(t):
    return t * t * (3 - 2 * t)


def keyposes(keys, f, ease=None):
    """keys: list of (time_s, spec). Returns the blended spec at time f (seconds).
    Uses an eased blend between neighbouring keys with Catmull-Rom style velocity carry-over
    implemented as a blend of the eased and linear parameter (keeps motion from stopping dead at keys)."""
    if f <= keys[0][0]:
        return keys[0][1]
    for i in range(len(keys) - 1):
        t0, s0 = keys[i]
        t1, s1 = keys[i + 1]
        if f <= t1:
            u = (f - t0) / (t1 - t0)
            e = ease(u, i) if ease else smooth01(u)
            return lerp_spec(s0, s1, e)
    return keys[-1][1]


def bake_clip(arm, poser, name, fn, duration, cyclic=False):
    """fn(t_seconds, phase) -> spec. Samples at FPS, writes the action. For loops the last frame equals the first."""
    n = int(round(duration * FPS))
    frames = []
    for i in range(n + 1):
        t = i / FPS
        ph = (i % n) / n if cyclic else i / n
        if cyclic and i == n:
            t, ph = 0.0, 0.0
        frames.append(poser.basis(fn(t, ph)))
    return write_action(arm, name, frames, loc_bones=('pelvis',))

# ---------------------------------------------------------------------------------------------- meshes, weights

def rigid_bind(o, arm, bone):
    """Weight every vertex of o 100% to `bone` and bind it to arm (armature modifier, parented)."""
    o.vertex_groups.clear()
    g = o.vertex_groups.new(name=bone)
    g.add(list(range(len(o.data.vertices))), 1.0, 'REPLACE')
    bind(o, arm)
    return o


def bind(o, arm):
    mw = o.matrix_world.copy()
    o.parent = arm
    o.matrix_parent_inverse = arm.matrix_world.inverted()
    o.matrix_world = mw
    for m in list(o.modifiers):
        if m.type == 'ARMATURE':
            o.modifiers.remove(m)
    m = o.modifiers.new('Armature', 'ARMATURE')
    m.object = arm
    return o


def apply_all(o):
    """Apply transforms and non-armature modifiers (keeps the armature modifier)."""
    set_active(o)
    for m in list(o.modifiers):
        if m.type != 'ARMATURE':
            bpy.ops.object.modifier_apply(modifier=m.name)
    if o.parent is None:
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def join(objs, name):
    objs = [o for o in objs if o is not None]
    set_active(objs[0])
    for o in objs[1:]:
        o.select_set(True)
    bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    o.name = name
    o.data.name = name
    return o


def weights(o):
    """Dense (V, G) weight array and group names."""
    names = [g.name for g in o.vertex_groups]
    W = np.zeros((len(o.data.vertices), len(names)), np.float32)
    for v in o.data.vertices:
        for g in v.groups:
            W[v.index, g.group] = g.weight
    return W, names


def tri_count(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)

# ---------------------------------------------------------------------------------------------- images

def np_image(name, arr, path=None):
    """arr: (H, W, 3|4) float 0..1, row 0 = top. Saved to `path` (format from extension) and loaded,
    so the exporter keeps JPEG for colour maps."""
    h, w = arr.shape[:2]
    if arr.shape[2] == 3:
        arr = np.concatenate([arr, np.ones((h, w, 1), np.float32)], 2)
    flip = np.ascontiguousarray(arr[::-1]).astype(np.float32)
    img = bpy.data.images.new(name, w, h, alpha=False)
    img.pixels.foreach_set(flip.ravel())
    if path:
        img.filepath_raw = path
        img.file_format = 'JPEG' if path.lower().endswith('.jpg') else 'PNG'
        bpy.context.scene.render.image_settings.quality = 92
        img.save()
        bpy.data.images.remove(img)
        img = bpy.data.images.load(path)
        img.name = name
    return img


def load_np(path, size=None):
    img = bpy.data.images.load(path)
    if size and img.size[0] != size:
        img.scale(size, size)
    w, h = img.size
    a = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(a)
    bpy.data.images.remove(img)
    return a.reshape(h, w, 4)[::-1, :, :3].copy()


def tex_mat(name, img, rough=0.8, normal=None, rough_img=None, metal=0.0, uv='UVMap', color=None):
    """Principled material driven by an image (and optional normal map)."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes['Principled BSDF']
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    uvn = nt.nodes.new('ShaderNodeUVMap')
    uvn.uv_map = uv
    if img is not None:
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = img
        nt.links.new(uvn.outputs['UV'], t.inputs['Vector'])
        nt.links.new(t.outputs['Color'], b.inputs['Base Color'])
    elif color is not None:
        b.inputs['Base Color'].default_value = (*color, 1)
    if normal is not None:
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = normal
        normal.colorspace_settings.name = 'Non-Color'
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nm.uv_map = uv
        nt.links.new(uvn.outputs['UV'], t.inputs['Vector'])
        nt.links.new(t.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], b.inputs['Normal'])
    if rough_img is not None:
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = rough_img
        rough_img.colorspace_settings.name = 'Non-Color'
        sep = nt.nodes.new('ShaderNodeSeparateColor')
        nt.links.new(uvn.outputs['UV'], t.inputs['Vector'])
        nt.links.new(t.outputs['Color'], sep.inputs['Color'])
        nt.links.new(sep.outputs['Green'], b.inputs['Roughness'])
    return m


def srgb_lin(c):
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


def flat_mat(name, rgb, rough=0.8, metal=0.0):
    """Untextured material; rgb is given in sRGB (like a colour picker)."""
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*srgb_lin(rgb), 1)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    return m

# ---------------------------------------------------------------------------------------------- previews

def dup_char(arm, meshes, dx=0.0, dy=0.0):
    """Linked copy of a character (armature + its meshes), shifted by (dx, dy)."""
    a2 = arm.copy()
    a2.data = arm.data
    a2.animation_data_clear()
    bpy.context.scene.collection.objects.link(a2)
    a2.location = (arm.location.x + dx, arm.location.y + dy, arm.location.z)
    a2.hide_render = False
    out = []
    for m in meshes:
        m2 = m.copy()
        m2.hide_render = False
        bpy.context.scene.collection.objects.link(m2)
        m2.parent = a2
        for md in m2.modifiers:
            if md.type == 'ARMATURE':
                md.object = a2
        out.append(m2)
    return a2, out


def pose_static(arm, action, frame):
    """Freeze `arm` in the pose of `action` at `frame` (evaluated straight from the F-curves)."""
    curves = {(fc.data_path, fc.array_index): fc for fc in action.fcurves}
    arm.animation_data_clear()
    for pb in arm.pose.bones:
        pb.rotation_mode = 'QUATERNION'
        def ev(prop, i, d):
            fc = curves.get(('pose.bones["%s"].%s' % (pb.name, prop), i))
            return fc.evaluate(frame) if fc else d
        pb.rotation_quaternion = Quaternion([ev('rotation_quaternion', i, (1, 0, 0, 0)[i]) for i in range(4)]).normalized()
        pb.location = Vector([ev('location', i, 0.0) for i in range(3)])
    bpy.context.view_layer.update()


def mesh_min_z(objs):
    dg = bpy.context.evaluated_depsgraph_get()
    z = 1e9
    for o in objs:
        e = o.evaluated_get(dg)
        me = e.to_mesh()
        mw = o.matrix_world
        co = np.empty(len(me.vertices) * 3, np.float32)
        me.vertices.foreach_get('co', co)
        co = co.reshape(-1, 3)
        if len(co):
            zz = (np.asarray(mw) @ np.c_[co, np.ones(len(co))].T)[2]
            z = min(z, float(zz.min()))
        e.to_mesh_clear()
    return z


def ground_fix(arm, rig, meshes, action, tol=0.008):
    """Lift the pelvis on frames where the skinned body would sink below z = 0 (lying/falling clips)."""
    curves = {(fc.data_path, fc.array_index): fc for fc in action.fcurves}
    fz = [curves.get(('pose.bones["pelvis"].location', i)) for i in range(3)]
    n = len(fz[0].keyframe_points)
    lift = []
    for f in range(n):
        pose_static(arm, action, f)
        lift.append(max(0.0, -mesh_min_z(meshes) - tol))
    lift = np.array(lift)
    k = 2
    mx = np.array([lift[max(0, i - k):i + k + 1].max() for i in range(n)])
    sm = np.array([mx[max(0, i - k):i + k + 1].mean() for i in range(n)])
    sm = np.maximum(sm, lift)
    R = rig.rest['pelvis'].to_3x3().inverted()
    for f in range(n):
        d = R @ Vector((0, 0, float(sm[f])))
        for i in range(3):
            kp = fz[i].keyframe_points[f]
            kp.co.y += d[i]
    for fc in fz:
        fc.update()
    for pb in arm.pose.bones:
        pb.matrix_basis = Matrix.Identity(4)
    return float(lift.max())

# ---------------------------------------------------------------------------------------------- body zones (clothing)

REGION = {}
for _b in ('Head', 'neck_01'):
    REGION[_b] = 'head'
for _b in ('root', 'pelvis', 'spine_01', 'spine_02', 'spine_03', 'clavicle_l', 'clavicle_r'):
    REGION[_b] = 'torso'


def region_of(bone):
    if bone in REGION:
        return REGION[bone]
    if any(k in bone for k in ('thigh', 'calf', 'foot', 'ball')):
        return 'legs'
    return 'arms'


class BodyData:
    """Numpy views of the base body mesh (rest pose)."""

    def __init__(self, o):
        me = o.data
        self.o = o
        nv, nf = len(me.vertices), len(me.polygons)
        self.co = np.empty(nv * 3, np.float64)
        me.vertices.foreach_get('co', self.co)
        self.co = self.co.reshape(-1, 3)
        self.no = np.array([v.normal[:] for v in me.vertices])
        self.W, self.names = weights(o)
        self.vdom = np.array(self.names)[self.W.argmax(1)]
        self.fc = np.empty(nf * 3)
        me.polygons.foreach_get('center', self.fc)
        self.fc = self.fc.reshape(-1, 3)
        self.fn = np.empty(nf * 3)
        me.polygons.foreach_get('normal', self.fn)
        self.fn = self.fn.reshape(-1, 3)
        self.fverts = [list(p.vertices) for p in me.polygons]
        fw = np.array([self.W[v].sum(0) for v in self.fverts])
        self.fdom = np.array(self.names)[fw.argmax(1)]
        self.freg = np.array([region_of(b) for b in self.fdom])
        e = np.empty(len(me.edges) * 2, np.int64)
        me.edges.foreach_get('vertices', e)
        self.edges = e.reshape(-1, 2)


def taubin(co, edges, movable, iters, lam=0.5, mu=-0.53):
    """Taubin smoothing of the vertex positions in `movable` (bool array)."""
    nv = len(co)
    deg = np.zeros(nv)
    np.add.at(deg, edges[:, 0], 1)
    np.add.at(deg, edges[:, 1], 1)
    deg = np.maximum(deg, 1)
    m = movable[:, None].astype(np.float64)
    for it in range(iters):
        for f in (lam, mu):
            acc = np.zeros_like(co)
            np.add.at(acc, edges[:, 0], co[edges[:, 1]])
            np.add.at(acc, edges[:, 1], co[edges[:, 0]])
            lap = acc / deg[:, None] - co
            co = co + f * lap * m
    return co


def apply_zones(bd, zones, spec, mats, tile=0.4):
    """zones: array (faces) of zone names. spec: {zone: (material_name, offset_m, smooth_iters)}.
    mats: {material_name: material}. Displaces cloth outward along normals, smooths it, assigns materials
    and gives cloth faces box-projected UVs (tile metres per texture repeat)."""
    me = bd.o.data
    names = list(mats.keys())
    me.materials.clear()
    for n in names:
        me.materials.append(mats[n])
    nv = len(bd.co)
    off_sum = np.zeros(nv)
    off_cnt = np.zeros(nv)
    smooth = np.zeros(nv, np.int64)
    skin_touch = np.zeros(nv, bool)
    midx = []
    for fi, vs in enumerate(bd.fverts):
        mname, off, sm = spec[zones[fi]]
        midx.append(names.index(mname))
        for v in vs:
            off_sum[v] += off
            off_cnt[v] += 1
            smooth[v] = max(smooth[v], sm)
            if off == 0:
                skin_touch[v] = True
    off = off_sum / np.maximum(off_cnt, 1)
    disp = bd.no * off[:, None]
    low = bd.co[:, 2] < 0.03
    disp[low, 2] = np.maximum(disp[low, 2], 0)          # soles stay on the ground
    co = bd.co + disp
    iters = int(smooth.max())
    if iters:
        movable = (smooth > 0) & ~skin_touch
        # smooth each level separately so lightly smoothed zones keep their shape
        for lvl in sorted(set(smooth[movable].tolist())):
            mv = movable & (smooth >= lvl)
            co = taubin(co, bd.edges, mv, 2 if lvl == min(smooth[movable]) else 2)
        co = taubin(co, bd.edges, movable & (smooth >= 4), iters)
    me.vertices.foreach_set('co', co.ravel())
    me.polygons.foreach_set('material_index', midx)
    # UVs: box projection for cloth faces
    uv = me.uv_layers['UVMap'].data
    for fi, p in enumerate(me.polygons):
        mname, offv, sm = spec[zones[fi]]
        if offv == 0 and sm == 0 and not mname.startswith('cloth'):
            continue
        n = np.abs(bd.fn[fi])
        ax = int(n.argmax())
        for li in p.loop_indices:
            c = bd.co[me.loops[li].vertex_index]
            a, b = [(1, 2), (0, 2), (0, 1)][ax]
            uv[li].uv = (c[a] / tile, c[b] / tile)
    me.update()
    return co


def box_uv(o, tile=0.4):
    me = o.data
    if not me.uv_layers:
        me.uv_layers.new(name='UVMap')
    uv = me.uv_layers[0].data
    for p in me.polygons:
        n = p.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        a, b = [(1, 2), (0, 2), (0, 1)][ax]
        for li in p.loop_indices:
            c = me.vertices[me.loops[li].vertex_index].co
            uv[li].uv = (c[a] / tile, c[b] / tile)


def set_weights(o, fn):
    """fn(co Vector) -> {bone: weight}; replaces all vertex groups of o."""
    o.vertex_groups.clear()
    groups = {}
    for v in o.data.vertices:
        w = fn(o.matrix_world @ v.co)
        tot = sum(w.values()) or 1.0
        for b, x in w.items():
            if x <= 1e-4:
                continue
            if b not in groups:
                groups[b] = o.vertex_groups.new(name=b)
            groups[b].add([v.index], x / tot, 'REPLACE')


def ring_shell(name, zs, center, ellipse, theta=(0.0, 360.0), nseg=32, bvh=None, margin=0.02, smooth=2,
               post=None, tile=0.4):
    """Tube of rings at heights zs. center(z) -> (x, y); ellipse(z, th) -> minimum radius.
    With a BVH, the radius is at least the body surface (ray cast outward from the centre) + margin.
    th = 0 is +Y (front), increasing towards +X. post(x, y, z, th) -> (x, y, z) to reshape."""
    closed = (theta[1] - theta[0]) >= 359.9
    nth = nseg if closed else nseg + 1
    ths = [theta[0] + (theta[1] - theta[0]) * i / nseg for i in range(nth)]
    R = np.zeros((len(zs), nth))
    for i, z in enumerate(zs):
        cx, cy = center(z)
        for j, th in enumerate(ths):
            t = math.radians(th)
            d = Vector((math.sin(t), math.cos(t), 0))
            r = ellipse(z, th)
            if bvh is not None:
                # cast from outside towards the axis: the first hit is the outermost surface
                o = Vector((cx, cy, z))
                hit = bvh.ray_cast(o + d * 0.8, -d, 0.8)
                if hit[0] is not None:
                    r = max(r, (hit[0] - o).length + margin)
            R[i, j] = r
    for it in range(smooth):
        Rn = R.copy()
        if closed:
            Rn = 0.5 * R + 0.25 * (np.roll(R, 1, 1) + np.roll(R, -1, 1))
        else:
            Rn[:, 1:-1] = 0.5 * R[:, 1:-1] + 0.25 * (R[:, :-2] + R[:, 2:])
        Rn[1:-1] = 0.5 * Rn[1:-1] + 0.25 * (Rn[:-2] + Rn[2:])
        R = np.maximum(Rn, R * 0.985)
    bm = bmesh.new()
    rows = []
    for i, z in enumerate(zs):
        cx, cy = center(z)
        row = []
        for j, th in enumerate(ths):
            t = math.radians(th)
            p = (cx + R[i, j] * math.sin(t), cy + R[i, j] * math.cos(t), z)
            if post:
                p = post(p[0], p[1], p[2], th)
            row.append(bm.verts.new(p))
        rows.append(row)
    uvl = bm.loops.layers.uv.new('UVMap')
    for i in range(len(zs) - 1):
        for j in range(nth if closed else nth - 1):
            j2 = (j + 1) % nth
            f = bm.faces.new((rows[i][j], rows[i][j2], rows[i + 1][j2], rows[i + 1][j]))
            for lp in f.loops:
                ii = 0 if lp.vert in rows[i] else 1
                row = rows[i + ii]
                jj = row.index(lp.vert)
                lp[uvl].uv = (math.radians(ths[jj] if jj < len(ths) else 360) * 0.2 / tile, zs[i + ii] / tile)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    for p in me.polygons:
        p.use_smooth = True
    return o


def solidify(o, t, offset=-1.0):
    m = o.modifiers.new('solid', 'SOLIDIFY')
    m.thickness = t
    m.offset = offset
    m.use_even_offset = True
    set_active(o)
    bpy.ops.object.modifier_apply(modifier=m.name)
    return o


def body_bvh(bd, mask):
    """BVH of the (current) body faces where mask is True."""
    me = bd.o.data
    co = [v.co.copy() for v in me.vertices]
    polys = [bd.fverts[i] for i in range(len(bd.fverts)) if mask[i]]
    return BVHTree.FromPolygons(co, polys)


def gbox(name, size, loc, mat=None, rot=(0, 0, 0), bevel=0.004, segs=1):
    """Bevelled box mesh object (applied), world coordinates."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
    if bevel:
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, segments=segs, affect='EDGES', profile=0.5)
    R = Euler([math.radians(a) for a in rot]).to_matrix().to_4x4()
    bmesh.ops.transform(bm, matrix=Matrix.Translation(loc) @ R, verts=bm.verts)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    if mat:
        me.materials.append(mat)
    return o


def gcyl(name, r, depth, loc, mat=None, rot=(0, 0, 0), verts=12, r2=None):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=verts, radius1=r, radius2=r if r2 is None else r2, depth=depth)
    R = Euler([math.radians(a) for a in rot]).to_matrix().to_4x4()
    bmesh.ops.transform(bm, matrix=Matrix.Translation(loc) @ R, verts=bm.verts)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    if mat:
        me.materials.append(mat)
    for p in me.polygons:
        p.use_smooth = True
    return o


def gsphere(name, r, loc, mat=None, scale=(1, 1, 1), seg=16, rings=8):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=r)
    for v in bm.verts:
        v.co = Vector((v.co.x * scale[0], v.co.y * scale[1], v.co.z * scale[2])) + Vector(loc)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    if mat:
        me.materials.append(mat)
    for p in me.polygons:
        p.use_smooth = True
    return o


def strap(name, pts, width, thick, up, mat=None, closed=False):
    """Rectangular strap swept along points; `up` = function(point)->vector normal to the strap face."""
    bm = bmesh.new()
    rings = []
    n = len(pts)
    for i, p in enumerate(pts):
        p = Vector(p)
        a = Vector(pts[(i + 1) % n] if (closed or i < n - 1) else pts[i]) - Vector(pts[i - 1] if (closed or i > 0) else pts[i])
        a.normalize()
        u = Vector(up(p))
        u = (u - a * u.dot(a)).normalized()
        s = a.cross(u).normalized()
        q = [p + s * width / 2, p - s * width / 2, p - s * width / 2 + u * thick, p + s * width / 2 + u * thick]
        rings.append([bm.verts.new(x) for x in q])
    m = n if closed else n - 1
    for i in range(m):
        r0, r1 = rings[i], rings[(i + 1) % n]
        for k in range(4):
            bm.faces.new((r0[k], r0[(k + 1) % 4], r1[(k + 1) % 4], r1[k]))
    if not closed:
        bm.faces.new(rings[0][::-1])
        bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    if mat:
        me.materials.append(mat)
    return o


def split_parts(body, arm):
    """Separate body faces into part_head/part_torso/part_arms/part_legs by dominant bone."""
    bd = BodyData(body)
    parts = {}
    for reg in ('head', 'torso', 'arms', 'legs'):
        o = body.copy()
        o.data = body.data.copy()
        bpy.context.scene.collection.objects.link(o)
        bm = bmesh.new()
        bm.from_mesh(o.data)
        bm.faces.ensure_lookup_table()
        kill = [bm.faces[i] for i in range(len(bm.faces)) if bd.freg[i] != reg]
        bmesh.ops.delete(bm, geom=kill, context='FACES')
        bm.to_mesh(o.data)
        bm.free()
        o.name = o.data.name = 'part_' + reg
        parts[reg] = o
    bpy.data.objects.remove(body, do_unlink=True)
    return parts


def render(path, target=(0, 0, 1), dist=5.0, az=150, el=10, res=(720, 720), lens=40, samples=12):
    """Cycles CPU preview (same lighting as common.preview, tuned for speed)."""
    s = bpy.context.scene
    s.render.engine = 'CYCLES'
    s.cycles.device = 'CPU'
    s.cycles.samples = samples
    s.cycles.use_adaptive_sampling = True
    s.cycles.max_bounces = 4
    s.cycles.use_denoising = False
    s.render.resolution_x, s.render.resolution_y = res
    s.render.resolution_percentage = 100
    w = bpy.data.worlds.new('w')
    s.world = w
    w.use_nodes = True
    bg = w.node_tree.nodes['Background']
    bg.inputs['Color'].default_value = (0.55, 0.65, 0.78, 1)
    bg.inputs['Strength'].default_value = 0.8
    sun = bpy.data.lights.new('sun', 'SUN')
    sun.energy = 4.0
    so = bpy.data.objects.new('sun', sun)
    s.collection.objects.link(so)
    so.rotation_euler = (math.radians(50), math.radians(10), math.radians(-40 + 180))
    bpy.ops.mesh.primitive_plane_add(size=20, location=(0, 0, 0))
    g = bpy.context.object
    g.name = 'preview_ground'
    g.data.materials.append(flat_mat('preview_ground', (0.32, 0.29, 0.22), 0.95))
    cam = bpy.data.cameras.new('cam')
    cam.lens = lens
    co = bpy.data.objects.new('cam', cam)
    s.collection.objects.link(co)
    t = Vector(target)
    a, e = math.radians(az), math.radians(el)
    co.location = t + Vector((math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e))) * dist
    co.rotation_euler = (t - co.location).to_track_quat('-Z', 'Y').to_euler()
    s.camera = co
    s.render.filepath = path
    bpy.ops.render.render(write_still=True)
    for n in ('preview_ground', 'cam', 'sun'):
        o = bpy.data.objects.get(n)
        if o:
            bpy.data.objects.remove(o, do_unlink=True)

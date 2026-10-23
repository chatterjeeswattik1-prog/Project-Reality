"""Preview render of any exported GLB under neutral studio light (for checking models without the game).
    blender -b --factory-startup --python tools/blender/glbshot.py -- <in.glb> <out.png> [--views side,34,front,top]
        [--size 900] [--anim anims.glb --clip Idle_Loop --frame 0] [--focus x,y,z,radius] [--hide part_head,part_legs]
Each view is written as <out>_<view>.png. Cycles CPU, low samples, neutral grey world plus a key and a rim light.
With --anim, the first armature is posed with the named clip (characters: see them in a natural pose, not the T-pose).
Framing uses the evaluated (posed, skinned) mesh vertices; --focus overrides it (Blender coordinates, metres).
"""
import sys, os, math
import bpy
import numpy as np
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:]
src, out = argv[0], argv[1]
def opt(name, default=None):
    return argv[argv.index(name) + 1] if name in argv else default
views = opt('--views', 'side,34').split(',')
size = int(opt('--size', 900))

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
scene_objs = list(bpy.context.scene.objects)
for n in (opt('--hide', '') or '').split(','):
    for o in scene_objs:
        if n and o.type == 'MESH' and o.name.startswith(n):
            o.hide_render = True

if opt('--anim'):
    arm = next(o for o in scene_objs if o.type == 'ARMATURE')
    before = set(bpy.data.objects)
    acts0 = set(bpy.data.actions)
    bpy.ops.import_scene.gltf(filepath=opt('--anim'))
    for o in set(bpy.data.objects) - before:
        bpy.data.objects.remove(o, do_unlink=True)
    clip = opt('--clip', 'Idle_Loop')
    act = next(a for a in bpy.data.actions if a not in acts0 and a.name.split('|')[-1].startswith(clip) or a.name.startswith(clip))
    arm.animation_data_create()
    arm.animation_data.action = act
    if getattr(act, 'slots', None):
        arm.animation_data.action_slot = act.slots[0]
    bpy.context.scene.frame_set(int(float(opt('--frame', 0))))

dg = bpy.context.evaluated_depsgraph_get()
pts = []
for o in bpy.context.scene.objects:
    if o.type != 'MESH' or o.hide_render:
        continue
    e = o.evaluated_get(dg)
    me = e.to_mesh()
    co = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    mw = np.array(o.matrix_world)
    pts.append(co @ mw[:3, :3].T + mw[:3, 3])
    e.to_mesh_clear()
pts = np.concatenate(pts)
lo, hi = Vector(pts.min(0)), Vector(pts.max(0))
ctr, ext = (lo + hi) / 2, (hi - lo)
R = max(ext) * 0.62 * float(opt("--zoom", 1))
if opt('--focus'):
    f = [float(v) for v in opt('--focus').split(',')]
    ctr, R = Vector(f[:3]), f[3]

sc = bpy.context.scene
sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'; sc.cycles.samples = int(opt('--samples', 48))
sc.render.resolution_x = size; sc.render.resolution_y = int(size * float(opt('--aspect', 0.62)))
sc.view_settings.view_transform = 'AgX'
sc.view_settings.exposure = float(opt('--exposure', -0.6))
w = bpy.data.worlds.new('w'); sc.world = w; w.use_nodes = True
w.node_tree.nodes['Background'].inputs[0].default_value = (0.45, 0.45, 0.45, 1); w.node_tree.nodes['Background'].inputs[1].default_value = 0.6
for name, loc, e in (('key', (2, -3, 4), 900), ('rim', (-3, 3, 2), 500), ('fill', (3, 2, -1), 200)):
    L = bpy.data.lights.new(name, 'AREA'); L.energy = e * max(1, R) ** 2; L.size = 2
    o = bpy.data.objects.new(name, L); sc.collection.objects.link(o)
    o.location = ctr + Vector(loc) * max(1, R * 2)
    o.rotation_euler = (ctr - o.location).to_track_quat('-Z', 'Y').to_euler()
cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); sc.collection.objects.link(cam); sc.camera = cam
cam.data.lens = 50
DIRS = {'side': Vector((1, 0, 0.05)), 'left': Vector((-1, 0, 0.05)), '34': Vector((0.8, -0.6, 0.45)), 'front': Vector((0, -1, 0.1)),
        'top': Vector((0, 0, 1)), 'back': Vector((0, 1, 0.2)), 'fp': Vector((0.12, 1, 0.18)),
        # characters face +Y in Blender (-Z in glTF, which imports back as +Y): these look at the face
        'cfront': Vector((0, 1, 0.08)), 'c34': Vector((0.6, 0.8, 0.25)), 'cside': Vector((1, 0.05, 0.05)), 'cback': Vector((0, -1, 0.1))}
for v in views:
    d = DIRS[v].normalized()
    cam.location = ctr + d * R * 3.2
    cam.rotation_euler = (ctr - cam.location).to_track_quat('-Z', 'Y').to_euler()
    sc.render.filepath = f"{os.path.splitext(out)[0]}_{v}.png"
    bpy.ops.render.render(write_still=True)

"""Sight-picture check: render each weapon from its `cheek` empty looking along `eye` -> `front_post` (the line the game
turns onto the view axis when aiming), narrow field of view, red crosshair on the image centre. Aligned sights put the
rear notch / aperture centre and the front post tip on the crosshair.
    blender -b --factory-startup --python tools/blender/sightcheck.py -- <out_dir> <id> [<id> ...] [--fov 12]
Prints, per weapon, the image-centre ray and where `eye` and `front_post` project (they should both be at the centre)."""
import sys, os, math
import bpy
import numpy as np
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:]
out = argv[0]
fov = float(argv[argv.index('--fov') + 1]) if '--fov' in argv else 12
ids = [a for i, a in enumerate(argv[1:], 1) if not a.startswith('--') and argv[i - 1] not in ('--fov', '--clip')]
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
os.makedirs(out, exist_ok=True)
for id_ in ids:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=os.path.join(REPO, 'public', 'models', 'weapons', f'{id_}.glb'))
    ob = {o.name: o for o in bpy.data.objects}
    if 'front_post' not in ob or 'eye' not in ob:
        print('SKIP', id_, 'no eye/front_post'); continue
    eye, fp = ob['eye'].matrix_world.translation.copy(), ob['front_post'].matrix_world.translation.copy()
    ch = ob['cheek'].matrix_world.translation.copy() if 'cheek' in ob else eye - (fp - eye).normalized() * 0.13
    d = (fp - eye).normalized()
    ch = eye - d * max(0.05, (eye - ch).dot(d))  # on the sight line, as the game places the eye (viewmodel.ts)
    if '--clip' in argv:  # cut everything behind this distance along the line from the eye (shows the front post alone)
        import bmesh
        cy = float(argv[argv.index('--clip') + 1])
        for o in [o for o in bpy.data.objects if o.type == 'MESH']:
            M = o.matrix_world; bm = bmesh.new(); bm.from_mesh(o.data)
            bmesh.ops.delete(bm, geom=[v for v in bm.verts if (M @ v.co - eye).dot(d) < cy], context='VERTS')
            bm.to_mesh(o.data); bm.free()
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_WORKBENCH'
    sc.display.shading.light = 'STUDIO'; sc.display.shading.color_type = 'TEXTURE'
    sc.render.resolution_x = sc.render.resolution_y = 700
    w = bpy.data.worlds.new('w'); sc.world = w; w.color = (0.75, 0.8, 0.85)
    cam = bpy.data.objects.new('c', bpy.data.cameras.new('c')); sc.collection.objects.link(cam); sc.camera = cam
    cam.data.angle = math.radians(fov); cam.data.clip_start = 0.005
    cam.location = ch
    cam.rotation_euler = d.to_track_quat('-Z', 'Z').to_euler()
    path = os.path.join(out, f'{id_}.png')
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(path); px = np.array(img.pixels[:], np.float32).reshape(700, 700, 4)
    px[349:351, :, :3] = (1, 0, 0); px[:, 349:351, :3] = (1, 0, 0)
    img.pixels[:] = px.ravel(); img.save(); bpy.data.images.remove(img)
    # offsets of eye / cheek from the line (mm): non-zero cheek offset = cheek not on the sight line
    off = (ch - eye) - d * (ch - eye).dot(d)
    print(f'SIGHT {id_} line pitch {math.degrees(math.atan2(d.z, d.y)):+.2f} deg yaw {math.degrees(math.atan2(d.x, d.y)):+.2f} deg '
          f'cheek off-line {off.length * 1000:.1f} mm  eye {tuple(round(v, 4) for v in eye)} post {tuple(round(v, 4) for v in fp)}')

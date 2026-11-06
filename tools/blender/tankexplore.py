"""Explore an imported tank GLB: world bounds of every mesh (metres), and preview renders.
    blender -b --factory-startup --python tools/blender/tankexplore.py -- <in.glb> <outPrefix>"""
import os, sys, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy
from mathutils import Vector
from common import preview

argv = sys.argv[sys.argv.index('--') + 1:]
src, out = argv[0], argv[1]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
bpy.context.view_layer.update()
lo, hi = Vector((1e9,) * 3), Vector((-1e9,) * 3)
for o in bpy.context.scene.objects:
    if o.type != 'MESH':
        continue
    cs = [o.matrix_world @ Vector(c) for c in o.bound_box]
    a = Vector((min(c.x for c in cs), min(c.y for c in cs), min(c.z for c in cs)))
    b = Vector((max(c.x for c in cs), max(c.y for c in cs), max(c.z for c in cs)))
    lo = Vector((min(lo.x, a.x), min(lo.y, a.y), min(lo.z, a.z))); hi = Vector((max(hi.x, b.x), max(hi.y, b.y), max(hi.z, b.z)))
    mats = ','.join(m.name for m in o.data.materials if m)
    print(f'MESH {o.name!r:40} parent={o.parent.name if o.parent else None!r:30} tris={sum(len(p.vertices) - 2 for p in o.data.polygons):6} '
          f'min=({a.x:.2f},{a.y:.2f},{a.z:.2f}) max=({b.x:.2f},{b.y:.2f},{b.z:.2f}) mats={mats}')
print(f'ALL min=({lo.x:.2f},{lo.y:.2f},{lo.z:.2f}) max=({hi.x:.2f},{hi.y:.2f},{hi.z:.2f}) size=({hi.x-lo.x:.2f},{hi.y-lo.y:.2f},{hi.z-lo.z:.2f})')
c = (lo + hi) / 2; d = max(hi - lo)
for name, az, el in (('side', 90, 10), ('front', 0, 15), ('q', -35, 25), ('top', 0, 89)):
    preview(f'{out}_{name}.png', target=(c.x, c.y, c.z), dist=d * 1.6, az=az, el=el, res=(800, 500), samples=8)

"""List the loose parts of one mesh of an imported GLB (world bounds, after scale), for splitting guns off turrets.
    blender -b --factory-startup --python tools/blender/tankparts.py -- <in.glb> <meshName> <scale>"""
import sys
import bpy, bmesh
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:]
src, name, sc = argv[0], argv[1], float(argv[2])
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
bpy.context.view_layer.update()
o = bpy.data.objects[name]
mw = o.matrix_world
bm = bmesh.new(); bm.from_mesh(o.data); bm.verts.ensure_lookup_table()
seen = set(); parts = []
for v in bm.verts:
    if v.index in seen:
        continue
    stack = [v]; seen.add(v.index); ids = []
    while stack:
        a = stack.pop(); ids.append(a.index)
        for e in a.link_edges:
            b = e.other_vert(a)
            if b.index not in seen:
                seen.add(b.index); stack.append(b)
    ps = [mw @ bm.verts[i].co * sc for i in ids]
    lo = Vector((min(p.x for p in ps), min(p.y for p in ps), min(p.z for p in ps)))
    hi = Vector((max(p.x for p in ps), max(p.y for p in ps), max(p.z for p in ps)))
    parts.append((len(ids), lo, hi))
parts.sort(key=lambda p: p[1].y)
for n, lo, hi in parts:
    print(f'PART v={n:5} min=({lo.x:6.2f},{lo.y:6.2f},{lo.z:5.2f}) max=({hi.x:6.2f},{hi.y:6.2f},{hi.z:5.2f}) size=({hi.x-lo.x:.2f},{hi.y-lo.y:.2f},{hi.z-lo.z:.2f})')
zs = sorted((mw @ v.co).z for v in bm.verts)
z0 = zs[0]
low = [mw @ v.co * sc for v in bm.verts if (mw @ v.co).z < z0 + 0.03]
print('LOWEST z', z0 * sc, 'low verts', len(low), 'x', min(p.x for p in low), max(p.x for p in low), 'y', min(p.y for p in low), max(p.y for p in low))

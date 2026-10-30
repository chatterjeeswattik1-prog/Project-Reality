"""List the connected pieces (islands) of a user model whose centre lies in a box, after the usual orient/rot/scale.
    blender -b --factory-startup --python tools/blender/uislands.py -- <src.glb> [--fwd +Y --up +Z] [--rot X,-14.4]
        [--len 1.04] [--pose] --box x0,y0,z0,x1,y1,z1 [--min 0]
Prints mesh, tris, centre and bounds of each island (weapon space, metres) for choosing split() boxes."""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
import ucommon as U
import bmesh
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:]
src = argv[0]
def opt(n, d=None): return argv[argv.index(n) + 1] if n in argv else d

U.load(src)
if '--pose' in argv:
    import uweapons_us; uweapons_us.flatten_posed()
else:
    U.flatten()
if opt('--fwd'):
    U.orient(opt('--fwd'), opt('--up', '+Z'))
if opt('--rot'):
    ax, deg = opt('--rot').split(','); U.rot(ax, float(deg))
if opt('--len'):
    U.scale_len(float(opt('--len')))
b = [float(v) for v in opt('--box').split(',')]
lo, hi = Vector(b[:3]), Vector(b[3:])
mn = int(opt('--min', 0))
for o in U.meshes():
    bm = bmesh.new(); bm.from_mesh(o.data); bm.faces.ensure_lookup_table()
    seen = set()
    for f in bm.faces:
        if f.index in seen:
            continue
        isl, st = [], [f]; seen.add(f.index)
        while st:
            g = st.pop(); isl.append(g)
            for e in g.edges:
                for h in e.link_faces:
                    if h.index not in seen:
                        seen.add(h.index); st.append(h)
        vs = {v for g in isl for v in g.verts}
        c = sum((v.co for v in vs), Vector()) / len(vs)
        if all(lo[i] <= c[i] <= hi[i] for i in range(3)):
            t = sum(len(g.verts) - 2 for g in isl)
            if t < mn:
                continue
            a = Vector([min(v.co[i] for v in vs) for i in range(3)]); z = Vector([max(v.co[i] for v in vs) for i in range(3)])
            print(f'ISL {o.name[:20]:20s} tris {t:6d} c ({c.x:+.3f},{c.y:+.3f},{c.z:+.3f}) '
                  f'bb ({a.x:+.3f},{a.y:+.3f},{a.z:+.3f})..({z.x:+.3f},{z.y:+.3f},{z.z:+.3f})')
    bm.free()

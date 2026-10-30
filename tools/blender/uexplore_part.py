"""uexplore.py with a mesh filter: renders only the meshes whose name contains one of --only a,b (or all but --skip a,b).
    blender -b --factory-startup --python tools/blender/uexplore_part.py -- <src.glb> <out_prefix> [--fwd -X --up +Z]
        [--len 0.88 (scaled on the whole model)] [--only a,b | --skip a,b] [--views side,top] [--ppm 1600] [--rot X,-14 (after orient)] [--pose (armatures posed, see uweapons_us.flatten_posed)]"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
import ucommon as U

argv = sys.argv[sys.argv.index('--') + 1:]
src, out = argv[0], argv[1]
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
    print('SCALE', U.scale_len(float(opt('--len')), axis=int(opt('--axis', 1))))
only, skip = opt('--only'), opt('--skip')
for o in list(U.meshes()):
    if (only and not any(s in o.name for s in only.split(','))) or (skip and any(s in o.name for s in skip.split(','))):
        U.bpy.data.objects.remove(o, do_unlink=True)
for o in sorted(U.meshes(), key=lambda o: o.name):
    a, b = U.bounds([o])
    print(f'MESH {o.name[:44]:44s} tris {U.tris([o]):6d} {tuple(round(v, 3) for v in a)} .. {tuple(round(v, 3) for v in b)} vg {[g.name for g in o.vertex_groups][:12]}')
lo, hi = U.bounds()
print(f'PART bounds {tuple(round(v, 4) for v in lo)} .. {tuple(round(v, 4) for v in hi)} tris {U.tris()}')
for v in opt('--views', 'side,top').split(','):
    U.ortho(f'{out}_{v}.png', v, ppm=int(opt('--ppm', 1600)))

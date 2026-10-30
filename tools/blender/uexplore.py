"""Look at a user-supplied model before writing its build function.
    blender -b --factory-startup --python tools/blender/uexplore.py -- <src.glb> <out_prefix> [--fwd -X --up +Z] [--len 0.88]
        [--views side,top,front] [--ppm 1600]
Flattens it (ucommon.flatten), optionally orients and scales it, prints every mesh with its weapon-space bounds and
triangle count, and writes gridded orthographic renders <out_prefix>_<view>.png (ucommon.ortho)."""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
import ucommon as U

argv = sys.argv[sys.argv.index('--') + 1:]
src, out = argv[0], argv[1]
def opt(n, d=None): return argv[argv.index(n) + 1] if n in argv else d

U.load(src)
U.flatten()
if opt('--fwd'):
    U.orient(opt('--fwd'), opt('--up', '+Z'))
if opt('--len'):
    print('SCALE', U.scale_len(float(opt('--len'))))
lo, hi = U.bounds()
print(f'ALL bounds {tuple(round(v, 4) for v in lo)} .. {tuple(round(v, 4) for v in hi)} size {tuple(round(v, 4) for v in hi - lo)} tris {U.tris()}')
for o in sorted(U.meshes(), key=lambda o: o.name):
    a, b = U.bounds([o])
    vg = [g.name for g in o.vertex_groups][:30]
    print(f'MESH {o.name[:44]:44s} tris {U.tris([o]):6d} {tuple(round(v, 3) for v in a)} .. {tuple(round(v, 3) for v in b)} '
          f'mats {[m.name for m in o.data.materials]} {"vg " + str(vg) if vg else ""}')
for v in opt('--views', 'side,top,front').split(','):
    U.ortho(f'{out}_{v}.png', v, ppm=int(opt('--ppm', 1600)))

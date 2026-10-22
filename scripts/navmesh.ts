// Bake the bots' navmesh offline: node (bundled) scripts/navmesh.ts [seed] → public/nav/zahran-<seed>.bin
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { init, exportNavMesh } from 'recast-navigation';
import { generateTiledNavMesh } from 'recast-navigation/generators';
import { generateCity } from '../src/world/citygen';
import { navGeometry, NAV_BOUNDS, NAV_CONFIG, solidBox, type Box } from '../src/world/navgeom';

type M = number[];
const mul = (a: M, b: M): M => { const o = new Array(16).fill(0); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) o[j * 4 + i] += a[k * 4 + i] * b[j * 4 + k]; return o; };
function trs(n: { translation?: M; rotation?: M; scale?: M; matrix?: M }): M {
  if (n.matrix) return n.matrix;
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1], [sx, sy, sz] = n.scale ?? [1, 1, 1], [tx, ty, tz] = n.translation ?? [0, 0, 0];
  return [(1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0, 2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0, 2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0, tx, ty, tz, 1];
}
/** Root-local bounding boxes of every root node (or the given names) in a GLB, from accessor min/max. */
function glbBoxes(file: string): Map<string, [M, M]> {
  const out = new Map<string, [M, M]>();
  if (!existsSync(file)) return out;
  const f = readFileSync(file), n = f.readUInt32LE(12), j = JSON.parse(f.subarray(20, 20 + n).toString());
  const scene = j.scenes[j.scene ?? 0];
  for (const r of scene.nodes) {
    const root = j.nodes[r], mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    const walk = (ni: number, m: M) => {
      const nd = j.nodes[ni];
      if (nd.mesh !== undefined) for (const pr of j.meshes[nd.mesh].primitives) {
        const a = j.accessors[pr.attributes.POSITION];
        for (let c = 0; c < 8; c++) {
          const v = [c & 1 ? a.max[0] : a.min[0], c & 2 ? a.max[1] : a.min[1], c & 4 ? a.max[2] : a.min[2]];
          const w = [0, 1, 2].map((k) => m[k] * v[0] + m[4 + k] * v[1] + m[8 + k] * v[2] + m[12 + k]);
          for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], w[k]); mx[k] = Math.max(mx[k], w[k]); }
        }
      }
      for (const ch of nd.children ?? []) walk(ch, mul(m, trs(j.nodes[ch])));
    };
    walk(r, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    if (mn[0] < Infinity) out.set(root.name, [mn, mx]);
  }
  return out;
}

const seed = Number(process.argv[2] ?? 1337);
const t0 = Date.now();
await init();
const city = generateCity(seed);
const kit = glbBoxes('public/models/props.glb');
const veh = new Map<string, [M, M]>();
const props: Box[] = [];
for (const p of city.props) {
  if (!p.solid) continue;
  let b = p.id.startsWith('veh:') ? veh.get(p.id) : kit.get(p.id);
  if (!b && p.id.startsWith('veh:')) { const m = glbBoxes(`public/models/vehicles/${p.id.slice(4)}.glb`); const v = [...m.values()][0]; if (v) { veh.set(p.id, v); b = v; } }
  if (!b) continue;
  props.push(solidBox(p.id, b[0], b[1], p));
}
const { positions, indices } = navGeometry(city, props);
console.log(`input: ${positions.length / 3} verts, ${indices.length / 3} tris, ${props.length} props (${kit.size} kit models) — ${Date.now() - t0} ms`);
const r = generateTiledNavMesh(positions, indices, { ...NAV_CONFIG, bounds: NAV_BOUNDS });
if (!r.success) { console.error('navmesh failed', r.error); process.exit(1); }
const data = exportNavMesh(r.navMesh);
mkdirSync('public/nav', { recursive: true });
writeFileSync(`public/nav/zahran-${seed}.bin`, data);
console.log(`navmesh: ${(data.length / 1e6).toFixed(1)} MB, ${r.navMesh.getMaxTiles()} max tiles — ${((Date.now() - t0) / 1000).toFixed(1)} s`);

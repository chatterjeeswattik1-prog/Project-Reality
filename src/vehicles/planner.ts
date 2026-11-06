// Route planning for tracked vehicles. The infantry navmesh lets a 0.4 m soldier through alleys a 3.7 m tank cannot
// enter, so vehicles plan on their own grid (2.5 m cells over the AO): cells under walls, trunks, HESCO, wrecks and
// other solid boxes are blocked, then grown by the hull's half width; the canal is water except on the bridges;
// steep ground is avoided; paved roads are cheaper (tanks keep to roads where they can). A* (8-neighbour, octile),
// then the path is straightened where the grid line of sight allows.
import type { Physics } from '../world/physics';
import type { City } from '../world/citygen';
import { AO, groundH } from '../world/terrain';

type V3 = [number, number, number];
const CS = 2.5;

export class VehiclePlanner {
  nx: number; nz: number; x0 = AO.x0; z0 = AO.z0;
  /** 0 = blocked, else move cost ×10 (7 road … 10 open … 25 rough). */
  cost: Uint8Array;
  private g: Float32Array; private from: Int32Array; private seen: Uint32Array; private closed: Uint32Array; private stamp = 1;
  /** Binary heap of (cell, f) entries; a cell may be queued more than once (stale entries are skipped). */
  private heap: Int32Array; private hf: Float32Array; private hn = 0;

  constructor(P: Physics, city: City, isRoad: (x: number, z: number) => boolean) {
    this.nx = Math.ceil((AO.x1 - AO.x0) / CS); this.nz = Math.ceil((AO.z1 - AO.z0) / CS);
    const N = this.nx * this.nz;
    // 1 = solid (buildings, HESCO, wrecks…), 2 = crushable (trees, garden walls, carts: passable but costly).
    const solid = new Uint8Array(N);
    const mark = (x0: number, z0: number, x1: number, z1: number, v = 1) => {
      const i0 = Math.max(0, Math.floor((x0 - this.x0) / CS)), i1 = Math.min(this.nx - 1, Math.floor((x1 - this.x0) / CS));
      const j0 = Math.max(0, Math.floor((z0 - this.z0) / CS)), j1 = Math.min(this.nz - 1, Math.floor((z1 - this.z0) / CS));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const k = j * this.nx + i; if (solid[k] !== 1) solid[k] = v; }
    };
    const CRUSH = /^(tree_|palm_|dead_tree|shrub|bush|reeds|grass|cart_|market_stall|plastic_|table_|trash|tyres|oil_drum|gas_cylinder|crate|pallet|cardboard|street_light|power_pole|sign_shop|kerb_barrier|generator|water_tank)/;
    P.eachBox((c, h, q, s, tag, pid) => {
      if (h[1] * 2 < 0.8) return; // slabs, decks, kerbs: drivable or not in the way
      const gy = groundH(c[0], c[2]);
      if (c[1] - h[1] > gy + 2.2 || c[1] + h[1] < gy + 0.5) return; // above head height / buried
      // Rotated props: their axis-aligned extent.
      let ex = h[0], ez = h[2];
      if (q) { const yaw = 2 * Math.atan2(q[1], q[3]), cs = Math.abs(Math.cos(yaw)), sn = Math.abs(Math.sin(yaw)); ex = h[0] * cs + h[2] * sn; ez = h[0] * sn + h[2] * cs; }
      const crushable = pid !== null ? CRUSH.test(pid) : (tag < 0 && Math.min(h[0], h[2]) * 2 <= 0.45 && h[1] * 2 <= 3.4 && s !== 'concrete');
      mark(c[0] - ex, c[2] - ez, c[0] + ex, c[2] + ez, crushable ? 2 : 1);
    });
    this.cost = new Uint8Array(N);
    for (let j = 0; j < this.nz; j++) for (let i = 0; i < this.nx; i++) {
      const x = this.x0 + (i + 0.5) * CS, z = this.z0 + (j + 0.5) * CS, k = j * this.nx + i;
      const h = groundH(x, z);
      const onBridge = city.bridges.some((b) => x > b.x0 && x < b.x1 && z > b.z0 + 1 && z < b.z1 - 1);
      if (h < -1.0 && !onBridge) { this.cost[k] = 0; continue; }
      const slope = Math.max(Math.abs(groundH(x + CS, z) - groundH(x - CS, z)), Math.abs(groundH(x, z + CS) - groundH(x, z - CS))) / (2 * CS);
      if (slope > 0.6) { this.cost[k] = 0; continue; }
      this.cost[k] = isRoad(x, z) ? 7 : 10 + Math.round(slope * 25);
    }
    // Grow the obstacles by the hull's half width (~1.9 m: one cell each way, diagonals included); crushable ones
    // only add cost (the planner goes round a wood or a garden wall when there is a way, through it when not).
    for (let j = 0; j < this.nz; j++) for (let i = 0; i < this.nx; i++) {
      const v = solid[j * this.nx + i]; if (!v) continue;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= this.nx || b >= this.nz) continue;
        const k = b * this.nx + a;
        if (v === 1) this.cost[k] = 0; else if (this.cost[k]) this.cost[k] = Math.max(this.cost[k], 30);
      }
    }
    this.g = new Float32Array(N); this.from = new Int32Array(N); this.seen = new Uint32Array(N); this.closed = new Uint32Array(N);
    this.heap = new Int32Array(N * 4); this.hf = new Float32Array(N * 4);
  }

  cell(x: number, z: number): number { const i = Math.floor((x - this.x0) / CS), j = Math.floor((z - this.z0) / CS); return i < 0 || j < 0 || i >= this.nx || j >= this.nz ? -1 : j * this.nx + i; }
  passable(x: number, z: number): boolean { const k = this.cell(x, z); return k >= 0 && this.cost[k] > 0; }
  private centre(k: number): V3 { const x = this.x0 + ((k % this.nx) + 0.5) * CS, z = this.z0 + (Math.floor(k / this.nx) + 0.5) * CS; return [x, groundH(x, z), z]; }
  /** Nearest passable cell to a point (within r cells), or −1. */
  nearest(x: number, z: number, r = 8): number {
    const k0 = this.cell(x, z); if (k0 >= 0 && this.cost[k0]) return k0;
    const i0 = Math.floor((x - this.x0) / CS), j0 = Math.floor((z - this.z0) / CS);
    for (let d = 1; d <= r; d++) for (let dj = -d; dj <= d; dj++) for (let di = -d; di <= d; di++) {
      if (Math.max(Math.abs(di), Math.abs(dj)) !== d) continue;
      const i = i0 + di, j = j0 + dj; if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) continue;
      if (this.cost[j * this.nx + i]) return j * this.nx + i;
    }
    return -1;
  }

  /** A route (world points) from a to b, or null. `limit` caps the search (cells expanded). */
  path(a: V3, b: V3, limit = 250000): V3[] | null {
    const s = this.nearest(a[0], a[2]), t = this.nearest(b[0], b[2], 12);
    if (s < 0 || t < 0) return null;
    const nx = this.nx, st = ++this.stamp, tx = t % nx, tz = Math.floor(t / nx);
    const h = (k: number) => { const dx = Math.abs((k % nx) - tx), dz = Math.abs(Math.floor(k / nx) - tz); return 7 * (Math.max(dx, dz) + 0.414 * Math.min(dx, dz)); };
    this.hn = 0; this.g[s] = 0; this.from[s] = -1; this.seen[s] = st; this.push(s, h(s));
    let n = 0;
    while (this.hn > 0 && n++ < limit) {
      const k = this.pop(); if (k === t) break;
      if (this.closed[k] === st) continue;
      this.closed[k] = st;
      const i = k % nx, j = Math.floor(k / nx);
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const a2 = i + di, b2 = j + dj; if (a2 < 0 || b2 < 0 || a2 >= nx || b2 >= this.nz) continue;
        const q = b2 * nx + a2, c = this.cost[q]; if (!c) continue;
        if (di && dj && (!this.cost[j * nx + a2] || !this.cost[b2 * nx + i])) continue; // no corner cutting
        const ng = this.g[k] + c * (di && dj ? 1.414 : 1);
        if (this.seen[q] === st && ng >= this.g[q]) continue;
        if (this.hn >= this.heap.length - 1) continue;
        this.seen[q] = st; this.g[q] = ng; this.from[q] = k; this.push(q, ng + h(q));
      }
    }
    if (this.seen[t] !== st) return null;
    const cells: number[] = [];
    for (let k = t; k >= 0; k = this.from[k]) cells.push(k);
    cells.reverse();
    // Straighten: keep a cell only where the straight line from the last kept one is blocked.
    const out: V3[] = [this.centre(cells[0])];
    let last = cells[0];
    for (let i = 2; i < cells.length; i++) if (!this.clear(last, cells[i])) { last = cells[i - 1]; out.push(this.centre(last)); }
    out.push(this.centre(cells[cells.length - 1]));
    return out;
  }

  /** Grid line of sight between two cells (all passable, and not much costlier than open ground). */
  private clear(a: number, b: number): boolean {
    const nx = this.nx, ax = a % nx, az = Math.floor(a / nx), bx = b % nx, bz = Math.floor(b / nx);
    const n = Math.max(Math.abs(bx - ax), Math.abs(bz - az));
    const roadA = this.cost[a] === 7;
    for (let s = 1; s <= n; s++) {
      const i = Math.round(ax + ((bx - ax) * s) / n), j = Math.round(az + ((bz - az) * s) / n), c = this.cost[j * nx + i];
      if (!c || c > 14 || (roadA && c !== 7 && this.cost[b] === 7)) return false;
    }
    return true;
  }

  private push(k: number, f: number) {
    let i = this.hn++;
    while (i > 0) { const p = (i - 1) >> 1; if (this.hf[p] <= f) break; this.heap[i] = this.heap[p]; this.hf[i] = this.hf[p]; i = p; }
    this.heap[i] = k; this.hf[i] = f;
  }
  private pop(): number {
    const top = this.heap[0], lk = this.heap[--this.hn], lf = this.hf[this.hn];
    let i = 0;
    for (;;) {
      let c = i * 2 + 1; if (c >= this.hn) break;
      if (c + 1 < this.hn && this.hf[c + 1] < this.hf[c]) c++;
      if (this.hf[c] >= lf) break;
      this.heap[i] = this.heap[c]; this.hf[i] = this.hf[c]; i = c;
    }
    this.heap[i] = lk; this.hf[i] = lf;
    return top;
  }
}

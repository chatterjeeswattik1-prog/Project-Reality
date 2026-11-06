// Rapier world: static city (cuboids), terrain (heightfield), character capsules, vehicles, grenades.
// Ray casts report the surface material so bullets can penetrate thin things and impacts look/sound right.
import RAPIER from '@dimforge/rapier3d-compat';
import type { City } from './citygen';
import type { PropBox } from './render';
import type { Surface } from './sink';
import { AO, groundH } from './terrain';

export const G_WORLD = 0x0001, G_CHAR = 0x0002, G_VEH = 0x0004, G_DEBRIS = 0x0008;
/** Play-area boundary barriers: stop soldiers and vehicles only (never bullets, sight lines or grenades). */
export const G_BOUND = 0x0010;
export const groups = (member: number, filter: number) => ((member & 0xffff) << 16) | (filter & 0xffff);

export interface RayHit { dist: number; point: [number, number, number]; normal: [number, number, number]; surf: Surface; tag: number; collider: RAPIER.Collider }

export class Physics {
  world: RAPIER.World;
  R = RAPIER;
  surf = new Map<number, Surface>();
  /** Shared kinematic character controller (results are read right after each call). */
  kcc: RAPIER.KinematicCharacterController;
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });

  constructor() {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = 1 / 60;
    const k = this.world.createCharacterController(0.03);
    k.setUp({ x: 0, y: 1, z: 0 });
    k.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    k.setMinSlopeSlideAngle((65 * Math.PI) / 180);
    k.enableAutostep(0.42, 0.2, false);
    k.enableSnapToGround(0.45);
    k.setApplyImpulsesToDynamicBodies(true);
    k.setCharacterMass(85);
    this.kcc = k;
  }

  static async create(): Promise<Physics> { await RAPIER.init(); return new Physics(); }

  /** Static boxes kept for surface lookups (trimesh hits carry no per-triangle data). */
  private boxes: { c: number[]; h: number[]; ry: number; q?: number[]; s: Surface; tag: number; dead?: boolean; grp?: string; tris?: { pos: Float32Array; idx: Uint32Array }; pid?: string }[] = [];
  /** Box indices of each solid prop (index in city.props). */
  private propBoxes = new Map<number, number[]>();
  /**
   * City boxes are grouped into one trimesh per building (by tag), or per 128 m chunk for boxes that belong to no
   * building (compound walls, fences, terrain features), so a destroyed wall only rebuilds its own building's collider.
   */
  private grps = new Map<string, { col: RAPIER.Collider | null; boxes: number[] }>();
  private dirty = new Set<string>();
  private cityBody: RAPIER.RigidBody | null = null;
  /** Static boxes [0, cityBoxN) are the city (walls, floors); the rest are props. */
  cityBoxN = 0;
  private grid = new Map<number, number[]>();
  private static cell = 4;
  private key(ix: number, iz: number) { return (ix + 4096) * 8192 + (iz + 4096); }

  /**
   * Static world. Rapier slows down badly with ~10^5 separate colliders, so the city's boxes are merged into one
   * trimesh per 128 m chunk (about 80 colliders). Surfaces are looked up from the original boxes by hit point.
   */
  buildStatic(city: City, props: PropBox[]) {
    const w = this.world, R = RAPIER, g = groups(G_WORLD, 0xffff);
    const body = w.createRigidBody(R.RigidBodyDesc.fixed());
    this.cityBody = body;
    // City boxes: grouped per building / chunk (rebuilt when destroyed).
    for (const c of city.sink.colliders) {
      const bi = this.boxes.length, tag = c.tag ?? -1;
      const grp = tag >= 0 ? `b${tag}` : `c${Math.floor((c.c[0] + 2048) / 128) + Math.floor((c.c[2] + 2048) / 128) * 64}`;
      this.boxes.push({ c: c.c, h: c.h, ry: 0, q: c.q, s: c.s, tag, grp });
      this.gridAdd(bi);
      let gr = this.grps.get(grp); if (!gr) this.grps.set(grp, gr = { col: null, boxes: [] });
      gr.boxes.push(bi); this.dirty.add(grp);
    }
    this.cityBoxN = this.boxes.length;
    this.commit();
    // Props: rebuildable groups per 128 m chunk too (a prop knocked off a holed roof takes its collider with it); the
    // real-shape ones (mounds, wrecks, stalls: thousands of triangles, never destroyed) in groups of their own.
    for (const p of props) {
      const cs = p.tris ? 128 : 32, bi = this.boxes.length, grp = `${p.tris ? "t" : "p"}${Math.floor((p.c[0] + 2048) / cs) + Math.floor((p.c[2] + 2048) / cs) * 256}`;
      // Real-shape props: their triangles collide; the (shrunk) box stays only for surface lookups.
      this.boxes.push({ c: p.c, h: p.h, ry: p.ry, q: [0, Math.sin(p.ry / 2), 0, Math.cos(p.ry / 2)], s: propSurface(p.id), tag: -1, grp, tris: p.tris, pid: p.id });
      if (p.tris) {
        const C = Physics.cell, r = Math.hypot(p.h[0], p.h[2]) + 1;
        for (let ix = Math.floor((p.c[0] - r) / C); ix <= Math.floor((p.c[0] + r) / C); ix++) for (let iz = Math.floor((p.c[2] - r) / C); iz <= Math.floor((p.c[2] + r) / C); iz++) {
          const k = this.key(ix, iz); let l = this.grid.get(k); if (!l) this.grid.set(k, l = []); l.push(bi);
        }
      } else this.gridAdd(bi);
      let gr = this.grps.get(grp); if (!gr) this.grps.set(grp, gr = { col: null, boxes: [] });
      gr.boxes.push(bi); this.dirty.add(grp);
      if (p.pi !== undefined) { const l = this.propBoxes.get(p.pi); if (l) l.push(bi); else this.propBoxes.set(p.pi, [bi]); }
    }
    this.commit();
    // Terrain heightfield: 4 m cells over ±1100 m (rows along z, columns along x, column-major); covers the AO.
    const N = 550, size = 2200, heights = new Float32Array((N + 1) * (N + 1));
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) heights[i + j * (N + 1)] = groundH(-size / 2 + (j * size) / N, -size / 2 + (i * size) / N);
    const terr = w.createCollider(R.ColliderDesc.heightfield(N, N, heights, { x: size, y: 1, z: size }).setCollisionGroups(g).setFriction(0.9), body);
    this.surf.set(terr.handle, 'dirt');
    // Test areas: invisible walls just inside the HESCO line.
    if (city.area) {
      const A = city.area, cx = (A.x0 + A.x1) / 2, cz = (A.z0 + A.z1) / 2, hx = (A.x1 - A.x0) / 2, hz = (A.z1 - A.z0) / 2;
      for (const [x, z, ex, ez] of [[cx, A.z0, hx, 0.3], [cx, A.z1, hx, 0.3], [A.x0, cz, 0.3, hz], [A.x1, cz, 0.3, hz]]) {
        const c = w.createCollider(R.ColliderDesc.cuboid(ex, 30, ez).setTranslation(x, 10, z).setCollisionGroups(groups(G_BOUND, G_CHAR | G_VEH)), body);
        this.surf.set(c.handle, 'sandbag');
      }
    }
    // Invisible walls at the edge of the AO (soldiers may not leave it; vehicles neither).
    const mx = (AO.x0 + AO.x1) / 2, mz = (AO.z0 + AO.z1) / 2, hx0 = (AO.x1 - AO.x0) / 2 + 20, hz0 = (AO.z1 - AO.z0) / 2 + 20;
    for (const [cx, cz, hx, hz] of [[mx, AO.z0 - 2, hx0, 2], [mx, AO.z1 + 2, hx0, 2], [AO.x0 - 2, mz, 2, hz0], [AO.x1 + 2, mz, 2, hz0]]) {
      const c = w.createCollider(R.ColliderDesc.cuboid(hx, 60, hz).setTranslation(cx, 20, cz).setCollisionGroups(groups(G_BOUND, G_CHAR | G_VEH)), body);
      this.surf.set(c.handle, 'dirt');
    }
  }

  private gridAdd(bi: number) {
    const { c, h, q } = this.boxes[bi], r = Math.hypot(h[0], h[2]) + (q ? h[1] : 0), C = Physics.cell;
    for (let ix = Math.floor((c[0] - r) / C); ix <= Math.floor((c[0] + r) / C); ix++) for (let iz = Math.floor((c[2] - r) / C); iz <= Math.floor((c[2] + r) / C); iz++) {
      const k = this.key(ix, iz); let l = this.grid.get(k); if (!l) this.grid.set(k, l = []); l.push(bi);
    }
  }

  /** Destruction: a city box is gone (its group's collider is rebuilt on the next commit()). */
  removeBox(bi: number) {
    const b = this.boxes[bi]; if (!b || b.dead) return;
    b.dead = true; if (b.grp) this.dirty.add(b.grp);
  }
  /** Destruction: a new city box (a wall remnant) in the same group as `like`. Returns its index. */
  addBox(min: number[], max: number[], like: number): number {
    const L = this.boxes[like], bi = this.boxes.length;
    this.boxes.push({ c: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2], h: [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2], ry: 0, s: L.s, tag: L.tag, grp: L.grp });
    this.gridAdd(bi);
    if (L.grp) { this.grps.get(L.grp)!.boxes.push(bi); this.dirty.add(L.grp); }
    return bi;
  }
  /** Every live static box (city and props): centre, half extents, rotation (props), surface, building tag. */
  eachBox(fn: (c: number[], h: number[], q: number[] | undefined, s: Surface, tag: number, prop: string | null) => void) {
    for (let i = 0; i < this.boxes.length; i++) { const b = this.boxes[i]; if (!b.dead && !b.tris) fn(b.c, b.h, b.q, b.s, b.tag, i >= this.cityBoxN ? b.pid ?? '' : null); }
  }
  /** Destruction: a prop is gone (all its collision boxes). */
  removeProp(pi: number) { for (const bi of this.propBoxes.get(pi) ?? []) this.removeBox(bi); }
  tagOf(bi: number): number { return this.boxes[bi]?.tag ?? -1; }
  surfOf(bi: number): Surface | null { return this.boxes[bi]?.s ?? null; }
  /** Rebuild the trimesh of every group that changed. */
  commit() {
    const w = this.world, g = groups(G_WORLD, 0xffff);
    for (const k of this.dirty) {
      const gr = this.grps.get(k); if (!gr) continue;
      if (gr.col) { this.surf.delete(gr.col.handle); w.removeCollider(gr.col, true); gr.col = null; }
      gr.boxes = gr.boxes.filter((i) => !this.boxes[i].dead);
      if (!gr.boxes.length) continue;
      const v: number[] = [], idx: number[] = [];
      for (const i of gr.boxes) {
        const b = this.boxes[i];
        if (b.tris) { const base = v.length / 3; for (let k = 0; k < b.tris.pos.length; k++) v.push(b.tris.pos[k]); for (let k = 0; k < b.tris.idx.length; k++) idx.push(base + b.tris.idx[k]); }
        else boxTris(b.c, b.h, b.q ?? null, v, idx);
      }
      gr.col = w.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array(v), new Uint32Array(idx), 0 as never).setCollisionGroups(g).setFriction(0.8), this.cityBody!);
      this.surf.set(gr.col.handle, 'concrete');
    }
    this.dirty.clear();
  }

  /** Self-test of the heightfield layout (logs a warning if axes are swapped). */
  checkTerrain() {
    let bad = 0;
    for (const [x, z] of [[-600, -500], [-372, 300], [800, -900], [-900, 700]]) {
      const h = this.castRay([x, 200, z], [0, -1, 0], 400, G_WORLD);
      if (h && Math.abs(h.point[1] - groundH(x, z)) > 1.5) bad++;
    }
    if (bad) console.warn(`terrain heightfield mismatch at ${bad} probes`);
    return bad === 0;
  }

  /** First hit along a ray (dir normalised), against the given collision groups. */
  castRay(o: [number, number, number] | number[], d: [number, number, number] | number[], max: number, filter = G_WORLD | G_VEH, exclude?: RAPIER.Collider): RayHit | null {
    // A perfectly vertical ray landing exactly on a heightfield vertex (x, z multiples of 4 m) misses the terrain
    // (Rapier edge case): nudge such rays off the grid by a millimetre.
    const vert = d[0] === 0 && d[2] === 0;
    this.ray.origin = { x: o[0] + (vert ? 1.3e-3 : 0), y: o[1], z: o[2] + (vert ? 0.7e-3 : 0) }; this.ray.dir = { x: d[0], y: d[1], z: d[2] };
    const h = this.world.castRayAndGetNormal(this.ray, max, true, undefined, groups(0xffff, filter), exclude);
    if (!h) return null;
    const t = h.timeOfImpact;
    const hit: RayHit = {
      dist: t, point: [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t], normal: [h.normal.x, h.normal.y, h.normal.z],
      surf: this.surf.get(h.collider.handle) ?? 'concrete', tag: -1, collider: h.collider,
    };
    if (hit.surf === 'concrete' && this.grid.size) {
      const b = this.boxAt(hit.point[0] - hit.normal[0] * 0.03, hit.point[1] - hit.normal[1] * 0.03, hit.point[2] - hit.normal[2] * 0.03);
      if (b) { hit.surf = b.s; hit.tag = b.tag; }
    }
    return hit;
  }

  /** Can a standing soldier (feet at p) stand here without overlapping static geometry? */
  fits(p: number[]): boolean {
    for (const y of [0.35, 0.9, 1.5]) for (const [dx, dz] of [[0, 0], [0.28, 0], [-0.28, 0], [0, 0.28], [0, -0.28]]) if (this.boxAt(p[0] + dx, p[1] + y, p[2] + dz)) return false;
    const hit = this.world.intersectionWithShape({ x: p[0], y: p[1] + 0.95, z: p[2] }, { x: 0, y: 0, z: 0, w: 1 }, new RAPIER.Capsule(0.55, 0.3), undefined, groups(0xffff, G_WORLD));
    return !hit;
  }

  /** Static boxes whose centre lies within the square [x−r, x+r] × [z−r, z+r] (cover generation). */
  boxesNear(x: number, z: number, r: number) {
    const C = Physics.cell, out = new Set<number>();
    for (let ix = Math.floor((x - r) / C); ix <= Math.floor((x + r) / C); ix++) for (let iz = Math.floor((z - r) / C); iz <= Math.floor((z + r) / C); iz++) for (const i of this.grid.get(this.key(ix, iz)) ?? []) out.add(i);
    return [...out].map((i) => this.boxes[i]).filter((b) => !b.dead && Math.abs(b.c[0] - x) <= r && Math.abs(b.c[2] - z) <= r);
  }

  /** The static box containing a point (for surface and building lookups). */
  boxAt(x: number, y: number, z: number) {
    const C = Physics.cell, l = this.grid.get(this.key(Math.floor(x / C), Math.floor(z / C)));
    if (!l) return null;
    for (const i of l) {
      const b = this.boxes[i];
      if (b.dead) continue;
      let dx = x - b.c[0], dy = y - b.c[1], dz = z - b.c[2];
      if (b.q) { const v = rotq([-b.q[0], -b.q[1], -b.q[2], b.q[3]], [dx, dy, dz]); dx = v[0]; dy = v[1]; dz = v[2]; }
      if (Math.abs(dx) <= b.h[0] + 0.01 && Math.abs(dy) <= b.h[1] + 0.01 && Math.abs(dz) <= b.h[2] + 0.01) return b;
    }
    return null;
  }

  /** Line of sight between two points through the static world (vehicles optional). */
  clear(a: number[], b: number[], filter = G_WORLD): boolean {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], L = Math.hypot(dx, dy, dz);
    if (L < 1e-3) return true;
    return !this.castRay(a, [dx / L, dy / L, dz / L], L - 0.05, filter);
  }

  step() { this.world.step(); }
}

function boxTris(c: number[], h: number[], q: number[] | null, v: number[], idx: number[]) {
  const b = v.length / 3;
  for (let n = 0; n < 8; n++) {
    let p = [(n & 1 ? 1 : -1) * h[0], (n & 2 ? 1 : -1) * h[1], (n & 4 ? 1 : -1) * h[2]];
    if (q) p = rotq(q, p);
    v.push(c[0] + p[0], c[1] + p[1], c[2] + p[2]);
  }
  for (const [a, b2, cc, d] of BOX_FACES) idx.push(b + a, b + b2, b + cc, b + a, b + cc, b + d);
}

const BOX_FACES = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
function rotq(q: number[], v: number[]): number[] {
  const [x, y, z, w] = q, [vx, vy, vz] = v;
  const ix = w * vx + y * vz - z * vy, iy = w * vy + z * vx - x * vz, iz = w * vz + x * vy - y * vx, iw = -x * vx - y * vy - z * vz;
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
}

function propSurface(id: string): Surface {
  if (id.startsWith('veh:') || id.includes('conex') || id.includes('drum') || id.includes('tank') || id.includes('container') || id.includes('pole') || id.includes('light')) return 'metal';
  if (id.includes('hesco') || id.includes('sandbag')) return 'sandbag';
  if (id.includes('stall') || id.includes('crate') || id.includes('pallet') || id.includes('cart') || id.includes('tower')) return 'wood';
  if (id.includes('rubble') || id.includes('debris')) return 'concrete';
  if (id.includes('palm') || id.includes('tree')) return 'wood';
  return 'concrete';
}

// Rapier world: static city (cuboids), terrain (heightfield), character capsules, vehicles, grenades.
// Ray casts report the surface material so bullets can penetrate thin things and impacts look/sound right.
import RAPIER from '@dimforge/rapier3d-compat';
import type { City } from './citygen';
import type { PropBox } from './render';
import type { Surface } from './sink';
import { groundH } from './terrain';

export const G_WORLD = 0x0001, G_CHAR = 0x0002, G_VEH = 0x0004, G_DEBRIS = 0x0008;
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
  private boxes: { c: number[]; h: number[]; ry: number; q?: number[]; s: Surface; tag: number }[] = [];
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
    const chunks = new Map<number, { v: number[]; i: number[] }>();
    const add = (c: number[], h: number[], q: number[] | null, surf: Surface, tag: number, ry = 0) => {
      const bi = this.boxes.length;
      this.boxes.push({ c, h, ry, q: q ?? undefined, s: surf, tag });
      const r = Math.hypot(h[0], h[2]) + (q ? h[1] : 0), C = Physics.cell;
      for (let ix = Math.floor((c[0] - r) / C); ix <= Math.floor((c[0] + r) / C); ix++) for (let iz = Math.floor((c[2] - r) / C); iz <= Math.floor((c[2] + r) / C); iz++) {
        const k = this.key(ix, iz); let l = this.grid.get(k); if (!l) this.grid.set(k, l = []); l.push(bi);
      }
      const ck = Math.floor((c[0] + 2048) / 128) + Math.floor((c[2] + 2048) / 128) * 64;
      let ch = chunks.get(ck); if (!ch) chunks.set(ck, ch = { v: [], i: [] });
      const b = ch.v.length / 3;
      for (let n = 0; n < 8; n++) {
        let v = [(n & 1 ? 1 : -1) * h[0], (n & 2 ? 1 : -1) * h[1], (n & 4 ? 1 : -1) * h[2]];
        if (q) v = rotq(q, v);
        ch.v.push(c[0] + v[0], c[1] + v[1], c[2] + v[2]);
      }
      for (const [a, b2, cc, d] of BOX_FACES) ch.i.push(b + a, b + b2, b + cc, b + a, b + cc, b + d);
    };
    for (const c of city.sink.colliders) add(c.c, c.h, c.q ?? null, c.s, c.tag ?? -1);
    for (const p of props) {
      if (!p.tris) { add(p.c, p.h, [0, Math.sin(p.ry / 2), 0, Math.cos(p.ry / 2)], propSurface(p.id), -1, p.ry); continue; }
      // Real-shape props: their triangles go into the chunk trimesh; the (shrunk) box stays only for surface lookups.
      const bi = this.boxes.length;
      this.boxes.push({ c: p.c, h: p.h, ry: p.ry, q: [0, Math.sin(p.ry / 2), 0, Math.cos(p.ry / 2)], s: propSurface(p.id), tag: -1 });
      const C = Physics.cell, r = Math.hypot(p.h[0], p.h[2]) + 1;
      for (let ix = Math.floor((p.c[0] - r) / C); ix <= Math.floor((p.c[0] + r) / C); ix++) for (let iz = Math.floor((p.c[2] - r) / C); iz <= Math.floor((p.c[2] + r) / C); iz++) {
        const k = this.key(ix, iz); let l = this.grid.get(k); if (!l) this.grid.set(k, l = []); l.push(bi);
      }
      const ck = Math.floor((p.c[0] + 2048) / 128) + Math.floor((p.c[2] + 2048) / 128) * 64;
      let ch = chunks.get(ck); if (!ch) chunks.set(ck, ch = { v: [], i: [] });
      const base = ch.v.length / 3;
      for (let i = 0; i < p.tris.pos.length; i++) ch.v.push(p.tris.pos[i]);
      for (let i = 0; i < p.tris.idx.length; i++) ch.i.push(base + p.tris.idx[i]);
    }
    for (const ch of chunks.values()) {
      const col = w.createCollider(R.ColliderDesc.trimesh(new Float32Array(ch.v), new Uint32Array(ch.i), 0 as never).setCollisionGroups(g).setFriction(0.8), body);
      this.surf.set(col.handle, 'concrete');
    }
    // Terrain heightfield: 4 m cells over ±1000 m (rows along z, columns along x, column-major).
    const N = 500, size = 2000, heights = new Float32Array((N + 1) * (N + 1));
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) heights[i + j * (N + 1)] = groundH(-size / 2 + (j * size) / N, -size / 2 + (i * size) / N);
    const terr = w.createCollider(R.ColliderDesc.heightfield(N, N, heights, { x: size, y: 1, z: size }).setCollisionGroups(g).setFriction(0.9), body);
    this.surf.set(terr.handle, 'dirt');
    // Test areas: invisible walls just inside the HESCO line.
    if (city.area) {
      const A = city.area, cx = (A.x0 + A.x1) / 2, cz = (A.z0 + A.z1) / 2, hx = (A.x1 - A.x0) / 2, hz = (A.z1 - A.z0) / 2;
      for (const [x, z, ex, ez] of [[cx, A.z0, hx, 0.3], [cx, A.z1, hx, 0.3], [A.x0, cz, 0.3, hz], [A.x1, cz, 0.3, hz]]) {
        const c = w.createCollider(R.ColliderDesc.cuboid(ex, 30, ez).setTranslation(x, 10, z).setCollisionGroups(groups(G_WORLD, G_CHAR | G_VEH)), body);
        this.surf.set(c.handle, 'sandbag');
      }
    }
    // Invisible walls at the map edge (soldiers may not leave the AO; vehicles neither).
    for (const [cx, cz, hx, hz] of [[0, -700, 720, 2], [0, 700, 720, 2], [-700, 0, 2, 720], [700, 0, 2, 720]]) {
      const c = w.createCollider(R.ColliderDesc.cuboid(hx, 60, hz).setTranslation(cx, 20, cz).setCollisionGroups(groups(G_WORLD, G_CHAR | G_VEH)), body);
      this.surf.set(c.handle, 'dirt');
    }
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
    this.ray.origin = { x: o[0], y: o[1], z: o[2] }; this.ray.dir = { x: d[0], y: d[1], z: d[2] };
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
    return [...out].map((i) => this.boxes[i]).filter((b) => Math.abs(b.c[0] - x) <= r && Math.abs(b.c[2] - z) <= r);
  }

  /** The static box containing a point (for surface and building lookups). */
  boxAt(x: number, y: number, z: number) {
    const C = Physics.cell, l = this.grid.get(this.key(Math.floor(x / C), Math.floor(z / C)));
    if (!l) return null;
    for (const i of l) {
      const b = this.boxes[i];
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

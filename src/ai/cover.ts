// Cover points generated from the real collision geometry: along every wall, car, HESCO, rubble pile or crate that is
// at least waist high, a point is sampled every 1.5 m just outside each face and snapped onto the navmesh. Low cover
// (< 1.5 m) is used crouched and peeked over by standing; high cover is peeked round its nearest edge.
// Built lazily per 16 m cell. A point protects against a threat when the threat's line of sight to the soldier's chest
// there is blocked; it is useful when a peek position has a line of sight back.
import type { Physics } from '../world/physics';
import type { Nav } from './nav';
import type { V3 } from '../game/projectiles';

export interface CoverPoint { id: number; p: V3; low: boolean; peek: V3; n: [number, number]; /** Height of the cover above the point. */ h: number }
const CELL = 16;
let nextId = 1;

export class CoverIndex {
  private cells = new Map<number, CoverPoint[]>();
  constructor(private P: Physics, private nav: Nav | null) {}

  private key(ix: number, iz: number) { return (ix + 512) * 1024 + (iz + 512); }

  near(x: number, z: number, r: number): CoverPoint[] {
    const out: CoverPoint[] = [];
    for (let ix = Math.floor((x - r) / CELL); ix <= Math.floor((x + r) / CELL); ix++) for (let iz = Math.floor((z - r) / CELL); iz <= Math.floor((z + r) / CELL); iz++) {
      const k = this.key(ix, iz);
      let l = this.cells.get(k);
      if (!l) { l = this.build(ix, iz); this.cells.set(k, l); }
      for (const c of l) if (Math.hypot(c.p[0] - x, c.p[2] - z) <= r) out.push(c);
    }
    return out;
  }

  private build(ix: number, iz: number): CoverPoint[] {
    const out: CoverPoint[] = [], x0 = ix * CELL, z0 = iz * CELL;
    for (const b of this.P.boxesNear(x0 + CELL / 2, z0 + CELL / 2, CELL / 2 + 8)) {
      if (b.h[1] * 2 < 0.8 || (b.h[0] < 0.12 && b.h[2] < 0.12)) continue;
      const top = b.c[1] + b.h[1], cs = Math.cos(b.ry ?? 0), sn = Math.sin(b.ry ?? 0);
      // Local face frames: (normal, tangent, half-extent along the normal, half-length along the tangent).
      const faces: [number, number, number, number, number, number][] = [[1, 0, 0, 1, b.h[0], b.h[2]], [-1, 0, 0, 1, b.h[0], b.h[2]], [0, 1, 1, 0, b.h[2], b.h[0]], [0, -1, 1, 0, b.h[2], b.h[0]]];
      for (const [nx, nz, tx, tz, hn, ht] of faces) {
        // Rotate local (x, z) by ry (three.js convention: x' = x cos + z sin, z' = −x sin + z cos).
        const rot = (x: number, z: number): [number, number] => [x * cs + z * sn, -x * sn + z * cs];
        const [wnx, wnz] = rot(nx, nz), [wtx, wtz] = rot(tx, tz);
        const steps = Math.max(1, Math.floor((ht * 2) / 1.5));
        for (let i = 0; i <= steps; i++) {
          const t = -ht + 0.3 + ((ht * 2 - 0.6) * i) / Math.max(1, steps);
          const px = b.c[0] + wnx * (hn + 0.5) + wtx * t, pz = b.c[2] + wnz * (hn + 0.5) + wtz * t;
          if (px < x0 || px >= x0 + CELL || pz < z0 || pz >= z0 + CELL) continue;
          const q = this.nav?.closest([px, top, pz], 0.6);
          if (!q || Math.hypot(q[0] - px, q[2] - pz) > 0.5) continue;
          const h = top - q[1];
          if (h < 0.85 || h > 30 || q[1] > top) continue;
          if (out.some((c) => Math.hypot(c.p[0] - q[0], c.p[2] - q[2]) < 0.9 && Math.abs(c.p[1] - q[1]) < 1)) continue;
          const low = h < 1.5;
          // High cover: peek past the nearer end of the face.
          const edge = t >= 0 ? ht + 0.55 : -ht - 0.55;
          const peek: V3 = low ? q : (() => { const ex = b.c[0] + wnx * (hn + 0.45) + wtx * edge, ez = b.c[2] + wnz * (hn + 0.45) + wtz * edge; return this.nav?.closest([ex, q[1] + 0.5, ez], 0.8) ?? q; })();
          out.push({ id: nextId++, p: q, low, peek, n: [wnx, wnz], h });
        }
      }
    }
    return out;
  }

  /**
   * Is cover point c protected from a threat whose eye is at `from`? The point must be on the far side of its own
   * object (its outward normal faces away from the threat), and the line of fire must be stopped close to the soldier
   * (within 2.5 m) — a building 25 m away that happens to block the line right now is not cover.
   */
  protects(c: CoverPoint, from: V3): boolean {
    const tx = from[0] - c.p[0], tz = from[2] - c.p[2], tl = Math.hypot(tx, tz) || 1;
    if ((c.n[0] * tx + c.n[1] * tz) / tl > -0.25) return false;
    const chest: V3 = [c.p[0], c.p[1] + (c.low ? 0.85 : 1.35), c.p[2]];
    const dx = from[0] - chest[0], dy = from[1] - chest[1], dz = from[2] - chest[2], L = Math.hypot(dx, dy, dz) || 1;
    const hit = this.P.castRay(chest, [dx / L, dy / L, dz / L], Math.min(2.5, L - 0.1));
    return !!hit;
  }
  /** Can a soldier at the peek position see/shoot the target point? */
  canPeek(c: CoverPoint, at: V3): boolean {
    const eye: V3 = [c.peek[0], c.peek[1] + (c.low ? 1.5 : 1.6), c.peek[2]];
    return this.P.clear(eye, at);
  }
}

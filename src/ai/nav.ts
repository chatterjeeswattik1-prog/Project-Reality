// Bot navigation on the baked Recast navmesh (public/nav/zahran-<seed>.bin, made by scripts/navmesh.ts).
// Without a navmesh the bots fall back to steering straight at their goal with obstacle feelers.
import { init, importNavMesh, NavMeshQuery, type NavMesh } from 'recast-navigation';
import type { City } from '../world/citygen';
import { navGeometry, NAV_CONFIG, type Box } from '../world/navgeom';

type V3 = [number, number, number];
const BASE = import.meta.env.BASE_URL;

export class Nav {
  /** Path queries left this frame (reset by the director): long A* searches are spread over frames. */
  budget = 3;
  constructor(public mesh: NavMesh, public q: NavMeshQuery) {}

  static async load(seed: number): Promise<Nav | null> {
    try {
      const r = await fetch(`${BASE}nav/zahran-${seed}.bin`);
      if (!r.ok) { console.warn('no navmesh baked — bots will steer directly (run npm run navmesh)'); return null; }
      await init();
      const { navMesh } = importNavMesh(new Uint8Array(await r.arrayBuffer()));
      return new Nav(navMesh, new NavMeshQuery(navMesh));
    } catch (e) { console.warn('navmesh load failed', e); return null; }
  }

  /** Build a navmesh in the browser for a small area (test areas: a second or two, no baked file needed). */
  static async generate(city: City, props: Box[]): Promise<Nav | null> {
    const A = city.area; if (!A) return null;
    await init();
    const { generateTiledNavMesh } = await import('recast-navigation/generators');
    const bounds: [[number, number, number], [number, number, number]] = [[A.x0 - 4, -8, A.z0 - 4], [A.x1 + 4, 45, A.z1 + 4]];
    const { positions, indices } = navGeometry(city, props, bounds);
    const r = generateTiledNavMesh(positions, indices, { ...NAV_CONFIG, bounds });
    if (!r.success) { console.warn('navmesh generation failed', r.error); return null; }
    return new Nav(r.navMesh, new NavMeshQuery(r.navMesh));
  }

  /** Straight path (corner points) from a to b, or null. */
  path(a: V3, b: V3): V3[] | null {
    this.budget--;
    const r = this.q.computePath({ x: a[0], y: a[1], z: a[2] }, { x: b[0], y: b[1], z: b[2] }, { halfExtents: { x: 3, y: 4, z: 3 }, maxPathPolys: 1024, maxStraightPathPoints: 256 });
    if (!r.success || !r.path.length) return null;
    return r.path.map((p) => [p.x, p.y, p.z] as V3);
  }

  /** The navmesh polygon under a point (for surface-constrained movement), or 0. */
  ref(p: V3): number {
    // Tight vertically first, so on stairs and upper floors it is the polygon underfoot, not the one above or below.
    for (const e of [[0.6, 1.0], [2, 4]]) {
      const r = this.q.findNearestPoly({ x: p[0], y: p[1] + 0.2, z: p[2] }, { halfExtents: { x: e[0], y: e[1], z: e[0] } });
      if (r.success && r.nearestRef) return r.nearestRef;
    }
    return 0;
  }

  /**
   * Move from `from` towards `to` while staying on the navmesh: blocked moves slide along walls instead of passing
   * through them. Returns the new position (on the polygon's surface height) and polygon.
   */
  step(ref: number, from: V3, to: V3): { p: V3; ref: number } | null {
    const r = this.q.moveAlongSurface(ref, { x: from[0], y: from[1], z: from[2] }, { x: to[0], y: to[1], z: to[2] }, { maxVisitedSize: 16 });
    if (!r.success) return null;
    const nref = r.visited.length ? r.visited[r.visited.length - 1] : ref;
    const h = this.q.getPolyHeight(nref, r.resultPosition);
    return { p: [r.resultPosition.x, h.success ? h.height : from[1], r.resultPosition.z], ref: nref };
  }

  /** Straight walk from a to b stays on the navmesh (no wall or edge in between). */
  clearLine(ref: number, a: V3, b: V3): boolean {
    if (!ref) return false;
    const r = this.q.raycast(ref, { x: a[0], y: a[1], z: a[2] }, { x: b[0], y: b[1], z: b[2] });
    return r.t > 0.999;
  }

  /** Nearest point on the navmesh. */
  closest(p: V3, ext = 4): V3 | null {
    const r = this.q.findClosestPoint({ x: p[0], y: p[1], z: p[2] }, { halfExtents: { x: ext, y: 6, z: ext } });
    return r.success ? [r.point.x, r.point.y, r.point.z] : null;
  }

  /** Random reachable point within `radius` of p. */
  around(p: V3, radius: number): V3 | null {
    const s = this.q.findClosestPoint({ x: p[0], y: p[1], z: p[2] }, { halfExtents: { x: 4, y: 6, z: 4 } });
    if (!s.success) return null;
    const r = this.q.findRandomPointAroundCircle(s.point, radius, { startRef: s.polyRef });
    return r.success ? [r.randomPoint.x, r.randomPoint.y, r.randomPoint.z] : null;
  }
}

/** A spawn point near `p` that is on the navmesh and clear of walls (tries the point itself, then nearby ones). */
export function safeSpawn(P: { fits: (p: number[]) => boolean }, nav: Nav | null, p: V3, radius = 4): V3 {
  const cands: V3[] = [];
  const c = nav?.closest(p, 2); if (c) cands.push(c);
  cands.push(p);
  for (let i = 0; i < 16; i++) { const a = nav?.around(p, radius * (0.4 + i / 16)); if (a) cands.push(a); }
  for (const q of cands) { const f: V3 = [q[0], q[1] + 0.05, q[2]]; if (P.fits(f)) return f; }
  return c ?? p;
}

// Navmesh input geometry: every static collider box (and solid prop box) as triangles, plus the terrain inside the
// playable area. Shared by the offline baker (scripts/navmesh.ts) and the runtime fallback.
import type { City } from './citygen';
import { groundH, HALF } from './terrain';

export interface Box { c: number[]; h: number[]; q?: number[]; ry?: number; tris?: { pos: Float32Array; idx: Uint32Array } }

export const NAV_BOUNDS: [[number, number, number], [number, number, number]] = [[-HALF - 10, -8, -HALF - 10], [HALF + 10, 45, HALF + 10]];
export const NAV_CONFIG = {
  cs: 0.2, ch: 0.1, walkableSlopeAngle: 50, walkableHeight: 17, walkableClimb: 4, walkableRadius: 1,
  maxEdgeLen: 60, maxSimplificationError: 1.3, minRegionArea: 8, mergeRegionArea: 20, maxVertsPerPoly: 6,
  detailSampleDist: 6, detailSampleMaxError: 1, tileSize: 128,
};

function rotate(q: number[], v: number[]): number[] {
  const [x, y, z, w] = q, [vx, vy, vz] = v;
  const ix = w * vx + y * vz - z * vy, iy = w * vy + z * vx - x * vz, iz = w * vz + x * vy - y * vx, iw = -x * vx - y * vy - z * vz;
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
}

export function navGeometry(city: City, props: Box[], bounds = NAV_BOUNDS): { positions: Float32Array; indices: Uint32Array } {
  const pos: number[] = [], idx: number[] = [];
  const box = (b: Box) => {
    const q = b.q ?? (b.ry !== undefined ? [0, Math.sin(b.ry / 2), 0, Math.cos(b.ry / 2)] : null);
    const base = pos.length / 3;
    for (let i = 0; i < 8; i++) {
      let v = [(i & 1 ? 1 : -1) * b.h[0], (i & 2 ? 1 : -1) * b.h[1], (i & 4 ? 1 : -1) * b.h[2]];
      if (q) v = rotate(q, v);
      pos.push(b.c[0] + v[0], b.c[1] + v[1], b.c[2] + v[2]);
    }
    // 12 triangles, counter-clockwise from outside.
    const F = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
    for (const [a, b2, c, d] of F) idx.push(base + a, base + b2, base + c, base + a, base + c, base + d);
  };
  const [mn, mx] = bounds;
  for (const c of city.sink.colliders) if (c.c[0] > mn[0] - 5 && c.c[0] < mx[0] + 5 && c.c[2] > mn[2] - 5 && c.c[2] < mx[2] + 5) box(c);
  for (const p of props) {
    if (!p.tris) { box(p); continue; }
    const base = pos.length / 3;
    for (let i = 0; i < p.tris.pos.length; i++) pos.push(p.tris.pos[i]);
    for (let i = 0; i < p.tris.idx.length; i++) idx.push(base + p.tris.idx[i]);
  }
  // Terrain grid (4 m) inside the bounds.
  const step = 4, n = Math.ceil((mx[0] - mn[0]) / step), base = pos.length / 3;
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) { const x = mn[0] + i * step, z = mn[2] + j * step; pos.push(x, groundH(x, z), z); }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const a = base + j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1; idx.push(a, c, b, b, c, d); }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

/** Collider box for a solid prop placement from its model's bounds (root-local). Palms and poles: trunk only. */
export function solidBox(id: string, min: number[], max: number[], p: { x: number; y: number; z: number; ry: number; s?: number }): Box & { id: string } {
  const s = p.s ?? 1;
  let hx = ((max[0] - min[0]) / 2) * s, hy = ((max[1] - min[1]) / 2) * s, hz = ((max[2] - min[2]) / 2) * s;
  let cx = ((max[0] + min[0]) / 2) * s, cz = ((max[2] + min[2]) / 2) * s;
  const cy = ((max[1] + min[1]) / 2) * s;
  if (id.startsWith('palm') || id === 'power_pole' || id === 'street_light' || id === 'flagpole' || id === 'antenna_tv' || id === 'dead_tree') { hx = hz = 0.2; cx = cz = 0; }
  const c = Math.cos(p.ry), sn = Math.sin(p.ry);
  // Rotation about Y (three.js convention: x' = x cos + z sin, z' = −x sin + z cos).
  const rx = cx * c + cz * sn, rz = -cx * sn + cz * c;
  return { id, c: [p.x + rx, p.y + cy, p.z + rz], h: [Math.max(0.05, hx), Math.max(0.05, hy), Math.max(0.05, hz)], ry: p.ry };
}

/** Fitted collision boxes per model id (scripts/propcol.mjs → public/models/props_col.json): [cx, cy, cz, hx, hy, hz]. */
export type PropCol = Record<string, number[][]>;
/** World boxes for one prop placement from its model's fitted boxes (scaled, rotated about Y like the instance). */
export function fittedBoxes(id: string, col: number[][], p: { x: number; y: number; z: number; ry: number; s?: number }): (Box & { id: string })[] {
  const s = p.s ?? 1, c = Math.cos(p.ry), sn = Math.sin(p.ry);
  return col.map(([bx, by, bz, hx, hy, hz]) => {
    const x = bx * s, z = bz * s;
    return { id, c: [p.x + x * c + z * sn, p.y + by * s, p.z - x * sn + z * c], h: [Math.max(0.03, hx * s), Math.max(0.03, hy * s), Math.max(0.03, hz * s)], ry: p.ry };
  });
}

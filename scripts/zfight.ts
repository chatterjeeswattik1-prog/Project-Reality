// Z-fighting finder: generate the city and list places where two visible faces lie in the same plane, facing the same
// way and overlapping (they flicker against each other). Axis-aligned faces only (walls, floors, ceilings).
//   node_modules/.bin/esbuild scripts/zfight.ts --bundle --platform=node --format=esm --outfile=node_modules/.cache/zfight.mjs && node node_modules/.cache/zfight.mjs [x0,z0,x1,z1]
import { generateCity } from '../src/world/citygen';
const rect = process.argv[2]?.split(',').map(Number);
const c = generateCity(1337);
type T = { tri: number[][]; a: number; u0: number; u1: number; v0: number; v1: number; mi: number; layer: number; cx: number; cz: number; y: number };
const planes = new Map<string, T[]>();
let n = 0;
for (const b of c.sink.batches.values()) {
  if (b.layer === 3) continue; // far shells swap with the detail
  for (let i = 0; i < b.n; i += 3) {
    const p = (k: number) => [b.pos[(i + k) * 3], b.pos[(i + k) * 3 + 1], b.pos[(i + k) * 3 + 2]];
    const nx = b.nrm[i * 3], ny = b.nrm[i * 3 + 1], nz = b.nrm[i * 3 + 2];
    const ax = Math.abs(nx) > 0.999 ? 0 : Math.abs(ny) > 0.999 ? 1 : Math.abs(nz) > 0.999 ? 2 : -1; if (ax < 0) continue;
    const A = p(0), B = p(1), C = p(2);
    if (rect && (A[0] < rect[0] || A[0] > rect[2] || A[2] < rect[1] || A[2] > rect[3])) continue;
    const s = Math.sign([nx, ny, nz][ax]), off = A[ax];
    const ua = (ax + 1) % 3, va = (ax + 2) % 3;
    const us = [A[ua], B[ua], C[ua]], vs = [A[va], B[va], C[va]];
    const u0 = Math.min(...us), u1 = Math.max(...us), v0 = Math.min(...vs), v1 = Math.max(...vs);
    const area = Math.abs((B[ua] - A[ua]) * (C[va] - A[va]) - (C[ua] - A[ua]) * (B[va] - A[va])) / 2;
    if (area < 1e-4) continue;
    const key = `${ax}:${s}:${Math.round(off * 2500)}`;
    (planes.get(key) ?? planes.set(key, []).get(key)!).push({ tri: [[A[ua], A[va]], [B[ua], B[va]], [C[ua], C[va]]], a: area, u0, u1, v0, v1, mi: b.mi[i], layer: b.layer, cx: (A[0] + B[0] + C[0]) / 3, cz: (A[2] + B[2] + C[2]) / 3, y: (A[1] + B[1] + C[1]) / 3 });
    n++;
  }
}
console.log('faces', n, 'planes', planes.size);
// Overlaps between triangles of the same plane and facing: count 2D bbox overlaps with an area check on the bboxes,
// excluding the two triangles of one quad (they share an edge: their bboxes overlap but their areas do not). A real
// overlap: bbox intersection area > 0.6 of the smaller triangle's area * 2 and > 0.02 mÂ².
// Area of the intersection of two triangles (Sutherland–Hodgman clip of one by the other).
function overlap(a: number[][], b: number[][]): number {
  const area = (p: number[][]) => { let s = 0; for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i + 1) % p.length]; s += q[0] * r[1] - r[0] * q[1]; } return s / 2; };
  const cw = area(b) < 0; const B = cw ? [...b].reverse() : b;
  let poly = a;
  for (let i = 0; i < 3 && poly.length; i++) {
    const p1 = B[i], p2 = B[(i + 1) % 3], inside = (q: number[]) => (p2[0] - p1[0]) * (q[1] - p1[1]) - (p2[1] - p1[1]) * (q[0] - p1[0]) >= -1e-9;
    const out: number[][] = [];
    for (let j = 0; j < poly.length; j++) {
      const c = poly[j], d = poly[(j + 1) % poly.length], ci = inside(c), di = inside(d);
      if (ci) out.push(c);
      if (ci !== di) { const x1 = c[0], y1 = c[1], x2 = d[0], y2 = d[1], x3 = p1[0], y3 = p1[1], x4 = p2[0], y4 = p2[1]; const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4); if (Math.abs(den) > 1e-12) { const tt = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den; out.push([x1 + tt * (x2 - x1), y1 + tt * (y2 - y1)]); } }
    }
    poly = out;
  }
  return poly.length >= 3 ? Math.abs(area(poly)) : 0;
}
const hits = new Map<string, { n: number; at: number[]; mats: Set<number> }>();
for (const [key, ts] of planes) {
  if (ts.length < 2) continue;
  ts.sort((x, y) => x.u0 - y.u0);
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i];
    for (let j = i + 1; j < ts.length && ts[j].u0 < t.u1; j++) {
      const o = ts[j];
      const du = Math.min(t.u1, o.u1) - Math.max(t.u0, o.u0), dv = Math.min(t.v1, o.v1) - Math.max(t.v0, o.v0);
      if (du <= 0.01 || dv <= 0.01) continue;
      if (du * dv < 0.01) continue;
      const ov = overlap(t.tri, o.tri);
      if (ov < 0.01) continue;
      if (process.env.AT) { const [x, y, z] = process.env.AT.split(',').map(Number); if (Math.hypot(t.cx - x, t.y - y, t.cz - z) < 1.5) console.log('PAIR', key, JSON.stringify(t), JSON.stringify(o)); }
      const k = `${Math.round(t.cx)},${Math.round(t.y)},${Math.round(t.cz)}`;
      const h = hits.get(k) ?? hits.set(k, { n: 0, at: [+t.cx.toFixed(1), +t.y.toFixed(1), +t.cz.toFixed(1)], mats: new Set() }).get(k)!;
      h.n++; h.mats.add(t.mi); h.mats.add(o.mi);
    }
  }
}
const list = [...hits.values()].sort((a, b) => b.n - a.n);
console.log('z-fight spots', list.length, 'mixed-material', list.filter((h) => h.mats.size > 1).length);
for (const h of list.slice(0, 30)) console.log(JSON.stringify({ ...h, mats: [...h.mats] }));

// Collision shapes for props and vehicles: a few boxes fitted to each model's real shape (root-local space, metres),
// written to public/models/props_col.json and used by both the game (world/render.ts, world/physics.ts) and the offline
// navmesh baker (scripts/navmesh.ts).   node scripts/propcol.mjs
// A full triangle mesh per placed prop (tens of thousands on the map) was ~10 M collision triangles; a bounding box
// leaves invisible walls round open shapes (tank on legs, pole cross-arm, dish). Here: voxelise the surface, fill the
// enclosed interior, greedily merge into boxes; a model that fills most of its bounds becomes one tight box.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import fs from 'node:fs';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const MAX_BOXES = 14;

function mat4(n) { return n.getWorldMatrix(); }
function apply(m, v) { return [m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13], m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]]; }
function inv(m) {
  // affine inverse (rotation-scale 3x3 + translation)
  const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], i = m[10];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  const r = [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, 0, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, 0, C / det, -(a * h - b * g) / det, (a * e - b * d) / det, 0, 0, 0, 0, 1];
  const t = [m[12], m[13], m[14]];
  r[12] = -(r[0] * t[0] + r[4] * t[1] + r[8] * t[2]); r[13] = -(r[1] * t[0] + r[5] * t[1] + r[9] * t[2]); r[14] = -(r[2] * t[0] + r[6] * t[1] + r[10] * t[2]);
  return r;
}

/** All triangles under `root`, in root-local space. */
function triangles(root) {
  const R = inv(mat4(root)), tris = [];
  const walk = (n) => {
    const mesh = n.getMesh();
    if (mesh) {
      const M = mat4(n);
      for (const p of mesh.listPrimitives()) {
        if (p.getMode() !== 4) continue;
        const pos = p.getAttribute('POSITION'), idx = p.getIndices(), v = [];
        for (let i = 0; i < pos.getCount(); i++) v.push(apply(R, apply(M, pos.getElement(i, []))));
        const I = idx ? idx.getArray() : [...Array(pos.getCount()).keys()];
        for (let t = 0; t + 2 < I.length; t += 3) tris.push([v[I[t]], v[I[t + 1]], v[I[t + 2]]]);
      }
    }
    for (const c of n.listChildren()) walk(c);
  };
  walk(root);
  return tris;
}

function fit(tris) {
  if (!tris.length) return null;
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const t of tris) for (const v of t) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], v[k]); mx[k] = Math.max(mx[k], v[k]); }
  const ext = mx.map((v, k) => v - mn[k]), maxD = Math.max(...ext);
  const bbox = [0, 1, 2].map((k) => +((mn[k] + mx[k]) / 2).toFixed(3)).concat([0, 1, 2].map((k) => +(ext[k] / 2).toFixed(3)));
  const small = maxD < 1.0;
  for (let res = Math.min(0.12, Math.max(0.03, maxD / 24)); ; res *= 1.25) {
    const n = ext.map((e) => Math.max(1, Math.ceil(e / res)) + 2), N = n[0] * n[1] * n[2];
    const at = (x, y, z) => (z * n[1] + y) * n[0] + x;
    const grid = new Uint8Array(N); // 1 surface, 2 outside, 0 inside
    const cell = (v, k) => Math.min(n[k] - 2, Math.max(1, 1 + Math.floor((v - mn[k]) / res)));
    for (const [a, b, c] of tris) {
      const e1 = b.map((v, k) => v - a[k]), e2 = c.map((v, k) => v - a[k]);
      const L = Math.max(Math.hypot(...e1), Math.hypot(...e2), Math.hypot(...c.map((v, k) => v - b[k])));
      const s = Math.max(1, Math.ceil(L / (res * 0.5)));
      for (let i = 0; i <= s; i++) for (let j = 0; i + j <= s; j++) {
        const u = i / s, w = j / s, p = a.map((v, k) => v + e1[k] * u + e2[k] * w);
        grid[at(cell(p[0], 0), cell(p[1], 1), cell(p[2], 2))] = 1;
      }
    }
    // Flood the outside from the padded border; what it cannot reach is enclosed (solid).
    const st = [0]; grid[0] = 2;
    while (st.length) {
      const i = st.pop(), x = i % n[0], y = Math.floor(i / n[0]) % n[1], z = Math.floor(i / (n[0] * n[1]));
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const X = x + dx, Y = y + dy, Z = z + dz;
        if (X < 0 || Y < 0 || Z < 0 || X >= n[0] || Y >= n[1] || Z >= n[2]) continue;
        const j = at(X, Y, Z); if (grid[j] === 0) { grid[j] = 2; st.push(j); }
      }
    }
    const solid = new Uint8Array(N); let filled = 0;
    for (let i = 0; i < N; i++) if (grid[i] !== 2) { solid[i] = 1; filled++; }
    const bboxCells = (n[0] - 2) * (n[1] - 2) * (n[2] - 2);
    const box = (x0, y0, z0, x1, y1, z1) => {
      const lo = [mn[0] + (x0 - 1) * res, mn[1] + (y0 - 1) * res, mn[2] + (z0 - 1) * res], hi = [mn[0] + x1 * res, mn[1] + y1 * res, mn[2] + z1 * res];
      for (let k = 0; k < 3; k++) { lo[k] = Math.max(lo[k], mn[k]); hi[k] = Math.min(hi[k], mx[k]); }
      return [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2, (hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2].map((v) => +v.toFixed(3));
    };
    if (filled / bboxCells > 0.88) return { boxes: [box(1, 1, 1, n[0] - 2, n[1] - 2, n[2] - 2)], fill: filled / bboxCells, res, bbox, small };
    // Greedy merge: grow x, then z, then y.
    const used = new Uint8Array(N), boxes = [];
    const free = (x, y, z) => solid[at(x, y, z)] && !used[at(x, y, z)];
    for (let y = 1; y < n[1] - 1; y++) for (let z = 1; z < n[2] - 1; z++) for (let x = 1; x < n[0] - 1; x++) {
      if (!free(x, y, z)) continue;
      let x1 = x; while (x1 + 1 < n[0] - 1 && free(x1 + 1, y, z)) x1++;
      let z1 = z; grow: while (z1 + 1 < n[2] - 1) { for (let xx = x; xx <= x1; xx++) if (!free(xx, y, z1 + 1)) break grow; z1++; }
      let y1 = y; growY: while (y1 + 1 < n[1] - 1) { for (let zz = z; zz <= z1; zz++) for (let xx = x; xx <= x1; xx++) if (!free(xx, y1 + 1, zz)) break growY; y1++; }
      for (let yy = y; yy <= y1; yy++) for (let zz = z; zz <= z1; zz++) for (let xx = x; xx <= x1; xx++) used[at(xx, yy, zz)] = 1;
      boxes.push({ b: [x, y, z, x1, y1, z1], v: (x1 - x + 1) * (y1 - y + 1) * (z1 - z + 1) });
    }
    // Keep the biggest boxes; tiny specks (wires, knobs) are dropped.
    boxes.sort((p, q) => q.v - p.v);
    const keep = boxes.filter((b) => b.v >= Math.max(2, filled * 0.01));
    if (keep.length <= MAX_BOXES || res > maxD / 3) return { boxes: keep.slice(0, MAX_BOXES).map((k) => box(...k.b)), fill: filled / bboxCells, res, bbox, small };
  }
}

const out = {};
/** Lines and masts: only what stands on the ground collides (posts, the mast) — the wire or arms would be walls. */
const POSTS_ONLY = /^(clothesline|antenna_tv|street_light|flagpole|bulb_hanging|ceiling_fan|tree_)/;
/** Indoor furniture and small items: one tight box (tens of thousands of placements; nobody shoots under a sofa). */
const ONE_BOX = /^(floor_cushions|sofa_old|armchair|rug_|coffee_table|tv_crt|side_table|curtain_|bed_double|mattress_|wardrobe|dresser|clothes_pile|prayer_mat|kitchen_|fridge_old|gas_stove|table_dining|water_cooler|cardboard_boxes|plastic_crates|shoes_rack|wall_shelf|picture_frame|broken_furniture|sandbag_window|bedsheet_window|gas_cylinder|oil_drum|plastic_chair|crate|pallet|generator_small|tyres_pile|trash_)/;
const doc = await io.read('public/models/props.glb');
for (const root of doc.getRoot().getDefaultScene().listChildren()) {
  const f = fit(triangles(root));
  if (!f) continue;
  const name = root.getName();
  if (ONE_BOX.test(name) || f.small) { out[name] = [f.bbox]; continue; }
  out[name] = POSTS_ONLY.test(name) ? f.boxes.filter((b) => b[1] - b[4] < 0.15) : f.boxes;
}
for (const file of fs.readdirSync('public/models/vehicles').filter((f) => f.endsWith('.glb'))) {
  const d = await io.read(`public/models/vehicles/${file}`), scene = d.getRoot().getDefaultScene();
  const roots = scene.listChildren();
  const tris = roots.flatMap((r) => { const t = triangles(r); const M = mat4(r); return t.map((tri) => tri.map((v) => apply(M, v))); });
  const f = fit(tris);
  if (f) out['veh:' + file.replace(/\.glb$/, '')] = f.boxes;
}
fs.writeFileSync('public/models/props_col.json', JSON.stringify(out));
const counts = Object.values(out).map((b) => b.length);
console.log(`${Object.keys(out).length} models, boxes per model: avg ${(counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(1)}, max ${Math.max(...counts)}`);
for (const id of ['water_tank', 'power_pole', 'sat_dish', 'veh:sedan', 'hesco_wall', 'clothesline', 'gas_cylinder', 'sofa_old', 'solar_heater']) console.log(id, JSON.stringify(out[id]));

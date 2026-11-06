// Destructible city. Every box the generator emitted (walls, slabs, parapets, caps, shutters, compound walls) is a
// piece (sink.ts PieceTable) that knows where its faces sit in the merged chunk meshes. A blast cuts a jagged hole
// through the pieces it reaches: the piece's faces are collapsed in place, the remnants around the hole are emitted as
// new boxes (same material, tint and paint; the broken edges show the masonry core) into run-time meshes, and the
// physics boxes are swapped (physics.ts rebuilds that building's trimesh). Remnants left hanging with nothing holding
// them come down. The volume blown out is thrown as rubble: physical chunks that tumble, settle and stay.
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { MATS, MAT_INDEX, type MatId, type PieceTable, type Surface, faceEps } from './sink';
import { G_DEBRIS, G_VEH, G_WORLD, groups, type Physics } from './physics';
import type { WorldView } from './render';
import type { City } from './citygen';
import { groundH } from './terrain';
import { tex } from '../core/assets';

type V3 = [number, number, number];
const MAT_IDS = Object.keys(MATS) as MatId[];
/** A face's look, read back from the mesh it was drawn in. */
interface Style { mi: number; layer: number; chunk: number; bot: V3; top: V3 }
interface Op { a0: number; a1: number; b0: number; b1: number }
/** What a blast did (for effects): hole centres with their outward normal and size, and the volume brought down. */
export interface BlastResult { holes: { p: V3; n: V3; r: number; surf: Surface }[]; volume: number; fell: number; /** Props wrecked or brought down. */ props: number }

const DYN_CAP = 6 * 700;
/** Props a blast never takes away (the cache crates are the insurgency objective: insurgency.ts destroys them). */
const ROBUST = /^(cache_crate|market_stall|burnt_tyre|hesco|t_wall|jersey|sandbag|conex|veh:|rubble|debris_|palm|dead_tree|minaret|dome_|arch_gate|fountain|guard_tower|power_pole|street_light|floodlight|flagpole|tent_|camo_net|wire_|billboard|transformer|kerb_barrier|grass|shrub|bush|reeds)/;
/** Props fixed to a wall or a ceiling rather than standing on a floor. */
const HUNG = /^(ceiling_fan|bulb_hanging|picture_frame|curtain_|wall_shelf|bedsheet_window|sandbag_window|ac_split|ac_window|sign_shop|awning_shop|shop_shutter|clothesline)/;
/** What a tank drives over: trees and palms topple; the rest is flattened. Buildings, HESCO, wrecks are not. */
const CRUSH = /^(tree_|palm_|dead_tree|shrub|bush|reeds|grass|cart_|market_stall|plastic_|table_|trash|tyres|oil_drum|gas_cylinder|crate|pallet|cardboard|street_light|power_pole|sign_shop|kerb_barrier|generator|water_tank)/;
const FELL = /^(tree_|palm_|dead_tree|street_light|power_pole)/;
const SOFT = /^(floor_cushions|sofa_old|armchair|rug_|coffee_table|side_table|curtain_|bed_double|mattress_|wardrobe|dresser|clothes_pile|prayer_mat|kitchen_|table_|shoes_rack|wall_shelf|picture_frame|broken_furniture|cardboard|pallet|crate_|cart_|market_stall|plastic_|bedsheet|clothesline|trash)/;
const MAX_RUBBLE = 2400, MAX_ACTIVE = 110;

class DynMesh {
  n = 0;
  mesh: THREE.Mesh;
  pos = new Float32Array(DYN_CAP * 3); nrm = new Float32Array(DYN_CAP * 3); uv = new Float32Array(DYN_CAP * 2); col = new Float32Array(DYN_CAP * 3); mi = new Float32Array(DYN_CAP);
  constructor(mat: THREE.Material, layer: number) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nrm, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('mi', new THREE.BufferAttribute(this.mi, 1).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.castShadow = layer !== 1; this.mesh.receiveShadow = true; this.mesh.matrixAutoUpdate = false;
    this.mesh.frustumCulled = false; // grows as walls break; small, so no culling bookkeeping
    this.mesh.userData.layer = layer;
  }
  get full() { return this.n + 6 > DYN_CAP; }
  /** Push a quad (corners counter-clockwise from the front). Returns its first vertex. */
  quad(p: number[][], n: V3, st: Style, colBot: V3, colTop: V3, mi: number): number {
    const v0 = this.n, s = 1 / MATS[MAT_IDS[mi]].uv, e = faceEps(mi, st.layer);
    const ax = Math.abs(n[0]), ay = Math.abs(n[1]);
    for (const i of [0, 1, 2, 0, 2, 3]) {
      const [x, y, z] = p[i], v = this.n++;
      this.pos[v * 3] = x + n[0] * e; this.pos[v * 3 + 1] = y + n[1] * e; this.pos[v * 3 + 2] = z + n[2] * e;
      this.nrm[v * 3] = n[0]; this.nrm[v * 3 + 1] = n[1]; this.nrm[v * 3 + 2] = n[2];
      if (ay > 0.7) { this.uv[v * 2] = x * s; this.uv[v * 2 + 1] = -z * s; }
      else if (ax > 0.7) { this.uv[v * 2] = (n[0] > 0 ? -z : z) * s; this.uv[v * 2 + 1] = y * s; }
      else { this.uv[v * 2] = (n[2] > 0 ? x : -x) * s; this.uv[v * 2 + 1] = y * s; }
      const c = i < 2 && ay < 0.7 ? colBot : colTop;
      this.col[v * 3] = c[0]; this.col[v * 3 + 1] = c[1]; this.col[v * 3 + 2] = c[2];
      this.mi[v] = mi;
    }
    return v0;
  }
  flush() {
    const g = this.mesh.geometry;
    for (const k of ['position', 'normal', 'uv', 'color', 'mi']) (g.attributes[k] as THREE.BufferAttribute).needsUpdate = true;
    g.setDrawRange(0, this.n);
  }
}

/** Corner lists of the six faces of a box (−x, +x, −y, +y, −z, +z), as in Sink.box. */
function facePts(min: number[], max: number[], f: number): number[][] {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  switch (f) {
    case 0: return [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]];
    case 1: return [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]];
    case 2: return [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]];
    case 3: return [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]];
    case 4: return [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]];
    default: return [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  }
}
const NORMALS: V3[] = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]];

export class Destruction {
  private T: PieceTable;
  private meshes: THREE.Mesh[];
  private dyn = new Map<string, { dm: DynMesh; id: number }>();
  private touched = new Set<THREE.BufferAttribute>();
  private touchedDyn = new Set<DynMesh>();
  private dynOf = new Map<number, DynMesh>();
  // Rubble.
  private rubble: THREE.InstancedMesh;
  private rubbleN = 0;
  private active: { body: RAPIER.RigidBody; i: number; t: number; s: THREE.Vector3 }[] = [];
  private m4 = new THREE.Matrix4(); private q = new THREE.Quaternion(); private v = new THREE.Vector3();
  private propGone = new Set<number>();
  /** Props falling over (trees pushed down by a tank): their instance slots rotate about the base. */
  private falling: { slots: [THREE.InstancedMesh, number, THREE.Matrix4][]; base: THREE.Vector3; axis: THREE.Vector3; t: number }[] = [];
  /** 8 m grids of prop and piece indices (crushing looks only at what is near a moving vehicle). */
  private propGrid: Map<number, number[]> | null = null; private pieceGrid: Map<number, number[]> | null = null;
  private zero = new THREE.Matrix4().makeScale(0, 0, 0);
  /** The game (sounds), set by the game after construction. */
  g: { audio: { play: (n: string, p: [number, number, number] | null, o?: Record<string, unknown>) => unknown } } | null = null;
  /** Pieces removed so far, and the time (ms) of the last blast's stages: scan, cut, settle, physics, upload. */
  removed = 0;
  prof = [0, 0, 0, 0, 0];

  constructor(private city: City, private P: Physics, private W: WorldView, scene: THREE.Scene) {
    this.T = city.sink.pieces;
    this.meshes = W.batchMesh.slice();
    // A rough lump: an icosahedron with its corners pulled about, flat shaded (a broken block, not a tidy cube).
    let s0 = 11; const rnd = () => ((s0 = (s0 * 16807) % 2147483647) / 2147483647);
    const box = new THREE.IcosahedronGeometry(0.62, 0).toNonIndexed();
    const pa = box.attributes.position as THREE.BufferAttribute, moved = new Map<string, [number, number, number]>();
    for (let i = 0; i < pa.count; i++) {
      const k = `${pa.getX(i).toFixed(3)},${pa.getY(i).toFixed(3)},${pa.getZ(i).toFixed(3)}`;
      let m = moved.get(k); if (!m) moved.set(k, m = [0.75 + rnd() * 0.4, 0.75 + rnd() * 0.4, 0.75 + rnd() * 0.4]);
      pa.setXYZ(i, Math.max(-0.5, Math.min(0.5, pa.getX(i) * m[0])), Math.max(-0.5, Math.min(0.5, pa.getY(i) * m[1])), Math.max(-0.5, Math.min(0.5, pa.getZ(i) * m[2])));
    }
    box.computeVertexNormals();
    const uvs = new Float32Array(pa.count * 2);
    for (let i = 0; i < pa.count; i++) { uvs[i * 2] = (pa.getX(i) + pa.getZ(i)) * 0.5 + 0.5; uvs[i * 2 + 1] = pa.getY(i) + 0.5; }
    box.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    // Broken masonry: the damaged-plaster set (brick under render), tinted per chunk with the wall's colour.
    const mat = new THREE.MeshStandardMaterial({ map: tex('assets/tex/damaged_plaster/diff.jpg'), normalMap: tex('assets/tex/damaged_plaster/nor.jpg', false), roughness: 0.95 });
    this.rubble = new THREE.InstancedMesh(box, mat, MAX_RUBBLE);
    this.rubble.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_RUBBLE * 3), 3);
    this.rubble.count = 0; this.rubble.frustumCulled = false; this.rubble.castShadow = true; this.rubble.receiveShadow = true;
    scene.add(this.rubble);
  }

  // ---------------- faces ----------------
  private style(i: number, f: number): Style | null {
    const id = this.T.face[i * 12 + f * 2]; if (id < 0) return null;
    const v = this.T.face[i * 12 + f * 2 + 1], m = this.meshes[id]; if (!m) return null;
    const g = m.geometry, c = g.attributes.color.array as Float32Array, mi = g.attributes.mi.array as Float32Array;
    return { mi: Math.round(mi[v]), layer: m.userData.layer ?? 0, chunk: m.userData.chunk ?? 0, bot: [c[v * 3], c[v * 3 + 1], c[v * 3 + 2]], top: [c[(v + 2) * 3], c[(v + 2) * 3 + 1], c[(v + 2) * 3 + 2]] };
  }
  /** Collapse a drawn face to a point (its six vertices onto the first). */
  private kill(i: number, f: number) {
    const id = this.T.face[i * 12 + f * 2]; if (id < 0) return;
    const v = this.T.face[i * 12 + f * 2 + 1], m = this.meshes[id]; if (!m) return;
    const a = m.geometry.attributes.position as THREE.BufferAttribute, p = a.array as Float32Array;
    for (let k = 1; k < 6; k++) { p[(v + k) * 3] = p[v * 3]; p[(v + k) * 3 + 1] = p[v * 3 + 1]; p[(v + k) * 3 + 2] = p[v * 3 + 2]; }
    const dm = this.dynOf.get(id);
    if (dm) this.touchedDyn.add(dm);
    else { a.addUpdateRange(v * 3, 18); this.touched.add(a); }
  }
  private dynFor(chunk: number, layer: number): { dm: DynMesh; id: number } {
    const key = `${chunk}|${layer}`;
    let d = this.dyn.get(key);
    if (!d || d.dm.full) {
      const dm = new DynMesh(layer === 1 ? this.W.mats.indoor : this.W.mats.outdoor, layer);
      dm.mesh.userData.chunk = chunk;
      const id = this.meshes.length; this.meshes.push(dm.mesh); this.dynOf.set(id, dm);
      const cx = ((chunk & 0xff) * 128) - 2048 + 64, cz = (((chunk >> 8) & 0xff) * 128) - 2048 + 64;
      this.W.addCity(dm.mesh, layer, cx, cz);
      d = { dm, id }; this.dyn.set(key, d);
    }
    return d;
  }
  private emit(pi: number, f: number, min: number[], max: number[], st: Style, bottomAt: boolean, mi = st.mi, tint?: V3) {
    const d = this.dynFor(st.chunk, st.layer);
    const top = tint ?? st.top, bot = tint ?? (bottomAt ? st.bot : st.top);
    const v0 = d.dm.quad(facePts(min, max, f), NORMALS[f], st, bot, top, mi);
    this.T.face[pi * 12 + f * 2] = d.id; this.T.face[pi * 12 + f * 2 + 1] = v0;
    this.touchedDyn.add(d.dm);
  }

  // ---------------- pieces ----------------
  private bounds(i: number): [number[], number[]] {
    const b = this.T.box, o = i * 6;
    return [[b[o], b[o + 1], b[o + 2]], [b[o + 3], b[o + 4], b[o + 5]]];
  }
  private surf(i: number): Surface {
    const c = this.T.col[i];
    if (c >= 0) { const s = this.P.surfOf(c); if (s) return s; }
    for (let f = 0; f < 6; f++) { const st = this.style(i, f); if (st) return MATS[MAT_IDS[st.mi]].surf; }
    return 'masonry';
  }
  /** Bounds of the pieces removed by the current blast (props above them may have lost their footing). */
  private gone: [number[], number[]][] = [];
  private remove(i: number) {
    if (this.T.dead[i]) return;
    this.T.dead[i] = 1; this.removed++;
    this.gone.push(this.bounds(i));
    for (let f = 0; f < 6; f++) this.kill(i, f);
    if (this.T.col[i] >= 0) this.P.removeBox(this.T.col[i]);
  }

  /**
   * Cut openings (in the piece's plane: `a` along it, `b` up it, or x/z for slabs) through piece i. Returns the new
   * pieces, or null when no opening touches it.
   */
  private cut(i: number, t: number, ops: Op[]): number[] | null {
    const [min, max] = this.bounds(i);
    const a = t === 1 ? 0 : t === 0 ? 2 : 0, b = t === 1 ? 2 : 1;
    const A0 = min[a], A1 = max[a], B0 = min[b], B1 = max[b];
    const hit = ops.filter((o) => o.a1 > A0 + 0.01 && o.a0 < A1 - 0.01 && o.b1 > B0 + 0.01 && o.b0 < B1 - 0.01);
    if (!hit.length) return null;
    const styles = [0, 1, 2, 3, 4, 5].map((f) => this.style(i, f));
    // The broken edges: the look of the outer (non-interior) broad face, with the masonry core exposed.
    const broad = [styles[t * 2], styles[t * 2 + 1]], any = styles.find((s) => s) ?? null;
    const ext = broad.find((s) => s && s.layer !== 1) ?? broad[0] ?? broad[1] ?? any;
    const surf = this.surf(i);
    const coreMi = surf === 'masonry' ? MAT_INDEX.damaged : surf === 'concrete' ? MAT_INDEX.cracked : ext?.mi ?? MAT_INDEX.damaged;
    const coreTint: V3 | null = ext ? [ext.top[0] * 0.92, ext.top[1] * 0.9, ext.top[2] * 0.88] : null;
    // Column decomposition (as building.ts wall()): cut positions along a, solid runs along b in each column.
    const cuts = new Set<number>([A0, A1]);
    for (const o of hit) { cuts.add(Math.max(A0, Math.min(A1, o.a0))); cuts.add(Math.max(A0, Math.min(A1, o.a1))); }
    const xs = [...cuts].sort((p, q) => p - q), rects: [number, number, number, number][] = [];
    for (let k = 0; k < xs.length - 1; k++) {
      const s0 = xs[k], s1 = xs[k + 1]; if (s1 - s0 < 0.01) continue;
      const mid = (s0 + s1) / 2, col = hit.filter((o) => o.a0 <= mid && o.a1 >= mid).sort((p, q) => p.b0 - q.b0);
      let y = B0;
      for (const o of col) { if (o.b0 > y) rects.push([s0, s1, y, o.b0]); y = Math.max(y, o.b1); }
      if (B1 > y) rects.push([s0, s1, y, B1]);
    }
    // Merge vertically adjacent column runs with the same b span (fewer, larger remnants).
    rects.sort((p, q) => p[2] - q[2] || p[3] - q[3] || p[0] - q[0]);
    const merged: [number, number, number, number][] = [];
    for (const r of rects) { const l = merged[merged.length - 1]; if (l && l[2] === r[2] && l[3] === r[3] && Math.abs(l[1] - r[0]) < 1e-5) l[1] = r[1]; else merged.push([...r]); }
    this.remove(i);
    const out: number[] = [];
    for (const [s0, s1, y0, y1] of merged) {
      // Small chips go with the rubble; long thin strips stay (dropping them opened slits up the whole wall).
      if (Math.min(s1 - s0, y1 - y0) < 0.1 && Math.max(s1 - s0, y1 - y0) < 0.6) continue;
      const nmin = [...min], nmax = [...max];
      nmin[a] = s0; nmax[a] = s1; nmin[b] = y0; nmax[b] = y1;
      const col = this.T.col[i] >= 0 ? this.P.addBox(nmin, nmax, this.T.col[i]) : -1;
      const pi = this.T.add(nmin, nmax, col);
      for (let f = 0; f < 6; f++) {
        const ax = f >> 1, side = f & 1;
        const plane = side ? nmax[ax] : nmin[ax], orig = side ? max[ax] : min[ax];
        const st = styles[f];
        if (ax === t || Math.abs(plane - orig) < 1e-4) { if (st) this.emit(pi, f, nmin, nmax, st, Math.abs(nmin[1] - min[1]) < 1e-4); }
        else if (ext) this.emit(pi, f, nmin, nmax, ext, false, coreMi, coreTint!);
      }
      out.push(pi);
    }
    return out;
  }

  /**
   * A blast at p. `breach`: hole radius in brick/plaster (concrete ×0.75, earth ×0.6); `light`: radius within which
   * sheet metal, wood and glass are torn out. `power` scales the rubble's throw.
   */
  blast(p: V3, breach: number, light: number, power: number): BlastResult {
    const res: BlastResult = { holes: [], volume: 0, fell: 0, props: 0 };
    const reach = Math.max(breach, light, breach * 1.8);
    if (reach <= 0.05) return res;
    const T = this.T, rnd = Math.random, t0 = performance.now();
    this.gone.length = 0;
    // Jag shape shared by every piece of this blast (coplanar pieces of one wall line up).
    const j = [rnd(), rnd(), rnd(), rnd()];
    const cand: number[] = [];
    for (let i = 0; i < T.n; i++) {
      if (T.dead[i]) continue;
      const o = i * 6, b = T.box;
      const dx = Math.max(b[o] - p[0], 0, p[0] - b[o + 3]), dy = Math.max(b[o + 1] - p[1], 0, p[1] - b[o + 4]), dz = Math.max(b[o + 2] - p[2], 0, p[2] - b[o + 5]);
      if (dx * dx + dy * dy + dz * dz < reach * reach) cand.push(i);
    }
    const fresh: number[] = [], t1 = performance.now();
    for (const i of cand) {
      const [min, max] = this.bounds(i), ext = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
      const t = ext[0] <= ext[1] && ext[0] <= ext[2] ? 0 : ext[2] <= ext[1] ? 2 : 1;
      if (ext[t] > 0.75) continue; // foundations, thick plinths
      const cx = (min[0] + max[0]) / 2, cz = (min[2] + max[2]) / 2;
      if (max[1] < groundH(cx, cz) + 0.3) continue; // ground slabs, kerbs: the ground itself
      const s = this.surf(i);
      const R = s === 'metal' || s === 'wood' || s === 'glass' ? Math.max(light, breach * 1.8) : s === 'concrete' ? breach * 0.75 : s === 'masonry' ? breach : breach * 0.6;
      const qx = Math.max(min[0], Math.min(max[0], p[0])), qy = Math.max(min[1], Math.min(max[1], p[1])), qz = Math.max(min[2], Math.min(max[2], p[2]));
      const d = Math.hypot(qx - p[0], qy - p[1], qz - p[2]);
      if (d >= R) continue;
      const r = Math.sqrt(R * R - d * d); if (r < 0.12) continue;
      const a = t === 1 ? 0 : t === 0 ? 2 : 0, bb = t === 1 ? 2 : 1, pa = p[a], pb = p[bb];
      // A ragged hole: three overlapping rectangles (wide, tall and the core) plus a bite out of one edge.
      const ops: Op[] = [
        { a0: pa - r * 0.8, a1: pa + r * 0.8, b0: pb - r * 0.75, b1: pb + r * 0.75 },
        { a0: pa - r * (0.45 + 0.25 * j[0]), a1: pa + r * (0.4 + 0.3 * j[1]), b0: pb - r * 1.02, b1: pb + r * (0.9 + 0.12 * j[2]) },
        { a0: pa - r * 1.02, a1: pa + r * (0.85 + 0.15 * j[3]), b0: pb - r * (0.25 + 0.3 * j[1]), b1: pb + r * (0.3 + 0.25 * j[0]) },
        { a0: pa + r * (0.3 * j[2] - 0.2), a1: pa + r * (0.55 + 0.3 * j[3]), b0: pb + r * 0.6, b1: pb + r * (1.0 + 0.15 * j[0]) },
        { a0: pa - r * (0.95 + 0.2 * j[1]), a1: pa - r * (0.5 - 0.2 * j[2]), b0: pb - r * (0.9 + 0.1 * j[3]), b1: pb - r * 0.4 },
        { a0: pa + r * 0.6, a1: pa + r * (1.0 + 0.2 * j[0]), b0: pb + r * (0.1 - 0.3 * j[2]), b1: pb + r * (0.5 + 0.2 * j[1]) },
      ];
      const vol0 = ext[0] * ext[1] * ext[2];
      const out = this.cut(i, t, ops);
      if (!out) continue;
      let left = 0; for (const k of out) { const [a2, b2] = this.bounds(k); left += (b2[0] - a2[0]) * (b2[1] - a2[1]) * (b2[2] - a2[2]); }
      const gone = Math.max(0, vol0 - left);
      res.volume += gone; fresh.push(...out);
      const n: V3 = [0, 0, 0]; n[t] = p[t] < (min[t] + max[t]) / 2 ? -1 : 1;
      const hp: V3 = [p[0], p[1], p[2]]; hp[t] = n[t] < 0 ? min[t] : max[t];
      if (res.holes.length < 6) res.holes.push({ p: hp, n, r, surf: s });
      this.throwRubble(min, max, t, p, r, gone, power, out.length ? this.style(out[0], t * 2) ?? this.style(out[0], t * 2 + 1) : null, s);
    }
    const t2 = performance.now();
    if (fresh.length || res.holes.length) res.fell = this.settle(p, reach + 6, power);
    res.props = this.props(p, light, reach + 6, power);
    if (!fresh.length && !res.holes.length && !res.fell && !res.props) return res;
    const t3 = performance.now();
    this.P.commit();
    const t4 = performance.now();
    this.flush();
    this.prof = [t1 - t0, t2 - t1, t3 - t2, t4 - t3, performance.now() - t4].map((x) => Math.round(x * 10) / 10);
    return res;
  }

  /**
   * Bring down whatever no longer connects to the ground: within the box p ± r, pieces that touch the ground or
   * reach outside the box are anchored; everything joined to an anchor (touching faces) stands; the rest falls.
   */
  private settle(p: V3, r: number, power: number): number {
    const T = this.T, near: number[] = [];
    for (let i = 0; i < T.n; i++) {
      if (T.dead[i]) continue;
      const o = i * 6, b = T.box;
      if (b[o + 3] < p[0] - r || b[o] > p[0] + r || b[o + 5] < p[2] - r || b[o + 2] > p[2] + r) continue;
      near.push(i);
    }
    if (near.length > 2500) return 0;
    const anchored = new Uint8Array(near.length), queue: number[] = [];
    near.forEach((i, k) => {
      const [min, max] = this.bounds(i);
      const out = min[0] < p[0] - r || max[0] > p[0] + r || min[2] < p[2] - r || max[2] > p[2] + r;
      if (out || min[1] <= groundH((min[0] + max[0]) / 2, (min[2] + max[2]) / 2) + 0.05) { anchored[k] = 1; queue.push(k); }
    });
    const bx = near.map((i) => this.bounds(i)), e = 0.03;
    const touch = (a: number, b: number) => bx[a][0][0] <= bx[b][1][0] + e && bx[a][1][0] >= bx[b][0][0] - e && bx[a][0][1] <= bx[b][1][1] + e && bx[a][1][1] >= bx[b][0][1] - e && bx[a][0][2] <= bx[b][1][2] + e && bx[a][1][2] >= bx[b][0][2] - e;
    // 2 m spatial hash (x, y, z) so the flood fill only compares pieces that are close.
    const C = 2, cells = new Map<number, number[]>(), ck = (x: number, y: number, z: number) => ((x + 512) * 1024 + (y + 512)) * 1024 + (z + 512);
    const span = (k: number, f: (c: number) => void) => {
      const [mn, mx] = bx[k];
      for (let x = Math.floor((mn[0] - e) / C); x <= Math.floor((mx[0] + e) / C); x++) for (let y = Math.floor((mn[1] - e) / C); y <= Math.floor((mx[1] + e) / C); y++) for (let z = Math.floor((mn[2] - e) / C); z <= Math.floor((mx[2] + e) / C); z++) f(ck(x, y, z));
    };
    near.forEach((_, k) => span(k, (c) => { let l = cells.get(c); if (!l) cells.set(c, l = []); l.push(k); }));
    while (queue.length) {
      const k = queue.pop()!;
      span(k, (c) => { for (const m of cells.get(c)!) if (!anchored[m] && touch(k, m)) { anchored[m] = 1; queue.push(m); } });
    }
    let fell = 0;
    near.forEach((i, k) => {
      if (anchored[k]) return;
      const [min, max] = bx[k], st = this.style(i, 0) ?? this.style(i, 1) ?? this.style(i, 4) ?? this.style(i, 5) ?? this.style(i, 3);
      const vol = (max[0] - min[0]) * (max[1] - min[1]) * (max[2] - min[2]);
      this.remove(i); fell++;
      this.throwRubble(min, max, -1, p, 0, vol, power * 0.2, st, this.surf(i));
    });
    return fell;
  }

  // ---------------- crushing (vehicles) ----------------
  private gkey(ix: number, iz: number) { return (ix + 512) * 1024 + (iz + 512); }
  private gridAdd(gr: Map<number, number[]>, i: number, x0: number, z0: number, x1: number, z1: number) {
    for (let ix = Math.floor(x0 / 8); ix <= Math.floor(x1 / 8); ix++) for (let iz = Math.floor(z0 / 8); iz <= Math.floor(z1 / 8); iz++) { const k = this.gkey(ix, iz); const l = gr.get(k); if (l) l.push(i); else gr.set(k, [i]); }
  }
  private near(gr: Map<number, number[]>, x0: number, z0: number, x1: number, z1: number): Set<number> {
    const out = new Set<number>();
    for (let ix = Math.floor(x0 / 8); ix <= Math.floor(x1 / 8); ix++) for (let iz = Math.floor(z0 / 8); iz <= Math.floor(z1 / 8); iz++) for (const i of gr.get(this.gkey(ix, iz)) ?? []) out.add(i);
    return out;
  }
  /**
   * A vehicle pushes through the box centred on (cx, cz) with half extents (hx along its right, hz along `dir`) and
   * heading `dir` (unit, horizontal): crushable props in it are knocked down, thin low walls (compound walls, fences;
   * never a building's) collapse as rubble. Returns how much was crushed.
   */
  crush(cx: number, cz: number, hx: number, hz: number, dir: [number, number], y0: number, y1: number): number {
    const T = this.T, P = this.P, list = this.city.props;
    if (!this.propGrid) { this.propGrid = new Map(); list.forEach((q, i) => { if (CRUSH.test(q.id)) this.gridAdd(this.propGrid!, i, q.x, q.z, q.x, q.z); }); }
    if (!this.pieceGrid) { this.pieceGrid = new Map(); for (let i = 0; i < T.n; i++) { const o = i * 6; this.gridAdd(this.pieceGrid, i, T.box[o], T.box[o + 2], T.box[o + 3], T.box[o + 5]); } }
    const r = Math.hypot(hx, hz) + 1, rx = -dir[1], rz = dir[0];
    const inBox = (x: number, z: number, m: number) => { const dx = x - cx, dz = z - cz; return Math.abs(dx * rx + dz * rz) < hx + m && Math.abs(dx * dir[0] + dz * dir[1]) < hz + m; };
    let n = 0;
    for (const pi of this.near(this.propGrid, cx - r, cz - r, cx + r, cz + r)) {
      const q = list[pi];
      if (this.propGone.has(pi) || !inBox(q.x, q.z, 0.3) || q.y > y1 || !this.W.propSlots.has(pi)) continue;
      this.propGone.add(pi); n += q.id.startsWith('tree_euca') || q.id.startsWith('palm') ? 3 : q.id.startsWith('tree_') || FELL.test(q.id) ? 1.5 : 0.5;
      P.removeProp(pi);
      const slots = this.W.propSlots.get(pi)!;
      if (FELL.test(q.id)) {
        // Pushed over forward and to one side (to the side of the hull it was on), clearing the lane behind.
        const side = Math.sign((q.x - cx) * rx + (q.z - cz) * rz) || (Math.random() < 0.5 ? -1 : 1);
        // Nearly square to the line of travel: the crown lands well off the lane, only the bare trunk lies across it.
        const a = Math.atan2(dir[1], dir[0]) + side * (1.3 + Math.random() * 0.27), fx = Math.cos(a), fz = Math.sin(a);
        // Rotating about up × fall-direction tips the top towards the fall direction (away from the vehicle).
        const axis = new THREE.Vector3(fz, 0, -fx).normalize();
        this.falling.push({ slots: slots.map(([im, i]) => { const m = new THREE.Matrix4(); im.getMatrixAt(i, m); return [im, i, m]; }), base: new THREE.Vector3(q.x, q.y, q.z), axis, t: 0 });
        this.g?.audio.play('debris_fall', [q.x, q.y + 1, q.z], { range: 120, gain: 0.5, rate: 0.6 });
      } else {
        for (const [im, i] of slots) { im.setMatrixAt(i, this.zero); im.instanceMatrix.needsUpdate = true; }
        this.throwRubble([q.x - 0.4, q.y, q.z - 0.4], [q.x + 0.4, q.y + 0.8, q.z + 0.4], -1, [q.x - dir[0], q.y, q.z - dir[1]], 0, 0.08, 0.3, null, SOFT.test(q.id) ? 'wood' : 'metal');
      }
    }
    let walls = 0;
    for (const i of this.near(this.pieceGrid, cx - r, cz - r, cx + r, cz + r)) {
      if (T.dead[i]) continue;
      const [mn, mx] = this.bounds(i), ext = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
      if (mx[1] < y0 + 0.3 || mn[1] > y1) continue;
      if (Math.min(ext[0], ext[2]) > 0.45 || ext[1] > 3.4) continue;
      const col = T.col[i]; if (col < 0 || P.tagOf(col) >= 0) continue; // only free-standing walls, never a building
      const s2 = this.surf(i); if (s2 !== 'masonry' && s2 !== 'metal' && s2 !== 'wood') continue;
      // Does the piece reach into the box? (test its centre line at a few points along its length)
      const along = ext[0] > ext[2] ? 0 : 2, L = along === 0 ? ext[0] : ext[2];
      let hit = false;
      for (let k = 0; k <= 8 && !hit; k++) { const t = k / 8, x = along === 0 ? mn[0] + L * t : (mn[0] + mx[0]) / 2, z = along === 2 ? mn[2] + L * t : (mn[2] + mx[2]) / 2; hit = inBox(x, z, 0.2); }
      if (!hit) continue;
      // Knock down the part of the wall in front of the hull (a breach as wide as the vehicle).
      const t = along === 0 ? 2 : 0;
      const ops = [{ a0: (along === 0 ? cx : cz) - hx - 0.6, a1: (along === 0 ? cx : cz) + hx + 0.6, b0: -1e3, b1: 1e3 }];
      const out = this.cutAlong(i, t, ops);
      if (out) { walls++; this.throwRubble(mn, mx, -1, [cx - dir[0] * 3, (mn[1] + mx[1]) / 2, cz - dir[1] * 3], 0, ext[0] * ext[1] * ext[2] * 0.5, 0.5, null, s2); for (const k of out) { const [a, b] = this.bounds(k); this.gridAdd(this.pieceGrid, k, a[0], a[2], b[0], b[2]); } }
    }
    if (walls) { this.settle([cx, y0, cz], 8, 0.3); this.P.commit(); this.flush(); this.g?.audio.play('debris_fall', [cx, y0 + 1, cz], { range: 150, gain: 0.9 }); }
    else if (n) this.P.commit();
    return n + walls;
  }
  /** Cut openings through a vertical piece (thin axis t), opening spans along its length and full height. */
  private cutAlong(i: number, t: number, ops: Op[]): number[] | null { return this.cut(i, t, ops); }

  // ---------------- props ----------------
  /**
   * Props near a blast: small, fragile ones within `light` of it are wrecked, and any prop left standing on nothing
   * (a water tank over a holed roof, furniture over a holed floor, a fan on a fallen ceiling) comes down.
   * Returns how many went.
   */
  private props(p: V3, light: number, r: number, power: number): number {
    const P = this.P, list = this.city.props; let n = 0;
    const solid = (x: number, y: number, z: number) => !!P.boxAt(x, y, z);
    for (let pi = 0; pi < list.length; pi++) {
      const q = list[pi];
      if (Math.abs(q.x - p[0]) > r || Math.abs(q.z - p[2]) > r || this.propGone.has(pi) || ROBUST.test(q.id) || !this.W.propSlots.has(pi)) continue;
      const d = Math.hypot(q.x - p[0], q.y + 0.4 - p[1], q.z - p[2]);
      let gone = d < light * 0.9;
      // Footing: only props over (or hung next to) something this blast removed can have lost it.
      const exposed = !gone && this.gone.some(([a, b]) => q.x > a[0] - 0.6 && q.x < b[0] + 0.6 && q.z > a[2] - 0.6 && q.z < b[2] + 0.6 && q.y > a[1] - 0.5 && q.y < b[1] + 4);
      if (exposed && !q.ground && q.y > groundH(q.x, q.z) + 0.3) {
        const y = q.y;
        const held = HUNG.test(q.id)
          ? [[0.35, 0], [-0.35, 0], [0, 0.35], [0, -0.35]].some(([dx, dz]) => solid(q.x + dx, y + 0.3, q.z + dz)) || !!P.castRay([q.x, y + 0.1, q.z], [0, 1, 0], 3.5)
          : [[0, 0], [0.25, 0], [-0.25, 0], [0, 0.25], [0, -0.25]].some(([dx, dz]) => solid(q.x + dx, y - 0.08, q.z + dz));
        gone = !held;
      }
      if (!gone) continue;
      this.propGone.add(pi); n++;
      for (const [im, i] of this.W.propSlots.get(pi)!) { im.setMatrixAt(i, this.zero); im.instanceMatrix.needsUpdate = true; }
      P.removeProp(pi);
      const soft = SOFT.test(q.id);
      this.throwRubble([q.x - 0.4, q.y, q.z - 0.4], [q.x + 0.4, q.y + 0.9, q.z + 0.4], -1, p, 0, 0.12, d < light ? power : 0.2, null, soft ? 'wood' : 'metal');
    }
    return n;
  }

  // ---------------- rubble ----------------
  /** Splinters / fragments thrown out of a box (min, max) by a blast at p (doors, other non-city things). */
  debris(min: number[], max: number[], p: V3, power: number, surf: Surface, vol: number) {
    this.throwRubble(min, max, -1, p, 0, vol, power, null, surf);
  }
  private throwRubble(min: number[], max: number[], t: number, p: V3, r: number, vol: number, power: number, st: Style | null, surf: Surface) {
    if (vol <= 0.002) return;
    const n = Math.max(3, Math.min(t < 0 ? 14 : 26, Math.round(vol / 0.012)));
    const base: V3 = st ? [Math.min(1, st.top[0] * 1.15), Math.min(1, st.top[1] * 1.15), Math.min(1, st.top[2] * 1.15)] : [0.8, 0.75, 0.66];
    const light = surf === 'metal' || surf === 'wood';
    const tintOf = (): V3 => { const k = 0.75 + Math.random() * 0.25; return surf === 'wood' ? [0.52 * k, 0.4 * k, 0.27 * k] : light ? [0.45 * k, 0.43 * k, 0.4 * k] : [base[0] * k, base[1] * k, base[2] * k]; };
    const size = Math.cbrt(vol / n) * 0.95;
    for (let k = 0; k < n; k++) {
      const c: V3 = [0, 0, 0];
      for (let a = 0; a < 3; a++) {
        const lo = t >= 0 && a !== t ? Math.max(min[a], p[a] - r * 0.8) : min[a], hi = t >= 0 && a !== t ? Math.min(max[a], p[a] + r * 0.8) : max[a];
        c[a] = lo + Math.random() * Math.max(0, hi - lo);
      }
      // Sizes spread widely (a few big lumps, many fist-sized pieces).
      const g = Math.pow(Math.random(), 1.6) * 1.5 + 0.35;
      const s = new THREE.Vector3(size * g * (0.7 + Math.random() * 0.6), size * g * (0.45 + Math.random() * 0.45), size * g * (0.7 + Math.random() * 0.6)).clampScalar(0.05, light ? 0.5 : 0.38);
      if (light) s.y = Math.min(s.y, 0.03);
      const d = [c[0] - p[0], c[1] - p[1], c[2] - p[2]], L = Math.hypot(d[0], d[1], d[2]) || 1;
      const sp = power * (2 + Math.random() * 6) / Math.max(1, L * 0.7);
      this.spawn(c, s, tintOf(), [d[0] / L * sp, d[1] / L * sp + 1 + Math.random() * 2.5 * power, d[2] / L * sp]);
    }
  }

  /** Rubble waiting to be created (a few per frame: making 50 bodies at once stalled the blast frame). */
  private pending: [V3, THREE.Vector3, V3, V3][] = [];
  private spawn(c: V3, s: THREE.Vector3, tint: V3, vel: V3) { this.pending.push([c, s, tint, vel]); }
  private make(c: V3, s: THREE.Vector3, tint: V3, vel: V3) {
    const i = this.rubbleN % MAX_RUBBLE; this.rubbleN++;
    const prev = this.active.findIndex((a) => a.i === i);
    if (prev >= 0) { this.P.world.removeRigidBody(this.active[prev].body); this.active.splice(prev, 1); }
    if (this.active.length >= MAX_ACTIVE) { const o = this.active.shift()!; this.P.world.removeRigidBody(o.body); }
    const R = RAPIER, w = this.P.world;
    const body = w.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(c[0], c[1], c[2]).setLinvel(vel[0], vel[1], vel[2])
      .setAngvel({ x: (Math.random() - 0.5) * 12, y: (Math.random() - 0.5) * 12, z: (Math.random() - 0.5) * 12 }).setLinearDamping(0.05).setAngularDamping(0.4).setCcdEnabled(true));
    w.createCollider(R.ColliderDesc.cuboid(s.x * 0.45, s.y * 0.45, s.z * 0.45).setDensity(1900).setFriction(0.9).setRestitution(0.1).setCollisionGroups(groups(G_DEBRIS, G_WORLD | G_VEH | G_DEBRIS)), body);
    this.active.push({ body, i, t: 0, s });
    this.rubble.setColorAt(i, new THREE.Color(tint[0], tint[1], tint[2]));
    this.rubble.count = Math.min(MAX_RUBBLE, this.rubbleN);
    this.place(i, c, { x: 0, y: 0, z: 0, w: 1 }, s);
    this.rubble.instanceColor!.needsUpdate = true;
  }
  private place(i: number, p: { x: number; y: number; z: number } | V3, r: { x: number; y: number; z: number; w: number }, s: THREE.Vector3) {
    if (Array.isArray(p)) this.v.set(p[0], p[1], p[2]); else this.v.set(p.x, p.y, p.z);
    this.q.set(r.x, r.y, r.z, r.w);
    this.m4.compose(this.v, this.q, s);
    this.rubble.setMatrixAt(i, this.m4);
    this.rubble.instanceMatrix.needsUpdate = true;
  }

  private flush() {
    for (const a of this.touched) a.needsUpdate = true;
    this.touched.clear();
    for (const d of this.touchedDyn) d.flush();
    this.touchedDyn.clear();
  }

  /** Per frame: rubble follows its bodies; settled (or old) chunks are frozen in place; felled trees topple. */
  update(dt: number) {
    for (let k = this.falling.length - 1; k >= 0; k--) {
      const f = this.falling[k]; f.t += dt;
      const ang = Math.min(1.53, f.t * f.t * 7 + f.t * 1.2); // down in ~0.4 s
      const R = new THREE.Matrix4().makeTranslation(f.base.x, f.base.y, f.base.z).multiply(new THREE.Matrix4().makeRotationAxis(f.axis, ang)).multiply(new THREE.Matrix4().makeTranslation(-f.base.x, -f.base.y, -f.base.z));
      for (const [im, i, m0] of f.slots) { im.setMatrixAt(i, this.m4.copy(R).multiply(m0)); im.instanceMatrix.needsUpdate = true; }
      if (ang >= 1.53) this.falling.splice(k, 1);
    }
    for (let k = 0; k < 14 && this.pending.length; k++) this.make(...this.pending.shift()!);
    for (let k = this.active.length - 1; k >= 0; k--) {
      const a = this.active[k]; a.t += dt;
      const tr = a.body.translation();
      this.place(a.i, tr, a.body.rotation(), a.s);
      if ((a.t > 1 && a.body.isSleeping()) || a.t > 8 || tr.y < -50) { this.P.world.removeRigidBody(a.body); this.active.splice(k, 1); }
    }
  }
}

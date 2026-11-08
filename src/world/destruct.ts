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
export interface BlastResult { holes: { p: V3; n: V3; r: number; surf: Surface }[]; volume: number; fell: number; /** Props wrecked or brought down. */ props: number; /** Bounds of the pieces removed (bullet holes on them go too). */ gone: [number[], number[]][] }

const DYN_CAP = 6 * 700;
/** Props a blast never takes away (the cache crates are the insurgency objective: insurgency.ts destroys them). */
const ROBUST = /^(cache_crate|market_stall|burnt_tyre|hesco|t_wall|jersey|sandbag|conex|veh:|rubble|debris_|palm|dead_tree|minaret|dome_|arch_gate|fountain|guard_tower|power_pole|street_light|floodlight|flagpole|tent_|camo_net|wire_|billboard|transformer|kerb_barrier|grass|shrub|bush|reeds)/;
/** Props fixed to a wall or a ceiling rather than standing on a floor. */
const HUNG = /^(ceiling_fan|bulb_hanging|picture_frame|curtain_|wall_shelf|bedsheet_window|sandbag_window|ac_split|ac_window|sign_shop|awning_shop|shop_shutter|clothesline)/;
/** What a tank drives over: trees and palms topple; the rest is flattened. Buildings, HESCO, wrecks are not. */
const CRUSH = /^(tree_|palm_|dead_tree|shrub|bush|reeds|grass|cart_|market_stall|plastic_|table_|trash|tyres|oil_drum|gas_cylinder|crate|pallet|cardboard|street_light|power_pole|sign_shop|kerb_barrier|generator|water_tank)/;
const FELL = /^(tree_|palm_|dead_tree|street_light|power_pole)/;
const SOFT = /^(floor_cushions|sofa_old|armchair|rug_|coffee_table|side_table|curtain_|bed_double|mattress_|wardrobe|dresser|clothes_pile|prayer_mat|kitchen_|table_|shoes_rack|wall_shelf|picture_frame|broken_furniture|cardboard|pallet|crate_|cart_|market_stall|plastic_|bedsheet|clothesline|trash)/;
const MAX_RUBBLE = 2400, MAX_ACTIVE = 140;
/** A fired clay brick (240 × 115 × 71 mm) and the plaster / mortar colours of broken walls. */
const BRICK: [number, number, number] = [0.24, 0.071, 0.115];

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

/**
 * Openings (in a piece's plane) for a ragged breach of radius r centred on (pa, pb). Masonry breaks along its courses,
 * but unevenly: course heights vary (a brick, a block, two courses together), the left and right edges wander
 * independently (each a random walk, so neighbouring steps are related but never repeat), notches of a brick or so
 * are knocked out of the edge, and in a wall the top closes in a rough corbelled point. `seed` is per blast, so
 * every piece of one wall gets the same outline.
 */
function holeOps(pa: number, pb: number, r: number, wall: boolean, seed: number): Op[] {
  let s0 = (Math.floor(seed * 2147483646) + 1) | 0;
  const rnd = () => ((s0 = Math.imul(s0 ^ (s0 >>> 15), 0x2c1b3c6d) + 0x9e3779b9 | 0), ((s0 >>> 0) % 100000) / 100000);
  const ops: Op[] = [], base = Math.max(0.1, Math.min(0.22, r / 5));
  const bot = -1.0, top = wall ? 1.25 + rnd() * 0.3 : 1.0, mid = 0.2 + rnd() * 0.25;
  let u = bot, wl = rnd(), wr = rnd(), ol = 0, or = 0;
  while (u < top) {
    const h = Math.max(0.09, base * (rnd() < 0.2 ? 1.8 + rnd() * 0.6 : 0.6 + rnd() * 0.8)) / r;
    const u0 = u, u1 = Math.min(top, u + h), um = (u0 + u1) / 2; u = u1;
    const prof = !wall || um <= mid ? Math.sqrt(Math.max(0, 1 - um * um)) : Math.sqrt(1 - mid * mid) * Math.max(0, (top - um) / (top - mid));
    // Random walks for each edge: width factor and a drift.
    wl = wl * 0.55 + rnd() * 0.45; wr = wr * 0.55 + rnd() * 0.45;
    ol = Math.max(-0.35, Math.min(0.35, ol * 0.7 + (rnd() - 0.5) * 0.3)); or = Math.max(-0.35, Math.min(0.35, or * 0.7 + (rnd() - 0.5) * 0.3));
    const hl = prof * (0.55 + 0.75 * wl) + ol, hr = prof * (0.55 + 0.75 * wr) + or;
    if (hl + hr < 0.15) continue;
    const a0 = pa - r * hl, a1 = pa + r * hr, b0 = pb + u0 * r, b1 = pb + u1 * r;
    ops.push({ a0, a1, b0, b1 });
    // Notches out of either edge: the whole course (a part-height notch left thin slats with gaps between them),
    // a brick or two long.
    for (const left of [true, false]) {
      if (rnd() > 0.4) continue;
      const L = 0.1 + rnd() * 0.28;
      ops.push(left ? { a0: a0 - L, a1: a0 + 0.05, b0, b1 } : { a0: a1 - 0.05, a1: a1 + L, b0, b1 });
    }
  }
  return ops;
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
  /** Pieces below this index are the generator's (whole walls, slabs); the rest are fragments left by cuts. */
  private n0 = 0;
  private meshes: THREE.Mesh[];
  private dyn = new Map<string, { dm: DynMesh; id: number }>();
  private touched = new Set<THREE.BufferAttribute>();
  private touchedDyn = new Set<DynMesh>();
  private dynOf = new Map<number, DynMesh>();
  // Rubble.
  /** Rubble meshes: 0 lumps (plaster, concrete), 1 bricks. */
  private rubbles: THREE.InstancedMesh[] = [];
  private rubbleN = [0, 0];
  private active: { body: RAPIER.RigidBody; k: number; i: number; t: number; s: THREE.Vector3 }[] = [];
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
  /** Seed of the last blast's outline (multiplayer: sent with the blast). */ lastSeed = 0;
  prof = [0, 0, 0, 0, 0];

  constructor(private city: City, private P: Physics, private W: WorldView, scene: THREE.Scene) {
    this.T = city.sink.pieces;
    this.n0 = this.T.n;
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
    const brick = new THREE.BoxGeometry(1, 1, 1);
    for (const geo of [box, brick]) {
      const im = new THREE.InstancedMesh(geo, mat, MAX_RUBBLE);
      im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_RUBBLE * 3), 3);
      im.count = 0; im.frustumCulled = false; im.castShadow = true; im.receiveShadow = true;
      scene.add(im); this.rubbles.push(im);
    }
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
    const ex = this.extra.get(i * 6 + f);
    if (ex) { this.extra.delete(i * 6 + f); for (const [id, v] of ex) this.killQuad(id, v); }
    const id = this.T.face[i * 12 + f * 2]; if (id < 0) return;
    this.killQuad(id, this.T.face[i * 12 + f * 2 + 1]);
  }
  /** Extra quads of a fragment's cut edge drawn in several stretches (see cut). */
  private extra = new Map<number, [number, number][]>();
  private killQuad(id: number, v: number) {
    const m = this.meshes[id]; if (!m) return;
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
  /** `yr`: the original face's height range: the fragment keeps that face's baked bottom-to-top shading. */
  private emit(pi: number, f: number, min: number[], max: number[], st: Style, yr: [number, number] | null, mi = st.mi, tint?: V3) {
    const d = this.dynFor(st.chunk, st.layer);
    const at = (y: number): V3 => { const k = yr && yr[1] - yr[0] > 1e-4 ? Math.max(0, Math.min(1, (y - yr[0]) / (yr[1] - yr[0]))) : 1; return [st.bot[0] + (st.top[0] - st.bot[0]) * k, st.bot[1] + (st.top[1] - st.bot[1]) * k, st.bot[2] + (st.top[2] - st.bot[2]) * k]; };
    const top = tint ?? at(max[1]), bot = tint ?? at(min[1]);
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
  /** Cut edges of fragments not drawn (or drawn only in part) because a neighbouring fragment covered them. */
  private seams = new Map<number, [Style, number, V3]>();
  /** Draw the hidden cut edges whose neighbour has just been removed (pieces in `gone`). */
  private exposeSeams() {
    if (!this.gone.length || !this.seams.size) return;
    const e = 0.02;
    for (const [key, [st, mi, tint]] of this.seams) {
      const pi = Math.floor(key / 6), f = key % 6;
      if (this.T.dead[pi]) { this.seams.delete(key); continue; }
      const [min, max] = this.bounds(pi), ax = f >> 1, v = f & 1 ? max[ax] : min[ax];
      const fmin = [...min], fmax = [...max]; fmin[ax] = fmax[ax] = v;
      const hit = this.gone.some(([g0, g1]) => g0[0] <= fmax[0] + e && g1[0] >= fmin[0] - e && g0[1] <= fmax[1] + e && g1[1] >= fmin[1] - e && g0[2] <= fmax[2] + e && g1[2] >= fmin[2] - e);
      if (!hit) continue;
      this.kill(pi, f);
      this.emit(pi, f, min, max, st, null, mi, tint);
      this.seams.delete(key);
    }
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
    // Decomposition into solid rectangles round the openings. Walls go row by row (bands across the wall, split only
    // where the hole is), so the masonry above and below a breach stays one piece and no long seams run up the wall;
    // floors go column by column. Adjacent runs with the same span are merged.
    const rowMajor = t !== 1;
    // Outside the envelope of the openings the piece stays whole: up to four large pieces round it (no long strips
    // and seams running out from a hole to the edge of a slab or wall). Only the envelope is cut into courses.
    let ea0 = Infinity, ea1 = -Infinity, eb0 = Infinity, eb1 = -Infinity;
    for (const o of hit) { ea0 = Math.min(ea0, o.a0); ea1 = Math.max(ea1, o.a1); eb0 = Math.min(eb0, o.b0); eb1 = Math.max(eb1, o.b1); }
    ea0 = Math.max(A0, ea0); ea1 = Math.min(A1, ea1); eb0 = Math.max(B0, eb0); eb1 = Math.min(B1, eb1);
    const frame: [number, number, number, number][] = [];
    if (eb0 - B0 > 0.01) frame.push([A0, A1, B0, eb0]);
    if (B1 - eb1 > 0.01) frame.push([A0, A1, eb1, B1]);
    if (ea0 - A0 > 0.01) frame.push([A0, ea0, eb0, eb1]);
    if (A1 - ea1 > 0.01) frame.push([ea1, A1, eb0, eb1]);
    const [P0, P1, Q0, Q1] = rowMajor ? [eb0, eb1, ea0, ea1] : [ea0, ea1, eb0, eb1];
    const hs = hit.map((o) => (rowMajor ? { p0: o.b0, p1: o.b1, q0: o.a0, q1: o.a1 } : { p0: o.a0, p1: o.a1, q0: o.b0, q1: o.b1 }));
    const cuts = new Set<number>([P0, P1]);
    for (const o of hs) { cuts.add(Math.max(P0, Math.min(P1, o.p0))); cuts.add(Math.max(P0, Math.min(P1, o.p1))); }
    // No slice thinner than 6 cm: such a cut is merged into its neighbour (thin slats left standing in a breach
    // read as shelves; dropped, they opened slits).
    const xs = [...cuts].sort((p, q) => p - q), runs: [number, number, number, number][] = [];
    for (let k = 1; k < xs.length - 1;) { if (xs[k] - xs[k - 1] < 0.06 || xs[k + 1] - xs[k] < 0.06) xs.splice(k, 1); else k++; }
    for (let k = 0; k < xs.length - 1; k++) {
      const s0 = xs[k], s1 = xs[k + 1]; if (s1 - s0 < 0.01) continue;
      const mid = (s0 + s1) / 2, col = hs.filter((o) => o.p0 <= mid && o.p1 >= mid).sort((p, q) => p.q0 - q.q0);
      let y = Q0;
      // Material between two openings narrower than 6 cm goes with them; against the envelope's edge it stays.
      for (const o of col) { if (o.q0 > y && (o.q0 - y >= 0.06 || y === Q0)) runs.push([s0, s1, y, o.q0]); y = Math.max(y, o.q1); }
      if (Q1 > y) runs.push([s0, s1, y, Q1]);
    }
    runs.sort((p, q) => p[2] - q[2] || p[3] - q[3] || p[0] - q[0]);
    const mergedPQ: [number, number, number, number][] = [];
    for (const r of runs) { const l = mergedPQ[mergedPQ.length - 1]; if (l && Math.abs(l[2] - r[2]) < 1e-5 && Math.abs(l[3] - r[3]) < 1e-5 && Math.abs(l[1] - r[0]) < 1e-5) l[1] = r[1]; else mergedPQ.push([...r]); }
    // Back to (a0, a1, b0, b1).
    const merged = [...frame, ...mergedPQ.map(([p0, p1, q0, q1]) => (rowMajor ? [q0, q1, p0, p1] : [p0, p1, q0, q1]) as [number, number, number, number])];
    this.remove(i);
    const out: number[] = [];
    // Small chips go with the rubble; long thin strips stay (dropping them opened slits up the whole wall).
    const kept = merged.filter(([s0, s1, y0, y1]) => !(Math.min(s1 - s0, y1 - y0) < 0.1 && Math.max(s1 - s0, y1 - y0) < 0.6));
    /**
     * The part of a fragment's cut edge (in-plane axis 0 = a, 1 = b; side 0 low / 1 high) that no other fragment
     * covers: [] when fully covered (a seam inside the wall: drawing it showed as dashed lines on the wall face),
     * else the uncovered intervals along the other in-plane axis.
     */
    const open = (k: number, ia: number, side: number): [number, number][] => {
      const R = kept[k], v = R[ia * 2 + side], io = 1 - ia, o0 = R[io * 2], o1 = R[io * 2 + 1];
      const cov = kept.filter((K, m) => m !== k && Math.abs(K[ia * 2 + 1 - side] - v) < 1e-5 && K[io * 2] < o1 && K[io * 2 + 1] > o0)
        .map((K) => [Math.max(o0, K[io * 2]), Math.min(o1, K[io * 2 + 1])]).sort((x, y) => x[0] - y[0]);
      const gaps: [number, number][] = []; let c = o0;
      for (const [c0, c1] of cov) { if (c0 > c + 1e-4) gaps.push([c, c0]); c = Math.max(c, c1); }
      if (o1 > c + 1e-4) gaps.push([c, o1]);
      return gaps;
    };
    for (const [k, [s0, s1, y0, y1]] of kept.entries()) {
      const nmin = [...min], nmax = [...max];
      nmin[a] = s0; nmax[a] = s1; nmin[b] = y0; nmax[b] = y1;
      const col = this.T.col[i] >= 0 ? this.P.addBox(nmin, nmax, this.T.col[i]) : -1;
      const pi = this.T.add(nmin, nmax, col);
      for (let f = 0; f < 6; f++) {
        const ax = f >> 1, side = f & 1;
        const plane = side ? nmax[ax] : nmin[ax], orig = side ? max[ax] : min[ax];
        const st = styles[f];
        if (ax === t || Math.abs(plane - orig) < 1e-4) { if (st) this.emit(pi, f, nmin, nmax, st, [min[1], max[1]]); continue; }
        if (!ext) continue;
        const ia = ax === a ? 0 : 1, gaps = open(k, ia, side);
        if (gaps.length === 1 && Math.abs(gaps[0][0] - (ia ? s0 : y0)) + Math.abs(gaps[0][1] - (ia ? s1 : y1)) < 1e-4) { this.emit(pi, f, nmin, nmax, ext, null, coreMi, coreTint!); continue; }
        // Covered (wholly, or but for one stretch): drawn later if the neighbour goes (exposeSeams).
        this.seams.set(pi * 6 + f, [ext, coreMi, coreTint!]);
        // The uncovered stretches only (a covered part drawn shows through the wall face as a dashed line). The first
        // quad is the face's record; any others are kept in `extra` so the face can still be removed whole.
        const oa = ia ? a : b, F = pi * 12 + f * 2, more: [number, number][] = [];
        let first: [number, number] | null = null;
        for (const [g0, g1] of gaps) {
          const m0 = [...nmin], m1 = [...nmax]; m0[oa] = g0; m1[oa] = g1;
          this.emit(pi, f, m0, m1, ext, null, coreMi, coreTint!);
          const ref: [number, number] = [this.T.face[F], this.T.face[F + 1]];
          if (first) more.push(ref); else first = ref;
        }
        if (first) { this.T.face[F] = first[0]; this.T.face[F + 1] = first[1]; }
        if (more.length) this.extra.set(pi * 6 + f, more);
      }
      out.push(pi);
    }
    return out;
  }

  /**
   * A blast at p. `breach`: hole radius in brick/plaster (concrete ×0.75, earth ×0.6); `light`: radius within which
   * sheet metal, wood and glass are torn out. `power` scales the rubble's throw.
   */
  /** `seed` (0..1): the ragged outline's random seed — a multiplayer host sends it so every client cuts the same hole. */
  blast(p: V3, breach: number, light: number, power: number, seedIn?: number): BlastResult {
    const res: BlastResult = { holes: [], volume: 0, fell: 0, props: 0, gone: [] };
    const reach = Math.max(breach, light, breach * 1.8);
    if (reach <= 0.05) return res;
    const T = this.T, rnd = Math.random, t0 = performance.now();
    this.gone.length = 0;
    // One ragged outline per blast (pieces of the same wall line up).
    const seed = seedIn ?? rnd();
    this.lastSeed = seed;
    let cling = 0;
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
      // The hole is cut course by course (12–24 cm rows, the height of a brick or block course), each row's width
      // following a ragged circle; in a wall the top closes in a corbelled point (unsupported masonry above a breach
      // falls in a rough inverted V, as real brickwork does). The stepped edges read as broken bricks.
      const ops = holeOps(pa, pb, r, t !== 1, seed);
      const vol0 = ext[0] * ext[1] * ext[2];
      const out = this.cut(i, t, ops);
      if (!out) continue;
      let left = 0; for (const k of out) { const [a2, b2] = this.bounds(k); left += (b2[0] - a2[0]) * (b2[1] - a2[1]) * (b2[2] - a2[2]); }
      const gone = Math.max(0, vol0 - left);
      res.volume += gone; fresh.push(...out);
      const n: V3 = [0, 0, 0]; n[t] = p[t] < (min[t] + max[t]) / 2 ? -1 : 1;
      const hp: V3 = [p[0], p[1], p[2]]; hp[t] = n[t] < 0 ? min[t] : max[t];
      if (res.holes.length < 6) res.holes.push({ p: hp, n, r, surf: s });
      // Broken pieces left lying on the ledges and sill of a wall breach (half bedded in), at odd angles: breaks up
      // the stepped outline. They rest on masonry, so they fall when it goes (settled-rubble checks).
      if (t !== 1 && out.length && s !== 'metal' && s !== 'wood' && s !== 'glass') {
        const st = this.style(out[0], t * 2) ?? this.style(out[0], t * 2 + 1), th = ext[t];
        const tint: V3 = st ? [st.top[0] * 0.95, st.top[1] * 0.93, st.top[2] * 0.9] : [0.7, 0.66, 0.6];
        const solid = (q: V3) => out.some((k) => { const [m0, m1] = this.bounds(k); return q[0] > m0[0] && q[0] < m1[0] && q[1] > m0[1] && q[1] < m1[1] && q[2] > m0[2] && q[2] < m1[2]; });
        for (const o of ops) {
          if (cling >= 16 || rnd() > 0.35) continue;
          const sz = Math.max(0.07, Math.min(0.3, th * (0.6 + rnd() * 0.7)));
          const q: V3 = [0, 0, 0];
          q[a] = o.a0 + (o.a1 - o.a0) * rnd(); q[t] = (min[t] + max[t]) / 2 + (rnd() - 0.5) * th * 0.5; q[bb] = o.b0 - 0.04;
          if (!solid(q)) continue; // nothing under this stretch of the opening
          q[bb] = o.b0 + sz * 0.22;
          if (solid(q)) continue; // inside the next course: not a ledge
          const kv = 0.85 + rnd() * 0.2;
          this.cling(q, new THREE.Vector3(sz * (0.8 + rnd() * 0.5), sz * (0.55 + rnd() * 0.3), sz * (0.8 + rnd() * 0.5)), [tint[0] * kv, tint[1] * kv, tint[2] * kv]);
          cling++;
        }
      }
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
    this.exposeSeams();
    // Settled rubble that lay on a floor or ledge now gone falls again.
    this.wakeFrozen(p, reach + 6);
    res.gone = this.gone.slice();
    this.prof = [t1 - t0, t2 - t1, t3 - t2, t4 - t3, performance.now() - t4].map((x) => Math.round(x * 10) / 10);
    return res;
  }

  /**
   * Bring down whatever is no longer held up. Within the box p ± r, pieces on the ground or reaching outside the box
   * are anchors. Support then spreads only through solid pieces (visual-only trims, caps and bands carry nothing):
   *  - the generator's own pieces (whole walls, slabs, lintels) stand if they touch a held piece (their joints are
   *    the builder's: slabs cast into walls, lintels into piers);
   *  - fragments left by cuts must be carried: resting on a held piece below them (real bearing, not a corner), or
   *    bonded at a side face to one (a course running on into sound wall), with a short reach from the nearest
   *    bearing (about 1.4 m of masonry, more for a slab). Hanging from what is above does not count, so brick ledges,
   *    strips over a breach and fragments joined by a corner come down.
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
    const REACH = 1.4, held = new Float32Array(near.length).fill(-1), queue: number[] = [];
    const bx = near.map((i) => this.bounds(i)), e = 0.03;
    near.forEach((i, k) => {
      const [min, max] = bx[k];
      const out = min[0] < p[0] - r || max[0] > p[0] + r || min[2] < p[2] - r || max[2] > p[2] + r;
      if (out || min[1] <= groundH((min[0] + max[0]) / 2, (min[2] + max[2]) / 2) + 0.05) { held[k] = REACH; queue.push(k); }
    });
    const ov = (a: number, b: number, ax: number) => Math.min(bx[a][1][ax], bx[b][1][ax]) - Math.max(bx[a][0][ax], bx[b][0][ax]);
    const touch = (a: number, b: number) => ov(a, b, 0) >= -e && ov(a, b, 1) >= -e && ov(a, b, 2) >= -e;
    // 2 m spatial hash (x, y, z) so the fill only compares pieces that are close.
    const C = 2, cells = new Map<number, number[]>(), ck = (x: number, y: number, z: number) => ((x + 512) * 1024 + (y + 512)) * 1024 + (z + 512);
    const span = (k: number, f: (c: number) => void) => {
      const [mn, mx] = bx[k];
      for (let x = Math.floor((mn[0] - e) / C); x <= Math.floor((mx[0] + e) / C); x++) for (let y = Math.floor((mn[1] - e) / C); y <= Math.floor((mx[1] + e) / C); y++) for (let z = Math.floor((mn[2] - e) / C); z <= Math.floor((mx[2] + e) / C); z++) f(ck(x, y, z));
    };
    near.forEach((_, k) => span(k, (c) => { let l = cells.get(c); if (!l) cells.set(c, l = []); l.push(k); }));
    /** How much reach fragment m keeps when held by k (−1: k does not hold it). */
    const carry = (k: number, m: number): number => {
      const [a0, a1] = bx[k], [b0, b1] = bx[m];
      if (near[m] < this.n0) return REACH;
      // Bearing: k's top at m's bottom (or k running up past it), k starting lower, a real footprint overlap.
      const ox = ov(k, m, 0), oz = ov(k, m, 2);
      if (a1[1] >= b0[1] - e && a0[1] < b0[1] - 0.02 && ox > -e && oz > -e && Math.max(ox, oz) >= 0.08) return REACH;
      // Side bond: overlapping most of m's height (a slab fragment: any real edge), face contact of some area.
      const oy = ov(k, m, 1), hm = b1[1] - b0[1];
      if (oy < Math.min(0.5 * hm, 0.1) && !(hm < 0.4 && oy > 0.02)) return -1;
      const ax = ox <= oz ? 0 : 2, other = ax === 0 ? oz : ox;
      if (other < 0.04 || oy * other < 0.006) return -1;
      const slab = hm < 0.4 && (b1[0] - b0[0]) > hm * 2 && (b1[2] - b0[2]) > hm * 2;
      // A thin course of masonry cannot reach out over nothing (a slat bonded only at its end comes down); a deep
      // one corbels about a brick per course height.
      if (!slab && hm < 0.09) return -1;
      const cost = (b1[ax] - b0[ax]) * (slab ? 0.3 : Math.max(1, 0.24 / hm));
      return Math.min(held[k], REACH) - cost;
    };
    while (queue.length) {
      const k = queue.pop()!;
      if (T.col[near[k]] < 0) continue; // visual-only: holds nothing up
      span(k, (c) => {
        for (const m of cells.get(c)!) {
          if (m === k || held[m] >= REACH || !touch(k, m)) continue;
          const v = carry(k, m);
          if (v >= 0 && v > held[m] + 1e-3) { held[m] = v; queue.push(m); }
        }
      });
    }
    let fell = 0;
    near.forEach((i, k) => {
      if (held[k] >= 0) return;
      const [min, max] = bx[k], st = this.style(i, 0) ?? this.style(i, 1) ?? this.style(i, 4) ?? this.style(i, 5) ?? this.style(i, 3);
      const vol = (max[0] - min[0]) * (max[1] - min[1]) * (max[2] - min[2]);
      this.remove(i); fell++;
      this.collapse(min, max, p, vol, power, st, this.surf(i));
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
    if (walls) { this.settle([cx, y0, cz], 8, 0.3); this.exposeSeams(); this.gone.length = 0; this.P.commit(); this.flush(); this.g?.audio.play('debris_fall', [cx, y0 + 1, cz], { range: 150, gain: 0.9 }); }
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
    // Several passes: a wardrobe that falls takes away the footing of the boxes stacked on it.
    for (let pass = 0; pass < 3; pass++) {
      let moved = 0;
      for (let pi = 0; pi < list.length; pi++) {
        const q = list[pi];
        if (Math.abs(q.x - p[0]) > r || Math.abs(q.z - p[2]) > r || this.propGone.has(pi) || ROBUST.test(q.id) || !this.W.propSlots.has(pi)) continue;
        const box = this.propBox(pi);
        const d = Math.hypot(q.x - p[0], q.y + 0.4 - p[1], q.z - p[2]);
        // Wrecked outright (close to the blast, first pass only).
        // (A charge under the floor wrecks the floor, not the furniture on it: that falls through the hole instead.)
        const sameLevel = p[1] > q.y - 0.25;
        if (pass === 0 && sameLevel && d < light * 0.9) {
          this.propGone.add(pi); n++; moved++;
          for (const [im, i] of this.W.propSlots.get(pi)!) { im.setMatrixAt(i, this.zero); im.instanceMatrix.needsUpdate = true; }
          P.removeProp(pi); this.gone.push([[box.min.x, box.min.y, box.min.z], [box.max.x, box.max.y, box.max.z]]);
          this.throwRubble([q.x - 0.4, q.y, q.z - 0.4], [q.x + 0.4, q.y + 0.9, q.z + 0.4], -1, p, 0, 0.12, power, null, SOFT.test(q.id) ? 'wood' : 'metal');
          continue;
        }
        // Knocked over / shoved by the blast (and with a line from the blast to it).
        if (pass === 0 && sameLevel && !HUNG.test(q.id) && d < Math.max(light * 2.2, 2.5) && P.clear(p, [q.x, q.y + 0.4, q.z], G_WORLD)) {
          const away: [number, number] = [q.x - p[0], q.z - p[2]], al = Math.hypot(away[0], away[1]) || 1;
          const push = (1 - d / Math.max(light * 2.2, 2.5)) * 2.2 * Math.min(2, power);
          const tall = box.max.y - box.min.y > 1.2;
          this.dropProp(pi, box, [away[0] / al * push, away[1] / al * push], tall ? 1.45 : 0.2 + Math.random() * 0.4, [away[0] / al, away[1] / al]);
          n++; moved++; continue;
        }
        // Footing: only props over (or hung next to) something removed can have lost it.
        const exposed = this.gone.some(([a, b]) => box.max.x > a[0] - 0.3 && box.min.x < b[0] + 0.3 && box.max.z > a[2] - 0.3 && box.min.z < b[2] + 0.3 && q.y > a[1] - 0.5 && q.y < b[1] + 4);
        if (!exposed || q.ground || q.y < groundH(q.x, q.z) + 0.3) continue;
        let held: boolean;
        if (HUNG.test(q.id)) held = [[0.35, 0], [-0.35, 0], [0, 0.35], [0, -0.35]].some(([dx, dz]) => solid(q.x + dx, q.y + 0.3, q.z + dz)) || !!P.castRay([q.x, q.y + 0.1, q.z], [0, 1, 0], 3.5);
        else {
          // Sample the whole footprint (4 × 4): it stays if most of it, and its middle, still rest on something.
          let ok = 0; const N = 4, y = q.y - 0.08;
          const sx = (box.max.x - box.min.x) * 0.9, sz = (box.max.z - box.min.z) * 0.9, x0 = (box.min.x + box.max.x) / 2 - sx / 2, z0 = (box.min.z + box.max.z) / 2 - sz / 2;
          let hx = 0, hz = 0, nh = 0;
          for (let a = 0; a < N; a++) for (let b = 0; b < N; b++) { const x = x0 + (a + 0.5) * sx / N, z = z0 + (b + 0.5) * sz / N; if (solid(x, y, z)) ok++; else { hx += x; hz += z; nh++; } }
          if (nh) this.holeAt = [hx / nh, hz / nh];
          const mid = solid((box.min.x + box.max.x) / 2, y, (box.min.z + box.max.z) / 2);
          held = ok / (N * N) >= 0.6 || (mid && ok / (N * N) >= 0.4);
        }
        if (held) continue;
        // It falls through the hole to whatever is below (tipping as it goes).
        // Falls into the hole: slides towards the unsupported side as it goes.
        const ctr = [(box.min.x + box.max.x) / 2, (box.min.z + box.max.z) / 2], hp = this.holeAt ?? ctr;
        this.dropProp(pi, box, [(hp[0] - ctr[0]) * 0.8, (hp[1] - ctr[1]) * 0.8], 0.15 + Math.random() * 0.5, null, true);
        this.holeAt = null;
        n++; moved++;
      }
      if (!moved) break;
    }
    return n;
  }

  /** World bounds of a placed prop (its instances' geometry through their matrices). */
  private propBox(pi: number): THREE.Box3 {
    const out = new THREE.Box3(), b = new THREE.Box3();
    for (const [im, i] of this.W.propSlots.get(pi) ?? []) {
      if (!im.geometry.boundingBox) im.geometry.computeBoundingBox();
      im.getMatrixAt(i, this.m4);
      b.copy(im.geometry.boundingBox!).applyMatrix4(this.m4);
      out.union(b);
    }
    if (out.isEmpty()) { const q = this.city.props[pi]; out.set(new THREE.Vector3(q.x - 0.4, q.y, q.z - 0.4), new THREE.Vector3(q.x + 0.4, q.y + 0.8, q.z + 0.4)); }
    return out;
  }

  /** Props falling to the floor below (through a hole) or knocked over by a blast: animated, then left lying. */
  private dropping: { slots: [THREE.InstancedMesh, number, THREE.Matrix4][]; base: THREE.Vector3; dy: number; slide: [number, number]; axis: THREE.Vector3; tilt: number; t: number; vy: number; y: number }[] = [];
  private holeAt: [number, number] | null = null;
  private dropProp(pi: number, box: THREE.Box3, slide: [number, number], tilt: number, dir: [number, number] | null, through = false) {
    const q = this.city.props[pi], P = this.P;
    this.propGone.add(pi); P.removeProp(pi);
    this.gone.push([[box.min.x, box.min.y, box.min.z], [box.max.x, box.max.y, box.max.z]]);
    // The floor below (through the hole) or the floor it stands on (knocked over).
    const cx = (box.min.x + box.max.x) / 2 + slide[0], cz = (box.min.z + box.max.z) / 2 + slide[1];
    // Through a hole: the floor below (the ray starts under the slab); knocked over: it stays on its own floor.
    const h = through ? P.castRay([cx, q.y - 0.4, cz], [0, -1, 0], 40, G_WORLD) : null;
    const dy = h ? Math.max(0, q.y - h.point[1]) : 0;
    const a = dir ? Math.atan2(dir[1], dir[0]) : Math.random() * Math.PI * 2;
    const axis = new THREE.Vector3(Math.sin(a), 0, -Math.cos(a)); // tips the top towards `dir` (up × dir)
    const slots = this.W.propSlots.get(pi)!.map(([im, i]) => { const m = new THREE.Matrix4(); im.getMatrixAt(i, m); return [im, i, m] as [THREE.InstancedMesh, number, THREE.Matrix4]; });
    this.dropping.push({ slots, base: new THREE.Vector3(q.x, q.y, q.z), dy, slide, axis, tilt: Math.min(1.5, tilt), t: 0, vy: 0, y: 0 });
    if (dy > 0.5) this.g?.audio.play('body_fall', [q.x, q.y, q.z], { range: 40, gain: 0.7, rate: 0.7 });
  }
  private updateDropping(dt: number) {
    for (let k = this.dropping.length - 1; k >= 0; k--) {
      const f = this.dropping[k]; f.t += dt;
      // Falls under gravity to the floor below; slides and tips over in ~0.5 s.
      f.vy += 9.81 * dt; f.y = Math.min(f.dy, f.y + f.vy * dt);
      const s = Math.min(1, f.t / 0.5), e = 1 - (1 - s) * (1 - s);
      const tilt = f.tilt * Math.min(1, f.dy > 0.3 ? f.y / f.dy : e);
      const M = new THREE.Matrix4().makeTranslation(f.base.x + f.slide[0] * e, f.base.y - f.y, f.base.z + f.slide[1] * e)
        .multiply(new THREE.Matrix4().makeRotationAxis(f.axis, tilt)).multiply(new THREE.Matrix4().makeTranslation(-f.base.x, -f.base.y, -f.base.z));
      for (const [im, i, m0] of f.slots) { im.setMatrixAt(i, this.m4.copy(M).multiply(m0)); im.instanceMatrix.needsUpdate = true; }
      if (f.y >= f.dy && s >= 1) this.dropping.splice(k, 1);
    }
  }

  // ---------------- rubble ----------------
  /** Splinters / fragments thrown out of a box (min, max) by a blast at p (doors, other non-city things). */
  debris(min: number[], max: number[], p: V3, power: number, surf: Surface, vol: number) {
    this.throwRubble(min, max, -1, p, 0, vol, power, null, surf);
  }
  private throwRubble(min: number[], max: number[], t: number, p: V3, r: number, vol: number, power: number, st: Style | null, surf: Surface) {
    if (vol <= 0.002) return;
    // Broken masonry is mostly bricks and fist-sized pieces, with a few larger lumps of bonded brick or plaster.
    const n = Math.max(4, Math.min(t < 0 ? 18 : 40, Math.round(vol / 0.006)));
    const base: V3 = st ? [Math.min(1, st.top[0] * 1.15), Math.min(1, st.top[1] * 1.15), Math.min(1, st.top[2] * 1.15)] : [0.8, 0.75, 0.66];
    const light = surf === 'metal' || surf === 'wood';
    const size = Math.min(0.22, Math.cbrt(vol / n) * 0.9);
    for (let k = 0; k < n; k++) {
      const c: V3 = [0, 0, 0];
      for (let a = 0; a < 3; a++) {
        const lo = t >= 0 && a !== t ? Math.max(min[a], p[a] - r * 0.8) : min[a], hi = t >= 0 && a !== t ? Math.min(max[a], p[a] + r * 0.8) : max[a];
        c[a] = lo + Math.random() * Math.max(0, hi - lo);
      }
      const kv = 0.75 + Math.random() * 0.25;
      let kind = 0, s: THREE.Vector3, tint: V3;
      if (light) {
        // Splinters and torn sheet: thin flat pieces.
        const g = 0.5 + Math.random();
        s = new THREE.Vector3(0.12 + Math.random() * 0.3 * g, 0.02, 0.05 + Math.random() * 0.12);
        tint = surf === 'wood' ? [0.52 * kv, 0.4 * kv, 0.27 * kv] : [0.45 * kv, 0.43 * kv, 0.4 * kv];
      } else if (surf === 'masonry' && Math.random() < 0.6) {
        // A brick (whole, or a half / bat).
        kind = 1;
        const half = Math.random() < 0.45 ? 0.5 + Math.random() * 0.25 : 1;
        s = new THREE.Vector3(BRICK[0] * half, BRICK[1], BRICK[2]);
        tint = Math.random() < 0.75 ? [0.62 * kv, 0.4 * kv, 0.29 * kv] : [base[0] * kv, base[1] * kv, base[2] * kv];
      } else {
        // Plaster / concrete: many small pieces, a few big ones.
        const g = Math.pow(Math.random(), 2.2) * 2.2 + 0.3;
        s = new THREE.Vector3(size * g * (0.7 + Math.random() * 0.6), size * g * (0.4 + Math.random() * 0.4), size * g * (0.7 + Math.random() * 0.6)).clampScalar(0.035, 0.4);
        tint = [base[0] * kv, base[1] * kv, base[2] * kv];
      }
      const d = [c[0] - p[0], c[1] - p[1], c[2] - p[2]], L = Math.hypot(d[0], d[1], d[2]) || 1;
      const sp = power * (2 + Math.random() * 7) / Math.max(1, L * 0.7);
      this.spawn(kind, c, s, tint, [d[0] / L * sp, d[1] / L * sp + 0.5 + Math.random() * 2.5 * power, d[2] / L * sp]);
    }
  }

  /**
   * An unsupported piece comes down: broken into a few large blocks (its own thickness, at most ~0.7 m across) that
   * drop and tumble from where it stood, with the loose bricks and fragments of its broken edges.
   */
  private collapse(min: number[], max: number[], p: V3, vol: number, power: number, st: Style | null, surf: Surface) {
    const ext = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    if (vol > 0.03 && surf !== 'metal' && surf !== 'wood' && surf !== 'glass') {
      const nd = ext.map((x) => Math.max(1, Math.round(x / 0.7))), tot = nd[0] * nd[1] * nd[2];
      const keep = Math.min(1, 10 / tot), base: V3 = st ? [Math.min(1, st.top[0] * 1.1), Math.min(1, st.top[1] * 1.1), Math.min(1, st.top[2] * 1.1)] : [0.75, 0.7, 0.62];
      for (let ix = 0; ix < nd[0]; ix++) for (let iy = 0; iy < nd[1]; iy++) for (let iz = 0; iz < nd[2]; iz++) {
        if (Math.random() > keep) continue;
        const sz = new THREE.Vector3(ext[0] / nd[0], ext[1] / nd[1], ext[2] / nd[2]).multiplyScalar(0.8 + Math.random() * 0.15).clampScalar(0.06, 0.8);
        const c: V3 = [min[0] + (ix + 0.5) * ext[0] / nd[0], min[1] + (iy + 0.5) * ext[1] / nd[1], min[2] + (iz + 0.5) * ext[2] / nd[2]];
        const d = [c[0] - p[0], c[2] - p[2]], L = Math.hypot(d[0], d[1]) || 1, sp = power * 0.6 * Math.random();
        const kv = 0.8 + Math.random() * 0.2;
        this.spawn(1, c, sz, [base[0] * kv, base[1] * kv, base[2] * kv], [d[0] / L * sp, -0.5, d[1] / L * sp]);
      }
      this.throwRubble(min, max, -1, p, 0, vol * 0.35, power * 0.1, st, surf);
    } else this.throwRubble(min, max, -1, p, 0, vol, power * 0.2, st, surf);
  }

  /** Rubble waiting to be created (a few per frame: making 50 bodies at once stalled the blast frame). */
  private pending: [number, V3, THREE.Vector3, V3, V3][] = [];
  private spawn(kind: number, c: V3, s: THREE.Vector3, tint: V3, vel: V3) { this.pending.push([kind, c, s, tint, vel]); }
  private make(k: number, c: V3, s: THREE.Vector3, tint: V3, vel: V3) {
    const i = this.rubbleN[k] % MAX_RUBBLE; this.rubbleN[k]++;
    const im = this.rubbles[k];
    const prev = this.active.findIndex((a) => a.k === k && a.i === i);
    if (prev >= 0) { this.P.world.removeRigidBody(this.active[prev].body); this.active.splice(prev, 1); }
    this.frozen.delete(k * MAX_RUBBLE + i);
    // Over the limit: the oldest piece that has come to rest is frozen; if none has, the oldest is laid on whatever
    // is under it (never left hanging where it was).
    if (this.active.length >= MAX_ACTIVE) {
      let o = this.active.findIndex((a) => { const v = a.body.linvel(); return a.t > 0.5 && v.x * v.x + v.y * v.y + v.z * v.z < 0.25; });
      if (o < 0) o = 0;
      this.freeze(o);
    }
    const R = RAPIER, w = this.P.world;
    const body = w.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(c[0], c[1], c[2]).setLinvel(vel[0], vel[1], vel[2])
      .setAngvel({ x: (Math.random() - 0.5) * 14, y: (Math.random() - 0.5) * 14, z: (Math.random() - 0.5) * 14 }).setLinearDamping(0.05).setAngularDamping(0.5).setCcdEnabled(true));
    const f = k === 1 ? 0.5 : 0.45;
    w.createCollider(R.ColliderDesc.cuboid(s.x * f, s.y * f, s.z * f).setDensity(k === 1 ? 1800 : 1900).setFriction(0.9).setRestitution(0.08).setCollisionGroups(groups(G_DEBRIS, G_WORLD | G_VEH | G_DEBRIS)), body);
    this.active.push({ body, k, i, t: 0, s });
    im.setColorAt(i, new THREE.Color(tint[0], tint[1], tint[2]));
    im.count = Math.min(MAX_RUBBLE, this.rubbleN[k]);
    this.place(k, i, c, { x: 0, y: 0, z: 0, w: 1 }, s);
    im.instanceColor!.needsUpdate = true;
  }
  private place(k: number, i: number, p: { x: number; y: number; z: number } | V3, r: { x: number; y: number; z: number; w: number }, s: THREE.Vector3) {
    if (Array.isArray(p)) this.v.set(p[0], p[1], p[2]); else this.v.set(p.x, p.y, p.z);
    this.q.set(r.x, r.y, r.z, r.w);
    this.m4.compose(this.v, this.q, s);
    this.rubbles[k].setMatrixAt(i, this.m4);
    this.rubbles[k].instanceMatrix.needsUpdate = true;
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
    for (let k = 0; k < 18 && this.pending.length; k++) this.make(...this.pending.shift()!);
    this.scanFrozen(24);
    this.updateDropping(dt);
    for (let k = this.active.length - 1; k >= 0; k--) {
      const a = this.active[k]; a.t += dt;
      const tr = a.body.translation();
      this.place(a.k, a.i, tr, a.body.rotation(), a.s);
      if (tr.y < -50) { this.P.world.removeRigidBody(a.body); this.active.splice(k, 1); continue; }
      const v = a.body.linvel(), slow = v.x * v.x + v.y * v.y + v.z * v.z < 0.04;
      if ((a.t > 1 && a.body.isSleeping()) || (a.t > 8 && slow) || a.t > 20) this.freeze(k);
    }
  }

  /** Settled rubble (no body): instance, where it lies, its size. A blast that takes the floor away wakes it. */
  private frozen = new Map<number, { k: number; i: number; p: V3; q: [number, number, number, number]; s: THREE.Vector3 }>();
  /**
   * Stop simulating active piece `ai` and leave it as settled rubble. If it is not resting on anything (still
   * falling, or lying on a vehicle), it is first laid on the ground or floor below it.
   */
  private freeze(ai: number) {
    const a = this.active[ai], tr = a.body.translation(), rot = a.body.rotation();
    let p: V3 = [tr.x, tr.y, tr.z], q: [number, number, number, number] = [rot.x, rot.y, rot.z, rot.w];
    const half = Math.max(a.s.x, a.s.y, a.s.z) * 0.5, h = this.P.castRay(p, [0, -1, 0], 200, G_WORLD);
    if (h && h.dist > half + 0.12) {
      // Lay it flat on the surface below (keeping its heading).
      const yaw = Math.atan2(2 * (rot.w * rot.y + rot.x * rot.z), 1 - 2 * (rot.y * rot.y + rot.x * rot.x));
      p = [tr.x, h.point[1] + a.s.y * 0.5, tr.z]; q = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
      this.place(a.k, a.i, p, { x: q[0], y: q[1], z: q[2], w: q[3] }, a.s);
    }
    this.P.world.removeRigidBody(a.body); this.active.splice(ai, 1);
    this.frozen.set(a.k * MAX_RUBBLE + a.i, { k: a.k, i: a.i, p, q, s: a.s });
  }
  /** Settled rubble round p that has lost what it lay on starts falling again. */
  private wakeFrozen(p: V3, r: number) {
    for (const [key, f] of this.frozen) {
      if (Math.abs(f.p[0] - p[0]) > r || Math.abs(f.p[2] - p[2]) > r) continue;
      this.checkFrozen(key, f);
    }
  }
  /** A broken chunk left clinging to the edge of a breach: settled rubble (no body) embedded in the edge. */
  private cling(c: V3, s: THREE.Vector3, tint: V3) {
    const k = 0, i = this.rubbleN[k] % MAX_RUBBLE; this.rubbleN[k]++;
    const prev = this.active.findIndex((a) => a.k === k && a.i === i);
    if (prev >= 0) { this.P.world.removeRigidBody(this.active[prev].body); this.active.splice(prev, 1); }
    const im = this.rubbles[k], q = new THREE.Quaternion().setFromEuler(new THREE.Euler((Math.random() - 0.5) * 0.7, Math.random() * 6.3, (Math.random() - 0.5) * 0.7));
    im.setColorAt(i, new THREE.Color(tint[0], tint[1], tint[2])); im.instanceColor!.needsUpdate = true;
    im.count = Math.min(MAX_RUBBLE, this.rubbleN[k]);
    this.place(k, i, c, q, s);
    this.frozen.set(k * MAX_RUBBLE + i, { k, i, p: c, q: [q.x, q.y, q.z, q.w], s });
  }
  /** Rolling check of settled rubble (a few pieces a frame): whatever no longer has something under it falls. */
  private scan: IterableIterator<[number, { k: number; i: number; p: V3; q: [number, number, number, number]; s: THREE.Vector3 }]> | null = null;
  private scanFrozen(n: number) {
    for (let c = 0; c < n && this.frozen.size; c++) {
      if (!this.scan) this.scan = this.frozen.entries();
      const it = this.scan.next();
      if (it.done) { this.scan = null; continue; }
      this.checkFrozen(it.value[0], it.value[1]);
    }
  }
  private checkFrozen(key: number, f: { k: number; i: number; p: V3; q: [number, number, number, number]; s: THREE.Vector3 }) {
    const R = RAPIER, w = this.P.world;
    {
      const half = Math.max(f.s.x, f.s.y, f.s.z) * 0.5, h = this.P.castRay(f.p, [0, -1, 0], half + 0.25, G_WORLD);
      if (h) return;
      this.frozen.delete(key);
      if (this.active.length >= MAX_ACTIVE) { const o = this.active.findIndex((a) => a.t > 1); this.freeze(o >= 0 ? o : 0); }
      const body = w.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(f.p[0], f.p[1], f.p[2]).setRotation({ x: f.q[0], y: f.q[1], z: f.q[2], w: f.q[3] }).setLinearDamping(0.05).setAngularDamping(0.5).setCcdEnabled(true));
      const k = f.k === 1 ? 0.5 : 0.45;
      w.createCollider(R.ColliderDesc.cuboid(f.s.x * k, f.s.y * k, f.s.z * k).setDensity(1900).setFriction(0.9).setRestitution(0.08).setCollisionGroups(groups(G_DEBRIS, G_WORLD | G_VEH | G_DEBRIS)), body);
      this.active.push({ body, k: f.k, i: f.i, t: 0, s: f.s });
    }
  }

}

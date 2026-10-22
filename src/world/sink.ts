// Geometry and collider accumulator for the procedural city. Pure data (no three.js), so the generator can run
// in a worker or in Node. Everything static is made of boxes: visual faces go into per-material, per-chunk batches
// with world-space UVs and baked vertex shading; solid boxes also become Rapier cuboid colliders.

export type Surface = 'masonry' | 'concrete' | 'metal' | 'wood' | 'glass' | 'dirt' | 'sandbag' | 'water' | 'flesh';

/** Visual materials; `uv` is metres per texture repeat. */
export const MATS = {
  plaster_a: { tex: 'beige_wall_001', uv: 2.6, surf: 'masonry' },
  plaster_b: { tex: 'beige_wall_002', uv: 2.6, surf: 'masonry' },
  clay: { tex: 'clay_plaster', uv: 3.0, surf: 'masonry' },
  plastered: { tex: 'plastered_wall_03', uv: 2.8, surf: 'masonry' },
  damaged: { tex: 'damaged_plaster', uv: 2.6, surf: 'masonry' },
  concrete: { tex: 'concrete_wall_008', uv: 3.0, surf: 'concrete' },
  block: { tex: 'concrete_block_wall', uv: 2.4, surf: 'concrete' },
  sandstone: { tex: 'large_sandstone_blocks', uv: 3.2, surf: 'masonry' },
  cracked: { tex: 'cracked_concrete_wall', uv: 2.8, surf: 'concrete' },
  brick: { tex: 'concrete_brick_wall_001', uv: 2.2, surf: 'masonry' },
  floor: { tex: 'concrete_floor_02', uv: 2.5, surf: 'concrete' },
  /** Two-tone terrazzo checker, the classic floor of Iraqi homes (0.4 m tiles). */
  checker: { tex: 'floor_tiles_06', uv: 1.6, surf: 'concrete' },
  tiles: { tex: 'large_grey_tiles', uv: 2.0, surf: 'concrete' },
  roof: { tex: 'dirty_concrete', uv: 4.0, surf: 'concrete' },
  asphalt: { tex: 'asphalt_02', uv: 6.0, surf: 'concrete' },
  pavement: { tex: 'concrete_pavement', uv: 2.5, surf: 'concrete' },
  kerb: { tex: 'cracked_concrete', uv: 2.0, surf: 'concrete' },
  metal: { tex: 'corrugated_iron_02', uv: 2.5, surf: 'metal' },
  metal_green: { tex: 'green_metal_rust', uv: 2.0, surf: 'metal' },
  wood: { tex: 'distressed_painted_planks', uv: 2.0, surf: 'wood' },
  dirt: { tex: 'dry_mud_field_001', uv: 4.0, surf: 'dirt' },
} as const;
export type MatId = keyof typeof MATS;

/** Face flags for `box`: which of the six faces to emit. */
export const F = { nx: 1, px: 2, ny: 4, py: 8, nz: 16, pz: 32, all: 63, sides: 51, noBottom: 59 } as const;

export interface Collider { c: [number, number, number]; h: [number, number, number]; q?: [number, number, number, number]; s: Surface; tag?: number }
/**
 * Per-chunk, per-layer triangle soup (non-indexed). Layers: 0 always drawn (terrain features, fences, bridges);
 * 1 building interiors (near only); 2 detailed building exteriors (near/mid); 3 building LOD shells (far only).
 */
export type Layer = 0 | 1 | 2 | 3;
export interface Batch { chunk: number; layer: Layer; n: number; pos: Float32Array; nrm: Float32Array; uv: Float32Array; col: Float32Array; mi: Float32Array }
/** Material index (texture-array layer) of each MatId. */
export const MAT_INDEX = Object.fromEntries(Object.keys(MATS).map((k, i) => [k, i])) as Record<MatId, number>;

/** Shading rule for a face: returns a brightness multiplier (interior faces are darker). */
export type Shade = (cx: number, cy: number, cz: number, nx: number, ny: number, nz: number) => number;

export const CHUNK = 128;
const ORDER = [0, 1, 2, 0, 2, 3];
/** Shade values at or below this mark interior faces (see building.ts). */
export const INTERIOR = 0.5;
export const chunkOf = (x: number, z: number) => (Math.floor((x + 2048) / CHUNK) & 0xff) | ((Math.floor((z + 2048) / CHUNK) & 0xff) << 8);

export class Sink {
  batches = new Map<string, Batch>();
  colliders: Collider[] = [];
  tris = 0;
  /** Tag stamped on new colliders (the building id), so ray hits can be traced to a building. */
  tag = -1;
  /** Optional crop (test areas): geometry outside it is dropped; whole buildings are kept or skipped via `skip`. */
  clip: { x0: number; z0: number; x1: number; z1: number } | null = null;
  skip = false;
  private out(x: number, z: number) { const c = this.clip; return !!c && !this.ext && (x < c.x0 - 3 || x > c.x1 + 3 || z < c.z0 - 3 || z > c.z1 + 3); }
  /** Interior paint of the building being emitted: interior wall faces become painted plaster in this colour. */
  paint: [number, number, number] | null = null;
  /** Layer for exterior faces (0, or 2 while a building is being emitted). */
  ext: Layer = 0;
  /** Chunk anchor while a building is emitted (its centre). */
  cx = 0; cz = 0;

  /** A far-LOD building shell: four walls and a roof, no collider. Chunked by the building centre so it swaps with its detail. */
  shell(min: number[], max: number[], mat: MatId, tint: [number, number, number], roofMat: MatId, cx: number, cz: number, layer: Layer = 3) {
    const [x0, y0, z0] = min, [x1, y1, z1] = max, k = [1, 1, 1, 1], kb = [0.72, 0.72, 1, 1];
    this.quad(mat, [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0], tint, kb, cx, cz, layer);
    this.quad(mat, [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0], tint, kb, cx, cz, layer);
    this.quad(mat, [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1], tint, kb, cx, cz, layer);
    this.quad(mat, [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], tint, kb, cx, cz, layer);
    this.quad(roofMat, [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [0, 1, 0], [tint[0] * 0.95, tint[1] * 0.95, tint[2] * 0.95], k, cx, cz, layer);
  }

  private batch(x: number, z: number, layer: Layer, add: number): Batch {
    const chunk = chunkOf(x, z), key = `${chunk}|${layer}`;
    let b = this.batches.get(key);
    if (!b) { const c = 4096; b = { chunk, layer, n: 0, pos: new Float32Array(c * 3), nrm: new Float32Array(c * 3), uv: new Float32Array(c * 2), col: new Float32Array(c * 3), mi: new Float32Array(c) }; this.batches.set(key, b); }
    if (b.n + add > b.pos.length / 3) {
      const c = Math.max(b.n + add, (b.pos.length / 3) * 2), g = (a: Float32Array, k: number) => { const r = new Float32Array(c * k); r.set(a); return r; };
      b.pos = g(b.pos, 3); b.nrm = g(b.nrm, 3); b.uv = g(b.uv, 2); b.col = g(b.col, 3); b.mi = g(b.mi, 1);
    }
    return b;
  }

  /** A quad from four corners (counter-clockwise seen from the front), world UVs from the normal axis. */
  quad(mat: MatId, p: number[][], n: [number, number, number], tint: [number, number, number], shade: number[], chunkX: number, chunkZ: number, layer: Layer = 0) {
    const b = this.batch(chunkX, chunkZ, layer, 6), s = 1 / MATS[mat].uv, mi = MAT_INDEX[mat];
    const ax = Math.abs(n[0]), ay = Math.abs(n[1]);
    for (const i of ORDER) {
      const [x, y, z] = p[i], v = b.n++;
      b.mi[v] = mi;
      b.pos[v * 3] = x; b.pos[v * 3 + 1] = y; b.pos[v * 3 + 2] = z;
      b.nrm[v * 3] = n[0]; b.nrm[v * 3 + 1] = n[1]; b.nrm[v * 3 + 2] = n[2];
      // Planar projection by the dominant normal axis; walls keep v vertical.
      if (ay > 0.7) { b.uv[v * 2] = x * s; b.uv[v * 2 + 1] = -z * s; }
      else if (ax > 0.7) { b.uv[v * 2] = (n[0] > 0 ? -z : z) * s; b.uv[v * 2 + 1] = y * s; }
      else { b.uv[v * 2] = (n[2] > 0 ? x : -x) * s; b.uv[v * 2 + 1] = y * s; }
      const k = shade[i];
      b.col[v * 3] = tint[0] * k; b.col[v * 3 + 1] = tint[1] * k; b.col[v * 3 + 2] = tint[2] * k;
    }
    this.tris += 2;
  }

  /**
   * Axis-aligned box from min to max. `faces` selects faces (F flags). `shade` darkens interior faces; the bottom
   * vertices of vertical faces get a little extra darkening near the ground/floor (cheap baked contact shadow).
   */
  box(min: number[], max: number[], mat: MatId, tint: [number, number, number], faces: number = F.all, shade?: Shade, solid: boolean = true, surf?: Surface) {
    const [x0, y0, z0] = min, [x1, y1, z1] = max;
    if (x1 - x0 < 1e-3 || y1 - y0 < 1e-3 || z1 - z0 < 1e-3 || this.skip) return;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
    if (this.out(cx, cz)) return;
    const ao = (y: number, base: number) => (y - y0 < 0.01 && y1 - y0 > 0.6 ? base * 0.72 : base);
    const face = (flag: number, n: [number, number, number], p: number[][], fc: [number, number, number]) => {
      if (!(faces & flag)) return;
      const k = shade ? shade(fc[0], fc[1], fc[2], n[0], n[1], n[2]) : 1;
      const sh = n[1] === 0 ? p.map((q) => ao(q[1], k)) : [k, k, k, k];
      const inside = k <= INTERIOR;
      // Inside: walls and ceilings are lime-washed plaster in the house colour; floors keep their own material.
      const pm: MatId = inside && this.paint && n[1] <= 0 ? 'plastered' : mat;
      const pt: [number, number, number] = inside && this.paint && n[1] <= 0 ? (n[1] < 0 ? [Math.min(1, this.paint[0] * 1.08), Math.min(1, this.paint[1] * 1.08), Math.min(1, this.paint[2] * 1.08)] : this.paint) : tint;
      this.quad(pm, p, n, pt, sh, this.ext ? this.cx : cx, this.ext ? this.cz : cz, inside ? 1 : this.ext);
    };
    face(F.nx, [-1, 0, 0], [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [x0, cy, cz]);
    face(F.px, [1, 0, 0], [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [x1, cy, cz]);
    face(F.ny, [0, -1, 0], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [cx, y0, cz]);
    face(F.py, [0, 1, 0], [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [cx, y1, cz]);
    face(F.nz, [0, 0, -1], [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [cx, cy, z0]);
    face(F.pz, [0, 0, 1], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [cx, cy, z1]);
    if (solid) this.colliders.push({ c: [cx, cy, cz], h: [(x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2], s: surf ?? MATS[mat].surf, tag: this.tag });
  }

  /**
   * One planar quad with an explicit normal (stairs, slopes). The winding is fixed up from the normal, so callers can
   * list the corners in either order. Shading/layer/chunk follow the same rules as `box`.
   */
  face(mat: MatId, p: number[][], n: [number, number, number], tint: [number, number, number], shade?: Shade) {
    if (this.skip) return;
    const e1 = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]], e2 = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
    const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const q = cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2] < 0 ? [p[0], p[3], p[2], p[1]] : p;
    const c = [0, 1, 2].map((i) => (p[0][i] + p[1][i] + p[2][i] + p[3][i]) / 4);
    const k = shade ? shade(c[0], c[1], c[2], n[0], n[1], n[2]) : 1;
    this.quad(mat, q, n, tint, [k, k, k, k], this.ext ? this.cx : c[0], this.ext ? this.cz : c[2], k <= INTERIOR ? 1 : this.ext);
  }

  /** A collider only (no visuals), optionally rotated (quaternion x, y, z, w). */
  solid(c: [number, number, number], h: [number, number, number], s: Surface, q?: [number, number, number, number]) {
    if (this.skip || this.out(c[0], c[2])) return;
    this.colliders.push({ c, h, q, s, tag: this.tag });
  }
}

/** Quaternion for a rotation of `a` radians about the X or Z axis. */
export const quatX = (a: number): [number, number, number, number] => [Math.sin(a / 2), 0, 0, Math.cos(a / 2)];
export const quatZ = (a: number): [number, number, number, number] => [0, 0, Math.sin(a / 2), Math.cos(a / 2)];
export const quatY = (a: number): [number, number, number, number] => [0, Math.sin(a / 2), 0, Math.cos(a / 2)];

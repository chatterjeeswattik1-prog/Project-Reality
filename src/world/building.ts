// One enterable building from boxes: exterior walls with door/window openings (whole-height piers, spandrels),
// floor slabs, a dog-leg stairwell from the ground to a roof hut, partition walls with doorways, parapets, and
// optional battle damage (holes punched through walls and slabs). Built in a local frame (u across the front,
// v from the front to the back, y up) and mapped to the world by one of four 90° orientations.
import { F, type MatId, type Shade, type Sink } from './sink';
import { hash2 } from '../core/rng';

export type Side = 'front' | 'back' | 'left' | 'right';
export interface BuildingSpec {
  id: number;
  /** World footprint (axis aligned) and the side that faces the street: 0 front at −z, 1 front at +x, 2 front at +z, 3 front at −x. */
  x0: number; z0: number; x1: number; z1: number; orient: 0 | 1 | 2 | 3;
  /** Ground level (top of the terrain under the footprint). */
  y0: number;
  floors: number; fh: number; t: number;
  wall: MatId; tint: [number, number, number]; floorMat: MatId;
  /** Sides shared with a neighbour (no windows or doors). */
  party: Side[];
  /** Ground floor shop bays on the front. */
  shops?: boolean;
  /** Regular window grid (apartments) vs irregular small windows (houses). */
  modern?: boolean;
  /** Battle damage 0..1 (0 = intact). */
  damage: number;
  /** Roof stair hut and stairs (false for one-storey sheds). */
  stairs: boolean;
  /** Extra height of a single tall storey (warehouses, prayer halls) — no stairs, no partitions. */
  hall?: boolean;
  parapet: number;
  /** Concrete floor bands on the facade (modern blocks). */
  bands?: boolean;
  /** Door in the back wall (courtyard houses). */
  backDoor?: boolean;
}

export interface BuildingInfo {
  id: number; spec: BuildingSpec;
  /** Rooms' floor points (world) usable for weapon caches, hideouts and AI positions: [x, y, z, floor]. */
  spots: [number, number, number, number][];
  /** Roof points (world) for snipers/lookouts. */
  roof: [number, number, number][];
  doors: [number, number, number][];
  roofY: number;
  /** Rubble placements [x, y, z, outside 0/1] for collapsed corners. */
  debris: [number, number, number, number][];
  /** Doorways for door leaves: centre on the floor, opening width/height, the axis the wall runs along, floor, outside? */
  doorways: { x: number; y: number; z: number; w: number; h: number; axis: 'x' | 'z'; floor: number; exterior: boolean }[];
  /** Room floor rectangles (world, axis aligned) per floor for furnishing; `kind` suggests the use. */
  rooms: { x0: number; z0: number; x1: number; z1: number; y: number; floor: number; kind: 'living' | 'kitchen' | 'bedroom' | 'store' }[];
  /** Interior paint colour (vertex tint for interior wall faces). */
  paint: [number, number, number];
  /** Window openings as firing positions: a point inside the room ~0.6 m from the wall (on the floor), the outward
   *  normal, the sill height above that floor and the floor index. */
  windows: { x: number; y: number; z: number; nx: number; nz: number; sill: number; floor: number }[];
}

interface Opening { u0: number; u1: number; y0: number; y1: number }

const STAIR_W = 1.05, STAIR_RUN = 2.6, LANDING = 1.1, WELL_W = 2 * STAIR_W, WELL_D = LANDING + STAIR_RUN + 1.1;

export function building(S: Sink, sp: BuildingSpec): BuildingInfo {
  const { orient, t, fh, floors } = sp;
  const W = orient % 2 === 0 ? sp.x1 - sp.x0 : sp.z1 - sp.z0, D = orient % 2 === 0 ? sp.z1 - sp.z0 : sp.x1 - sp.x0;
  const G = sp.y0 + 0.15;                         // ground floor top
  const Y = (k: number) => G + k * fh;             // floor k top
  const roofY = Y(floors), top = roofY + sp.parapet;
  const R = hash2(sp.id, 77);
  // Local (u, v) → world (x, z).
  const W2 = (u: number, v: number): [number, number] => {
    switch (orient) {
      case 0: return [sp.x0 + u, sp.z0 + v];
      case 1: return [sp.x1 - v, sp.z0 + u];
      case 2: return [sp.x1 - u, sp.z1 - v];
      default: return [sp.x0 + v, sp.z1 - u];
    }
  };
  // Local box → world box; faces given in local terms are remapped.
  const LF = { nu: 1, pu: 2, ny: 4, py: 8, nv: 16, pv: 32 };
  const mapFaces = (f: number) => {
    // local −u,+u,−v,+v → world faces depending on orientation
    const m: Record<number, [number, number, number, number]> = {
      0: [F.nx, F.px, F.nz, F.pz], 1: [F.nz, F.pz, F.px, F.nx], 2: [F.px, F.nx, F.pz, F.nz], 3: [F.pz, F.nz, F.nx, F.px],
    };
    const [nu, pu, nv, pv] = m[orient];
    return (f & LF.nu ? nu : 0) | (f & LF.pu ? pu : 0) | (f & LF.nv ? nv : 0) | (f & LF.pv ? pv : 0) | (f & (F.ny | F.py));
  };
  const inside = (x: number, y: number, z: number) => x > sp.x0 + t - 0.02 && x < sp.x1 - t + 0.02 && z > sp.z0 + t - 0.02 && z < sp.z1 - t + 0.02 && y < roofY - 0.05 && y > sp.y0 - 0.2;
  const shade: Shade = (cx, cy, cz, nx, ny, nz) => {
    const px = cx + nx * 0.05, py = cy + ny * 0.05, pz = cz + nz * 0.05;
    if (!inside(px, py, pz)) return ny < -0.5 ? 0.55 : 1;
    return ny < -0.5 ? 0.3 : ny > 0.5 ? 0.5 : 0.42;
  };
  // ---------- battle damage (structural, no loose fragments) ----------
  // Breaches: jagged holes through exterior walls, cut like oversized openings (stacked rectangles give broken edges).
  // Collapse: on heavy damage the top storey's back-right corner (away from the stairwell) has fallen in: its roof slab
  // is gone and the walls around it are broken down in steps from the corner. Debris points mark where rubble goes.
  const dmg = sp.damage, R2 = (k: number) => hash2(sp.id, 500 + k);
  const breaches: { side: Side; ops: Opening[] }[] = [];
  const collapse = dmg > 0.55 ? { u0: W * (0.42 + 0.18 * R2(1)), v0: D * (0.38 + 0.22 * R2(2)) } : null;
  const inCollapse = (u: number, v: number) => !!collapse && u > collapse.u0 && v > collapse.v0;
  if (dmg > 0) {
    const free = (['front', 'back', 'left', 'right'] as Side[]).filter((x) => !sp.party.includes(x));
    const n = Math.min(free.length * 2, 1 + Math.floor(dmg * 2.6));
    for (let i = 0; i < n && free.length; i++) {
      const side = free[Math.floor(R2(10 + i) * free.length)], len = side === 'front' || side === 'back' ? W : D;
      const k = Math.floor(R2(20 + i) * floors), w = 1.2 + R2(30 + i) * 1.6, h = 1.0 + R2(40 + i) * 1.1;
      const c = 0.9 + w / 2 + R2(50 + i) * Math.max(0, len - 1.8 - w), y0 = Y(k) + 0.35 + R2(60 + i) * 0.5;
      const u0 = c - w / 2, u1 = c + w / 2, j = R2(70 + i);
      breaches.push({ side, ops: [
        { u0, u1, y0, y1: y0 + h },
        { u0: u0 + w * (0.15 + 0.2 * j), u1: u1 - w * (0.1 + 0.25 * (1 - j)), y0: y0 + h, y1: y0 + h + 0.3 + 0.3 * j },
        { u0: u0 + w * (0.25 + 0.15 * (1 - j)), u1: u1 - w * (0.2 + 0.2 * j), y0: Math.max(G + 0.2, y0 - 0.25 - 0.25 * j), y1: y0 },
        { u0: u0 - 0.25 * j, u1: u0 + w * 0.4, y0: y0 + h * 0.25, y1: y0 + h * 0.8 },
      ] });
    }
  }
  /** Openings that break a wall down from the top around the collapsed corner (a = position along the wall). */
  const collapseOps = (side: Side): Opening[] => {
    if (!collapse || (side !== 'back' && side !== 'right')) return [];
    const low = floors > 1 ? Y(floors - 1) + 0.4 : G + 1.3, out: Opening[] = [];
    const a0 = side === 'back' ? collapse.u0 : collapse.v0, a1 = side === 'back' ? W - 0.05 : D - t;
    let a = a0, k = 0;
    while (a < a1) {
      const w = Math.min(a1 - a, 0.5 + R2(80 + k + (side === 'back' ? 0 : 40)) * 0.8);
      // Lowest at the building corner, rising towards the intact part.
      const f = 1 - (a + w / 2 - a0) / Math.max(0.1, a1 - a0);
      const yb = top - (top - low) * Math.pow(f, 0.7) * (0.75 + 0.25 * R2(120 + k));
      if (yb < top - 0.15) out.push({ u0: a, u1: a + w, y0: yb, y1: top + 0.5 });
      a += w; k++;
    }
    return out;
  };

  /** Emit a local box (u0..u1, y0..y1, v0..v1). */
  const lbox = (u0: number, u1: number, y0: number, y1: number, v0: number, v1: number, mat: MatId, faces = 63, tint = sp.tint, solid = true) => {
    const [ax, az] = W2(u0, v0), [bx, bz] = W2(u1, v1);
    const min = [Math.min(ax, bx), y0, Math.min(az, bz)], max = [Math.max(ax, bx), y1, Math.max(az, bz)];
    const wf = mapFaces(faces);
    S.box(min, max, mat, tint, wf, shade, solid);
  };

  /** A wall along u at v = v0..v0+th (or along v when `alongV`), from y0 to y1, with openings. */
  const wall = (alongV: boolean, a0: number, a1: number, c0: number, th: number, y0: number, y1: number, ops: Opening[], mat: MatId, endFaces: boolean) => {
    const cuts = new Set<number>([a0, a1]);
    for (const o of ops) { cuts.add(Math.max(a0, Math.min(a1, o.u0))); cuts.add(Math.max(a0, Math.min(a1, o.u1))); }
    const xs = [...cuts].sort((p, q) => p - q);
    for (let i = 0; i < xs.length - 1; i++) {
      const s0 = xs[i], s1 = xs[i + 1];
      if (s1 - s0 < 0.01) continue;
      const mid = (s0 + s1) / 2, col = ops.filter((o) => o.u0 <= mid && o.u1 >= mid).sort((p, q) => p.y0 - q.y0);
      let y = y0;
      const segs: [number, number][] = [];
      for (const o of col) { if (o.y0 > y) segs.push([y, o.y0]); y = Math.max(y, o.y1); }
      if (y1 > y) segs.push([y, y1]);
      const leftOpen = i > 0 || endFaces, rightOpen = i < xs.length - 2 || endFaces;
      for (const [ya, yb] of segs) {
        // Faces: both broad faces; ends only where they border an opening or the free wall end; top if it is the wall top or an opening's sill.
        let f = alongV ? LF.nu | LF.pu : LF.nv | LF.pv;
        const nearOpen = (s: number) => ops.some((o) => Math.abs(o.u1 - s) < 0.01 || Math.abs(o.u0 - s) < 0.01);
        if ((leftOpen && (i > 0 ? nearOpen(s0) : true))) f |= alongV ? LF.nv : LF.nu;
        if ((rightOpen && (i < xs.length - 2 ? nearOpen(s1) : true))) f |= alongV ? LF.pv : LF.pu;
        if (yb < y1 - 0.01) f |= LF.py;
        if (ya > y0 + 0.01) f |= LF.ny;
        if (alongV) lbox(c0, c0 + th, ya, yb, s0, s1, mat, f); else lbox(s0, s1, ya, yb, c0, c0 + th, mat, f);
      }
    }
  };

  // Interior paint: pastel lime-washed colours typical of Iraqi homes (light green, blue, cream, pink, white).
  const PAINTS: [number, number, number][] = [[0.82, 0.9, 0.78], [0.78, 0.86, 0.92], [0.95, 0.9, 0.78], [0.94, 0.84, 0.82], [0.92, 0.92, 0.9], [0.8, 0.88, 0.86]];
  const info: BuildingInfo = { id: sp.id, spec: sp, spots: [], roof: [], doors: [], roofY, debris: [], doorways: [], rooms: [], windows: [], paint: PAINTS[Math.floor(hash2(sp.id, 333) * PAINTS.length) % PAINTS.length] };
  S.paint = sp.hall ? null : info.paint;
  // Local axis → world axis: u runs along world x for orientations 0/2, along z for 1/3.
  const axisOf = (alongV: boolean): 'x' | 'z' => ((orient % 2 === 0) !== alongV ? 'x' : 'z');
  const doorway = (alongV: boolean, c0: number, th: number, o: Opening, floor: number, exterior: boolean) => {
    const m = (o.u0 + o.u1) / 2, [x, z] = alongV ? W2(c0 + th / 2, m) : W2(m, c0 + th / 2);
    info.doorways.push({ x, y: o.y0, z, w: o.u1 - o.u0, h: o.y1 - o.y0, axis: axisOf(alongV), floor, exterior });
  };
  const wellU0 = t, wellU1 = t + WELL_W, wellV0 = t, wellV1 = t + WELL_D;
  const hasStairs = sp.stairs && !sp.hall && W - 2 * t > WELL_W + 2.2 && D - 2 * t > WELL_D + 0.6;

  // ---------- exterior walls ----------
  const sides: [Side, boolean, number, number, number][] = [
    // side, alongV, a0, a1, c0 (inner offset)
    ['front', false, 0, W, 0], ['back', false, 0, W, D - t], ['left', true, t, D - t, 0], ['right', true, t, D - t, W - t],
  ];
  const winH = sp.modern ? 1.35 : 1.15, winW = sp.modern ? 1.3 : 0.95, sill = sp.modern ? 0.95 : 1.1;
  for (const [side, alongV, a0, a1, c0] of sides) {
    const ops: Opening[] = [];
    const party = sp.party.includes(side), len = a1 - a0;
    if (!party) {
      const span = alongV ? [t, D - t] : [t, W - t];
      // Entrances on the ground floor: front door (right of the stairwell); back door on big buildings.
      if (side === 'front') {
        if (sp.shops) {
          const bays = Math.max(1, Math.floor((W - 2 * t - (hasStairs ? WELL_W + 1.5 : 0)) / 3.6));
          const startU = hasStairs ? wellU1 + 1.4 : t + 0.4;
          for (let b = 0; b < bays; b++) { const u0 = startU + b * 3.6 + 0.3; if (u0 + 2.8 < W - t - 0.2) ops.push({ u0, u1: u0 + 2.8, y0: G, y1: G + 2.6 }); }
          if (hasStairs) ops.push({ u0: wellU1 + 0.15, u1: wellU1 + 1.15, y0: G, y1: G + 2.15 });
        } else {
          const du = hasStairs ? wellU1 + 0.35 : W / 2 - 0.55, dw = sp.hall ? 3.0 : 1.1;
          ops.push({ u0: du, u1: du + dw, y0: G, y1: G + (sp.hall ? 3.6 : 2.15) });
        }
      }
      if (side === 'back' && (W > 11 || sp.hall || sp.backDoor)) { const u0 = W * (0.55 + 0.2 * R); ops.push({ u0, u1: u0 + 1.0, y0: G, y1: G + 2.15 }); }
      // Windows per floor.
      const fl = sp.hall ? 1 : floors;
      for (let k = 0; k < fl; k++) {
        const yb = sp.hall ? G + fh * floors - 2.2 : Y(k) + sill, ye = yb + (sp.hall ? 1.0 : winH);
        const step = sp.modern ? 3.0 : 3.4 + hash2(sp.id, k + 5) * 1.2;
        const n = Math.floor((span[1] - span[0] - 0.8) / step);
        if (n < 1) continue;
        const off = span[0] + (span[1] - span[0] - (n - 1) * step) / 2;
        for (let i = 0; i < n; i++) {
          const c = off + i * step;
          if (!sp.modern && hash2(sp.id * 13 + i, k * 7 + side.length) < 0.25) continue;
          const u0 = c - winW / 2, u1 = c + winW / 2;
          if (ops.some((o) => o.y0 < ye && o.y1 > yb && o.u0 < u1 + 0.4 && o.u1 > u0 - 0.4)) continue;
          // No windows in the stairwell (front/left walls next to it).
          if (hasStairs && ((side === 'front' && u1 > wellU0 - 0.2 && u0 < wellU1 + 0.2) || (side === 'left' && u1 > wellV0 - 0.2 && u0 < wellV1 + 0.2))) continue;
          if (k === 0 && side === 'front' && sp.shops) continue;
          ops.push({ u0, u1, y0: yb, y1: k === 0 && !sp.modern && !sp.hall ? yb + winH * 0.8 : ye });
          if (!sp.hall) {
            const inner = c0 < 1 ? t + 0.6 : c0 - 0.6, wallMid = c0 + t / 2;
            const [x, z] = alongV ? W2(inner, c) : W2(c, inner), [ox, oz] = alongV ? W2(wallMid, c) : W2(c, wallMid), L = Math.hypot(ox - x, oz - z) || 1;
            info.windows.push({ x, y: yb - sill, z, nx: (ox - x) / L, nz: (oz - z) / L, sill, floor: k });
          }
        }
      }
    }
    void len;
    for (const b of breaches) if (b.side === side) ops.push(...b.ops);
    ops.push(...collapseOps(side));
    wall(alongV, a0, a1, c0, t, sp.y0 - 0.6, top, ops, sp.wall, !alongV);
    for (const o of ops) if (o.y0 <= G + 0.01 && o.y1 - o.y0 < 3) { const [x, z] = W2((o.u0 + o.u1) / 2, alongV ? 0 : c0 < 1 ? -0.6 : D + 0.6); info.doors.push([x, G, z]); if (o.u1 - o.u0 < 1.6) doorway(alongV, c0, t, o, 0, true); }
  }
  // Parapet coping (a thin cap with a small overhang) for a finished look.
  if (sp.parapet > 0.3) {
    const capT: [number, number, number] = [sp.tint[0] * 0.92, sp.tint[1] * 0.92, sp.tint[2] * 0.9];
    lbox(-0.04, W + 0.04, top, top + 0.06, -0.04, t + 0.04, 'concrete', 63, capT, false);
    if (!collapse) lbox(-0.04, W + 0.04, top, top + 0.06, D - t - 0.04, D + 0.04, 'concrete', 63, capT, false);
    else lbox(-0.04, collapse.u0, top, top + 0.06, D - t - 0.04, D + 0.04, 'concrete', 63, capT, false);
    lbox(-0.04, t + 0.04, top, top + 0.06, t + 0.04, D - t - 0.04, 'concrete', 63, capT, false);
    if (!collapse) lbox(W - t - 0.04, W + 0.04, top, top + 0.06, t + 0.04, D - t - 0.04, 'concrete', 63, capT, false);
    else lbox(W - t - 0.04, W + 0.04, top, top + 0.06, t + 0.04, collapse.v0, 'concrete', 63, capT, false);
  }
  // Floor bands on modern facades.
  if (sp.bands) for (let k = 1; k <= floors; k++) {
    const y = Y(k) - 0.22, bt: [number, number, number] = [0.78, 0.76, 0.72];
    lbox(-0.05, W + 0.05, y, y + 0.24, -0.05, 0, 'concrete', LF.nv | LF.py | LF.ny | LF.nu | LF.pu, bt, false);
    lbox(-0.05, W + 0.05, y, y + 0.24, D, D + 0.05, 'concrete', LF.pv | LF.py | LF.ny | LF.nu | LF.pu, bt, false);
  }

  // ---------- floors, stairs, partitions ----------
  const iu0 = t, iu1 = W - t, iv0 = t, iv1 = D - t;
  type R4 = [number, number, number, number]; // u0, u1, v0, v1
  const subtract = (rs: R4[], h: R4): R4[] => rs.flatMap((r) => {
    if (h[0] >= r[1] || h[1] <= r[0] || h[2] >= r[3] || h[3] <= r[2]) return [r];
    const out: R4[] = [], u0 = Math.max(r[0], h[0]), u1 = Math.min(r[1], h[1]);
    if (h[2] > r[2]) out.push([r[0], r[1], r[2], h[2]]);
    if (h[3] < r[3]) out.push([r[0], r[1], h[3], r[3]]);
    const v0 = Math.max(r[2], h[2]), v1 = Math.min(r[3], h[3]);
    if (u0 > r[0]) out.push([r[0], u0, v0, v1]);
    if (u1 < r[1]) out.push([u1, r[1], v0, v1]);
    return out.filter((q) => q[1] - q[0] > 0.02 && q[3] - q[2] > 0.02);
  });
  const slab = (k: number) => {
    const yt = k === 0 ? G : Y(k), yb = k === 0 ? sp.y0 - 0.4 : yt - 0.22;
    const mat: MatId = k === floors ? 'roof' : sp.floorMat;
    const f = LF.py | (k === 0 ? 0 : LF.ny) | LF.nu | LF.pu | LF.nv | LF.pv;
    let rs: R4[] = [[iu0, iu1, iv0, iv1]];
    if (k > 0 && hasStairs) rs = subtract(rs, [iu0, wellU1, wellV0 + LANDING, wellV1]);
    if (k === floors && collapse) rs = subtract(rs, [collapse.u0, iu1 + 0.01, collapse.v0, iv1 + 0.01]);
    for (const r of rs) lbox(r[0], r[1], yb, yt, r[2], r[3], mat, f);
  };
  for (let k = 0; k <= floors; k++) slab(k);
  if (sp.hall) {
    // Columns in big halls.
    if (W > 14 && D > 14) for (let cu = W / 3; cu < W - 2; cu += W / 3) for (let cv = D / 3; cv < D - 2; cv += D / 3) lbox(cu - 0.2, cu + 0.2, G, roofY - 0.22, cv - 0.2, cv + 0.2, 'concrete');
  }

  const stepH = fh / 2 / 9;
  const flight = (k: number, uA: number, rising: 1 | -1, yStart: number) => {
    // 9 steps of fh/18 rise over STAIR_RUN; rising +1 = towards +v from v=wellV0+LANDING, −1 = from the far end back.
    const vStart = rising > 0 ? wellV0 + LANDING : wellV0 + LANDING + STAIR_RUN, run = STAIR_RUN / 9;
    // One closed solid per flight: treads, risers, both sides, a sloped soffit (or the floor on the ground flight) and
    // the end faces — so it is solid from every angle.
    const vEnd = vStart + rising * STAIR_RUN, yEnd = yStart + 9 * stepH, solidBase = k === 0 && rising > 0;
    const sof = (v: number) => solidBase ? G : yStart - 0.06 + ((v - vStart) / (vEnd - vStart)) * (yEnd - 0.26 - yStart + 0.06);
    const uL = uA, uR = uA + STAIR_W, col: [number, number, number] = [0.8, 0.78, 0.74];
    const P = (u: number, y: number, v: number) => { const [x, z] = W2(u, v); return [x, y, z]; };
    const N = (nu: number, ny: number, nv: number): [number, number, number] => { const [ax, az] = W2(0, 0), [bx, bz] = W2(nu, nv); const x = bx - ax, z = bz - az, l = Math.hypot(x, ny, z) || 1; return [x / l, ny / l, z / l]; };
    for (let st = 0; st < 9; st++) {
      const va = vStart + rising * st * run, vb = va + rising * run, y0s = yStart + st * stepH, yTop = y0s + stepH;
      S.face('floor', [P(uL, yTop, va), P(uR, yTop, va), P(uR, yTop, vb), P(uL, yTop, vb)], N(0, 1, 0), col, shade);
      S.face('floor', [P(uL, y0s, va), P(uR, y0s, va), P(uR, yTop, va), P(uL, yTop, va)], N(0, 0, -rising), col, shade);
      for (const [u, nu] of [[uL, -1], [uR, 1]] as const) S.face('floor', [P(u, sof(va), va), P(u, sof(vb), vb), P(u, yTop, vb), P(u, yTop, va)], N(nu, 0, 0), col, shade);
    }
    if (!solidBase) {
      const dyS = sof(vEnd) - sof(vStart), dvS = vEnd - vStart;
      S.face('floor', [P(uL, sof(vStart), vStart), P(uR, sof(vStart), vStart), P(uR, sof(vEnd), vEnd), P(uL, sof(vEnd), vEnd)], N(0, -Math.abs(dvS), dyS * Math.sign(dvS)), col, shade);
      S.face('floor', [P(uL, sof(vStart), vStart), P(uR, sof(vStart), vStart), P(uR, yStart, vStart), P(uL, yStart, vStart)], N(0, 0, -rising), col, shade);
    }
    S.face('floor', [P(uL, sof(vEnd), vEnd), P(uR, sof(vEnd), vEnd), P(uR, yEnd, vEnd), P(uL, yEnd, vEnd)], N(0, 0, rising), col, shade);
    // Collider: a ramp along the flight.
    const ang = Math.atan2(fh / 2, STAIR_RUN), len = Math.hypot(fh / 2, STAIR_RUN);
    const cu = uA + STAIR_W / 2, cv = wellV0 + LANDING + STAIR_RUN / 2, cy = yStart + fh / 4 - 0.08;
    const [cx, cz] = W2(cu, cv);
    // Ramp tilt: rising along local +v by `rising`. Map the local direction to world.
    const [dx, dz] = (() => { const [ax, az] = W2(cu, cv + rising), d = [ax - cx, az - cz]; return d; })();
    const halfW = STAIR_W / 2, halfL = len / 2, halfT = 0.08;
    // Quaternion that maps local +Z → the rising world direction tilted up by ang: rotate about Y to face (dx,dz), then pitch.
    const yaw = Math.atan2(dx, dz), pitch = -ang;
    const cyw = Math.cos(yaw / 2), syw = Math.sin(yaw / 2), cp = Math.cos(pitch / 2), spp = Math.sin(pitch / 2);
    // q = qYaw * qPitch(X)
    const q: [number, number, number, number] = [cyw * spp, syw * cp, -syw * spp, cyw * cp];
    S.solid([cx, cy, cz], [halfW, halfT, halfL], 'concrete', q);
  };
  if (hasStairs) {
    for (let k = 0; k < floors; k++) {
      const yk = Y(k);
      flight(k, wellU0, 1, yk);
      // Mid landing (far end, full well width) and the flight back.
      lbox(wellU0, wellU1, yk + fh / 2 - 0.22, yk + fh / 2, wellV0 + LANDING + STAIR_RUN, wellV1, 'floor', 63, [0.8, 0.78, 0.74]);
      flight(k, wellU0 + STAIR_W, -1, yk + fh / 2);
      // Stairwell enclosure: divider along u = wellU1 (open at the landing) and the far end wall.
      const yb = yk, yt = Y(k + 1) - 0.22;
      lbox(wellU1, wellU1 + 0.14, yb, yt, wellV0 + LANDING, wellV1, sp.wall, 63);
      lbox(wellU0, wellU1 + 0.14, yb, yt, wellV1, wellV1 + 0.14, sp.wall, 63);
    }
    // Roof hut over the stairwell with a door onto the roof at the landing.
    const hy0 = roofY, hy1 = roofY + 2.5;
    wall(true, wellV0 - t, wellV1 + 0.14, wellU1, 0.16, hy0 - 0.22, hy1, [{ u0: wellV0 + 0.05, u1: wellV0 + LANDING - 0.05, y0: hy0, y1: hy0 + 2.1 }], sp.wall, true);
    wall(false, wellU0 - t, wellU1 + 0.16, wellV1 + 0.14, 0.16, hy0 - 0.22, hy1, [], sp.wall, true);
    if (sp.parapet < 2.4) {
      wall(false, wellU0 - t, wellU1 + 0.16, -0.0, t, top, hy1, [], sp.wall, true);
      wall(true, -0.0 + t, wellV1 + 0.3, 0, t, top, hy1, [], sp.wall, true);
    }
    lbox(wellU0 - t, wellU1 + 0.16, hy1, hy1 + 0.18, -0.0, wellV1 + 0.3, 'roof', 63);
  }
  // Partitions (not in halls or tiny buildings).
  if (!sp.hall && W > 6 && D > 6) {
    for (let k = 0; k < floors; k++) {
      const yb = Y(k), yt = Y(k + 1) - 0.22;
      const left = hasStairs ? wellU1 + 0.14 : iu0;
      const vA = hasStairs ? Math.max(wellV1 + 0.4, D * 0.55) : D * 0.5;
      if (vA < iv1 - 2.5) {
        const du = left + 0.4 + hash2(sp.id, k) * Math.max(0, iu1 - left - 2.2);
        const oA: Opening = { u0: du, u1: du + 0.95, y0: yb, y1: yb + 2.1 };
        wall(false, left, iu1, vA, 0.14, yb, yt, [oA], sp.wall, true); doorway(false, vA, 0.14, oA, k, false);
        if (hasStairs) { const oS: Opening = { u0: iu0 + 0.2, u1: iu0 + 1.15, y0: yb, y1: yb + 2.1 }; wall(false, iu0, left - 0.14, vA, 0.14, yb, yt, [oS], sp.wall, true); doorway(false, vA, 0.14, oS, k, false); }
      }
      if (iu1 - left > 7.5) {
        const uB = left + (iu1 - left) * (0.45 + 0.1 * hash2(sp.id, k + 9));
        const v1 = vA < iv1 - 2.5 ? vA : iv1, dv = iv0 + 0.6 + hash2(sp.id, k + 3) * Math.max(0, v1 - iv0 - 2.0);
        const oB: Opening = { u0: dv, u1: dv + 0.95, y0: yb, y1: yb + 2.1 };
        wall(true, iv0, v1, uB, 0.14, yb, yt, [oB], sp.wall, true); doorway(true, uB, 0.14, oB, k, false);
      }
      // Rooms of this floor (local rectangles → world) for furnishing.
      const hasA = vA < iv1 - 2.5, hasB = iu1 - left > 7.5, uBm = hasB ? left + (iu1 - left) * (0.45 + 0.1 * hash2(sp.id, k + 9)) : iu1;
      const room = (u0: number, u1: number, v0: number, v1: number, kind: BuildingInfo['rooms'][number]['kind']) => {
        if (u1 - u0 < 2 || v1 - v0 < 2) return;
        const r = (() => { const [ax, az] = W2(u0, v0), [bx, bz] = W2(u1, v1); return { x0: Math.min(ax, bx), z0: Math.min(az, bz), x1: Math.max(ax, bx), z1: Math.max(az, bz) }; })();
        if (k === floors - 1 && collapse && inCollapse((u0 + u1) / 2, (v0 + v1) / 2)) return;
        info.rooms.push({ ...r, y: yb, floor: k, kind });
      };
      const front: BuildingInfo['rooms'][number]['kind'] = k === 0 ? 'living' : 'bedroom';
      room(left + 0.1, (hasB ? uBm : iu1) - 0.1, iv0, (hasA ? vA : iv1) - 0.1, front);
      if (hasB) room(uBm + 0.1, iu1, iv0, (hasA ? vA : iv1) - 0.1, k === 0 ? 'kitchen' : 'bedroom');
      if (hasA) room(iu0, iu1, vA + 0.15, iv1, k === 0 ? (hasB ? 'store' : 'kitchen') : 'living');
    }
  }

  // ---------- gameplay points ----------
  const left = hasStairs ? wellU1 + 0.6 : iu0 + 0.6;
  for (let k = 0; k < (sp.hall ? 1 : floors); k++) {
    for (const [fu, fv] of [[0.3, 0.75], [0.8, 0.25], [0.75, 0.8], [0.25, 0.3]]) {
      const u = left + (iu1 - 0.6 - left) * fu, v = iv0 + 0.6 + (iv1 - iv0 - 1.2) * fv;
      const [x, z] = W2(u, v);
      if (!(k === floors - 1 && inCollapse(u, v))) info.spots.push([x, Y(k), z, k]);
    }
  }
  if (hasStairs) for (const [fu, fv] of [[0.8, 0.2], [0.2, 0.85], [0.85, 0.85]]) { const u = t + 0.8 + (W - 2 * t - 1.6) * fu, v = t + 0.8 + (D - 2 * t - 1.6) * fv, [x, z] = W2(u, v); if (!inCollapse(u, v)) info.roof.push([x, roofY, z]); }
  if (collapse) {
    // Rubble where the roof came down (inside, on the top floor) and outside below the broken corner.
    const lowY = floors > 1 ? Y(floors - 1) : G;
    for (const [fu, fv] of [[0.55, 0.6], [0.8, 0.85]]) { const [x, z] = W2(collapse.u0 + (iu1 - collapse.u0) * fu, collapse.v0 + (iv1 - collapse.v0) * fv); info.debris.push([x, lowY, z, 0]); }
    const [ox, oz] = W2(W + 1.2, D * 0.8), [px, pz] = W2(W * 0.8, D + 1.2);
    info.debris.push([ox, sp.y0, oz, 1], [px, sp.y0, pz, 1]);
  }
  S.paint = null;
  return info;
}

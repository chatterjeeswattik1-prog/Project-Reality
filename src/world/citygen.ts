// Map generator for "Al Zahran", a fictional mid-sized Iraqi river town (1.3 km playable, 13×13 grid of 100 m).
// Layout (north is −z): canal + palm groves + farmland in the west; old town north of the boulevard with the souk and
// the Grand Mosque; the war-damaged southern old town ("the Ruins"); a modern apartment district (New Town) and a civic
// district east of the avenue; industrial zone in the south; walled compounds on the northern outskirts; the US FOB on
// the eastern edge. Deterministic from the seed. Pure data: no three.js.
import { building, type BuildingInfo, type BuildingSpec, type Side } from './building';
import { F, Sink, type MatId } from './sink';
import { hash2, mulberry, pick, range } from '../core/rng';
import { CANAL_W, canalX, groundH, HALF } from './terrain';

export interface Rect { x0: number; z0: number; x1: number; z1: number }
export type RoadKind = 'boulevard' | 'avenue' | 'street' | 'lane' | 'alley' | 'dirt' | 'market';
export interface Road extends Rect { kind: RoadKind }
export interface Prop { id: string; x: number; y: number; z: number; ry: number; s?: number; solid?: boolean; /** Placed on the ground (no explicit height). */ ground?: boolean }
export type District = 'old' | 'ruins' | 'new' | 'civic' | 'industrial' | 'outskirts' | 'rural' | 'fob';
export interface Spot { x: number; y: number; z: number; b: number; district: District; floor: number }
export interface City {
  seed: number;
  /** Set when only part of the map was built (test areas). */
  area?: Rect;
  sink: Sink;
  buildings: BuildingInfo[];
  districtOf: Map<number, District>;
  roads: Road[];
  props: Prop[];
  /** Ground mask, 1 px per MASK_RES m over [−MASK_HALF, MASK_HALF]²; R dirt/track, G gravel/rubble, B field, A damp. */
  mask: Uint8Array;
  fob: { rect: Rect; spawns: [number, number, number][]; vehicles: { id: string; x: number; z: number; ry: number }[]; flag: [number, number] };
  insBase: { rect: Rect; spawns: [number, number, number][]; vehicles: { id: string; x: number; z: number; ry: number }[] };
  cacheSpots: Spot[];
  roofSpots: Spot[];
  landmarks: { name: string; x: number; z: number }[];
  bridges: Rect[];
}
export const MASK_HALF = 704, MASK_RES = 1, MASK_N = (2 * MASK_HALF) / MASK_RES;

const WALL_SETS: Record<string, MatId[]> = {
  old: ['clay', 'plaster_a', 'plaster_b', 'plastered', 'sandstone', 'brick', 'clay'],
  ruins: ['damaged', 'clay', 'plaster_b', 'cracked', 'brick', 'sandstone'],
  new: ['concrete', 'plaster_a', 'plastered', 'cracked', 'block'],
  civic: ['concrete', 'plaster_a', 'sandstone', 'plastered'],
  industrial: ['block', 'concrete', 'cracked'],
  outskirts: ['clay', 'plaster_a', 'plaster_b', 'plastered', 'brick'],
};
const TINTS: [number, number, number][] = [
  [1, 1, 1], [1, 0.95, 0.86], [0.96, 0.9, 0.8], [0.92, 0.9, 0.86], [1, 0.93, 0.8], [0.98, 0.97, 0.94], [0.9, 0.84, 0.74],
];
const RARE_TINTS: [number, number, number][] = [[0.84, 0.92, 0.95], [0.9, 0.96, 0.86], [1, 0.88, 0.82]];

export interface CityOptions { /** Build only this part of the map (small test areas for weak PCs). */ area?: Rect }

export function generateCity(seed = 1337, opts: CityOptions = {}): City {
  const area = opts.area ?? null;
  const rng = mulberry(seed);
  const S = new Sink();
  // Test areas: a building belongs to the area when its centre is inside, and the play boundary then grows to enclose
  // those buildings whole (the HESCO line must never cut through a house). Ground and roads are built a little wider.
  const GROW = 30;
  S.clip = area && { x0: area.x0 - GROW, z0: area.z0 - GROW, x1: area.x1 + GROW, z1: area.z1 + GROW };
  const play: Rect | null = area && { ...area }, footprints: Rect[] = [];
  const roads: Road[] = [], props: Prop[] = [], buildings: BuildingInfo[] = [], districtOf = new Map<number, District>();
  const mask = new Uint8Array(MASK_N * MASK_N * 4);
  const landmarks: City['landmarks'] = [], bridges: Rect[] = [];
  let nextId = 0;

  // ---------- helpers ----------
  const paint = (r: Rect, ch: number, v: number, feather = 1.5, noise = 0) => {
    const i0 = Math.max(0, Math.floor((r.x0 - feather + MASK_HALF) / MASK_RES)), i1 = Math.min(MASK_N - 1, Math.ceil((r.x1 + feather + MASK_HALF) / MASK_RES));
    const j0 = Math.max(0, Math.floor((r.z0 - feather + MASK_HALF) / MASK_RES)), j1 = Math.min(MASK_N - 1, Math.ceil((r.z1 + feather + MASK_HALF) / MASK_RES));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = i * MASK_RES - MASK_HALF, z = j * MASK_RES - MASK_HALF;
      const dx = Math.max(r.x0 - x, 0, x - r.x1), dz = Math.max(r.z0 - z, 0, z - r.z1), d = Math.hypot(dx, dz);
      let a = d <= 0 ? 1 : Math.max(0, 1 - d / Math.max(0.01, feather));
      if (noise) a *= 1 - noise * hash2(i, j, 99);
      const k = (j * MASK_N + i) * 4 + ch;
      mask[k] = Math.max(mask[k], Math.round(v * a * 255));
    }
  };
  const paintDisc = (x: number, z: number, r: number, ch: number, v: number) => paint({ x0: x, z0: z, x1: x, z1: z }, ch, v, r, 0.3);
  const road = (r: Rect, kind: RoadKind) => {
    roads.push({ ...r, kind });
    if (kind === 'lane' || kind === 'alley' || kind === 'dirt' || kind === 'market') paint(r, 0, kind === 'market' ? 0.85 : 0.75, 1.2, 0.25);
  };
  const H = (x: number, z: number) => groundH(x, z);
  const prop = (id: string, x: number, z: number, ry = 0, s = 1, y?: number, solid = false) => {
    if (area && (x < area.x0 - GROW || x > area.x1 + GROW || z < area.z0 - GROW || z > area.z1 + GROW)) return;
    props.push({ id, x, y: y ?? H(x, z), z, ry, s, solid, ...(y === undefined ? { ground: true } : {}) });
  };
  const footY = (r: Rect) => Math.max(H(r.x0, r.z0), H(r.x1, r.z0), H(r.x0, r.z1), H(r.x1, r.z1), H((r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2));
  const tintFor = (id: number): [number, number, number] => hash2(id, 3) < 0.07 ? pick(() => hash2(id, 4), RARE_TINTS) : pick(() => hash2(id, 5), TINTS);
  const overlaps = (a: Rect, b: Rect) => a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0;
  const shrink = (r: Rect, d: number): Rect => ({ x0: r.x0 + d, z0: r.z0 + d, x1: r.x1 - d, z1: r.z1 - d });

  /** A free-standing wall along x or z (compound/courtyard walls) with optional gaps [a0, a1] along its length. */
  const fence = (x0: number, z0: number, x1: number, z1: number, h: number, th: number, mat: MatId, tint: [number, number, number], gaps: [number, number][] = []) => {
    const alongX = Math.abs(x1 - x0) >= Math.abs(z1 - z0);
    const a0 = alongX ? Math.min(x0, x1) : Math.min(z0, z1), a1 = alongX ? Math.max(x0, x1) : Math.max(z0, z1), c = alongX ? z0 : x0;
    const cuts = [a0, ...gaps.flat().filter((g) => g > a0 && g < a1).sort((p, q) => p - q), a1];
    for (let i = 0; i < cuts.length - 1; i += 2) {
      const s0 = cuts[i], s1 = cuts[i + 1];
      if (s1 - s0 < 0.05) continue;
      const mid = (s0 + s1) / 2, y = alongX ? Math.min(H(s0, c), H(s1, c), H(mid, c)) : Math.min(H(c, s0), H(c, s1), H(c, mid));
      const min = alongX ? [s0, y - 0.5, c - th / 2] : [c - th / 2, y - 0.5, s0], max = alongX ? [s1, y + h, c + th / 2] : [c + th / 2, y + h, s1];
      S.box(min, max, mat, tint, F.all ^ F.ny);
      S.box([min[0] - 0.03, y + h, min[2] - 0.03], [max[0] + 0.03, y + h + 0.07, max[2] + 0.03], 'concrete', [0.85, 0.83, 0.8], F.all ^ F.ny, undefined, false);
    }
  };
  const compoundWall = (r: Rect, h: number, mat: MatId, tint: [number, number, number], gate: { side: 0 | 1 | 2 | 3; at: number; w: number } | null, th = 0.25) => {
    const g = (side: number): [number, number][] => (gate && gate.side === side ? [[gate.at - gate.w / 2, gate.at + gate.w / 2]] : []);
    fence(r.x0, r.z0, r.x1, r.z0, h, th, mat, tint, g(0));
    fence(r.x1, r.z0, r.x1, r.z1, h, th, mat, tint, g(1));
    fence(r.x0, r.z1, r.x1, r.z1, h, th, mat, tint, g(2));
    fence(r.x0, r.z0, r.x0, r.z1, h, th, mat, tint, g(3));
  };

  /** Lot frame: local (u across the front, v back from the front) → world, as in building.ts. */
  const lotFrame = (r: Rect, orient: number) => {
    const W = orient % 2 === 0 ? r.x1 - r.x0 : r.z1 - r.z0, D = orient % 2 === 0 ? r.z1 - r.z0 : r.x1 - r.x0;
    const to = (u: number, v: number): [number, number] => orient === 0 ? [r.x0 + u, r.z0 + v] : orient === 1 ? [r.x1 - v, r.z0 + u] : orient === 2 ? [r.x1 - u, r.z1 - v] : [r.x0 + v, r.z1 - u];
    const rect = (u0: number, v0: number, u1: number, v1: number): Rect => { const [ax, az] = to(u0, v0), [bx, bz] = to(u1, v1); return { x0: Math.min(ax, bx), z0: Math.min(az, bz), x1: Math.max(ax, bx), z1: Math.max(az, bz) }; };
    return { W, D, to, rect };
  };
  /** World direction (−x, +x, −z, +z) → local side for an orientation. */
  const localSide = (orient: number, dir: '-x' | '+x' | '-z' | '+z'): Side => {
    const t: Record<number, Record<string, Side>> = {
      0: { '-z': 'front', '+z': 'back', '-x': 'left', '+x': 'right' },
      1: { '+x': 'front', '-x': 'back', '-z': 'left', '+z': 'right' },
      2: { '+z': 'front', '-z': 'back', '+x': 'left', '-x': 'right' },
      3: { '-x': 'front', '+x': 'back', '+z': 'left', '-z': 'right' },
    };
    return t[orient][dir];
  };

  interface Lot extends Rect { orient: 0 | 1 | 2 | 3; party: Side[] }
  /** Cut a block into lots that all touch the block edge: columns along the long axis, back-to-back when deep. */
  const lotsOf = (b: Rect, minW: number, maxW: number, maxDepth: number): Lot[] => {
    const out: Lot[] = [], w = b.x1 - b.x0, d = b.z1 - b.z0, longX = w >= d;
    const L = longX ? w : d, Sd = longX ? d : w, deep = Sd > maxDepth * 1.6;
    const cuts = [0];
    while (L - cuts[cuts.length - 1] > maxW) cuts.push(cuts[cuts.length - 1] + range(rng, minW, maxW));
    if (cuts.length > 1 && L - cuts[cuts.length - 1] < minW * 0.7) cuts.pop();
    cuts.push(L);
    for (let i = 0; i < cuts.length - 1; i++) {
      const a0 = cuts[i], a1 = cuts[i + 1], first = i === 0, last = i === cuts.length - 2;
      const halves: [number, number, boolean][] = deep ? [[0, Sd / 2, true], [Sd / 2, Sd, false]] : [[0, Sd, rng() < 0.5]];
      for (const [s0, s1, low] of halves) {
        const r: Rect = longX ? { x0: b.x0 + a0, x1: b.x0 + a1, z0: b.z0 + s0, z1: b.z0 + s1 } : { z0: b.z0 + a0, z1: b.z0 + a1, x0: b.x0 + s0, x1: b.x0 + s1 };
        const orient: 0 | 1 | 2 | 3 = longX ? (low ? 0 : 2) : (low ? 3 : 1);
        const party: Side[] = [];
        if (!first) party.push(localSide(orient, longX ? '-x' : '-z'));
        if (!last) party.push(localSide(orient, longX ? '+x' : '+z'));
        if (deep) party.push('back');
        out.push({ ...shrink(r, 0.03), orient, party });
      }
    }
    return out;
  };

  const addBuilding = (spec: Omit<BuildingSpec, 'id'>, district: District) => {
    const id = nextId++;
    S.tag = id; S.ext = 2; S.cx = (spec.x0 + spec.x1) / 2; S.cz = (spec.z0 + spec.z1) / 2;
    const cxb = (spec.x0 + spec.x1) / 2, czb = (spec.z0 + spec.z1) / 2;
    const inArea = !area || (cxb > area.x0 && cxb < area.x1 && czb > area.z0 && czb < area.z1);
    footprints.push({ x0: spec.x0, z0: spec.z0, x1: spec.x1, z1: spec.z1 });
    if (inArea && play) { play.x0 = Math.min(play.x0, spec.x0 - 3); play.z0 = Math.min(play.z0, spec.z0 - 3); play.x1 = Math.max(play.x1, spec.x1 + 3); play.z1 = Math.max(play.z1, spec.z1 + 3); }
    S.skip = !inArea;
    const info = building(S, { ...spec, id });
    S.tag = -1; S.ext = 0; S.skip = false;
    // Far LOD shell (ruins lose their top to suggest the damage). Outside a test area only the shell is built, always
    // drawn, so the rest of the town still stands on the horizon.
    const shellTop = info.roofY + spec.parapet * (spec.damage > 0.5 ? 0 : 1) - (spec.damage > 0.6 ? spec.fh * 0.6 : 0);
    S.shell([spec.x0, spec.y0 - 0.5, spec.z0], [spec.x1, shellTop, spec.z1], spec.wall, spec.tint, 'roof', S.cx, S.cz, inArea ? 3 : 0);
    if (!inArea) {
      // Outside a test area the building is only its shell: make it a solid block, or players and bullets would pass
      // through the walls they can see (some shells reach into the play area).
      const ext = S.clip; S.clip = null;
      S.solid([(spec.x0 + spec.x1) / 2, (spec.y0 - 0.5 + shellTop) / 2, (spec.z0 + spec.z1) / 2], [(spec.x1 - spec.x0) / 2, (shellTop - spec.y0 + 0.5) / 2, (spec.z1 - spec.z0) / 2], 'masonry');
      S.clip = ext;
      districtOf.set(id, district); return info;
    }
    furnish(info);
    // Rubble where the building has partly collapsed.
    for (const [x, y, z, out] of info.debris) prop(out ? pick(rng, ['rubble_c', 'rubble_b']) : pick(rng, ['rubble_a', 'rubble_b', 'debris_slab']), x, z, rng() * 6.28, out ? range(rng, 0.7, 1.0) : range(rng, 0.55, 0.8), out ? undefined : y, true);
    buildings.push(info); districtOf.set(id, district);
    // Rooftop clutter.
    const roofR = mulberry(id * 7 + 1);
    if (spec.floors >= 1 && !spec.hall && spec.parapet > 0.3 && spec.damage < 0.6) {
      const fr = lotFrame(spec, spec.orient), ry = (spec.orient * Math.PI) / 2;
      const ru = (f: number) => spec.t + 0.8 + (fr.W - 2 * spec.t - 1.6) * f, rv = (f: number) => spec.t + 0.8 + (fr.D - 2 * spec.t - 1.6) * f;
      const roofY = info.roofY;
      const place = (id2: string, fu: number, fv: number, rot = 0) => { const [x, z] = fr.to(ru(fu), rv(fv)); prop(id2, x, z, ry + rot, 1, roofY, true); };
      if (roofR() < 0.75) place(roofR() < 0.7 ? 'water_tank' : 'water_tank_steel', 0.85, 0.15 + roofR() * 0.2);
      if (roofR() < 0.45) place('sat_dish', 0.6 + roofR() * 0.3, 0.9, Math.PI + roofR() - 0.5);
      if (roofR() < 0.3) place('antenna_tv', 0.9, 0.7);
      if (roofR() < 0.15) place('solar_heater', 0.5, 0.6);
      if (roofR() < 0.2) place(roofR() < 0.5 ? 'roof_clutter' : 'clothesline', 0.55, 0.45, roofR() * 3);
      if (roofR() < 0.3) place('generator_small', 0.7, 0.85);
    }
    return info;
  };

  /**
   * Furnish a building's rooms (Iraqi homes, 2004 — after "Six Days in Fallujah"): items stand against the walls facing
   * into the room, clear of doorways and of each other; rugs, tables and fans go in the middle.
   */
  const furnish = (info: BuildingInfo) => {
    const r = mulberry(info.id * 131 + 7), sp = info.spec;
    if (sp.hall) return;
    for (const room of info.rooms) {
      const placed: [number, number, number, number][] = [];
      const free = (x0: number, z0: number, x1: number, z1: number) => !placed.some((q) => x0 < q[2] && x1 > q[0] && z0 < q[3] && z1 > q[1])
        && !info.doorways.some((d) => d.floor === room.floor && Math.hypot(d.x - (x0 + x1) / 2, d.z - (z0 + z1) / 2) < 1.2 + Math.max(x1 - x0, z1 - z0) / 2);
      /** Against a wall: side 0 north (z0), 1 east (x1), 2 south (z1), 3 west (x0); w along the wall, d out from it. */
      const wallItem = (id: string, w: number, d: number, solid = true, y = room.y) => {
        for (let tries = 0; tries < 6; tries++) {
          const side = Math.floor(r() * 4), alongX = side % 2 === 0, len = alongX ? room.x1 - room.x0 : room.z1 - room.z0;
          if (len < w + 0.4) continue;
          const t = 0.2 + w / 2 + r() * (len - w - 0.4);
          const x = side === 1 ? room.x1 - d / 2 : side === 3 ? room.x0 + d / 2 : room.x0 + t, z = side === 0 ? room.z0 + d / 2 : side === 2 ? room.z1 - d / 2 : room.z0 + t;
          const hx = alongX ? w / 2 : d / 2, hz = alongX ? d / 2 : w / 2;
          if (!free(x - hx, z - hz, x + hx, z + hz)) continue;
          placed.push([x - hx, z - hz, x + hx, z + hz]);
          prop(id, x, z, [Math.PI, Math.PI / 2, 0, -Math.PI / 2][side], 1, y, solid);
          return true;
        }
        return false;
      };
      const centre = (id: string, w: number, d: number, solid = false) => {
        const x = (room.x0 + room.x1) / 2, z = (room.z0 + room.z1) / 2, rot = r() < 0.5 ? 0 : Math.PI / 2, hx = rot ? d / 2 : w / 2, hz = rot ? w / 2 : d / 2;
        if (room.x1 - room.x0 < 2 * hx + 1 || room.z1 - room.z0 < 2 * hz + 1) return;
        if (solid) placed.push([x - hx, z - hz, x + hx, z + hz]);
        prop(id, x, z, rot, 1, room.y + 0.005, solid);
      };
      const ceiling = room.y + sp.fh - 0.22;
      switch (room.kind) {
        case 'living':
          centre('rug_large', 3, 2);
          if (r() < 0.6) wallItem('floor_cushions', 3.0, 0.9); else wallItem('sofa_old', 2.05, 0.9);
          if (r() < 0.6) wallItem('floor_cushions', 3.0, 0.9);
          wallItem('tv_crt_stand', 0.9, 0.55);
          if (r() < 0.4) wallItem('side_table_lamp', 0.45, 0.45);
          if (r() < 0.4) wallItem('wall_shelf_items', 1.0, 0.25, false, room.y + 1.6);
          if (r() < 0.5) wallItem('armchair', 0.85, 0.85);
          if (r() < 0.5) centre('coffee_table_low', 1.0, 0.6, true);
          if (r() < 0.5) wallItem('picture_frame', 0.6, 0.05, false, room.y + 1.5);
          if (r() < 0.6) prop('ceiling_fan', (room.x0 + room.x1) / 2, (room.z0 + room.z1) / 2, 0, 1, ceiling);
          break;
        case 'kitchen':
          wallItem('kitchen_counter', 2.05, 0.62);
          wallItem('fridge_old', 0.7, 0.7);
          if (wallItem('gas_stove', 0.9, 0.56)) wallItem('gas_cylinder', 0.35, 0.35);
          if (r() < 0.7) wallItem('kitchen_shelf', 0.9, 0.35);
          if (r() < 0.5) centre('table_dining', 1.45, 1.8, true);
          if (r() < 0.4) wallItem('water_cooler', 0.35, 0.4);
          prop('bulb_hanging', (room.x0 + room.x1) / 2, (room.z0 + room.z1) / 2, 0, 1, ceiling);
          break;
        case 'bedroom':
          wallItem(r() < 0.55 ? 'bed_double' : 'mattress_floor', 1.7, 2.1);
          wallItem('wardrobe', 1.26, 0.62);
          if (r() < 0.5) wallItem('dresser_mirror', 1.0, 0.5);
          if (r() < 0.6) wallItem('clothes_pile', 1.15, 0.9, false);
          if (r() < 0.5) centre('rug_small', 1.6, 1.0);
          if (r() < 0.3) wallItem('prayer_mat', 0.7, 1.2, false);
          if (r() < 0.4) prop('ceiling_fan', (room.x0 + room.x1) / 2, (room.z0 + room.z1) / 2, 0, 1, ceiling);
          break;
        case 'shop':
          // A grocer's / general store: shelves of goods along the walls, a counter, stock in crates and boxes.
          wallItem('kitchen_counter', 2.05, 0.62);
          wallItem('kitchen_shelf', 0.9, 0.35); wallItem('kitchen_shelf', 0.9, 0.35);
          if (r() < 0.7) wallItem('kitchen_shelf', 0.9, 0.35);
          wallItem('plastic_crates', 1.2, 0.95);
          wallItem('cardboard_boxes', 1.7, 0.6);
          if (r() < 0.6) wallItem('water_cooler', 0.35, 0.4);
          if (r() < 0.5) wallItem('gas_cylinder', 0.35, 0.35);
          if (r() < 0.5) wallItem('fridge_old', 0.7, 0.7);
          if (r() < 0.6) prop('bulb_hanging', (room.x0 + room.x1) / 2, (room.z0 + room.z1) / 2, 0, 1, ceiling);
          break;
        case 'store':
          wallItem('cardboard_boxes', 1.7, 0.6);
          if (r() < 0.6) wallItem('plastic_crates', 1.2, 0.95);
          if (r() < 0.5) wallItem('broken_furniture', 2.0, 1.5);
          if (r() < 0.4) wallItem('shoes_rack', 0.8, 0.7);
          break;
      }
      // Big rooms get more along the walls (about one more piece per 12 m²); damaged houses more clutter and junk.
      const FILL: Record<string, [string, number, number, boolean][]> = {
        living: [['floor_cushions', 3.0, 0.9, true], ['armchair', 0.85, 0.85, true], ['side_table_lamp', 0.45, 0.45, true], ['wall_shelf_items', 1.0, 0.25, false], ['water_cooler', 0.35, 0.4, true], ['rug_small', 1.5, 0.9, false]],
        kitchen: [['plastic_crates', 1.2, 0.95, true], ['cardboard_boxes', 1.7, 0.6, true], ['gas_cylinder', 0.35, 0.35, true], ['water_cooler', 0.35, 0.4, true]],
        bedroom: [['mattress_floor', 0.95, 1.95, true], ['clothes_pile', 1.15, 0.9, false], ['cardboard_boxes', 1.7, 0.6, true], ['prayer_mat', 0.7, 1.2, false]],
        store: [['cardboard_boxes', 1.7, 0.6, true], ['plastic_crates', 1.2, 0.95, true], ['broken_furniture', 2.0, 1.5, true], ['gas_cylinder', 0.35, 0.35, true]],
        shop: [['kitchen_shelf', 0.9, 0.35, true], ['cardboard_boxes', 1.7, 0.6, true], ['plastic_crates', 1.2, 0.95, true], ['oil_drum', 0.6, 0.6, true]],
      };
      const fill = FILL[room.kind] ?? [], extra = Math.floor(((room.x1 - room.x0) * (room.z1 - room.z0)) / 12) - 1 + (sp.damage > 0.3 ? 1 : 0);
      for (let i = 0; i < extra && fill.length; i++) {
        const [fid, w, d, solid] = fill[Math.floor(r() * fill.length)];
        wallItem(fid, w, d, solid, fid === 'wall_shelf_items' ? room.y + 1.6 : room.y);
      }
      if (sp.damage > 0.3 && r() < 0.6) wallItem('broken_furniture', 2.0, 1.5);
      // Insurgent strongpoints: a mattress against a wall as improvised cover (more in war-damaged buildings).
      if (r() < (sp.damage > 0 ? 0.4 : 0.12)) wallItem('mattress_upright', 0.92, 0.55);
    }
  };

  const houseSpec = (lot: Lot, district: District, floors: number, depthFrac: number, shops: boolean, damage: number): { spec: Omit<BuildingSpec, 'id'>; yard: Rect | null; fr: ReturnType<typeof lotFrame> } => {
    const fr = lotFrame(lot, lot.orient), Db = Math.max(7.5, Math.min(fr.D, fr.D * depthFrac));
    const fp = fr.rect(0, 0, fr.W, Db), id = nextId;
    const wall = pick(() => hash2(id, 8), WALL_SETS[district === 'fob' || district === 'rural' ? 'outskirts' : district]);
    const spec: Omit<BuildingSpec, 'id'> = {
      ...fp, orient: lot.orient, y0: footY(fp), floors, fh: 3.05, t: district === 'new' || district === 'civic' ? 0.25 : 0.3,
      wall, tint: tintFor(id), floorMat: hash2(id, 9) < 0.3 ? 'tiles' : hash2(id, 9) < 0.7 ? 'checker' : 'floor', party: lot.party, shops, damage, stairs: true,
      parapet: 1.0 + (hash2(id, 10) < 0.3 ? 0.4 : 0), backDoor: fr.D - Db > 3,
    };
    return { spec, yard: fr.D - Db > 3 ? fr.rect(0, Db, fr.W, fr.D) : null, fr };
  };

  // ---------- major roads ----------
  const cxN = canalX(-HALF), cxS = canalX(HALF); void cxN; void cxS;
  road({ x0: -HALF - 60, z0: -13, x1: HALF + 60, z1: 13 }, 'boulevard');
  road({ x0: 100, z0: -520, x1: 118, z1: 520 }, 'avenue');
  road({ x0: -HALF - 60, z0: -330, x1: 512, z1: -318 }, 'street');
  road({ x0: -345, z0: 258, x1: 512, z1: 270 }, 'street');
  road({ x0: 500, z0: -520, x1: 512, z1: 520 }, 'street');
  road({ x0: -344, z0: -640, x1: -334, z1: 640 }, 'dirt');
  for (const zc of [0, -324]) {
    const xc = canalX(zc);
    bridges.push({ x0: xc - CANAL_W / 2 - 8, z0: zc - (zc === 0 ? 14 : 7), x1: xc + CANAL_W / 2 + 8, z1: zc + (zc === 0 ? 14 : 7) });
  }
  // Bridge decks, kerbs and railings.
  for (const b of bridges) {
    S.box([b.x0, -0.6, b.z0], [b.x1, 0.06, b.z1], 'concrete', [0.85, 0.83, 0.8], F.all);
    for (const z of [b.z0, b.z1 - 0.3]) S.box([b.x0, 0.06, z], [b.x1, 0.95, z + 0.3], 'concrete', [0.82, 0.8, 0.76], F.all);
    const xc = (b.x0 + b.x1) / 2;
    for (const dx of [-CANAL_W / 4, CANAL_W / 4]) S.box([xc + dx - 0.6, -3.6, b.z0 + 1], [xc + dx + 0.6, -0.6, b.z1 - 1], 'concrete', [0.75, 0.73, 0.7], F.sides);
  }

  // ---------- reserved landmarks ----------
  const mosqueR: Rect = { x0: -150, z0: -212, x1: -86, z1: -150 };
  const plazaS: Rect = { x0: -140, z0: 112, x1: -90, z1: 152 };
  const souk: Rect = { x0: -332, z0: -96, x1: 100, z1: -88 };
  road(souk, 'market');
  const reserved = [mosqueR, plazaS];

  // ---------- old town (north) and the Ruins (south) ----------
  const oldTown = (area: Rect, district: District, ruinRate: number) => {
    const blocks: Rect[] = [];
    const split = (q: Rect, depth: number) => {
      const w = q.x1 - q.x0, d = q.z1 - q.z0;
      if ((w < 50 && d < 42) || depth > 8) { blocks.push(q); return; }
      const splitX = w / 50 > d / 42, width = depth < 2 ? range(rng, 6.5, 8) : range(rng, 3.6, 5.2), kind: RoadKind = depth < 2 ? 'lane' : 'alley';
      const t = range(rng, 0.38, 0.62);
      if (splitX) { const xm = q.x0 + w * t; road({ x0: xm - width / 2, z0: q.z0, x1: xm + width / 2, z1: q.z1 }, kind); split({ ...q, x1: xm - width / 2 }, depth + 1); split({ ...q, x0: xm + width / 2 }, depth + 1); }
      else { const zm = q.z0 + d * t; road({ z0: zm - width / 2, x0: q.x0, z1: zm + width / 2, x1: q.x1 }, kind); split({ ...q, z1: zm - width / 2 }, depth + 1); split({ ...q, z0: zm + width / 2 }, depth + 1); }
    };
    split(area, 0);
    for (const b of blocks) {
      if (b.x1 - b.x0 < 8 || b.z1 - b.z0 < 8) continue;
      for (const lot of lotsOf(b, 10, 17, 19)) {
        if (reserved.some((r) => overlaps(r, lot)) || overlaps(souk, lot)) continue;
        const roll = rng();
        const nearSouk = Math.abs((lot.z0 + lot.z1) / 2 - (souk.z0 + souk.z1) / 2) < 30;
        if (district === 'ruins' && roll < 0.08) {
          // Flattened: a rubble field.
          paint(lot, 1, 0.9, 1.5, 0.3);
          const n = 2 + Math.floor(rng() * 3);
          for (let i = 0; i < n; i++) prop(pick(rng, ['rubble_a', 'rubble_b', 'rubble_c', 'debris_slab']), range(rng, lot.x0 + 2, lot.x1 - 2), range(rng, lot.z0 + 2, lot.z1 - 2), rng() * 6.28, range(rng, 0.8, 1.3), undefined, true);
          continue;
        }
        if (roll < 0.05) { paint(lot, 0, 0.6, 1, 0.4); if (rng() < 0.5) prop('palm_' + pick(rng, ['a', 'b', 'c']), (lot.x0 + lot.x1) / 2, (lot.z0 + lot.z1) / 2, rng() * 6.28); continue; }
        const floors = rng() < 0.25 ? 1 : rng() < 0.75 ? 2 : 3;
        const damage = rng() < ruinRate ? range(rng, 0.35, 1) : 0;
        const { spec, yard, fr } = houseSpec(lot, district, floors, range(rng, 0.58, 0.8), nearSouk && rng() < 0.7, damage);
        const info = addBuilding(spec, district);
        if (yard) {
          // Courtyard walls (back and sides); a gate in the back wall when the back is open.
          const backOpen = !lot.party.includes('back'), wallH = 2.6;
          const [gx, gz] = fr.to(fr.W * (0.3 + 0.4 * rng()), fr.D);
          const yardWall = (u0: number, v0: number, u1: number, v1: number, gate: boolean) => {
            const [ax, az] = fr.to(u0, v0), [bx, bz] = fr.to(u1, v1), alongX = Math.abs(bx - ax) > Math.abs(bz - az);
            fence(ax, az, bx, bz, wallH, 0.22, spec.wall, spec.tint, gate ? [alongX ? [gx - 0.6, gx + 0.6] : [gz - 0.6, gz + 0.6]] : []);
          };
          const Db = spec.orient % 2 === 0 ? spec.z1 - spec.z0 : spec.x1 - spec.x0;
          yardWall(0, fr.D - 0.12, fr.W, fr.D - 0.12, backOpen);
          if (!lot.party.includes('left')) yardWall(0.12, Db, 0.12, fr.D, false);
          if (!lot.party.includes('right')) yardWall(fr.W - 0.12, Db, fr.W - 0.12, fr.D, false);
          paint(yard, 0, 0.5, 0.5, 0.5);
          if (rng() < 0.3) { const c = fr.to(fr.W * 0.5, (fr.D + Db) / 2); prop(rng() < 0.6 ? 'palm_' + pick(rng, ['a', 'b', 'c']) : 'bush_oleander', c[0], c[1], rng() * 6.28, range(rng, 0.7, 1.0)); }
          else if (rng() < 0.3) { const c = fr.to(fr.W * range(rng, 0.2, 0.8), fr.D - 1.2); prop(pick(rng, ['gas_cylinder', 'oil_drum', 'tyres_pile', 'trash_pile', 'cart_hand', 'plastic_chair']), c[0], c[1], rng() * 6.28); }
        }
        if (damage > 0.3) paintDisc((lot.x0 + lot.x1) / 2, (lot.z0 + lot.z1) / 2, 14, 1, 0.8);
        void info;
      }
    }
  };
  oldTown({ x0: -332, z0: -318, x1: 100, z1: -13 }, 'old', 0.06);
  oldTown({ x0: -332, z0: 13, x1: 100, z1: 258 }, 'ruins', 0.38);

  // Grand Mosque: prayer hall, walled courtyard (sahn) with a gate onto the plaza, dome and minaret.
  {
    const m = mosqueR, y0 = footY(m) + 0.1;
    paint(shrink(m, -6), 0, 0.3, 2);
    compoundWall(shrink(m, 1), 3.2, 'sandstone', [1, 0.96, 0.88], { side: 2, at: (m.x0 + m.x1) / 2, w: 4.5 }, 0.5);
    const hall: Rect = { x0: m.x0 + 8, z0: m.z0 + 4, x1: m.x1 - 8, z1: m.z0 + 30 };
    addBuilding({ ...hall, orient: 2, y0, floors: 1, fh: 8, t: 0.6, wall: 'sandstone', tint: [1, 0.97, 0.9], floorMat: 'tiles', party: [], damage: 0, stairs: false, hall: true, parapet: 1.2 }, 'old');
    prop('dome_large', (hall.x0 + hall.x1) / 2, (hall.z0 + hall.z1) / 2, 0, 1, y0 + 0.15 + 8, true);
    prop('minaret', m.x1 - 6, m.z1 - 6, 0, 1, undefined, true);
    for (const [x, z] of [[m.x0 + 12, m.z1 - 12], [m.x1 - 20, m.z1 - 14], [m.x0 + 22, m.z1 - 20]]) prop('palm_' + pick(rng, ['a', 'b']), x, z, rng() * 6.28);
    prop('fountain_basin', (m.x0 + m.x1) / 2, m.z1 - 14, 0, 1, undefined, true);
    landmarks.push({ name: 'Grand Mosque', x: (m.x0 + m.x1) / 2, z: (m.z0 + m.z1) / 2 });
  }
  // Ruins plaza: open square with rubble and wrecks.
  {
    paint(plazaS, 1, 0.7, 3, 0.4);
    for (let i = 0; i < 7; i++) prop(pick(rng, ['rubble_a', 'rubble_b', 'rubble_c', 'debris_slab', 'burnt_tyre']), range(rng, plazaS.x0 + 4, plazaS.x1 - 4), range(rng, plazaS.z0 + 4, plazaS.z1 - 4), rng() * 6.28, range(rng, 0.7, 1.2), undefined, true);
    prop('veh:bus_wreck', plazaS.x0 + 14, plazaS.z0 + 12, 0.5, 1, undefined, true);
    prop('veh:sedan_wreck', plazaS.x1 - 10, plazaS.z1 - 9, 2.2, 1, undefined, true);
    landmarks.push({ name: 'The Ruins', x: -115, z: 140 });
  }
  // Souk: stalls and awnings along the market street.
  for (let x = souk.x0 + 6; x < souk.x1 - 4; x += range(rng, 5, 9)) {
    if (rng() < 0.35) continue;
    const north = rng() < 0.5;
    prop(rng() < 0.75 ? 'market_stall' : pick(rng, ['cart_hand', 'trash_bags', 'table_plastic', 'gas_cylinder']), x, north ? souk.z0 + 1.4 : souk.z1 - 1.4, north ? 0 : Math.PI, 1, undefined, true);
  }
  landmarks.push({ name: 'Old Souk', x: -120, z: -92 });
  landmarks.push({ name: 'Old Town', x: -230, z: -230 });

  // ---------- New Town: grid of apartment blocks ----------
  const gridDistrict = (area: Rect, district: District, cell: number) => {
    const xs: number[] = [area.x0], zs: number[] = [area.z0];
    while (area.x1 - xs[xs.length - 1] > cell * 1.4) xs.push(xs[xs.length - 1] + cell + range(rng, -8, 8));
    while (area.z1 - zs[zs.length - 1] > cell * 1.3) zs.push(zs[zs.length - 1] + cell * 0.85 + range(rng, -6, 6));
    xs.push(area.x1); zs.push(area.z1);
    const sw = 14;
    for (let i = 1; i < xs.length - 1; i++) road({ x0: xs[i] - sw / 2, z0: area.z0, x1: xs[i] + sw / 2, z1: area.z1 }, 'street');
    for (let j = 1; j < zs.length - 1; j++) road({ x0: area.x0, z0: zs[j] - sw / 2, x1: area.x1, z1: zs[j] + sw / 2 }, 'street');
    const blocks: Rect[] = [];
    for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < zs.length - 1; j++) {
      blocks.push({ x0: xs[i] + (i ? sw / 2 : 0), x1: xs[i + 1] - (i < xs.length - 2 ? sw / 2 : 0), z0: zs[j] + (j ? sw / 2 : 0), z1: zs[j + 1] - (j < zs.length - 2 ? sw / 2 : 0) });
    }
    return blocks;
  };
  const pavement = (b: Rect) => {
    // Raised pavement ring (2.5 m) around a block.
    const w = 2.5, y = footY(b) + 0.15;
    const sides: Rect[] = [{ x0: b.x0, z0: b.z0, x1: b.x1, z1: b.z0 + w }, { x0: b.x0, z0: b.z1 - w, x1: b.x1, z1: b.z1 }, { x0: b.x0, z0: b.z0 + w, x1: b.x0 + w, z1: b.z1 - w }, { x0: b.x1 - w, z0: b.z0 + w, x1: b.x1, z1: b.z1 - w }];
    for (const s of sides) S.box([s.x0, y - 0.45, s.z0], [s.x1, y, s.z1], 'pavement', [0.92, 0.9, 0.86], F.all ^ F.ny);
    return shrink(b, w);
  };
  const apartment = (lot: Lot, district: District, onMain: boolean) => {
    const fr = lotFrame(lot, lot.orient);
    if (fr.W < 14 || fr.D < 14) return;
    const set = 2.5, bw = Math.min(fr.W - 2 * set, range(rng, 16, 26)), bd = Math.min(fr.D - 5, range(rng, 11, 15));
    const u0 = (fr.W - bw) / 2, fp = fr.rect(u0, set, u0 + bw, set + bd), id = nextId;
    const damage = rng() < (district === 'new' ? 0.16 : 0.08) ? range(rng, 0.4, 1) : 0;
    addBuilding({
      ...fp, orient: lot.orient, y0: footY(fp), floors: 2 + Math.floor(rng() * 4), fh: 3.1, t: 0.25, wall: pick(rng, WALL_SETS[district]),
      tint: tintFor(id), floorMat: 'tiles', party: [], shops: onMain && rng() < 0.8, modern: true, bands: rng() < 0.6, damage, stairs: true, parapet: 1.1,
    }, district);
    if (rng() < 0.6) {
      const yard = shrink(lot, 0.3), [gx, gz] = fr.to(fr.W / 2, 0);
      const gate = { side: (lot.orient === 0 ? 0 : lot.orient === 1 ? 1 : lot.orient === 2 ? 2 : 3) as 0 | 1 | 2 | 3, at: lot.orient % 2 === 0 ? gx : gz, w: 4 };
      compoundWall(yard, 1.8, pick(rng, ['block', 'plaster_a', 'concrete']), [0.92, 0.9, 0.86], gate, 0.22);
    }
    const [px, pz] = fr.to(range(rng, 2, fr.W - 2), fr.D - 2);
    if (rng() < 0.5) prop(pick(rng, ['palm_a', 'palm_b', 'bush_oleander', 'dead_tree']), px, pz, rng() * 6.28, range(rng, 0.7, 1));
  };
  for (const b of gridDistrict({ x0: 118, z0: -318, x1: 500, z1: -13 }, 'new', 78)) {
    const inner = pavement(b);
    const onMain = b.z1 > -30;
    if (rng() < 0.08) { paint(inner, 0, 0.6, 1, 0.4); for (let i = 0; i < 5; i++) prop(pick(rng, ['palm_a', 'palm_b', 'bush_oleander', 'dead_tree']), range(rng, inner.x0 + 3, inner.x1 - 3), range(rng, inner.z0 + 3, inner.z1 - 3), rng() * 6.28); continue; }
    for (const lot of lotsOf(inner, 22, 30, 24)) apartment(lot, 'new', onMain && (lot.orient === 2));
  }
  landmarks.push({ name: 'New Town', x: 310, z: -170 });

  // ---------- Civic district: police station, school, hospital, petrol station, apartments ----------
  const civicBlocks = gridDistrict({ x0: 118, z0: 13, x1: 500, z1: 258 }, 'civic', 90);
  civicBlocks.forEach((b, i) => {
    const inner = pavement(b);
    if (i === 0) {
      // Police station: T-wall compound with a two-storey HQ.
      const c = shrink(inner, 2), y0 = footY(c);
      compoundWall(c, 2.8, 'concrete', [0.9, 0.9, 0.88], { side: 0, at: (c.x0 + c.x1) / 2, w: 6 }, 0.35);
      const hq: Rect = { x0: c.x0 + 8, z0: c.z0 + 10, x1: Math.min(c.x1 - 8, c.x0 + 40), z1: c.z0 + 24 };
      addBuilding({ ...hq, orient: 0, y0, floors: 2, fh: 3.3, t: 0.3, wall: 'concrete', tint: [0.95, 0.93, 0.88], floorMat: 'tiles', party: [], modern: true, bands: true, damage: 0, stairs: true, parapet: 1.1 }, 'civic');
      for (let x = c.x0 + 4; x < c.x1 - 4; x += 1.6) prop('t_wall', x, c.z0 - 1.5, 0, 1, undefined, true);
      prop('flagpole', (c.x0 + c.x1) / 2 + 6, c.z0 + 5);
      landmarks.push({ name: 'Police Station', x: (c.x0 + c.x1) / 2, z: (c.z0 + c.z1) / 2 });
      return;
    }
    if (i === 1) {
      // School: U-shape of three two-storey wings around a yard.
      const c = shrink(inner, 2), y0 = footY(c), wd = 11;
      compoundWall(c, 2.2, 'plaster_a', [0.95, 0.92, 0.84], { side: 0, at: (c.x0 + c.x1) / 2, w: 5 }, 0.25);
      const tint: [number, number, number] = [0.98, 0.94, 0.82];
      addBuilding({ x0: c.x0 + 3, z0: c.z1 - 3 - wd, x1: c.x1 - 3, z1: c.z1 - 3, orient: 0, y0, floors: 2, fh: 3.4, t: 0.3, wall: 'plaster_a', tint, floorMat: 'tiles', party: [], modern: true, damage: 0.0, stairs: true, parapet: 1.0 }, 'civic');
      addBuilding({ x0: c.x0 + 3, z0: c.z0 + 12, x1: c.x0 + 3 + wd, z1: c.z1 - 4 - wd, orient: 1, y0, floors: 2, fh: 3.4, t: 0.3, wall: 'plaster_a', tint, floorMat: 'tiles', party: [], modern: true, damage: 0.45, stairs: true, parapet: 1.0 }, 'civic');
      addBuilding({ x0: c.x1 - 3 - wd, z0: c.z0 + 12, x1: c.x1 - 3, z1: c.z1 - 4 - wd, orient: 3, y0, floors: 2, fh: 3.4, t: 0.3, wall: 'plaster_a', tint, floorMat: 'tiles', party: [], modern: true, damage: 0, stairs: true, parapet: 1.0 }, 'civic');
      paint(c, 0, 0.55, 1, 0.3);
      landmarks.push({ name: 'School', x: (c.x0 + c.x1) / 2, z: (c.z0 + c.z1) / 2 });
      return;
    }
    if (i === 2) {
      // Petrol station on the boulevard: canopy on columns and a kiosk.
      const c = shrink(inner, 2), y = footY(c);
      paint(c, 1, 0.4, 1);
      const cx = (c.x0 + c.x1) / 2, cz = c.z0 + 14;
      S.box([cx - 12, y + 5, cz - 6], [cx + 12, y + 5.8, cz + 6], 'metal_green', [0.95, 0.95, 0.95], F.all);
      for (const dx of [-8, 8]) for (const dz of [-3, 3]) S.box([cx + dx - 0.25, y, cz + dz - 0.25], [cx + dx + 0.25, y + 5, cz + dz + 0.25], 'concrete', [0.9, 0.9, 0.9], F.sides);
      for (const dx of [-8, 0, 8]) S.box([cx + dx - 0.5, y, cz - 0.6], [cx + dx + 0.5, y + 1.7, cz + 0.6], 'metal', [0.9, 0.3, 0.2], F.all ^ F.ny, undefined, true, 'metal');
      addBuilding({ x0: cx - 7, z0: c.z1 - 14, x1: cx + 7, z1: c.z1 - 4, orient: 0, y0: y, floors: 1, fh: 3.4, t: 0.25, wall: 'concrete', tint: [0.95, 0.95, 0.92], floorMat: 'tiles', party: [], shops: true, modern: true, damage: 0, stairs: false, parapet: 0.6 }, 'civic');
      landmarks.push({ name: 'Petrol Station', x: cx, z: cz });
      return;
    }
    if (i === 3) {
      // Hospital: one big four-storey block.
      const c = shrink(inner, 2), y0 = footY(c), hw = Math.min(46, c.x1 - c.x0 - 10);
      addBuilding({ x0: c.x0 + 5, z0: c.z0 + 6, x1: c.x0 + 5 + hw, z1: c.z0 + 22, orient: 0, y0, floors: 4, fh: 3.3, t: 0.3, wall: 'concrete', tint: [0.97, 0.97, 0.95], floorMat: 'tiles', party: [], modern: true, bands: true, damage: 0.3, stairs: true, parapet: 1.1 }, 'civic');
      compoundWall(c, 2.0, 'block', [0.9, 0.9, 0.88], { side: 0, at: c.x0 + 10, w: 6 }, 0.22);
      landmarks.push({ name: 'Hospital', x: (c.x0 + c.x1) / 2, z: (c.z0 + c.z1) / 2 });
      return;
    }
    for (const lot of lotsOf(inner, 22, 30, 24)) apartment(lot, 'civic', b.z0 < 30 && lot.orient === 0);
  });

  // ---------- Industrial zone ----------
  for (const b of gridDistrict({ x0: -332, z0: 270, x1: 500, z1: 600 }, 'industrial', 95)) {
    if (rng() < 0.12) { paint(b, 0, 0.7, 2, 0.3); continue; }
    const c = shrink(b, 1.5), y0 = footY(c);
    const wallMat = pick(rng, ['block', 'concrete'] as MatId[]);
    compoundWall(c, 2.6, wallMat, [0.88, 0.86, 0.82], { side: 0, at: (c.x0 + c.x1) / 2 + range(rng, -10, 10), w: 7 }, 0.25);
    paint(c, 1, 0.55, 2, 0.4);
    const ww = Math.min(c.x1 - c.x0 - 14, range(rng, 28, 48)), wd = Math.min(c.z1 - c.z0 - 18, range(rng, 18, 30));
    if (ww > 12 && wd > 10) {
      const wx = c.x0 + 6 + rng() * (c.x1 - c.x0 - 12 - ww), wz = c.z1 - 6 - wd;
      addBuilding({ x0: wx, z0: wz, x1: wx + ww, z1: wz + wd, orient: 0, y0, floors: 1, fh: range(rng, 6, 8), t: 0.3, wall: rng() < 0.5 ? 'metal' : wallMat, tint: rng() < 0.5 ? [0.85, 0.82, 0.78] : [0.7, 0.75, 0.72], floorMat: 'floor', party: [], damage: rng() < 0.2 ? range(rng, 0.3, 0.8) : 0, stairs: false, hall: true, parapet: 0.5 }, 'industrial');
    }
    // Small office by the gate.
    if (rng() < 0.6) {
      const ox = c.x0 + 4, oz = c.z0 + 4;
      addBuilding({ x0: ox, z0: oz, x1: ox + 10, z1: oz + 8, orient: 0, y0, floors: rng() < 0.5 ? 1 : 2, fh: 3.1, t: 0.25, wall: wallMat, tint: [0.92, 0.9, 0.85], floorMat: 'floor', party: [], modern: true, damage: 0, stairs: true, parapet: 0.9 }, 'industrial');
    }
    // Yard clutter.
    const n = 4 + Math.floor(rng() * 6);
    for (let i = 0; i < n; i++) {
      const id = pick(rng, ['conex', 'conex', 'oil_drum', 'oil_drum_rusty', 'pallet', 'tyres_pile', 'water_tank_steel', 'generator_small', 'trash_pile', 'transformer_box']);
      const x = range(rng, c.x0 + 4, c.x1 - 4), z = range(rng, c.z0 + 12, c.z0 + 22);
      prop(id, x, z, Math.round(rng() * 4) * Math.PI / 2 + range(rng, -0.1, 0.1), 1, undefined, true);
    }
  }
  landmarks.push({ name: 'Industrial Zone', x: 80, z: 430 });

  // ---------- Compounds (outskirts north, rural west) ----------
  const compound = (c: Rect, district: District) => {
    const y0 = footY(c), tint = tintFor(nextId), wallMat = pick(rng, ['clay', 'plaster_a', 'plaster_b', 'brick'] as MatId[]);
    compoundWall(c, 2.4, wallMat, tint, { side: 2, at: (c.x0 + c.x1) / 2 + range(rng, -6, 6), w: 3.5 }, 0.25);
    paint(c, 0, 0.45, 1, 0.5);
    const vw = Math.min(c.x1 - c.x0 - 8, range(rng, 11, 16)), vd = Math.min(c.z1 - c.z0 - 12, range(rng, 9, 13));
    const vx = (c.x0 + c.x1) / 2 - vw / 2 + range(rng, -3, 3), vz = c.z0 + 3;
    addBuilding({ x0: vx, z0: vz, x1: vx + vw, z1: vz + vd, orient: 2, y0, floors: rng() < 0.6 ? 2 : 1, fh: 3.1, t: 0.3, wall: wallMat, tint, floorMat: 'tiles', party: [], damage: rng() < 0.1 ? 0.6 : 0, stairs: true, parapet: 1.0 }, district);
    for (let i = 0; i < 2 + Math.floor(rng() * 3); i++) prop('palm_' + pick(rng, ['a', 'b', 'c']), range(rng, c.x0 + 2, c.x1 - 2), range(rng, vz + vd + 2, c.z1 - 2), rng() * 6.28, range(rng, 0.8, 1.1));
    if (rng() < 0.4) prop(pick(rng, ['veh:pickup', 'veh:sedan']), range(rng, c.x0 + 4, c.x1 - 4), c.z1 - 4, rng() * 6.28, 1, undefined, true);
  };
  for (let x = -320; x < 480; x += range(rng, 45, 70)) for (let z = -625; z < -350; z += range(rng, 50, 75)) {
    if (rng() < 0.35) { paint({ x0: x, z0: z, x1: x + 40, z1: z + 40 }, 2, 0.7, 4, 0.5); continue; }
    compound({ x0: x, z0: z, x1: x + range(rng, 26, 38), z1: z + range(rng, 26, 36) }, 'outskirts');
  }
  for (let x = -320; x < 480; x += 60) road({ x0: x - 3, z0: -640, x1: x + 3, z1: -330 }, 'dirt');
  landmarks.push({ name: 'Northern Compounds', x: 80, z: -480 });
  // Rural west bank: fields, palm groves, a few compounds, the insurgent base compound.
  for (let z = -630; z < 630; z += range(rng, 60, 90)) {
    const x = range(rng, -630, -470);
    if (rng() < 0.5) compound({ x0: x, z0: z, x1: x + range(rng, 26, 36), z1: z + range(rng, 26, 34) }, 'rural');
    else paint({ x0: x - 20, z0: z, x1: x + 60, z1: z + 50 }, 2, 0.9, 3, 0.4);
  }
  const insRect: Rect = { x0: -600, z0: -70, x1: -540, z1: -20 };
  compoundWall(insRect, 2.8, 'clay', [0.95, 0.9, 0.8], { side: 1, at: -45, w: 5 }, 0.4);
  addBuilding({ x0: insRect.x0 + 4, z0: insRect.z0 + 4, x1: insRect.x0 + 20, z1: insRect.z0 + 16, orient: 1, y0: footY(insRect), floors: 2, fh: 3.0, t: 0.35, wall: 'clay', tint: [0.95, 0.9, 0.8], floorMat: 'floor', party: [], damage: 0, stairs: true, parapet: 1.0 }, 'rural');
  landmarks.push({ name: 'Palm Groves', x: -440, z: 200 });
  landmarks.push({ name: 'Canal', x: canalX(-420), z: -420 });
  // Palm groves along both canal banks.
  for (let z = -640; z < 640; z += range(rng, 6, 11)) {
    for (const side of [-1, 1]) {
      if (bridges.some((b) => z > b.z0 - 4 && z < b.z1 + 4)) continue;
      const rows = side < 0 ? 3 : 1;
      for (let r = 0; r < rows; r++) {
        if (rng() < 0.25) continue;
        const x = canalX(z) + side * (CANAL_W / 2 + 10 + r * range(rng, 7, 11) + range(rng, -2, 2));
        if (side > 0 && x > -347) continue;
        prop('palm_' + pick(rng, ['a', 'b', 'c']), x, z + range(rng, -2, 2), rng() * 6.28, range(rng, 0.8, 1.15));
      }
      if (rng() < 0.12) prop('reeds', canalX(z) + side * (CANAL_W / 2 + 1.5), z, rng() * 6.28);
    }
  }
  for (let z = -640; z < 640; z += 4) paint({ x0: canalX(z) - CANAL_W / 2 - 12, z0: z, x1: canalX(z) + CANAL_W / 2 + 12, z1: z + 4 }, 3, 0.8, 6);

  // ---------- Boulevard furniture: palms and lights on the median, checkpoint near the FOB ----------
  for (let x = -330; x < 495; x += 15) {
    if (x > 92 && x < 126) continue;
    prop(Math.round(x / 15) % 2 ? 'palm_' + pick(rng, ['a', 'b']) : 'street_light', x, 0, 0, Math.round(x / 15) % 2 ? range(rng, 0.85, 1.05) : 1, undefined, true);
  }
  S.box([-330, H(0, 0) - 0.3, -1], [494, H(0, 0) + 0.2, 1], 'kerb', [0.9, 0.88, 0.84], F.all ^ F.ny);
  for (let z = -510; z < 510; z += 30) { if (Math.abs(z) < 20) continue; prop('street_light', 120, z, -Math.PI / 2, 1, undefined, true); }
  for (const z of [-7, 7]) prop('jersey_barrier', 470, z, Math.PI / 2, 1, undefined, true);
  prop('sandbag_bunker', 474, -16, 0, 1, undefined, true);
  prop('sandbag_bunker', 474, 16, Math.PI, 1, undefined, true);
  // Power poles along streets and lanes.
  for (const r of roads) {
    if (r.kind !== 'street' && r.kind !== 'lane') continue;
    const alongX = r.x1 - r.x0 > r.z1 - r.z0, len = alongX ? r.x1 - r.x0 : r.z1 - r.z0;
    for (let a = 20; a < len - 10; a += 38) {
      const x = alongX ? r.x0 + a : r.x0 - 0.6, z = alongX ? r.z0 - 0.6 : r.z0 + a;
      if (Math.abs(x) < HALF - 20 && Math.abs(z) < HALF - 20) prop('power_pole', x, z, alongX ? 0 : Math.PI / 2, 1, undefined, true);
    }
  }
  // Wrecks and parked cars along streets; trash in alleys.
  for (const r of roads) {
    const alongX = r.x1 - r.x0 > r.z1 - r.z0, len = alongX ? r.x1 - r.x0 : r.z1 - r.z0, w = alongX ? r.z1 - r.z0 : r.x1 - r.x0;
    const perKm = r.kind === 'street' || r.kind === 'boulevard' || r.kind === 'avenue' ? 12 : r.kind === 'lane' ? 6 : r.kind === 'alley' ? 9 : 0;
    const n = Math.floor((len / 1000) * perKm);
    for (let i = 0; i < n; i++) {
      const a = range(rng, 5, len - 5), off = (w / 2 - (r.kind === 'alley' ? 0.8 : 2.2)) * (rng() < 0.5 ? -1 : 1);
      const x = alongX ? r.x0 + a : (r.x0 + r.x1) / 2 + off, z = alongX ? (r.z0 + r.z1) / 2 + off : r.z0 + a;
      if (Math.abs(x) > HALF || Math.abs(z) > HALF || bridges.some((b) => x > b.x0 - 5 && x < b.x1 + 5 && z > b.z0 - 5 && z < b.z1 + 5)) continue;
      const ry = (alongX ? Math.PI / 2 : 0) + (rng() < 0.5 ? Math.PI : 0) + range(rng, -0.15, 0.15);
      if (r.kind === 'alley') prop(pick(rng, ['trash_pile', 'trash_bags', 'gas_cylinder', 'oil_drum', 'tyres_pile', 'cart_hand']), x, z, rng() * 6.28, 1, undefined, true);
      else prop(pick(rng, ['veh:sedan', 'veh:sedan', 'veh:pickup', 'veh:sedan_wreck', 'veh:pickup_wreck', 'veh:m1114_wreck', 'trash_pile', 'burnt_tyre']), x, z, ry, 1, undefined, true);
    }
  }

  // ---------- US FOB (main base) ----------
  const fobR: Rect = { x0: 530, z0: -95, x1: 640, z1: 95 };
  paint(fobR, 1, 0.75, 3, 0.2);
  {
    const step = 1.06 * 5;
    const wallLine = (x0: number, z0: number, x1: number, z1: number, gap?: [number, number]) => {
      const alongX = Math.abs(x1 - x0) > Math.abs(z1 - z0), len = Math.hypot(x1 - x0, z1 - z0);
      for (let a = step / 2; a < len; a += step) {
        const x = alongX ? x0 + a : x0, z = alongX ? z0 : z0 + a;
        if (gap && (alongX ? x : z) > gap[0] && (alongX ? x : z) < gap[1]) continue;
        prop('hesco_wall', x, z, alongX ? 0 : Math.PI / 2, 1, undefined, true);
      }
    };
    wallLine(fobR.x0, fobR.z0, fobR.x1, fobR.z0); wallLine(fobR.x0, fobR.z1, fobR.x1, fobR.z1);
    wallLine(fobR.x1, fobR.z0, fobR.x1, fobR.z1); wallLine(fobR.x0, fobR.z0, fobR.x0, fobR.z1, [-9, 9]);
    for (const [x, z] of [[fobR.x0 + 4, fobR.z0 + 4], [fobR.x1 - 4, fobR.z0 + 4], [fobR.x0 + 4, fobR.z1 - 4], [fobR.x1 - 4, fobR.z1 - 4], [fobR.x0 + 4, -14]]) prop('guard_tower', x, z, x < 600 ? -Math.PI / 2 : Math.PI / 2, 1, undefined, true);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 4; j++) prop('tent_military', 595 + i * 14, -70 + j * 14, 0, 1, undefined, true);
    for (let j = 0; j < 4; j++) prop('conex', 625, 20 + j * 7, Math.PI / 2, 1, undefined, true);
    for (let x = 548; x < 590; x += 1.6) prop('t_wall', x, 40, 0, 1, undefined, true);
    prop('flagpole', 575, -30);
    prop('floodlight_tower', 560, 60, 0, 1, undefined, true);
    prop('camo_net', 570, 70, 0, 1, undefined, true);
    prop('sandbags_line', fobR.x0 - 3, -12, Math.PI / 2, 1, undefined, true);
    prop('sandbags_line', fobR.x0 - 3, 12, Math.PI / 2, 1, undefined, true);
    for (let i = 0; i < 6; i++) prop('crate_ammo', 600 + (i % 3) * 1.2, 30 + Math.floor(i / 3) * 1.0, 0, 1, undefined, true);
  }
  landmarks.push({ name: 'FOB Hammer', x: 585, z: 0 });

  // ---------- gameplay points ----------
  const cacheSpots: Spot[] = [], roofSpots: Spot[] = [];
  for (const b of buildings) {
    const d = districtOf.get(b.id)!;
    if (d === 'rural' && b.spec.x0 < -530 && b.spec.z0 > -80 && b.spec.z1 < -10) continue; // insurgent base
    if (b.spec.damage < 0.7) for (const [x, y, z, floor] of b.spots) if (floor <= 1 && d !== 'fob') cacheSpots.push({ x, y, z, b: b.id, district: d, floor });
    for (const [x, y, z] of b.roof) roofSpots.push({ x, y, z, b: b.id, district: d, floor: -1 });
  }

  // Test area boundary: a HESCO line around the edge (the physics adds an invisible wall too).
  // Pieces that would stand inside a building (one outside the area that reaches in) are left out: its walls close
  // the line there.
  if (play) {
    for (let i = props.length - 1; i >= 0; i--) { const q = props[i]; if (q.x < play.x0 - 2 || q.x > play.x1 + 2 || q.z < play.z0 - 2 || q.z > play.z1 + 2) props.splice(i, 1); }
    for (const [ax, az, bx, bz] of [[play.x0, play.z0, play.x1, play.z0], [play.x1, play.z0, play.x1, play.z1], [play.x0, play.z1, play.x1, play.z1], [play.x0, play.z0, play.x0, play.z1]]) {
      const L = Math.hypot(bx - ax, bz - az), n = Math.ceil(L / 5.3), alongX = Math.abs(bx - ax) > Math.abs(bz - az);
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n, x = ax + (bx - ax) * t, z = az + (bz - az) * t, hx = alongX ? 2.8 : 0.6, hz = alongX ? 0.6 : 2.8;
        if (footprints.some((f) => x + hx > f.x0 && x - hx < f.x1 && z + hz > f.z0 && z - hz < f.z1)) continue;
        prop('hesco_wall', x, z, alongX ? 0 : Math.PI / 2, 1, undefined, true);
      }
    }
  }
  unstickProps(props, S.colliders);
  return {
    area: play ?? undefined,
    seed, sink: S, buildings, districtOf, roads, props, mask, bridges, landmarks, cacheSpots, roofSpots,
    fob: {
      rect: fobR, flag: [575, -30],
      spawns: [[600, H(600, -40), -40], [606, H(606, -20), -20], [590, H(590, 10), 10], [612, H(612, -55), -55]],
      vehicles: [{ id: 'm1114', x: 560, z: -40, ry: -Math.PI / 2 }, { id: 'm1114', x: 560, z: -52, ry: -Math.PI / 2 }, { id: 'm1114', x: 560, z: -64, ry: -Math.PI / 2 }],
    },
    insBase: {
      rect: insRect,
      spawns: [[-570, H(-570, -30), -30], [-560, H(-560, -55), -55], [-585, H(-585, -28), -28]],
      vehicles: [{ id: 'hilux_dshk', x: -528, z: -48, ry: Math.PI / 2 }, { id: 'pickup', x: -528, z: -35, ry: Math.PI / 2 }],
    },
  };
}

/** Approximate footprint radius (m) of outdoor props, for keeping them out of walls. */
const PROP_R: [RegExp, number][] = [[/^veh:/, 2.4], [/^sandbag_bunker|^guard_tower/, 1.8], [/^market_stall|^jersey|^hesco/, 1.2], [/^cart_|^trash_|^tyres|^oil_drum|^generator/, 0.7], [/^street_light|^power_pole|^palm|^dead_tree|^antenna/, 0.25]];
/**
 * Ground-standing outdoor props must not stand in walls: a prop whose footprint overlaps a city collider between knee and
 * head height is moved out along a free direction (up to 2.5 m), or dropped. Rubble and debris lie against breached
 * walls on purpose; interior furniture and roof clutter have an explicit height and are not touched.
 */
function unstickProps(props: Prop[], cols: { c: number[]; h: number[]; q?: number[] }[]) {
  const C = 4, grid = new Map<number, number[]>(), key = (ix: number, iz: number) => (ix + 1024) * 2048 + (iz + 1024);
  cols.forEach((c, i) => {
    if (c.q || c.h[1] < 0.35) return; // floors, kerbs, ramps
    for (let ix = Math.floor((c.c[0] - c.h[0]) / C); ix <= Math.floor((c.c[0] + c.h[0]) / C); ix++) for (let iz = Math.floor((c.c[2] - c.h[2]) / C); iz <= Math.floor((c.c[2] + c.h[2]) / C); iz++) {
      const k = key(ix, iz); (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
    }
  });
  const blocked = (x: number, y: number, z: number, r: number) => {
    for (let ix = Math.floor((x - r) / C); ix <= Math.floor((x + r) / C); ix++) for (let iz = Math.floor((z - r) / C); iz <= Math.floor((z + r) / C); iz++) for (const i of grid.get(key(ix, iz)) ?? []) {
      const c = cols[i];
      if (y + 1.6 < c.c[1] - c.h[1] || y + 0.3 > c.c[1] + c.h[1]) continue;
      if (Math.abs(x - c.c[0]) < c.h[0] + r && Math.abs(z - c.c[2]) < c.h[2] + r) return true;
    }
    return false;
  };
  let moved = 0, dropped = 0;
  for (let i = props.length - 1; i >= 0; i--) {
    const q = props[i];
    if (!q.ground || /^(rubble|debris|grass|reeds|bush)/.test(q.id)) continue;
    const r = (PROP_R.find(([re]) => re.test(q.id))?.[1] ?? 0.5) * (q.s ?? 1);
    if (!blocked(q.x, q.y, q.z, r)) continue;
    let ok = false;
    for (let d = 0.5; d <= 2.5 && !ok; d += 0.5) for (let a = 0; a < 8 && !ok; a++) {
      const x = q.x + Math.cos(a * Math.PI / 4) * d, z = q.z + Math.sin(a * Math.PI / 4) * d;
      if (!blocked(x, q.y, z, r)) { q.x = x; q.z = z; ok = true; }
    }
    if (ok) moved++; else { props.splice(i, 1); dropped++; }
  }
  if (typeof console !== 'undefined') console.log(`props out of walls: ${moved} moved, ${dropped} dropped`);
}

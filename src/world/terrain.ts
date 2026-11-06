// Terrain height for the map "Al Zahran": a flat river-plain city, a canal on the west side, gentle rises outside the
// town and low desert hills on the horizon. Pure functions (shared by the generator, physics and renderer).
import { fbm, lerp, smoothstep } from '../core/rng';

/** Half-size (m) of the town and its outskirts (the generator's layout extent). */
export const HALF = 650;
/**
 * Area of operations (playable): the town plus the eastern farmland belt where the US armour stages and attacks from
 * (FOB Hammer at x ≈ 925). Bounded by invisible walls; bots navigate inside it.
 */
export const AO = { x0: -700, x1: 1000, z0: -700, z1: 700 } as const;
/** Map sheet: a square of 17 × 17 grid squares of 100 m centred on the AO (letters A–Q west→east, rows 1–17). */
export const MAP = { cx: 150, cz: 0, half: 850, n: 17 } as const;
/** Low ridge east of the town (crest x, height): hull-down positions overlooking the eastern edge of town. */
export const RIDGE_X = 662, RIDGE_H = 5;
/** East–west roads crossing the ridge (z): the ridge is cut where they pass. */
const RIDGE_CUTS = [0, -324, 264];
/** Rendered terrain half-size (horizon). */
export const OUTER = 2200;
export const CANAL_W = 22;
export const canalX = (z: number) => -372 + 9 * Math.sin(z / 170) + 4 * Math.sin(z / 61 + 1.3);
export const WATER_Y = -1.6;

export function groundH(x: number, z: number): number {
  // Distance outside the built-up area (roughly the playable square).
  const r = Math.max(Math.abs(x) / 560, Math.abs(z) / 560);
  // East of the town the hills give way to a farmland plain out to the edge of the AO (and rise again beyond it).
  const east = smoothstep(470, 600, x) * (1 - smoothstep(AO.x1 + 40, AO.x1 + 260, x)) * (1 - smoothstep(AO.z1 - 20, AO.z1 + 200, Math.abs(z)));
  const out = smoothstep(1.0, 1.9, r) * (1 - east);
  let h = (fbm(x / 110, z / 110, 3, 5) - 0.5) * 0.7;
  h += out * ((fbm(x / 420, z / 420, 4, 9) - 0.3) * 55 + (fbm(x / 90, z / 90, 3, 11) - 0.5) * 6);
  if (east > 0) {
    // Gentle undulation (±1.5 m) and the ridge, cut down to road level where the three roads cross it.
    const cut = Math.max(...RIDGE_CUTS.map((zc) => Math.exp(-(((z - zc) / 16) ** 2))));
    const ridge = RIDGE_H * Math.exp(-(((x - RIDGE_X) / 26) ** 2)) * (0.75 + 0.25 * fbm(z / 140, 3.7, 2, 13)) * (1 - 0.92 * cut);
    h += east * ((fbm(x / 160, z / 160, 3, 17) - 0.5) * 3 + ridge);
  }
  // Canal channel with sloping banks.
  if (Math.abs(z) < OUTER) {
    const d = Math.abs(x - canalX(z)), hw = CANAL_W / 2;
    if (d < hw + 9) h = lerp(h, -3.4, smoothstep(hw + 9, hw - 1.5, d));
  }
  return h;
}

/** Map grid label for a world point (columns A–Q west→east, rows 1–17 north→south, keypad 1–9 like a phone). */
export function gridRef(x: number, z: number): string {
  const x0 = MAP.cx - MAP.half, z0 = MAP.cz - MAP.half, sq = (2 * MAP.half) / MAP.n, cx = Math.floor((x - x0) / sq), cz = Math.floor((z - z0) / sq);
  if (cx < 0 || cx >= MAP.n || cz < 0 || cz >= MAP.n) return 'off-map';
  // Keypad as on a phone/numpad with north up: the northern third is 7 8 9, the southern third 1 2 3.
  const fx = (x - x0) / sq - cx, fz = (z - z0) / sq - cz;
  const row = Math.min(2, Math.floor(fz * 3)), col = Math.min(2, Math.floor(fx * 3));
  return `${'ABCDEFGHIJKLMNOPQ'[cx]}${cz + 1} kp${[7, 4, 1][row] + col}`;
}

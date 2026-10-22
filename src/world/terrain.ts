// Terrain height for the map "Al Zahran": a flat river-plain city, a canal on the west side, gentle rises outside the
// town and low desert hills on the horizon. Pure functions (shared by the generator, physics and renderer).
import { fbm, lerp, smoothstep } from '../core/rng';

/** Playable area half-size (m): 13 × 100 m grid squares. */
export const HALF = 650;
/** Rendered terrain half-size (horizon). */
export const OUTER = 2200;
export const CANAL_W = 22;
export const canalX = (z: number) => -372 + 9 * Math.sin(z / 170) + 4 * Math.sin(z / 61 + 1.3);
export const WATER_Y = -1.6;

export function groundH(x: number, z: number): number {
  // Distance outside the built-up area (roughly the playable square).
  const r = Math.max(Math.abs(x) / 560, Math.abs(z) / 560);
  const out = smoothstep(1.0, 1.9, r);
  let h = (fbm(x / 110, z / 110, 3, 5) - 0.5) * 0.7;
  h += out * ((fbm(x / 420, z / 420, 4, 9) - 0.3) * 55 + (fbm(x / 90, z / 90, 3, 11) - 0.5) * 6);
  // Canal channel with sloping banks.
  if (Math.abs(z) < OUTER) {
    const d = Math.abs(x - canalX(z)), hw = CANAL_W / 2;
    if (d < hw + 9) h = lerp(h, -3.4, smoothstep(hw + 9, hw - 1.5, d));
  }
  return h;
}

/** Map grid label for a world point (columns A–M west→east, rows 1–13 north→south, keypad 1–9 like a phone). */
export function gridRef(x: number, z: number): string {
  const sq = (2 * HALF) / 13, cx = Math.floor((x + HALF) / sq), cz = Math.floor((z + HALF) / sq);
  if (cx < 0 || cx > 12 || cz < 0 || cz > 12) return 'off-map';
  // Keypad as on a phone/numpad with north up: the northern third is 7 8 9, the southern third 1 2 3.
  const fx = (x + HALF) / sq - cx, fz = (z + HALF) / sq - cz;
  const row = Math.min(2, Math.floor(fz * 3)), col = Math.min(2, Math.floor(fx * 3));
  return `${'ABCDEFGHIJKLM'[cx]}${cz + 1} kp${[7, 4, 1][row] + col}`;
}

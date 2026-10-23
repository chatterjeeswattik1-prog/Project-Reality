// First-person weapon handling choreography: keyframed tracks for each reload style, sampled by the reload's progress
// (0..1). The AK timings follow the Squad AKM reference video (frames in tools/blender/src-assets/ref/video): the
// rifle is lifted and rolled to the right so the magazine well faces the support hand, the hand rocks the old
// magazine forward off its front lug and takes it away (~25% of the reload), the rifle waits canted while the hand
// fetches a fresh one from the pouch, the new magazine is hooked on its lug and rocked back until it clicks (~75%),
// and the rifle comes back down. An empty reload adds the reach over to the charging handle.
import type { WeaponDef } from '../game/data/weapons';

export type V3 = [number, number, number];
/** Where the support hand is: on the handguard, holding the magazine (or belt box), on the charging handle, the
 *  bolt catch / magazine release, lifting the feed cover, or out of view at the pouches. */
export type HandAt = 'grip' | 'mag' | 'charge' | 'catch' | 'cover' | 'away';
type K<T> = [number, T][];

export interface Choreo {
  /** Weapon offset added to its pose: position (m, view space: +x right, +y up, +z back) and rotation
   *  (rad: +x muzzle up, +y muzzle left, +z roll counter-clockwise as seen by the shooter). */
  pos: K<V3>; rot: K<V3>;
  /** Magazine relative to its seat, in weapon space (m), its rock about the front lug (rad, + = bottom forward) and
   *  whether it is shown (step track). AR-type magazines also slide along `mag_dir` by `magSlide` (m). */
  magPos: K<V3>; magRock: K<number>; magShow: K<number>; magSlide?: K<number>;
  /** Support-hand target per keyframe; the hand moves smoothly between consecutive targets. */
  hand: K<HandAt>;
  /** Charging handle / slide / bolt travel 0..1, feed cover opening 0..1. */
  charge: K<number>; cover?: K<number>;
  /** Sounds at progress points. */
  cues: [number, string, number?][];
}

export type Style = 'ak' | 'ar' | 'belt' | 'bolt' | 'pistol' | 'rpg' | 'none';
export function styleOf(def: WeaponDef): Style {
  if (def.kind === 'grenade' || def.kind === 'charge' || def.disposable) return 'none';
  if (def.belt) return 'belt';
  if (def.kind === 'launcher') return 'rpg';
  if (def.kind === 'pistol') return 'pistol';
  if (def.id === 'm24') return 'bolt';
  if (def.ammo === '762x39' || def.ammo === '545' || def.ammo === '762x54') return 'ak';
  return 'ar';
}

const Z: V3 = [0, 0, 0];
const AK_ROT: V3 = [0.5, 0.14, -0.6], AK_POS: V3 = [-0.1, 0.02, -0.1];
const AK: Choreo = {
  pos: [[0, Z], [0.13, AK_POS], [0.745, AK_POS], [0.77, [-0.1, 0.005, -0.095]], [0.8, AK_POS], [0.86, AK_POS], [1, Z]],
  rot: [[0, Z], [0.13, AK_ROT], [0.5, [0.46, 0.15, -0.55]], [0.745, AK_ROT], [0.77, [0.42, 0.14, -0.58]], [0.8, AK_ROT], [0.86, AK_ROT], [1, Z]],
  magPos: [[0.17, Z], [0.25, [0, -0.03, -0.02]], [0.4, [-0.3, -0.42, 0.06]], [0.56, [-0.32, -0.45, 0.1]], [0.64, [-0.1, -0.14, 0]], [0.71, [0, -0.028, -0.014]], [0.76, Z]],
  magRock: [[0.17, 0], [0.24, 0.45], [0.38, 0.75], [0.6, 0.7], [0.66, 0.52], [0.71, 0.42], [0.76, 0]],
  magShow: [[0, 1], [0.42, 0], [0.55, 1]],
  hand: [[0.04, 'grip'], [0.16, 'mag'], [0.8, 'mag'], [0.95, 'grip']],
  charge: [[0, 0]],
  cues: [[0.22, 'mag_out'], [0.45, 'aim_cloth', 0.4], [0.755, 'mag_in']],
};
/** Empty AK: the same, faster to the seat, then the hand goes over the top to the charging handle and rips it back. */
const AK_EMPTY: Choreo = (() => {
  const k = 0.78, sc = <T>(l: K<T>): K<T> => l.map(([t, v]) => [t * k, v]);
  return {
    pos: [...sc(AK.pos.slice(0, 5)), [0.84, [-0.04, 0.05, 0.02]], [0.9, [-0.04, 0.05, 0.02]], [1, Z]],
    rot: [...sc(AK.rot.slice(0, 5)), [0.84, [0.4, 0.05, -0.15]], [0.86, [0.42, 0.05, -0.18]], [0.9, [0.38, 0.05, -0.12]], [1, Z]],
    magPos: sc(AK.magPos), magRock: sc(AK.magRock), magShow: sc(AK.magShow),
    hand: [...sc(AK.hand.slice(0, 3)), [0.8, 'charge'], [0.88, 'charge'], [0.97, 'grip']],
    charge: [[0.81, 0], [0.855, 1], [0.87, 0]],
    cues: [...AK.cues.map(([t, n, g]) => [t * k, n, g] as [number, string, number?]), [0.85, 'charging_handle_ak']],
  };
})();

const AR_ROT: V3 = [0.3, 0.12, -0.5], AR_POS: V3 = [-0.08, 0.02, -0.08];
const AR: Choreo = {
  pos: [[0, Z], [0.12, AR_POS], [0.72, [-0.08, 0.01, -0.075]], [0.76, AR_POS], [0.86, AR_POS], [1, Z]],
  rot: [[0, Z], [0.12, AR_ROT], [0.72, [0.26, 0.1, -0.45]], [0.76, AR_ROT], [0.86, AR_ROT], [1, Z]],
  magPos: [[0, Z]], magRock: [[0, 0]], magShow: [[0, 1], [0.4, 0], [0.55, 1]],
  magSlide: [[0.14, 0], [0.22, 0.12], [0.38, 0.55], [0.55, 0.6], [0.64, 0.12], [0.73, 0]],
  hand: [[0.04, 'grip'], [0.14, 'mag'], [0.78, 'mag'], [0.93, 'grip']],
  charge: [[0, 0]],
  cues: [[0.2, 'mag_out'], [0.47, 'aim_cloth', 0.4], [0.73, 'mag_in']],
};
/** Empty AR: after the seat, the support hand slaps the bolt catch. */
const AR_EMPTY: Choreo = {
  ...AR,
  hand: [[0.04, 'grip'], [0.14, 'mag'], [0.76, 'mag'], [0.82, 'catch'], [0.86, 'catch'], [0.96, 'grip']],
  charge: [[0, 1], [0.84, 1], [0.86, 0]],
  cues: [...AR.cues, [0.85, 'bolt_release']],
};

const BELT_ROT: V3 = [0.18, 0.08, 0.2], BELT_POS: V3 = [-0.04, 0.03, 0.04];
const BELT: Choreo = {
  pos: [[0, Z], [0.1, BELT_POS], [0.88, BELT_POS], [1, Z]],
  rot: [[0, Z], [0.1, BELT_ROT], [0.88, BELT_ROT], [1, Z]],
  magPos: [[0.24, Z], [0.36, [-0.12, -0.38, 0.04]], [0.58, [-0.14, -0.4, 0.04]], [0.68, Z]],
  magRock: [[0, 0]], magShow: [[0, 1], [0.38, 0], [0.56, 1]],
  hand: [[0.04, 'grip'], [0.12, 'cover'], [0.2, 'cover'], [0.26, 'mag'], [0.7, 'mag'], [0.78, 'cover'], [0.84, 'cover'], [0.95, 'grip']],
  charge: [[0, 0]], cover: [[0.13, 0], [0.19, 1], [0.79, 1], [0.84, 0]],
  cues: [[0.17, 'belt_box_open_close'], [0.3, 'mag_out'], [0.66, 'mag_in'], [0.74, 'shell_link'], [0.83, 'belt_box_open_close']],
};
const BELT_EMPTY: Choreo = {
  ...BELT,
  hand: [...BELT.hand.slice(0, 7), [0.88, 'charge'], [0.93, 'charge'], [0.99, 'grip']],
  charge: [[0.89, 0], [0.92, 1], [0.935, 0]],
  cues: [...BELT.cues, [0.92, 'charging_handle_ak', 0.8]],
};

/** Bolt rifle: bolt up and back, rounds pressed in through the port, bolt forward and down. */
const BOLT: Choreo = {
  pos: [[0, Z], [0.1, [-0.03, 0.03, 0.02]], [0.9, [-0.03, 0.03, 0.02]], [1, Z]],
  rot: [[0, Z], [0.1, [0.15, 0.05, -0.35]], [0.9, [0.15, 0.05, -0.35]], [1, Z]],
  magPos: [[0, Z]], magRock: [[0, 0]], magShow: [[0, 1]],
  hand: [[0.04, 'grip'], [0.14, 'catch'], [0.3, 'away'], [0.4, 'catch'], [0.5, 'away'], [0.6, 'catch'], [0.7, 'away'], [0.8, 'catch'], [0.92, 'grip']],
  charge: [[0.05, 0], [0.12, 1], [0.84, 1], [0.9, 0]],
  cues: [[0.1, 'bolt_action_cycle'], [0.4, 'casing_drop', 0.5], [0.6, 'casing_drop', 0.5], [0.8, 'casing_drop', 0.5], [0.88, 'bolt_release']],
};

const PISTOL: Choreo = {
  pos: [[0, Z], [0.15, [-0.03, 0.05, 0.02]], [0.85, [-0.03, 0.05, 0.02]], [1, Z]],
  rot: [[0, Z], [0.15, [0.45, 0.05, -0.35]], [0.85, [0.45, 0.05, -0.35]], [1, Z]],
  magPos: [[0, Z]], magRock: [[0, 0]], magShow: [[0, 1], [0.3, 0], [0.45, 1]],
  magSlide: [[0.15, 0], [0.3, 0.6], [0.45, 0.6], [0.62, 0.1], [0.7, 0]],
  hand: [[0.05, 'grip'], [0.2, 'away'], [0.45, 'mag'], [0.72, 'mag'], [0.9, 'grip']],
  charge: [[0, 0]],
  cues: [[0.17, 'mag_out'], [0.7, 'mag_in']],
};
const PISTOL_EMPTY: Choreo = {
  ...PISTOL,
  hand: [[0.05, 'grip'], [0.2, 'away'], [0.45, 'mag'], [0.7, 'mag'], [0.78, 'charge'], [0.84, 'charge'], [0.95, 'grip']],
  charge: [[0, 1], [0.8, 1], [0.83, 1], [0.86, 0]],
  cues: [...PISTOL.cues, [0.85, 'bolt_release']],
};

/** RPG-7: the next rocket is fetched from the back and pushed into the muzzle until it seats. */
const RPG: Choreo = {
  pos: [[0, Z], [0.15, [-0.06, -0.06, 0.04]], [0.85, [-0.06, -0.06, 0.04]], [1, Z]],
  rot: [[0, Z], [0.15, [0.35, 0.3, -0.15]], [0.85, [0.35, 0.3, -0.15]], [1, Z]],
  magPos: [[0.3, [-0.2, -0.5, -0.4]], [0.55, [-0.05, -0.08, -0.35]], [0.72, [0, 0, -0.12]], [0.8, Z]],
  magRock: [[0, 0]], magShow: [[0, 0], [0.3, 1]],
  hand: [[0.05, 'grip'], [0.18, 'away'], [0.34, 'mag'], [0.8, 'mag'], [0.95, 'grip']],
  charge: [[0, 0]],
  cues: [[0.4, 'aim_cloth', 0.5], [0.78, 'rpg_load']],
};

export function choreo(def: WeaponDef, empty: boolean): Choreo | null {
  switch (styleOf(def)) {
    case 'ak': return empty ? AK_EMPTY : AK;
    case 'ar': return empty ? AR_EMPTY : AR;
    case 'belt': return empty ? BELT_EMPTY : BELT;
    case 'bolt': return BOLT;
    case 'pistol': return empty ? PISTOL_EMPTY : PISTOL;
    case 'rpg': return RPG;
    default: return null;
  }
}

const ease = (t: number) => t * t * (3 - 2 * t);
function seg<T>(keys: K<T>, p: number): [T, T, number] {
  if (p <= keys[0][0]) return [keys[0][1], keys[0][1], 0];
  for (let i = 0; i < keys.length - 1; i++) if (p < keys[i + 1][0]) return [keys[i][1], keys[i + 1][1], ease((p - keys[i][0]) / (keys[i + 1][0] - keys[i][0]))];
  const l = keys[keys.length - 1][1]; return [l, l, 0];
}
export function num(keys: K<number> | undefined, p: number, def = 0): number { if (!keys) return def; const [a, b, t] = seg(keys, p); return a + (b - a) * t; }
export function vec(keys: K<V3>, p: number, out: V3): V3 { const [a, b, t] = seg(keys, p); out[0] = a[0] + (b[0] - a[0]) * t; out[1] = a[1] + (b[1] - a[1]) * t; out[2] = a[2] + (b[2] - a[2]) * t; return out; }
/** Step track: the value of the last key at or before p. */
export function step(keys: K<number>, p: number): number { let v = keys[0][1]; for (const [t, x] of keys) if (p >= t) v = x; return v; }
export function hand(keys: K<HandAt>, p: number): [HandAt, HandAt, number] { return seg(keys, p); }

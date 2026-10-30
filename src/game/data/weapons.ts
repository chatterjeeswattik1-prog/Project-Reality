// Weapons and ammunition. Ballistic values are real-world (muzzle velocity, mass, calibre); the drag factor k (1/m)
// comes from k = ρ·Cd·A / (2m) with a typical Cd, so velocity falls as v = v0·e^(−k·x). Damage and deviation are game
// tuning (lethal like Squad / Six Days in Fallujah: one torso hit from a rifle staggers and bleeds hard, two put a man
// down, a head hit kills; Squad-style: aimed shots go where the swaying sights point, plus the mechanical dispersion `acc`; no crosshair).
// Sources: docs/RESEARCH.md §4. Values marked ~ are approximate.

export type AmmoId = '556' | '545' | '762x39' | '762x51' | '762x51lr' | '762x54' | '9x19' | '9x18' | '50bmg' | '127x108' | 'hedp40' | 'heat84' | 'pg7vl' | 'og7v' | 'frag' | 'smoke' | 'c4' | 'ied';
export interface Ammo {
  id: AmmoId; name: string;
  /** Muzzle velocity m/s (for rockets: launch speed; `boost` brings it to cruise). */ v0: number;
  /** Drag factor 1/m. */ k: number;
  /** Damage to an unarmoured torso at the muzzle (HP out of 100). */ dmg: number;
  /** Penetration class: 0 pistol, 1 intermediate rifle, 2 full-power rifle, 3 heavy MG. Decides what walls it goes through. */ pen: number;
  tracer?: number;
  explosive?: { radius: number; dmg: number; kill: number; heat?: boolean };
  rocket?: { boost: number; cruise: number; burn: number; selfDestruct?: number };
  /** Supersonic crack audible to soldiers near the path. */ crack?: boolean;
}

export const AMMO: Record<AmmoId, Ammo> = {
  '556': { id: '556', name: '5.56×45 mm M855', v0: 910, k: 1.17e-3, dmg: 66, pen: 1, crack: true },
  '545': { id: '545', name: '5.45×39 mm 7N6', v0: 735, k: 1.13e-3, dmg: 64, pen: 1, crack: true },
  '762x39': { id: '762x39', name: '7.62×39 mm M43', v0: 715, k: 1.34e-3, dmg: 76, pen: 1, crack: true },
  '762x51': { id: '762x51', name: '7.62×51 mm M80', v0: 853, k: 8.3e-4, dmg: 96, pen: 2, tracer: 5, crack: true },
  '762x51lr': { id: '762x51lr', name: '7.62×51 mm M118LR', v0: 790, k: 6.0e-4, dmg: 102, pen: 2, crack: true },
  '762x54': { id: '762x54', name: '7.62×54 mmR 57-N-323S', v0: 825, k: 8.5e-4, dmg: 96, pen: 2, tracer: 4, crack: true },
  '9x19': { id: '9x19', name: '9×19 mm M882', v0: 375, k: 1.46e-3, dmg: 40, pen: 0, crack: true },
  '9x18': { id: '9x18', name: '9×18 mm Makarov', v0: 315, k: 1.9e-3, dmg: 36, pen: 0 },
  '50bmg': { id: '50bmg', name: '.50 BMG M33', v0: 890, k: 5.4e-4, dmg: 260, pen: 3, tracer: 5, crack: true },
  '127x108': { id: '127x108', name: '12.7×108 mm B-32', v0: 840, k: 4.7e-4, dmg: 260, pen: 3, tracer: 5, crack: true },
  hedp40: { id: 'hedp40', name: '40 mm M433 HEDP', v0: 76, k: 1.5e-4, dmg: 120, pen: 0, explosive: { radius: 14, dmg: 160, kill: 4 } },
  heat84: { id: 'heat84', name: '84 mm HEAT (AT4)', v0: 285, k: 2.0e-4, dmg: 300, pen: 3, explosive: { radius: 10, dmg: 200, kill: 3, heat: true } },
  pg7vl: { id: 'pg7vl', name: 'PG-7VL HEAT', v0: 117, k: 2.0e-4, dmg: 300, pen: 3, explosive: { radius: 9, dmg: 200, kill: 3, heat: true }, rocket: { boost: 0.3, cruise: 295, burn: 1.0, selfDestruct: 920 } },
  og7v: { id: 'og7v', name: 'OG-7V frag', v0: 117, k: 2.0e-4, dmg: 150, pen: 0, explosive: { radius: 18, dmg: 180, kill: 6 }, rocket: { boost: 0.3, cruise: 290, burn: 1.0, selfDestruct: 920 } },
  frag: { id: 'frag', name: 'Fragmentation grenade', v0: 0, k: 0, dmg: 0, pen: 0, explosive: { radius: 15, dmg: 180, kill: 5 } },
  smoke: { id: 'smoke', name: 'Smoke grenade', v0: 0, k: 0, dmg: 0, pen: 0 },
  c4: { id: 'c4', name: 'C4 demolition charge', v0: 0, k: 0, dmg: 0, pen: 0, explosive: { radius: 12, dmg: 400, kill: 6 } },
  ied: { id: 'ied', name: '155 mm shell IED', v0: 0, k: 0, dmg: 0, pen: 0, explosive: { radius: 28, dmg: 500, kill: 10 } },
};

export type Optic = 'irons' | 'acog' | 'rco' | 'scope10' | 'pso1' | 'pgo7' | 'none';
export type FireMode = 'semi' | 'burst' | 'auto';
export type WeaponKind = 'rifle' | 'lmg' | 'gpmg' | 'sniper' | 'pistol' | 'launcher' | 'gl' | 'grenade' | 'charge' | 'tool';

export interface Deviation {
  /** Mechanical dispersion when aimed (mrad cone half-angle): weapon + ammunition, independent of stance. */ acc: number;
  /** Hip-fire cone (mrad): standing, crouched, prone. */ hip: [number, number, number];
  /** Added to the hip cone per shot (mrad); a quarter of it when aimed. */ kick: number;
}
export interface WeaponDef {
  id: string; name: string; faction: 'us' | 'ins' | 'any'; kind: WeaponKind; model: string;
  ammo: AmmoId; mag: number; rpm: number; modes: FireMode[];
  /** Kg, loaded: drives sway and the time to raise the sights. */ mass: number;
  optic: Optic; /** Magnification when aiming. */ zoom: number; /** Sight zero (m). */ zero: number;
  dev: Deviation;
  /** View kick per shot (mrad up, random side). */ recoil: [number, number];
  /** Reload seconds: with rounds left / from empty. */ reload: [number, number];
  /** Deployable bipod (prone, or on a ledge at chest height): sway ×0.1, recoil ×0.3, limited traverse. */ bipod?: boolean;
  /** Belt-fed: magazine is a belt box. */ belt?: boolean;
  /** Tracer every n-th round for this weapon (overrides the ammunition's; 0 = none). */ tracer?: number;
  sound: string; farSound: string;
  /** Underbarrel launcher (M203). */ under?: string;
  /** Throwables and charges: fuse seconds. */ fuse?: number;
  /** Single-shot disposable (AT4). */ disposable?: boolean;
  /** Back-blast danger zone length behind the tube (m). */ backblast?: number;
}

const RIFLE_DEV: Deviation = { acc: 0.45, hip: [38, 28, 20], kick: 4.5 };
export const WEAPONS: Record<string, WeaponDef> = {
  // ---------- US Army ----------
  m4a1: { id: 'm4a1', name: 'M4A1', faction: 'us', kind: 'rifle', model: 'm4a1', ammo: '556', mag: 30, rpm: 800, modes: ['semi', 'auto'], mass: 3.4, optic: 'irons', zoom: 1.3, zero: 300, dev: RIFLE_DEV, recoil: [3.2, 1.4], reload: [2.6, 3.3], sound: 'm4_shot', farSound: 'rifle_far' },
  m4a1_m203: { id: 'm4a1_m203', name: 'M4A1 / M203', faction: 'us', kind: 'rifle', model: 'm4a1_m203', ammo: '556', mag: 30, rpm: 800, modes: ['semi', 'auto'], mass: 5.3, optic: 'irons', zoom: 1.3, zero: 300, dev: { ...RIFLE_DEV, acc: 0.55 }, recoil: [3.0, 1.3], reload: [2.7, 3.4], sound: 'm4_shot', farSound: 'rifle_far', under: 'm203' },
  m16a4: { id: 'm16a4', name: 'M16A4', faction: 'us', kind: 'rifle', model: 'm16a4', ammo: '556', mag: 30, rpm: 800, modes: ['semi', 'burst'], mass: 3.6, optic: 'irons', zoom: 1.3, zero: 300, dev: { ...RIFLE_DEV, acc: 0.4 }, recoil: [2.8, 1.2], reload: [2.6, 3.3], sound: 'm4_shot', farSound: 'rifle_far' },
  m249: { id: 'm249', name: 'M249 SAW', faction: 'us', kind: 'lmg', model: 'm249', ammo: '556', mag: 200, rpm: 775, modes: ['auto'], mass: 7.5, optic: 'irons', zoom: 1.3, zero: 300, dev: { acc: 0.9, hip: [45, 34, 24], kick: 6 }, recoil: [3.5, 2.0], reload: [6.5, 7.5], bipod: true, belt: true, tracer: 4, sound: 'm249_shot', farSound: 'mg_far' },
  m240b: { id: 'm240b', name: 'M240B', faction: 'us', kind: 'gpmg', model: 'm240b', ammo: '762x51', mag: 100, rpm: 700, modes: ['auto'], mass: 12.5, optic: 'irons', zoom: 1.3, zero: 400, dev: { acc: 1.0, hip: [55, 42, 30], kick: 9 }, recoil: [5.5, 2.6], reload: [7.5, 8.5], bipod: true, belt: true, sound: 'm240_shot', farSound: 'mg_far' },
  m24: { id: 'm24', name: 'M24 SWS', faction: 'us', kind: 'sniper', model: 'm24', ammo: '762x51lr', mag: 5, rpm: 40, modes: ['semi'], mass: 7.3, optic: 'scope10', zoom: 10, zero: 300, dev: { acc: 0.15, hip: [60, 45, 35], kick: 12 }, recoil: [9, 2], reload: [4.5, 5.0], bipod: true, sound: 'm24_shot', farSound: 'rifle_far' },
  m9: { id: 'm9', name: 'M9 Beretta', faction: 'us', kind: 'pistol', model: 'm9', ammo: '9x19', mag: 15, rpm: 300, modes: ['semi'], mass: 1.0, optic: 'irons', zoom: 1.15, zero: 25, dev: { acc: 2.5, hip: [30, 25, 22], kick: 8 }, recoil: [8, 3], reload: [1.8, 2.2], sound: 'm9_shot', farSound: 'rifle_far' },
  m203: { id: 'm203', name: 'M203 40 mm', faction: 'us', kind: 'gl', model: 'm4a1_m203', ammo: 'hedp40', mag: 1, rpm: 30, modes: ['semi'], mass: 5.3, optic: 'irons', zoom: 1.2, zero: 150, dev: { acc: 3, hip: [30, 24, 20], kick: 20 }, recoil: [20, 4], reload: [2.5, 2.5], sound: 'm203_launch', farSound: 'rifle_far' },
  m136: { id: 'm136', name: 'M136 AT4', faction: 'us', kind: 'launcher', model: 'm136', ammo: 'heat84', mag: 1, rpm: 10, modes: ['semi'], mass: 6.7, optic: 'irons', zoom: 1.5, zero: 200, dev: { acc: 2, hip: [80, 70, 70], kick: 30 }, recoil: [25, 4], reload: [0, 0], disposable: true, backblast: 15, sound: 'at4_launch', farSound: 'explosion_far' },
  m67: { id: 'm67', name: 'M67 frag', faction: 'us', kind: 'grenade', model: 'm67', ammo: 'frag', mag: 1, rpm: 30, modes: ['semi'], mass: 0.4, optic: 'none', zoom: 1, zero: 0, dev: RIFLE_DEV, recoil: [0, 0], reload: [1.2, 1.2], fuse: 4.5, sound: 'grenade_throw', farSound: 'explosion_far' },
  m18: { id: 'm18', name: 'M18 smoke', faction: 'us', kind: 'grenade', model: 'm18', ammo: 'smoke', mag: 1, rpm: 30, modes: ['semi'], mass: 0.54, optic: 'none', zoom: 1, zero: 0, dev: RIFLE_DEV, recoil: [0, 0], reload: [1.2, 1.2], fuse: 1.6, sound: 'grenade_throw', farSound: 'explosion_far' },
  c4: { id: 'c4', name: 'C4 charge', faction: 'us', kind: 'charge', model: 'c4', ammo: 'c4', mag: 1, rpm: 30, modes: ['semi'], mass: 1.2, optic: 'none', zoom: 1, zero: 0, dev: RIFLE_DEV, recoil: [0, 0], reload: [1.5, 1.5], fuse: 15, sound: 'grenade_pin', farSound: 'explosion_far' },
  // ---------- Insurgents ----------
  akm: { id: 'akm', name: 'AKM', faction: 'ins', kind: 'rifle', model: 'akm', ammo: '762x39', mag: 30, rpm: 600, modes: ['semi', 'auto'], mass: 3.6, optic: 'irons', zoom: 1.3, zero: 300, dev: { ...RIFLE_DEV, acc: 0.6, kick: 6 }, recoil: [4.5, 1.8], reload: [3.2, 4.0], sound: 'ak_shot', farSound: 'rifle_far' },
  ak47: { id: 'ak47', name: 'AK-47 (Type 56)', faction: 'ins', kind: 'rifle', model: 'ak47', ammo: '762x39', mag: 30, rpm: 600, modes: ['semi', 'auto'], mass: 4.3, optic: 'irons', zoom: 1.3, zero: 300, dev: { ...RIFLE_DEV, acc: 0.65, kick: 6 }, recoil: [4.6, 1.9], reload: [3.3, 4.1], sound: 'ak_shot', farSound: 'rifle_far' },
  aks74u: { id: 'aks74u', name: 'AKS-74U', faction: 'ins', kind: 'rifle', model: 'aks74u', ammo: '545', mag: 30, rpm: 700, modes: ['semi', 'auto'], mass: 3.0, optic: 'irons', zoom: 1.25, zero: 200, dev: { ...RIFLE_DEV, acc: 1.0, hip: [32, 24, 18], kick: 5 }, recoil: [4.0, 2.2], reload: [3.0, 3.8], sound: 'ak_shot', farSound: 'rifle_far' },
  rpk: { id: 'rpk', name: 'RPK', faction: 'ins', kind: 'lmg', model: 'rpk', ammo: '762x39', mag: 40, rpm: 600, modes: ['semi', 'auto'], mass: 5.6, optic: 'irons', zoom: 1.3, zero: 300, dev: { acc: 0.7, hip: [42, 32, 22], kick: 6 }, recoil: [4.2, 1.8], reload: [3.2, 4.0], bipod: true, tracer: 5, sound: 'ak_shot', farSound: 'mg_far' },
  rpd: { id: 'rpd', name: 'RPD', faction: 'ins', kind: 'lmg', model: 'rpd', ammo: '762x39', mag: 100, rpm: 700, modes: ['auto'], mass: 7.4, optic: 'irons', zoom: 1.3, zero: 300, dev: { acc: 0.8, hip: [44, 33, 23], kick: 6.5 }, recoil: [4.4, 2.0], reload: [6.5, 7.5], bipod: true, belt: true, tracer: 5, sound: 'ak_shot', farSound: 'mg_far' },
  pkm: { id: 'pkm', name: 'PKM', faction: 'ins', kind: 'gpmg', model: 'pkm', ammo: '762x54', mag: 100, rpm: 650, modes: ['auto'], mass: 9.0, optic: 'irons', zoom: 1.3, zero: 300, dev: { acc: 1.0, hip: [52, 40, 28], kick: 8.5 }, recoil: [5.2, 2.5], reload: [7.0, 8.0], bipod: true, belt: true, sound: 'pkm_shot', farSound: 'mg_far' },
  svd: { id: 'svd', name: 'SVD Dragunov / PSO-1', faction: 'ins', kind: 'sniper', model: 'svd', ammo: '762x54', mag: 10, rpm: 120, modes: ['semi'], mass: 4.7, optic: 'pso1', zoom: 4, zero: 300, dev: { acc: 0.3, hip: [55, 42, 32], kick: 10 }, recoil: [7, 2], reload: [3.0, 3.6], tracer: 0, sound: 'svd_shot', farSound: 'rifle_far' },
  rpg7: { id: 'rpg7', name: 'RPG-7 / PG-7VL', faction: 'ins', kind: 'launcher', model: 'rpg7', ammo: 'pg7vl', mag: 1, rpm: 10, modes: ['semi'], mass: 7.0, optic: 'pgo7', zoom: 2.7, zero: 200, dev: { acc: 2.2, hip: [80, 70, 70], kick: 25 }, recoil: [18, 4], reload: [4.5, 4.5], backblast: 20, sound: 'rpg_launch', farSound: 'explosion_far' },
  makarov: { id: 'makarov', name: 'Makarov PM', faction: 'ins', kind: 'pistol', model: 'makarov', ammo: '9x18', mag: 8, rpm: 300, modes: ['semi'], mass: 0.8, optic: 'irons', zoom: 1.15, zero: 25, dev: { acc: 3, hip: [30, 25, 22], kick: 8 }, recoil: [8, 3], reload: [1.8, 2.2], sound: 'makarov_shot', farSound: 'rifle_far' },
  f1: { id: 'f1', name: 'F1 frag', faction: 'ins', kind: 'grenade', model: 'f1', ammo: 'frag', mag: 1, rpm: 30, modes: ['semi'], mass: 0.6, optic: 'none', zoom: 1, zero: 0, dev: RIFLE_DEV, recoil: [0, 0], reload: [1.2, 1.2], fuse: 3.8, sound: 'grenade_throw', farSound: 'explosion_far' },
  ied: { id: 'ied', name: 'IED (155 mm shell)', faction: 'ins', kind: 'charge', model: 'ied', ammo: 'ied', mag: 1, rpm: 30, modes: ['semi'], mass: 45, optic: 'none', zoom: 1, zero: 0, dev: RIFLE_DEV, recoil: [0, 0], reload: [2, 2], fuse: 0, sound: 'grenade_pin', farSound: 'explosion_far' },
  // ---------- vehicle guns ----------
  m2: { id: 'm2', name: 'M2 .50 cal', faction: 'us', kind: 'gpmg', model: 'm2', ammo: '50bmg', mag: 100, rpm: 550, modes: ['auto'], mass: 38, optic: 'irons', zoom: 1.4, zero: 500, dev: { acc: 2.2, hip: [6, 6, 6], kick: 2.5 }, recoil: [3, 1.5], reload: [8, 9], belt: true, sound: 'm2_shot', farSound: 'heavy_far' },
  dshk: { id: 'dshk', name: 'DShK 12.7 mm', faction: 'ins', kind: 'gpmg', model: 'dshk', ammo: '127x108', mag: 50, rpm: 600, modes: ['auto'], mass: 34, optic: 'irons', zoom: 1.4, zero: 500, dev: { acc: 2.8, hip: [7, 7, 7], kick: 3 }, recoil: [3.5, 1.8], reload: [8, 9], belt: true, sound: 'dshk_shot', farSound: 'heavy_far' },
};

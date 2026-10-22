// Kits per faction, after Project Reality's insurgency layers (docs/RESEARCH.md §3). Magazine counts are approximate.
export type Faction = 'us' | 'ins';
export interface KitItem { weapon: string; /** Spare magazines/belts (or count for grenades, rockets, charges). */ count: number }
export interface Kit {
  id: string; name: string; faction: Faction; role: KitRole;
  /** Slots 1–5: 1 primary, 2 sidearm, 3 grenades/smoke, 4 special (launcher, charges), 5 field dressings/medkit. */
  items: KitItem[];
  bandages: number; medic?: boolean; leader?: boolean; ammoBag?: boolean;
  /** Character model id. */ model: string[];
  /** Max per squad for bots. */ perSquad: number;
}
export type KitRole = 'leader' | 'rifleman' | 'grenadier' | 'ar' | 'mg' | 'marksman' | 'medic' | 'engineer' | 'lat' | 'at' | 'sapper';

export const KITS: Kit[] = [
  // US Army
  { id: 'us_sl', name: 'Squad Leader', faction: 'us', role: 'leader', items: [{ weapon: 'm4a1', count: 6 }, { weapon: 'm9', count: 3 }, { weapon: 'm18', count: 4 }, { weapon: 'm67', count: 1 }], bandages: 4, leader: true, model: ['us_rifleman', 'us_rifleman_b'], perSquad: 1 },
  { id: 'us_rifle', name: 'Rifleman', faction: 'us', role: 'rifleman', items: [{ weapon: 'm4a1', count: 7 }, { weapon: 'm67', count: 2 }, { weapon: 'm18', count: 2 }], bandages: 4, ammoBag: true, model: ['us_rifleman', 'us_rifleman_b'], perSquad: 6 },
  { id: 'us_gren', name: 'Grenadier', faction: 'us', role: 'grenadier', items: [{ weapon: 'm4a1_m203', count: 6 }, { weapon: 'm203', count: 9 }, { weapon: 'm18', count: 2 }], bandages: 4, model: ['us_rifleman', 'us_rifleman_b'], perSquad: 1 },
  { id: 'us_ar', name: 'Automatic Rifleman', faction: 'us', role: 'ar', items: [{ weapon: 'm249', count: 3 }, { weapon: 'm9', count: 3 }, { weapon: 'm18', count: 1 }], bandages: 4, model: ['us_rifleman', 'us_rifleman_b'], perSquad: 1 },
  { id: 'us_medic', name: 'Medic', faction: 'us', role: 'medic', items: [{ weapon: 'm16a4', count: 6 }, { weapon: 'm18', count: 4 }], bandages: 10, medic: true, model: ['us_rifleman', 'us_rifleman_b'], perSquad: 1 },
  { id: 'us_eng', name: 'Combat Engineer', faction: 'us', role: 'engineer', items: [{ weapon: 'm4a1', count: 5 }, { weapon: 'c4', count: 2 }, { weapon: 'm67', count: 1 }], bandages: 4, model: ['us_rifleman', 'us_rifleman_b'], perSquad: 1 },
  { id: 'us_lat', name: 'Rifleman AT (LAT)', faction: 'us', role: 'lat', items: [{ weapon: 'm4a1', count: 5 }, { weapon: 'm136', count: 1 }, { weapon: 'm18', count: 1 }], bandages: 4, model: ['us_rifleman', 'us_rifleman_b'], perSquad: 1 },
  { id: 'us_mg', name: 'Machine Gunner', faction: 'us', role: 'mg', items: [{ weapon: 'm240b', count: 3 }, { weapon: 'm9', count: 3 }], bandages: 4, model: ['us_rifleman', 'us_rifleman_b'], perSquad: 1 },
  { id: 'us_sniper', name: 'Sniper', faction: 'us', role: 'marksman', items: [{ weapon: 'm24', count: 6 }, { weapon: 'm9', count: 3 }], bandages: 4, model: ['us_rifleman', 'us_rifleman_b'], perSquad: 1 },
  // Insurgents
  { id: 'ins_cell', name: 'Cell Leader', faction: 'ins', role: 'leader', items: [{ weapon: 'akm', count: 5 }, { weapon: 'makarov', count: 2 }, { weapon: 'f1', count: 1 }], bandages: 3, leader: true, model: ['insurgent_c', 'insurgent_a'], perSquad: 1 },
  { id: 'ins_rifle', name: 'Insurgent', faction: 'ins', role: 'rifleman', items: [{ weapon: 'akm', count: 6 }, { weapon: 'f1', count: 1 }], bandages: 3, model: ['insurgent_a', 'insurgent_b', 'insurgent_c'], perSquad: 8 },
  { id: 'ins_rifle2', name: 'Insurgent (AK-47)', faction: 'ins', role: 'rifleman', items: [{ weapon: 'ak47', count: 6 }, { weapon: 'f1', count: 1 }], bandages: 3, model: ['insurgent_b', 'insurgent_a'], perSquad: 8 },
  { id: 'ins_at', name: 'Anti-Tank (RPG)', faction: 'ins', role: 'at', items: [{ weapon: 'aks74u', count: 3 }, { weapon: 'rpg7', count: 3 }], bandages: 3, model: ['insurgent_a', 'insurgent_c'], perSquad: 2 },
  { id: 'ins_mg', name: 'Machine Gunner', faction: 'ins', role: 'mg', items: [{ weapon: 'pkm', count: 2 }, { weapon: 'makarov', count: 2 }], bandages: 3, model: ['insurgent_c', 'insurgent_b'], perSquad: 1 },
  { id: 'ins_rpk', name: 'Automatic Rifleman', faction: 'ins', role: 'ar', items: [{ weapon: 'rpk', count: 5 }, { weapon: 'f1', count: 1 }], bandages: 3, model: ['insurgent_b', 'insurgent_a'], perSquad: 1 },
  { id: 'ins_marks', name: 'Marksman', faction: 'ins', role: 'marksman', items: [{ weapon: 'svd', count: 5 }, { weapon: 'makarov', count: 2 }], bandages: 3, model: ['insurgent_a', 'insurgent_c'], perSquad: 1 },
  { id: 'ins_medic', name: 'Medic', faction: 'ins', role: 'medic', items: [{ weapon: 'aks74u', count: 4 }], bandages: 10, medic: true, model: ['insurgent_b'], perSquad: 1 },
  { id: 'ins_sapper', name: 'Sapper', faction: 'ins', role: 'sapper', items: [{ weapon: 'makarov', count: 3 }, { weapon: 'ied', count: 2 }], bandages: 3, model: ['insurgent_c'], perSquad: 1 },
];
export const kitById = (id: string) => KITS.find((k) => k.id === id)!;

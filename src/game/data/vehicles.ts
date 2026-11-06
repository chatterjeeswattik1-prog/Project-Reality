// Armoured vehicles. Dimensions, weights, speeds, armament and ammunition loads from public sources (US Army fact
// files, Jane's, FAS); armour figures are public RHA-equivalent estimates and are approximate (marked ~). Crew rules
// follow Project Reality: the crew seats need a Crewman kit, the gunner's cannon works only with a driver aboard and
// after the turret has warmed up, switching ammunition costs a reload.
import type { AmmoId } from './weapons';

export type SeatRole = 'driver' | 'gunner' | 'commander' | 'loader' | 'cargo';
/** Armour per face in mm RHA: ke against kinetic rounds, ce against shaped charges; era = the part of ce that a tandem
 *  warhead defeats (explosive reactive armour tiles). */
export interface Armour { ke: number; ce: number; era?: number }
export interface ArmourSet { front: Armour; side: Armour; rear: Armour; top: Armour; bottom: Armour }

export interface MountDef {
  id: string;
  /** Ammunition types (the gunner switches between them: a reload). */ ammo: AmmoId[];
  /** Rounds ready per type, and stowed (moved to ready by the crew between engagements). */ ready: number[]; stowed: number[];
  /** Muzzle node in the model; `aim` = which part aims it: the gun (turret + elevation) or its own remote station. */
  node: string; aim: 'gun' | 'station' | 'launcher';
  /** Rounds per minute (automatic) or 0 for a single-shot cannon / launcher. */ rpm: number;
  /** Seconds to reload one round (cannon, launcher) or a belt (MG): with a loader / without one. */ reload: [number, number];
  /** Belt or magazine size for automatic weapons. */ belt?: number;
  /** Dispersion (mrad, half-angle). */ spread: number;
  /** Tracer every n-th round (1 = all). */ tracer?: number;
  /** Fire sound and far sound. */ sound: string; far: string; rate?: number;
  /** Launchers (TOW): the vehicle must stand still this long (launcher erected) before a missile can go. */ still?: number;
  /** Rate selector (25 mm: high 200 / low 100 rpm). */ rates?: number[];
}

export interface SeatDef {
  role: SeatRole; node: string; label: string;
  /** Mounts this seat fires (the first is the primary). */ mounts: string[];
  /** Optic magnifications (first = wide). */ zoom: number[];
  /** Thermal sight available. */ thermal?: boolean;
  /** Looks through the turret's sight (follows the gun) or from its own station / hatch / vision blocks. */ view: 'gun' | 'station' | 'hatch' | 'hull' | 'cargo';
  /** Needs a Crewman kit. */ crew: boolean;
}

export interface VehicleDef {
  id: string; name: string; model: string;
  /** Combat weight (kg). */ mass: number;
  /** Hull box for physics (m): width, height, length; turret box; turret ring radius (hit zone). */
  hull: [number, number, number]; turret: [number, number, number]; ringR: number;
  /** Road / cross-country top speed, reverse (m/s); acceleration (m/s²); pivot turn rate (rad/s). */
  vmax: number; vmaxOff: number; vrev: number; accel: number; pivot: number;
  /** Turret traverse (rad/s), gun elevation limits (rad) and rate. */ traverse: number; elev: [number, number]; elevRate: number;
  /** Seconds after taking the gunner's seat before the cannon can be aimed (PR turret warm-up). */ warmup: number;
  hullArmour: ArmourSet; turretArmour: ArmourSet;
  /** Top of the running gear (m): hits low on the sides below this can break a track. */ trackTop: number;
  seats: SeatDef[]; mounts: MountDef[];
  /** Smoke grenade salvos (M250 / M257 launchers). */ smoke: number;
  engine: 'turbine' | 'diesel';
  /** Respawn time at the FOB after destruction (s). */ respawn: number;
}

const A = (ke: number, ce: number, era = 0): Armour => ({ ke, ce, era });

export const VEHICLES: Record<string, VehicleDef> = {
  // M1A2 Abrams (SEP-era, with TUSK side tiles): 62.1 t, 9.83 m with the gun forward, hull 7.93 m, 3.66 m wide,
  // 2.44 m high. AGT1500 gas turbine 1,500 hp; 67 km/h road (governed), ~48 km/h cross-country. Turret 360° in ~9 s,
  // gun −9° / +20°. 120 mm M256 (42 rounds; 34 ready in the bustle behind blow-out panels), coax M240C, loader's
  // M240, commander's M2HB on CROWS. Armour (~, RHA equivalent): turret front ~950 KE / ~1500 CE, glacis ~570 / ~800.
  m1a2: {
    id: 'm1a2', name: 'M1A2 Abrams', model: 'm1a2', mass: 62100,
    hull: [3.5, 1.15, 7.9], turret: [3.3, 0.85, 5.6], ringR: 1.5,
    vmax: 18.8, vmaxOff: 13.3, vrev: 8.0, accel: 1.6, pivot: 0.55,
    traverse: 0.70, elev: [-0.157, 0.349], elevRate: 0.42, warmup: 12,
    hullArmour: { front: A(570, 800), side: A(90, 400, 250), rear: A(40, 60), top: A(40, 60), bottom: A(30, 40) },
    turretArmour: { front: A(950, 1500), side: A(300, 500), rear: A(60, 80), top: A(50, 70), bottom: A(300, 300) },
    trackTop: 0.95,
    seats: [
      { role: 'driver', node: 'seat_driver', label: 'Driver', mounts: [], zoom: [1], view: 'hull', crew: true, thermal: true },
      { role: 'gunner', node: 'seat_gunner', label: 'Gunner', mounts: ['main', 'coax'], zoom: [3, 10], view: 'gun', crew: true, thermal: true },
      { role: 'commander', node: 'seat_commander', label: 'Commander (CROWS .50)', mounts: ['cmdr'], zoom: [1, 4], view: 'station', crew: true, thermal: true },
      { role: 'loader', node: 'seat_loader', label: 'Loader (M240)', mounts: ['loader'], zoom: [1], view: 'hatch', crew: true },
    ],
    mounts: [
      { id: 'main', ammo: ['120apfsds', '120heat'], ready: [17, 17], stowed: [4, 4], node: 'muzzle', aim: 'gun', rpm: 0, reload: [6, 15], spread: 0.15, tracer: 1, sound: 'tank_fire', far: 'explosion_far' },
      { id: 'coax', ammo: ['762x51'], ready: [1000], stowed: [9000], node: 'coax', aim: 'gun', rpm: 750, reload: [6, 6], belt: 200, spread: 0.7, tracer: 5, sound: 'm240_shot', far: 'heavy_far' },
      { id: 'cmdr', ammo: ['50bmg'], ready: [400], stowed: [500], node: 'mg_cmdr', aim: 'station', rpm: 500, reload: [8, 8], belt: 100, spread: 0.9, tracer: 5, sound: 'm2_shot', far: 'heavy_far' },
      { id: 'loader', ammo: ['762x51'], ready: [600], stowed: [800], node: 'mg_loader', aim: 'station', rpm: 650, reload: [6, 6], belt: 200, spread: 1.4, tracer: 5, sound: 'm240_shot', far: 'heavy_far' },
    ],
    smoke: 2, engine: 'turbine', respawn: 600,
  },
  // M2A3 Bradley IFV: 30.4 t, 6.55 m, 3.6 m wide (with tiles), 2.98 m high; Cummins VTA-903T 600 hp, 61 km/h road.
  // Turret ~60°/s, gun −9° / +59°. 25 mm M242 Bushmaster (300 ready: 70 AP + 230 HE; single, 100 or 200 rpm), coax
  // M240C, twin TOW launcher (2 ready, 5 stowed; erected and fired only at a halt). Crew 3 + 6 dismounts.
  // Armour (~): aluminium hull with spaced steel, ~30 mm-class protection front against 30 mm, BRAT reactive tiles.
  m2a3: {
    id: 'm2a3', name: 'M2A3 Bradley', model: 'm2a3', mass: 30400,
    hull: [3.2, 1.35, 6.4], turret: [2.6, 0.9, 2.9], ringR: 1.1,
    vmax: 16.9, vmaxOff: 12.5, vrev: 7.0, accel: 1.8, pivot: 0.65,
    traverse: 1.0, elev: [-0.157, 1.03], elevRate: 0.7, warmup: 8,
    hullArmour: { front: A(45, 350, 260), side: A(30, 300, 260), rear: A(25, 40), top: A(20, 30), bottom: A(15, 20) },
    turretArmour: { front: A(40, 300, 220), side: A(25, 250, 200), rear: A(20, 30), top: A(20, 30), bottom: A(30, 30) },
    trackTop: 0.85,
    seats: [
      { role: 'driver', node: 'seat_driver', label: 'Driver', mounts: [], zoom: [1], view: 'hull', crew: true },
      { role: 'gunner', node: 'seat_gunner', label: 'Gunner', mounts: ['main', 'coax', 'tow'], zoom: [4, 12], view: 'gun', crew: true, thermal: true },
      { role: 'commander', node: 'seat_commander', label: 'Commander', mounts: [], zoom: [1, 4], view: 'station', crew: false, thermal: true },
      ...[0, 1, 2, 3, 4, 5].map((i): SeatDef => ({ role: 'cargo', node: `seat_cargo_${i}`, label: `Dismount ${i + 1}`, mounts: [], zoom: [1], view: 'cargo', crew: false })),
    ],
    mounts: [
      { id: 'main', ammo: ['25ap', '25he'], ready: [70, 230], stowed: [150, 450], node: 'muzzle', aim: 'gun', rpm: 200, rates: [200, 100], reload: [4, 8], belt: 70, spread: 0.6, tracer: 1, sound: 'cannon25', far: 'heavy_far' },
      { id: 'coax', ammo: ['762x51'], ready: [800], stowed: [1400], node: 'coax', aim: 'gun', rpm: 750, reload: [6, 6], belt: 200, spread: 0.7, tracer: 5, sound: 'm240_shot', far: 'heavy_far' },
      { id: 'tow', ammo: ['tow2'], ready: [2], stowed: [5], node: 'tow', aim: 'launcher', rpm: 0, reload: [40, 60], spread: 0.3, sound: 'tow_launch', far: 'explosion_far', still: 4 },
    ],
    smoke: 2, engine: 'diesel', respawn: 480,
  },
};

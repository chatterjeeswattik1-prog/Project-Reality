// Armour and damage. A hit is placed on the turret or the hull, on one face (front / side / rear / top / bottom, from
// the direction the round came from) with a modest obliquity bonus; the round's penetration (kinetic, falling with
// velocity, or shaped-charge, with tandem warheads ignoring reactive armour) is compared with that face's armour.
// A penetration damages the vehicle by the round's size and what it reaches: crew in that compartment, the engine
// (rear hull: the vehicle stops and may burn), the ammunition (the M1A2's bustle vents through its blow-out panels; a
// Bradley's may cook off), the turret drive. Low side hits can break a track (immobilised). Non-penetrating hits do
// little. Values are game approximations of the real behaviour.
import * as THREE from 'three';
import type { Ammo } from '../game/data/weapons';
import type { ArmourSet } from '../game/data/vehicles';
import type { Soldier } from '../game/soldier';
import type { Vehicle } from './vehicle';

type V3 = [number, number, number];
export type Face = 'front' | 'side' | 'rear' | 'top' | 'bottom';
export interface StrikeResult { pen: boolean; zone: 'hull' | 'turret'; face: Face; eff: number; pv: number; track: boolean; comp: string | null; dmg: number }

const NORMALS: Record<Face, THREE.Vector3> = { front: new THREE.Vector3(0, 0, -1), rear: new THREE.Vector3(0, 0, 1), side: new THREE.Vector3(1, 0, 0), top: new THREE.Vector3(0, 1, 0), bottom: new THREE.Vector3(0, -1, 0) };

/**
 * A round (or a blast: `blast` = its shaped-charge-like penetration) strikes vehicle v at world point p travelling along
 * dir (unit). Applies the damage and returns what happened.
 */
export function strike(v: Vehicle, p: V3, dir: V3, a: Ammo | null, speed: number, by: Soldier | null, blast?: number): StrikeResult {
  const inv = new THREE.Quaternion().copy(v.root.quaternion).invert();
  const lp = v.toLocal(p);
  const ld = new THREE.Vector3(dir[0], dir[1], dir[2]).applyQuaternion(inv);
  // Turret zone: above the ring and within the turret's footprint (in the turret's own frame).
  const tp = lp.clone().sub(v.ring).applyAxisAngle(new THREE.Vector3(0, 1, 0), -v.turretYaw);
  const inTurret = lp.y > v.ring.y - 0.08 && Math.abs(tp.x) < v.def.turret[0] / 2 + 0.3 && tp.z > -v.def.turret[2] / 2 - 0.6 && tp.z < v.def.turret[2] / 2 + 1.0;
  const from = ld.clone().negate();
  if (inTurret) from.applyAxisAngle(new THREE.Vector3(0, 1, 0), -v.turretYaw);
  let face: Face;
  if (from.y > 0.65) face = 'top';
  else if (from.y < -0.65) face = 'bottom';
  else {
    const al = Math.abs(Math.atan2(from.x, -from.z)) * 180 / Math.PI;
    face = al <= (inTurret ? 35 : 40) ? 'front' : al >= 140 ? 'rear' : 'side';
  }
  const set: ArmourSet = inTurret ? v.def.turretArmour : v.def.hullArmour, arm = set[face];
  const n = NORMALS[face].clone(); if (face === 'side' && from.x < 0) n.x = -1;
  const cos = Math.max(0.3, from.clone().normalize().dot(n));
  const ob = Math.min(2, Math.pow(1 / cos, 0.7));
  // Penetration: kinetic (falls with the remaining velocity) and shaped charge; tandem warheads strip the ERA.
  const ke = a?.ap ? a.ap * Math.pow(Math.max(0.2, speed / a.v0), 1.3) : 0;
  const ce = blast ?? (a?.ce ?? 0);
  const keEff = arm.ke * ob, ceEff = (arm.ce - (a?.tandem ? arm.era ?? 0 : 0)) * ob;
  const penKE = ke > 0 && ke >= keEff, penCE = ce > 0 && ce >= ceEff;
  const pen = penKE || penCE;
  const pv = Math.max(ke, ce), eff = penCE || (ce > 0 && !penKE) ? ceEff : keEff;
  // Damage (% integrity).
  let dmg = 0, comp: string | null = null;
  if (pen) {
    const over = Math.min(1, (pv - eff) / Math.max(20, eff));
    const base = pv >= 300 ? 34 : pv >= 80 ? 11 : pv >= 30 ? 4 : 1.5;
    dmg = base * (0.8 + 0.6 * over);
    const abrams = v.def.id === 'm1a2', hl = v.def.hull[2];
    if (inTurret) {
      comp = face === 'rear' ? 'ammo' : 'turret';
      if (comp === 'ammo') {
        if (abrams) {
          // Bustle ammunition behind blow-out panels: the ready rounds burn off outward through the roof panels; the
          // crew, behind the ammunition doors, is spared.
          const main = v.mounts[0]; main.ready = main.ready.map(() => 0); if (Math.random() < 0.5) v.burning = true;
        } else {
          // Bradley: 25 mm ready boxes and the TOW rounds in the turret: a cook-off can take the vehicle.
          if (Math.random() < 0.3) dmg = 999;
          crew(v, ['gunner', 'commander'], pv, p, by);
        }
      } else {
        if (pv >= 80 && Math.random() < 0.25) v.turretJam = true;
        crew(v, ['gunner', 'commander', 'loader'], pv, p, by);
      }
    } else if (abrams) {
      // M1A2: driver in the front centre, the turbine and fuel at the rear.
      if (face === 'rear' || lp.z > hl * 0.15) { comp = 'engine'; if (pv >= 60) { v.engineOut = true; if (Math.random() < 0.5) v.burning = true; } }
      else { comp = 'driver'; crew(v, ['driver'], pv, p, by); if (face === 'side' && pv >= 300 && Math.random() < 0.3) v.burning = true; }
    } else {
      // M2A3: the diesel front right beside the driver (front left); the troop compartment behind the turret.
      if (lp.z < -hl * 0.2 && lp.x > 0) { comp = 'engine'; if (pv >= 60) { v.engineOut = true; if (Math.random() < 0.4) v.burning = true; } }
      else if (lp.z < -hl * 0.2) { comp = 'driver'; crew(v, ['driver'], pv, p, by); }
      else { comp = 'troops'; crew(v, ['cargo', 'commander'], pv, p, by); if (pv >= 300 && Math.random() < 0.35) v.burning = true; }
    }
  } else {
    dmg = pv >= 300 ? 2 : pv >= 80 ? 0.5 : 0;
  }
  // Tracks: a hit low on the running gear (sides, or the front/rear corners) by anything heavier than a bullet.
  let track = false;
  if (!inTurret && lp.y < v.def.trackTop && Math.abs(lp.x) > v.def.hull[0] / 2 - 0.75 && (face === 'side' || face === 'bottom' || Math.abs(lp.z) > v.def.hull[2] / 2 - 1.2)) {
    const heavy = (a?.explosive && (ce >= 60 || (a.explosive.dmg ?? 0) >= 150)) || blast !== undefined || ke >= 60;
    if (heavy && Math.random() < (blast !== undefined ? 0.8 : a?.explosive ? 0.6 : 0.35)) { track = true; v.tracked = true; }
  }
  v.hurt(dmg);
  return { pen, zone: inTurret ? 'turret' : 'hull', face, eff, pv, track, comp, dmg };
}

/** Behind-armour effects: spall and fragments reach the crew in the struck compartment. */
function crew(v: Vehicle, roles: string[], pv: number, p: V3, by: Soldier | null) {
  const k = pv >= 300 ? 0.65 : pv >= 80 ? 0.35 : 0.15;
  for (const st of v.seats) {
    const w = st.who; if (!w?.alive || !roles.includes(st.def.role)) continue;
    if (Math.random() < k) {
      const hp = 30 + Math.random() * (pv >= 300 ? 140 : 70);
      w.damage(hp, Math.random() < 0.2 ? 'head' : 'chest', p, by, v.g.time, true);
      if (w.state !== 'alive') v.g.events.onDown?.(w, by, w.state === 'dead');
    }
  }
}

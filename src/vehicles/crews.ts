// The armoured vehicles of a side and their AI crews. Vehicles start at the FOB's motor pool fully crewed by AI
// crewmen (Crewman kit); an empty crew seat is filled again by an AI crewman a few seconds later (the player can take
// any seat: the AI moves over). A destroyed vehicle is replaced at its motor-pool slot after its respawn time.
import * as THREE from 'three';
import { gltf } from '../core/assets';
import { VEHICLES } from '../game/data/vehicles';
import { kitById } from '../game/data/kits';
import type { Game } from '../game/game';
import type { Faction } from '../game/data/kits';
import { Vehicle } from './vehicle';
import { VehicleAI } from './vai';
import { VehiclePlanner } from './planner';
import { groundH } from '../world/terrain';

type V3 = [number, number, number];
interface Slot { id: string; x: number; z: number; ry: number; v: Vehicle | null; respawnT: number; refillT: number[] }
const CREW_NAMES = ['Sgt. Reyes', 'Spc. Novak', 'Pvt. Hale', 'Cpl. Brandt', 'Spc. Ortega', 'Pvt. Kim', 'Sgt. Walsh', 'Spc. Diaz', 'Pvt. Ford', 'Cpl. Ames', 'Spc. Grant', 'Pvt. Lowe', 'Sgt. Pike', 'Spc. Yates', 'Pvt. Cole', 'Cpl. Shaw'];

export class VehicleCrews {
  slots: Slot[] = [];
  planner: VehiclePlanner;
  private models = new Map<string, THREE.Object3D>();
  private nameI = 0;

  constructor(private g: Game, private team: Faction) {
    this.planner = new VehiclePlanner(g.P, g.city, (x, z) => g.isRoad(x, z));
  }

  async load(ids: string[]) {
    await Promise.all([...new Set(ids)].map(async (id) => {
      const def = VEHICLES[id]; if (!def) return;
      const m = await gltf(`models/vehicles/${def.model}.glb`);
      if (m) this.models.set(id, m.scene.getObjectByName(def.model) ?? m.scene);
    }));
  }

  /** Add a motor-pool slot and its vehicle (crewed by AI). */
  add(id: string, x: number, z: number, ry: number): Vehicle | null {
    const slot: Slot = { id, x, z, ry, v: null, respawnT: 0, refillT: [] };
    this.slots.push(slot);
    this.spawn(slot);
    return slot.v;
  }

  private spawn(slot: Slot) {
    const def = VEHICLES[slot.id], model = this.models.get(slot.id); if (!def || !model) return;
    const v = new Vehicle(this.g, def, model, [slot.x, groundH(slot.x, slot.z), slot.z], slot.ry, this.team);
    this.g.vehicles.push(v);
    new VehicleAI(v, this.planner);
    slot.v = v; slot.refillT = v.seats.map(() => 0);
    for (let i = 0; i < v.seats.length; i++) if (this.wantsCrew(v, i)) this.crewman(v, i);
  }

  /** Seats the AI keeps manned: driver and gunner, and on the M1A2 the commander and loader too. */
  private wantsCrew(v: Vehicle, i: number) { const r = v.seats[i].def.role; return r === 'driver' || r === 'gunner' || (v.def.id === 'm1a2' && (r === 'commander' || r === 'loader')); }

  private crewman(v: Vehicle, i: number) {
    const p = v.nodePos(v.seats[i].def.node);
    const s = this.g.spawn(kitById('us_crew'), this.team, [p[0], p[1] - 1.6, p[2]], CREW_NAMES[this.nameI++ % CREW_NAMES.length], v.yaw());
    s.squad = 90 + this.g.vehicles.indexOf(v);
    v.enter(s, i);
  }

  update(dt: number) {
    for (const slot of this.slots) {
      const v = slot.v;
      if (!v) continue;
      if (v.dead) {
        // The wreck stays; a new vehicle arrives at the slot after the respawn time (the wreck is cleared then).
        if ((slot.respawnT += dt) > v.def.respawn) {
          slot.respawnT = 0;
          for (const st of v.seats) if (st.who) v.exit(st.who, true);
          v.dispose(); this.g.vehicles.splice(this.g.vehicles.indexOf(v), 1);
          this.spawn(slot);
        }
        continue;
      }
      v.ai?.update(dt);
      // Empty crew seats are manned again (not while the vehicle burns, and the player's seat is his).
      for (let i = 0; i < v.seats.length; i++) {
        if (v.seats[i].who || !this.wantsCrew(v, i) || v.burning) { slot.refillT[i] = 0; continue; }
        if ((slot.refillT[i] += dt) > 8) { slot.refillT[i] = 0; this.crewman(v, i); }
      }
      // Burning: the AI crew bails out.
      if (v.burning) for (const st of v.seats) if (st.who && !st.who.isPlayer) v.exit(st.who, true);
    }
  }

  /** A vehicle near a point (test areas: `?veh=m1a2` puts one beside the player's spawn). */
  near(p: V3, r: number): Vehicle | null { return this.g.vehicles.find((v) => !v.dead && Math.hypot(v.pos()[0] - p[0], v.pos()[2] - p[2]) < r) ?? null; }
}

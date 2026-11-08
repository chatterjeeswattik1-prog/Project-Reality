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
interface Slot { id: string; x: number; z: number; ry: number; v: Vehicle | null; respawnT: number; refillT: number[]; crewed: boolean }
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
  /** Sandbox: vehicles start empty and open to either side; an AI crew joins only when someone gets in. */
  sandbox = false;

  add(id: string, x: number, z: number, ry: number, crewed = !this.sandbox): Vehicle | null {
    const slot: Slot = { id, x, z, ry, v: null, respawnT: 0, refillT: [], crewed };
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
    if (slot.crewed) for (let i = 0; i < v.seats.length; i++) if (this.wantsCrew(v, i)) this.crewman(v, i);
  }

  /** Multiplayer client: the same vehicle as the host's, without crew or AI, posed by snapshots (net/client.ts). */
  addRemote(id: string, x: number, z: number, ry: number): Vehicle | null {
    const def = VEHICLES[id], model = this.models.get(id); if (!def || !model) return null;
    const v = new Vehicle(this.g, def, model, [x, groundH(x, z), z], ry, this.team);
    v.netRemote = true;
    v.body.setBodyType(this.g.P.R.RigidBodyType.KinematicPositionBased, true);
    this.g.vehicles.push(v);
    return v;
  }

  /** Take a vehicle out of play (sandbox clean-up); its slot is dropped. */
  remove(v: Vehicle) {
    const i = this.slots.findIndex((x) => x.v === v); if (i >= 0) this.slots.splice(i, 1);
    for (const st of v.seats) if (st.who) { const w = st.who; v.exit(w, true); if (!w.isPlayer && this.g.soldiers.includes(w)) this.g.remove(w); }
    v.dispose(); const k = this.g.vehicles.indexOf(v); if (k >= 0) this.g.vehicles.splice(k, 1);
  }

  /** Seats the AI keeps manned: driver and gunner, and on the M1A2 the commander too. */
  private wantsCrew(v: Vehicle, i: number) { const r = v.seats[i].def.role; return r === 'driver' || r === 'gunner' || (v.def.id === 'm1a2' && r === 'commander'); }

  private crewman(v: Vehicle, i: number) {
    const p = v.nodePos(v.seats[i].def.node);
    const team = v.team, s = this.g.spawn(kitById(team === 'us' ? 'us_crew' : 'ins_rifle'), team, [p[0], p[1] - 1.6, p[2]], team === 'us' ? CREW_NAMES[this.nameI++ % CREW_NAMES.length] : `Crew ${++this.nameI}`, v.yaw());
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
      // Empty crew seats are manned again (not while the vehicle burns, and the player's seat is his). In the sandbox
      // only a vehicle someone is in (or one spawned crewed) gets a crew, at once.
      const manned = !this.sandbox || slot.crewed || v.seats.some((x) => x.who?.isPlayer);
      for (let i = 0; i < v.seats.length; i++) {
        if (v.seats[i].who || !this.wantsCrew(v, i) || v.burning || !manned) { slot.refillT[i] = 0; continue; }
        if ((slot.refillT[i] += dt) > (this.sandbox ? 1.5 : 8)) { slot.refillT[i] = 0; this.crewman(v, i); }
      }
      // Burning: the AI crew bails out.
      if (v.burning) for (const st of v.seats) if (st.who && !st.who.isPlayer) v.exit(st.who, true);
    }
  }

  /** A vehicle near a point (test areas: `?veh=m1a2` puts one beside the player's spawn). */
  near(p: V3, r: number): Vehicle | null { return this.g.vehicles.find((v) => !v.dead && Math.hypot(v.pos()[0] - p[0], v.pos()[2] - p[2]) < r) ?? null; }
}

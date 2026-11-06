// Tracked armour (M1A2, M2A3). A Rapier rigid body (hull + turret boxes) carried by a ray-cast spring/damper
// suspension (5 points per track) with track traction modelled at the hull: a speed target per throttle (road /
// cross-country limits, acceleration limit), sideslip killed by the tracks' grip and a yaw-rate target for skid
// steering (pivot turns in place). Turret and gun slew towards the aim at their real rates. Weapons per mount (ready /
// stowed ammunition, reload with or without a loader, ammunition switch = reload, belts, TOW at a halt), smoke
// salvos, armour and damage (vehicles/armour.ts), burning, the wreck, and the seats and crew.
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { AMMO, type Ammo, type AmmoId } from '../game/data/weapons';
import type { MountDef, SeatDef, VehicleDef } from '../game/data/vehicles';
import { G_VEH, G_WORLD, groups } from '../world/physics';
import type { Game } from '../game/game';
import type { Soldier } from '../game/soldier';
import type { Faction } from '../game/data/kits';
import { EngineSound } from './vaudio';

type V3 = [number, number, number];
const UP = new THREE.Vector3(0, 1, 0);
let nextId = 1;

export interface Mount {
  def: MountDef;
  /** Selected ammunition (index into def.ammo), ready and stowed counts per type. */ sel: number; ready: number[]; stowed: number[];
  /** Cannon/launcher: a round is chambered (of type `loadedType`); automatic: rounds left in the belt. */
  loaded: boolean; loadedType: number; belt: number;
  /** Seconds until loaded / belt changed, and until the next shot (rate of fire). */ reloadT: number; cool: number;
  /** Remote station aim (relative to the turret): yaw, pitch. */ yaw: number; pitch: number;
  rate: number; shots: number;
}

export interface Seat { def: SeatDef; who: Soldier | null; /** Seconds in the seat (turret warm-up). */ t: number }

export class Vehicle {
  id = nextId++;
  root: THREE.Object3D;
  body: RAPIER.RigidBody;
  hullCol: RAPIER.Collider; turretCol: RAPIER.Collider;
  turret: THREE.Object3D; gun: THREE.Object3D;
  nodes = new Map<string, THREE.Object3D>();
  seats: Seat[]; mounts: Mount[];
  // Controls (set by the driver: player or AI) and aim (by the gunner).
  throttle = 0; steer = 0;
  /** Aim the gunner wants (world yaw, pitch): the turret and gun slew towards it. */ aimYaw = 0; aimPitch = 0;
  /** Turret yaw relative to the hull, gun elevation (rad). */ turretYaw = 0; gunPitch = 0;
  /** Fire-control superelevation for the current range and round (rad), and the lased range (m). */ fcs = 0; range = 0;
  // State.
  integrity = 100; burning = false; dead = false; tracked = false; engineOut = false; turretJam = false;
  /** Smoke salvos left; seconds since the last one. */ smoke: number; smokeT = 99;
  /** Seconds the hull has been stopped (TOW launcher erection). */ stillT = 0;
  speed = 0; /** Forward speed (m/s, signed). */ vf = 0; yawRate = 0;
  onRoad = false; grounded = false;
  deadT = 0;
  private repairT = 0; private lastHp = 100;
  /** The AI crew's brain (driver / gunner / commander), when it has one (vehicles/vai.ts). */
  ai: import('./vai').VehicleAI | null = null;
  private trackOff = [0, 0];
  private trackTex: THREE.Texture[] = [];
  private wheels: { o: THREE.Object3D; side: number; r: number }[] = [];
  private sound: EngineSound | null = null;
  private q = new THREE.Quaternion(); private v = new THREE.Vector3(); private m4 = new THREE.Matrix4();
  /** Hit zone geometry (local, from the model): turret ring centre, height. */ ring = new THREE.Vector3();

  constructor(public g: Game, public def: VehicleDef, model: THREE.Object3D, pos: V3, yaw: number, public team: Faction) {
    this.root = model.clone(true);
    this.root.traverse((o) => {
      if (o.name) this.nodes.set(o.name, o);
      const m = o as THREE.Mesh;
      if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; }
    });
    this.turret = this.nodes.get('turret')!; this.gun = this.nodes.get('gun')!;
    this.ring.copy(this.turret.position);
    // Tracks: own material and texture per side, so the links scroll with each track's speed.
    for (const side of ['track_l', 'track_r']) {
      const t = this.nodes.get(side) as THREE.Mesh | undefined; if (!t) continue;
      const mat = (t.material as THREE.MeshStandardMaterial).clone();
      if (mat.map) { mat.map = mat.map.clone(); mat.map.wrapS = mat.map.wrapT = THREE.RepeatWrapping; mat.map.needsUpdate = true; this.trackTex.push(mat.map); }
      if (mat.normalMap) { mat.normalMap = mat.normalMap.clone(); mat.normalMap.wrapS = mat.normalMap.wrapT = THREE.RepeatWrapping; mat.normalMap.needsUpdate = true; this.trackTex.push(mat.normalMap); }
      t.material = mat;
    }
    for (const [n, o] of this.nodes) if (/^rw_[lr]_\d+$/.test(n)) this.wheels.push({ o, side: n[3] === 'l' ? 0 : 1, r: 0.33 });
    g.gfx.scene.add(this.root);
    // Physics: hull box from the ground clearance up, turret box on the ring (moved with the turret each frame).
    const R = RAPIER, w = g.P.world, [hw, hh, hl] = def.hull, [tw, th, tl] = def.turret;
    this.body = w.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(pos[0], pos[1] + 0.1, pos[2]).setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
      .setCanSleep(false).setLinearDamping(0.05).setAngularDamping(0.6).setCcdEnabled(true));
    const vHull = hw * hh * hl, vTur = tw * th * tl;
    const gr = groups(G_VEH, 0xffff);
    this.hullCol = w.createCollider(R.ColliderDesc.cuboid(hw / 2, hh / 2, hl / 2).setTranslation(0, 0.45 + hh / 2, 0).setDensity((def.mass * 0.82) / vHull).setFriction(0.6).setCollisionGroups(gr), this.body);
    this.turretCol = w.createCollider(R.ColliderDesc.cuboid(tw / 2, th / 2, tl / 2).setTranslation(this.ring.x, this.ring.y + th / 2, this.ring.z + 0.4).setDensity((def.mass * 0.18) / vTur).setFriction(0.6).setCollisionGroups(gr), this.body);
    for (const c of [this.hullCol, this.turretCol]) { g.P.surf.set(c.handle, 'metal'); g.vehicleOf.set(c.handle, this); }
    this.seats = def.seats.map((d) => ({ def: d, who: null, t: 0 }));
    this.mounts = def.mounts.map((d) => ({ def: d, sel: 0, ready: [...d.ready], stowed: [...d.stowed], loaded: d.rpm === 0 && d.ready[0] > 0, loadedType: 0, belt: d.belt ? Math.min(d.belt, d.ready[0]) : 0, reloadT: 0, cool: 0, yaw: 0, pitch: 0, rate: d.rpm, shots: 0 }));
    // A round chambered / a belt on the gun, taken from the ready racks.
    for (const m of this.mounts) { if (m.def.rpm === 0 && m.loaded) m.ready[0]--; else m.ready[0] -= m.belt; }
    this.smoke = def.smoke;
    this.aimYaw = yaw;
    try { this.sound = new EngineSound(g.audio.ctx, g.audio.sfx, def.engine); } catch { this.sound = null; }
    this.sync(0);
  }

  // ---------------- frames ----------------
  /** Hull yaw (world, rad) from the body's rotation. */
  yaw(): number { const r = this.body.rotation(); this.q.set(r.x, r.y, r.z, r.w); const f = this.v.set(0, 0, -1).applyQuaternion(this.q); return Math.atan2(-f.x, -f.z); }
  pos(): V3 { const t = this.body.translation(); return [t.x, t.y, t.z]; }
  /** World position of a model node (after sync). */
  nodePos(name: string): V3 { const o = this.nodes.get(name); if (!o) return this.pos(); o.getWorldPosition(this.v); return [this.v.x, this.v.y, this.v.z]; }
  /** World direction of a node's forward (−Z). */
  nodeDir(name: string): V3 { const o = this.nodes.get(name)!; o.getWorldQuaternion(this.q); this.v.set(0, 0, -1).applyQuaternion(this.q); return [this.v.x, this.v.y, this.v.z]; }
  /** The gun's line (world): origin at the muzzle and direction, including the fire-control superelevation. */
  gunDir(): V3 { return this.nodeDir('gun'); }
  /** The sight line (world): the gun direction without the superelevation the FCS adds (what the gunner sees). */
  sightDir(): V3 {
    const yaw = this.yaw() + this.turretYaw, p = this.gunPitch - this.fcs + this.hullPitch();
    return [-Math.sin(yaw) * Math.cos(p), Math.sin(p), -Math.cos(yaw) * Math.cos(p)];
  }
  hullPitch(): number { const r = this.body.rotation(); this.q.set(r.x, r.y, r.z, r.w); const f = this.v.set(0, 0, -1).applyQuaternion(this.q); return Math.asin(Math.max(-1, Math.min(1, f.y))); }
  /** World point → vehicle-local (hull frame). */
  toLocal(p: V3): THREE.Vector3 { this.root.updateMatrixWorld(); return this.v.set(p[0], p[1], p[2]).applyMatrix4(this.m4.copy(this.root.matrixWorld).invert()).clone(); }

  // ---------------- crew ----------------
  seatOf(s: Soldier): number { return this.seats.findIndex((x) => x.who === s); }
  driver(): Soldier | null { return this.seats.find((x) => x.def.role === 'driver')?.who ?? null; }
  crewIn(role: string): Soldier | null { return this.seats.find((x) => x.def.role === role && x.who?.alive)?.who ?? null; }
  /** Put a soldier in seat i (the soldier's own body stops colliding; it rides with the vehicle). */
  enter(s: Soldier, i: number): boolean {
    const st = this.seats[i]; if (!st || (st.who && st.who !== s) || this.dead) return false;
    const cur = s.vehicle === this ? this.seatOf(s) : -1;
    if (cur >= 0) this.seats[cur].who = null;
    else if (s.vehicle) s.vehicle.exit(s, false);
    st.who = s; st.t = 0; s.vehicle = this; s.seat = i;
    s.collider.setEnabled(false); s.vel = [0, 0, 0]; s.ads = 0; s.aiming = false; s.sprinting = false; s.support = 'none';
    if (st.def.view === 'gun') { this.aimYaw = this.yaw() + this.turretYaw; this.aimPitch = this.gunPitch; }
    this.place(s, i);
    return true;
  }
  /** Get out at the nearest free exit (or anywhere free around the hull). */
  exit(s: Soldier, place = true) {
    const i = this.seatOf(s); if (i >= 0) this.seats[i].who = null;
    s.vehicle = null; s.seat = -1; s.teleported = true;
    if (s.state === 'dead') return; // his body was removed from the physics world when he died
    s.collider.setEnabled(true);
    if (!place) return;
    const exits = this.def.seats[i]?.role === 'cargo' ? ['exit_rear', 'exit_l', 'exit_r'] : ['exit_l', 'exit_r', 'exit_rear'];
    for (const n of exits) {
      if (!this.nodes.has(n)) continue;
      const p = this.nodePos(n), h = this.g.P.castRay([p[0], p[1] + 2, p[2]], [0, -1, 0], 6, G_WORLD), y = h ? h.point[1] : p[1];
      if (this.g.P.fits([p[0], y + 0.05, p[2]])) { s.pos = [p[0], y + 0.05, p[2]]; s.body.setTranslation({ x: p[0], y: y + 0.95, z: p[2] }, true); return; }
    }
    const p = this.pos(); s.pos = [p[0] + 3, p[1] + 0.1, p[2]]; s.body.setTranslation({ x: p[0] + 3, y: p[1] + 1, z: p[2] }, true);
  }
  /** Occupant's eye at the seat (soldier.pos is the feet, so eye height is subtracted). */
  private place(s: Soldier, i: number) {
    const e = this.nodePos(this.seats[i].def.node), eh = s.eye[1] - s.pos[1];
    s.pos = [e[0], e[1] - eh, e[2]];
    s.body.setTranslation({ x: e[0], y: e[1] - eh + 0.9, z: e[2] }, true);
  }

  // ---------------- per frame (before the physics step) ----------------
  update(dt: number) {
    const d = this.def, g = this.g;
    // A crewman killed in his seat stays aboard until the vehicle is cleared; a wounded one is pulled out beside it.
    for (const st of this.seats) if (st.who) { st.t += dt; if (st.who.state === 'dead') { st.who.vehicle = null; st.who.seat = -1; st.who = null; } else if (!st.who.alive) this.exit(st.who, true); }
    const drv = this.driver();
    if (this.dead) { this.throttle = this.steer = 0; this.deadT += dt; this.burn(dt); return; }
    // ---- drive ----
    const mobile = !!drv?.alive && !this.tracked && !this.engineOut;
    const thr = mobile ? this.throttle : 0, str = mobile ? this.steer : 0;
    const t = this.body.translation(), r = this.body.rotation();
    this.q.set(r.x, r.y, r.z, r.w);
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(this.q), rt = new THREE.Vector3(1, 0, 0).applyQuaternion(this.q), up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.q);
    const lv = this.body.linvel(), av = this.body.angvel();
    const vel = new THREE.Vector3(lv.x, lv.y, lv.z);
    // Suspension: 5 points per track, rays down from 0.9 m; spring rest length 0.98 m (8 cm static sag).
    const [hw, , hl] = d.hull, n = 5, m = d.mass, k = (m * 9.81) / (2 * n * 0.08), c = 2 * Math.sqrt(k * (m / (2 * n))) * 0.55;
    let contacts = 0, load = 0;
    for (const sx of [-1, 1]) for (let i = 0; i < n; i++) {
      const lz = -hl / 2 + 0.8 + (i * (hl - 1.6)) / (n - 1);
      const lp = new THREE.Vector3(sx * (hw / 2 - 0.45), 0.9, lz).applyQuaternion(this.q).add(new THREE.Vector3(t.x, t.y, t.z));
      const down = up.clone().negate();
      const h = g.P.castRay([lp.x, lp.y, lp.z], [down.x, down.y, down.z], 1.4, G_WORLD);
      if (!h) continue;
      const comp = 0.98 - h.dist; if (comp <= 0) continue;
      const rr = lp.clone().sub(new THREE.Vector3(t.x, t.y, t.z));
      const pv = vel.clone().add(new THREE.Vector3(av.x, av.y, av.z).cross(rr));
      const F = Math.max(0, k * Math.min(comp, 0.4) - c * pv.dot(up));
      this.body.applyImpulseAtPoint({ x: up.x * F * dt, y: up.y * F * dt, z: up.z * F * dt }, { x: lp.x, y: lp.y, z: lp.z }, true);
      contacts++; load += F;
    }
    this.grounded = contacts >= 3;
    this.vf = vel.dot(f); const vl = vel.dot(rt);
    this.speed = Math.hypot(lv.x, lv.z);
    this.onRoad = this.g.isRoad(t.x, t.z);
    if (this.grounded) {
      const frac = Math.min(1, load / (m * 9.81));
      // Track speed target and limits (tracks lock when the throttle is released: they are self-braking).
      const vmax = this.onRoad ? d.vmax : d.vmaxOff;
      const target = thr >= 0 ? thr * vmax * (1 - 0.25 * Math.abs(str)) : thr * d.vrev;
      const acc = Math.abs(target) > Math.abs(this.vf) && Math.sign(target) === Math.sign(this.vf || target) ? d.accel : 4.0;
      const dv = Math.max(-acc * dt, Math.min(acc * dt, target - this.vf)) * frac;
      const imp = f.clone().multiplyScalar(m * dv);
      this.body.applyImpulse({ x: imp.x, y: imp.y, z: imp.z }, true);
      // Grip: the tracks kill sideslip.
      const side = rt.clone().multiplyScalar(-m * vl * Math.min(1, 7 * dt) * frac);
      this.body.applyImpulse({ x: side.x, y: side.y, z: side.z }, true);
      // Skid steering: a yaw-rate target (slower at speed), reached through the tracks' grip.
      const wt = str * d.pivot * (1 - 0.45 * Math.min(1, Math.abs(this.vf) / d.vmax));
      const Iy = (m * (hw * hw + hl * hl)) / 12;
      const wNow = new THREE.Vector3(av.x, av.y, av.z).dot(up);
      const tq = Iy * (wt - wNow) * Math.min(1, 5 * dt) * frac;
      this.body.applyTorqueImpulse({ x: up.x * tq, y: up.y * tq, z: up.z * tq }, true);
    }
    this.yawRate = new THREE.Vector3(av.x, av.y, av.z).dot(up);
    this.stillT = this.speed < 0.3 ? this.stillT + dt : 0;
    // ---- turret and gun ----
    const gunner = this.crewIn('gunner');
    const gs = this.seats.find((x) => x.def.role === 'gunner');
    const warm = !!gs && gs.t >= d.warmup && !!drv?.alive;
    if (gunner && warm && !this.turretJam) {
      const hy = this.yaw();
      let dy = this.aimYaw - hy - this.turretYaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      const tr = d.traverse * (this.engineOut ? 0.25 : 1) * dt;
      this.turretYaw += Math.max(-tr, Math.min(tr, dy));
      this.turretYaw = Math.atan2(Math.sin(this.turretYaw), Math.cos(this.turretYaw));
      const want = Math.max(d.elev[0], Math.min(d.elev[1], this.aimPitch - this.hullPitch() * Math.cos(this.turretYaw) + this.fcs));
      const er = d.elevRate * dt;
      this.gunPitch += Math.max(-er, Math.min(er, want - this.gunPitch));
    }
    // ---- weapons ----
    const loader = this.crewIn('loader');
    for (const mt of this.mounts) {
      mt.cool = Math.max(0, mt.cool - dt);
      if (mt.reloadT > 0) {
        mt.reloadT -= dt;
        if (mt.reloadT <= 0) {
          if (mt.def.rpm === 0) { if (mt.ready[mt.sel] > 0) { mt.ready[mt.sel]--; mt.loaded = true; mt.loadedType = mt.sel; } }
          else { const take = Math.min(mt.def.belt ?? 100, mt.ready[mt.sel]); mt.belt = take; mt.ready[mt.sel] -= take; mt.loadedType = mt.sel; }
        }
      }
      // The crew restocks the ready racks from stowage between engagements (slowly).
      if (mt.ready[mt.sel] === 0 && mt.stowed[mt.sel] > 0 && mt.reloadT <= 0) { const n2 = Math.min(mt.stowed[mt.sel], mt.def.rpm ? 100 : 1); mt.stowed[mt.sel] -= n2; mt.ready[mt.sel] += n2; mt.reloadT = mt.def.reload[loader ? 0 : 1] * 2; }
    }
    this.smokeT += dt;
    // Field repair: with the crew aboard and no hits for 90 s, a thrown track is put back on and the engine coaxed
    // back to life (a turret drive too); nothing is fixed while burning.
    if ((this.tracked || this.engineOut || this.turretJam) && !this.burning && this.driver()?.alive) {
      if (this.integrity < this.lastHp) { this.lastHp = this.integrity; this.repairT = 0; }
      if ((this.repairT += dt) > 90) { this.tracked = this.engineOut = this.turretJam = false; this.repairT = 0; if (this.g.player?.s.vehicle === this) this.g.hud?.flash('REPAIRED'); }
    } else { this.repairT = 0; this.lastHp = this.integrity; }
    this.burn(dt);
    // Ride with the hull: every occupant's soldier follows his seat.
    for (let i = 0; i < this.seats.length; i++) { const w = this.seats[i].who; if (w) this.place(w, i); }
    this.runOver(dt);
    this.crushAhead(dt);
  }

  /** Driving into trees, carts, fences and garden walls knocks them down (a strip just ahead of the hull). */
  private crushT = 0;
  private crushAhead(dt: number) {
    if ((this.crushT -= dt) > 0 || Math.abs(this.vf) < 0.5 || !this.g.destruct) return;
    this.crushT = 0.12;
    const p = this.pos(), yaw = this.yaw(), s = Math.sign(this.vf), f: [number, number] = [-Math.sin(yaw) * s, -Math.cos(yaw) * s];
    // A strip from the bow to ~3 m ahead: things go down before the hull reaches them.
    const reach = this.def.hull[2] / 2 + 1.5;
    const n = this.g.destruct.crush(p[0] + f[0] * reach, p[2] + f[1] * reach, this.def.hull[0] / 2 + 0.1, 1.6, f, p[1], p[1] + 2.6);
    // Pushing trees and walls over costs momentum (a big eucalyptus takes ~1.5 m/s off a 62 t tank, more off a Bradley).
    if (n > 0) { const lv = this.body.linvel(), k = Math.max(0.35, 1 - (n * 0.5 * 62000) / this.def.mass / Math.max(3, this.speed)); this.body.setLinvel({ x: lv.x * k, y: lv.y, z: lv.z * k }, true); }
  }

  /** Burning: integrity bleeds away; at zero the vehicle is destroyed. Smoke and flames from the engine deck. */
  private burn(dt: number) {
    if (!this.burning && !this.dead) return;
    const p = this.nodePos('body'), rear = this.v.set(0, 0, 1).applyQuaternion(this.root.quaternion);
    const src: V3 = [p[0] + rear.x * this.def.hull[2] * 0.3, p[1] + 1.6, p[2] + rear.z * this.def.hull[2] * 0.3];
    if (Math.random() < dt * (this.dead ? 6 : 10)) this.g.fx.smoke.spawn(src, [(Math.random() - 0.5) * 0.8, 2 + Math.random() * 2, (Math.random() - 0.5) * 0.8], 0.9, 2.5, 7 + Math.random() * 5, 0.85, [0.08, 0.075, 0.07], 0.6, -0.12, [0.35, 0.33, 0.3]);
    if ((this.burning || this.deadT < 60) && Math.random() < dt * 14) this.g.fx.glow.spawn(src, [(Math.random() - 0.5) * 0.6, 1.5 + Math.random() * 1.5, (Math.random() - 0.5) * 0.6], 0.6, 1.4, 0.5 + Math.random() * 0.4, 1, [1, 0.6, 0.2], 1, -2, [0.8, 0.2, 0.05]);
    if (this.burning && !this.dead) { this.integrity -= dt * 1.6; if (this.integrity <= 0) this.destroy(false); }
  }

  /** Soldiers under the tracks of a moving vehicle are killed. */
  private runOver(dt: number) {
    if (this.speed < 1.2) return;
    void dt;
    const p = this.pos(), [hw, , hl] = this.def.hull, yaw = this.yaw(), cs = Math.cos(yaw), sn = Math.sin(yaw);
    for (const s of this.g.soldiers) {
      if (s.vehicle || s.state === 'dead') continue;
      const dx = s.pos[0] - p[0], dz = s.pos[2] - p[2];
      if (dx * dx + dz * dz > hl * hl) continue;
      // Into the hull frame (forward −Z).
      const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
      if (Math.abs(lx) < hw / 2 + 0.15 && Math.abs(lz) < hl / 2 + 0.2 && Math.abs(s.pos[1] - p[1]) < 1.5) {
        const by = this.driver();
        s.damage(500, 'chest', [p[0], p[1] + 0.5, p[2]], by, this.g.time, true);
        this.g.events.onDown?.(s, by, true);
      }
    }
  }

  // ---------------- after the physics step ----------------
  sync(dt: number) {
    const t = this.body.translation(), r = this.body.rotation();
    this.root.position.set(t.x, t.y, t.z); this.root.quaternion.set(r.x, r.y, r.z, r.w);
    this.turret.rotation.y = this.turretYaw; this.gun.rotation.x = this.gunPitch;
    // Turret collider follows the turret.
    const off = new THREE.Vector3(0, this.def.turret[1] / 2, 0.4).applyAxisAngle(UP, this.turretYaw).add(this.ring);
    this.turretCol.setTranslationWrtParent({ x: off.x, y: off.y, z: off.z });
    const tq = new THREE.Quaternion().setFromAxisAngle(UP, this.turretYaw);
    this.turretCol.setRotationWrtParent({ x: tq.x, y: tq.y, z: tq.z, w: tq.w });
    this.root.updateMatrixWorld(true);
    if (!dt) return;
    // Tracks: each side's speed = hull speed ± yaw rate × half track width; links and road wheels follow.
    const half = this.def.hull[0] / 2 - 0.4;
    for (let s = 0; s < 2; s++) {
      const v = this.vf + (s === 0 ? 1 : -1) * this.yawRate * half;
      this.trackOff[s] += (v * dt) / 1.2;
      for (let i = s * (this.trackTex.length / 2); i < (s + 1) * (this.trackTex.length / 2); i++) this.trackTex[i].offset.y = this.trackOff[s];
      for (const w of this.wheels) if (w.side === s) w.o.rotation.x -= (v * dt) / w.r;
    }
    const L = this.g.audio.listener.p, p = this.pos();
    const rpm = Math.min(1, 0.25 + Math.abs(this.throttle) * 0.5 + Math.abs(this.steer) * 0.2 + this.speed / this.def.vmax * 0.4);
    this.sound?.update(p, L, this.dead || this.engineOut ? 0 : rpm, Math.abs(this.throttle), Math.abs(this.vf) + Math.abs(this.yawRate) * 1.5, !!this.driver());
  }

  // ---------------- weapons ----------------
  mountsOf(i: number): Mount[] { const st = this.seats[i]; return st ? st.def.mounts.map((id) => this.mounts.find((m) => m.def.id === id)!).filter(Boolean) : []; }
  /** Select the ammunition type of a cannon (a different round means unloading and loading: PR's switch delay). */
  selectAmmo(mt: Mount, type: number) {
    if (type === mt.sel || type >= mt.def.ammo.length) return;
    mt.sel = type;
    const loader = this.crewIn('loader') || this.def.id !== 'm1a2';
    if (mt.def.rpm === 0) { if (mt.loaded) { mt.ready[mt.loadedType]++; mt.loaded = false; } mt.reloadT = mt.def.reload[loader ? 0 : 1]; }
    else { mt.ready[mt.loadedType] += mt.belt; mt.belt = 0; mt.loadedType = type; mt.reloadT = 1.5; }
  }
  /** Can this mount fire now? Returns the reason it cannot, or null. */
  blocked(mt: Mount, seat: number): string | null {
    const st = this.seats[seat];
    if (this.dead) return 'destroyed';
    if (mt.def.aim === 'gun' || mt.def.aim === 'launcher') {
      if (!this.driver()?.alive) return 'no driver';
      if (st.t < this.def.warmup) return `turret warming up ${Math.ceil(this.def.warmup - st.t)} s`;
    }
    if (mt.def.aim === 'launcher' && this.stillT < (mt.def.still ?? 0)) return 'halt to fire (launcher)';
    if (mt.reloadT > 0) return 'loading';
    if (mt.def.rpm === 0 ? !mt.loaded : mt.belt <= 0) return mt.ready[mt.sel] + mt.stowed[mt.sel] > 0 ? 'loading' : 'no ammunition';
    if (mt.cool > 0) return 'cycling';
    return null;
  }

  /** Fire a mount (the occupant of `seat` pulls the trigger). Station mounts aim along `dir` (world). */
  fire(mt: Mount, seat: number, dir?: V3): boolean {
    const shooter = this.seats[seat]?.who; if (!shooter || this.blocked(mt, seat)) return false;
    const d = mt.def, g = this.g, type = d.rpm === 0 ? mt.loadedType : mt.sel, ammoId = d.ammo[type] as AmmoId, a: Ammo = AMMO[ammoId];
    const o = this.nodePos(d.node);
    let dv: V3 = d.aim === 'station' && dir ? dir : d.aim === 'launcher' ? this.sightDir() : this.nodeDir('gun');
    if (d.aim === 'launcher') dv = [dv[0], dv[1] + 0.02, dv[2]];
    const sp = (d.spread / 1000) * (0.5 + Math.random() * 0.5), ang = Math.random() * Math.PI * 2;
    dv = jitter(dv, sp, ang);
    const tracer = !!d.tracer && mt.shots % d.tracer === 0;
    g.proj.fire(shooter, null, ammoId, [o[0] + dv[0] * 0.3, o[1] + dv[1] * 0.3, o[2] + dv[2] * 0.3], dv, tracer, d.aim === 'launcher' || a.guided ? this.guide(seat) : undefined);
    mt.shots++;
    if (d.rpm === 0) {
      mt.loaded = false;
      const loader = this.crewIn('loader') || this.def.id !== 'm1a2';
      if (mt.ready[mt.sel] + mt.stowed[mt.sel] > 0) mt.reloadT = d.reload[loader ? 0 : 1];
    } else {
      mt.belt--; mt.cool = 60 / (mt.rate || d.rpm);
      if (mt.belt <= 0 && mt.ready[mt.sel] > 0) mt.reloadT = d.reload[0];
    }
    // Effects: muzzle blast and dust (the 120 mm raises a cloud and rocks the hull), sound.
    const big = ammoId.startsWith('120');
    g.fx.muzzle(o, dv, big ? 6 : ammoId.startsWith('25') ? 2.2 : d.aim === 'launcher' ? 1.5 : 1, shooter.isPlayer && !!g.player && !g.player.third);
    if (big) {
      g.fx.explosion([o[0] + dv[0] * 1.5, o[1], o[2] + dv[2] * 1.5], 0.6, dv);
      const kick = new THREE.Vector3(-dv[0], 0, -dv[2]).multiplyScalar(this.def.mass * 0.05);
      this.body.applyImpulseAtPoint({ x: kick.x, y: 0, z: kick.z }, { x: o[0], y: o[1], z: o[2] }, true);
      if (g.player?.s.vehicle === this) g.player.shake += 0.6;
    }
    g.audio.play(d.sound, o, { range: big ? 3000 : 1500, far: d.far, nearDist: big ? 200 : 120, gain: big ? 1.3 : 1, rate: d.rate, delay: !shooter.isPlayer });
    // Weapons fire draws attention: enemies hear it.
    for (const s of g.soldiers) if (s.team !== this.team && s.alive && Math.hypot(s.pos[0] - o[0], s.pos[2] - o[2]) < (big ? 600 : 300)) s.heard = { p: o, t: g.time };
    return true;
  }

  /** SACLOS guidance: the point on the gunner's sight line a little beyond the missile (null = wire cut). */
  private guide(seat: number): ((p: V3) => V3 | null) {
    return (p: V3) => {
      if (this.dead || !this.seats[seat]?.who?.alive) return null;
      const o = this.nodePos(this.seats[seat].def.node), d = this.sightDir();
      const along = (p[0] - o[0]) * d[0] + (p[1] - o[1]) * d[1] + (p[2] - o[2]) * d[2];
      const a = Math.max(0, along) + 40;
      return [o[0] + d[0] * a, o[1] + d[1] * a, o[2] + d[2] * a];
    };
  }

  /** Laser rangefinder (gunner): range along the sight; the FCS sets the superelevation for the selected round. */
  lase(): number {
    // From the muzzle along the sight line (the laser must not range the vehicle's own gun).
    const o = this.nodePos('muzzle'), d = this.sightDir();
    const h = this.g.P.castRay([o[0] + d[0] * 0.5, o[1] + d[1] * 0.5, o[2] + d[2] * 0.5], d, 4000);
    this.range = h ? Math.round(h.dist + 0.5 + Math.hypot(...this.nodePos('muzzle').map((x, i) => x - this.nodePos(this.seats.find((s) => s.def.role === 'gunner')!.def.node)[i]))) : 0;
    const main = this.mounts[0];
    if (this.range >= 150) this.fcs = superelevation(main.def.ammo[main.def.rpm === 0 ? main.sel : main.sel] as AmmoId, this.range);
    else this.fcs = 0;
    return this.range;
  }

  /** Smoke salvo: a screen 30–40 m ahead across the turret's front. */
  popSmoke(): boolean {
    if (this.smoke <= 0 || this.smokeT < 5 || this.dead) return false;
    this.smoke--; this.smokeT = 0;
    const yaw = this.yaw() + this.turretYaw, p = this.pos();
    for (let i = -3; i <= 3; i++) {
      const a = yaw + i * 0.22, dist = 32 + Math.random() * 6;
      const q: V3 = [p[0] - Math.sin(a) * dist, p[1], p[2] - Math.cos(a) * dist];
      const h = this.g.P.castRay([q[0], q[1] + 20, q[2]], [0, -1, 0], 60, G_WORLD); if (h) q[1] = h.point[1];
      this.g.fx.smokeGrenade(q, [0.88, 0.88, 0.86]); this.g.smokes.push({ p: q, t0: this.g.time });
    }
    this.g.audio.play('grenade_throw', p, { range: 200, gain: 1, rate: 0.6 });
    return true;
  }

  // ---------------- damage ----------------
  /** Lose integrity; below 25 % the vehicle catches fire (the crew should bail out). */
  hurt(pct: number) {
    if (this.dead) return;
    this.integrity -= pct;
    if (this.integrity <= 25 && !this.burning) { this.burning = true; this.g.events.onVehicle?.(this, 'burning'); }
    if (this.integrity <= 0) this.destroy(pct >= 40);
  }
  /** Destroyed: the crew dies (catastrophic) or is badly hurt; the hull becomes a burnt-out wreck. */
  destroy(catastrophic: boolean) {
    if (this.dead) return;
    this.dead = true; this.integrity = 0; this.burning = false;
    const p = this.pos();
    this.g.fx.explosion([p[0], p[1] + 1.5, p[2]], catastrophic ? 3 : 1.6);
    this.g.audio.play('explosion_big', p, { range: 3000, far: 'explosion_far', nearDist: 150, gain: 1.2 });
    for (const st of this.seats) {
      const w = st.who; if (!w) continue;
      this.exit(w, true);
      if (catastrophic || Math.random() < 0.5) { w.damage(400, 'chest', p, null, this.g.time, true); this.g.events.onDown?.(w, null, true); }
      else { w.damage(60, 'chest', p, null, this.g.time, true); }
    }
    // Burnt-out look.
    this.root.traverse((o) => {
      const m = o as THREE.Mesh; if (!m.isMesh) return;
      const mats = (Array.isArray(m.material) ? m.material : [m.material]).map((x) => { const c = (x as THREE.MeshStandardMaterial).clone(); c.color?.multiplyScalar(0.22); c.roughness = 1; c.metalness = 0.2; return c; });
      m.material = Array.isArray(m.material) ? mats : mats[0];
    });
    if (catastrophic) { this.turretYaw += (Math.random() - 0.5) * 2; this.turret.position.y += 0.35; this.turret.rotation.z = (Math.random() - 0.5) * 0.5; this.gunPitch = this.def.elev[0]; }
    this.sound?.stop(); this.sound = null;
    this.g.events.onVehicle?.(this, 'destroyed');
  }

  dispose() {
    this.sound?.stop();
    this.g.gfx.scene.remove(this.root);
    for (const c of [this.hullCol, this.turretCol]) this.g.vehicleOf.delete(c.handle);
    this.g.P.world.removeRigidBody(this.body);
  }
}

function jitter(d: V3, a: number, ang: number): V3 {
  const up: V3 = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const r: V3 = [d[1] * up[2] - d[2] * up[1], d[2] * up[0] - d[0] * up[2], d[0] * up[1] - d[1] * up[0]];
  const rl = Math.hypot(r[0], r[1], r[2]); r[0] /= rl; r[1] /= rl; r[2] /= rl;
  const u: V3 = [r[1] * d[2] - r[2] * d[1], r[2] * d[0] - r[0] * d[2], r[0] * d[1] - r[1] * d[0]];
  const cx = Math.cos(ang) * a, cy = Math.sin(ang) * a;
  const o: V3 = [d[0] + r[0] * cx + u[0] * cy, d[1] + r[1] * cx + u[1] * cy, d[2] + r[2] * cx + u[2] * cy];
  const l = Math.hypot(o[0], o[1], o[2]); return [o[0] / l, o[1] / l, o[2] / l];
}

const seCache = new Map<string, number>();
/** Superelevation (rad) for a round to drop onto the sight line at `range` m (flat fire, drag + gravity). */
export function superelevation(ammo: AmmoId, range: number): number {
  const key = `${ammo}|${Math.round(range / 10)}`;
  const c = seCache.get(key); if (c !== undefined) return c;
  const a = AMMO[ammo];
  const drop = (th: number) => {
    let x = 0, y = 0, vx = a.v0 * Math.cos(th), vy = a.v0 * Math.sin(th);
    const dt = 0.005;
    while (x < range && vx > 1) { const sp = Math.hypot(vx, vy); vx += -a.k * sp * vx * dt; vy += (-a.k * sp * vy - 9.81) * dt; x += vx * dt; y += vy * dt; }
    return y;
  };
  let lo = 0, hi = 0.25;
  for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (drop(mid) < 0) lo = mid; else hi = mid; }
  const v = (lo + hi) / 2; seCache.set(key, v); return v;
}

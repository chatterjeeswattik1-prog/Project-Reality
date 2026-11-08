// A soldier (player or bot): body physics, stance, stamina, health/bleeding, inventory and the weapon state machine.
// Aiming follows Squad rather than PR: there is no settle time. Aimed shots leave along the sights with only the
// weapon's mechanical dispersion; what makes aiming hard is visible — the sights sway (stance, stamina, movement,
// suppression, bleeding; a bipod or a rest nearly stops it) and recoil climbs. From the hip a cone remains. No crosshair.
import type RAPIER from '@dimforge/rapier3d-compat';
import { AMMO, WEAPONS, type FireMode, type WeaponDef } from './data/weapons';
import { type Faction, type Kit } from './data/kits';
import { G_BOUND, G_CHAR, G_VEH, G_WORLD, groups, type Physics } from '../world/physics';
import { clamp, damp } from '../core/rng';

export type Stance = 'stand' | 'crouch' | 'prone';
export type LifeState = 'alive' | 'wounded' | 'dead';
export type HitPart = 'head' | 'chest' | 'stomach' | 'arm' | 'leg';
export const PART_MULT: Record<HitPart, number> = { head: 4.5, chest: 1.0, stomach: 0.9, arm: 0.5, leg: 0.6 };

export interface Slot {
  def: WeaponDef;
  /** Rounds in each spare magazine (magazine weapons) — PR keeps partly used mags. Throwables/rockets: one entry per item. */
  mags: number[];
  loaded: number;
  mode: FireMode;
  /** Under-barrel grenades: spare rounds and the one in the tube. */
  gl?: number; glLoaded?: number;
}

const STANCE_H: Record<Stance, number> = { stand: 1.62, crouch: 1.1, prone: 0.32 };
const CAP_R = 0.3;
const CAP_HH: Record<Stance, number> = { stand: 0.6, crouch: 0.28, prone: 0.0 };
/** Sideways head travel of a full lean (m). */
export const LEAN_M = 0.36;
export const SPEED = { walk: 3.2, sprint: 5.6, crouch: 1.6, prone: 0.7, adsMul: 0.55 };

export interface Capsule { a: [number, number, number]; b: [number, number, number]; r: number; part: HitPart }

let nextId = 1;
export class Soldier {
  id = nextId++;
  name: string;
  team: Faction;
  kit: Kit;
  squad = 0;
  isPlayer = false;
  /** Multiplayer: moved and posed by the host's snapshots (another player or a bot, seen on a client). */ netRemote = false;
  /** Multiplayer: this client's own soldier — moves here, but his health and life are the host's (no local bleeding). */ netSlave = false;
  /** Multiplayer (host): stand-in for a remote player (moved by his updates; health simulated here). */ netProxy = false;
  /** Multiplayer (client): not drawn (riding inside a vehicle on the host). */ netHidden = false;
  /** Riding in a vehicle (seat index): the vehicle carries him; his own collider is off and he has no hit capsules. */
  vehicle: import('../vehicles/vehicle').Vehicle | null = null; seat = -1;
  /** Moved without walking (out of a vehicle): his bot must find its place on the navmesh again. */
  teleported = false;
  // body
  pos: [number, number, number];
  vel: [number, number, number] = [0, 0, 0];
  yaw = 0; pitch = 0;
  /** M203 quadrant sight range setting (m). */
  glRange = 150;
  stance: Stance = 'stand';
  /** Smoothed eye height (m above the feet). */ eyeH = STANCE_H.stand;
  onGround = true;
  moving = 0; sprinting = false;
  stamina = 100;
  // health
  health = 100; bleed = 0; state: LifeState = 'alive';
  downT = 0; deadT = 0;
  lastHitT = -99; lastHitFrom: [number, number, number] | null = null;
  killedBy: Soldier | null = null;
  // weapons
  slots: Slot[] = [];
  cur = 0; prevSlot = 0;
  ads = 0; aiming = false;
  /** Random shot cone half-angle (mrad): mechanical dispersion when aimed, the hip-fire cone otherwise. */
  dev = 30;
  /** Current visible sway of the sights (yaw, pitch) in radians — shots follow it. */
  wob: [number, number] = [0, 0]; private wobT = Math.random() * 100; private swayA = 0.002;
  /** Recoil offset of the aim (rad, pitch up / yaw), recovers between shots; part of each kick stays in `pitch`. */
  rcP = 0; rcY = 0;
  /** Extra sway after a stance change, a hit or running out of breath (0..1, decays). */
  swayBoost = 0;
  /** Breath held (steadies the sights for a few seconds) and the breath left (0..1). */
  holdBreath = false; breath = 1;
  /** Weapon support: deployed bipod (prone or on a ledge) or resting on a surface. */
  support: 'none' | 'rest' | 'bipod' = 'none'; bipodYaw = 0; bipodPitch = 0; deployT = 0;
  cool = 0; reloadT = 0; reloadDur = 0; /** The reload started on an empty weapon (adds charging). */ reloadEmpty = false; switchT = 0; burst = 0; triggerWas = false;
  bandages!: number;
  bandageT = 0;
  /** Under-barrel launcher selected (M203). */ underSel = false;
  suppress = 0;
  // physics
  body: RAPIER.RigidBody; collider: RAPIER.Collider;
  /** Time (s) since the last shot, movement, etc. — for AI and audio. */ lastShotT = -99;
  /** Weapon light on (US long guns). */ light = false;
  kills = 0; deaths = 0; score = 0;
  /** Bookkeeping for the game mode (ticket and intel counted once). */
  deathCounted = false; intelGiven = false; pooled = false;
  shots = 0;
  /** Last gunfire this soldier heard (for the AI). */
  heard: { p: [number, number, number]; t: number } | null = null;

  constructor(public P: Physics, kit: Kit, team: Faction, pos: [number, number, number], name: string) {
    this.kit = kit; this.team = team; this.name = name; this.pos = [...pos];
    this.rearm();
    const R = P.R;
    this.body = P.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(pos[0], pos[1] + CAP_R + CAP_HH.stand, pos[2]));
    this.collider = P.world.createCollider(R.ColliderDesc.capsule(CAP_HH.stand, CAP_R).setCollisionGroups(groups(G_CHAR, G_WORLD | G_VEH | G_CHAR | G_BOUND)), this.body);
  }

  /** Sandbox: no damage at all. */
  god = false;

  /** The kit's full load of weapons, magazines, grenades and dressings (spawn, and the sandbox's refill). */
  rearm() {
    const kit = this.kit, keep = this.slots[this.cur]?.def.id;
    this.slots = [];
    this.bandages = kit.bandages;
    for (const it of kit.items) {
      const def = WEAPONS[it.weapon];
      const single = def.kind === 'grenade' || def.kind === 'charge' || def.kind === 'launcher' || def.kind === 'gl';
      if (def.kind === 'gl') {
        // Under-barrel rounds ride on the rifle slot.
        const host = this.slots.find((s) => s.def.under === def.id);
        if (host) { host.gl = it.count - 1; host.glLoaded = 1; continue; }
      }
      this.slots.push({ def, mags: single ? Array(Math.max(0, it.count - 1)).fill(1) : Array(it.count).fill(def.mag), loaded: single ? (it.count > 0 ? 1 : 0) : def.mag, mode: def.modes[def.modes.length - 1] === 'auto' && def.kind !== 'rifle' ? 'auto' : def.modes[0] });
    }
    if (keep) { const i = this.slots.findIndex((s) => s.def.id === keep); if (i >= 0) this.cur = i; }
  }

  get slot(): Slot { return this.slots[this.cur]; }
  get weapon(): WeaponDef { return this.slot.def; }
  get alive() { return this.state === 'alive'; }
  /** Lean round corners: wanted (−1 left … +1 right, from the input) and current; how far the head can go (m). */
  leanWant = 0; lean = 0; private leanRoom = LEAN_M;
  /** Sideways head offset of the lean (m, + = right). */
  get leanX() { return this.lean * Math.min(LEAN_M, this.leanRoom); }
  get eye(): [number, number, number] {
    const lx = this.leanX;
    return [this.pos[0] + Math.cos(this.yaw) * lx, this.pos[1] + this.eyeH - Math.abs(this.lean) * 0.07, this.pos[2] - Math.sin(this.yaw) * lx];
  }
  /** A point inside the body (no lean) at about chest height: a sight line or shot that starts at the eye or muzzle is only
   *  valid when nothing solid lies between this point and it (a head or muzzle pushed into or through a wall). */
  get core(): [number, number, number] { return [this.pos[0], this.pos[1] + Math.max(0.2, this.eyeH * 0.8), this.pos[2]]; }
  /** Aim direction (unit) from yaw/pitch: yaw 0 looks −z (north). */
  aimDir(yaw = this.yaw, pitch = this.pitch): [number, number, number] {
    const c = Math.cos(pitch); return [-Math.sin(yaw) * c, Math.sin(pitch), -Math.cos(yaw) * c];
  }
  totalMags(s = this.slot) { return s.mags.filter((m) => m > 0).length; }

  // ---------------- movement ----------------
  setStance(s: Stance, now: number) {
    if (s === this.stance || !this.alive) return;
    // Standing up needs head room.
    if (s !== 'prone' && this.stance !== 'stand') {
      const need = s === 'stand' ? 1.8 : 1.2;
      if (!this.P.clear([this.pos[0], this.pos[1] + 0.5, this.pos[2]], [this.pos[0], this.pos[1] + need, this.pos[2]])) return;
    }
    this.stance = s;
    this.collider.setHalfHeight(CAP_HH[s]);
    // Changing stance makes the sights wander briefly and folds the bipod.
    this.swayBoost = Math.max(this.swayBoost, s === 'prone' ? 0.6 : 0.3);
    this.support = 'none';
    void now;
  }

  /** Move with a desired horizontal velocity (m/s, world) and an optional jump. */
  move(dt: number, want: [number, number], jump: boolean) {
    // Dead: the body's collider is gone (die()); nothing moves any more. Mounted: the vehicle places him.
    if (this.state === 'dead' || this.vehicle) { this.vel = [0, 0, 0]; return; }
    const P = this.P;
    if (!this.alive) { want = [0, 0]; jump = false; }
    const accel = this.onGround ? 14 : 2;
    this.vel[0] += (want[0] - this.vel[0]) * damp(accel, dt);
    this.vel[2] += (want[1] - this.vel[2]) * damp(accel, dt);
    if (this.onGround && jump && this.stance === 'stand' && this.stamina > 15) { this.vel[1] = 3.8; this.stamina -= 15; this.swayBoost = 1; }
    this.vel[1] -= 9.81 * dt;
    const hh = CAP_HH[this.stance], cy = this.pos[1] + CAP_R + hh;
    const t = this.body.translation();
    // Keep the body where the feet say (stance changes move the centre).
    if (Math.abs(t.y - cy) > 1e-3) this.body.setTranslation({ x: this.pos[0], y: cy, z: this.pos[2] }, true);
    P.kcc.computeColliderMovement(this.collider, { x: this.vel[0] * dt, y: this.vel[1] * dt, z: this.vel[2] * dt }, undefined, groups(0xffff, G_WORLD | G_VEH | G_CHAR | G_BOUND));
    const m = P.kcc.computedMovement();
    const grounded = P.kcc.computedGrounded();
    const nx = this.pos[0] + m.x, ny = this.pos[1] + m.y, nz = this.pos[2] + m.z;
    if (grounded) { if (this.vel[1] < -12 && !this.onGround) this.fallDamage(-this.vel[1]); this.vel[1] = Math.max(this.vel[1], -0.5); }
    this.onGround = grounded;
    // Real displacement drives velocity when blocked.
    if (dt > 0) { this.vel[0] = m.x / dt * 0.5 + this.vel[0] * 0.5; this.vel[2] = m.z / dt * 0.5 + this.vel[2] * 0.5; }
    this.pos = [nx, ny, nz];
    this.body.setNextKinematicTranslation({ x: nx, y: ny + CAP_R + hh, z: nz });
    this.moving = Math.hypot(m.x, m.z) / Math.max(dt, 1e-4);
    this.eyeH += (STANCE_H[this.stance] - this.eyeH) * damp(this.stance === 'prone' ? 4 : 8, dt);
  }

  /**
   * Cheap movement for distant bots (no collision sweep): follow the navmesh path, height supplied by the caller
   * (interpolated along the path's corner points, which lie on walkable surfaces).
   */
  moveOnPath(dt: number, want: [number, number], groundY: number | null) {
    if (this.state === 'dead' || this.vehicle) { this.vel = [0, 0, 0]; return; }
    if (!this.alive) want = [0, 0];
    this.vel[0] += (want[0] - this.vel[0]) * damp(14, dt); this.vel[2] += (want[1] - this.vel[2]) * damp(14, dt); this.vel[1] = 0;
    const nx = this.pos[0] + this.vel[0] * dt, nz = this.pos[2] + this.vel[2] * dt, ny = groundY ?? this.pos[1];
    this.pos = [nx, ny, nz]; this.onGround = true;
    this.body.setNextKinematicTranslation({ x: nx, y: ny + CAP_R + CAP_HH[this.stance], z: nz });
    this.moving = Math.hypot(this.vel[0], this.vel[2]);
    this.eyeH += (STANCE_H[this.stance] - this.eyeH) * damp(this.stance === 'prone' ? 4 : 8, dt);
  }

  /**
   * Bot movement on the navmesh: the step is clamped to walkable ground (walls block it, it slides along them), so a bot
   * can never pass through geometry even when its path or goal is bad. Returns the new polygon ref.
   */
  moveNav(dt: number, want: [number, number], nav: { step: (ref: number, a: [number, number, number], b: [number, number, number]) => { p: [number, number, number]; ref: number } | null; ref: (p: [number, number, number]) => number }, ref: number): number {
    if (this.state === 'dead' || this.vehicle) { this.vel = [0, 0, 0]; return ref; }
    if (!this.alive) want = [0, 0];
    this.vel[0] += (want[0] - this.vel[0]) * damp(14, dt); this.vel[2] += (want[1] - this.vel[2]) * damp(14, dt); this.vel[1] = 0;
    if (!ref) ref = nav.ref(this.pos);
    const to: [number, number, number] = [this.pos[0] + this.vel[0] * dt, this.pos[1], this.pos[2] + this.vel[2] * dt];
    let r = ref ? nav.step(ref, this.pos, to) : null;
    // A failed or stalled move usually means a stale polygon (stairs, overlapping floors): look it up again and retry.
    const asked = Math.hypot(to[0] - this.pos[0], to[2] - this.pos[2]);
    if (asked > 1e-3 && (!r || Math.hypot(r.p[0] - this.pos[0], r.p[2] - this.pos[2]) < asked * 0.2)) {
      const fresh = nav.ref(this.pos);
      if (fresh && fresh !== ref) { const r2 = nav.step(fresh, this.pos, to); if (r2) { r = r2; ref = fresh; } }
    }
    const np: [number, number, number] = r ? r.p : [...this.pos];
    // Blocked: keep only the velocity that actually happened.
    if (dt > 0) { this.vel[0] = (np[0] - this.pos[0]) / dt; this.vel[2] = (np[2] - this.pos[2]) / dt; }
    this.moving = Math.hypot(np[0] - this.pos[0], np[2] - this.pos[2]) / Math.max(dt, 1e-4);
    this.pos = np; this.onGround = true;
    this.body.setNextKinematicTranslation({ x: np[0], y: np[1] + CAP_R + CAP_HH[this.stance], z: np[2] });
    this.eyeH += (STANCE_H[this.stance] - this.eyeH) * damp(this.stance === 'prone' ? 4 : 8, dt);
    return r ? r.ref : ref;
  }

  private fallDamage(v: number) { this.damage(Math.max(0, (v - 12) * 9), 'leg', null, null); }

  /** Speed this soldier may move at now. */
  maxSpeed(): number {
    if (this.stance === 'prone') return SPEED.prone;
    if (this.stance === 'crouch') return SPEED.crouch * (this.ads > 0.5 ? 0.8 : 1);
    const heavy = this.weapon.mass > 7 ? 0.9 : 1;
    if (this.sprinting) return SPEED.sprint * heavy;
    return SPEED.walk * heavy * (this.ads > 0.5 ? SPEED.adsMul : 1);
  }

  // ---------------- health ----------------
  /** Apply damage; returns true if it took the soldier down (wounded or dead). */
  damage(dmg: number, part: HitPart, from: [number, number, number] | null, by: Soldier | null, now = 0, explosive = false): boolean {
    if (this.state === 'dead' || this.god) return false;
    const d = dmg * PART_MULT[part];
    this.lastHitT = now; this.lastHitFrom = from;
    if (this.state === 'wounded') { if (d > 30 || part === 'head') this.die(by); return false; }
    this.health -= d;
    this.bleed = Math.min(8, this.bleed + d * (explosive ? 0.03 : 0.045));
    this.swayBoost = 1; this.support = 'none';
    if (part === 'head' && dmg > 25) { this.health = 0; this.die(by); return true; }
    if (this.health <= 0) {
      if (this.health < -60) { this.die(by); return true; }
      this.state = 'wounded'; this.downT = 0; this.killedBy = by; this.health = 0; this.bleed = 0;
      this.setStance('prone', now); this.aiming = false;
      return true;
    }
    return false;
  }
  die(by: Soldier | null) {
    if (this.state === 'dead') return;
    this.state = 'dead'; this.deadT = 0; this.killedBy = by ?? this.killedBy; this.deaths++;
    this.P.world.removeCollider(this.collider, false); this.P.world.removeRigidBody(this.body);
  }
  revive() { if (this.state !== 'wounded') return; this.state = 'alive'; this.health = 30; this.bleed = 0; this.setStance('prone', 0); }

  // ---------------- weapons ----------------
  select(i: number) {
    if (i < 0 || i >= this.slots.length || i === this.cur || !this.alive) return;
    this.prevSlot = this.cur; this.cur = i; this.switchT = 0.6 + this.weapon.mass * 0.05; this.reloadT = 0; this.ads = 0; this.underSel = false;
  }
  canFire() { return this.alive && this.switchT <= 0 && this.reloadT <= 0 && this.bandageT <= 0 && this.cool <= 0 && !this.sprinting && !(this.support === 'bipod' && this.deployT < 1); }
  startReload() {
    const s = this.slot, d = s.def;
    if (this.reloadT > 0 || !this.alive || d.disposable) return false;
    if (d.kind === 'grenade' || d.kind === 'charge') return false;
    if (this.underSel) {
      if ((s.glLoaded ?? 0) > 0 || !s.gl) return false;
      this.reloadDur = this.reloadT = WEAPONS.m203.reload[0]; this.reloadEmpty = false;
      return true;
    }
    // Pick the fullest spare mag (PR cycles them).
    const best = s.mags.reduce((bi, m, i) => (m > (s.mags[bi] ?? -1) ? i : bi), -1);
    if (best < 0 || s.mags[best] <= 0 || (s.loaded >= d.mag && !d.belt)) return false;
    this.reloadDur = this.reloadT = s.loaded > 0 ? d.reload[0] : d.reload[1];
    this.reloadEmpty = s.loaded === 0;
    this.ads = 0;
    return true;
  }
  finishReload() {
    const s = this.slot;
    if (this.underSel) { if (s.gl) { s.gl--; s.glLoaded = 1; } return; }
    const best = s.mags.reduce((bi, m, i) => (m > (s.mags[bi] ?? -1) ? i : bi), -1);
    if (best < 0) return;
    const fresh = s.mags[best];
    s.mags.splice(best, 1);
    if (s.loaded > 0 && !s.def.belt) s.mags.push(s.loaded);
    if (s.def.kind === 'launcher' || s.def.kind === 'gl') s.loaded = 1; else s.loaded = fresh;
  }

  /** Shot interval for the current weapon. */
  interval() { return 60 / this.weapon.rpm; }

  /** Shot cone (mrad) for the current state: the weapon's mechanical dispersion when aimed, the hip cone otherwise. */
  devTarget(): number {
    const d = this.underSel ? WEAPONS.m203.dev : this.weapon.dev;
    const si = this.stance === 'stand' ? 0 : this.stance === 'crouch' ? 1 : 2;
    if (this.ads > 0.9) return d.acc;
    let base = d.hip[si] * (1 - this.ads * 0.6);
    if (this.moving > 0.3) base += this.sprinting ? 60 : 16 * Math.min(1, this.moving / SPEED.walk);
    if (!this.onGround) base += 60;
    return base;
  }

  /** Sway amplitude of the sights (rad) — stance, weapon weight, movement, stamina, suppression, wounds, support. */
  swayTarget(): number {
    let a = this.stance === 'stand' ? 2.4 : this.stance === 'crouch' ? 1.4 : 0.6;
    a *= 0.6 + Math.min(14, this.weapon.mass) * 0.1;
    if (this.moving > 0.3) a += (this.stance === 'prone' ? 3 : 7) * Math.min(1, this.moving / SPEED.walk);
    a *= 1 + Math.max(0, 70 - this.stamina) / 30;
    a *= 1 + this.suppress * 1.5 + this.bleed * 0.1 + this.swayBoost * 2;
    if (this.support === 'bipod' && this.deployT >= 1) a *= 0.1; else if (this.support === 'rest') a *= 0.4;
    else if (this.holdBreath && this.breath > 0) a *= 0.3;
    return a / 1000;
  }

  /** A shot's recoil: the aim jumps up and to the side; most of it recovers, a part stays (the shooter pulls down). */
  recoil(up: number, side: number) {
    this.rcP += up / 1000; this.rcY += side / 1000;
    this.pitch += (up / 1000) * 0.35;
  }

  /**
   * What the weapon could rest on here: a bipod weapon lying prone, or any long gun on a surface just below the
   * sights in front of the soldier (window sill, wall top, sandbags, car bonnet) with an open view over it.
   * Returns the kind of support and the surface height, or null.
   */
  supportSpot(): { kind: 'bipod' | 'rest'; y: number } | null {
    const d = this.weapon;
    if (!this.alive || this.underSel || this.moving > 0.3 || !(d.kind === 'rifle' || d.kind === 'lmg' || d.kind === 'gpmg' || d.kind === 'sniper')) return null;
    if (this.stance === 'prone') return d.bipod ? { kind: 'bipod', y: this.pos[1] } : null;
    const e = this.eye, fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    if (this.P.castRay(e, [fx, 0, fz], 1.0)) return null;
    for (const f of [0.35, 0.55, 0.75]) {
      const h = this.P.castRay([e[0] + fx * f, e[1] + 0.02, e[2] + fz * f], [0, -1, 0], 0.65);
      if (!h || h.normal[1] < 0.7) continue;
      const drop = e[1] - h.point[1];
      if (drop > 0.07 && drop < 0.6) return { kind: d.bipod ? 'bipod' : 'rest', y: h.point[1] };
    }
    return null;
  }
  /** Deploy (or fold) the bipod where possible. Returns the new state. */
  toggleBipod(): boolean {
    if (this.support === 'bipod') { this.support = 'none'; return false; }
    const sp = this.supportSpot();
    if (!sp || sp.kind !== 'bipod') return false;
    this.support = 'bipod'; this.deployT = 0; this.bipodYaw = this.yaw; this.bipodPitch = this.pitch;
    return true;
  }
  private restCheck = 0;

  /** Per-frame upkeep: aim, sway, recoil recovery, timers, stamina, bleeding. Returns true when a reload completes. */
  tick(dt: number, now: number): boolean {
    let reloaded = false;
    if (this.state === 'wounded') { this.downT += dt; if (this.downT > 300 && !this.netSlave) this.die(null); return false; }
    if (this.state === 'dead') { this.deadT += dt; return false; }
    // Support: a bipod folds when the soldier moves; resting is found automatically while aiming.
    if (this.support === 'bipod') { this.deployT = Math.min(1, this.deployT + dt / 0.5); if (this.moving > 0.4 || this.sprinting || this.reloadT > 0 && !this.weapon.belt) this.support = 'none'; }
    else if ((this.restCheck -= dt) <= 0) { this.restCheck = 0.25; this.support = this.ads > 0.5 && this.supportSpot() ? 'rest' : 'none'; }
    // Breath: holding it steadies the sights for ~4 s, then they shake worse while the soldier catches it.
    if (this.holdBreath && this.breath > 0 && this.ads > 0.9) { this.breath = Math.max(0, this.breath - dt / 4); if (this.breath === 0) this.swayBoost = Math.max(this.swayBoost, 0.8); }
    else this.breath = Math.min(1, this.breath + dt / 6);
    this.swayBoost = Math.max(0, this.swayBoost - dt * 0.6);
    // Lean: eases over ~0.25 s; the head stops short of walls; no leaning prone or sprinting.
    const lw = this.stance === 'prone' || this.sprinting ? 0 : this.leanWant;
    this.lean += (lw - this.lean) * damp(9, dt);
    if (Math.abs(lw) > 0.01) {
      const side = Math.sign(lw), o: [number, number, number] = [this.pos[0], this.pos[1] + this.eyeH, this.pos[2]];
      const h = this.P.castRay(o, [Math.cos(this.yaw) * side, 0, -Math.sin(this.yaw) * side], LEAN_M + 0.2);
      this.leanRoom = h ? Math.max(0, h.dist - 0.2) : LEAN_M;
    }
    // Sway: a slow figure-of-eight (breathing, ~0.3 Hz) plus a smaller, faster tremor; the amplitude eases in and out.
    this.wobT += dt;
    this.swayA += (this.swayTarget() - this.swayA) * damp(3, dt);
    const A = this.swayA, w = this.wobT, k = this.id * 1.7;
    this.wob[0] = A * (Math.sin(w * 1.9 + k) * 0.75 + Math.sin(w * 5.3 + k * 2.1) * 0.25);
    this.wob[1] = A * (Math.sin(w * 3.8 + k * 2) * 0.45 + Math.sin(w * 1.3 + k) * 0.35 + Math.sin(w * 6.1 + k * 0.7) * 0.2);
    this.dev += (this.devTarget() - this.dev) * damp(12, dt);
    // Recoil recovery (the aim drifts back towards where it was held).
    const rec = damp(this.support === 'bipod' ? 12 : 7, dt);
    this.rcP -= this.rcP * rec; this.rcY -= this.rcY * rec;
    this.cool -= dt; this.switchT -= dt;
    if (this.reloadT > 0) { this.reloadT -= dt; if (this.reloadT <= 0) { this.finishReload(); reloaded = true; } }
    if (this.bandageT > 0) { this.bandageT -= dt; if (this.bandageT <= 0) { this.bleed = 0; this.health = Math.min(100, this.health + 10); } }
    if (this.sprinting && this.moving > 1) this.stamina = Math.max(0, this.stamina - dt * 8.5);
    else this.stamina = Math.min(100, this.stamina + dt * (this.moving > 0.5 ? 5 : 9));
    if (this.stamina <= 0) this.sprinting = false;
    if (this.bleed > 0 && !this.netSlave) { this.health -= this.bleed * dt; if (this.health <= 0) { this.health = 0; this.state = 'wounded'; this.downT = 0; this.bleed = 0; this.setStance('prone', now); } }
    this.suppress = Math.max(0, this.suppress - dt * 0.35);
    return reloaded;
  }

  startBandage() { if (this.bandages > 0 && this.bleed > 0 && this.bandageT <= 0 && this.alive) { this.bandages--; this.bandageT = 3.5; this.reloadT = 0; this.ads = 0; return true; } return false; }

  /** Hit capsules in world space, from the stance (good enough for hit detection; the visible body follows the same pose). */
  hitboxes(out: Capsule[] = []): Capsule[] {
    out.length = 0;
    if (this.vehicle) return out; // inside the armour: rounds hit the vehicle (vehicles/armour.ts reaches the crew)
    const [x, y, z] = this.pos, fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw), rx = -fz, rz = fx;
    const P = (f: number, r: number, h: number): [number, number, number] => [x + fx * f + rx * r, y + h, z + fz * f + rz * r];
    if (this.stance === 'prone' || this.state !== 'alive') {
      out.push({ a: P(0.72, 0, 0.3), b: P(0.72, 0, 0.3), r: 0.13, part: 'head' });
      out.push({ a: P(0.45, 0, 0.22), b: P(0.1, 0, 0.2), r: 0.19, part: 'chest' });
      out.push({ a: P(0.1, 0, 0.2), b: P(-0.25, 0, 0.18), r: 0.18, part: 'stomach' });
      out.push({ a: P(-0.25, 0.12, 0.13), b: P(-1.0, 0.18, 0.1), r: 0.1, part: 'leg' });
      out.push({ a: P(-0.25, -0.12, 0.13), b: P(-1.0, -0.18, 0.1), r: 0.1, part: 'leg' });
      out.push({ a: P(0.5, 0.22, 0.2), b: P(0.9, 0.12, 0.25), r: 0.07, part: 'arm' });
      return out;
    }
    const k = this.stance === 'crouch' ? 0.68 : 1, hy = this.eyeH + 0.06 - Math.abs(this.lean) * 0.07, lx = this.leanX;
    // Leaning moves the head fully and the upper chest about half as far.
    out.push({ a: P(0.02, lx, hy), b: P(0.02, lx, hy), r: 0.125, part: 'head' });
    out.push({ a: P(0, lx * 0.6, 1.45 * k), b: P(0, lx * 0.15, 1.18 * k), r: 0.2, part: 'chest' });
    out.push({ a: P(0, 0, 1.18 * k), b: P(0, 0, 0.92 * k), r: 0.18, part: 'stomach' });
    if (this.stance === 'crouch') {
      out.push({ a: P(0.05, 0.13, 0.62), b: P(0.35, 0.13, 0.42), r: 0.1, part: 'leg' });
      out.push({ a: P(0.35, 0.13, 0.42), b: P(0.3, 0.13, 0.05), r: 0.09, part: 'leg' });
      out.push({ a: P(0.05, -0.13, 0.62), b: P(-0.25, -0.13, 0.12), r: 0.1, part: 'leg' });
    } else {
      out.push({ a: P(0, 0.11, 0.9), b: P(0, 0.12, 0.08), r: 0.1, part: 'leg' });
      out.push({ a: P(0, -0.11, 0.9), b: P(0, -0.12, 0.08), r: 0.1, part: 'leg' });
    }
    out.push({ a: P(0.05, 0.24, 1.42 * k), b: P(0.45, 0.12, 1.3 * k), r: 0.07, part: 'arm' });
    out.push({ a: P(0.05, -0.24, 1.42 * k), b: P(0.5, -0.05, 1.32 * k), r: 0.07, part: 'arm' });
    return out;
  }

  /** Ammo shown to the player PR-style: magazines, not rounds. */
  ammoText(): string {
    const s = this.slot, d = s.def;
    if (this.underSel) return `M203  ${s.glLoaded ?? 0} + ${s.gl ?? 0}`;
    if (d.kind === 'grenade' || d.kind === 'charge' || d.kind === 'launcher' || d.kind === 'gl') return `${s.loaded + s.mags.length}`;
    return `${this.totalMags()} mag${this.totalMags() === 1 ? '' : 's'}`;
  }
}

/**
 * M203 quadrant sight: the elevation (rad above the sight line) set for a range, i.e. the launch angle that lands a 40 mm
 * grenade at `range` m on level ground, fired from the shoulder (~1.4 m up) (M433: 76 m/s; ~400 m max effective).
 */
const glCache = new Map<number, number>();
export function glElevation(range: number): number {
  const c = glCache.get(range); if (c !== undefined) return c;
  const a = AMMO.hedp40;
  let lo = 0, hi = 0.75;
  for (let it = 0; it < 28; it++) {
    const ang = (lo + hi) / 2;
    let x = 0, y = 0, vx = a.v0 * Math.cos(ang), vy = a.v0 * Math.sin(ang), t = 0;
    const dt = 0.004;
    while ((t < 0.05 || y > -1.4) && t < 30) { const v = Math.hypot(vx, vy); vx -= a.k * v * vx * dt; vy -= (a.k * v * vy + 9.81) * dt; x += vx * dt; y += vy * dt; t += dt; }
    if (x < range) lo = ang; else hi = ang;
  }
  const e = (lo + hi) / 2; glCache.set(range, e); return e;
}
/** Quadrant sight settings (m). */
export const GL_RANGES = [50, 75, 100, 125, 150, 200, 250, 300, 350, 400];

/** Ballistic launch angle (rad) above the line of sight so a weapon hits its zero distance. */
export function zeroAngle(def: WeaponDef, sightHeight = 0.065): number {
  const a = AMMO[def.ammo];
  if (!def.zero || a.rocket) return 0;
  let lo = -0.01, hi = 0.05;
  for (let it = 0; it < 30; it++) {
    const ang = (lo + hi) / 2;
    // Integrate to the zero range.
    let x = 0, y = -sightHeight, vx = a.v0 * Math.cos(ang), vy = a.v0 * Math.sin(ang);
    const dt = 0.002;
    while (x < def.zero && vx > 1) { const v = Math.hypot(vx, vy); vx -= a.k * v * vx * dt; vy -= (a.k * v * vy + 9.81) * dt; x += vx * dt; y += vy * dt; }
    if (y > 0) hi = ang; else lo = ang;
  }
  return clamp((lo + hi) / 2, -0.01, 0.05);
}

// A soldier (player or bot): body physics, stance, stamina, health/bleeding, inventory and the weapon state machine.
// Deviation follows Project Reality: a cone that grows with movement, stance changes and firing, and settles back
// over a couple of seconds; aiming down sights only removes it once settled. There is no crosshair.
import type RAPIER from '@dimforge/rapier3d-compat';
import { AMMO, WEAPONS, type FireMode, type WeaponDef } from './data/weapons';
import { type Faction, type Kit } from './data/kits';
import { G_CHAR, G_VEH, G_WORLD, groups, type Physics } from '../world/physics';
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
  // body
  pos: [number, number, number];
  vel: [number, number, number] = [0, 0, 0];
  yaw = 0; pitch = 0;
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
  dev = 30; // mrad
  /** Current visible aim wobble (yaw, pitch) in radians, from the excess deviation. */
  wob: [number, number] = [0, 0]; private wobT = Math.random() * 100;
  cool = 0; reloadT = 0; reloadDur = 0; switchT = 0; burst = 0; triggerWas = false;
  bandages: number;
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
    const R = P.R;
    this.body = P.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(pos[0], pos[1] + CAP_R + CAP_HH.stand, pos[2]));
    this.collider = P.world.createCollider(R.ColliderDesc.capsule(CAP_HH.stand, CAP_R).setCollisionGroups(groups(G_CHAR, G_WORLD | G_VEH | G_CHAR)), this.body);
  }

  get slot(): Slot { return this.slots[this.cur]; }
  get weapon(): WeaponDef { return this.slot.def; }
  get alive() { return this.state === 'alive'; }
  get eye(): [number, number, number] { return [this.pos[0], this.pos[1] + this.eyeH, this.pos[2]]; }
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
    // Changing stance throws the aim off (PR settle penalty).
    this.dev = Math.max(this.dev, s === 'prone' ? 40 : 22);
    void now;
  }

  /** Move with a desired horizontal velocity (m/s, world) and an optional jump. */
  move(dt: number, want: [number, number], jump: boolean) {
    const P = this.P;
    if (!this.alive) { want = [0, 0]; jump = false; }
    const accel = this.onGround ? 14 : 2;
    this.vel[0] += (want[0] - this.vel[0]) * damp(accel, dt);
    this.vel[2] += (want[1] - this.vel[2]) * damp(accel, dt);
    if (this.onGround && jump && this.stance === 'stand' && this.stamina > 15) { this.vel[1] = 3.8; this.stamina -= 15; this.dev = Math.max(this.dev, 80); }
    this.vel[1] -= 9.81 * dt;
    const hh = CAP_HH[this.stance], cy = this.pos[1] + CAP_R + hh;
    const t = this.body.translation();
    // Keep the body where the feet say (stance changes move the centre).
    if (Math.abs(t.y - cy) > 1e-3) this.body.setTranslation({ x: this.pos[0], y: cy, z: this.pos[2] }, true);
    P.kcc.computeColliderMovement(this.collider, { x: this.vel[0] * dt, y: this.vel[1] * dt, z: this.vel[2] * dt }, undefined, groups(0xffff, G_WORLD | G_VEH | G_CHAR));
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
    if (this.state === 'dead') return false;
    const d = dmg * PART_MULT[part];
    this.lastHitT = now; this.lastHitFrom = from;
    if (this.state === 'wounded') { if (d > 30 || part === 'head') this.die(by); return false; }
    this.health -= d;
    this.bleed = Math.min(6, this.bleed + d * (explosive ? 0.02 : 0.03));
    this.dev = Math.max(this.dev, 60);
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
  canFire() { return this.alive && this.switchT <= 0 && this.reloadT <= 0 && this.bandageT <= 0 && this.cool <= 0 && !this.sprinting; }
  startReload() {
    const s = this.slot, d = s.def;
    if (this.reloadT > 0 || !this.alive || d.disposable) return false;
    if (d.kind === 'grenade' || d.kind === 'charge') return false;
    if (this.underSel) {
      if ((s.glLoaded ?? 0) > 0 || !s.gl) return false;
      this.reloadDur = this.reloadT = WEAPONS.m203.reload[0];
      return true;
    }
    // Pick the fullest spare mag (PR cycles them).
    const best = s.mags.reduce((bi, m, i) => (m > (s.mags[bi] ?? -1) ? i : bi), -1);
    if (best < 0 || s.mags[best] <= 0 || (s.loaded >= d.mag && !d.belt)) return false;
    this.reloadDur = this.reloadT = s.loaded > 0 ? d.reload[0] : d.reload[1];
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

  /** Deviation target (mrad) for the current state, before firing kicks. */
  /** Fully settled deviation for the current stance and sights (mrad) — the floor the cone settles to. */
  devFloor(): number {
    const d = this.underSel ? WEAPONS.m203.dev : this.weapon.dev;
    const si = this.stance === 'stand' ? 0 : this.stance === 'crouch' ? 1 : 2;
    return this.ads > 0.9 ? d.ads[si] : d.hip[si];
  }
  /** 0 = unsettled, 1 = fully settled (HUD settle indicator). */
  settled(): number { const f = this.devFloor(); return clamp(1 - (this.dev - f) / Math.max(8, f * 6), 0, 1); }

  devTarget(): number {
    const d = this.underSel ? WEAPONS.m203.dev : this.weapon.dev;
    const si = this.stance === 'stand' ? 0 : this.stance === 'crouch' ? 1 : 2;
    let base = this.ads > 0.9 ? d.ads[si] : d.hip[si] * (1 - this.ads * 0.5);
    if (this.weapon.bipod && this.stance === 'prone' && this.moving < 0.1) base *= 0.6;
    if (this.moving > 0.3) base += this.sprinting ? 90 : this.stance === 'prone' ? 30 : 26 * Math.min(1, this.moving / SPEED.walk);
    if (!this.onGround) base += 90;
    if (this.bleed > 0.5) base *= 1 + this.bleed * 0.08;
    if (this.stamina < 25) base *= 1.6;
    base *= 1 + this.suppress * 1.5;
    return base;
  }

  /** Per-frame upkeep: deviation settle, timers, stamina, bleeding. Returns true when a reload completes. */
  tick(dt: number, now: number): boolean {
    let reloaded = false;
    if (this.state === 'wounded') { this.downT += dt; if (this.downT > 300) this.die(null); return false; }
    if (this.state === 'dead') { this.deadT += dt; return false; }
    const target = this.devTarget(), settle = (this.underSel ? WEAPONS.m203.dev : this.weapon.dev).settle;
    // Visible sway: the excess deviation drives a smooth wobble of the aim (what the sights show is where it goes).
    this.wobT += dt;
    const A = Math.max(0, this.dev - this.devFloor()) / 1000 * 0.75, w = this.wobT;
    this.wob[0] = A * (Math.sin(w * 1.7 + this.id) * 0.6 + Math.sin(w * 3.9 + this.id * 2.1) * 0.4);
    this.wob[1] = A * (Math.sin(w * 2.3 + this.id * 1.3) * 0.55 + Math.sin(w * 4.7 + this.id * 0.7) * 0.45);
    this.dev += (target - this.dev) * (target < this.dev ? damp(1 / settle, dt) : damp(10, dt));
    this.cool -= dt; this.switchT -= dt;
    if (this.reloadT > 0) { this.reloadT -= dt; if (this.reloadT <= 0) { this.finishReload(); reloaded = true; } }
    if (this.bandageT > 0) { this.bandageT -= dt; if (this.bandageT <= 0) { this.bleed = 0; this.health = Math.min(100, this.health + 10); } }
    if (this.sprinting && this.moving > 1) this.stamina = Math.max(0, this.stamina - dt * 8.5);
    else this.stamina = Math.min(100, this.stamina + dt * (this.moving > 0.5 ? 5 : 9));
    if (this.stamina <= 0) this.sprinting = false;
    if (this.bleed > 0) { this.health -= this.bleed * dt; if (this.health <= 0) { this.health = 0; this.state = 'wounded'; this.downT = 0; this.bleed = 0; this.setStance('prone', now); } }
    this.suppress = Math.max(0, this.suppress - dt * 0.35);
    return reloaded;
  }

  startBandage() { if (this.bandages > 0 && this.bleed > 0 && this.bandageT <= 0 && this.alive) { this.bandages--; this.bandageT = 3.5; this.reloadT = 0; this.ads = 0; return true; } return false; }

  /** Hit capsules in world space, from the stance (good enough for hit detection; the visible body follows the same pose). */
  hitboxes(out: Capsule[] = []): Capsule[] {
    out.length = 0;
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
    const k = this.stance === 'crouch' ? 0.68 : 1, hy = this.eyeH + 0.06;
    out.push({ a: P(0.02, 0, hy), b: P(0.02, 0, hy), r: 0.125, part: 'head' });
    out.push({ a: P(0, 0, 1.45 * k), b: P(0, 0, 1.18 * k), r: 0.2, part: 'chest' });
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

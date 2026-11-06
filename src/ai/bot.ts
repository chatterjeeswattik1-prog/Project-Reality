// One AI soldier. Perception: a spotting meter per enemy that fills with distance, stance, movement and muzzle flash
// (walls and smoke block it). Combat: human reaction time, an aim error that shrinks while tracking, and the same
// deviation rules as the player — so bots stop and settle before long shots. Suppression drives them to cover.
import type { Game } from '../game/game';
import type { Soldier } from '../game/soldier';
import type { Nav } from './nav';
import { THIN, type V3 } from '../game/projectiles';
import { AMMO } from '../game/data/weapons';
import { clamp, damp } from '../core/rng';
import type { CoverPoint } from './cover';

type Tac = 'none' | 'toCover' | 'hide' | 'peek' | 'flank';

export type OrderKind = 'move' | 'defend' | 'patrol' | 'search' | 'demolish' | 'follow' | 'hold' | 'advance';
export interface Order { kind: OrderKind; pos: V3; radius?: number; leader?: Soldier; offset?: [number, number]; facing?: number; stance?: 'stand' | 'crouch' | 'prone' }

/**
 * A task from the team brain (ai/team.ts), which takes precedence over the order:
 *  slot     — formation position next to the leader: walk there, watch the given sector;
 *  hold     — a firing position (window, cover): get there and fight from it; `ambush` keeps the bot hidden (below
 *             the sill, peeking now and then) and holding fire until the cell springs the ambush;
 *  move     — a bound, a flanking leg or a fallback: get there (running), returning fire only at close range;
 *  suppress — base of fire: from `p` (or where it is) keep bursts going at `at` even without a target in sight;
 *  assault  — close with the enemy at `at`: shoot what shows, grenade what hides;
 *  search   — sweep the given spots with the weapon up.
 */
export type Task =
  | { kind: 'slot'; p: V3; face: number }
  | { kind: 'hold'; p: V3; face: number; ambush?: boolean; window?: boolean }
  | { kind: 'move'; p: V3; run: boolean }
  | { kind: 'suppress'; p: V3 | null; at: V3 }
  | { kind: 'assault'; at: V3 }
  | { kind: 'search'; spots: V3[] };
type Act = { move: V3 | null; stance: 'stand' | 'crouch' | 'prone'; aimAt: V3 | null; fire: boolean; run?: boolean };

const VIEW = 380;

/** How far up a prone soldier can aim (rad). */
const PRONE_UP = 0.45;

export class Bot {
  order: Order;
  path: V3[] = []; pathI = 0; repathT = 0; goal: V3 | null = null;
  target: Soldier | null = null;
  spot = new Map<number, number>();
  lastSeen: { p: V3; t: number } | null = null;
  thinkT = Math.random() * 0.4;
  reactT = 0;
  aimErr: [number, number] = [0, 0];
  cover: V3 | null = null; coverT = 0;
  stuckT = 0; lastProgress: V3;
  burst = 0; pauseT = 0; pressPhase = false;
  wantYaw = 0; wantPitch = 0;
  grenadeT = 10 + Math.random() * 20;
  reviveT = 0; reviving: Soldier | null = null;
  plantT = 0; planted = false;
  skill: number;
  searchSpots: V3[] = [];
  private snapT = 0; private snapped: V3 | null = null;
  // Tactical state (see combat()).
  tac: Tac = 'none'; private tacT = 0; coverPt: CoverPoint | null = null; private flankTo: V3 | null = null;
  private noSightT = 0; engagedT = 0; private bound: V3 | null = null; private boundWait = 0;
  /** Cover points this bot failed to reach (id → time until it may try again). */
  private badCover = new Map<number, number>();
  private peekT = 0;
  private navRef = 0;
  private boundT = 0;
  private throwAt: V3 | null = null; private throwSlot = -1; private throwUntil = 0;
  /** Attackers who lost contact push towards the last known position until this time. */
  private pushUntil = 0;
  /** Current task from the team brain; `taskDone` is set when a move/search task is complete. */
  task: Task | null = null; taskDone = false; private taskKey = '';
  /** Ambush sprung: hidden ambushers may now fight. */ sprung = false;
  /** Time spent firing from the current position (shoot and scoot). */ firingHere = 0;
  private peekCycle = Math.random() * 5;
  private seenHitT = -99; private searchI = 0;
  private rpgT = 5 + Math.random() * 10; private rpgOn = false; private rpgUntil = 0;

  constructor(public g: Game, public s: Soldier, public nav: Nav | null, order: Order, skill = 0.6) {
    this.order = order; this.skill = skill; this.lastProgress = [...s.pos];
  }

  setOrder(o: Order) {
    const same = this.order.kind === o.kind && Math.hypot(this.order.pos[0] - o.pos[0], this.order.pos[2] - o.pos[2]) < 4;
    this.order = o;
    if (!same) { this.goal = null; this.path = []; this.planted = false; this.plantT = 0; }
  }

  // ---------------- perception ----------------
  private think(dt: number) {
    const g = this.g, s = this.s;
    // A head leaned into (or through) a wall sees nothing beyond it: look from inside the body then.
    let e = s.eye; if (!g.P.clear(s.core, e)) e = s.core;
    const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw);
    const alert = this.target || (this.lastSeen && g.time - this.lastSeen.t < 20) || s.suppress > 0.2;
    let best: Soldier | null = null, bestScore = -Infinity;
    // Armour: only a man with an anti-tank weapon takes it on (rifle fire just rattles off the hull); the others
    // keep their heads down when a tank or IFV is close and in view.
    const hasAT = s.slots.some((x) => x.def.kind === 'launcher' && (x.loaded > 0 || x.mags.length > 0));
    const seenVeh = new Set<number>();
    for (const t of g.soldiers) {
      if (t.team === s.team || t.state !== 'alive') { this.spot.delete(t.id); continue; }
      if (t.vehicle) {
        const v = t.vehicle;
        if (seenVeh.has(v.id)) continue; seenVeh.add(v.id);
        const vp = v.pos(), c: V3 = [vp[0], vp[1] + 1.4, vp[2]], d = Math.hypot(c[0] - e[0], c[2] - e[2]);
        if (d > 900 || !g.P.clear(e, c) || g.smokeBlocks(e, c)) { this.decay(t.id, dt); continue; }
        // A 60-tonne tank is easy to see and hear: the meter fills fast out to a long way.
        const v2 = Math.min(1.5, (this.spot.get(t.id) ?? 0) + dt * 6 / (1 + (d / 400) ** 2));
        this.spot.set(t.id, v2);
        if (v2 < 1) continue;
        g.report(s.team, t);
        if (!hasAT) { if (d < 150) s.suppress = Math.min(1, s.suppress + dt * 0.4 * (1 - d / 150)); if (!this.lastSeen || g.time - this.lastSeen.t > 3) this.lastSeen = { p: [...t.pos], t: g.time }; continue; }
        const threat = 40 + (t === this.target ? 30 : 0) - d * 0.1;
        if (d < 320 && threat > bestScore) { bestScore = threat; best = t; }
        continue;
      }
      const dx = t.pos[0] - e[0], dz = t.pos[2] - e[2], d = Math.hypot(dx, dz);
      if (d > VIEW) { this.spot.delete(t.id); continue; }
      const cos = (dx * fx + dz * fz) / (d || 1);
      const fovCos = alert ? -0.2 : 0.35;
      if (cos < fovCos && d > 6) { this.decay(t.id, dt); continue; }
      const head: V3 = t.eye, chest: V3 = [t.pos[0], t.pos[1] + (t.stance === 'prone' ? 0.25 : t.stance === 'crouch' ? 0.8 : 1.25), t.pos[2]];
      const seen = (g.P.clear(e, head) || g.P.clear(e, chest)) && !g.smokeBlocks(e, chest);
      if (!seen) { this.decay(t.id, dt); continue; }
      // Seeing a man falls off with the square of range (his size on the retina): ~0.5 at 60 m, 0.14 at 150 m, 0.08 at
      // 200 m. Movement and above all muzzle flash still give him away — the fair version of what the player can see.
      let f = 1 / (1 + (d / 60) ** 2);
      f *= t.stance === 'prone' ? 0.3 : t.stance === 'crouch' ? 0.65 : 1;
      f *= t.moving > 0.5 ? 1.7 : 1;
      if (g.time - t.lastShotT < 1.5) f *= 3;
      // A weapon light swept across you is hard to miss (and in a dark room it is all you see).
      if (t.light && d < 40) { const ad = t.aimDir(), c2 = -(ad[0] * dx + ad[2] * dz) / (d || 1); if (c2 > 0.94) f *= 3; }
      f *= cos > 0.85 ? 1.4 : 0.8;
      if (alert) f *= 1.6;
      const v = Math.min(1.5, (this.spot.get(t.id) ?? 0) + dt * f * (2 + this.skill * 3));
      this.spot.set(t.id, v);
      if (v >= 1) {
        const threat = (t === this.target ? 30 : 0) - d * 0.2 + (g.time - t.lastShotT < 3 ? 15 : 0);
        if (threat > bestScore) { bestScore = threat; best = t; }
      }
    }
    if (best && best !== this.target) {
      // New target: reaction time and a fresh aim error proportional to distance and inexperience.
      this.reactT = 0.35 + (1 - this.skill) * 0.6 + Math.random() * 0.3;
      const d = Math.hypot(best.pos[0] - s.pos[0], best.pos[2] - s.pos[2]);
      const mag = (0.04 + 0.06 * (1 - this.skill)) * (0.5 + Math.min(1.5, d / 150));
      this.aimErr = [(Math.random() - 0.5) * 2 * mag, (Math.random() - 0.5) * mag];
    }
    this.target = best;
    if (best) { this.lastSeen = { p: [...best.pos], t: g.time }; g.report(s.team, best); }
    else {
      // Heard gunfire nearby, or a teammate's report: turn towards it and get ready.
      const h = s.heard;
      if (h && g.time - h.t < 4 && (!this.lastSeen || h.t > this.lastSeen.t)) this.lastSeen = { p: h.p, t: h.t };
      const k = g.knownEnemy(s.team, s.pos, 150, 12);
      if (k && (!this.lastSeen || k.t > this.lastSeen.t + 1)) this.lastSeen = { p: [...k.p], t: k.t };
    }
    // Cover that no longer protects (the enemy moved or flanked us): find another.
    if (this.coverPt && (this.tac === 'hide' || this.tac === 'toCover') && this.lastSeen && g.cover) {
      const te: V3 = best ? best.eye : [this.lastSeen.p[0], this.lastSeen.p[1] + 1.5, this.lastSeen.p[2]];
      if (!g.cover.protects(this.coverPt, te)) this.leaveCover();
    }
    if (s.team === 'us') g.mode?.spot(s);
  }
  private decay(id: number, dt: number) { const v = this.spot.get(id); if (v !== undefined) { const n = v - dt * 0.4; if (n <= 0) this.spot.delete(id); else this.spot.set(id, n); } }

  // ---------------- per frame ----------------
  update(dt: number) {
    const s = this.s, g = this.g;
    if (s.state !== 'alive' || s.vehicle) return; // mounted: the vehicle carries him (dismounts at the rear)
    // Just out of a vehicle: forget the navmesh polygon and path from before he got in (he is somewhere else now).
    if (s.teleported) { s.teleported = false; this.navRef = 0; this.path = []; this.goal = null; this.coverPt = null; this.cover = null; }
    this.thinkT -= dt;
    if (this.thinkT <= 0) { const iv = 0.25 + Math.random() * 0.15; this.think(iv); this.thinkT = iv; }
    this.reactT -= dt; this.grenadeT -= dt;
    // Self care.
    if (s.bleed > 0 && !this.target && s.bandageT <= 0 && s.bandages > 0) s.startBandage();
    if (s.slot.loaded === 0 && s.reloadT <= 0 && !s.weapon.disposable && (s.weapon.kind === 'rifle' || s.weapon.kind === 'lmg' || s.weapon.kind === 'gpmg' || s.weapon.kind === 'sniper' || s.weapon.kind === 'pistol')) g.reload(s);
    if (!this.target && s.slot.loaded < s.weapon.mag * 0.35 && s.reloadT <= 0 && s.totalMags() > 0 && s.weapon.kind !== 'launcher') g.reload(s);
    // Choose weapon: primary unless the AT kit sees a vehicle (later) — keep slot 0 for now.
    // Back to the primary unless a grenade throw is in progress (planting C4 keeps its own slot).
    if (this.throwAt && (g.time > this.throwUntil || s.cur !== this.throwSlot)) this.throwAt = null;
    if (this.throwAt && s.switchT <= 0 && s.cur === this.throwSlot) {
      const dx = this.throwAt[0] - s.pos[0], dz = this.throwAt[2] - s.pos[2], d = Math.hypot(dx, dz);
      s.yaw = Math.atan2(-dx, -dz); s.pitch = clamp(0.25 + d * 0.006, 0.2, 0.7) - 0.18;
      g.trigger(s, true, true, false);
      this.throwAt = null;
    }
    // RPG gunner: a team in the open or a man behind a wall at 30–180 m gets a rocket (the backblast needs room).
    this.rpgT -= dt;
    const rpg = s.slots.findIndex((x) => x.def.kind === 'launcher' && (x.loaded > 0 || x.mags.length > 0));
    if (rpg >= 0 && this.target && this.rpgT <= 0 && !this.rpgOn && s.reloadT <= 0) {
      const t0 = this.target, d = Math.hypot(t0.pos[0] - s.pos[0], t0.pos[2] - s.pos[2]);
      const group = g.soldiers.filter((o) => o.team === t0.team && o.alive && Math.hypot(o.pos[0] - t0.pos[0], o.pos[2] - t0.pos[2]) < 6).length;
      const back = s.aimDir(), behind = g.P.castRay(s.eye, [-back[0], 0, -back[2]], 1.8);
      // Hidden in an ambush, the RPG is what opens it (on a group in the kill zone).
      const ok = t0.vehicle ? d < 300 : this.sprung ? (group >= 2 || Math.random() < 0.3) : group >= 2 && d < 90;
      if (ok && d > 30 && d < (t0.vehicle ? 300 : 180) && !behind) { this.rpgOn = true; this.rpgUntil = g.time + (t0.vehicle ? 12 : 7); this.sprung = true; s.select(rpg); }
      else this.rpgT = 2;
    }
    if (this.rpgOn) {
      // Committed for a few seconds: a target that ducks is still shot at where it was last seen.
      const done = g.time > this.rpgUntil || s.cur !== rpg;
      if (s.weapon.kind === 'launcher' && s.slot.loaded === 0 && s.reloadT <= 0 && s.slot.mags.length && !done) g.reload(s);
      if (done || (s.weapon.kind === 'launcher' && s.slot.loaded === 0 && g.time - s.lastShotT < 1.5)) { this.rpgOn = false; this.rpgT = 20 + Math.random() * 15; }
    }
    if (s.cur !== 0 && !this.throwAt && !this.rpgOn && s.weapon.kind !== 'charge' && !this.reviving && s.switchT <= 0) s.select(0);
    let move: V3 | null = null, speed = s.maxSpeed(), stance: 'stand' | 'crouch' | 'prone' = this.order.stance ?? 'stand';
    let aimAt: V3 | null = null, wantFire = false, run = false;

    const t = this.target;
    // Hit: the bot is knocked off its aim and reacts (it does not keep running and shooting as if nothing happened);
    // out in the open it drops or dives for cover.
    if (s.lastHitT > this.seenHitT) {
      this.seenHitT = s.lastHitT;
      this.reactT = Math.max(this.reactT, 0.45 + Math.random() * 0.45); this.pauseT = Math.max(this.pauseT, 0.6);
      this.aimErr[0] += (Math.random() - 0.5) * 0.12; this.aimErr[1] += (Math.random() - 0.5) * 0.08;
      if (s.lastHitFrom) this.lastSeen = { p: [s.lastHitFrom[0], s.lastHitFrom[1] - 1.5, s.lastHitFrom[2]], t: g.time };
      if (this.tac === 'peek' && this.coverPt) { this.tac = 'hide'; this.tacT = 1.5 + Math.random(); }
      this.sprung = true;
    }
    let tasked = false;
    if (this.task && !this.throwAt) {
      const a = this.runTask(dt, t);
      if (a) { tasked = true; move = a.move; stance = a.stance; aimAt = a.aimAt; wantFire = a.fire; run = !!a.run; }
    }
    // Attackers who have not seen anybody for 7 s stop hiding and push (bounding) to the last known position.
    if (!t && this.order.kind === 'advance' && this.noSightT > 7 && this.lastSeen && g.time > this.pushUntil) { this.pushUntil = g.time + 12; this.leaveCover(); this.bound = null; }
    const pushing = !t && g.time < this.pushUntil;
    const threat = t ? t.pos : !pushing && this.lastSeen && g.time - this.lastSeen.t < 20 ? this.lastSeen.p : null;
    if (tasked) { /* the task decided */ }
    else if (threat) {
      const c = this.combat(dt, t, threat);
      move = c.move; stance = c.stance; aimAt = c.aimAt; wantFire = c.fire;
      // Grenade an enemy hiding behind cover at short range.
      const d = Math.hypot(threat[0] - s.pos[0], threat[2] - s.pos[2]);
      if (!t && this.lastSeen && d > 10 && d < 32 && this.grenadeT <= 0 && g.time - this.lastSeen.t > 2 && g.time - this.lastSeen.t < 10) this.throwGrenade(this.lastSeen.p);
    } else { this.leaveCover(); this.tac = 'none'; this.engagedT = 0; }
    // Suppressed: get lower (unless the task needs it up — a hidden ambusher is already down).
    if (s.suppress > 0.85 && this.tac !== 'toCover' && this.tac !== 'flank' && !run) stance = this.task?.kind === 'hold' && this.task.window ? 'crouch' : 'prone';

    // Orders when not fighting.
    if (!tasked && !threat && !move) move = this.order.kind === 'advance' ? this.advance(dt, pushing && this.lastSeen ? this.lastSeen.p : undefined) : this.orderGoal();
    if (pushing) this.noSightT += dt;
    // Medics revive wounded teammates nearby.
    if (s.kit.medic && !t) {
      const w = this.reviving && this.reviving.state === 'wounded' ? this.reviving : g.soldiers.find((o) => o.team === s.team && o.state === 'wounded' && Math.hypot(o.pos[0] - s.pos[0], o.pos[2] - s.pos[2]) < 70);
      this.reviving = w ?? null;
      if (w) {
        const d = Math.hypot(w.pos[0] - s.pos[0], w.pos[2] - s.pos[2]);
        if (d > 1.4) { move = w.pos; this.reviveT = 0; }
        else { move = null; stance = 'crouch'; this.reviveT += dt; if (this.reviveT > 5) { w.revive(); this.reviving = null; this.reviveT = 0; g.audio.play('bandage', w.isPlayer ? null : w.pos, { range: 15 }); } }
      }
    }
    // Engineers: plant C4 on the cache, back off, detonate.
    if (this.order.kind === 'demolish' && !t) {
      const c = this.order.pos, d = Math.hypot(c[0] - s.pos[0], c[2] - s.pos[2]);
      if (!this.planted && d < 1.8) {
        const slot = s.slots.findIndex((x) => x.def.id === 'c4' && x.loaded > 0);
        if (slot >= 0) {
          if (s.cur !== slot) s.select(slot);
          else if (s.switchT <= 0) { s.yaw = Math.atan2(-(c[0] - s.pos[0]), -(c[2] - s.pos[2])); s.pitch = -0.6; g.trigger(s, true, true, false); this.planted = true; this.plantT = 0; }
          move = null;
        }
      } else if (this.planted) {
        this.plantT += dt;
        const away: V3 = [c[0] + (s.pos[0] - c[0]) * 30 / Math.max(1, d), c[1], c[2] + (s.pos[2] - c[2]) * 30 / Math.max(1, d)];
        move = d < 24 ? away : null;
        if (d >= 22 || this.plantT > 14) { g.detonate(s); this.planted = false; s.select(0); this.order = { kind: 'defend', pos: [...s.pos] }; }
      }
    }

    // Peeking from tall cover: lean out towards the edge rather than step into the open.
    s.leanWant = 0;
    if (this.tac === 'peek' && this.coverPt && !this.coverPt.low) {
      const c = this.coverPt, rx = Math.cos(s.yaw), rz = -Math.sin(s.yaw);
      s.leanWant = Math.sign((c.peek[0] - c.p[0]) * rx + (c.peek[2] - c.p[2]) * rz);
    }
    // Stance and movement. Covering ground (more than a few metres to go, or running) is done on the feet — soldiers
    // dash between covers upright and get low when they arrive; the crouch walk is for the last steps and for creeping.
    if (move && stance === 'crouch' && (run || Math.hypot(move[0] - s.pos[0], move[2] - s.pos[2]) > 4)) stance = 'stand';
    // Lying down a rifle cannot be raised more than ~25° (PRONE_UP): a target well above (someone standing over him, an
    // upper window close by) makes him come up to a crouch to shoot.
    if (stance === 'prone' && aimAt) { const e = s.eye; if (Math.atan2(aimAt[1] - e[1], Math.hypot(aimAt[0] - e[0], aimAt[2] - e[2])) > PRONE_UP + 0.05) stance = 'crouch'; }
    if (s.stance !== stance && s.switchT <= 0) s.setStance(stance, g.time);
    let want: [number, number] = [0, 0];
    if (move) {
      const dir = this.steer(move, dt);
      if (dir) {
        const far = Math.hypot(move[0] - s.pos[0], move[2] - s.pos[2]);
        // Rush to cover / flank at a sprint when not shooting; otherwise move at the order's pace.
        const dash = run || (this.tac === 'toCover' && far > 4) || this.tac === 'flank';
        s.sprinting = s.stance === 'stand' && s.stamina > 20 && far > 2.5 && (dash || (far > 40 && !threat));
        speed = s.maxSpeed();
        want = [dir[0] * speed, dir[1] * speed];
        if (!aimAt) { this.wantYaw = Math.atan2(-dir[0], -dir[1]); this.wantPitch = 0; }
      }
    } else s.sprinting = false;
    // Bots move on the navmesh surface (walls block and slide them); without a navmesh, the character controller.
    g.doors?.openNear(s.pos, s.vel);
    if (this.nav) this.navRef = s.moveNav(dt, want, this.nav, this.navRef);
    else s.move(dt, want, false);

    // Aim: turn at a limited rate, error shrinks while tracking.
    if (aimAt) {
      const e = s.eye, dx = aimAt[0] - e[0], dy = aimAt[1] - e[1], dz = aimAt[2] - e[2];
      this.wantYaw = Math.atan2(-dx, -dz) + this.aimErr[0];
      this.wantPitch = Math.atan2(dy, Math.hypot(dx, dz)) + this.aimErr[1];
      const k = damp(0.5 + this.skill * 0.9, dt);
      this.aimErr[0] *= 1 - k; this.aimErr[1] *= 1 - k;
      if (s.suppress > 0.5) { this.aimErr[0] += (Math.random() - 0.5) * 0.01 * s.suppress; this.aimErr[1] += (Math.random() - 0.5) * 0.006 * s.suppress; }
    } else if (this.order.facing !== undefined && !move) this.wantYaw = this.order.facing;
    const turn = (3.2 + this.skill * 2.5) * dt;
    let dy = this.wantYaw - s.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    s.yaw += clamp(dy, -turn, turn);
    s.pitch += clamp(this.wantPitch - s.pitch, -turn, turn);
    if (s.stance === 'prone') s.pitch = clamp(s.pitch, -0.35, PRONE_UP);
    s.aiming = ((!!t && Math.hypot(t.pos[0] - s.pos[0], t.pos[2] - s.pos[2]) > 12) || (wantFire && !t)) && s.switchT <= 0 && !s.sprinting;
    // Machine gunners deploy the bipod where they can when they settle into a firing position.
    if (s.weapon.bipod && s.aiming && s.support !== 'bipod' && s.moving < 0.1 && Math.random() < dt * 2) s.toggleBipod();
    s.ads = clamp(s.ads + (s.aiming ? 4 : -6) * dt, 0, 1);

    // Fire control.
    if (wantFire && aimAt && Math.abs(dy) < 0.08 && Math.abs(this.wantPitch - s.pitch) < 0.12) this.fire(t, dt, aimAt);
    else { this.pressPhase = false; g.trigger(s, false, false); }
  }

  /** Fire at a soldier, or (t = null) suppressive bursts at a position. */
  private fire(t: Soldier | null, dt: number, at: V3) {
    const s = this.s, g = this.g, def = s.weapon;
    const d = Math.hypot(at[0] - s.pos[0], at[2] - s.pos[2]);
    this.pauseT -= dt;
    if (this.pauseT > 0) { g.trigger(s, false, false); return; }
    // Wait for the aim to settle enough that the cone fits the target (≈ 0.5 m), unless very close.
    const coneM = (s.dev / 1000) * d;
    const errM = Math.hypot(this.aimErr[0], this.aimErr[1]) * d;
    if (d > 15 && (coneM > 0.9 + (1 - this.skill) * 0.6 || errM > 1.4) && this.burst <= 0) { g.trigger(s, false, false); return; }
    if (def.kind === 'launcher') { if (d < 25 || d > 300) return; }
    // Never pour fire into a wall: hold fire when something this round cannot go through lies well short of the point
    // (shooting the cover an enemy just ducked behind is fine; a wall in our own face is not).
    {
      const e = s.eye, dx = at[0] - e[0], dy = at[1] - e[1], dz = at[2] - e[2], L = Math.hypot(dx, dy, dz);
      const hit = L > 0.5 ? g.P.castRay(e, [dx / L, dy / L, dz / L], L) : null;
      if (hit && hit.dist < L - 1.5 && AMMO[def.ammo].pen < (THIN[hit.surf] ?? 9)) { this.burst = 0; g.trigger(s, false, false); return; }
    }
    // A friend in the line of fire (or right beside the point aimed at): hold.
    {
      const e = s.eye, dx = at[0] - e[0], dy = at[1] - e[1], dz = at[2] - e[2], L = Math.hypot(dx, dy, dz) || 1;
      for (const o of g.soldiers) {
        if (o === s || o.team !== s.team || !o.alive || o.vehicle) continue;
        const w0 = o.pos[0] - e[0], w2 = o.pos[2] - e[2]; if (Math.abs(w0) > L + 3 || Math.abs(w2) > L + 3) continue;
        const c: [number, number, number] = [o.pos[0], o.pos[1] + 1.1, o.pos[2]], wx = c[0] - e[0], wy = c[1] - e[1], wz = c[2] - e[2];
        const a = (wx * dx + wy * dy + wz * dz) / L;
        if (a < 0.5 || a > L + 2) continue;
        if (Math.hypot(wx - dx / L * a, wy - dy / L * a, wz - dz / L * a) < (def.kind === 'launcher' ? 3 : 0.9)) { this.burst = 0; g.trigger(s, false, false); return; }
      }
    }
    const auto = s.slot.mode === 'auto';
    if (this.burst <= 0) this.burst = auto ? (d < 30 ? 6 : def.kind === 'rifle' ? 3 : 7) : d < 30 ? 3 : 1;
    if (auto) {
      g.trigger(s, true, false);
      if (s.lastShotT === g.time) this.burst--;
    } else {
      this.pressPhase = !this.pressPhase;
      const before = s.slot.loaded;
      g.trigger(s, this.pressPhase, this.pressPhase);
      if (s.slot.loaded < before) this.burst--;
    }
    if (this.burst <= 0) { this.pauseT = (auto ? 0.35 : 0.25) + Math.random() * (d > 100 ? 1.0 : 0.4); g.trigger(s, false, false); }
  }

  /**
   * Fire-and-manoeuvre: get to cover that protects from the threat, then cycle hide (reload, recover from suppression)
   * → peek (stand up over low cover or step to the edge of high cover and fire bursts) → hide. With no cover nearby,
   * fight from where you are, low. A flank order sends the bot round the side at a run.
   */
  private combat(dt: number, t: Soldier | null, threat: V3): { move: V3 | null; stance: 'stand' | 'crouch' | 'prone'; aimAt: V3; fire: boolean } {
    const s = this.s, g = this.g, C = g.cover;
    this.tacT -= dt; this.engagedT += dt;
    const d = Math.hypot(threat[0] - s.pos[0], threat[2] - s.pos[2]);
    const tEye: V3 = t ? t.eye : [threat[0], threat[1] + 1.5, threat[2]];
    const chest: V3 = t ? [t.pos[0], t.pos[1] + (t.stance === 'prone' ? 0.25 : t.stance === 'crouch' ? 0.85 : 1.3), t.pos[2]] : [threat[0], threat[1] + 1.1, threat[2]];
    // Lead a moving target and hold over for drop at long range.
    const tof = d / 700;
    const aimAt: V3 = t ? [chest[0] + t.vel[0] * tof, chest[1] + t.vel[1] * tof + (d > 300 ? (d - 300) * 0.004 : 0), chest[2] + t.vel[2] * tof] : chest;
    this.noSightT = t ? 0 : this.noSightT + dt;
    const canShoot = !!t && this.reactT <= 0;
    const low = (dd: number): 'crouch' | 'prone' => (dd > 70 && (s.weapon.kind === 'gpmg' || s.weapon.kind === 'sniper')) || s.suppress > 0.7 ? 'prone' : 'crouch';
    if (this.tac === 'flank') {
      if (!this.flankTo || Math.hypot(this.flankTo[0] - s.pos[0], this.flankTo[2] - s.pos[2]) < 1.5 || this.tacT <= 0) { this.tac = 'none'; this.flankTo = null; }
      else return { move: this.flankTo, stance: 'stand', aimAt, fire: canShoot && d < 25 };
    }
    if (this.tac === 'none') {
      const c = C ? this.pickCover(tEye, threat) : null;
      if (c) { this.claim(c); this.tac = Math.hypot(c.p[0] - s.pos[0], c.p[2] - s.pos[2]) < 0.8 ? 'hide' : 'toCover'; this.tacT = this.tac === 'hide' ? 0.8 + Math.random() : 0; }
      else { this.tac = 'peek'; this.tacT = 2 + Math.random() * 2; }
    }
    const cp = this.coverPt;
    switch (this.tac) {
      case 'toCover':
        if (!cp) { this.tac = 'none'; break; }
        // Could not get there (wall in the way, no path): forget this spot for a while.
        if (this.tacT < -6) { this.badCover.set(cp.id, g.time + 25); this.leaveCover(); this.tac = 'none'; break; }
        if (Math.hypot(cp.p[0] - s.pos[0], cp.p[2] - s.pos[2]) < 0.8) { this.tac = 'hide'; this.tacT = 0.6 + Math.random() * 0.8; }
        // Return fire on the way only at close range.
        return { move: cp.p, stance: 'stand', aimAt, fire: canShoot && d < 20 };
      case 'hide': {
        const st: 'stand' | 'crouch' | 'prone' = cp && !cp.low ? (s.suppress > 0.6 ? 'crouch' : 'stand') : s.suppress > 0.85 ? 'prone' : 'crouch';
        if (s.slot.loaded < s.weapon.mag * 0.6 && s.reloadT <= 0 && s.totalMags() > 0 && s.weapon.kind !== 'launcher') g.reload(s);
        if (this.tacT <= 0 && s.reloadT <= 0 && s.suppress < 0.6) { this.tac = 'peek'; this.tacT = 2.2 + Math.random() * 2.2; this.peekT = 0; }
        return { move: cp ? cp.p : null, stance: st, aimAt, fire: false };
      }
      case 'peek': {
        // Low cover: rise over it (crouched if it is low enough); high cover: step to its edge. No cover: stay low.
        const st: 'stand' | 'crouch' | 'prone' = cp ? (cp.low ? (cp.h < 1.1 ? 'crouch' : 'stand') : 'stand') : low(d);
        // Keep shooting while the target stays in sight (up to ~7 s in total), then duck back.
        if (t && this.tacT < 1.2 && this.peekT < 7) this.tacT = 1.2;
        this.peekT += dt;
        const done = this.tacT <= 0 || s.slot.loaded === 0 || (this.noSightT > 4 && !this.suppressing());
        if (done && cp) { this.tac = 'hide'; this.tacT = 1.2 + Math.random() * 1.6 + s.suppress * 3; }
        else if (done) { this.tac = 'none'; }
        // Fire at the last known position: a couple of seconds' worth after the enemy ducks out of sight (keeps his head
        // down, as real riflemen do), and for longer while a teammate is on the move.
        const suppress = !t && this.lastSeen !== null && g.time - this.lastSeen.t < (this.suppressing() ? 6 : 2.5);
        return { move: cp ? cp.peek : null, stance: st, aimAt, fire: canShoot || suppress };
      }
    }
    return { move: null, stance: low(d), aimAt, fire: canShoot };
  }

  /** Give the bot a task (null = back to its order and free combat). Re-issuing the same task keeps its progress. */
  setTask(t: Task | null) {
    const key = t ? `${t.kind}:${'p' in t && t.p ? t.p.map((v) => v.toFixed(0)).join(',') : ''}:${'at' in t ? t.at.map((v) => v.toFixed(0)).join(',') : ''}` : '';
    if (key === this.taskKey) { this.task = t; return; }
    this.taskKey = key; this.task = t; this.taskDone = false; this.searchI = 0; this.firingHere = 0;
    if (t && t.kind !== 'hold') this.leaveCover();
    if (t?.kind === 'hold') this.sprung = !t.ambush;
  }

  /** Eye height for a stance (for line-of-sight checks from a position). */
  private eyeAt(p: V3, st: 'stand' | 'crouch' | 'prone'): V3 { return [p[0], p[1] + (st === 'stand' ? 1.62 : st === 'crouch' ? 1.1 : 0.32), p[2]]; }
  /** Highest stance that sees `at` from p (stand if none does). */
  private stanceToSee(p: V3, at: V3): 'stand' | 'crouch' | 'prone' {
    if (this.g.P.clear(this.eyeAt(p, 'crouch'), at)) return 'crouch';
    return 'stand';
  }
  /** Chest of a soldier (aim point) with lead for its motion. */
  private aimPoint(t: Soldier): V3 {
    // A man inside a vehicle: aim at the hull's centre (sides above the running gear), leading it by the rocket's
    // (or bullet's) time of flight.
    if (t.vehicle) {
      const v = t.vehicle, p = v.pos(), lv = v.body.linvel(), d = Math.hypot(p[0] - this.s.pos[0], p[2] - this.s.pos[2]);
      const spd = this.s.weapon.kind === 'launcher' ? 160 : AMMO[this.s.weapon.ammo].v0, tof = d / spd;
      return [p[0] + lv.x * tof, p[1] + 1.25 + lv.y * tof, p[2] + lv.z * tof];
    }
    const s = this.s, d = Math.hypot(t.pos[0] - s.pos[0], t.pos[2] - s.pos[2]), tof = d / 700;
    const y = t.pos[1] + (t.stance === 'prone' || t.state !== 'alive' ? 0.25 : t.stance === 'crouch' ? 0.85 : 1.3);
    return [t.pos[0] + t.vel[0] * tof, y + (d > 300 ? (d - 300) * 0.004 : 0), t.pos[2] + t.vel[2] * tof];
  }

  /** Carry out the current task; null hands control back to the order/combat logic. */
  private runTask(dt: number, t: Soldier | null): Act | null {
    const s = this.s, g = this.g, k = this.task!;
    const dist = (p: V3) => Math.hypot(p[0] - s.pos[0], p[2] - s.pos[2]);
    const canShoot = !!t && this.reactT <= 0;
    const faceAt = (yaw: number, h = 1.4): V3 => [s.pos[0] - Math.sin(yaw) * 20, s.pos[1] + h, s.pos[2] - Math.cos(yaw) * 20];
    switch (k.kind) {
      case 'slot': {
        // In formation: fight back from where you are when something shows up (the brain then runs the drill).
        if (t) return null;
        const far = dist(k.p);
        return { move: far > 1.8 ? k.p : null, stance: far > 1.8 ? 'stand' : 'crouch', aimAt: far > 1.8 ? null : faceAt(k.face), fire: false, run: far > 14 };
      }
      case 'hold': {
        const far = dist(k.p);
        if (far > 0.7) return { move: k.p, stance: 'stand', aimAt: t && far < 25 ? this.aimPoint(t) : null, fire: canShoot && far < 20 && this.sprung, run: far > 6 };
        if (t || this.sprung) this.firingHere += dt;
        // Hidden ambusher: down below the sill, peeking (standing for ~1.2 s every ~5 s) to watch the approach.
        if (!this.sprung) {
          this.peekCycle += dt;
          const peek = this.peekCycle % 5 > 3.8;
          return { move: null, stance: peek ? 'stand' : 'crouch', aimAt: t ? this.aimPoint(t) : faceAt(k.face, 1.2), fire: false };
        }
        const at = t ? this.aimPoint(t) : this.lastSeen && g.time - this.lastSeen.t < 12 ? [this.lastSeen.p[0], this.lastSeen.p[1] + 1.2, this.lastSeen.p[2]] as V3 : faceAt(k.face);
        // At a window: stand to fire over the sill, duck to reload or when the fire gets too heavy.
        const duck = (s.reloadT > 0 || s.suppress > 0.75 || this.reactT > 0.2) && !this.rpgOn;
        const st = duck ? 'crouch' : k.window ? 'stand' : this.stanceToSee(s.pos, at);
        return { move: null, stance: st, aimAt: at, fire: (canShoot || (this.rpgOn && s.switchT <= 0 && !!this.lastSeen)) && !duck };
      }
      case 'move': {
        const far = dist(k.p);
        if (far < 1.2) { this.taskDone = true; return { move: null, stance: 'crouch', aimAt: t ? this.aimPoint(t) : null, fire: canShoot }; }
        const close = !!t && Math.hypot(t.pos[0] - s.pos[0], t.pos[2] - s.pos[2]) < 18;
        // Close contact on the way: stop and fight it out.
        if (close) return { move: null, stance: 'crouch', aimAt: this.aimPoint(t!), fire: canShoot };
        return { move: k.p, stance: 'stand', aimAt: null, fire: false, run: k.run };
      }
      case 'suppress': {
        if (k.p && dist(k.p) > 1.0) return { move: k.p, stance: 'stand', aimAt: null, fire: false, run: true };
        const at: V3 = t ? this.aimPoint(t) : [k.at[0] + Math.sin(g.time * 0.7 + s.id) * 1.5, k.at[1] + 0.9 + Math.sin(g.time * 1.3) * 0.4, k.at[2] + Math.cos(g.time * 0.9 + s.id) * 1.5];
        const duck = s.reloadT > 0 || s.suppress > 0.9;
        const st = duck ? 'crouch' : s.weapon.bipod && s.supportSpot() ? s.stance : this.stanceToSee(s.pos, at);
        return { move: null, stance: st, aimAt: at, fire: !duck && this.reactT <= 0 };
      }
      case 'assault': {
        const far = dist(k.at);
        // Grenade an enemy hidden behind cover or in a room before going in.
        if (!t && far > 6 && far < 26 && this.grenadeT <= 0) this.throwGrenade(k.at);
        if (t) {
          const d = Math.hypot(t.pos[0] - s.pos[0], t.pos[2] - s.pos[2]);
          // Shoot on the move at close range, stop to shoot further out.
          return { move: d < 12 ? k.at : null, stance: d < 12 ? 'stand' : 'crouch', aimAt: this.aimPoint(t), fire: canShoot };
        }
        if (far < 2) { this.taskDone = true; return { move: null, stance: 'crouch', aimAt: [k.at[0], k.at[1] + 1.2, k.at[2]], fire: false }; }
        return { move: k.at, stance: 'stand', aimAt: null, fire: false, run: far > 15 };
      }
      case 'search': {
        if (t) return null;
        while (this.searchI < k.spots.length && dist(k.spots[this.searchI]) < 1.5) this.searchI++;
        if (this.searchI >= k.spots.length) { this.taskDone = true; return { move: null, stance: 'crouch', aimAt: null, fire: false }; }
        const p = k.spots[this.searchI];
        // Weapon up, looking where the next spot is (rooms are cleared with the muzzle leading).
        return { move: p, stance: 'stand', aimAt: [p[0], s.pos[1] + 1.5, p[2]], fire: false };
      }
    }
  }

  /** Teammates moving under fire want covering fire. */
  private suppressing() { return this.g.movers(this.s.team) > 0; }

  private pickCover(tEye: V3, threat: V3): CoverPoint | null {
    const s = this.s, g = this.g, C = g.cover!;
    const dNow = Math.hypot(threat[0] - s.pos[0], threat[2] - s.pos[2]);
    const cands = C.near(s.pos[0], s.pos[2], 22).map((c) => {
      const dm = Math.hypot(c.p[0] - s.pos[0], c.p[2] - s.pos[2]), dt = Math.hypot(c.p[0] - threat[0], c.p[2] - threat[2]);
      return { c, dt, score: dm + Math.max(0, dt - dNow) * 0.4 + (Math.abs(c.p[1] - s.pos[1]) > 2 ? 15 : 0) };
    }).filter((x) => x.dt > 7 && !(g.claims.has(x.c.id) && g.claims.get(x.c.id) !== s.id) && !((this.badCover.get(x.c.id) ?? 0) > g.time)).sort((a, b) => a.score - b.score);
    let tries = 0;
    for (const x of cands) {
      if (++tries > 14) break;
      if (!C.protects(x.c, tEye)) continue;
      if (!C.canPeek(x.c, [threat[0], threat[1] + 1.2, threat[2]]) && tries < 10) continue;
      return x.c;
    }
    return null;
  }
  private claim(c: CoverPoint) { this.leaveCover(); this.coverPt = c; this.g.claims.set(c.id, this.s.id); }
  leaveCover() { if (this.coverPt && this.g.claims.get(this.coverPt.id) === this.s.id) this.g.claims.delete(this.coverPt.id); this.coverPt = null; if (this.tac !== 'flank') this.tac = 'none'; }

  /** Director: go round the enemy's side to `p` at a run, then re-engage. */
  flank(p: V3) { this.leaveCover(); this.tac = 'flank'; this.flankTo = p; this.tacT = 25; }

  /**
   * Bounding overwatch towards the order's objective: move cover-to-cover 10–20 m at a time, pause to watch, and only
   * set off when no more than half of the team is already moving.
   */
  private advance(dt: number, toward?: V3): V3 | null {
    const s = this.s, g = this.g, obj = toward ?? this.order.pos;
    const dObj = Math.hypot(obj[0] - s.pos[0], obj[2] - s.pos[2]);
    if (dObj < 6) return null;
    if (this.bound) {
      this.boundT += dt;
      // Could not get there in 8 s (blocked, no route): drop it and pick another.
      if (this.boundT > 8) { if (this.coverPt) this.badCover.set(this.coverPt.id, g.time + 30); this.leaveCover(); this.bound = null; this.boundT = 0; return null; }
      if (Math.hypot(this.bound[0] - s.pos[0], this.bound[2] - s.pos[2]) > 1.0) return this.bound;
      this.boundWait -= dt;
      this.wantYaw = Math.atan2(-(obj[0] - s.pos[0]), -(obj[2] - s.pos[2]));
      if (this.boundWait > 0) return null;
      this.bound = null;
    }
    const team = g.soldiers.filter((o) => o.team === s.team && o.alive && !o.isPlayer).length;
    if (g.movers(s.team) >= Math.max(1, Math.floor(team / 2))) return null;
    const options = (g.cover?.near(s.pos[0], s.pos[2], 22) ?? []).filter((c) => { const dc = Math.hypot(obj[0] - c.p[0], obj[2] - c.p[2]); return dc < dObj - 8 && dc > dObj - 22 && !g.claims.has(c.id) && !((this.badCover.get(c.id) ?? 0) > g.time); }).sort((a, b) => Math.hypot(a.p[0] - s.pos[0], a.p[2] - s.pos[2]) - Math.hypot(b.p[0] - s.pos[0], b.p[2] - s.pos[2]));
    // Only cover that can actually be walked to (one route query per candidate, at most three).
    let next: CoverPoint | undefined;
    for (const c of options.slice(0, 3)) { const r = this.nav?.path(s.pos, c.p); if (!this.nav || (r && Math.hypot(r[r.length - 1][0] - c.p[0], r[r.length - 1][2] - c.p[2]) < 1.2)) { next = c; break; } if (c) this.badCover.set(c.id, g.time + 30); }
    this.boundT = 0;
    if (next) { this.claim(next); this.bound = next.p; }
    else { const k = Math.min(1, 15 / dObj); this.bound = this.nav?.closest([s.pos[0] + (obj[0] - s.pos[0]) * k, s.pos[1], s.pos[2] + (obj[2] - s.pos[2]) * k], 4) ?? obj; }
    this.boundWait = 2 + Math.random() * 2.5;
    return this.bound;
  }

  /** Throw a frag at a point now (team brain: into a room before the entry). */
  fragInto(at: V3) { this.grenadeT = 0; this.throwGrenade(at); }

  private throwGrenade(at: V3) {
    const s = this.s, i = s.slots.findIndex((x) => x.def.kind === 'grenade' && x.def.ammo === 'frag' && x.loaded > 0);
    this.grenadeT = 25 + Math.random() * 30;
    if (i < 0) return;
    s.select(i);
    this.throwAt = [...at]; this.throwSlot = i; this.throwUntil = this.g.time + 2.5;
  }

  /** Where the current order wants this bot to be (null = stay). */
  private orderGoal(): V3 | null {
    const o = this.order, s = this.s;
    if (o.kind === 'follow' && o.leader) {
      const L = o.leader, off = o.offset ?? [0, -4];
      const fx = -Math.sin(L.yaw), fz = -Math.cos(L.yaw), rx = -fz, rz = fx;
      const p: V3 = [L.pos[0] + rx * off[0] + fx * off[1], L.pos[1], L.pos[2] + rz * off[0] + fz * off[1]];
      return Math.hypot(p[0] - s.pos[0], p[2] - s.pos[2]) > 2.5 ? p : null;
    }
    if (o.kind === 'hold' || (o.kind === 'defend' && Math.hypot(o.pos[0] - s.pos[0], o.pos[2] - s.pos[2]) < 1.2)) return null;
    if (o.kind === 'patrol' || o.kind === 'search') {
      if (!this.goal || Math.hypot(this.goal[0] - s.pos[0], this.goal[2] - s.pos[2]) < 2) {
        const next = o.kind === 'search' && this.searchSpots.length ? this.searchSpots.shift()! : this.nav?.around(o.pos, o.radius ?? 40) ?? [o.pos[0] + (Math.random() - 0.5) * 40, o.pos[1], o.pos[2] + (Math.random() - 0.5) * 40];
        this.goal = next; this.path = [];
      }
      return this.goal;
    }
    return Math.hypot(o.pos[0] - s.pos[0], o.pos[2] - s.pos[2]) > 1.2 ? o.pos : null;
  }

  /** Steering along a navmesh path to `to`. Returns a unit direction (x, z) or null when there. */
  private steer(to: V3, dt: number): [number, number] | null {
    const s = this.s;
    this.repathT -= dt;
    const moved = this.goal ? Math.hypot(this.goal[0] - to[0], this.goal[2] - to[2]) : Infinity;
    if (this.nav && (moved > 12 || this.repathT <= 0 || !this.path.length) && this.nav.budget > 0) {
      this.goal = [...to];
      this.path = this.nav.path(s.pos, to) ?? [to];
      this.pathI = this.path.length > 1 ? 1 : 0;
      this.repathT = 4 + Math.random() * 3;
    } else if (moved > 0.5 && this.path.length) {
      // Small goal moves (following a leader): just move the end point, kept on the navmesh.
      this.goal = [...to];
      this.snapT -= dt;
      if (this.nav && this.snapT <= 0) { this.snapT = 0.5; this.snapped = this.nav.closest(to, 3) ?? to; }
      this.path[this.path.length - 1] = this.snapped && Math.hypot(this.snapped[0] - to[0], this.snapped[2] - to[2]) < 3 ? this.snapped : [...to];
    } else if (!this.path.length) { this.goal = [...to]; this.path = [to]; this.pathI = 0; }
    let p = this.path[this.pathI];
    // Next corner once this one is reached or passed (cutting a corner early wedges the bot against the wall it turns
    // round: moves stay on the navmesh, so it slides into the inside corner of a doorway and stops).
    // In tight spots corners can be centimetres apart, so it also has to see the next corner in a straight line.
    const passed = (i: number) => {
      const c = this.path[i], d = Math.hypot(c[0] - s.pos[0], c[2] - s.pos[2]);
      if (d < 0.08) return true;
      if (d > 1.0) return false;
      const q = i > 0 ? this.path[i - 1] : null;
      const near = d < 0.35 || (!!q && (s.pos[0] - c[0]) * (c[0] - q[0]) + (s.pos[2] - c[2]) * (c[2] - q[2]) > 0);
      return near && (!this.nav || this.nav.clearLine(this.navRef || this.nav.ref(s.pos), s.pos, this.path[i + 1]));
    };
    while (p && this.pathI < this.path.length - 1 && passed(this.pathI)) p = this.path[++this.pathI];
    if (!p) return null;
    const dx = p[0] - s.pos[0], dz = p[2] - s.pos[2], d = Math.hypot(dx, dz);
    if (d < 0.5 && this.pathI >= this.path.length - 1) return null;
    // Stuck detection: little progress for 2 s → repath with a side-step.
    this.stuckT += dt;
    if (this.stuckT > 2) {
      const moved = Math.hypot(s.pos[0] - this.lastProgress[0], s.pos[2] - this.lastProgress[2]);
      this.lastProgress = [...s.pos]; this.stuckT = 0;
      if (moved < 0.6) { this.repathT = 0; return [Math.cos(Math.random() * 6.28), Math.sin(Math.random() * 6.28)]; }
    }
    return [dx / d, dz / d];
  }
}

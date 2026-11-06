// AI crew for a vehicle. Driver: follows a planned route (vehicles/planner.ts), pivots on sharp corners, slows for
// turns and in town, backs out and replans when stuck. Gunner: scans for enemies the crew can see (thermal sights:
// day or night, but not through smoke), picks by threat (anti-tank gunners first) and range, chooses the round
// (sabot for armour, HEAT/HE for infantry in buildings or far away, coax for infantry in the open), lets the FCS set
// the superelevation, and fires once laid. Commander (M1A2): his CROWS .50 takes infantry the gunner is not on.
import type { Vehicle, Mount } from './vehicle';
import { superelevation } from './vehicle';
import type { VehiclePlanner } from './planner';
import type { Soldier } from '../game/soldier';
import type { AmmoId } from '../game/data/weapons';
import { G_WORLD } from '../world/physics';

type V3 = [number, number, number];
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

interface Target { s?: Soldier; v?: Vehicle; p: V3; t: number }

export class VehicleAI {
  goal: V3 | null = null; path: V3[] = []; pi = 0;
  /** Seconds trying to move without moving; reversing timer. */ private stuckT = 0; private revT = 0; private replanT = 0;
  /** Gunner's current target and when it was acquired; scan timer. */ target: Target | null = null; private acqT = 0; private scanT = 0;
  private cmdTarget: Target | null = null; private cmdScanT = 0; private burstT = 0;
  /** Points the crew was ordered to engage (suppress), with the time. */ engage: { p: V3; t: number } | null = null;
  /** Speed cap 0..1 (orders: slow advance with infantry). */ speedCap = 1;

  constructor(public v: Vehicle, private planner: VehiclePlanner) { v.ai = this; }

  /** A missile launch seen (ATGM flash / smoke): pop smoke at once and put HE on the launch point. */
  warn(from: V3) {
    const v = this.v;
    if (v.crewIn('gunner') || v.crewIn('commander')) { if (v.popSmoke() && v.g.player?.s.vehicle === v) v.g.hud?.flash('MISSILE! SMOKE!'); }
    this.engage = { p: from, t: v.g.time }; this.target = null;
  }
  /** Ordered fire on a point (infantry calling for fire on a building). */
  fireAt(p: V3) { this.engage = { p, t: this.v.g.time }; }

  driveTo(p: V3) {
    this.goal = p; this.replanT = 0;
    const path = this.planner.path(this.v.pos(), p);
    this.path = path ?? [p]; this.pi = 0;
  }
  stop() { this.goal = null; this.path = []; }
  get moving() { return !!this.goal; }

  update(dt: number) {
    const v = this.v;
    if (v.dead) return;
    const drv = v.driver();
    if (drv && !drv.isPlayer && drv.alive) this.drive(dt);
    const gunner = v.crewIn('gunner');
    if (gunner && !gunner.isPlayer) this.gun(dt);
    const cmd = v.crewIn('commander');
    if (cmd && !cmd.isPlayer && v.mounts.some((m) => m.def.id === 'cmdr')) this.commander(dt);
  }

  // ---------------- driver ----------------
  private drive(dt: number) {
    const v = this.v;
    if (!this.goal || !this.path.length) { v.throttle = 0; v.steer = 0; return; }
    const p = v.pos();
    // Advance along the route: the next point at least 8 m ahead.
    while (this.pi < this.path.length - 1 && Math.hypot(this.path[this.pi][0] - p[0], this.path[this.pi][2] - p[2]) < 8) this.pi++;
    const tp = this.path[this.pi], dist = Math.hypot(tp[0] - p[0], tp[2] - p[2]);
    const last = this.pi >= this.path.length - 1;
    if (last && dist < 6) { this.goal = null; v.throttle = 0; v.steer = 0; return; }
    const want = Math.atan2(-(tp[0] - p[0]), -(tp[2] - p[2])), err = wrap(want - v.yaw());
    if (this.revT > 0) { this.revT -= dt; v.throttle = -0.6; v.steer = -Math.sign(err) * 0.8; if (this.revT <= 0) this.driveTo(this.goal); return; }
    v.steer = Math.max(-1, Math.min(1, err * 2.2));
    const turn = Math.abs(err);
    // Friendly infantry in the way (ahead, or behind when backing, or beside the hull while it pivots): stop and wait
    // (a driver does not roll over his own people; the dismounts clear the ramp first).
    if (this.blocked(this.revT > 0 ? -1 : 1)) { v.throttle = 0; v.steer = 0; this.stuckT = 0; return; }
    const town = this.planner.cost[this.planner.cell(p[0], p[2])] === 7 ? 0.8 : 1;
    v.throttle = turn > 0.9 ? 0 : Math.min(this.speedCap, town, (1 - turn / 1.1) * Math.min(1, (last ? dist : 30) / 20) + 0.15);
    // Stuck: pushing without moving.
    if (v.throttle > 0.3 && v.speed < 0.4) this.stuckT += dt; else this.stuckT = Math.max(0, this.stuckT - dt);
    if (this.stuckT > 2.5) { this.stuckT = 0; this.revT = 2.2; }
    if ((this.replanT += dt) > 20) this.driveTo(this.goal);
  }

  // ---------------- gunner ----------------
  /** A friendly soldier within the hull's footprint grown by 1.5 m, or up to 7 m ahead in the direction of travel. */
  private blocked(dirSign: number): boolean {
    const v = this.v, p = v.pos(), yaw = v.yaw(), fx = -Math.sin(yaw), fz = -Math.cos(yaw), hl = v.def.hull[2] / 2, hw = v.def.hull[0] / 2;
    for (const s of v.g.soldiers) {
      if (s.team !== v.team || !s.alive || s.vehicle) continue;
      const dx = s.pos[0] - p[0], dz = s.pos[2] - p[2], ahead = (dx * fx + dz * fz) * dirSign, side = Math.abs(dx * -fz + dz * fx);
      if (side < hw + 1.5 && ahead > -hl - 1.5 && ahead < hl + 7) return true;
    }
    return false;
  }

  private visible(from: V3, p: V3): boolean { return this.v.g.P.clear(from, p, G_WORLD) && !this.v.g.smokeBlocks(from, p); }
  private scan(eye: V3, range: number, exclude?: Target | null): Target | null {
    const g = this.v.g, team = this.v.team;
    let best: Target | null = null, bs = -1;
    for (const s of g.soldiers) {
      if (s.team === team || !s.alive || s.vehicle || (exclude?.s === s)) continue;
      const c: V3 = [s.pos[0], s.pos[1] + (s.stance === 'prone' ? 0.3 : s.stance === 'crouch' ? 0.9 : 1.3), s.pos[2]];
      const d = Math.hypot(c[0] - eye[0], c[1] - eye[1], c[2] - eye[2]); if (d > range) continue;
      if (!this.visible(eye, c)) continue;
      // Threat: anti-armour first, then machine guns, then the rest; nearer is worse.
      const threat = s.kit.role === 'at' || s.kit.role === 'lat' ? 3 : s.kit.role === 'mg' || s.kit.role === 'ar' ? 1.6 : 1;
      const sc = threat * (1 - d / (range * 1.2));
      if (sc > bs) { bs = sc; best = { s, p: c, t: g.time }; }
    }
    for (const o of g.vehicles) {
      if (o.team === team || o.dead) continue;
      const c = o.pos(); c[1] += 1.4;
      const d = Math.hypot(c[0] - eye[0], c[1] - eye[1], c[2] - eye[2]); if (d > range * 1.5) continue;
      if (!this.visible(eye, c)) continue;
      const sc = 5 * (1 - d / (range * 1.8));
      if (sc > bs) { bs = sc; best = { v: o, p: c, t: g.time }; }
    }
    return best;
  }

  private gun(dt: number) {
    const v = this.v, g = v.g, seat = v.seats.findIndex((s) => s.def.role === 'gunner'), eye = v.nodePos(v.seats[seat].def.node);
    if ((this.scanT -= dt) <= 0) {
      this.scanT = 0.6 + Math.random() * 0.4;
      const T0 = this.target;
      const keep = !!T0 && (T0.s ? T0.s.alive : T0.v ? !T0.v.dead : g.time - T0.t < 25) && (T0.s || T0.v ? this.visible(eye, this.tp(T0)) : true);
      if (!keep) {
        const t = this.scan(eye, v.def.id === 'm1a2' ? 1800 : 1500);
        if (t?.s !== this.target?.s || t?.v !== this.target?.v) { this.target = t; this.acqT = 0; }
      }
      // Ordered to engage a point (no target of his own): put HE on it.
      if (!this.target && this.engage && g.time - this.engage.t < 25) this.target = { p: this.engage.p, t: g.time };
    }
    const T = this.target;
    if (!T) { v.aimYaw = v.yaw() + wrap(v.aimYaw - v.yaw()) * 0.98; return; }
    const tp = this.tp(T), dx = tp[0] - eye[0], dy = tp[1] - eye[1], dz = tp[2] - eye[2], dist = Math.hypot(dx, dy, dz);
    // Weapon and round.
    const mounts = v.mountsOf(seat), main = mounts[0], coax = mounts.find((m) => m.def.id === 'coax'), tow = mounts.find((m) => m.def.id === 'tow');
    const indoors = !!T.s && !!g.audio.indoorAt(tp);
    let mt: Mount = main;
    if (T.v) { if (tow && dist > 400 && tow.ready[0] > 0 && v.stillT > 0) mt = tow; else v.selectAmmo(main, 0); }
    else if (T.s) {
      const open = !indoors;
      if (coax && open && dist < (v.def.id === 'm1a2' ? 500 : 300) && T.s.kit.role !== 'at') mt = coax;
      else if (main.def.ammo.length > 1) v.selectAmmo(main, 1);
    } else if (main.def.ammo.length > 1) v.selectAmmo(main, 1);
    const ammo = mt.def.ammo[mt.def.rpm === 0 ? mt.sel : mt.sel] as AmmoId;
    v.range = Math.round(dist); v.fcs = mt === main ? superelevation(ammo, dist) : 0;
    v.aimYaw = Math.atan2(-dx, -dz); v.aimPitch = Math.asin(dy / dist);
    this.acqT += dt;
    // Laid? (turret on the bearing, gun at the elevation) and a reaction time after acquiring.
    const yawErr = Math.abs(wrap(v.aimYaw - v.yaw() - v.turretYaw));
    const tol = mt.def.rpm === 0 ? Math.max(0.003, 1.2 / dist) : Math.max(0.01, 3 / dist);
    if (yawErr < tol && this.acqT > (T.v ? 1.5 : 1.0 + Math.random() * 0.8) && this.clearLine(v.nodePos(mt.def.node), tp, mt.def.ammo[mt.sel] === '120heat' || mt.def.ammo[mt.sel] === '25he' ? 8 : 3)) {
      if (mt.def.rpm > 0) { if ((this.burstT -= dt) > -0.6) v.fire(mt, seat); else if (this.burstT < -1.2) this.burstT = 0.4 + Math.random() * 0.8; }
      else v.fire(mt, seat);
    }
  }

  /** No friendly vehicle in the line of fire, and no friendly soldier within `r` m of it (or of the impact). */
  private clearLine(o: V3, t: V3, r: number): boolean {
    const v = this.v, g = v.g, d: V3 = [t[0] - o[0], t[1] - o[1], t[2] - o[2]], L = Math.hypot(d[0], d[1], d[2]) || 1;
    const u: V3 = [d[0] / L, d[1] / L, d[2] / L];
    const h = g.P.castRay([o[0] + u[0] * 1.5, o[1] + u[1] * 1.5, o[2] + u[2] * 1.5], u, L);
    if (h) { const hv = g.vehicleOf.get(h.collider.handle); if (hv && hv !== v && hv.team === v.team) return false; }
    for (const s of g.soldiers) {
      if (s.team !== v.team || !s.alive || s.vehicle === v) continue;
      const q: V3 = s.vehicle ? s.vehicle.pos() : s.pos, w: V3 = [q[0] - o[0], q[1] + 1 - o[1], q[2] - o[2]];
      const a = Math.max(0, Math.min(L, w[0] * u[0] + w[1] * u[1] + w[2] * u[2]));
      if (Math.hypot(w[0] - u[0] * a, w[1] - u[1] * a, w[2] - u[2] * a) < (a > L - 12 ? r : 2.5)) return false;
    }
    // A friendly vehicle close to where the round lands.
    if (r > 3) for (const o2 of g.vehicles) { if (o2 === v || o2.dead || o2.team !== v.team) continue; const q = o2.pos(); if (Math.hypot(q[0] - t[0], q[2] - t[2]) < r + 4) return false; }
    return true;
  }

  private tp(t: Target): V3 {
    if (t.s) return [t.s.pos[0], t.s.pos[1] + (t.s.stance === 'prone' ? 0.3 : t.s.stance === 'crouch' ? 0.9 : 1.3), t.s.pos[2]];
    if (t.v) { const p = t.v.pos(); return [p[0], p[1] + 1.3, p[2]]; }
    return t.p;
  }

  // ---------------- commander (CROWS) ----------------
  private commander(dt: number) {
    const v = this.v, seat = v.seats.findIndex((s) => s.def.role === 'commander'), mt = v.mountsOf(seat)[0]; if (!mt) return;
    const eye = v.nodePos(v.seats[seat].def.node);
    if ((this.cmdScanT -= dt) <= 0) {
      this.cmdScanT = 0.8;
      const t = this.scan(eye, 900, this.target);
      this.cmdTarget = t?.s ? t : null;
    }
    const T = this.cmdTarget; if (!T?.s?.alive) return;
    const tp = this.tp(T), o = v.nodePos(mt.def.node), dx = tp[0] - o[0], dy = tp[1] - o[1], dz = tp[2] - o[2], d = Math.hypot(dx, dy, dz);
    const wantYaw = wrap(Math.atan2(-dx, -dz) - v.yaw() - v.turretYaw), wantP = Math.asin(dy / d);
    mt.yaw += Math.max(-1.2 * dt, Math.min(1.2 * dt, wrap(wantYaw - mt.yaw)));
    mt.pitch += Math.max(-0.8 * dt, Math.min(0.8 * dt, wantP - mt.pitch));
    if (Math.abs(wrap(wantYaw - mt.yaw)) < 0.02) {
      const yaw = v.yaw() + v.turretYaw + mt.yaw, dir: V3 = [-Math.sin(yaw) * Math.cos(mt.pitch), Math.sin(mt.pitch), -Math.cos(yaw) * Math.cos(mt.pitch)];
      if (Math.random() < 0.7) v.fire(mt, seat, dir);
    }
  }
}

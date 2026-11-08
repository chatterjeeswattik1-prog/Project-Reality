// A player in someone else's match (the host's browser runs it: net/host.ts). His own soldier moves here (no waiting
// on the network); his shots, throws, charges, reloads and dressings go to the host, which decides every hit, wound
// and wall cut. Everyone else is drawn from the host's snapshots, about 100 ms in the past so their movement stays
// smooth; every shot is shown here (flash, sound, tracer, impacts) as the host reports it; wall cuts arrive with the
// host's seed, so the holes are the same as his.
import * as THREE from 'three';
import { slotMsg, slotOf, type Game, type SlotMsg } from '../game/game';
import type { Bullet } from '../game/projectiles';
import type { GameMode } from '../game/mode';
import { Soldier } from '../game/soldier';
import { kitById, type Faction } from '../game/data/kits';
import { AMMO, WEAPONS, type WeaponDef } from '../game/data/weapons';
import type { SpawnPoint } from '../ui/menus';
import { connectToHost, send, sendU, type Link } from './peer';
import { decodeSnapshot, encodeMove, LIFE, STANCES, type SoldierRec, type VehicleRec } from './proto';

type V3 = [number, number, number];
const DELAY = 0.1, SEND_HZ = 20;

/** The host's match status, as this player sees it. */
export class ClientMode implements GameMode {
  kind = 'insurgency' as const;
  log: { t: number; text: string; team?: 'us' | 'ins' }[] = [];
  over: null | 'us' | 'ins' = null;
  timeLeft = 0;
  top = '';
  spawns: { us: SpawnPoint[]; ins: SpawnPoint[] } = { us: [], ins: [] };
  constructor(private g: Game) {}
  say(text: string, team?: 'us' | 'ins') { this.log.push({ t: this.g.time, text, team }); if (this.log.length > 40) this.log.shift(); }
  onDown() { /* the host reports kills */ }
  onExplosion() { /* the host decides */ }
  spot() { /* the host decides */ }
  update() { /* status comes from the host */ }
  hudTop() { return this.top; }
}

interface Remote { s: Soldier; buf: { t: number; r: SoldierRec }[]; seen: boolean }

/** Weapon (sound, flash) for a reported shot: the shooter's own weapon, else the vehicle gun by its ammunition. */
const VEH_SOUND: Record<string, [string, string, number]> = {
  '120apfsds': ['tank_fire', 'explosion_far', 6], '120heat': ['tank_fire', 'explosion_far', 6], '25ap': ['cannon25', 'heavy_far', 2.2], '25he': ['cannon25', 'heavy_far', 2.2],
  '762x51': ['m240_shot', 'heavy_far', 1], '50bmg': ['m2_shot', 'heavy_far', 1], tow2: ['tow_launch', 'explosion_far', 1.5], '9m113': ['tow_launch', 'explosion_far', 1.5],
};

export interface ClientDeps {
  game: Game; mode: ClientMode; myId: string; myName: string; side: Faction; hostId: string; ice: RTCIceServer[];
  me: () => Soldier | null;
  /** The host ended / lost the match. */ onLost: (why: string) => void;
}

export class ClientSync {
  private link: Link | null = null;
  private remotes = new Map<number, Remote>();
  private hostT = 0; private hostTAt = 0; private renderT = 0;
  private sendT = 0;
  myNid = 0;
  private ghost: Soldier | null = null;
  private applying = false;
  private vfT: Record<number, number> = {}; private vcT = 0;
  private pickUpLocal: Game['pickUp'] | null = null;
  /** Guided missiles in flight (the host's id → our copy). */ private missiles = new Map<number, Bullet>();
  connected = false;
  constructor(private D: ClientDeps) {
    const g = D.game;
    g.netRole = 'client';
    // The player's own actions go to the host as well as happening here.
    const fire = g.proj.fire.bind(g.proj), throwItem = g.proj.throwItem.bind(g.proj), place = g.placeCharge.bind(g), det = g.detonate.bind(g), reload = g.reload.bind(g);
    g.proj.fire = (owner, def, ammoId, origin, dir, tracer, guide) => {
      const b = fire(owner, def, ammoId, origin, dir, tracer, guide);
      if (owner === D.me() && !this.applying) this.send({ t: 'fire', a: ammoId, o: origin, d: dir, tr: tracer ? 1 : 0 });
      return b;
    };
    g.proj.throwItem = (owner, ammoId, origin, vel, fuse) => {
      throwItem(owner, ammoId, origin, vel, fuse);
      if (owner === D.me() && !this.applying) this.send({ t: 'throw', a: ammoId, o: origin, v: vel, f: fuse });
    };
    g.placeCharge = (s, p, a) => { place(s, p, a); if (s === D.me() && !this.applying) this.send({ t: 'charge', p, a }); };
    g.detonate = (owner) => { if (owner === D.me() && !this.applying && g.charges.some((c) => c.owner === owner)) this.send({ t: 'det' }); det(owner); };
    g.reload = (s) => { const ok = reload(s); if (ok && s === D.me()) this.send({ t: 'reload' }); return ok; };
    // Doors: our own use goes to the host (it swings here at once); the rest come from him.
    if (g.doors) g.doors.onChange = (i, target, _removed, byUse) => { if (byUse && !this.applying) this.send({ t: 'door', i, o: target }); };
    // Picking up a weapon: the host hands it over (he knows who got there first).
    const pickUp = g.pickUp.bind(g);
    this.pickUpLocal = pickUp;
    g.pickUp = (s, k, leave) => {
      if (s !== D.me() || this.applying) { pickUp(s, k, leave); return; }
      const FA = ['rifle', 'lmg', 'gpmg', 'sniper', 'pistol', 'launcher'];
      const cur = FA.includes(s.weapon.kind) ? s.slot : s.slots.find((x) => FA.includes(x.def.kind));
      this.send({ t: 'pick', id: k.id, cur: cur ? slotMsg(cur) : null });
    };
    g.netVehicle = (op, v, a, s) => {
      if (this.applying) return false;
      const idx = g.vehicles.indexOf(v);
      if (op === 'enter' && s === D.me()) this.send({ t: 'seat', v: idx, i: a.i });
      else if (op === 'exit' && s === D.me()) this.send({ t: 'exit' });
      else if (op === 'fire') {
        // Held triggers repeat every frame: at most ~15 requests a second (the host fires at the gun's own rate).
        const now = g.time; if (now - (this.vfT[a.m] ?? -9) < 0.066) return true;
        this.vfT[a.m] = now; this.send({ t: 'vfire', m: a.m });
      } else if (op === 'ammo') this.send({ t: 'vammo', m: a.m, k: a.k });
      else if (op === 'lase') this.send({ t: 'lase' });
      else if (op === 'smoke') this.send({ t: 'smoke' });
      return true;
    };
  }

  async connect(): Promise<void> {
    const D = this.D;
    this.link = await connectToHost(D.myId, D.hostId, D.ice, { name: D.myName, side: D.side }, {
      onOpen: () => undefined,
      onClose: () => { if (!this.connected) return; this.connected = false; D.onLost('Connection to the host lost'); },
      onR: (_l, m) => this.onMessage(m as Record<string, unknown>),
      onU: (_l, d) => this.onSnapshot(d),
    });
    this.connected = true;
    this.send({ t: 'hello', name: D.myName, side: D.side });
  }
  send(m: unknown) { if (this.link) send(this.link, m); }
  get rtt() { return this.link?.rtt ?? 0; }

  /** Tell the host where we spawn (he makes our stand-in there). */
  spawned(me: Soldier, kitId: string, side: Faction) {
    me.netSlave = true;
    // A field dressing and giving up are the host's to apply.
    const band = me.startBandage.bind(me);
    me.startBandage = () => { const ok = band(); if (ok) this.send({ t: 'bandage' }); return ok; };
    const die = me.die.bind(me);
    me.die = (by) => { if (!this.applying && me.state === 'wounded') this.send({ t: 'giveup' }); die(by); };
    this.myNid = 0;
    this.send({ t: 'spawn', kit: kitId, side, pos: me.pos, yaw: me.yaw });
  }

  private remote(nid: number) { return this.remotes.get(nid)?.s ?? null; }
  /** Owner of a reported shot when we do not know the shooter (yet): a stand-in out of play. */
  private ghostOf(): Soldier {
    if (!this.ghost) { this.ghost = new Soldier(this.D.game.P, kitById('us_rifle'), 'us', [0, -500, 0], ''); this.ghost.die(null); }
    return this.ghost;
  }

  /** The vehicle whose gun fired from o (within 8 m): a stand-in riding it (rounds pass through its own hull). */
  private vghosts = new Map<object, Soldier>();
  private vehicleGhost(o: V3): Soldier | null {
    let best = null as import('../vehicles/vehicle').Vehicle | null, bd = 64;
    for (const v of this.D.game.vehicles) { const p = v.pos(), d = (p[0] - o[0]) ** 2 + (p[1] - o[1]) ** 2 + (p[2] - o[2]) ** 2; if (d < bd) { bd = d; best = v; } }
    if (!best) return null;
    let gh = this.vghosts.get(best);
    if (!gh) { gh = new Soldier(this.D.game.P, kitById('us_crew'), best.team, [0, -500, 0], ''); gh.die(null); this.vghosts.set(best, gh); }
    gh.vehicle = best;
    return gh;
  }

  private addRemote(e: Record<string, unknown>) {
    const nid = Number(e.s);
    if (nid === this.myNid || this.remotes.has(nid)) return;
    const kit = kitById(String(e.k));
    const s = this.D.game.spawn(kit, e.tm === 'ins' ? 'ins' : 'us', [0, -200, 0], String(e.n ?? ''), 0, Number(e.m ?? 0));
    s.netRemote = true; s.netHidden = true;
    if (typeof e.w === 'number' && e.w < s.slots.length) s.cur = e.w;
    this.remotes.set(nid, { s, buf: [], seen: false });
  }
  private delRemote(nid: number) { const r = this.remotes.get(nid); if (!r) return; this.remotes.delete(nid); this.D.game.remove(r.s); }

  private onMessage(m: Record<string, unknown>) {
    const g = this.D.game, mode = this.D.mode;
    switch (m.t) {
      case 'welcome': {
        for (const e of (m.roster as Record<string, unknown>[]) ?? []) this.addRemote(e);
        this.hostT = Number(m.time ?? 0); this.hostTAt = g.time;
        // Joining mid-match: the same wall damage (cuts and crushing, in order), doors, weapons lying about.
        this.applying = true;
        try {
          for (const e of (m.hist as Record<string, unknown>[]) ?? []) this.onEvent(e);
          ((m.doors as number[]) ?? []).forEach((t, i) => { if (t < 0) g.doors?.setState(i, 0, true); else g.doors?.setState(i, t, false); });
          for (const k of (m.pickups as { id: number; p: V3; ry: number; slot: SlotMsg }[]) ?? []) { const sl = slotOf(k.slot); if (sl) g.dropAt(k.id, sl, k.p, k.ry); }
        } finally { this.applying = false; }
        break;
      }
      case 'got': {
        // The weapon is ours (our old one is reported lying where it was).
        const me = this.D.me(), sl = slotOf(m.slot as SlotMsg);
        if (me && sl && this.pickUpLocal) { this.applying = true; try { this.pickUpLocal(me, { id: -1, slot: sl, obj: new THREE.Object3D() }, false); } finally { this.applying = false; } }
        break;
      }
      case 'gotno': g.hud?.flash('Someone got there first'); break;
      case 'spawned': this.myNid = Number(m.nid); this.delRemote(this.myNid); break;
      case 'you': this.applyLife(m); break;
      case 'mode': {
        mode.top = String(m.top ?? ''); mode.over = (m.over as 'us' | 'ins' | null) ?? null; mode.timeLeft = Number(m.tl ?? 0);
        if (m.spawns) mode.spawns = m.spawns as ClientMode['spawns'];
        for (const [nid, k, dd] of (m.score as number[][]) ?? []) { const s = nid === this.myNid ? this.D.me() : this.remote(nid); if (s) { s.kills = k; s.deaths = dd; } }
        break;
      }
      case 'ev': for (const e of (m.e as Record<string, unknown>[]) ?? []) this.onEvent(e); break;
      case 'seatno': { const me = this.D.me(); if (me?.vehicle) { this.applying = true; try { me.vehicle.exit(me, true); } finally { this.applying = false; } } g.hud?.flash(String(m.why ?? 'Seat taken').toUpperCase()); break; }
      case 'range': { const me = this.D.me(); if (me?.vehicle) me.vehicle.range = Number(m.r) || 0; break; }
      case 'vst': {
        // Our vehicle's ammunition and readiness (the host runs it).
        const v = g.vehicles[Number(m.v)]; if (!v) break;
        (m.m as unknown[][]).forEach((x, i) => { const mt = v.mounts[i]; if (!mt) return; mt.sel = Number(x[0]); mt.loaded = !!x[1]; mt.loadedType = Number(x[2]); mt.belt = Number(x[3]); mt.ready = x[4] as number[]; mt.stowed = x[5] as number[]; v.netBlocked[mt.def.id] = (x[6] as string | null) ?? null; });
        v.smoke = Number(m.sm ?? v.smoke); v.integrity = Number(m.i ?? v.integrity); v.tracked = !!m.tr; v.engineOut = !!m.eo;
        break;
      }
    }
  }

  private onEvent(e: Record<string, unknown>) {
    const g = this.D.game;
    this.applying = true;
    try {
      switch (e.t) {
        case 'add': this.addRemote(e); break;
        case 'del': this.delRemote(Number(e.s)); break;
        case 'log': this.D.mode.say(String(e.text ?? ''), e.team as 'us' | 'ins' | undefined); break;
        case 'shot': {
          const s = this.remote(Number(e.s)), a = String(e.a), o = e.o as V3, d = e.d as V3;
          // A vehicle's gun: replayed with an owner riding that vehicle, so the round leaves it as on the host.
          const owner = s && !s.netHidden ? s : this.vehicleGhost(o) ?? s ?? this.ghostOf();
          const b = g.proj.fire(owner, null, a, o, d, !!e.tr);
          if (e.g) this.missiles.set(Number(e.g), b);
          if (s && !s.netHidden) {
            s.lastShotT = g.time;
            const def: WeaponDef | undefined = s.underSel ? WEAPONS.m203 : s.slots[s.cur]?.def;
            if (def && def.ammo === a) { g.shotFx(s, def, o, d); break; }
          }
          // A vehicle's gun (or an unknown shooter): its report and flash.
          const vs = VEH_SOUND[a];
          if (vs) { g.fx.muzzle(o, d, vs[2], false); g.audio.play(vs[0], o, { range: vs[2] > 3 ? 3000 : 1500, far: vs[1], nearDist: 150, gain: 1, delay: true }); }
          else { const w = Object.values(WEAPONS).find((x) => x.ammo === a); if (w) { g.fx.muzzle(o, d, 1, false); g.audio.play(w.sound, o, { range: 1600, far: w.farSound, nearDist: 90, gain: 1 }); } }
          break;
        }
        case 'throw': { const s = this.remote(Number(e.s)) ?? this.ghostOf(); g.proj.throwItem(s, e.a as 'frag' | 'smoke' | 'c4', e.o as V3, e.v as V3, Number(e.f ?? 4)); g.audio.play('grenade_throw', e.o as V3, { range: 25 }); break; }
        case 'charge': { const s = this.remote(Number(e.s)) ?? this.ghostOf(); g.placeCharge(s, e.p as V3, String(e.a)); break; }
        case 'det': { const s = this.remote(Number(e.s)); if (s) g.detonate(s); break; }
        case 'blast': g.applyBlast(e.p as V3, Number(e.b), Number(e.l), Number(e.w), Number(e.s), !!e.d); break;
        case 'door': g.doors?.setState(Number(e.i), Number(e.o), !!e.r); break;
        case 'drop': {
          const sl = slotOf(e.slot as SlotMsg); if (!sl) break;
          // A body's weapon: the one lying by his body here; otherwise a fresh one where the host has it.
          const r = e.s ? this.remote(Number(e.s)) : null, rig = r ? g.rigs.get(r.id) : null;
          if (rig?.weapon && !g.pickups.some((k) => k.obj === rig.weapon)) g.addPickup(sl, rig.weapon, {}, Number(e.id));
          else g.dropAt(Number(e.id), sl, e.p as V3, Number(e.ry ?? 0));
          break;
        }
        case 'take': g.removePickup(Number(e.id)); break;
        case 'msl': {
          // The host's missile as it was ~half a ping plus the event batching ago: carried forward to now.
          const b = this.missiles.get(Number(e.id));
          if (b && g.proj.bullets.includes(b)) { const p = e.p as V3, v = e.v as V3, lag = this.rtt / 2000 + 0.03; b.p = [p[0] + v[0] * lag, p[1] + v[1] * lag, p[2] + v[2] * lag]; b.v = v; }
          else this.missiles.delete(Number(e.id));
          break;
        }
        case 'crush': { const c = e.c as number[], f = e.f as [number, number], y = e.y as number[]; g.destruct?.crush(c[0], c[1], c[2], c[3], f, y[0], y[1]); break; }
        case 'down': break; // the log line comes from the host's mode; the state from the snapshots
      }
    } finally { this.applying = false; }
  }

  /** The host's verdict on our own soldier: health, bleeding, wounded, dead. */
  private applyLife(m: Record<string, unknown>) {
    const me = this.D.me(); if (!me) return;
    this.applying = true;
    try {
      me.health = Number(m.h ?? me.health); me.bleed = Number(m.b ?? me.bleed);
      if (typeof m.bd === 'number') me.bandages = m.bd;
      const st = String(m.st);
      if (st === 'wounded' && me.state === 'alive') { me.setStance('prone', this.D.game.time); me.state = 'wounded'; me.downT = 0; me.health = 0; me.aiming = false; }
      else if (st === 'dead' && me.state !== 'dead') { const by = [...this.remotes.values()].find((r) => r.s.name === m.by)?.s ?? null; me.die(by); }
      else if (st === 'alive' && me.state === 'wounded') me.revive();
    } finally { this.applying = false; }
  }

  private onSnapshot(data: ArrayBuffer) {
    const snap = decodeSnapshot(data); if (!snap) return;
    const g = this.D.game;
    // Host clock → ours: render a little behind the newest snapshot.
    if (snap.t > this.hostT) { this.hostT = snap.t; this.hostTAt = g.time; }
    for (const r of snap.soldiers) {
      const rm = this.remotes.get(r.nid); if (!rm) continue;
      rm.buf.push({ t: snap.t, r }); if (rm.buf.length > 12) rm.buf.shift();
    }
    for (const v of snap.vehicles) this.applyVehicle(v);
  }

  private applyVehicle(r: VehicleRec) {
    const v = this.D.game.vehicles[r.idx]; if (!v || !v.netRemote) return;
    v.body.setNextKinematicTranslation({ x: r.x, y: r.y, z: r.z });
    const L = Math.hypot(...r.q) || 1;
    v.body.setNextKinematicRotation({ x: r.q[0] / L, y: r.q[1] / L, z: r.q[2] / L, w: r.q[3] / L });
    v.turretYaw = r.turretYaw; v.gunPitch = r.gunPitch;
    const st = v.mounts.find((m) => m.def.station); if (st) { st.yaw = r.stYaw; st.pitch = r.stPitch; }
    if (r.dead && !v.dead) v.destroy(false);
    v.burning = r.burning;
  }

  update(dt: number) {
    const g = this.D.game;
    // Remote soldiers: interpolate between the two snapshots around the render time.
    this.renderT = this.hostT + (g.time - this.hostTAt) - DELAY;
    for (const rm of this.remotes.values()) {
      const b = rm.buf; if (!b.length) continue;
      let i = b.length - 1;
      while (i > 0 && b[i - 1].t > this.renderT) i--;
      const B = b[i], A = i > 0 ? b[i - 1] : B;
      const k = B.t > A.t ? Math.max(0, Math.min(1, (this.renderT - A.t) / (B.t - A.t))) : 1;
      this.pose(rm, A.r, B.r, k);
    }
    // Our own soldier to the host.
    const me = this.D.me();
    // In a vehicle: the controls go to the host (~15 Hz): throttle and steering, the gunner's aim, a pintle / CROWS aim.
    if (this.connected && me?.vehicle && (this.vcT += dt) >= 1 / 15) {
      this.vcT = 0;
      const v = me.vehicle, mt = v.mountsOf(v.seatOf(me))[0];
      this.send({ t: 'vc', th: v.throttle, st: v.steer, ay: v.aimYaw, ap: v.aimPitch, sy: mt?.aimYaw ?? 0, sp: mt?.aimPitch ?? 0 });
    }
    if (this.connected && me && this.link && (this.sendT += dt) >= 1 / SEND_HZ) {
      this.sendT = 0;
      sendU(this.link, encodeMove({ x: me.pos[0], y: me.pos[1], z: me.pos[2], vx: me.vel[0], vz: me.vel[2], yaw: me.yaw, pitch: me.pitch, stance: Math.max(0, STANCES.indexOf(me.stance)), aiming: me.aiming, sprinting: me.sprinting, underSel: me.underSel, light: me.light, cur: me.cur, ads: me.ads, lean: me.lean }));
    }
  }

  private pose(rm: Remote, A: SoldierRec, B: SoldierRec, k: number) {
    const s = rm.s, g = this.D.game, lerp = (a: number, b: number) => a + (b - a) * k;
    let dy = B.yaw - A.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    s.pos = [lerp(A.x, B.x), lerp(A.y, B.y), lerp(A.z, B.z)];
    s.yaw = A.yaw + dy * k; s.pitch = lerp(A.pitch, B.pitch);
    s.vel = [B.vx, 0, B.vz]; s.moving = Math.hypot(B.vx, B.vz); s.onGround = true;
    s.netHidden = B.inVeh;
    rm.seen = true;
    // Life: wounded and dead as the host has it (a death starts the ragdoll here too).
    const life = LIFE[B.life] ?? 'alive';
    if (life === 'dead' && s.state !== 'dead') { s.die(null); return; }
    if (s.state === 'dead') return;
    if (life === 'wounded' && s.state === 'alive') { s.state = 'wounded'; s.downT = 0; }
    else if (life === 'alive' && s.state === 'wounded') { s.state = 'alive'; }
    s.stance = STANCES[B.stance] ?? 'stand';
    s.eyeH += ((s.stance === 'stand' ? 1.62 : s.stance === 'crouch' ? 1.0 : 0.3) - s.eyeH) * 0.2;
    s.aiming = B.aiming; s.ads = B.ads; s.sprinting = B.sprinting; s.underSel = B.underSel; s.light = B.light; s.lean = B.lean;
    if (B.cur !== s.cur && B.cur < s.slots.length) { s.cur = B.cur; }
    // Reload progress drives the reload animation.
    if (B.reload > 0) { s.reloadDur = 2; s.reloadT = (1 - B.reload) * 2; s.reloadEmpty = B.reloadEmpty; } else s.reloadT = 0;
    if (s.state === 'alive') s.body.setNextKinematicTranslation({ x: s.pos[0], y: s.pos[1] + 0.3 + (s.stance === 'stand' ? 0.6 : s.stance === 'crouch' ? 0.28 : 0), z: s.pos[2] });
    void g;
  }

  /** Remote soldiers (for the scoreboard / map). */
  remoteList() { return [...this.remotes.values()].map((r) => r.s); }
}
void THREE; void AMMO;

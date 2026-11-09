// The host player's browser runs the match (net/README in CLAUDE.md): this admits up to 29 other players, gives each a
// stand-in soldier moved by his updates, applies what he does (shots, throws, charges, reloads, dressings), and sends
// everyone the match: snapshots of the soldiers near him and of the vehicles (unreliable, ~15 Hz), and events
// (reliable): shots and throws by anyone (so every machine shows the same fire), joins and leaves, kills, the mode's
// log and status, wall cuts with their seeds, his own health.
import * as THREE from 'three';
import type { Game } from '../game/game';
import type { GameMode } from '../game/mode';
import type { Soldier } from '../game/soldier';
import { slotMsg, slotOf, type SlotMsg } from '../game/game';
import type { Bullet } from '../game/projectiles';
import { kitById, type Faction } from '../game/data/kits';
import type { SpawnPoint } from '../ui/menus';
import { HostLinks, send, sendU, type Link } from './peer';
import { closeLobby, hostBeat } from './signal';
import { decodeMove, encodeSnapshot, LIFE, STANCES, type SoldierRec, type VehicleRec } from './proto';

type V3 = [number, number, number];
export const MAX_PLAYERS = 20;
const SNAP_HZ = 15, NEAR = 900;

interface Peer { link: Link; name: string; side: Faction; proxy: Soldier | null; botTaken: boolean; joined: number; lastLife: string }

/** What the host needs from the rest of the game (main.ts wires it). */
export interface HostDeps {
  game: Game; mode: GameMode; seed: number; myId: string; myName: string; ice: RTCIceServer[];
  spawnPoints: (side: Faction) => SpawnPoint[];
  /** Retire one bot of this side to make room for a player (returns false if none left). */
  takeBot: (side: Faction) => boolean;
  /** Always-on server: no player of its own (all 20 places are for players); `key` proves it to the lobby. */
  dedicated?: boolean; key?: string;
}

export class HostSync {
  private peers = new Map<string, Peer>();
  private links: HostLinks;
  private known = new Set<number>();
  private events: Record<string, unknown>[] = [];
  private snapT = 0; private mslT = 0; private evT = 0; private modeT = 0; private beatAt = performance.now();
  private logN = 0; private vstT = 0;
  /** Wall cuts and crushing so far (replayed to late joiners), guided missiles in flight. */
  private history: Record<string, unknown>[] = []; private missiles = new Map<number, Bullet>();
  /** A shot being fired for a player (his rifle, his vehicle's gun). */ private peerShot = false;
  /** Bytes sent per second (for the host-load readout). */ rate = 0; private bytes = 0; private rateT = 0;
  constructor(private D: HostDeps) {
    const g = D.game;
    g.netRole = 'host';
    // Wall cuts and crushing are kept (in order) for players who join later: they rebuild the same damage.
    g.netEmit = (ev) => { this.events.push(ev); if (ev.t === 'blast' || ev.t === 'crush') this.history.push(ev); };
    // Doors: whoever swings one (a player, a bot, a blast), every machine follows the host.
    if (g.doors) g.doors.onChange = (i, target, removed) => this.events.push({ t: 'door', i, o: target, r: removed ? 1 : 0 });
    // Every shot and throw, by bots and players alike, is shown on every machine.
    const fire = g.proj.fire.bind(g.proj), throwItem = g.proj.throwItem.bind(g.proj);
    g.proj.fire = (owner, def, ammoId, origin, dir, tracer, guide) => {
      const b = fire(owner, def, ammoId, origin, dir, tracer, guide);
      // A wire-guided missile: its flight is streamed (players' copies follow it, net/client.ts).
      if (b.ammo.guided) this.missiles.set(b.id, b);
      // (x: a player's own rifle shot, already shown on his screen — not echoed back to him.)
      this.events.push({ t: 'shot', s: owner.id, a: ammoId, o: r3(origin), d: r4(dir), tr: tracer ? 1 : 0, x: this.peerShot && !owner.vehicle ? 1 : 0, g: b.ammo.guided ? b.id : 0 });
      return b;
    };
    g.proj.throwItem = (owner, ammoId, origin, vel, fuse) => {
      throwItem(owner, ammoId, origin, vel, fuse);
      this.events.push({ t: 'throw', s: owner.id, a: ammoId, o: r3(origin), v: r3(vel), f: fuse });
    };
    const prevDown = g.events.onDown;
    g.events.onDown = (v, by, killed) => { prevDown?.(v, by, killed); this.events.push({ t: 'down', v: v.id, by: by?.id ?? 0, k: killed ? 1 : 0 }); };
    this.links = new HostLinks(D.myId, D.ice, {
      admit: (id) => (this.players >= MAX_PLAYERS && !this.peers.has(id) ? `The match is full (${MAX_PLAYERS} players)` : null),
      onOpen: (l) => this.onOpen(l),
      onClose: (l) => this.onClose(l),
      onR: (l, m) => this.onMessage(l, m as Record<string, unknown>),
      onU: (l, d) => this.onMove(l, d),
    });
    void this.beat();
    addEventListener('beforeunload', () => { void closeLobby(D.myId); });
  }

  get players() { return this.peers.size + (this.D.dedicated ? 0 : 1); }
  /** Lobby heartbeat, every 25 s once the match is held (every 5 s until then: a dedicated server retries until it holds
   *  it). Each beat also brings the mail that waited in this host's mailbox (join knocks, offers). */
  holding = false;
  private startedAt = Date.now();
  private async beat() {
    try {
      const { msgs } = await hostBeat(this.D.myId, this.D.myName, this.D.seed, this.players, this.startedAt, this.D.key);
      this.holding = true; this.links.deliver(msgs);
    } catch (e) { this.holding = false; console.warn('lobby:', (e as Error).message); }
  }
  peerList() { return [...this.peers.values()].map((p) => ({ name: p.name, side: p.side, rtt: Math.round(p.link.rtt) })); }

  private onOpen(l: Link) {
    const p: Peer = { link: l, name: 'Player', side: 'us', proxy: null, botTaken: false, joined: performance.now(), lastLife: '' };
    this.peers.set(l.id, p);
    // Everyone already in play, so he can build them before the first snapshot.
    const g = this.D.game;
    send(l, {
      t: 'welcome', seed: this.D.seed, time: g.time, roster: g.soldiers.map((s) => this.rosterEntry(s)),
      // The match so far: the same wall damage, doors as they stand, weapons lying about.
      hist: this.history, doors: g.doors?.states() ?? [],
      pickups: g.pickups.map((k) => { const w = k.obj.getWorldPosition(new THREE.Vector3()); return { id: k.id, p: [w.x, w.y, w.z], ry: k.obj.rotation.y, slot: slotMsg(k.slot) }; }),
    });
  }
  private onClose(l: Link) {
    const p = this.peers.get(l.id); if (!p) return;
    this.peers.delete(l.id);
    if (p.proxy) { this.D.game.remove(p.proxy); }
    this.D.mode.say(`${p.name} left the match`);
  }
  private rosterEntry(s: Soldier) { return { s: s.id, n: s.name, tm: s.team, k: s.kit.id, m: s.id % s.kit.model.length, w: s.cur }; }

  private onMessage(l: Link, m: Record<string, unknown>) {
    const p = this.peers.get(l.id); if (!p) return;
    const g = this.D.game, px = p.proxy;
    switch (m.t) {
      case 'hello': p.name = String(m.name ?? 'Player').slice(0, 20); p.side = m.side === 'ins' ? 'ins' : 'us'; this.D.mode.say(`${p.name} joined the match`); break;
      case 'spawn': {
        const side: Faction = m.side === 'ins' ? 'ins' : 'us', kit = kitById(String(m.kit));
        if (px) g.remove(px);
        if (!p.botTaken || p.side !== side) { if (this.D.takeBot(side)) p.botTaken = true; }
        p.side = side;
        const pos = (m.pos as V3) ?? [0, 0, 0];
        const s = g.spawn(kit, side, pos, p.name, Number(m.yaw ?? 0));
        s.netProxy = true; p.proxy = s; p.lastLife = '';
        send(l, { t: 'spawned', nid: s.id });
        break;
      }
      case 'fire': if (px?.alive) { px.lastShotT = g.time; this.peerShot = true; try { g.proj.fire(px, null, String(m.a), m.o as V3, m.d as V3, !!m.tr); } finally { this.peerShot = false; } } break;
      case 'throw': if (px?.alive) g.proj.throwItem(px, m.a as 'frag' | 'smoke' | 'c4', m.o as V3, m.v as V3, Number(m.f ?? 4)); break;
      case 'charge': if (px?.alive) g.placeCharge(px, m.p as V3, String(m.a)); break;
      case 'det': if (px) g.detonate(px); break;
      case 'reload': if (px?.alive) g.reload(px); break;
      case 'bandage': if (px) px.startBandage(); break;
      case 'giveup': if (px && px.state === 'wounded') px.die(px.killedBy); break;
      case 'door': { const i = Number(m.i), o = Number(m.o); g.doors?.setState(i, o, false); this.events.push({ t: 'door', i, o, r: 0 }); break; }
      case 'pick': {
        const k = g.pickups.find((x) => x.id === Number(m.id));
        if (!px?.alive || !k) { send(l, { t: 'gotno' }); break; }
        const at = k.obj.getWorldPosition(new THREE.Vector3());
        // (Bodies fall as separate ragdolls on each machine, so a weapon lies a little differently here: a loose check.)
        if (Math.hypot(at.x - px.pos[0], at.z - px.pos[2]) > 6) { send(l, { t: 'gotno' }); break; }
        // His weapon as it really is (ammunition counted on his machine) goes down in its place.
        const mine = m.cur ? slotOf(m.cur as SlotMsg) : null;
        if (mine) { const i = px.slots.findIndex((x) => x.def.id === mine.def.id); if (i >= 0) { px.slots[i] = mine; px.cur = i; } }
        const got = k.slot;
        g.pickUp(px, k);
        send(l, { t: 'got', slot: slotMsg(got) });
        break;
      }
      case 'chat': this.D.mode.say(`${p.name}: ${String(m.text ?? '').slice(0, 120)}`, p.side); break;
      // ---- vehicles ----
      case 'seat': {
        const v = g.vehicles[Number(m.v)], i = Number(m.i); if (!px?.alive || !v || v.dead) break;
        const st = v.seats[i]; if (!st) break;
        if (st.who && st.who !== px) {
          // An AI crewman makes room (to the seat the player leaves, or out); another player's seat is refused.
          const ai = st.who;
          if (ai.isPlayer || ai.netProxy) { send(l, { t: 'seatno', why: 'Seat taken' }); break; }
          const cur = v.seatOf(px), free = cur >= 0 ? cur : v.seats.findIndex((x, k) => !x.who && k !== i && (!x.def.crew || ai.kit.role === 'crew'));
          v.exit(ai, false); if (cur >= 0) v.seats[cur].who = null;
          if (px.vehicle && px.vehicle !== v) px.vehicle.exit(px, false);
          v.enter(px, i);
          if (free >= 0) v.enter(ai, free); else v.exit(ai, true);
        } else { if (px.vehicle && px.vehicle !== v) px.vehicle.exit(px, false); if (!v.enter(px, i)) send(l, { t: 'seatno', why: 'Cannot get in' }); }
        break;
      }
      case 'exit': if (px?.vehicle) px.vehicle.exit(px, true); break;
      case 'vc': {
        const v = px?.vehicle; if (!v) break;
        const role = v.seats[v.seatOf(px!)]?.def.role;
        if (role === 'driver') { v.throttle = clampN(m.th, -1, 1); v.steer = clampN(m.st, -1, 1); }
        if (role === 'gunner') { v.aimYaw = Number(m.ay) || 0; v.aimPitch = Number(m.ap) || 0; }
        const mt = v.mountsOf(v.seatOf(px!))[0];
        if (mt?.def.station) { mt.aimYaw = Number(m.sy) || 0; mt.aimPitch = Number(m.sp) || 0; }
        break;
      }
      case 'vfire': { const v = px?.vehicle, mt = v?.mounts[Number(m.m)]; if (v && mt && v.mountsOf(v.seatOf(px!)).includes(mt)) { this.peerShot = true; try { v.fire(mt, v.seatOf(px!)); } finally { this.peerShot = false; } } break; }
      case 'vammo': { const v = px?.vehicle, mt = v?.mounts[Number(m.m)]; if (v && mt) v.selectAmmo(mt, Number(m.k)); break; }
      case 'lase': { const v = px?.vehicle; if (v) { const r = v.lase(); send(l, { t: 'range', r }); } break; }
      case 'smoke': { const v = px?.vehicle; if (v) v.popSmoke(); break; }
    }
  }

  /** A player's own movement: his stand-in follows. */
  private onMove(l: Link, data: ArrayBuffer) {
    const p = this.peers.get(l.id), s = p?.proxy, m = decodeMove(data);
    if (!s || !m || s.state === 'dead' || s.vehicle) return;
    s.pos = [m.x, m.y, m.z]; s.vel = [m.vx, 0, m.vz]; s.yaw = m.yaw; s.pitch = m.pitch;
    s.moving = Math.hypot(m.vx, m.vz); s.onGround = true;
    if (s.alive) {
      const st = STANCES[m.stance] ?? 'stand'; if (st !== s.stance) s.setStance(st, this.D.game.time);
      s.aiming = m.aiming; s.ads = m.ads; s.sprinting = m.sprinting; s.underSel = m.underSel; s.light = m.light; s.leanWant = m.lean; s.lean = m.lean;
      if (m.cur !== s.cur && m.cur < s.slots.length) { s.cur = m.cur; s.reloadT = 0; }
    }
    s.body.setNextKinematicTranslation({ x: m.x, y: m.y + 0.3 + (s.stance === 'stand' ? 0.6 : s.stance === 'crouch' ? 0.28 : 0), z: m.z });
  }

  update(dt: number) {
    const g = this.D.game;
    // Joins and leaves of soldiers (players spawning, bots reinforcing, bodies cleared).
    const now = new Set(g.soldiers.map((s) => s.id));
    for (const s of g.soldiers) if (!this.known.has(s.id)) { this.known.add(s.id); this.events.push({ t: 'add', ...this.rosterEntry(s) }); }
    for (const id of this.known) if (!now.has(id)) { this.known.delete(id); this.events.push({ t: 'del', s: id }); }
    // The mode's log (kills, intel, caches, joins).
    const log = this.D.mode.log;
    if (log.length < this.logN) this.logN = 0;
    for (; this.logN < log.length; this.logN++) this.events.push({ t: 'log', text: log[this.logN].text, team: log[this.logN].team });
    // Each player's own life (the host decides hits, bleeding, wounds and deaths).
    for (const p of this.peers.values()) {
      const s = p.proxy; if (!s) continue;
      const key = `${s.state}|${Math.round(s.health)}|${s.bleed.toFixed(1)}|${s.bandages}`;
      if (key !== p.lastLife) { p.lastLife = key; send(p.link, { t: 'you', st: s.state, h: s.health, b: s.bleed, bd: s.bandages, by: s.killedBy?.name ?? '', sp: s.suppress }); }
    }
    // Events out, about 20 times a second (a player's own shots are not echoed back to him).
    if ((this.evT += dt) >= 0.05 && this.events.length) {
      this.evT = 0;
      const evs = this.events; this.events = [];
      for (const p of this.peers.values()) {
        const own = p.proxy?.id;
        const mine = evs.filter((e) => !(own !== undefined && e.s === own && ((e.t === 'shot' && e.x) || e.t === 'throw' || e.t === 'charge')));
        if (mine.length) { const msg = { t: 'ev', e: mine }; send(p.link, msg); this.bytes += JSON.stringify(msg).length; }
      }
    }
    // Guided missiles in flight: position and velocity (~10 Hz) for the players' copies.
    if ((this.mslT += dt) >= 0.1 && this.missiles.size) {
      this.mslT = 0;
      for (const [id, b] of this.missiles) { if (!g.proj.bullets.includes(b)) { this.missiles.delete(id); continue; } this.events.push({ t: 'msl', id, p: r3(b.p), v: r3(b.v) }); }
    }
    // Snapshots.
    if ((this.snapT += dt) >= 1 / SNAP_HZ) {
      this.snapT = 0;
      const vrecs: VehicleRec[] = g.vehicles.map((v, i) => {
        const t = v.body.translation(), q = v.body.rotation(), st = v.mounts.find((m) => m.def.station);
        return { idx: i, x: t.x, y: t.y, z: t.z, q: [q.x, q.y, q.z, q.w], turretYaw: v.turretYaw, gunPitch: v.gunPitch, stYaw: st ? Math.atan2(Math.sin(st.yaw), Math.cos(st.yaw)) : 0, stPitch: st ? st.pitch : 0, dead: v.dead, burning: v.burning };
      });
      for (const p of this.peers.values()) {
        const me = p.proxy, c = me ? me.pos : null, recs: SoldierRec[] = [];
        for (const s of g.soldiers) {
          if (s === me) continue;
          if (c && Math.hypot(s.pos[0] - c[0], s.pos[2] - c[2]) > NEAR && s.state === 'alive') continue;
          recs.push(rec(s));
        }
        const buf = encodeSnapshot(g.time, recs, vrecs);
        sendU(p.link, buf); this.bytes += buf.byteLength;
      }
    }
    // Mode status and spawn points (once a second); lobby heartbeat (every 25 s, see beat()).
    if ((this.modeT += dt) >= 1) {
      this.modeT = 0;
      const msg = { t: 'mode', top: this.D.mode.hudTop(), over: this.D.mode.over, tl: this.D.mode.timeLeft, spawns: { us: this.D.spawnPoints('us'), ins: this.D.spawnPoints('ins') }, score: g.soldiers.map((s) => [s.id, s.kills, s.deaths]) };
      for (const p of this.peers.values()) send(p.link, msg);
    }
    // A player in a vehicle: its ammunition and readiness, for his panel (4 Hz).
    if ((this.vstT += dt) >= 0.25) {
      this.vstT = 0;
      for (const p of this.peers.values()) {
        const v = p.proxy?.vehicle; if (!v) continue;
        const seat = v.seatOf(p.proxy!);
        send(p.link, { t: 'vst', v: g.vehicles.indexOf(v), m: v.mounts.map((mt) => [mt.sel, mt.loaded ? 1 : 0, mt.loadedType, mt.belt, mt.ready, mt.stowed, v.mountsOf(seat).includes(mt) ? v.blocked(mt, seat) : null]), sm: v.smoke, i: Math.round(v.integrity), tr: v.tracked ? 1 : 0, eo: v.engineOut ? 1 : 0 });
      }
    }
    // Real time, not game time: a struggling host's game clock crawls (dt is clamped), and the lobby forgets a host that
    // has not beaten for 75 s of real time.
    const wall = performance.now();
    if (wall - this.beatAt >= (this.holding ? 25000 : 5000)) { this.beatAt = wall; void this.beat(); }
    if ((this.rateT += dt) >= 1) { this.rate = this.bytes / this.rateT; this.bytes = 0; this.rateT = 0; }
  }

  close() { this.links.close(); void closeLobby(this.D.myId); }
}

function rec(s: Soldier): SoldierRec {
  return {
    nid: s.id, x: s.pos[0], y: s.pos[1], z: s.pos[2], yaw: s.yaw, pitch: s.pitch, vx: s.vel[0], vz: s.vel[2],
    stance: Math.max(0, STANCES.indexOf(s.stance)), aiming: s.aiming || s.ads > 0.3, sprinting: s.sprinting, underSel: s.underSel, inVeh: !!s.vehicle, light: s.light,
    life: Math.max(0, LIFE.indexOf(s.state as typeof LIFE[number])), cur: s.cur, reloadEmpty: s.reloadEmpty, ads: s.ads,
    reload: s.reloadT > 0 && s.reloadDur > 0 ? 1 - s.reloadT / s.reloadDur : 0, lean: s.lean,
  };
}
const clampN = (v: unknown, a: number, b: number) => Math.max(a, Math.min(b, Number(v) || 0));
const r3 = (v: V3 | number[]): V3 => [Math.round(v[0] * 1000) / 1000, Math.round(v[1] * 1000) / 1000, Math.round(v[2] * 1000) / 1000];
const r4 = (v: V3 | number[]): V3 => [Math.round(v[0] * 1e5) / 1e5, Math.round(v[1] * 1e5) / 1e5, Math.round(v[2] * 1e5) / 1e5];
void THREE;

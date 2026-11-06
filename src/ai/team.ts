// Team brains: small-unit tactics on top of the individual bots (ai/bot.ts), after FM 3-21.8 / FM 3-06.11, Squad and
// Six Days in Fallujah (docs/RESEARCH.md §AI).
//
// US fireteam (Fireteam): travels in a wedge behind its leader (the player when on the team), or in file when the way
// narrows (members walk the leader's trail). On contact everybody returns fire from cover for a few seconds (react),
// then the team splits: the base of fire (automatic rifleman + one) keeps the enemy's heads down with sustained
// bursts at the last known position while the maneuver element runs a covered route round the flank (60–90° off the
// line of fire). When the maneuver element is close, the base lifts or shifts its fire and the maneuver assaults:
// grenade first, then in. After the fight the team searches the area and moves on.
//
// Insurgent cell (Cell): hides in houses at windows that look onto the US approach, below the sills, peeking now and
// then. The ambush is sprung when the Americans walk into the kill zone (or someone is hit or seen up close): then
// everybody fires at once. Fighters shoot and scoot — after a few bursts from one window they move to another — and
// one or two stalk round the flank. When the cell is losing (half down, or the Americans at the door) it falls back
// to the next house away from them and sets up again. A cell that hears nothing for a long time goes hunting.
//
// Both sides fight from buildings (Brain.overwatch): windows on every floor and roof spots of nearby houses that face
// the enemy and can see out to him, higher posts preferred. The cell spreads over several houses and moves between them;
// the US base of fire climbs to an overwatch window before suppressing, and the maneuver element flanks into a house.
import type { Game } from '../game/game';
import type { Soldier } from '../game/soldier';
import type { Faction } from '../game/data/kits';
import type { V3 } from '../game/projectiles';
import type { Nav } from './nav';
import type { Bot } from './bot';
import type { BuildingInfo } from '../world/building';

const flat = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[2] - b[2]);
/** A firing position: navmesh point, facing (yaw), at a window (fire over the sill), building id (-1 outside), floor. */
interface Post { p: V3; face: number; window: boolean; b: number; floor: number }
const yawTo = (a: V3, b: V3) => Math.atan2(-(b[0] - a[0]), -(b[2] - a[2]));

/** Shared helpers for both brains. */
abstract class Brain {
  /** Radio log for the player's team ("Contact front!", …). */
  say: (text: string) => void = () => undefined;
  state = '';
  stateT = 0;
  constructor(protected g: Game, protected nav: Nav | null, public team: Faction, public bots: Bot[]) {}

  protected alive() { return this.bots.filter((b) => b.s.alive); }
  protected members(): Soldier[] { return this.g.soldiers.filter((s) => s.team === this.team && s.alive); }
  protected enemies(): Soldier[] { return this.g.soldiers.filter((s) => s.team !== this.team && s.alive); }
  protected set(state: string) { if (state !== this.state) { this.state = state; this.stateT = 0; } }
  protected centroid(): V3 {
    const m = this.members(); if (!m.length) return [0, 0, 0];
    return [m.reduce((a, s) => a + s.pos[0], 0) / m.length, m.reduce((a, s) => a + s.pos[1], 0) / m.length, m.reduce((a, s) => a + s.pos[2], 0) / m.length];
  }
  /** Freshest knowledge of a living enemy: the team's contact reports (spotted, or heard firing at us). */
  protected known(maxAge: number): { p: V3; t: number; id: number } | null {
    let best: { p: V3; t: number; id: number } | null = null;
    for (const [id, c] of this.g.contacts[this.team]) {
      if (this.g.time - c.t > maxAge) continue;
      const e = this.g.soldiers.find((s) => s.id === id);
      // Soldiers see the man they shot go down: a downed enemy is no longer a threat.
      if (!e || e.state !== 'alive') { this.g.contacts[this.team].delete(id); continue; }
      if (!best || c.t > best.t) best = { p: c.p, t: c.t, id };
    }
    // Gunfire heard by a member counts as a (vague) contact.
    for (const b of this.alive()) { const h = b.s.heard; if (h && this.g.time - h.t <= maxAge && (!best || h.t > best.t + 2)) best = { p: [h.p[0], h.p[1] - 1.5, h.p[2]], t: h.t, id: -1 }; }
    return best;
  }
  protected hitRecently(sec: number) { return this.members().some((s) => this.g.time - s.lastHitT < sec); }
  /** Nearest navmesh point, or the point itself. */
  protected snap(p: V3, r = 4): V3 { return this.nav?.closest(p, r) ?? p; }

  /**
   * Firing posts in the houses near `center` that look towards `threat`: windows on every floor and roof spots, on the
   * navmesh, with a sight line out to the threat area. Best first: higher floors (overwatch), facing the threat, at a
   * fighting distance.
   */
  protected overwatch(center: V3, threat: V3, radius = 40, maxHouses = 5): Post[] {
    const g = this.g, area = (g.mode as { area?: { x0: number; z0: number; x1: number; z1: number } } | null)?.area;
    const tx = threat[0] - center[0], tz = threat[2] - center[2], tl = Math.hypot(tx, tz) || 1;
    const dc = (b: BuildingInfo) => Math.hypot((b.spec.x0 + b.spec.x1) / 2 - center[0], (b.spec.z0 + b.spec.z1) / 2 - center[2]);
    const houses = g.city.buildings.filter((b) => {
      const cx = (b.spec.x0 + b.spec.x1) / 2, cz = (b.spec.z0 + b.spec.z1) / 2;
      if (area && (cx < area.x0 || cx > area.x1 || cz < area.z0 || cz > area.z1)) return false;
      return dc(b) < radius;
    }).sort((a, b) => dc(a) - dc(b)).slice(0, maxHouses);
    const aim: V3 = [threat[0], threat[1] + 1.2, threat[2]];
    const scored: { q: Post; sc: number }[] = [];
    for (const h of houses) {
      for (const w of h.windows) {
        const facing = (w.nx * tx + w.nz * tz) / tl;
        if (facing < 0.2) continue;
        const p = this.nav?.closest([w.x, w.y + 0.2, w.z], 0.8);
        if (!p || Math.abs(p[1] - w.y) > 0.6) continue;
        // Out through the window to the threat (the eye just inside the opening, standing at the sill).
        if (!g.P.clear([w.x - w.nx * 0.15, w.y + 1.45, w.z - w.nz * 0.15], aim)) continue;
        const d = flat(p, threat);
        scored.push({ q: { p, face: Math.atan2(-w.nx, -w.nz), window: true, b: h.id, floor: w.floor }, sc: w.floor * 4 + facing * 3 - Math.abs(d - 45) * 0.08 });
      }
      // Roofs (behind the parapet): good fields of fire but exposed - ranked like a window one floor down.
      for (const r of h.roof) {
        const p = this.nav?.closest(r, 0.8);
        if (!p || Math.abs(p[1] - r[1]) > 0.6) continue;
        if (!g.P.clear([p[0], p[1] + 1.5, p[2]], aim)) continue;
        const d = flat(p, threat);
        scored.push({ q: { p, face: yawTo(p, threat), window: false, b: h.id, floor: h.spec.floors }, sc: h.spec.floors * 3 + 1 - Math.abs(d - 45) * 0.08 });
      }
    }
    return scored.sort((a, b) => b.sc - a.sc).map((x) => x.q);
  }
  /** Building whose footprint contains p (with a margin), if any. */
  protected buildingAt(p: V3, margin = 0.5): BuildingInfo | null {
    for (const b of this.g.city.buildings) { const sp = b.spec; if (p[0] > sp.x0 - margin && p[0] < sp.x1 + margin && p[2] > sp.z0 - margin && p[2] < sp.z1 + margin) return b; }
    return null;
  }
  abstract update(dt: number): void;
}

// ====================================================================================================== US fireteam
export class Fireteam extends Brain {
  /** Where the team is going (enemy zone, then the last known enemy). */
  objective: V3;
  private trail: V3[] = [];
  private base: Bot[] = []; private maneuver: Bot[] = [];
  private flankTo: V3 | null = null;
  /** Overwatch posts (windows / roofs) taken by the base of fire, by soldier id. */
  private basePost = new Map<number, V3>();
  private enemyAt: V3 | null = null; private enemyT = 0;
  private legT = 0; private leg: V3 | null = null;
  /** The player's standing order to the team (Six Days in Fallujah-style): form up on me, hold, or move to a point;
   *  and a timed suppression order on a point. */
  private cmd: { kind: 'follow' | 'hold' | 'move'; p?: V3 } = { kind: 'follow' };
  private suppressAt: V3 | null = null; private suppressUntil = 0;
  /** Room clearing (FM 3-06.11): the stack outside a doorway, the grenade, then the flow into the room. */
  private breach: { b: BuildingInfo; door: V3; out: [number, number]; along: [number, number]; side: number; phase: 'stack' | 'bang' | 'flow' | 'clear'; t: number; team: Bot[]; corners: V3[]; rooms: BuildingInfo['rooms']; bang: boolean } | null = null;
  /** Clearing a building on the director's plan (house-to-house), rather than assaulting a contact. */
  clearing: BuildingInfo | null = null;

  /** Player order: 'move' / 'suppress' need the point aimed at; 'hold' toggles hold ↔ form up. */
  command(kind: 'move' | 'hold' | 'suppress', p?: V3) {
    if (kind === 'suppress' && p) { this.suppressAt = p; this.suppressUntil = this.g.time + 12; this.say('Suppressing!'); return; }
    if (kind === 'move' && p) { this.cmd = { kind: 'move', p: this.snap(p, 4) }; this.say('Moving!'); }
    else if (kind === 'hold') { this.cmd = this.cmd.kind === 'hold' ? { kind: 'follow' } : { kind: 'hold' }; this.say(this.cmd.kind === 'hold' ? 'Holding here.' : 'Forming up on you.'); }
    if (this.state !== 'react' && this.state !== 'fix' && this.state !== 'assault') this.set('move');
  }

  constructor(g: Game, nav: Nav | null, team: Faction, bots: Bot[], objective: V3) { super(g, nav, team, bots); this.objective = objective; this.state = 'move'; }

  /** The player leads this fireteam (false for squads the player is not in). */
  playerLed = true;
  /** The player leads when in this fireteam; otherwise the leader kit, else the first bot standing. */
  leader(): Soldier | null {
    const p = this.playerLed ? this.g.soldiers.find((s) => s.isPlayer && s.team === this.team && s.alive) : null;
    if (p) return p;
    // Bot-led: the member furthest forward (towards the objective) leads, the squad leader kit preferred by 40 m — a
    // reinforcement just respawned at the FOB must not pull the whole squad back to him.
    const a = this.alive(); if (!a.length) return null;
    const score = (b: Bot) => flat(b.s.pos, this.objective) - (b.s.kit.leader ? 40 : 0);
    return a.reduce((x, y) => (score(y) < score(x) ? y : x)).s;
  }

  update(dt: number) {
    const g = this.g, L = this.leader(); if (!L) return;
    this.stateT += dt;
    // Leader's trail (for the file when the street narrows or the leader goes indoors).
    const last = this.trail[this.trail.length - 1];
    if (!last || flat(last, L.pos) > 1.2) { this.trail.push([...L.pos]); if (this.trail.length > 40) this.trail.shift(); }
    const k = this.known(25);
    if (k) { this.enemyAt = k.p; this.enemyT = k.t; }
    const fresh = !!k && g.time - k.t < 4;
    const anySees = this.alive().some((b) => b.target);

    // A suppression order overrides everything for its duration (the base of fire the player asked for).
    if (this.suppressAt && g.time < this.suppressUntil) { for (const b of this.alive()) b.setTask({ kind: 'suppress', p: null, at: this.suppressAt }); return; }
    switch (this.state) {
      case 'move': {
        if (anySees || this.hitRecently(1.5) || (fresh && flat(k!.p, L.pos) < 120)) { this.contact(); break; }
        if (L.isPlayer && this.cmd.kind === 'hold') { for (const b of this.alive()) if (b.task?.kind !== 'hold') b.setTask({ kind: 'hold', p: [...b.s.pos], face: L.yaw }); }
        else if (L.isPlayer && this.cmd.kind === 'move') {
          const bots = this.alive();
          bots.forEach((b) => b.setTask({ kind: 'move', p: this.offsetFor(this.cmd.p!, b), run: flat(b.s.pos, this.cmd.p!) > 15 }));
          if (bots.every((b) => b.taskDone)) this.cmd = { kind: 'hold' };
        } else this.travel(dt, L);
        break;
      }
      case 'react': {
        // Everybody fights from where they are (cover, return fire) — no tasks.
        for (const b of this.alive()) b.setTask(null);
        if (this.stateT > 3.5) {
          if (this.enemyAt && g.time - this.enemyT < 15) this.planFlank(L);
          else if (this.stateT > 10) this.set('move');
        }
        break;
      }
      case 'fix': {
        const e = this.enemyAt!;
        const man = this.maneuver.filter((b) => b.s.alive), base = this.base.filter((b) => b.s.alive);
        if (!man.length) { this.set('react'); break; }
        for (const b of base) b.setTask({ kind: 'suppress', p: this.basePost.get(b.s.id) ?? null, at: e });
        for (const b of man) b.setTask({ kind: 'move', p: this.offsetFor(this.flankTo!, b), run: true });
        const arrived = man.every((b) => b.taskDone || flat(b.s.pos, e) < 20);
        if (arrived || this.stateT > 35) { this.set('assault'); this.say('Maneuver set — assaulting!'); }
        if (g.time - this.enemyT > 20) this.search();
        break;
      }
      case 'assault': {
        const e = this.enemyAt!;
        const man = this.maneuver.filter((b) => b.s.alive), base = this.base.filter((b) => b.s.alive);
        for (const b of man) b.setTask({ kind: 'assault', at: e });
        // Shift / lift fire: the base stops shooting at the objective once the maneuver element is near it or in
        // its line of fire, and covers from where it is instead.
        for (const b of base) {
          const inLine = man.some((m) => { const a1 = yawTo(b.s.pos, e), a2 = yawTo(b.s.pos, m.s.pos); return Math.abs(Math.atan2(Math.sin(a1 - a2), Math.cos(a1 - a2))) < 0.3 || flat(m.s.pos, e) < 12; });
          b.setTask(inLine ? { kind: 'hold', p: [...b.s.pos], face: yawTo(b.s.pos, e) } : { kind: 'suppress', p: this.basePost.get(b.s.id) ?? null, at: e });
        }
        if (!man.length) { this.set('react'); break; }
        // Enemy inside a house and the assault element close: stack on its door and clear it.
        const inside = this.buildingAt(e, -0.3);
        if (inside && man.some((b) => flat(b.s.pos, e) < 30) && this.planBreach(inside, man)) break;
        if (man.every((b) => b.taskDone) && g.time - this.enemyT > 5) this.search();
        else if (g.time - this.enemyT > 25) this.search();
        break;
      }
      case 'breach': {
        if (this.clearing && (this.hitRecently(1) || (anySees && !this.breach?.team.some((b) => b.target)))) { this.breach = null; this.clearing = null; this.contact(); break; }
        this.runBreach(dt); break;
      }
      case 'search': {
        if (anySees || this.hitRecently(1.5) || fresh) { this.contact(); break; }
        if (this.alive().every((b) => b.taskDone) || this.stateT > 40) { this.objective = this.enemyAt ?? this.objective; this.enemyAt = null; this.set('move'); this.say('Area clear, moving on.'); }
        break;
      }
    }
  }

  private contact() {
    this.set('react');
    const L = this.leader(), e = this.enemyAt;
    if (L && e) {
      const a = yawTo(L.pos, e) - L.yaw, rel = Math.atan2(Math.sin(a), Math.cos(a));
      const dir = Math.abs(rel) < 0.6 ? 'front' : Math.abs(rel) > 2.4 ? 'rear' : rel > 0 ? 'left' : 'right';
      this.say(`Contact ${dir}, ${Math.round(flat(L.pos, e) / 10) * 10} metres!`);
    } else this.say('Contact!');
  }

  /** Wedge slots in the leader's frame (right, back): AR left rear, grenadier right rear, rifleman further out. */
  private static WEDGE: [number, number][] = [[-4, 4], [4, 4], [-8, 8], [8, 8]];
  private travel(dt: number, L: Soldier) {
    const g = this.g, bots = this.alive();
    const fx = -Math.sin(L.yaw), fz = -Math.cos(L.yaw), rx = -fz, rz = fx;
    // Indoors or in a narrow street (a wedge slot is off the navmesh) the team goes in file along the leader's trail.
    const tight = !!this.buildingAt(L.pos, -0.3);
    let i = 0;
    for (const b of bots) {
      if (b.s === L) continue;
      const [r, back] = Fireteam.WEDGE[i % 4];
      let slot: V3 = [L.pos[0] + rx * r - fx * back, L.pos[1], L.pos[2] + rz * r - fz * back];
      const sn = this.nav?.closest(slot, 1.5);
      if (tight || !sn || flat(sn, slot) > 1.2 || Math.abs(sn[1] - L.pos[1]) > 1.5) {
        const j = Math.max(0, this.trail.length - 3 - i * 3);
        slot = this.trail[j] ?? L.pos;
      } else slot = sn;
      // Sectors: left-side men watch left, right-side men watch right, the last man the rear.
      const face = L.yaw + (i === 3 ? Math.PI : r < 0 ? 0.7 : -0.7);
      b.setTask({ kind: 'slot', p: slot, face });
      i++;
    }
    // A bot leader walks the team towards the objective in legs of ~25 m, waiting for stragglers.
    const lb = bots.find((b) => b.s === L);
    if (lb) {
      this.legT -= dt;
      const spread = Math.max(0, ...bots.map((b) => flat(b.s.pos, L.pos)));
      if (!this.leg || flat(this.leg, L.pos) < 2 || this.legT <= 0) {
        const path = this.nav?.path(L.pos, this.objective);
        this.leg = path ? path[Math.min(path.length - 1, path.findIndex((p) => flat(p, L.pos) > 22) >= 0 ? path.findIndex((p) => flat(p, L.pos) > 22) : path.length - 1)] : this.objective;
        this.legT = 12;
      }
      if (spread > 14) lb.setTask({ kind: 'slot', p: [...L.pos], face: yawTo(L.pos, this.objective) });
      else lb.setTask({ kind: 'move', p: this.leg, run: false });
      if (flat(L.pos, this.objective) < 6) { this.search(); }
    }
    void g;
  }

  /** Split into base of fire and maneuver element and pick the flanking point. */
  private planFlank(L: Soldier) {
    const bots = this.alive(), e = this.enemyAt!;
    if (!bots.length) return;
    // Base of fire: the automatic rifleman first, then whoever has the enemy in sight. Maneuver: the rest
    // (with the player as leader, all bots but the AR can flank: the player is part of the base by default).
    const ar = bots.filter((b) => b.s.kit.role === 'ar' || b.s.kit.role === 'mg');
    const rest = bots.filter((b) => !ar.includes(b)).sort((a, b) => (a.target ? 0 : 1) - (b.target ? 0 : 1));
    const nBase = Math.max(0, Math.min(rest.length - 1, bots.length >= 4 ? 1 : 0));
    this.base = [...ar, ...rest.slice(0, nBase)];
    this.maneuver = rest.slice(nBase);
    if (!this.maneuver.length) { this.maneuver = this.base.splice(this.base.length - 1, 1); }
    if (!this.maneuver.length || bots.length < 2) { this.base = []; this.maneuver = bots; this.set('assault'); this.say('Assaulting!'); return; }
    // Flank point: 60–90° off the line from the team to the enemy, ~16 m from the enemy; the side with the shorter
    // walk wins (a wall in the way shows up as a long or failed path).
    const c = this.centroid(), dx = c[0] - e[0], dz = c[2] - e[2], d = Math.hypot(dx, dz) || 1, ux = dx / d, uz = dz / d;
    let best: { p: V3; len: number } | null = null;
    for (const side of [1, -1]) for (const ang of [1.2, 1.0, 1.45]) {
      const ca = Math.cos(ang * side), sa = Math.sin(ang * side), R = Math.min(18, d * 0.8);
      const p = this.snap([e[0] + (ux * ca - uz * sa) * R, e[1], e[2] + (ux * sa + uz * ca) * R], 5);
      const path = this.nav?.path(this.maneuver[0].s.pos, p);
      if (this.nav && (!path || flat(path[path.length - 1], p) > 2)) continue;
      const len = path ? path.reduce((a, q, i) => a + (i ? flat(q, path[i - 1]) : 0), 0) : flat(p, c);
      if (!best || len < best.len) best = { p, len };
      break;
    }
    if (!best) { this.base = []; this.maneuver = bots; this.set('assault'); this.say('Assaulting!'); return; }
    // Flank into a house when there is one by the flank point with a window or roof onto the enemy (higher ground).
    const inHouse = this.overwatch(best.p, e, 16, 2).find((q) => flat(q.p, e) > 10 && flat(q.p, best!.p) < 16);
    this.flankTo = inHouse ? inHouse.p : best.p;
    // Base of fire: an overwatch window or roof near where it is (reachable within ~45 m), else from where it stands.
    this.basePost.clear();
    const bc: V3 = this.base.length ? [this.base[0].s.pos[0], this.base[0].s.pos[1], this.base[0].s.pos[2]] : c;
    const posts = this.overwatch(bc, e, 30, 4).filter((q) => flat(q.p, e) > 15 && flat(q.p, e) < 120);
    const used = new Set<Post>();
    for (const b of this.base) {
      if (b.s.isPlayer) continue;
      const q = posts.find((x) => !used.has(x) && flat(x.p, b.s.pos) < 35);
      if (!q) continue;
      const path = this.nav?.path(b.s.pos, q.p);
      const len = path ? path.reduce((a, pt, i) => a + (i ? flat(pt, path[i - 1]) : 0), 0) : flat(q.p, b.s.pos);
      if (this.nav && (!path || len > 45)) continue;
      used.add(q); this.basePost.set(b.s.id, q.p);
    }
    this.set('fix');
    const who = this.base.map((b) => b.s.name.split(' ').pop()).join(' and ');
    this.say(`${who || 'Base'}: ${this.basePost.size ? 'get up high and ' : ''}suppress! ${this.maneuver.map((b) => b.s.name.split(' ').pop()).join(', ')}: flank ${inHouse ? 'through that house' : 'round the side'}!`);
    void L;
  }

  /**
   * Plan a room clearing: the exterior doorway of the house nearest the team; stack points along the wall on the near
   * side of it; entry points in the room behind it (the two corners along the entry wall, then the centre).
   */
  private planBreach(b: BuildingInfo, team: Bot[], bang = true): boolean {
    const c = this.centroid();
    const doors = b.doorways.filter((d) => d.exterior && d.floor === 0).sort((d1, d2) => flat([d1.x, 0, d1.z], c) - flat([d2.x, 0, d2.z], c));
    const d = doors[0]; if (!d) return false;
    // Every room, floor by floor, nearest the way in first (the stairwell takes the team up).
    const rooms = [...b.rooms].sort((r1, r2) => r1.floor - r2.floor || flat([(r1.x0 + r1.x1) / 2, 0, (r1.z0 + r1.z1) / 2], [d.x, 0, d.z]) - flat([(r2.x0 + r2.x1) / 2, 0, (r2.z0 + r2.z1) / 2], [d.x, 0, d.z]));
    this.breach = { b, door: [0, 0, 0], out: [0, 1], along: [1, 0], side: 1, phase: 'stack', t: 0, team: team.slice(0, 4), corners: [], rooms, bang };
    if (!this.nextRoom(d)) { this.breach = null; return false; }
    this.set('breach');
    this.say(this.clearing ? 'Stack up — clearing this house.' : 'Stack up on that door!');
    return true;
  }

  /**
   * Set up the entry into the next room on the list: its doorway (the given exterior one for the first room, else an
   * interior doorway on its boundary), the stack on the team's side, and the points of domination inside (the two
   * corners along the entry wall, then the middle). Returns false when no room is left.
   */
  private nextRoom(first?: BuildingInfo['doorways'][number]): boolean {
    const B = this.breach!, b = B.b, c = this.centroid();
    while (B.rooms.length) {
      const room = B.rooms[0];
      const onEdge = (d: BuildingInfo['doorways'][number]) => d.floor === room.floor && d.x > room.x0 - 0.6 && d.x < room.x1 + 0.6 && d.z > room.z0 - 0.6 && d.z < room.z1 + 0.6 &&
        (Math.min(Math.abs(d.x - room.x0), Math.abs(d.x - room.x1)) < 0.6 || Math.min(Math.abs(d.z - room.z0), Math.abs(d.z - room.z1)) < 0.6);
      const rc: V3 = [(room.x0 + room.x1) / 2, room.y, (room.z0 + room.z1) / 2];
      const d = first && onEdge(first) ? first : b.doorways.filter(onEdge).sort((d1, d2) => flat([d1.x, 0, d1.z], c) - flat([d2.x, 0, d2.z], c))[0];
      first = undefined;
      if (!d) {
        // No marked doorway (an open archway, the stair landing): walk in and take the corners.
        B.rooms.shift();
        B.door = rc; B.out = [0, 1]; B.along = [1, 0]; B.side = 1;
        B.corners = [this.snap([room.x0 + 0.8, room.y, room.z0 + 0.8], 1.5), this.snap([room.x1 - 0.8, room.y, room.z1 - 0.8], 1.5), this.snap(rc, 1.5)];
        B.phase = 'flow'; B.t = 0;
        return true;
      }
      B.rooms.shift();
      // Outward normal: across the wall, away from the room's centre.
      const n: [number, number] = d.axis === 'x' ? [0, Math.sign(d.z - rc[2]) || 1] : [Math.sign(d.x - rc[0]) || 1, 0];
      const along: [number, number] = d.axis === 'x' ? [1, 0] : [0, 1];
      const side = Math.sign((c[0] - d.x) * along[0] + (c[2] - d.z) * along[1]) || 1;
      const near = n[0] !== 0 ? (n[0] > 0 ? room.x1 - 0.7 : room.x0 + 0.7) : (n[1] > 0 ? room.z1 - 0.7 : room.z0 + 0.7);
      const a0 = (n[0] !== 0 ? room.z0 : room.x0) + 0.7, a1 = (n[0] !== 0 ? room.z1 : room.x1) - 0.7;
      const P = (u: number, v: number): V3 => n[0] !== 0 ? [v, d.y, u] : [u, d.y, v];
      // #1 crosses to the far side of the door, #2 hooks to the near side, #3 and #4 take the middle and the far wall.
      const far = side > 0 ? a0 : a1, nearSide = side > 0 ? a1 : a0;
      const deep = n[0] !== 0 ? (n[0] > 0 ? room.x0 + 0.9 : room.x1 - 0.9) : (n[1] > 0 ? room.z0 + 0.9 : room.z1 - 0.9);
      B.door = [d.x, d.y, d.z]; B.out = n; B.along = along; B.side = side;
      B.corners = [P(far, near), P(nearSide, near), rc, P((a0 + a1) / 2, deep)].map((p) => this.snap(p, 1.5));
      B.phase = 'stack'; B.t = 0;
      return true;
    }
    return false;
  }

  /** House-to-house: clear building b room by room (quiet entries unless the enemy is known to be inside). */
  clearBuilding(b: BuildingInfo): boolean {
    if (this.state === 'react' || this.state === 'fix' || this.state === 'assault' || this.state === 'breach') return false;
    const team = this.alive(); if (!team.length) return false;
    this.clearing = b;
    const ok = this.planBreach(b, team, false);
    if (!ok) this.clearing = null;
    return ok;
  }

  private runBreach(dt: number) {
    const B = this.breach!, team = B.team.filter((b) => b.s.alive), g = this.g;
    if (!team.length) { this.breach = null; this.set('react'); return; }
    B.t += dt;
    const d = B.door, n = B.out, a = B.along;
    switch (B.phase) {
      case 'stack': {
        // Against the wall outside, 0.9 m apart, facing the door.
        team.forEach((b, i) => {
          const off = B.side * (0.9 + i * 0.85);
          const p = this.snap([d[0] + a[0] * off + n[0] * 0.45, d[1], d[2] + a[1] * off + n[1] * 0.45], 1);
          b.setTask({ kind: 'hold', p, face: yawTo(p, [d[0] - n[0], d[1], d[2] - n[1]]) });
        });
        const set = team.every((b) => b.task?.kind === 'hold' && flat(b.s.pos, b.task.p) < 1);
        // Already inside and at the door (moving room to room): straight in.
        const inside = team.every((b) => flat(b.s.pos, d) < 4);
        if (set || B.t > 8 || (inside && B.t > 1)) { B.phase = 'bang'; B.t = 0; }
        break;
      }
      case 'bang': {
        // The number one throws a grenade into the room (when the enemy is known to be inside); everybody waits for the
        // bang. A quiet entry otherwise.
        const hot = B.bang || (this.enemyAt && g.time - this.enemyT < 30 && this.buildingAt(this.enemyAt, 0.3)?.id === B.b.id);
        if (!hot) { B.phase = 'flow'; B.t = 0; break; }
        if (B.t < dt * 1.5) { this.say('Frag out!'); team[0].fragInto([d[0] - n[0] * 3, d[1], d[2] - n[1] * 3]); }
        if (B.t > 5.2) { B.phase = 'flow'; B.t = 0; this.say('Go, go, go!'); }
        break;
      }
      case 'flow': {
        // One after another, ~0.7 s apart, each to his point of domination, shooting whatever shows.
        team.forEach((b, i) => { if (B.t > i * 0.7) b.setTask({ kind: 'move', p: B.corners[i % B.corners.length], run: true }); });
        if (team.every((b) => b.taskDone) || B.t > 8) {
          B.phase = 'clear'; B.t = 0;
          team.forEach((b, i) => b.setTask({ kind: 'hold', p: [...b.s.pos], face: yawTo(b.s.pos, B.corners[(i + 2) % B.corners.length]) }));
          this.say('Room clear!');
        }
        break;
      }
      case 'clear': {
        // Next room (interior doors, then up the stairs), until the whole house is clear.
        if (B.t > 1.5) {
          if (this.nextRoom()) { if ((B.phase as string) === 'stack') this.say(B.rooms.length ? 'Next room!' : 'Last room!'); break; }
          this.g.cleared[this.team].add(B.b.id);
          this.say('Building clear!');
          const was = this.clearing; this.breach = null; this.clearing = null;
          if (was) this.set('move'); else { this.enemyAt = [B.b.spots[0]?.[0] ?? d[0], B.b.spots[0]?.[1] ?? d[1], B.b.spots[0]?.[2] ?? d[2]]; this.search(); }
        }
        break;
      }
    }
    // Contact on the way in is fought by the bots themselves (their tasks shoot); a fresh hit outside resets.
    void g;
  }

  /** Spread members round a point so they do not stack on one spot. */
  private offsetFor(p: V3, b: Bot): V3 { const i = this.bots.indexOf(b); return this.snap([p[0] + (i % 2 ? 1.6 : -1.6), p[1], p[2] + (i % 3 - 1) * 1.6], 2); }

  private search() {
    const e = this.enemyAt ?? this.objective, bots = this.alive();
    const bld = this.buildingAt(e, 1.5);
    // Spots: the rooms of the building the enemy was in (lowest floors first), else points around the position.
    const spots: V3[] = bld ? [...bld.spots].sort((a, b) => a[3] - b[3]).slice(0, 8).map((p) => [p[0], p[1], p[2]] as V3) : [0, 1, 2, 3].map((i) => this.snap([e[0] + Math.cos(i * 1.57) * 6, e[1], e[2] + Math.sin(i * 1.57) * 6], 4));
    bots.forEach((b, i) => b.setTask({ kind: 'search', spots: spots.filter((_, j) => j % Math.max(1, bots.length) === i % Math.max(1, bots.length)).concat(spots.length ? [] : [e]) }));
    this.set('search');
  }
}

// ================================================================================================== Insurgent cell
export class Cell extends Brain {
  private posts: Post[] = [];
  private postOf = new Map<number, Post>();
  private stalkers = new Set<number>();
  private quietT = 0; private lostAt = 0; private home: V3; private threatFrom: V3;
  private relocateCheck = 0;
  /** Seconds before an unsprung ambush loses patience and goes hunting (Infinity: never, e.g. cache defenders). */
  patience = 90;
  /** Hunting only goes after enemies this close to the cell's home (m). */
  huntRange = Infinity;

  constructor(g: Game, nav: Nav | null, team: Faction, bots: Bot[], home: V3, threatFrom: V3) {
    super(g, nav, team, bots); this.home = home; this.threatFrom = threatFrom;
    this.setupAt(home);
    this.state = 'ambush';
  }

  /** Firing posts round a position: windows on every floor and roofs of the houses round it that see the threat. */
  private setupAt(center: V3) {
    const g = this.g;
    const tx = this.threatFrom[0] - center[0], tz = this.threatFrom[2] - center[2], tl = Math.hypot(tx, tz) || 1;
    const posts: Post[] = this.overwatch(center, this.threatFrom, 40, 5).slice(0, Math.max(8, this.bots.length * 3));
    // Low cover outside as a fallback (walls, cars) facing the threat.
    if (posts.length < this.bots.length && g.cover) for (const c of g.cover.near(center[0], center[2], 20)) {
      if (posts.length >= this.bots.length * 2) break;
      if ((c.n[0] * tx + c.n[1] * tz) / tl > -0.3) continue;
      posts.push({ p: c.p, face: Math.atan2(-tx, -tz), window: false, b: -1, floor: 0 });
    }
    this.posts = posts;
    this.postOf.clear();
    const bots = this.alive();
    // Spread the cell over different windows (and houses where possible).
    const used = new Set<Post>();
    bots.forEach((b, i) => {
      const free = posts.filter((q) => !used.has(q)).sort((a, c) => (a.b === bots[Math.max(0, i - 1)]?.s.id ? 1 : 0) - (c.b === bots[Math.max(0, i - 1)]?.s.id ? 1 : 0) + flat(a.p, b.s.pos) * 0.02 - flat(c.p, b.s.pos) * 0.02);
      const q = free[(i * 2) % Math.max(1, free.length)] ?? free[0];
      if (q) { used.add(q); this.postOf.set(b.s.id, q); }
    });
  }

  update(dt: number) {
    const g = this.g, bots = this.alive(); if (!bots.length) return;
    this.stateT += dt;
    const k = this.known(20), enemies = this.enemies();
    if (k) this.threatFrom = k.p;
    const nearest = (p: V3) => Math.min(...enemies.map((e) => flat(e.pos, p)), Infinity);
    switch (this.state) {
      case 'ambush': {
        for (const b of bots) { const q = this.postOf.get(b.s.id); b.setTask(q ? { kind: 'hold', p: q.p, face: q.face, ambush: true, window: q.window } : null); }
        // Spring it when they walk into the kill zone, someone is hit, an enemy is seen up close or we are fired on.
        const close = bots.some((b) => nearest(b.s.pos) < 32 && (b.target || nearest(b.s.pos) < 16));
        if (close || this.hitRecently(3) || bots.some((b) => g.time - b.s.lastShotT < 1) || bots.some((b) => b.target && nearest(b.s.pos) < 60 && b.s.suppress > 0.3)) { this.spring(); break; }
        if (this.stateT > this.patience) this.hunt();
        break;
      }
      case 'fight': {
        this.quietT = k && g.time - k.t < 6 ? 0 : this.quietT + dt;
        this.relocateCheck -= dt;
        for (const b of bots) {
          if (this.stalkers.has(b.s.id)) {
            // Stalkers: round the flank, then fight from there.
            const tgt = k ? k.p : this.threatFrom;
            if (!b.task || b.task.kind !== 'move' && b.task.kind !== 'assault' || b.taskDone) {
              if (b.task?.kind === 'move' && b.taskDone) b.setTask({ kind: 'assault', at: tgt });
              else if (!b.task || b.task.kind !== 'assault') b.setTask({ kind: 'move', p: this.flankPoint(b, tgt), run: true });
            }
            continue;
          }
          const q = this.postOf.get(b.s.id);
          if (!q) { b.setTask(null); continue; }
          b.sprung = true;
          b.setTask({ kind: 'hold', p: q.p, face: q.face, window: q.window });
          // Shoot and scoot: after ~8–12 s of shooting from one window, or when the fire there gets heavy, move on.
          if (this.relocateCheck <= 0 && (b.firingHere > 8 + (b.s.id % 5) || (b.s.suppress > 0.8 && b.firingHere > 3) || (g.time - b.s.lastHitT < 1 && b.firingHere > 1))) this.relocate(b);
        }
        if (this.relocateCheck <= 0) this.relocateCheck = 0.5;
        // Falling back: half the cell is down, or the Americans are at the door.
        const start = this.bots.length, down = start - bots.length;
        const atDoor = enemies.length >= 2 && bots.every((b) => nearest(b.s.pos) < 12);
        if ((down >= Math.ceil(start / 2) && this.lostAt < down) || atDoor) { this.lostAt = down; this.fallback(); break; }
        if (this.quietT > 30) this.hunt();
        break;
      }
      case 'fallback': {
        const arrived = bots.every((b) => !b.task || b.task.kind !== 'move' || b.taskDone);
        if (arrived || this.stateT > 20) { this.set('fight'); }
        break;
      }
      case 'hunt': {
        const inRange = enemies.filter((e) => flat(e.pos, this.home) < this.huntRange).sort((a, c) => flat(a.pos, this.home) - flat(c.pos, this.home));
        const kk = k && flat(k.p, this.home) < this.huntRange ? k : null;
        // Nobody to hunt near home: back to the posts and wait.
        if (!kk && !inRange.length) { this.setupAt(this.home); this.set('ambush'); break; }
        const tgt = kk ? kk.p : this.snap([inRange[0].pos[0] + (Math.random() - 0.5) * 16, inRange[0].pos[1], inRange[0].pos[2] + (Math.random() - 0.5) * 16], 6);
        for (const b of bots) if (!b.task || b.task.kind !== 'assault' || b.taskDone || this.stateT % 10 < dt) b.setTask({ kind: 'assault', at: tgt });
        if (bots.some((b) => b.target)) { this.setupAt(bots[0].s.pos); this.spring(); }
        break;
      }
    }
  }

  private spring() {
    this.set('fight');
    for (const b of this.alive()) b.sprung = true;
    // One or two of the cell (riflemen, not the RPK) go round the flank when the cell is big enough.
    this.stalkers.clear();
    const bots = this.alive(), riflemen = bots.filter((b) => b.s.kit.role === 'rifleman' && !b.s.isPlayer);
    if (bots.length >= 3 && riflemen.length) this.stalkers.add(riflemen[riflemen.length - 1].s.id);
    if (bots.length >= 5 && riflemen.length > 1) this.stalkers.add(riflemen[0].s.id);
    this.say('Open fire! Open fire!');
  }

  /** A point on the enemy's flank (perpendicular to the line from us to them), on the navmesh. */
  private flankPoint(b: Bot, tgt: V3): V3 {
    const dx = tgt[0] - b.s.pos[0], dz = tgt[2] - b.s.pos[2], d = Math.hypot(dx, dz) || 1, side = b.s.id % 2 ? 1 : -1;
    return this.snap([tgt[0] - (dx / d) * 10 + (-dz / d) * side * 16, tgt[1], tgt[2] - (dz / d) * 10 + (dx / d) * side * 16], 6);
  }

  /** Move a fighter to another free firing post: a few metres away, upstairs or in the next house. */
  private relocate(b: Bot) {
    const cur = this.postOf.get(b.s.id), taken = new Set(this.postOf.values());
    const cost = (q: Post) => flat(q.p, b.s.pos) - q.floor * 3 - (q.b !== cur?.b ? 2 : 0);
    const pick = () => this.posts.filter((q) => !taken.has(q) && flat(q.p, b.s.pos) > 2.5 && flat(q.p, b.s.pos) < 30).sort((a, c) => cost(a) - cost(c));
    let opts = pick();
    // The fight has moved: survey the houses round this fighter again.
    if (!opts.length) { this.posts.push(...this.overwatch(b.s.pos, this.threatFrom, 35, 4).filter((q) => !this.posts.some((o) => flat(o.p, q.p) < 0.5))); opts = pick(); }
    const q = opts[0]; if (!q) { b.firingHere = 0; return; }
    this.postOf.set(b.s.id, q);
    b.setTask({ kind: 'hold', p: q.p, face: q.face, window: q.window });
  }

  /** Withdraw to the nearest house further from the enemy and set up there. */
  private fallback() {
    const bots = this.alive(), c = this.centroid(), e = this.threatFrom;
    const ax = c[0] - e[0], az = c[2] - e[2], al = Math.hypot(ax, az) || 1;
    const back = this.snap([c[0] + (ax / al) * 25, c[1], c[2] + (az / al) * 25], 8);
    this.setupAt(back);
    for (const b of bots) { const q = this.postOf.get(b.s.id); if (q) b.setTask({ kind: 'move', p: q.p, run: true }); }
    this.stalkers.clear();
    this.set('fallback');
    this.say('Fall back! Fall back!');
  }

  private hunt() { this.set('hunt'); for (const b of this.alive()) b.sprung = true; }

  /** A reinforcement joins the cell: it gets a free post (or the nearest one). */
  join(b: Bot) {
    this.bots.push(b);
    const taken = new Set(this.postOf.values());
    const q = this.posts.find((x) => !taken.has(x)) ?? this.posts[0];
    if (q) this.postOf.set(b.s.id, q);
    if (this.state !== 'ambush') b.sprung = true;
  }
  /** Move the cell's base (a new cache to defend, or a new patrol area) and set up there in ambush. */
  rehome(home: V3, threatFrom: V3) { this.home = home; this.threatFrom = threatFrom; this.setupAt(home); this.set('ambush'); this.stateT = 0; this.stalkers.clear(); }
}

// Commands the bots on the full map (Insurgency). The small-unit tactics come from the team brains (ai/team.ts), as in
// the test area: each US squad is a Fireteam that travels in formation to the intel marker of a revealed cache, reacts
// to contact (suppress from overwatch, flank through houses, assault, clear rooms), and searches the buildings round the
// marker one by one; when the cache is found the engineer demolishes it while the rest secure it. Insurgent cells
// defend the active caches from windows and roofs round them (ambush, shoot and scoot, stalk, fall back); roaming
// cells hide in houses in the town and hunt when they hear fighting. Both sides respawn: US at the FOB (costs
// tickets), insurgents at undiscovered caches or their base; reinforcements join their squad's or cell's brain.
// Combined arms: each US squad rides its M2A3 to a dismount point ~140 m short of the objective while its M1A2 takes
// an overwatch position further back on the same route; dismounted, the squad clears the houses round the objective
// room by room and both vehicles follow 60–90 m behind it, putting fire on whatever the squad is in contact with.
// Reinforcements arrive at the squad's Bradley. The insurgents have command-wire IEDs on the approaches (with
// triggermen in nearby houses) and ATGM teams on roofs at the eastern edge of the town.
import type { Game } from '../game/game';
import type { Soldier } from '../game/soldier';
import type { Insurgency, Cache } from '../game/insurgency';
import type { City } from '../world/citygen';
import { kitById, type Faction } from '../game/data/kits';
import { Bot, type Order } from './bot';
import { safeSpawn } from './nav';
import type { Nav } from './nav';
import type { V3 } from '../game/projectiles';
import { mulberry, pick } from '../core/rng';
import { Cell as CellBrain, Fireteam } from './team';
import { InsurgentAT } from './threats';
import type { BuildingInfo } from '../world/building';
import type { Vehicle } from '../vehicles/vehicle';
import { groundH } from '../world/terrain';

const US_NAMES = ['Miller', 'Johnson', 'Garcia', 'Rodriguez', 'Davis', 'Martinez', 'Wilson', 'Anderson', 'Taylor', 'Thomas', 'Moore', 'Jackson', 'Martin', 'Lee', 'Harris', 'Clark', 'Lewis', 'Walker', 'Young', 'King', 'Wright', 'Lopez', 'Hill', 'Scott', 'Green', 'Baker', 'Nelson', 'Carter', 'Mitchell', 'Perez'];
const INS_NAMES = ['Ahmed', 'Omar', 'Yusuf', 'Khalid', 'Hassan', 'Ali', 'Mahmoud', 'Saeed', 'Tariq', 'Hamza', 'Bilal', 'Faisal', 'Karim', 'Nasser', 'Rashid', 'Samir', 'Walid', 'Ziad', 'Jamal', 'Murad', 'Idris', 'Qasim', 'Adnan', 'Fadi'];
const US_SQUAD = ['us_sl', 'us_rifle', 'us_ar', 'us_medic', 'us_eng', 'us_gren'];
const US_SQUAD2 = ['us_sl', 'us_rifle', 'us_ar', 'us_medic', 'us_eng', 'us_lat'];
const INS_POOL = ['ins_rifle', 'ins_rifle', 'ins_rifle2', 'ins_rifle', 'ins_at', 'ins_rpk', 'ins_rifle2', 'ins_mg', 'ins_marks', 'ins_rifle', 'ins_cell', 'ins_medic', 'ins_at2', 'ins_at'];

interface Squad {
  id: number; name: string; team: Faction; members: Soldier[]; leader: Soldier | null; kits: string[]; target: Cache | null; phase: 'move' | 'search' | 'secure'; searchT: number;
  brain: Fireteam | null; plan: BuildingInfo[]; planI: number; wasSearching: boolean; secured: boolean;
  /** Attached vehicles (motor-pool slots) and the mechanised phase. */
  ifvSlot: number; tankSlot: number; mech: 'none' | 'mount' | 'ride' | 'dismounted'; mechT: number; supportT: number; stuckT?: number; ridingHp?: number;
}
interface Cell { id: number; members: Soldier[]; role: 'defend' | 'roam'; cache: Cache | null; patrol: V3; size: number; brain: CellBrain | null }

export class Director {
  bots = new Map<number, Bot>();
  squads: Squad[] = [];
  cells: Cell[] = [];
  respawnQ: { team: Faction; kit: string; t: number; squad?: Squad; cell?: Cell }[] = [];
  insTarget = 20;
  private rng = mulberry(99);
  private nameI = 0;

  constructor(private g: Game, private city: City, private mode: Insurgency, private nav: Nav | null) {}

  /** Create the initial forces. `playerSquad` gets 5 bots (the player is the sixth). */
  setup(player: Soldier | null) {
    const sq0 = { leader: null, target: null, phase: 'move' as const, searchT: 0, brain: null, plan: [], planI: 0, wasSearching: false, secured: false, ifvSlot: -1, tankSlot: -1, mech: 'none' as Squad['mech'], mechT: 0, supportT: 0 };
    const us1: Squad = { ...sq0, id: 1, name: 'Alpha', team: 'us', members: [], kits: US_SQUAD };
    const us2: Squad = { ...sq0, id: 2, name: 'Bravo', team: 'us', members: [], kits: US_SQUAD2 };
    this.squads.push(us1, us2);
    if (player?.team === 'us') { us1.members.push(player); player.squad = 1; if (player.kit.leader) us1.leader = player; }
    for (const sq of [us1, us2]) {
      // The player takes the place of the matching kit (or a rifleman) in Alpha.
      const kits = [...sq.kits];
      if (sq === us1 && player?.team === 'us') { const k = kits.indexOf(player.kit.id); kits.splice(k >= 0 ? k : 1, 1); }
      for (const k of kits) this.spawnUS(sq, k);
    }
    // Insurgent cells: one defending each active cache, the rest roaming.
    for (const c of this.mode.active) this.cells.push({ id: this.cells.length, members: [], role: 'defend', cache: c, patrol: c.pos, size: 6, brain: null });
    for (let i = 0; i < 2; i++) this.cells.push({ id: this.cells.length, members: [], role: 'roam', cache: null, patrol: this.randomTownPoint(), size: 4, brain: null });
    for (const cell of this.cells) for (let i = 0; i < cell.size; i++) this.spawnIns(cell);
    if (player?.team === 'ins') { this.cells[0].members.push(player); player.squad = 100; }
    // Team brains.
    const g = this.g;
    for (const sq of this.squads) {
      const bots = sq.members.filter((m) => !m.isPlayer).map((m) => this.bots.get(m.id)).filter((b): b is Bot => !!b);
      const fob = this.city.fob.flag;
      sq.brain = new Fireteam(g, this.nav, 'us', bots, [fob[0], 0, fob[1]]);
      sq.brain.playerLed = !!player && sq.members.includes(player);
      sq.brain.say = (t) => { if (sq.brain!.playerLed) this.mode.say(`${sq.name}: ${t}`, 'us'); };
      if (sq.brain.playerLed) g.fireteam = sq.brain;
    }
    // Armour: a Bradley (mounted infantry) and a tank per squad.
    const crews = g.crews;
    if (crews) {
      const ifvs = crews.slots.map((x, i) => [x.id, i] as const).filter((x) => x[0] === 'm2a3'), tanks = crews.slots.map((x, i) => [x.id, i] as const).filter((x) => x[0] === 'm1a2');
      this.squads.forEach((sq, k) => { sq.ifvSlot = ifvs[k]?.[1] ?? -1; sq.tankSlot = tanks[k]?.[1] ?? -1; sq.mech = sq.ifvSlot >= 0 && !sq.brain!.playerLed ? 'mount' : 'none'; });
    }
    this.setupThreats();
    for (const cell of this.cells) {
      const bots = cell.members.filter((m) => !m.isPlayer).map((m) => this.bots.get(m.id)).filter((b): b is Bot => !!b);
      cell.brain = new CellBrain(g, this.nav, 'ins', bots, cell.cache ? cell.cache.pos : cell.patrol, this.fobPoint());
      // Defenders stay on their cache; roaming cells hunt what comes into their part of town.
      if (cell.role === 'roam') { cell.brain.patience = 60 + this.rng() * 60; cell.brain.huntRange = 250; }
      else { cell.brain.patience = Infinity; cell.brain.huntRange = 120; }
      cell.brain.say = (t) => { if (player?.team === 'ins' && cell.members.includes(player)) this.mode.say(t, 'ins'); };
    }
  }

  private veh(slot: number): Vehicle | null { const v = slot >= 0 ? this.g.crews?.slots[slot]?.v ?? null : null; return v && !v.dead ? v : null; }
  /** A vehicle the player crews is his to drive: the director does not order it about. */
  private playerCrewed(v: Vehicle) { return v.seats.some((x) => x.who?.isPlayer && x.def.role !== 'cargo'); }

  /** IEDs on the approaches into town (each with a triggerman watching from a house) and three ATGM teams. */
  private setupThreats() {
    const g = this.g, at = new InsurgentAT(g); g.insAT = at;
    const spots: [number, number][] = [[536, 2.5], [592, -3], [563, -325], [618, -322], [549, 265], [604, 262], [493, 1.5]];
    for (const [x, z] of spots) {
      const ied = at.addIed([x, groundH(x, z), z]);
      const post = this.watchPost([x, groundH(x, z) + 0.5, z], 40, 170);
      const s = this.spawnLone('ins_sapper', post.p, post.face);
      ied.trigger = s;
    }
    // ATGM teams: roofs at the eastern edge of the town with a view of the ridge and the farmland.
    const bands: [number, number][] = [[-420, -120], [-120, 120], [120, 420]];
    for (const [z0, z1] of bands) {
      let best: { p: V3; sc: number } | null = null;
      for (const r of this.city.roofSpots) {
        if (r.x < 360 || r.x > 515 || r.z < z0 || r.z > z1 || r.y < 4) continue;
        const eye: V3 = [r.x, r.y + 1.2, r.z];
        let seen = 0;
        for (const tz of [r.z - 120, r.z, r.z + 120]) for (const tx of [600, 662, 760]) if (g.P.clear(eye, [tx, groundH(tx, tz) + 2, tz])) seen++;
        const sc = seen * 10 + r.y;
        if (seen >= 3 && (!best || sc > best.sc)) best = { p: [r.x, r.y, r.z], sc };
      }
      if (!best) continue;
      const site = at.addSite(best.p, -Math.PI / 2);
      site.gunner = this.spawnLone('ins_rifle', [best.p[0] - 0.8, best.p[1] + 0.1, best.p[2]], -Math.PI / 2);
    }
  }

  /** A window or roof within [rMin, rMax] of p with a clear view of it (else a point on the navmesh near it). */
  private watchPost(p: V3, rMin: number, rMax: number): { p: V3; face: number } {
    let best: { p: V3; face: number; d: number } | null = null;
    for (const b of this.city.buildings) {
      const cx = (b.spec.x0 + b.spec.x1) / 2, cz = (b.spec.z0 + b.spec.z1) / 2, dd = Math.hypot(cx - p[0], cz - p[2]);
      if (dd > rMax + 20 || dd < rMin - 20) continue;
      for (const w of b.windows) {
        const d = Math.hypot(w.x - p[0], w.z - p[2]); if (d < rMin || d > rMax) continue;
        if (!this.g.P.clear([w.x, w.y + 1.4, w.z], p)) continue;
        if (!best || d < best.d) best = { p: [w.x, w.y, w.z], face: Math.atan2(-(p[0] - w.x), -(p[2] - w.z)), d };
      }
    }
    if (best) return { p: this.nav?.closest(best.p, 1.5) ?? best.p, face: best.face };
    const q: V3 = [p[0] - 70, p[1], p[2] + 25];
    return { p: this.nav?.closest(q, 25) ?? q, face: Math.atan2(-(p[0] - q[0]), -(p[2] - q[2])) };
  }

  /** An insurgent with a fixed post (IED triggerman, ATGM gunner): no cell, no respawn. */
  private spawnLone(kitId: string, p: V3, face: number): Soldier {
    const s = this.g.spawn(kitById(kitId), 'ins', p, this.name('ins'), face);
    s.squad = 200;
    const bot = new Bot(this.g, s, this.nav, { kind: 'defend', pos: p, stance: 'crouch', facing: face }, 0.5 + this.rng() * 0.3);
    this.bots.set(s.id, bot);
    return s;
  }

  /**
   * Mounted infantry and armour support for a squad: mount at the FOB, ride to the dismount point, dismount at the
   * ramp; then the Bradley and the tank follow the squad and fire where it is in contact.
   */
  private mech(sq: Squad, dt: number, objective: V3) {
    const ifv = this.veh(sq.ifvSlot), tank = this.veh(sq.tankSlot), B = sq.brain!, g = this.g;
    sq.mechT += dt;
    const live = sq.members.filter((m) => m.alive);
    const player = g.player?.s;
    const withPlayer = !!player && live.includes(player);
    // The player's squad goes nowhere without him: mounting waits for him to get in.
    if (sq.mech === 'mount' && withPlayer && player!.vehicle !== ifv) { sq.mech = 'none'; for (const m of live) { if (m.vehicle === ifv && ifv) ifv.exit(m, true); } return false; }
    // The player's squad: when he gets into the Bradley's troop seats, his bots mount up with him.
    if (sq.mech === 'none' && ifv && player && live.includes(player) && player.vehicle === ifv && ifv.seats[ifv.seatOf(player)]?.def.role === 'cargo') { sq.mech = 'mount'; sq.mechT = 0; this.mode.say(`${sq.name}: mounting up!`, 'us'); }
    if ((sq.mech === 'mount' || sq.mech === 'ride') && (!ifv || ifv.burning)) {
      // The Bradley is gone or on fire: everybody out, carry on on foot.
      if (ifv) for (const st of ifv.seats) if (st.who && st.def.role === 'cargo') ifv.exit(st.who, true);
      sq.mech = 'dismounted';
    }
    if (sq.mech === 'mount' && ifv) {
      const free = () => ifv.seats.findIndex((x) => x.def.role === 'cargo' && !x.who);
      const rear = ifv.nodePos('exit_rear');
      for (const m of live) {
        if (m.isPlayer || m.vehicle) continue;
        const b = this.bots.get(m.id); if (!b) continue;
        if (Math.hypot(m.pos[0] - rear[0], m.pos[2] - rear[2]) < 3.5) { const i = free(); if (i >= 0) { b.setTask(null); ifv.enter(m, i); } }
        else b.setTask({ kind: 'move', p: this.nav?.closest(rear, 4) ?? rear, run: true });
      }
      const aboard = live.filter((m) => m.vehicle === ifv).length;
      if ((aboard >= live.length || sq.mechT > 70) && aboard > 0) {
        sq.mech = 'ride'; sq.mechT = 0;
        const path = this.g.crews!.planner.path(ifv.pos(), objective);
        const at = (dist: number): V3 => {
          if (!path || path.length < 2) return objective;
          let acc = 0;
          for (let i = path.length - 1; i > 0; i--) { const a = path[i], b = path[i - 1], l = Math.hypot(a[0] - b[0], a[2] - b[2]); if (acc + l >= dist) { const t = (dist - acc) / l; return [a[0] + (b[0] - a[0]) * t, a[1], a[2] + (b[2] - a[2]) * t]; } acc += l; }
          return path[0];
        };
        if (!this.playerCrewed(ifv)) ifv.ai?.driveTo(at(140));
        if (tank && !this.playerCrewed(tank)) tank.ai?.driveTo(at(230));
        if (B.playerLed) this.mode.say(`${sq.name}: all aboard — moving out.`, 'us');
      }
    }
    if (sq.mech === 'ride' && ifv) {
      const arrived = !ifv.ai?.moving && ifv.speed < 0.6 && sq.mechT > 5;
      // Dismount under fire (the vehicle hit) or when it cannot get on (blocked for 15 s).
      sq.stuckT = ifv.speed < 0.6 ? (sq.stuckT ?? 0) + dt : 0;
      const hit = ifv.integrity < (sq.ridingHp ??= ifv.integrity) - 0.1;
      if (arrived || sq.mechT > 240 || hit || sq.stuckT > 15) {
        for (const st of ifv.seats) if (st.who && st.def.role === 'cargo') ifv.exit(st.who, true);
        sq.mech = 'dismounted'; sq.mechT = 0; sq.supportT = 10; sq.stuckT = 0; sq.ridingHp = undefined; // let them clear the ramp
        if (ifv.ai?.moving) ifv.ai.stop();
        this.mode.say(`${sq.name}: dismount, dismount!`, 'us');
      }
      return true; // riding: the brain waits
    }
    if (sq.mech === 'mount') return true;
    // Support: follow the squad (60 m behind for the Bradley, 90 m for the tank) and fire where it is in contact.
    const L = B.leader();
    if (L && (sq.supportT -= dt) <= 0) {
      sq.supportT = 8;
      const dx = L.pos[0] - objective[0], dz = L.pos[2] - objective[2], dl = Math.hypot(dx, dz) || 1;
      for (const [v, back, side] of [[ifv, 60, 10], [tank, 90, -14]] as [Vehicle | null, number, number][]) {
        if (!v || this.playerCrewed(v) || !v.ai) continue;
        const q: V3 = [L.pos[0] + dx / dl * back - dz / dl * side, 0, L.pos[2] + dz / dl * back + dx / dl * side];
        const vp = v.pos();
        if (Math.hypot(vp[0] - q[0], vp[2] - q[2]) > 25 && (!v.ai.goal || Math.hypot(v.ai.goal[0] - q[0], v.ai.goal[2] - q[2]) > 20)) v.ai.driveTo(q);
      }
    }
    const k = this.g.contacts.us, fresh = [...k.values()].filter((c) => g.time - c.t < 8 && L && Math.hypot(c.p[0] - L.pos[0], c.p[2] - L.pos[2]) < 250);
    if (fresh.length) { const c = fresh[0].p; for (const v of [ifv, tank]) if (v?.ai && !v.ai.target) v.ai.fireAt([c[0], c[1] + 1.2, c[2]]); }
    return false;
  }

  private name(team: Faction) { this.nameI++; return team === 'us' ? `${pick(this.rng, ['Pvt.', 'PFC', 'Spc.', 'Cpl.'])} ${US_NAMES[this.nameI % US_NAMES.length]}` : INS_NAMES[this.nameI % INS_NAMES.length]; }

  private spawnUS(sq: Squad, kitId: string) {
    const sp = this.city.fob.spawns[Math.floor(this.rng() * this.city.fob.spawns.length)];
    let p: V3 = [sp[0] + (this.rng() - 0.5) * 6, sp[1] + 0.1, sp[2] + (this.rng() - 0.5) * 6];
    // Reinforcements arrive at the squad's Bradley when it is up with the squad (and not under fire).
    const ifv = this.veh(sq.ifvSlot);
    if (ifv && sq.mech === 'dismounted' && !ifv.burning && ifv.speed < 1 && this.g.time - (ifv.seats[0].who?.lastHitT ?? -99) > 10) { const r = ifv.nodePos('exit_rear'); p = [r[0], r[1] + 0.1, r[2]]; }
    const kit = kitById(kitId), s = this.g.spawn(kit, 'us', safeSpawn(this.g.P, this.nav, p), (kit.leader ? 'Sgt. ' : '') + this.name('us').replace(/^(Pvt\.|PFC|Spc\.|Cpl\.) /, kit.leader ? '' : '$1 '), Math.PI / 2);
    s.squad = sq.id; sq.members.push(s);
    if (kit.leader && !sq.leader) sq.leader = s;
    const bot = new Bot(this.g, s, this.nav, { kind: 'hold', pos: p }, 0.55 + this.rng() * 0.3);
    this.bots.set(s.id, bot);
    sq.brain?.bots.push(bot);
    return s;
  }

  private spawnIns(cell: Cell) {
    const kit = kitById(INS_POOL[Math.floor(this.rng() * INS_POOL.length)]);
    let p: V3;
    const spawns = this.mode.insSpawns();
    if (cell.cache && cell.cache.state === 'active' && !cell.cache.found) p = [cell.cache.pos[0] + (this.rng() - 0.5) * 2, cell.cache.pos[1] + 0.1, cell.cache.pos[2] + (this.rng() - 0.5) * 2];
    else if (spawns.length && this.rng() < 0.7) { const q = spawns[Math.floor(this.rng() * spawns.length)]; p = [q[0], q[1] + 0.1, q[2]]; }
    else { const q = this.city.insBase.spawns[Math.floor(this.rng() * this.city.insBase.spawns.length)]; p = [q[0] + (this.rng() - 0.5) * 4, q[1] + 0.1, q[2] + (this.rng() - 0.5) * 4]; }
    p = safeSpawn(this.g.P, this.nav, p, 3);
    const s = this.g.spawn(kit, 'ins', p, this.name('ins'), this.rng() * Math.PI * 2);
    s.squad = 100 + cell.id; cell.members.push(s);
    const bot = new Bot(this.g, s, this.nav, { kind: 'hold', pos: p }, 0.4 + this.rng() * 0.35);
    this.bots.set(s.id, bot);
    this.orderIns(cell, s, bot);
    cell.brain?.join(bot);
    return s;
  }

  /** Where the Americans come from (the FOB), for facing ambush posts. */
  private fobPoint(): V3 { const f = this.city.fob.flag; return [f[0], 0, f[1]]; }

  private randomTownPoint(): V3 {
    const town = this.city.buildings.filter((x) => x.spec.x1 < 500);
    const b = town[Math.floor(this.rng() * town.length)];
    const d = b.doors[0] ?? [b.spec.x0, b.spec.y0, b.spec.z0];
    return [d[0], d[1], d[2]];
  }

  /** Insurgent positions: inside the cache building, windows/roofs of buildings within 45 m, or a patrol. */
  private orderIns(cell: Cell, s: Soldier, bot: Bot) {
    if (cell.role === 'defend' && cell.cache && cell.cache.state === 'active') {
      const c = cell.cache, i = cell.members.indexOf(s);
      const bld = this.city.buildings[c.spot.b];
      const near = this.city.roofSpots.filter((r) => Math.hypot(r.x - c.pos[0], r.z - c.pos[2]) < 45);
      let pos: V3, stance: Order['stance'] = 'crouch';
      if (i < 2 && bld) { const sp = bld.spots[(i + 1) % bld.spots.length]; pos = [sp[0], sp[1], sp[2]]; }
      else if (near.length) { const r = near[(i * 7 + cell.id) % near.length]; pos = [r.x, r.y, r.z]; stance = 'crouch'; }
      else pos = this.nav?.around(c.pos, 25) ?? c.pos;
      bot.setOrder({ kind: 'defend', pos, stance, facing: Math.atan2(-(585 - pos[0]), -(0 - pos[2])) });
    } else {
      bot.setOrder({ kind: 'patrol', pos: cell.patrol, radius: 50 });
    }
  }

  private nearestCache(p: V3, revealedOnly: boolean): Cache | null {
    let best: Cache | null = null, bd = Infinity;
    for (const c of this.mode.active) {
      if (revealedOnly && !c.revealed) continue;
      const d = Math.hypot(c.marker[0] - p[0], c.marker[1] - p[2]);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  update(dt: number) {
    const g = this.g;
    if (this.nav) this.nav.budget = 3;
    for (const b of this.bots.values()) b.update(dt);
    // US squads: the Fireteam brain does the moving and fighting; the director gives it the objective.
    for (const sq of this.squads) {
      sq.members = sq.members.filter((m) => g.soldiers.includes(m));
      if (sq.brain) sq.brain.bots = sq.brain.bots.filter((b) => g.soldiers.includes(b.s));
      const live = sq.members.filter((m) => m.alive);
      if (!sq.leader || !sq.leader.alive) sq.leader = live.find((m) => m.kit.leader) ?? live.find((m) => !m.isPlayer) ?? null;
      if (sq.brain) { sq.brain.playerLed = sq.members.some((m) => m.isPlayer && m.alive); if (sq.brain.playerLed) g.fireteam = sq.brain; }
      const L = sq.brain?.leader() ?? sq.leader; if (!L || !sq.brain) continue;
      if (!sq.target || sq.target.state !== 'active') { sq.target = this.nearestCache(L.pos, true); sq.phase = 'move'; sq.plan = []; sq.secured = false; }
      const tgt = sq.target, B = sq.brain;
      if (!tgt) {
        if (!sq.plan.length || B.state === 'move') B.objective = this.nav?.closest(this.randomTownPoint(), 10) ?? B.objective;
        if (sq.mech !== 'none' && this.mech(sq, dt, B.objective)) continue;
        B.update(dt); continue;
      }
      const markerP: V3 = [tgt.marker[0], tgt.pos[1], tgt.marker[1]];
      if (sq.mech !== 'none' && this.mech(sq, dt, markerP)) continue;
      if (tgt.found) sq.phase = 'secure';
      else if (sq.phase === 'move' && Math.hypot(markerP[0] - L.pos[0], markerP[2] - L.pos[2]) < 60) {
        // Search plan: the buildings round the marker, nearest first (the team clears each one's rooms).
        sq.phase = 'search'; sq.searchT = 0; sq.planI = 0;
        const ctr = (b: BuildingInfo): V3 => [(b.spec.x0 + b.spec.x1) / 2, 0, (b.spec.z0 + b.spec.z1) / 2];
        sq.plan = this.city.buildings
          .filter((b) => Math.hypot(ctr(b)[0] - markerP[0], ctr(b)[2] - markerP[2]) < REVEAL_R && b.doorways.some((d) => d.exterior) && !b.spec.hall)
          // The 12 houses nearest the marker (the cache is within REVEAL_OFFSET of it), cleared nearest-first from the team.
          .sort((a, b) => Math.hypot(ctr(a)[0] - markerP[0], ctr(a)[2] - markerP[2]) - Math.hypot(ctr(b)[0] - markerP[0], ctr(b)[2] - markerP[2])).slice(0, 12)
          .sort((a, b) => Math.hypot(ctr(a)[0] - L.pos[0], ctr(a)[2] - L.pos[2]) - Math.hypot(ctr(b)[0] - L.pos[0], ctr(b)[2] - L.pos[2]));
      }
      if (sq.phase === 'move') { B.objective = this.nav?.closest(markerP, 20) ?? markerP; B.update(dt); }
      else if (sq.phase === 'search') {
        sq.searchT += dt;
        // House-to-house: clear the buildings round the marker one after another, room by room (skipping any another
        // squad has cleared); between houses, and in a fight, the brain runs as usual.
        if (B.state === 'move' && !B.clearing) {
          while (sq.planI < sq.plan.length && g.cleared.us.has(sq.plan[sq.planI].id)) sq.planI++;
          const next = sq.plan[sq.planI];
          if (next) {
            const door = next.doorways.find((d) => d.exterior) ?? next.doorways[0];
            const dp: V3 = [door.x, door.y, door.z];
            if (Math.hypot(dp[0] - L.pos[0], dp[2] - L.pos[2]) < 25) { if (!B.clearBuilding(next)) sq.planI++; else sq.planI++; }
            else B.objective = this.nav?.closest(dp, 6) ?? dp;
          } else B.objective = this.nav?.closest(markerP, 20) ?? markerP;
        }
        B.update(dt);
        if (sq.searchT > 420 || (sq.plan.length && sq.planI >= sq.plan.length && B.state === 'move' && !B.clearing)) tgt.found = true; // they eventually stumble on it
      } else {
        // Secure: the engineer demolishes, the rest hold round the cache (orders, not brain tasks).
        if (!sq.secured) { sq.secured = true; for (const b of B.bots) b.setTask(null); if (B.playerLed) this.mode.say(`${sq.name}: cache found — securing it, engineer to the cache!`, 'us'); }
        for (const m of live) {
          const b = this.bots.get(m.id); if (!b) continue;
          if (m.kit.role === 'engineer' && m.slots.some((x) => x.def.id === 'c4' && (x.loaded > 0 || x.mags.length))) { if (b.order.kind !== 'demolish') b.setOrder({ kind: 'demolish', pos: tgt.pos }); }
          else if (b.order.kind !== 'defend') b.setOrder({ kind: 'defend', pos: this.nav?.around(tgt.pos, 18) ?? tgt.pos, stance: 'crouch' });
        }
        // Still fight back: contact runs the brain's drill (it hands back when the fight is over).
        if (live.some((m) => this.bots.get(m.id)?.target)) { sq.secured = false; B.update(dt); }
      }
    }
    // Insurgent cells: the Cell brain fights; the director moves defenders to the next cache when theirs is gone.
    for (const cell of this.cells) {
      cell.members = cell.members.filter((m) => g.soldiers.includes(m));
      if (cell.brain) cell.brain.bots = cell.brain.bots.filter((b) => g.soldiers.includes(b.s));
      if (cell.role === 'defend' && (!cell.cache || cell.cache.state !== 'active')) {
        cell.cache = this.mode.active.find((c) => !this.cells.some((o) => o !== cell && o.cache === c)) ?? null;
        if (!cell.cache) { cell.role = 'roam'; if (cell.brain) { cell.brain.patience = 30; cell.brain.huntRange = 250; } }
        else cell.brain?.rehome(cell.cache.pos, this.fobPoint());
        for (const m of cell.members) { const b = this.bots.get(m.id); if (b) this.orderIns(cell, m, b); }
      }
      cell.brain?.update(dt);
    }
    // Deaths → respawn queue.
    for (const s of [...g.soldiers]) {
      if (s.isPlayer) continue;
      const dead = s.state === 'dead' && s.deadT > 6;
      if (!dead) continue;
      const sq = this.squads.find((q) => q.members.includes(s)), cell = this.cells.find((c) => c.members.includes(s));
      this.respawnQ.push({ team: s.team, kit: s.kit.id, t: g.time + (s.team === 'us' ? 30 : 20), squad: sq, cell });
      this.bots.delete(s.id); g.remove(s);
    }
    // Wounded bots bleed out / give up after a while (medics may revive them first).
    for (const s of g.soldiers) if (!s.isPlayer && s.state === 'wounded' && s.downT > 75) { s.die(null); this.mode.onDown(s, s.killedBy, true); }
    for (let i = this.respawnQ.length - 1; i >= 0; i--) {
      const r = this.respawnQ[i]; if (g.time < r.t || this.mode.over) continue;
      this.respawnQ.splice(i, 1);
      if (r.team === 'us' && r.squad) { if (this.mode.tickets > 0) this.spawnUS(r.squad, r.kit); }
      else if (r.cell) { if (g.soldiers.filter((s) => s.team === 'ins' && s.state !== 'dead').length < this.insTarget + 4) this.spawnIns(r.cell); }
    }
  }
}
const REVEAL_R = 80;

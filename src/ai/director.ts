// Commands the bots on the full map (Insurgency). The small-unit tactics come from the team brains (ai/team.ts), as in
// the test area: each US squad is a Fireteam that travels in formation to the intel marker of a revealed cache, reacts
// to contact (suppress from overwatch, flank through houses, assault, clear rooms), and searches the buildings round the
// marker one by one; when the cache is found the engineer demolishes it while the rest secure it. Insurgent cells
// defend the active caches from windows and roofs round them (ambush, shoot and scoot, stalk, fall back); roaming
// cells hide in houses in the town and hunt when they hear fighting. Both sides respawn: US at the FOB (costs
// tickets), insurgents at undiscovered caches or their base; reinforcements join their squad's or cell's brain.
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

const US_NAMES = ['Miller', 'Johnson', 'Garcia', 'Rodriguez', 'Davis', 'Martinez', 'Wilson', 'Anderson', 'Taylor', 'Thomas', 'Moore', 'Jackson', 'Martin', 'Lee', 'Harris', 'Clark', 'Lewis', 'Walker', 'Young', 'King', 'Wright', 'Lopez', 'Hill', 'Scott', 'Green', 'Baker', 'Nelson', 'Carter', 'Mitchell', 'Perez'];
const INS_NAMES = ['Ahmed', 'Omar', 'Yusuf', 'Khalid', 'Hassan', 'Ali', 'Mahmoud', 'Saeed', 'Tariq', 'Hamza', 'Bilal', 'Faisal', 'Karim', 'Nasser', 'Rashid', 'Samir', 'Walid', 'Ziad', 'Jamal', 'Murad', 'Idris', 'Qasim', 'Adnan', 'Fadi'];
const US_SQUAD = ['us_sl', 'us_rifle', 'us_ar', 'us_medic', 'us_eng', 'us_gren'];
const US_SQUAD2 = ['us_sl', 'us_rifle', 'us_ar', 'us_medic', 'us_eng', 'us_lat'];
const INS_POOL = ['ins_rifle', 'ins_rifle', 'ins_rifle2', 'ins_rifle', 'ins_at', 'ins_rpk', 'ins_rifle2', 'ins_mg', 'ins_marks', 'ins_rifle', 'ins_cell', 'ins_medic'];

interface Squad {
  id: number; name: string; team: Faction; members: Soldier[]; leader: Soldier | null; kits: string[]; target: Cache | null; phase: 'move' | 'search' | 'secure'; searchT: number;
  brain: Fireteam | null; plan: V3[]; planI: number; wasSearching: boolean; secured: boolean;
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
    const sq0 = { leader: null, target: null, phase: 'move' as const, searchT: 0, brain: null, plan: [], planI: 0, wasSearching: false, secured: false };
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
    for (const cell of this.cells) {
      const bots = cell.members.filter((m) => !m.isPlayer).map((m) => this.bots.get(m.id)).filter((b): b is Bot => !!b);
      cell.brain = new CellBrain(g, this.nav, 'ins', bots, cell.cache ? cell.cache.pos : cell.patrol, this.fobPoint());
      // Defenders stay on their cache; roaming cells hunt what comes into their part of town.
      if (cell.role === 'roam') { cell.brain.patience = 60 + this.rng() * 60; cell.brain.huntRange = 250; }
      else { cell.brain.patience = Infinity; cell.brain.huntRange = 120; }
      cell.brain.say = (t) => { if (player?.team === 'ins' && cell.members.includes(player)) this.mode.say(t, 'ins'); };
    }
  }

  private name(team: Faction) { this.nameI++; return team === 'us' ? `${pick(this.rng, ['Pvt.', 'PFC', 'Spc.', 'Cpl.'])} ${US_NAMES[this.nameI % US_NAMES.length]}` : INS_NAMES[this.nameI % INS_NAMES.length]; }

  private spawnUS(sq: Squad, kitId: string) {
    const sp = this.city.fob.spawns[Math.floor(this.rng() * this.city.fob.spawns.length)];
    const p: V3 = [sp[0] + (this.rng() - 0.5) * 6, sp[1] + 0.1, sp[2] + (this.rng() - 0.5) * 6];
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
    const b = this.city.buildings[Math.floor(this.rng() * this.city.buildings.length)];
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
      const L = sq.brain?.leader() ?? sq.leader; if (!L || !sq.brain) continue;
      if (!sq.target || sq.target.state !== 'active') { sq.target = this.nearestCache(L.pos, true); sq.phase = 'move'; sq.plan = []; sq.secured = false; }
      const tgt = sq.target, B = sq.brain;
      if (!tgt) { B.objective = this.nav?.closest(this.randomTownPoint(), 10) ?? B.objective; B.update(dt); continue; }
      const markerP: V3 = [tgt.marker[0], tgt.pos[1], tgt.marker[1]];
      if (tgt.found) sq.phase = 'secure';
      else if (sq.phase === 'move' && Math.hypot(markerP[0] - L.pos[0], markerP[2] - L.pos[2]) < 60) {
        // Search plan: the buildings round the marker, nearest first (the team clears each one's rooms).
        sq.phase = 'search'; sq.searchT = 0; sq.planI = 0;
        sq.plan = this.city.buildings
          .filter((b) => Math.hypot((b.spec.x0 + b.spec.x1) / 2 - markerP[0], (b.spec.z0 + b.spec.z1) / 2 - markerP[2]) < REVEAL_R && b.doors.length)
          .map((b) => [b.doors[0][0], b.doors[0][1], b.doors[0][2]] as V3)
          // The 12 houses nearest the marker (the cache is within REVEAL_OFFSET of it), visited nearest-first from the team.
          .sort((a, b) => Math.hypot(a[0] - markerP[0], a[2] - markerP[2]) - Math.hypot(b[0] - markerP[0], b[2] - markerP[2])).slice(0, 12)
          .sort((a, b) => Math.hypot(a[0] - L.pos[0], a[2] - L.pos[2]) - Math.hypot(b[0] - L.pos[0], b[2] - L.pos[2]));
      }
      if (sq.phase === 'move') { B.objective = this.nav?.closest(markerP, 20) ?? markerP; B.update(dt); }
      else if (sq.phase === 'search') {
        sq.searchT += dt;
        // Next building when the team finished clearing this one (its search ended and it is moving again).
        const searching = B.state === 'search';
        if (sq.wasSearching && !searching && B.state === 'move') sq.planI++;
        sq.wasSearching = searching;
        const obj = sq.plan[sq.planI % Math.max(1, sq.plan.length)] ?? markerP;
        B.objective = this.nav?.closest(obj, 6) ?? obj;
        B.update(dt);
        if (sq.searchT > 300 || (sq.plan.length && sq.planI >= sq.plan.length * 2)) tgt.found = true; // they eventually stumble on it
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

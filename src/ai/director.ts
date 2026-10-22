// Commands the bots. US squads (leader + fire team) move on the revealed caches, search the buildings around the
// intel marker, and their engineer demolishes a found cache while the rest secure it. Insurgent cells defend the
// active caches from inside the building and the nearby rooftops; roaming cells patrol and converge on gunfire.
// Both sides respawn: US at the FOB (costs tickets), insurgents at undiscovered caches or their base.
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

const US_NAMES = ['Miller', 'Johnson', 'Garcia', 'Rodriguez', 'Davis', 'Martinez', 'Wilson', 'Anderson', 'Taylor', 'Thomas', 'Moore', 'Jackson', 'Martin', 'Lee', 'Harris', 'Clark', 'Lewis', 'Walker', 'Young', 'King', 'Wright', 'Lopez', 'Hill', 'Scott', 'Green', 'Baker', 'Nelson', 'Carter', 'Mitchell', 'Perez'];
const INS_NAMES = ['Ahmed', 'Omar', 'Yusuf', 'Khalid', 'Hassan', 'Ali', 'Mahmoud', 'Saeed', 'Tariq', 'Hamza', 'Bilal', 'Faisal', 'Karim', 'Nasser', 'Rashid', 'Samir', 'Walid', 'Ziad', 'Jamal', 'Murad', 'Idris', 'Qasim', 'Adnan', 'Fadi'];
const US_SQUAD = ['us_sl', 'us_rifle', 'us_ar', 'us_medic', 'us_eng', 'us_gren'];
const US_SQUAD2 = ['us_sl', 'us_rifle', 'us_ar', 'us_medic', 'us_eng', 'us_lat'];
const INS_POOL = ['ins_rifle', 'ins_rifle', 'ins_rifle2', 'ins_rifle', 'ins_at', 'ins_rpk', 'ins_rifle2', 'ins_mg', 'ins_marks', 'ins_rifle', 'ins_cell', 'ins_medic'];

interface Squad { id: number; name: string; team: Faction; members: Soldier[]; leader: Soldier | null; kits: string[]; target: Cache | null; phase: 'move' | 'search' | 'secure'; searchT: number }
interface Cell { id: number; members: Soldier[]; role: 'defend' | 'roam'; cache: Cache | null; patrol: V3; size: number }

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
    const us1: Squad = { id: 1, name: 'Alpha', team: 'us', members: [], leader: null, kits: US_SQUAD, target: null, phase: 'move', searchT: 0 };
    const us2: Squad = { id: 2, name: 'Bravo', team: 'us', members: [], leader: null, kits: US_SQUAD2, target: null, phase: 'move', searchT: 0 };
    this.squads.push(us1, us2);
    if (player?.team === 'us') { us1.members.push(player); player.squad = 1; if (player.kit.leader) us1.leader = player; }
    for (const sq of [us1, us2]) {
      // The player takes the place of the matching kit (or a rifleman) in Alpha.
      const kits = [...sq.kits];
      if (sq === us1 && player?.team === 'us') { const k = kits.indexOf(player.kit.id); kits.splice(k >= 0 ? k : 1, 1); }
      for (const k of kits) this.spawnUS(sq, k);
    }
    // Insurgent cells: one defending each active cache, the rest roaming.
    for (const c of this.mode.active) this.cells.push({ id: this.cells.length, members: [], role: 'defend', cache: c, patrol: c.pos, size: 6 });
    for (let i = 0; i < 2; i++) this.cells.push({ id: this.cells.length, members: [], role: 'roam', cache: null, patrol: this.randomTownPoint(), size: 4 });
    for (const cell of this.cells) for (let i = 0; i < cell.size; i++) this.spawnIns(cell);
    if (player?.team === 'ins') { this.cells[0].members.push(player); player.squad = 100; }
  }

  private name(team: Faction) { this.nameI++; return team === 'us' ? `${pick(this.rng, ['Pvt.', 'PFC', 'Spc.', 'Cpl.'])} ${US_NAMES[this.nameI % US_NAMES.length]}` : INS_NAMES[this.nameI % INS_NAMES.length]; }

  private spawnUS(sq: Squad, kitId: string) {
    const sp = this.city.fob.spawns[Math.floor(this.rng() * this.city.fob.spawns.length)];
    const p: V3 = [sp[0] + (this.rng() - 0.5) * 6, sp[1] + 0.1, sp[2] + (this.rng() - 0.5) * 6];
    const kit = kitById(kitId), s = this.g.spawn(kit, 'us', safeSpawn(this.g.P, this.nav, p), (kit.leader ? 'Sgt. ' : '') + this.name('us').replace(/^(Pvt\.|PFC|Spc\.|Cpl\.) /, kit.leader ? '' : '$1 '), Math.PI / 2);
    s.squad = sq.id; sq.members.push(s);
    if (kit.leader && !sq.leader) sq.leader = s;
    this.bots.set(s.id, new Bot(this.g, s, this.nav, { kind: 'hold', pos: p }, 0.55 + this.rng() * 0.3));
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
    return s;
  }

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
    // US squads.
    for (const sq of this.squads) {
      sq.members = sq.members.filter((m) => g.soldiers.includes(m));
      const live = sq.members.filter((m) => m.alive);
      if (!sq.leader || !sq.leader.alive) sq.leader = live.find((m) => m.kit.leader) ?? live.find((m) => !m.isPlayer) ?? null;
      const L = sq.leader; if (!L) continue;
      if (!sq.target || sq.target.state !== 'active') { sq.target = this.nearestCache(L.pos, true); sq.phase = 'move'; }
      const lb = this.bots.get(L.id);
      const tgt = sq.target;
      if (lb && tgt) {
        const markerP: V3 = [tgt.marker[0], tgt.pos[1], tgt.marker[1]];
        const dm = Math.hypot(markerP[0] - L.pos[0], markerP[2] - L.pos[2]);
        if (tgt.found) sq.phase = 'secure';
        else if (sq.phase === 'move' && dm < 60) { sq.phase = 'search'; sq.searchT = 0; }
        if (sq.phase === 'move') lb.setOrder({ kind: 'move', pos: this.nav?.closest(markerP, 20) ?? markerP });
        else if (sq.phase === 'search') {
          sq.searchT += dt;
          if (lb.order.kind !== 'search') {
            // Search plan: doors and rooms of buildings within 80 m of the marker, nearest first.
            const spots = this.city.buildings.filter((b) => Math.hypot((b.spec.x0 + b.spec.x1) / 2 - markerP[0], (b.spec.z0 + b.spec.z1) / 2 - markerP[2]) < REVEAL_R).flatMap((b) => b.spots.filter((s) => s[3] === 0).slice(0, 2).map((s) => [s[0], s[1], s[2]] as V3));
            spots.sort((a, b) => Math.hypot(a[0] - L.pos[0], a[2] - L.pos[2]) - Math.hypot(b[0] - L.pos[0], b[2] - L.pos[2]));
            lb.setOrder({ kind: 'search', pos: markerP, radius: 60 }); lb.searchSpots = spots.filter((_, i) => i % 2 === 0);
            // Members split the other half.
            const others = spots.filter((_, i) => i % 2 === 1);
            live.filter((m) => m !== L && !m.isPlayer).forEach((m, i) => { const b = this.bots.get(m.id); if (b) { b.setOrder({ kind: 'search', pos: markerP, radius: 60 }); b.searchSpots = others.filter((_, k) => k % Math.max(1, live.length - 1) === i % Math.max(1, live.length - 1)); } });
          }
          if (sq.searchT > 240) { tgt.found = true; } // they eventually stumble on it
        } else if (sq.phase === 'secure') {
          // Engineer demolishes; everyone else sets up around the cache.
          for (const m of live) {
            const b = this.bots.get(m.id); if (!b) continue;
            if (m.kit.role === 'engineer' && m.slots.some((x) => x.def.id === 'c4' && (x.loaded > 0 || x.mags.length))) { if (b.order.kind !== 'demolish') b.setOrder({ kind: 'demolish', pos: tgt.pos }); }
            else if (b.order.kind !== 'defend') b.setOrder({ kind: 'defend', pos: this.nav?.around(tgt.pos, 18) ?? tgt.pos, stance: 'crouch' });
          }
        }
      } else if (lb && !tgt) lb.setOrder({ kind: 'patrol', pos: [0, 0, -150], radius: 200 });
      if (sq.phase === 'move' || !tgt) {
        // Fire team follows the leader in a staggered column.
        live.forEach((m, i) => {
          if (m === L || m.isPlayer) return;
          const b = this.bots.get(m.id); if (!b) return;
          const k = i + 1, side = k % 2 ? 1 : -1;
          b.setOrder({ kind: 'follow', pos: L.pos, leader: L, offset: [side * (2 + (k % 3)), -3 - k * 2.2] });
        });
      }
    }
    // Insurgent cells: reassign defenders of destroyed/discovered caches; roamers converge on nearby gunfire.
    for (const cell of this.cells) {
      cell.members = cell.members.filter((m) => g.soldiers.includes(m));
      if (cell.role === 'defend' && (!cell.cache || cell.cache.state !== 'active')) {
        cell.cache = this.mode.active.find((c) => !this.cells.some((o) => o !== cell && o.cache === c)) ?? null;
        if (!cell.cache) cell.role = 'roam';
        for (const m of cell.members) { const b = this.bots.get(m.id); if (b) this.orderIns(cell, m, b); }
      }
      if (cell.role === 'roam') {
        const heard = cell.members.map((m) => m.heard).find((h) => h && g.time - h.t < 5);
        if (heard && Math.hypot(heard.p[0] - cell.patrol[0], heard.p[2] - cell.patrol[2]) > 30) { cell.patrol = heard.p; for (const m of cell.members) this.bots.get(m.id)?.setOrder({ kind: 'patrol', pos: heard.p, radius: 35 }); }
      }
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

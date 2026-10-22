// Bots for the close-quarters test mode. Each team gets bots up to three soldiers (the player counts on theirs).
// The US side advances on the insurgents' start zone by bounding overwatch; the insurgents first hold positions in
// the buildings and cover near their zone, then push after 45 s. When a firefight stalls, one bot is sent to flank.
import type { Game } from '../game/game';
import type { Soldier } from '../game/soldier';
import type { Skirmish } from '../game/skirmish';
import { kitById, type Faction } from '../game/data/kits';
import { Bot } from './bot';
import { safeSpawn, type Nav } from './nav';
import type { V3 } from '../game/projectiles';

const KITS: Record<Faction, string[]> = { us: ['us_rifle', 'us_ar', 'us_medic'], ins: ['ins_rifle', 'ins_rpk', 'ins_rifle2'] };
const NAMES: Record<Faction, string[]> = { us: ['Spc. Miller', 'Cpl. Garcia', 'PFC Davis'], ins: ['Omar', 'Khalid', 'Yusuf'] };

export class SkirmishDirector {
  bots = new Map<number, Bot>();
  private flankCheck = 0;
  private roundT = 0; private huntCheck = 0;
  constructor(private g: Game, private mode: Skirmish, private nav: Nav | null, private playerTeam: Faction | null) {}

  /** Clear the field (bots and corpses) and spawn this round's bots. */
  startRound() {
    const g = this.g;
    for (const s of [...g.soldiers]) if (!s.isPlayer) { this.bots.delete(s.id); g.remove(s); }
    for (const c of g.corpses) c.dispose();
    g.corpses.length = 0; g.claims.clear(); g.contacts.us.clear(); g.contacts.ins.clear();
    this.roundT = 0;
    for (const team of ['us', 'ins'] as Faction[]) {
      const n = team === this.playerTeam ? 2 : 3;
      for (let i = 0; i < n; i++) {
        // The player (if on this team) takes spot 0 of the start building; bots take the others.
        const p = safeSpawn(g.P, this.nav, this.mode.spawnAt(team, i + (team === this.playerTeam ? 1 : 0)), 1.5);
        const s = g.spawn(kitById(KITS[team][i]), team, p, NAMES[team][i], team === 'us' ? -Math.PI / 2 : Math.PI / 2);
        const other = this.mode.zone(team === 'us' ? 'ins' : 'us');
        const bot = new Bot(g, s, this.nav, team === 'us' ? { kind: 'advance', pos: other } : this.defendOrder(s, i), 0.6 + Math.random() * 0.25);
        this.bots.set(s.id, bot);
      }
    }
  }

  /** Insurgents: a firing position in cover near their zone, facing the US side. */
  private defendOrder(s: Soldier, i: number) {
    const z = this.mode.zone('ins'), us = this.mode.zone('us');
    const covers = this.g.cover?.near(z[0] - 12, z[2], 18) ?? [];
    const c = covers.filter((k) => k.p[0] < z[0] - 4).sort((a, b) => a.p[0] - b.p[0])[(i * 3) % Math.max(1, covers.length)];
    const p: V3 = c ? c.p : (this.nav?.around([z[0] - 12, z[1], z[2]], 10) ?? z);
    return { kind: 'defend' as const, pos: p, stance: 'crouch' as const, facing: Math.atan2(-(us[0] - p[0]), -(us[2] - p[2])) };
  }

  update(dt: number) {
    const g = this.g;
    if (this.nav) this.nav.budget = 4;
    this.roundT += dt;
    for (const b of this.bots.values()) b.update(dt);
    // Insurgents stop waiting and push after 45 s.
    if (this.roundT > 45) for (const b of this.bots.values()) if (b.s.team === 'ins' && b.order.kind === 'defend') b.setOrder({ kind: 'advance', pos: this.mode.zone('us') });
    // Rounds have no time limit, so a quiet round must not stall: after 30 s without a shot, both sides hunt,
    // each bot moving on the nearest enemy still standing (roughly: they know the area, not the exact spot).
    const lastShot = Math.max(-99, ...g.soldiers.map((o) => o.lastShotT));
    this.huntCheck -= dt;
    if (g.time - lastShot > 30 && this.roundT > 30 && this.huntCheck <= 0) {
      this.huntCheck = 8;
      for (const b of this.bots.values()) {
        if (!b.s.alive || b.target) continue;
        const foes = g.soldiers.filter((o) => o.team !== b.s.team && o.state === 'alive');
        const e = foes.sort((x, y) => Math.hypot(x.pos[0] - b.s.pos[0], x.pos[2] - b.s.pos[2]) - Math.hypot(y.pos[0] - b.s.pos[0], y.pos[2] - b.s.pos[2]))[0];
        if (!e) continue;
        const guess = this.nav?.closest([e.pos[0] + (Math.random() - 0.5) * 12, e.pos[1], e.pos[2] + (Math.random() - 0.5) * 12], 6) ?? ([...e.pos] as V3);
        b.setOrder({ kind: 'advance', pos: guess });
      }
    }
    // Flanking: when a team has been trading fire for a while, send the bot with the best angle round the side.
    this.flankCheck -= dt;
    if (this.flankCheck <= 0) {
      this.flankCheck = 3;
      for (const team of ['us', 'ins'] as Faction[]) {
        const mine = [...this.bots.values()].filter((b) => b.s.team === team && b.s.alive);
        if (mine.length < 2 || mine.some((b) => b.tac === 'flank')) continue;
        const engaged = mine.filter((b) => b.engagedT > 14 && b.lastSeen && g.time - b.lastSeen.t < 6);
        if (engaged.length < 2) continue;
        const f = engaged.sort((a, b) => b.engagedT - a.engagedT)[0], e = f.lastSeen!.p, s = f.s;
        const dx = e[0] - s.pos[0], dz = e[2] - s.pos[2], L = Math.hypot(dx, dz) || 1, side = Math.random() < 0.5 ? 1 : -1;
        const fp = this.nav?.closest([e[0] - (dx / L) * 10 + (-dz / L) * side * 16, e[1], e[2] - (dz / L) * 10 + (dx / L) * side * 16], 6);
        if (fp) { f.flank(fp); f.engagedT = 0; }
      }
    }
  }
}

// Close-quarters test mode for a small part of the map: two teams of three (the player plus two bots against three
// bots), elimination rounds with no time limit. A round ends only when one side has nobody left standing (both at
// once is a draw); everyone respawns at their start zone a few seconds later.
import type { Rect } from '../world/citygen';
import type { Game } from './game';
import type { GameMode } from './mode';
import type { Soldier } from './soldier';
import type { V3 } from './projectiles';
import type { Faction } from './data/kits';
import { groundH } from '../world/terrain';

export const ROUNDS_TO_WIN = 5;

export class Skirmish implements GameMode {
  kind = 'skirmish' as const;
  log: { t: number; text: string; team?: 'us' | 'ins' }[] = [];
  over: null | 'us' | 'ins' = null;
  /** No round time limit (kept for the GameMode interface). */
  timeLeft = Infinity;
  /** Seconds since the round started (shown on the HUD). */
  elapsed = 0;
  round = 1;
  score = { us: 0, ins: 0 };
  phase: 'live' | 'end' = 'live';
  private endT = 0;
  /** Called when a new round should start (the director respawns everybody). */
  onRound: () => void = () => undefined;

  /** Each team starts inside its own building (US at the west end, insurgents at the east end). */
  private bases: Record<Faction, V3[]>;
  constructor(private g: Game, public area: Rect) {
    const A = area, mid = (A.z0 + A.z1) / 2;
    const used = new Set<number>();
    const pick = (team: Faction) => {
      const cx = (b: { spec: { x0: number; x1: number } }) => (b.spec.x0 + b.spec.x1) / 2, cz = (b: { spec: { z0: number; z1: number } }) => (b.spec.z0 + b.spec.z1) / 2;
      const cands = g.city.buildings.filter((b) => !used.has(b.id) && b.spec.damage < 0.75 && !b.spec.hall && b.spots.some((p) => p[3] === 0)
        && cx(b) > A.x0 + 3 && cx(b) < A.x1 - 3 && cz(b) > A.z0 + 3 && cz(b) < A.z1 - 3);
      // The building furthest towards this team's end of the area (so the two bases are as far apart as possible).
      cands.sort((a, b) => (team === 'us' ? cx(a) - cx(b) : cx(b) - cx(a)) + (Math.abs(cz(a) - mid) - Math.abs(cz(b) - mid)) * 0.15);
      const b = cands[0];
      if (!b) { const x = team === 'us' ? A.x0 + 7 : A.x1 - 7; return [[x, groundH(x, mid), mid] as V3]; }
      used.add(b.id);
      // Ground floor first, then the upper floors.
      return [...b.spots].sort((p, q) => p[3] - q[3]).map((p) => [p[0], p[1], p[2]] as V3);
    };
    this.bases = { us: pick('us'), ins: pick('ins') };
  }

  /** The team's start building (its first spawn spot). */
  zone(team: Faction): V3 { return this.bases[team][0]; }
  /** Spawn spot i inside the team's start building. */
  spawnAt(team: Faction, i: number): V3 { const l = this.bases[team]; return l[i % l.length]; }

  say(text: string, team?: 'us' | 'ins') { this.log.push({ t: this.g.time, text, team }); if (this.log.length > 30) this.log.shift(); }
  onDown(v: Soldier, by: Soldier | null, killed: boolean) {
    if (killed) { if (v.deathCounted) return; v.deathCounted = true; }
    if (by && by !== v && by.team !== v.team && killed) by.kills++;
  }
  onExplosion() { /* no objectives */ }
  spot() { /* no caches */ }

  private standing(team: Faction) { return this.g.soldiers.filter((s) => s.team === team && s.state === 'alive').length; }

  update(dt: number) {
    if (this.over) return;
    if (this.phase === 'live') {
      this.elapsed += dt;
      const us = this.standing('us'), ins = this.standing('ins');
      let w: Faction | 'draw' | null = null;
      if (us === 0 && ins === 0) w = 'draw'; else if (us === 0) w = 'ins'; else if (ins === 0) w = 'us';
      if (w) {
        if (w !== 'draw') this.score[w]++;
        this.say(w === 'draw' ? `Round ${this.round}: draw` : `Round ${this.round}: ${w === 'us' ? 'US Army' : 'Insurgents'} win (${this.score.us}–${this.score.ins})`, w === 'draw' ? undefined : w);
        this.phase = 'end'; this.endT = 6;
        if (this.score.us >= ROUNDS_TO_WIN) this.over = 'us'; else if (this.score.ins >= ROUNDS_TO_WIN) this.over = 'ins';
      }
    } else {
      this.endT -= dt;
      if (this.endT <= 0) { this.round++; this.phase = 'live'; this.elapsed = 0; this.onRound(); this.say(`Round ${this.round} — fight!`); }
    }
  }

  hudTop() {
    const t = this.elapsed, mm = Math.floor(t / 60), ss = Math.floor(t % 60).toString().padStart(2, '0');
    return `<span>ROUND <b>${this.round}</b></span><span>US <b>${this.score.us}</b> : <b>${this.score.ins}</b> INS</span><span>ALIVE <b>${this.standing('us')}</b> v <b>${this.standing('ins')}</b></span><span>${mm}:${ss}</span>`;
  }
}

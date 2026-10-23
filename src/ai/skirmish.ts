// Bots for the close-quarters test mode: a US fireteam of four (the player leads it when on the US side) against an
// insurgent cell of five (the player is one of them on that side). The team brains (ai/team.ts) run the tactics:
// the fireteam moves in formation on the insurgents' houses, reacts to contact and flanks; the cell waits in ambush
// at the windows, shoots and scoots, stalks and falls back. A team that has not heard a shot for a while hunts.
import type { Game } from '../game/game';
import type { Skirmish } from '../game/skirmish';
import { kitById, type Faction } from '../game/data/kits';
import { Bot } from './bot';
import { safeSpawn, type Nav } from './nav';
import { Cell, Fireteam } from './team';

const KITS: Record<Faction, string[]> = { us: ['us_sl', 'us_ar', 'us_gren', 'us_rifle'], ins: ['ins_cell', 'ins_rpk', 'ins_at', 'ins_rifle', 'ins_rifle2'] };
const NAMES: Record<Faction, string[]> = { us: ['Sgt. Brooks', 'Spc. Miller', 'Cpl. Garcia', 'PFC Davis'], ins: ['Abu Bakr', 'Omar', 'Khalid', 'Yusuf', 'Hamza'] };

export class SkirmishDirector {
  bots = new Map<number, Bot>();
  fireteam: Fireteam | null = null; cell: Cell | null = null;
  constructor(private g: Game, private mode: Skirmish, private nav: Nav | null, private playerTeam: Faction | null) {}

  /** Clear the field (bots and corpses) and spawn this round's bots and their team brains. */
  startRound() {
    const g = this.g;
    for (const s of [...g.soldiers]) if (!s.isPlayer) { this.bots.delete(s.id); g.remove(s); }
    for (const c of g.corpses) c.dispose();
    g.corpses.length = 0; g.claims.clear(); g.contacts.us.clear(); g.contacts.ins.clear();
    const teams: Record<Faction, Bot[]> = { us: [], ins: [] };
    for (const team of ['us', 'ins'] as Faction[]) {
      // The player takes the leader's place on their own team (spot 0 of the start building).
      const kits = team === this.playerTeam ? KITS[team].slice(1) : KITS[team], names = team === this.playerTeam ? NAMES[team].slice(1) : NAMES[team];
      kits.forEach((kid, i) => {
        const p = safeSpawn(g.P, this.nav, this.mode.spawnAt(team, i + (team === this.playerTeam ? 1 : 0)), 1.5);
        const s = g.spawn(kitById(kid), team, p, names[i], team === 'us' ? -Math.PI / 2 : Math.PI / 2);
        const bot = new Bot(g, s, this.nav, { kind: 'hold', pos: p }, 0.6 + Math.random() * 0.25);
        this.bots.set(s.id, bot); teams[team].push(bot);
      });
    }
    const usZone = this.mode.zone('us'), insZone = this.mode.zone('ins');
    this.fireteam = new Fireteam(g, this.nav, 'us', teams.us, insZone);
    this.cell = new Cell(g, this.nav, 'ins', teams.ins, insZone, usZone);
    const say = (team: Faction) => (t: string) => { if (team === this.playerTeam || !this.playerTeam) this.mode.say(t, team); };
    this.fireteam.say = say('us'); this.cell.say = say('ins');
    g.fireteam = this.playerTeam === 'us' ? this.fireteam : null;
  }

  update(dt: number) {
    if (this.nav) this.nav.budget = 6;
    this.fireteam?.update(dt); this.cell?.update(dt);
    for (const b of this.bots.values()) b.update(dt);
  }
}

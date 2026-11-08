// Sandbox: the whole map to yourself for testing. No squads, cells, IEDs or ATGM teams; the motor pool at the FOB is
// empty and open to either side (any kit may take any seat; an AI crew joins whoever gets in). The tools panel (`)
// spawns targets where you look: standing dummies or fighters of either side, a row of dummies, an insurgent squad,
// empty or AI-crewed vehicles; and gives god mode, heal, refill, repair, teleport and clear-up. Every hit you land is
// logged (part, damage, range) so weapons, wounds, ragdolls and blasts can be checked.
import type { Game } from './game';
import type { GameMode } from './mode';
import type { Soldier } from './soldier';
import type { V3 } from './projectiles';
import type { Nav } from '../ai/nav';
import { safeSpawn } from '../ai/nav';
import { Bot } from '../ai/bot';
import { kitById, type Faction } from './data/kits';
import type { Input } from '../core/input';
import { G_VEH, G_WORLD } from '../world/physics';
import { gridRef } from '../world/terrain';

const INS_KITS = ['ins_rifle', 'ins_rifle2', 'ins_at', 'ins_rpk', 'ins_mg', 'ins_cell', 'ins_marks'];
const US_KITS = ['us_rifle', 'us_ar', 'us_gren', 'us_sl', 'us_mg'];

export class SandboxMode implements GameMode {
  kind = 'sandbox' as const;
  log: { t: number; text: string; team?: 'us' | 'ins' }[] = [];
  over: null | 'us' | 'ins' = null;
  timeLeft = Infinity;
  /** Soldiers spawned from the panel (and their bots, for fighters). */
  spawned: Soldier[] = [];
  bots = new Map<number, Bot>();
  private n = 0;

  constructor(private g: Game, private nav: Nav | null) {
    g.sandbox = true;
    g.events.onHit = (v, part, dmg, by, p) => {
      if (!by.isPlayer) return;
      const d = Math.hypot(p[0] - by.eye[0], p[1] - by.eye[1], p[2] - by.eye[2]);
      this.say(`Hit ${v.name}: ${part.toUpperCase()} — ${Math.round(dmg)} dmg${part === 'head' ? ' (×4.5)' : ''} at ${Math.round(d)} m · health ${Math.max(0, Math.round(v.health))}${v.state === 'wounded' ? ' · DOWN' : v.state === 'dead' ? ' · KILLED' : ''}`);
    };
  }

  say(text: string, team?: 'us' | 'ins') { this.log.push({ t: this.g.time, text, team }); if (this.log.length > 40) this.log.shift(); }
  onDown(v: Soldier, by: Soldier | null, killed: boolean) { if (!v.isPlayer) this.say(`${v.name} ${killed ? 'killed' : 'down'}${by ? ` by ${by.isPlayer ? 'you' : by.name}` : ''}`); }
  onExplosion(p: V3, ammoId: string, by: Soldier | null) { if (by?.isPlayer) this.say(`${ammoId.toUpperCase()} burst at ${gridRef(p[0], p[2])}`); }
  spot() { /* no objectives */ }
  hudTop() { return `<b>SANDBOX</b> · <span style="opacity:.75">\` tools · targets ${this.spawned.filter((s) => s.alive).length}</span>`; }

  update(dt: number) {
    for (const b of this.bots.values()) b.update(dt);
    // Bodies are cleared a minute after death (and their bots).
    for (const s of [...this.spawned]) if (s.state === 'dead' && s.deadT > 60) { this.bots.delete(s.id); this.spawned.splice(this.spawned.indexOf(s), 1); if (this.g.soldiers.includes(s)) this.g.remove(s); }
  }

  /** A soldier at p facing `face`: a standing dummy, or a fighter (a bot that defends that spot and shoots back). */
  spawn(team: Faction, p: V3, face: number, fighter: boolean, kitId?: string): Soldier {
    const kit = kitById(kitId ?? (team === 'ins' ? INS_KITS[this.n % INS_KITS.length] : US_KITS[this.n % US_KITS.length]));
    const q = safeSpawn(this.g.P, this.nav, p, 2);
    const s = this.g.spawn(kit, team, q, `${team === 'ins' ? 'Insurgent' : 'US'} ${fighter ? 'fighter' : 'target'} ${++this.n}`, face);
    s.squad = 300;
    this.spawned.push(s);
    if (fighter) this.bots.set(s.id, new Bot(this.g, s, this.nav, { kind: 'defend', pos: q, stance: 'stand', facing: face }, 0.6));
    return s;
  }

  clearSoldiers() {
    for (const s of this.spawned) if (this.g.soldiers.includes(s)) this.g.remove(s);
    this.spawned = []; this.bots.clear();
  }
}

/** The sandbox tools panel (` key): acts at the point the player was looking at when it opened. */
export class SandboxTools {
  el: HTMLDivElement;
  open = false;
  private at: V3 | null = null; private face = 0;
  private extraVeh: import('../vehicles/vehicle').Vehicle[] = [];

  constructor(host: HTMLElement, private g: Game, private mode: SandboxMode, private input: Input, private me: () => Soldier | null, private switchSide: () => void) {
    this.el = document.createElement('div'); this.el.className = 'sandbox';
    const B = (id: string, label: string) => `<button data-a="${id}">${label}</button>`;
    this.el.innerHTML = `<div class="sb-box"><h2>SANDBOX TOOLS</h2><div class="sb-at"></div>
      <h3>Targets where you looked</h3><div class="sb-row">${B('ins_dummy', 'Insurgent — standing target')}${B('ins_fighter', 'Insurgent — fighter')}${B('ins_row', '5 insurgent targets in a row')}${B('ins_squad', 'Insurgent squad ×6 (fighters)')}${B('ins_at', 'Insurgent RPG gunner (fighter)')}</div>
      <div class="sb-row">${B('us_dummy', 'US soldier — standing target')}${B('us_fighter', 'US soldier — fighter')}${B('us_row', '5 US targets in a row')}</div>
      <h3>Vehicles where you looked</h3><div class="sb-row">${B('m1a2', 'M1A2 Abrams (empty)')}${B('m2a3', 'M2A3 Bradley (empty)')}${B('m1a2_crew', 'M1A2 with AI crew (fights)')}${B('m2a3_crew', 'M2A3 with AI crew (fights)')}</div>
      <h3>You</h3><div class="sb-row">${B('god', 'God mode: OFF')}${B('heal', 'Heal')}${B('refill', 'Refill ammunition')}${B('tp', 'Teleport there')}${B('side', 'Switch side / kit (respawn)')}</div>
      <h3>Clean-up</h3><div class="sb-row">${B('repair', 'Repair all vehicles')}${B('clear', 'Remove spawned soldiers')}${B('clearveh', 'Remove spawned vehicles')}</div>
      <div class="sb-row"><button class="big" data-a="close">BACK TO THE GAME (\`)</button></div>
      <p class="sb-hint">Hits you land are logged top left (body part, damage, range). Vehicles: any kit can take any seat in the sandbox; F to get in, F1–F9 seats.</p></div>`;
    host.appendChild(this.el);
    this.el.style.display = 'none';
    this.el.addEventListener('click', (e) => { const a = (e.target as HTMLElement).dataset?.a; if (a) this.act(a); });
    addEventListener('keydown', (e) => { if (e.code === 'Backquote') { e.preventDefault(); this.toggle(); } });
  }

  toggle(v = !this.open) {
    const me = this.me();
    if (v) {
      // The point under the view centre (soldier or vehicle seat).
      const cam = this.g.gfx.camera, o: V3 = [cam.position.x, cam.position.y, cam.position.z];
      const d = cam.getWorldDirection(cam.position.clone().set(0, 0, 0));
      const h = this.g.P.castRay([o[0] + d.x * 2, o[1] + d.y * 2, o[2] + d.z * 2], [d.x, d.y, d.z], 1500, G_WORLD | G_VEH);
      this.at = h ? [h.point[0], h.point[1], h.point[2]] : [o[0] + d.x * 30, o[1], o[2] + d.z * 30];
      this.face = Math.atan2(d.x, d.z); // facing back towards the viewer
      (this.el.querySelector('.sb-at') as HTMLElement).textContent = `Point: ${gridRef(this.at[0], this.at[2])} · ${me ? Math.round(Math.hypot(this.at[0] - me.pos[0], this.at[2] - me.pos[2])) : '?'} m away`;
      (this.el.querySelector('[data-a=god]') as HTMLElement).textContent = `God mode: ${me?.god ? 'ON' : 'OFF'}`;
      this.input.unlock();
    } else this.input.lock();
    this.open = v; this.el.style.display = v ? 'grid' : 'none';
  }

  private act(a: string) {
    const g = this.g, m = this.mode, me = this.me(), at = this.at, f = this.face;
    const row = (team: Faction) => { if (!at) return; const rx = Math.cos(f), rz = -Math.sin(f); for (let i = -2; i <= 2; i++) m.spawn(team, [at[0] + rx * i * 2, at[1], at[2] + rz * i * 2], f, false); };
    const veh = async (id: string, crewed: boolean) => {
      if (!at || !g.crews) return;
      await g.crews.load([id]);
      const v = g.crews.add(id, at[0], at[2], f + Math.PI, crewed);
      if (v) this.extraVeh.push(v);
    };
    switch (a) {
      case 'ins_dummy': if (at) m.spawn('ins', at, f, false); break;
      case 'ins_fighter': if (at) m.spawn('ins', at, f, true); break;
      case 'ins_at': if (at) m.spawn('ins', at, f, true, 'ins_at'); break;
      case 'ins_row': row('ins'); break;
      case 'ins_squad': if (at) for (let i = 0; i < 6; i++) m.spawn('ins', [at[0] + (i % 3 - 1) * 3, at[1], at[2] + Math.floor(i / 3) * 3], f, true); break;
      case 'us_dummy': if (at) m.spawn('us', at, f, false); break;
      case 'us_fighter': if (at) m.spawn('us', at, f, true); break;
      case 'us_row': row('us'); break;
      case 'm1a2': void veh('m1a2', false); break;
      case 'm2a3': void veh('m2a3', false); break;
      case 'm1a2_crew': void veh('m1a2', true); break;
      case 'm2a3_crew': void veh('m2a3', true); break;
      case 'god': if (me) { me.god = !me.god; (this.el.querySelector('[data-a=god]') as HTMLElement).textContent = `God mode: ${me.god ? 'ON' : 'OFF'}`; } return;
      case 'heal': if (me) { if (me.state === 'wounded') me.revive(); me.health = 100; me.bleed = 0; m.say('Healed.'); } break;
      case 'refill': if (me) { me.rearm(); m.say('Ammunition refilled.'); } break;
      case 'tp': if (me && at && !me.vehicle) { const q = safeSpawn(g.P, null, [at[0], at[1] + 0.2, at[2]], 2); me.pos = [...q]; me.body.setTranslation({ x: q[0], y: q[1] + 0.9, z: q[2] }, true); me.vel = [0, 0, 0]; } break;
      case 'side': this.toggle(false); this.switchSide(); return;
      case 'repair': for (const v of g.vehicles) if (!v.dead) { v.integrity = 100; v.burning = v.tracked = v.engineOut = v.turretJam = false; v.smoke = v.def.smoke; v.mounts.forEach((mt) => { mt.ready = [...mt.def.ready]; mt.stowed = [...mt.def.stowed]; }); } m.say('Vehicles repaired and rearmed.'); break;
      case 'clear': m.clearSoldiers(); m.say('Spawned soldiers removed.'); break;
      case 'clearveh': for (const v of this.extraVeh) g.crews?.remove(v); this.extraVeh = []; m.say('Spawned vehicles removed.'); break;
      case 'close': this.toggle(false); return;
    }
    if (a !== 'heal' && a !== 'refill' && a !== 'clear' && a !== 'clearveh' && a !== 'repair' && a !== 'tp') m.say(`Spawned ${a.replace('_', ' ')} at ${at ? gridRef(at[0], at[2]) : '?'}`);
    this.toggle(false);
  }
}

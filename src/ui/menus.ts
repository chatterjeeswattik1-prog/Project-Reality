// Main menu, spawn screen (kit + spawn point on the map), scoreboard and the end-of-round screen.
import { KITS, type Faction, type Kit } from '../game/data/kits';
import { WEAPONS } from '../game/data/weapons';
import type { Game } from '../game/game';
import type { Soldier } from '../game/soldier';
import { MapView } from './map';
import { CACHES_TO_WIN } from '../game/insurgency';
import { MAP } from '../world/terrain';

export interface MenuChoice { faction: Faction; quality: 'low' | 'medium' | 'high'; sens: number; fov: number; mode: 'insurgency' | 'test' | 'sandbox' | 'multiplayer'; name?: string }

export function mainMenu(host: HTMLElement, gpu: string): Promise<MenuChoice> {
  const el = document.createElement('div'); el.className = 'menu';
  const saved = (() => { try { return JSON.parse(localStorage.getItem('pr.settings') ?? '{}'); } catch { return {}; } })();
  el.innerHTML = `<div class="menu-box">
    <h1>PROJECT REALISM</h1><div class="sub">INSURGENCY · AL ZAHRAN · 1.3 KM</div>
    <p class="brief">US Army forces at FOB Hammer must locate and destroy the insurgents' hidden weapons caches in Al Zahran. Intel from engagements reveals cache areas. Only C4 destroys a cache. Every US soldier lost costs a ticket.</p>
    <div class="row"><button data-f="us" class="big">Join US Army</button><button data-f="ins" class="big ins">Join Insurgents</button></div>
    <div class="opts">
      <label>Mode <select name="mode"><option value="test">Close-quarters test · 3 v 3 · small area (light)</option><option value="insurgency">Insurgency · full map</option><option value="sandbox">Sandbox · full map to yourself: spawn targets and vehicles, either side (testing)</option><option value="multiplayer">Multiplayer · the one online match, up to 20 players (host it if nobody is)</option></select></label>
      <label class="mpname">Your name <input name="name" maxlength="20" placeholder="Soldier"></label>
      <label>Graphics <select name="q"><option value="low">Low (integrated GPU)</option><option value="medium">Medium</option><option value="high">High</option></select></label>
      <label>Mouse sensitivity <input name="sens" type="range" min="0.5" max="3" step="0.1"></label>
      <label>Field of view <input name="fov" type="range" min="45" max="75" step="1"> <span class="fovv"></span>°</label>
    </div>
    <div class="keys"><b>Controls</b> WASD move · Shift sprint · Ctrl/C crouch · Z prone · Space jump · RMB aim · LMB fire · R reload · B fire mode · 1–5 weapons (press 1 again for M203; PgUp / PgDn sets its quadrant sight range) · Q / E lean (hold) · Alt freelook (hold) · F doors, else field dressing · T weapon light · G bipod (prone, window sill, wall top) · Shift while aiming hold breath · Y team move there · H team hold / form up · U team suppress there · M map · Tab score · Enter give up when wounded · Esc menu<br><b>Vehicles</b> F get in / out · F1–F9 seats · driver WASD · gunner: mouse aims, LMB fire, 1 sabot · 2 HE · 3 coax · 4 TOW, RMB zoom, R laser range, T thermal, G smoke · Y / H order the AI driver<br><b>Sandbox</b> \` (key left of 1) tools: spawn targets and vehicles where you look, god mode, heal, refill, teleport</div>
    <div class="gpu">Rendering on: ${gpu}</div>
    <div class="gpu">Credits: running animation <a href="https://sketchfab.com/3d-models/rida-sidi-ben-ali-running-487e9e949e4a4ea3a8fd59df7e842830" target="_blank" rel="noopener">“Rida sidi ben ali Running”</a> by Rida.Sidi.Ben.Ali and blood shape <a href="https://sketchfab.com/3d-models/cc0-color-spot-2-f0c6c040b86f4b42af3b3b49b9e6a23b" target="_blank" rel="noopener">“Color Spot 2”</a> by plaggy, the M1A2 <a href="https://sketchfab.com/3d-models/abrams-m1a2-0e98541f6f684311ac7a8abe08c9449e" target="_blank" rel="noopener">“abrams m1a2”</a> by coderslava402 and the M2A3 <a href="https://sketchfab.com/3d-models/m2-bradley-ifv-ab022158ab5f4fbfa55d4142db7595ab" target="_blank" rel="noopener">“M2 Bradley IFV”</a> by 42manako, the pistol arms <a href="https://sketchfab.com/3d-models/fps-pistol-animations-0d7a343dcb6f401197a73c91aee93f6d" target="_blank" rel="noopener">“FPS pistol animations”</a> by Cransh, all <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>. Other assets CC0 (Poly Haven, ambientCG, Quaternius, Freesound) — see the CREDITS.txt files.</div>
  </div>`;
  host.appendChild(el);
  const md = el.querySelector('select[name=mode]') as HTMLSelectElement;
  md.value = saved.mode ?? 'test';
  const q = el.querySelector('select[name=q]') as HTMLSelectElement, sens = el.querySelector('input[name=sens]') as HTMLInputElement, fov = el.querySelector('input[name=fov]') as HTMLInputElement, fovv = el.querySelector('.fovv') as HTMLElement;
  q.value = saved.quality ?? new URLSearchParams(location.search).get('q') ?? 'low'; sens.value = String(saved.sens ?? 1); fov.value = String(saved.fov ?? 55);
  fovv.textContent = fov.value; fov.oninput = () => { fovv.textContent = fov.value; };
  const nm = el.querySelector('input[name=name]') as HTMLInputElement, nl = el.querySelector('.mpname') as HTMLElement;
  nm.value = saved.name ?? '';
  const showName = () => { nl.style.display = md.value === 'multiplayer' ? '' : 'none'; };
  md.onchange = showName; showName();
  return new Promise((res) => el.querySelectorAll('button[data-f]').forEach((b) => b.addEventListener('click', () => {
    const c: MenuChoice = { faction: (b as HTMLElement).dataset.f as Faction, quality: q.value as MenuChoice['quality'], sens: Number(sens.value), fov: Number(fov.value), mode: md.value as MenuChoice['mode'], name: nm.value.trim().slice(0, 20) || 'Soldier' };
    try { localStorage.setItem('pr.settings', JSON.stringify({ quality: c.quality, sens: c.sens, fov: c.fov, mode: c.mode, name: c.name })); } catch { /* private mode */ }
    el.remove(); res(c);
  })));
}

export interface SpawnPoint { id: string; label: string; x: number; z: number; pos: [number, number, number] }

export class SpawnScreen {
  el: HTMLDivElement; private cv: HTMLCanvasElement; private kitList: HTMLDivElement; private btn: HTMLButtonElement; private info: HTMLDivElement;
  kit!: Kit; spawn: SpawnPoint | null = null;
  waitUntil = 0;
  /** Sandbox: a spawn point clicked anywhere on the map. */
  private custom: SpawnPoint | null = null;
  private resolve: ((v: { kit: Kit; spawn: SpawnPoint; faction: Faction }) => void) | null = null;
  /**
   * `opts.both`: the side can be chosen (sandbox); `opts.anywhere`: a click anywhere on the map is a spawn point, with
   * `ground` giving the height there.
   */
  constructor(host: HTMLElement, private g: Game, private base: HTMLCanvasElement, public faction: Faction, private points: () => SpawnPoint[], opts: { both?: boolean; anywhere?: boolean; ground?: (x: number, z: number) => number } = {}) {
    this.el = document.createElement('div'); this.el.className = 'spawn';
    const sides = opts.both ? `<div class="sp-sides"><button data-f="us">US ARMY</button><button data-f="ins">INSURGENTS</button></div>` : '';
    this.el.innerHTML = `<div class="sp-left"><h2></h2>${sides}<div class="kits"></div><div class="sp-info"></div><button class="big deploy">DEPLOY</button></div><div class="sp-map"><canvas></canvas><div class="hint">${opts.anywhere ? 'Click anywhere on the map to spawn there' : 'Click a spawn point'}</div></div>`;
    host.appendChild(this.el);
    this.cv = this.el.querySelector('canvas')!; this.kitList = this.el.querySelector('.kits')!; this.btn = this.el.querySelector('.deploy')!; this.info = this.el.querySelector('.sp-info')!;
    this.el.querySelectorAll('.sp-sides button').forEach((b) => b.addEventListener('click', () => this.setFaction((b as HTMLElement).dataset.f as Faction)));
    this.setFaction(faction);
    this.cv.addEventListener('click', (e) => {
      // The map sheet is MAP (square, centred on the AO).
      const r = this.cv.getBoundingClientRect();
      const wx = MAP.cx - MAP.half + ((e.clientX - r.left) / r.width) * 2 * MAP.half, wz = MAP.cz - MAP.half + ((e.clientY - r.top) / r.height) * 2 * MAP.half;
      let best: SpawnPoint | null = null, bd = 60;
      for (const p of this.points()) { const d = Math.hypot(p.x - wx, p.z - wz); if (d < bd) { bd = d; best = p; } }
      if (!best && opts.anywhere) best = this.custom = { id: 'custom', label: 'Here', x: wx, z: wz, pos: [wx, (opts.ground?.(wx, wz) ?? 0) + 0.3, wz] };
      if (best) { this.spawn = best; this.refresh(); }
    });
    this.btn.onclick = () => { if (this.ready() && this.resolve) { const r = this.resolve; this.resolve = null; this.hide(); r({ kit: this.kit, spawn: this.spawn!, faction: this.faction }); } };
    this.el.style.display = 'none';
  }
  /** Show the kits of one side. */
  setFaction(f: Faction) {
    this.faction = f;
    (this.el.querySelector('.sp-left h2') as HTMLElement).textContent = f === 'us' ? 'US ARMY · ALPHA SQUAD' : 'INSURGENTS';
    this.el.querySelectorAll('.sp-sides button').forEach((b) => b.classList.toggle('sel', (b as HTMLElement).dataset.f === f));
    const kits = KITS.filter((k) => k.faction === f);
    if (!this.kit || this.kit.faction !== f) this.kit = kits.find((k) => k.role === 'rifleman')!;
    this.kitList.innerHTML = '';
    for (const k of kits) {
      const b = document.createElement('button'); b.className = 'kit';
      b.innerHTML = `<b>${k.name}</b><span>${k.items.map((i) => WEAPONS[i.weapon].name).join(' · ')}</span>`;
      b.onclick = () => { this.kit = k; this.refresh(); };
      this.kitList.appendChild(b); (b as HTMLButtonElement & { kit?: Kit }).kit = k;
    }
    if (this.spawn && this.spawn.id !== 'custom' && !this.points().some((p) => p.id === this.spawn!.id)) this.spawn = this.points()[0] ?? null;
    // Choosing a side (sandbox) picks its home: the FOB for the Americans, the insurgent base for the insurgents.
    if (this.spawn?.id === 'fob' || this.spawn?.id === 'base') this.spawn = this.points().find((p) => p.id === (f === 'us' ? 'fob' : 'base')) ?? this.spawn;
    this.refresh();
  }
  private all(): SpawnPoint[] { return this.custom ? [...this.points(), this.custom] : this.points(); }
  private ready() { return !!this.spawn && this.g.time >= this.waitUntil && this.all().some((p) => p.id === this.spawn!.id); }
  private refresh() {
    this.kitList.querySelectorAll('button').forEach((b) => b.classList.toggle('sel', (b as HTMLButtonElement & { kit?: Kit }).kit === this.kit));
    const w = Math.max(0, Math.ceil(this.waitUntil - this.g.time));
    this.btn.textContent = w > 0 ? `DEPLOY IN ${w}` : this.spawn ? `DEPLOY AT ${this.spawn.label.toUpperCase()}` : 'SELECT A SPAWN POINT';
    this.btn.disabled = !this.ready();
    const k = this.kit;
    this.info.innerHTML = `<b>${k.name}</b><ul>${k.items.map((i) => { const d = WEAPONS[i.weapon]; return `<li>${d.name} <i>×${i.count}</i></li>`; }).join('')}<li>Field dressings <i>×${k.bandages}</i></li></ul>`;
  }
  show(waitSeconds: number): Promise<{ kit: Kit; spawn: SpawnPoint; faction: Faction }> {
    this.waitUntil = this.g.time + waitSeconds;
    const pts = this.all();
    if (!this.spawn || !pts.some((p) => p.id === this.spawn!.id)) this.spawn = pts[0] ?? null;
    this.el.style.display = 'flex'; this.refresh();
    return new Promise((r) => { this.resolve = r; });
  }
  hide() { this.el.style.display = 'none'; }
  get visible() { return this.el.style.display !== 'none'; }
  update(me: Soldier | null) {
    if (!this.visible) return;
    const s = Math.min(innerHeight * 0.9, innerWidth - 420);
    if (this.cv.width !== Math.round(s)) { this.cv.width = this.cv.height = Math.round(s); this.cv.style.width = this.cv.style.height = `${Math.round(s)}px`; }
    MapView.draw(this.cv, this.base, this.g, me, this.all().map((p) => ({ x: p.x, z: p.z, label: p.label, sel: p.id === this.spawn?.id })));
    this.refresh();
    void this.faction;
  }
}

export function scoreboard(host: HTMLElement) {
  const el = document.createElement('div'); el.className = 'score'; el.style.display = 'none'; host.appendChild(el);
  return {
    show(g: Game, v: boolean) {
      el.style.display = v ? 'flex' : 'none';
      if (!v) return;
      const col = (team: Faction) => g.soldiers.filter((s) => s.team === team).sort((a, b) => b.score + b.kills * 10 - (a.score + a.kills * 10)).map((s) => `<tr class="${s.isPlayer ? 'me' : ''} ${s.state}"><td>${s.name}</td><td>${s.kit.name}</td><td>${s.kills}</td><td>${s.deaths}</td><td>${s.state === 'alive' ? '' : s.state === 'wounded' ? 'WOUNDED' : 'KIA'}</td></tr>`).join('');
      const m = g.mode as unknown as { tickets?: number; destroyed?: number };
      el.innerHTML = `<div class="sc-col"><h3>US ARMY${m.tickets !== undefined ? ` · ${m.tickets} tickets` : ''}</h3><table><tr><th>Name</th><th>Kit</th><th>K</th><th>D</th><th></th></tr>${col('us')}</table></div><div class="sc-col"><h3>INSURGENTS${m.destroyed !== undefined ? ` · caches lost ${m.destroyed}/${CACHES_TO_WIN}` : ''}</h3><table><tr><th>Name</th><th>Kit</th><th>K</th><th>D</th><th></th></tr>${col('ins')}</table></div>`;
    },
  };
}

export function endScreen(host: HTMLElement, winner: 'us' | 'ins', mine: Faction) {
  const el = document.createElement('div'); el.className = 'menu';
  const won = winner === mine;
  el.innerHTML = `<div class="menu-box"><h1>${won ? 'VICTORY' : 'DEFEAT'}</h1><div class="sub">${winner === 'us' ? 'THE INSURGENT CACHES HAVE BEEN DESTROYED' : 'US FORCES HAVE WITHDRAWN FROM AL ZAHRAN'}</div><div class="row"><button class="big" onclick="location.reload()">Play again</button></div></div>`;
  host.appendChild(el);
}

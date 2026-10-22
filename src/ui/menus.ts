// Main menu, spawn screen (kit + spawn point on the map), scoreboard and the end-of-round screen.
import { KITS, type Faction, type Kit } from '../game/data/kits';
import { WEAPONS } from '../game/data/weapons';
import type { Game } from '../game/game';
import type { Soldier } from '../game/soldier';
import { MapView } from './map';
import { CACHES_TO_WIN } from '../game/insurgency';

export interface MenuChoice { faction: Faction; quality: 'low' | 'medium' | 'high'; sens: number; fov: number; mode: 'insurgency' | 'test' }

export function mainMenu(host: HTMLElement, gpu: string): Promise<MenuChoice> {
  const el = document.createElement('div'); el.className = 'menu';
  const saved = (() => { try { return JSON.parse(localStorage.getItem('pr.settings') ?? '{}'); } catch { return {}; } })();
  el.innerHTML = `<div class="menu-box">
    <h1>PROJECT REALISM</h1><div class="sub">INSURGENCY · AL ZAHRAN · 1.3 KM</div>
    <p class="brief">US Army forces at FOB Hammer must locate and destroy the insurgents' hidden weapons caches in Al Zahran. Intel from engagements reveals cache areas. Only C4 destroys a cache. Every US soldier lost costs a ticket.</p>
    <div class="row"><button data-f="us" class="big">Join US Army</button><button data-f="ins" class="big ins">Join Insurgents</button></div>
    <div class="opts">
      <label>Mode <select name="mode"><option value="test">Close-quarters test · 3 v 3 · small area (light)</option><option value="insurgency">Insurgency · full map</option></select></label>
      <label>Graphics <select name="q"><option value="low">Low (integrated GPU)</option><option value="medium">Medium</option><option value="high">High</option></select></label>
      <label>Mouse sensitivity <input name="sens" type="range" min="0.5" max="3" step="0.1"></label>
      <label>Field of view <input name="fov" type="range" min="45" max="75" step="1"> <span class="fovv"></span>°</label>
    </div>
    <div class="keys"><b>Controls</b> WASD move · Shift sprint · Ctrl/C crouch · Z prone · Space jump · RMB aim · LMB fire · R reload · B fire mode · 1–5 weapons (press 1 again for M203) · F field dressing · E use / doors · T weapon light · M map · Tab score · Enter give up when wounded · Esc menu</div>
    <div class="gpu">Rendering on: ${gpu}</div>
  </div>`;
  host.appendChild(el);
  const md = el.querySelector('select[name=mode]') as HTMLSelectElement;
  md.value = saved.mode ?? 'test';
  const q = el.querySelector('select[name=q]') as HTMLSelectElement, sens = el.querySelector('input[name=sens]') as HTMLInputElement, fov = el.querySelector('input[name=fov]') as HTMLInputElement, fovv = el.querySelector('.fovv') as HTMLElement;
  q.value = saved.quality ?? new URLSearchParams(location.search).get('q') ?? 'low'; sens.value = String(saved.sens ?? 1); fov.value = String(saved.fov ?? 55);
  fovv.textContent = fov.value; fov.oninput = () => { fovv.textContent = fov.value; };
  return new Promise((res) => el.querySelectorAll('button[data-f]').forEach((b) => b.addEventListener('click', () => {
    const c: MenuChoice = { faction: (b as HTMLElement).dataset.f as Faction, quality: q.value as MenuChoice['quality'], sens: Number(sens.value), fov: Number(fov.value), mode: md.value as MenuChoice['mode'] };
    try { localStorage.setItem('pr.settings', JSON.stringify({ quality: c.quality, sens: c.sens, fov: c.fov, mode: c.mode })); } catch { /* private mode */ }
    el.remove(); res(c);
  })));
}

export interface SpawnPoint { id: string; label: string; x: number; z: number; pos: [number, number, number] }

export class SpawnScreen {
  el: HTMLDivElement; private cv: HTMLCanvasElement; private kitList: HTMLDivElement; private btn: HTMLButtonElement; private info: HTMLDivElement;
  kit: Kit; spawn: SpawnPoint | null = null;
  waitUntil = 0;
  private resolve: ((v: { kit: Kit; spawn: SpawnPoint }) => void) | null = null;
  constructor(host: HTMLElement, private g: Game, private base: HTMLCanvasElement, private faction: Faction, private points: () => SpawnPoint[]) {
    this.el = document.createElement('div'); this.el.className = 'spawn';
    this.el.innerHTML = `<div class="sp-left"><h2>${faction === 'us' ? 'US ARMY · ALPHA SQUAD' : 'INSURGENTS'}</h2><div class="kits"></div><div class="sp-info"></div><button class="big deploy">DEPLOY</button></div><div class="sp-map"><canvas></canvas><div class="hint">Click a spawn point</div></div>`;
    host.appendChild(this.el);
    this.cv = this.el.querySelector('canvas')!; this.kitList = this.el.querySelector('.kits')!; this.btn = this.el.querySelector('.deploy')!; this.info = this.el.querySelector('.sp-info')!;
    const kits = KITS.filter((k) => k.faction === faction);
    this.kit = kits.find((k) => k.role === 'rifleman')!;
    for (const k of kits) {
      const b = document.createElement('button'); b.className = 'kit';
      b.innerHTML = `<b>${k.name}</b><span>${k.items.map((i) => WEAPONS[i.weapon].name).join(' · ')}</span>`;
      b.onclick = () => { this.kit = k; this.refresh(); };
      this.kitList.appendChild(b); (b as HTMLButtonElement & { kit?: Kit }).kit = k;
    }
    this.cv.addEventListener('click', (e) => {
      const r = this.cv.getBoundingClientRect(), wx = ((e.clientX - r.left) / r.width) * 1300 - 650, wz = ((e.clientY - r.top) / r.height) * 1300 - 650;
      let best: SpawnPoint | null = null, bd = 60;
      for (const p of this.points()) { const d = Math.hypot(p.x - wx, p.z - wz); if (d < bd) { bd = d; best = p; } }
      if (best) { this.spawn = best; this.refresh(); }
    });
    this.btn.onclick = () => { if (this.ready() && this.resolve) { const r = this.resolve; this.resolve = null; this.hide(); r({ kit: this.kit, spawn: this.spawn! }); } };
    this.el.style.display = 'none';
  }
  private ready() { return !!this.spawn && this.g.time >= this.waitUntil && this.points().some((p) => p.id === this.spawn!.id); }
  private refresh() {
    this.kitList.querySelectorAll('button').forEach((b) => b.classList.toggle('sel', (b as HTMLButtonElement & { kit?: Kit }).kit === this.kit));
    const w = Math.max(0, Math.ceil(this.waitUntil - this.g.time));
    this.btn.textContent = w > 0 ? `DEPLOY IN ${w}` : this.spawn ? `DEPLOY AT ${this.spawn.label.toUpperCase()}` : 'SELECT A SPAWN POINT';
    this.btn.disabled = !this.ready();
    const k = this.kit;
    this.info.innerHTML = `<b>${k.name}</b><ul>${k.items.map((i) => { const d = WEAPONS[i.weapon]; return `<li>${d.name} <i>×${i.count}</i></li>`; }).join('')}<li>Field dressings <i>×${k.bandages}</i></li></ul>`;
  }
  show(waitSeconds: number): Promise<{ kit: Kit; spawn: SpawnPoint }> {
    this.waitUntil = this.g.time + waitSeconds;
    const pts = this.points();
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
    MapView.draw(this.cv, this.base, this.g, me, this.points().map((p) => ({ x: p.x, z: p.z, label: p.label, sel: p.id === this.spawn?.id })));
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

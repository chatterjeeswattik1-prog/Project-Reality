// In-game HUD in the Project Reality style: no crosshair, magazine counts instead of rounds, a compass, stamina and
// bleeding indicators, damage direction, suppression and blast effects, and the optics' reticles.
import type { Game } from '../game/game';
import type { Player } from '../player/player';
import type { V3 } from '../game/projectiles';
import { gridRef } from '../world/terrain';

export class Hud {
  el: HTMLDivElement;
  cv: HTMLCanvasElement; x: CanvasRenderingContext2D;
  private weapon: HTMLDivElement; private status: HTMLDivElement; private log: HTMLDivElement; private center: HTMLDivElement; private top: HTMLDivElement; private down: HTMLDivElement;
  private flashT = 0;
  private hurts: { t: number; p: V3 }[] = [];
  private supp = 0; private blastV = 0;

  constructor(host: HTMLElement) {
    this.el = document.createElement('div'); this.el.className = 'hud';
    this.cv = document.createElement('canvas'); this.cv.className = 'hudcv';
    this.x = this.cv.getContext('2d')!;
    this.el.innerHTML = `<div class="h-weapon"></div><div class="h-status"></div><div class="h-log"></div><div class="h-center"></div><div class="h-top"></div><div class="h-down"></div>`;
    this.el.prepend(this.cv);
    host.appendChild(this.el);
    const q = (c: string) => this.el.querySelector(c) as HTMLDivElement;
    this.weapon = q('.h-weapon'); this.status = q('.h-status'); this.log = q('.h-log'); this.center = q('.h-center'); this.top = q('.h-top'); this.down = q('.h-down');
  }

  flash(text: string) { this.center.textContent = text; this.center.style.opacity = '1'; this.flashT = 2.2; }
  hurt(from: V3) { this.hurts.push({ t: 1.6, p: from }); }
  suppress(v: number) { this.supp = Math.max(this.supp, v); }
  blast(v: number) { this.blastV = Math.max(this.blastV, v); }

  update(dt: number, g: Game, p: Player) {
    const s = p.s, W = (this.cv.width = this.el.clientWidth), H = (this.cv.height = this.el.clientHeight), x = this.x;
    x.clearRect(0, 0, W, H);
    // Weapon box.
    const d = s.underSel ? null : s.weapon;
    const extra = s.slots.filter((k, i) => i !== s.cur && (k.def.kind === 'grenade' || k.def.kind === 'launcher' || k.def.kind === 'charge')).map((k) => `<span>${k.def.name.split(' ')[0]} ×${k.loaded + k.mags.length}</span>`).join('');
    this.weapon.innerHTML = s.alive ? `<b>${s.underSel ? 'M203 40 mm' : d!.name}</b><div class="ammo">${s.ammoText()}</div><div class="mode">${s.underSel ? 'SINGLE' : s.slot.mode.toUpperCase()}${s.reloadT > 0 ? ' · RELOADING' : ''}</div><div class="extra">${extra}<span>Field dressing ×${s.bandages}</span></div>` : '';
    // Status: stance, stamina, bleeding, grid.
    const st = s.stance === 'stand' ? '▮' : s.stance === 'crouch' ? '▬' : '▁';
    this.status.innerHTML = s.alive ? `<div class="stance">${st} ${s.stance.toUpperCase()}</div><div class="bar"><i style="width:${s.stamina}%"></i></div>${s.bleed > 0 ? `<div class="bleed">BLEEDING — press F</div>` : ''}${s.bandageT > 0 ? '<div class="bleed">Applying field dressing…</div>' : ''}<div class="grid">${gridRef(s.pos[0], s.pos[2])}</div>` : '';
    // Log.
    const m = g.mode;
    if (m) this.log.innerHTML = m.log.filter((l) => g.time - l.t < 14).slice(-6).map((l) => `<div class="${l.team ?? ''}">${l.text}</div>`).join('');
    if (m) this.top.innerHTML = m.hudTop();
    this.flashT -= dt; if (this.flashT <= 0) this.center.style.opacity = '0';
    // Wounded.
    if (s.state === 'wounded') this.down.innerHTML = `<h2>CRITICALLY WOUNDED</h2><p>Wait for a medic, or press <b>Enter</b> to give up. Bleed-out in ${Math.max(0, Math.ceil(300 - s.downT))} s</p>`;
    else if (s.state === 'dead') this.down.innerHTML = `<h2>KILLED IN ACTION</h2>`;
    else this.down.innerHTML = '';
    this.down.style.display = s.state === 'alive' ? 'none' : 'flex';

    // Scope.
    if (p.scoped()) this.scope(W, H, s.weapon.optic);
    // Settle indicator while aiming: a short bar under the sight that fills and turns green as the aim settles.
    if (s.alive && s.ads > 0.6 && s.weapon.optic !== 'none') {
      const k = s.settled(), bw = 64, bx = W / 2 - bw / 2, by = H / 2 + Math.min(W, H) * 0.2;
      x.fillStyle = 'rgba(0,0,0,0.35)'; x.fillRect(bx - 1, by - 1, bw + 2, 5);
      x.fillStyle = k > 0.92 ? 'rgba(110,210,110,0.9)' : `rgba(${Math.round(230 - k * 80)},${Math.round(150 + k * 50)},60,0.85)`;
      x.fillRect(bx, by, bw * k, 3);
    }
    // Compass strip.
    if (s.alive) this.compass(W, s.yaw);
    // Damage direction.
    for (const h of this.hurts) {
      h.t -= dt;
      const hp = h.p;
      const ang = Math.atan2(-(hp[0] - s.pos[0]), -(hp[2] - s.pos[2])) - s.yaw;
      x.save(); x.translate(W / 2, H / 2); x.rotate(-ang);
      x.strokeStyle = `rgba(190,30,20,${Math.min(1, h.t) * 0.8})`; x.lineWidth = 14; x.beginPath(); x.arc(0, 0, Math.min(W, H) * 0.28, -Math.PI / 2 - 0.35, -Math.PI / 2 + 0.35); x.stroke(); x.restore();
    }
    this.hurts = this.hurts.filter((h) => h.t > 0);
    // Health / blood vignette, suppression, blast.
    const hurt = s.alive ? Math.max(0, 1 - s.health / 100) : 0.8;
    this.supp = Math.max(this.supp * Math.exp(-dt * 0.8), s.suppress);
    const v = Math.min(0.85, hurt * 0.7 + this.supp * 0.5);
    if (v > 0.02) {
      const gr = x.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.max(W, H) * 0.7);
      gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, hurt > this.supp ? `rgba(90,0,0,${v})` : `rgba(0,0,0,${v})`);
      x.fillStyle = gr; x.fillRect(0, 0, W, H);
    }
    this.blastV *= Math.exp(-dt * 0.5);
    g.audio.muffle = Math.min(0.9, this.blastV * 1.2);
    if (this.blastV > 0.02) { x.fillStyle = `rgba(235,225,210,${this.blastV * 0.6})`; x.fillRect(0, 0, W, H); }
  }

  private compass(W: number, yaw: number) {
    const x = this.x, cx = W / 2, w = Math.min(520, W * 0.4), y = 22;
    const brg = ((-yaw * 180) / Math.PI + 360) % 360;
    x.save(); x.beginPath(); x.rect(cx - w / 2, 4, w, 34); x.clip();
    x.fillStyle = 'rgba(0,0,0,0.25)'; x.fillRect(cx - w / 2, 4, w, 34);
    x.font = '12px "Segoe UI", sans-serif'; x.textAlign = 'center'; x.fillStyle = 'rgba(232,226,210,0.9)'; x.strokeStyle = 'rgba(232,226,210,0.7)';
    const pxDeg = w / 120;
    for (let a = Math.floor(brg - 65); a <= brg + 65; a++) {
      const k = ((a % 360) + 360) % 360, px = cx + (a - brg) * pxDeg;
      if (k % 5 === 0) { x.beginPath(); x.moveTo(px, y + 6); x.lineTo(px, y + (k % 15 === 0 ? -2 : 3)); x.stroke(); }
      if (k % 45 === 0) x.fillText(({ 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' } as Record<number, string>)[k], px, y - 6);
      else if (k % 15 === 0) { x.font = '10px "Segoe UI", sans-serif'; x.fillText(String(k), px, y - 6); x.font = '12px "Segoe UI", sans-serif'; }
    }
    x.restore();
    x.fillStyle = '#c9a24a'; x.fillText(String(Math.round(brg) % 360).padStart(3, '0'), cx, 52);
  }

  private scope(W: number, H: number, optic: string) {
    const x = this.x, cx = W / 2, cy = H / 2, r = Math.min(W, H) * 0.46;
    // Black outside the eyepiece, soft edge.
    x.save(); x.fillStyle = '#000'; x.beginPath(); x.rect(0, 0, W, H); x.arc(cx, cy, r, 0, Math.PI * 2, true); x.fill();
    const gr = x.createRadialGradient(cx, cy, r * 0.82, cx, cy, r); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,0.9)'); x.fillStyle = gr; x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fill();
    x.restore();
    x.save(); x.translate(cx, cy);
    const u = r / 100;
    if (optic === 'acog') {
      // TA31: red chevron at the centre, BDC stadia below, thin crosshair lines.
      x.strokeStyle = 'rgba(10,10,10,0.9)'; x.lineWidth = 1.2;
      x.beginPath(); x.moveTo(-r, 0); x.lineTo(-r * 0.45, 0); x.moveTo(r * 0.45, 0); x.lineTo(r, 0); x.moveTo(0, r * 0.12); x.lineTo(0, r); x.stroke();
      for (let i = 1; i <= 5; i++) { const y = i * 9 * u, w = (12 - i * 1.6) * u; x.beginPath(); x.moveTo(-w / 2, y + 6 * u); x.lineTo(w / 2, y + 6 * u); x.stroke(); }
      x.fillStyle = 'rgba(230,40,30,0.95)'; x.beginPath(); x.moveTo(0, -0.5 * u); x.lineTo(-3.2 * u, 4.6 * u); x.lineTo(-2.2 * u, 4.6 * u); x.lineTo(0, 1.6 * u); x.lineTo(2.2 * u, 4.6 * u); x.lineTo(3.2 * u, 4.6 * u); x.closePath(); x.fill();
    } else if (optic === 'rco') {
      x.strokeStyle = 'rgba(10,10,10,0.9)'; x.lineWidth = 1.2;
      x.beginPath(); x.moveTo(-r, 0); x.lineTo(-r * 0.3, 0); x.moveTo(r * 0.3, 0); x.lineTo(r, 0); x.moveTo(0, -r); x.lineTo(0, -r * 0.3); x.stroke();
      x.fillStyle = 'rgba(230,40,30,0.95)'; x.beginPath(); x.moveTo(0, 0); x.lineTo(-3 * u, 4 * u); x.lineTo(3 * u, 4 * u); x.closePath(); x.fill();
      x.strokeStyle = 'rgba(230,40,30,0.9)'; x.beginPath(); x.moveTo(0, 4 * u); x.lineTo(0, 30 * u); x.stroke();
    } else if (optic === 'scope10') {
      // Leupold Mk4 mil-dot.
      x.strokeStyle = 'rgba(0,0,0,0.95)'; x.lineWidth = 1.2; x.beginPath(); x.moveTo(-r, 0); x.lineTo(r, 0); x.moveTo(0, -r); x.lineTo(0, r); x.stroke();
      x.lineWidth = 4; x.beginPath(); x.moveTo(-r, 0); x.lineTo(-r * 0.55, 0); x.moveTo(r * 0.55, 0); x.lineTo(r, 0); x.moveTo(0, r * 0.55); x.lineTo(0, r); x.moveTo(0, -r); x.lineTo(0, -r * 0.55); x.stroke();
      x.fillStyle = '#000'; for (let i = -4; i <= 4; i++) if (i) { x.beginPath(); x.arc(i * 10 * u, 0, 1.4 * u, 0, 7); x.fill(); x.beginPath(); x.arc(0, i * 10 * u, 1.4 * u, 0, 7); x.fill(); }
    } else if (optic === 'pso1') {
      x.strokeStyle = 'rgba(0,0,0,0.9)'; x.fillStyle = 'rgba(0,0,0,0.9)'; x.lineWidth = 1.5;
      const chev = (y: number, s: number) => { x.beginPath(); x.moveTo(-s * u, y + s * u); x.lineTo(0, y); x.lineTo(s * u, y + s * u); x.stroke(); };
      chev(0, 3); for (let i = 1; i <= 3; i++) chev(i * 7 * u, 2);
      x.beginPath(); x.moveTo(-40 * u, 0); x.lineTo(-8 * u, 0); for (let i = 1; i <= 5; i++) { x.moveTo(-8 * u - i * 5 * u, 0); x.lineTo(-8 * u - i * 5 * u, -2.5 * u); } x.stroke();
      // Stadia rangefinder curve (bottom left).
      x.beginPath(); for (let i = 0; i <= 20; i++) { const xx = -60 * u + i * 3 * u, yy = 50 * u - 18 * u * Math.sqrt(i / 20); i ? x.lineTo(xx, yy) : x.moveTo(xx, yy); } x.stroke();
      x.lineTo(-60 * u, 50 * u);
    } else if (optic === 'pgo7') {
      x.strokeStyle = 'rgba(0,0,0,0.9)'; x.fillStyle = 'rgba(0,0,0,0.9)'; x.lineWidth = 1.4; x.font = `${4 * u}px sans-serif`; x.textAlign = 'right';
      for (let i = 0; i <= 5; i++) { const y = i * 9 * u; x.beginPath(); x.moveTo(-6 * u, y); x.lineTo(6 * u, y); x.stroke(); x.fillText(String(i + 2), -8 * u, y + 1.5 * u); }
      x.beginPath(); x.moveTo(0, -4 * u); x.lineTo(0, 46 * u); x.stroke();
      for (let i = -4; i <= 4; i++) { x.beginPath(); x.moveTo(i * 6 * u, -1.5 * u); x.lineTo(i * 6 * u, 1.5 * u); x.stroke(); }
    }
    x.restore();
  }
}

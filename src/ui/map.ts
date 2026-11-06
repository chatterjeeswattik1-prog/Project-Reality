// Tactical map (M key, spawn screen): the whole AO drawn once from the generated city, a 17×17 PR grid with keypad
// sub-squares, and live markers (you, your squad, friendlies, cache intel, spawn points).
import type { City } from '../world/citygen';
import { MASK_HALF, MASK_N } from '../world/citygen';
import { AO, canalX, CANAL_W, MAP } from '../world/terrain';
import type { Game } from '../game/game';
import type { Soldier } from '../game/soldier';
import type { GameMode } from '../game/mode';
import type { Insurgency } from '../game/insurgency';

export function renderBaseMap(city: City, px = 1300): HTMLCanvasElement {
  const c = document.createElement('canvas'); c.width = c.height = px;
  const x = c.getContext('2d')!, k = px / (2 * MAP.half), X = (v: number) => (v - MAP.cx + MAP.half) * k, Z = (v: number) => (v - MAP.cz + MAP.half) * k;
  // Ground from the mask (dirt/gravel/fields).
  const img = x.createImageData(px, px);
  for (let j = 0; j < px; j++) for (let i = 0; i < px; i++) {
    const wx = i / k + MAP.cx - MAP.half, wz = j / k + MAP.cz - MAP.half;
    const mi = Math.floor(((wx + MASK_HALF) / (2 * MASK_HALF)) * MASK_N), mj = Math.floor(((wz + MASK_HALF) / (2 * MASK_HALF)) * MASK_N);
    const inM = mi >= 0 && mj >= 0 && mi < MASK_N && mj < MASK_N, m = (mj * MASK_N + mi) * 4, r = inM ? city.mask[m] / 255 : 0, g = inM ? city.mask[m + 1] / 255 : 0, b = inM ? city.mask[m + 2] / 255 : 0;
    let cr = 200, cg = 186, cb = 150;
    cr += (178 - cr) * r; cg += (160 - cg) * r; cb += (122 - cb) * r;
    cr += (170 - cr) * g; cg += (165 - cg) * g; cb += (150 - cb) * g;
    cr += (150 - cr) * b; cg += (150 - cg) * b; cb += (100 - cb) * b;
    const o = (j * px + i) * 4; img.data[o] = cr; img.data[o + 1] = cg; img.data[o + 2] = cb; img.data[o + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  // Canal.
  x.strokeStyle = '#5d7470'; x.lineWidth = CANAL_W * k; x.beginPath();
  for (let z = MAP.cz - MAP.half; z <= MAP.cz + MAP.half; z += 10) { const cx = canalX(z); z === MAP.cz - MAP.half ? x.moveTo(X(cx), Z(z)) : x.lineTo(X(cx), Z(z)); }
  x.stroke();
  // Paved roads.
  x.fillStyle = '#6e6a62';
  for (const r of city.roads) if (r.kind === 'boulevard' || r.kind === 'avenue' || r.kind === 'street') x.fillRect(X(r.x0), Z(r.z0), (r.x1 - r.x0) * k, (r.z1 - r.z0) * k);
  // Buildings: darker when taller.
  for (const b of city.buildings) {
    const s = b.spec, h = s.floors * s.fh, t = Math.max(0.45, 1 - h / 30);
    x.fillStyle = s.damage > 0.5 ? `rgb(${120 * t},${108 * t},${96 * t})` : `rgb(${215 * t},${205 * t},${190 * t})`;
    x.fillRect(X(s.x0), Z(s.z0), (s.x1 - s.x0) * k, (s.z1 - s.z0) * k);
    x.strokeStyle = 'rgba(60,52,40,0.55)'; x.lineWidth = 1; x.strokeRect(X(s.x0), Z(s.z0), (s.x1 - s.x0) * k, (s.z1 - s.z0) * k);
  }
  // Palms and trees (woods read as dark green masses, as on a topographic map).
  x.fillStyle = 'rgba(70,95,45,0.85)';
  for (const p of city.props) if (p.id.startsWith('palm') || p.id.startsWith('tree_')) { const r = p.id.startsWith('tree_euca') ? 4.5 : 2.2; x.beginPath(); x.arc(X(p.x), Z(p.z), r * k * 1.5, 0, 7); x.fill(); }
  // Grid: 17×17 squares A–Q / 1–17 with keypad lines (the sheet is square, so a grid line sits at the same pixel on
  // both axes).
  const N = MAP.n, sq = px / N;
  x.strokeStyle = 'rgba(30,30,30,0.18)'; x.lineWidth = 1;
  for (let i = 0; i <= N * 3; i++) { const v = (i * sq) / 3; x.beginPath(); x.moveTo(v, 0); x.lineTo(v, px); x.moveTo(0, v); x.lineTo(px, v); x.stroke(); }
  x.strokeStyle = 'rgba(20,20,20,0.55)'; x.lineWidth = 1.5;
  for (let i = 0; i <= N; i++) { const v = i * sq; x.beginPath(); x.moveTo(v, 0); x.lineTo(v, px); x.moveTo(0, v); x.lineTo(px, v); x.stroke(); }
  x.fillStyle = 'rgba(20,20,20,0.8)'; x.font = `bold ${Math.round(px / 80)}px "Segoe UI", sans-serif`; x.textAlign = 'center';
  for (let i = 0; i < N; i++) { x.fillText('ABCDEFGHIJKLMNOPQ'[i], (i + 0.5) * sq, px / 80 + 2); x.fillText(String(i + 1), px / 90 + 4, (i + 0.5) * sq + 5); }
  // The AO boundary.
  x.strokeStyle = 'rgba(160,30,20,0.7)'; x.lineWidth = 2.5; x.setLineDash([10, 6]);
  x.strokeRect(X(AO.x0), Z(AO.z0), (AO.x1 - AO.x0) * k, (AO.z1 - AO.z0) * k); x.setLineDash([]);
  // Landmarks.
  x.font = `${Math.round(px / 85)}px "Segoe UI", sans-serif`;
  for (const l of city.landmarks) { x.fillStyle = 'rgba(255,255,255,0.75)'; const w = x.measureText(l.name).width; x.fillRect(X(l.x) - w / 2 - 3, Z(l.z) - 11, w + 6, 15); x.fillStyle = '#222'; x.fillText(l.name, X(l.x), Z(l.z)); }
  return c;
}

export class MapView {
  el: HTMLDivElement; cv: HTMLCanvasElement;
  open = false;
  constructor(host: HTMLElement, private base: HTMLCanvasElement) {
    this.el = document.createElement('div'); this.el.className = 'mapview';
    this.cv = document.createElement('canvas'); this.el.appendChild(this.cv);
    host.appendChild(this.el); this.el.style.display = 'none';
  }
  toggle(v = !this.open) { this.open = v; this.el.style.display = v ? 'grid' : 'none'; }

  /** Draw the map into any canvas (also used by the spawn screen). */
  static draw(cv: HTMLCanvasElement, base: HTMLCanvasElement, g: Game, me: Soldier | null, spawns: { x: number; z: number; label: string; sel?: boolean }[] = []) {
    const size = cv.width, x = cv.getContext('2d')!, k = size / (2 * MAP.half), X = (v: number) => (v - MAP.cx + MAP.half) * k, Z = (v: number) => (v - MAP.cz + MAP.half) * k;
    x.drawImage(base, 0, 0, size, size);
    const m = g.mode as (GameMode & { caches?: Insurgency['caches'] }) | null;
    if (m?.caches) for (const c of m.caches) {
      if (c.state === 'destroyed') { x.strokeStyle = '#333'; x.lineWidth = 3; const a = X(c.pos[0]), b = Z(c.pos[2]); x.beginPath(); x.moveTo(a - 7, b - 7); x.lineTo(a + 7, b + 7); x.moveTo(a + 7, b - 7); x.lineTo(a - 7, b + 7); x.stroke(); continue; }
      const showAll = me?.team === 'ins';
      if (c.state === 'active' && (c.revealed || showAll)) {
        if (c.found || showAll) { x.fillStyle = '#b0241a'; x.fillRect(X(c.pos[0]) - 6, Z(c.pos[2]) - 6, 12, 12); x.strokeStyle = '#fff'; x.strokeRect(X(c.pos[0]) - 6, Z(c.pos[2]) - 6, 12, 12); }
        else { x.strokeStyle = 'rgba(176,36,26,0.9)'; x.fillStyle = 'rgba(176,36,26,0.15)'; x.lineWidth = 2; x.beginPath(); x.arc(X(c.marker[0]), Z(c.marker[1]), 75 * k, 0, 7); x.fill(); x.stroke(); }
      }
    }
    for (const sp of spawns) { x.fillStyle = sp.sel ? '#c9a24a' : 'rgba(30,60,120,0.85)'; x.beginPath(); x.arc(X(sp.x), Z(sp.z), 8, 0, 7); x.fill(); x.fillStyle = '#fff'; x.font = '11px "Segoe UI", sans-serif'; x.textAlign = 'center'; x.fillText(sp.label, X(sp.x), Z(sp.z) - 11); }
    if (me) for (const s of g.soldiers) {
      if (s.team !== me.team || s.state === 'dead' || s === me) continue;
      x.fillStyle = s.squad === me.squad ? '#4fc34f' : '#3a78d8';
      if (s.state === 'wounded') x.fillStyle = '#e0e020';
      x.beginPath(); x.arc(X(s.pos[0]), Z(s.pos[2]), s.squad === me.squad ? 4.5 : 3.5, 0, 7); x.fill();
    }
    if (me && me.state !== 'dead') {
      x.save(); x.translate(X(me.pos[0]), Z(me.pos[2])); x.rotate(-me.yaw);
      x.fillStyle = '#f2e14a'; x.strokeStyle = '#000'; x.lineWidth = 1.5; x.beginPath(); x.moveTo(0, -10); x.lineTo(6, 7); x.lineTo(0, 3); x.lineTo(-6, 7); x.closePath(); x.fill(); x.stroke(); x.restore();
    }
  }

  update(g: Game, me: Soldier) {
    if (!this.open) return;
    const s = Math.min(innerWidth, innerHeight) * 0.92;
    if (this.cv.width !== Math.round(s)) { this.cv.width = this.cv.height = Math.round(s); this.cv.style.width = this.cv.style.height = `${Math.round(s)}px`; }
    MapView.draw(this.cv, this.base, g, me);
  }
}

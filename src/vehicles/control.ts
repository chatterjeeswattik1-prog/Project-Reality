// The player in a vehicle: seats, views and weapons, after Project Reality's armour.
//   F1–F9 change seat (crew seats need the Crewman kit), F gets out.
//   Driver: W/S throttle, A/D pivot steering; the mouse looks round the vision blocks.
//   Gunner: the mouse aims, the turret follows at its traverse rate (the view is the sight); LMB fires; 1 AP / sabot,
//     2 HE / HEAT (switching rounds means a reload), 3 coax, 4 TOW (at a halt, wire-guided: keep the sight on the
//     target); RMB zoom; R laser rangefinder (the FCS sets the superelevation); T day / thermal; G smoke; B 25 mm rate.
//   Commander / loader: their own machine-gun station (CROWS .50 / M240), LMB fires, RMB zoom.
//   Y orders the AI driver to drive to where you look, H to stop.
import * as THREE from 'three';
import { BIND, type Input } from '../core/input';
import type { Game } from '../game/game';
import type { Soldier } from '../game/soldier';
import { BASE_FOV } from '../player/player';
import { gridRef } from '../world/terrain';
import type { Mount, Vehicle } from './vehicle';

type V3 = [number, number, number];
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export class VehicleControl {
  zoomI = 0; thermal = false;
  /** Free look (driver, cargo, hatch) relative to the hull or turret. */ lookYaw = 0; lookPitch = 0;
  /** Current weapon of the seat (index into the seat's mounts). */ weap = 0;
  private filterSet = '';

  constructor(private g: Game, private I: Input) {}

  /** Seat change by the player (crew seats need a Crewman kit). */
  trySeat(s: Soldier, v: Vehicle, i: number): boolean {
    const st = v.seats[i]; if (!st) return false;
    if (st.def.crew && s.kit.role !== 'crew') { this.g.hud?.flash('Crewman kit required'); return false; }
    if (st.who && st.who !== s) {
      // An AI crewman in that seat moves to the seat the player leaves (or another free one), else gets out.
      const ai = st.who, cur = v.seatOf(s);
      const free = cur >= 0 ? cur : v.seats.findIndex((x, k) => !x.who && k !== i && (!x.def.crew || ai.kit.role === 'crew'));
      v.exit(ai, false);
      if (cur >= 0) v.seats[cur].who = null;
      v.enter(s, i);
      if (free >= 0) v.enter(ai, free); else v.exit(ai, true);
    } else v.enter(s, i);
    this.zoomI = 0; this.weap = 0; this.lookYaw = this.lookPitch = 0;
    this.g.hud?.flash(st.def.label.toUpperCase());
    this.g.audio.play('car_door', null, { gain: 0.4, rate: 0.7 });
    return true;
  }

  update(dt: number, s: Soldier) {
    const v = s.vehicle!, I = this.I, g = this.g, seat = v.seatOf(s), st = v.seats[seat];
    if (!st) return;
    const d = st.def;
    if (I.locked && s.alive) {
      for (let k = 1; k <= 9; k++) if (I.hit(`F${k}`) && k - 1 !== seat) { this.trySeat(s, v, k - 1); return; }
      if (I.hit(BIND.use)) { v.exit(s, true); this.setFilter(''); g.hud?.flash('DISMOUNTED'); g.audio.play('car_door', null, { gain: 0.5 }); return; }
      const sens = I.sens / Math.max(1, this.zoom(d) * 0.8);
      const dx = -I.mouse.dx * sens, dy = -I.mouse.dy * sens;
      if (I.mouse.rightPressed) this.zoomI = (this.zoomI + 1) % d.zoom.length;
      if (d.thermal && I.hit(BIND.light)) { this.thermal = !this.thermal; g.hud?.flash(this.thermal ? 'THERMAL (WHOT)' : 'DAY'); }
      const mounts = v.mountsOf(seat);
      if (d.role === 'driver') {
        const f = (I.is(BIND.fwd) ? 1 : 0) - (I.is(BIND.back) ? 1 : 0), r = (I.is(BIND.right) ? 1 : 0) - (I.is(BIND.left) ? 1 : 0);
        v.throttle = f; v.steer = -r;
        this.lookYaw = clamp(this.lookYaw + dx, -2.4, 2.4); this.lookPitch = clamp(this.lookPitch + dy, -0.4, 0.5);
        if (!I.is(BIND.freeLook) && Math.abs(dx) + Math.abs(dy) === 0) this.lookYaw *= Math.exp(-2 * dt);
      } else if (d.view === 'gun') {
        v.aimYaw += dx; v.aimPitch = clamp(v.aimPitch + dy, v.def.elev[0] - 0.2, v.def.elev[1] + 0.2);
        // Weapons: 1 sabot, 2 HE (main gun rounds), 3 coax, 4 TOW.
        const main = mounts[0];
        if (I.hit('Digit1')) { this.weap = 0; v.selectAmmo(main, 0); }
        if (I.hit('Digit2')) { this.weap = 0; v.selectAmmo(main, 1); }
        if (I.hit('Digit3') && mounts[1]) this.weap = 1;
        if (I.hit('Digit4') && mounts[2]) this.weap = 2;
        if (I.hit(BIND.reload)) { const r = v.lase(); g.hud?.flash(r ? `RANGE ${r} m` : 'NO RETURN'); g.audio.play('switch_fire_mode', null, { gain: 0.3, rate: 1.6 }); }
        if (I.hit(BIND.bipod)) { if (v.popSmoke()) g.hud?.flash('SMOKE'); }
        if (I.hit(BIND.mode) && main.def.rates) { main.rate = main.rate === main.def.rates[0] ? main.def.rates[1] : main.def.rates[0]; g.hud?.flash(`${main.rate} RPM`); }
        const mt = mounts[this.weap] ?? main;
        if (I.mouse.left && (mt.def.rpm > 0 || I.mouse.leftPressed)) { if (!v.fire(mt, seat)) { const b = v.blocked(mt, seat); if (b && I.mouse.leftPressed) g.hud?.flash(b.toUpperCase()); } }
      } else if (d.view === 'station' || d.view === 'hatch') {
        const mt = mounts[0];
        if (mt) { mt.yaw += dx; mt.pitch = clamp(mt.pitch + dy, -0.35, 0.9); }
        else { this.lookYaw += dx; this.lookPitch = clamp(this.lookPitch + dy, -0.5, 0.8); }
        if (mt && I.mouse.left) v.fire(mt, seat, this.stationDir(v, mt));
      } else {
        this.lookYaw = clamp(this.lookYaw + dx, -2.6, 2.6); this.lookPitch = clamp(this.lookPitch + dy, -0.4, 0.5);
      }
      // Orders to the AI driver (when someone else drives): drive to the point looked at / stop.
      if (d.role !== 'driver' && (I.hit(BIND.orderMove) || I.hit(BIND.orderHold))) {
        const ai = v.ai;
        if (ai) {
          if (I.hit(BIND.orderHold)) { ai.stop(); g.hud?.flash('DRIVER: STOP'); }
          else {
            const o = this.eye(v, st, s), dir = this.viewDir(v, st), h = g.P.castRay(o, dir, 1500);
            if (h) { ai.driveTo([h.point[0], h.point[1], h.point[2]]); g.hud?.flash(`DRIVER: MOVING ${gridRef(h.point[0], h.point[2])}`); }
          }
          g.audio.play('radio_squelch', null, { gain: 0.4 });
        }
      }
    }
    this.place(s);
  }

  /**
   * Camera at the seat's eye, looking along the sight / station / free look. Called again after the physics step
   * (Game.update), so the view never lags the moving hull (a lagging eye at speed ends up inside the hull).
   */
  place(s: Soldier) {
    const v = s.vehicle; if (!v) return;
    const g = this.g, cam = g.gfx.camera, st = v.seats[v.seatOf(s)]; if (!st) return;
    const d = st.def;
    const e = this.eye(v, st, s), dir = this.viewDir(v, st);
    cam.position.set(e[0], e[1], e[2]);
    const yaw = Math.atan2(-dir[0], -dir[2]), pitch = Math.asin(clamp(dir[1], -1, 1));
    const roll = d.view === 'gun' ? 0 : -this.hullRoll(v) * 0.8;
    const sh = g.player?.shake ?? 0, n = performance.now() / 1000;
    cam.rotation.set(pitch + Math.sin(n * 47) * sh * 0.01, yaw + Math.sin(n * 39) * sh * 0.01, roll, 'YXZ');
    cam.fov = BASE_FOV / this.zoom(d); cam.updateProjectionMatrix();
    this.setFilter(this.thermal && d.thermal ? 'grayscale(1) contrast(1.9) brightness(1.25)' : '');
  }

  zoom(d: { zoom: number[] }) { return d.zoom[Math.min(this.zoomI, d.zoom.length - 1)]; }
  private hullRoll(v: Vehicle) { const r = new THREE.Vector3(1, 0, 0).applyQuaternion(v.root.quaternion); return Math.asin(clamp(r.y, -1, 1)); }
  private eye(v: Vehicle, st: Vehicle['seats'][number], s: Soldier): V3 {
    void s;
    const e = v.nodePos(st.def.node);
    // Driver: the periscope head sits a hand above the hull roof.
    if (st.def.role === 'driver') { const up = new THREE.Vector3(0, 1, 0).applyQuaternion(v.root.quaternion); return [e[0] + up.x * 0.12, e[1] + up.y * 0.12, e[2] + up.z * 0.12]; }
    return e;
  }
  /** Station machine guns aim on their own (relative to the turret). */
  stationDir(v: Vehicle, mt: Mount): V3 {
    const yaw = v.yaw() + v.turretYaw + mt.yaw, p = mt.pitch;
    return [-Math.sin(yaw) * Math.cos(p), Math.sin(p), -Math.cos(yaw) * Math.cos(p)];
  }
  viewDir(v: Vehicle, st: Vehicle['seats'][number]): V3 {
    const d = st.def, seat = v.seats.indexOf(st), mounts = v.mountsOf(seat);
    if (d.view === 'gun') return v.sightDir();
    if ((d.view === 'station' || d.view === 'hatch') && mounts[0]) return this.stationDir(v, mounts[0]);
    const base = v.yaw() + (d.view === 'station' || d.view === 'hatch' ? v.turretYaw : 0) + this.lookYaw, p = this.lookPitch + v.hullPitch() * 0.8;
    return [-Math.sin(base) * Math.cos(p), Math.sin(p), -Math.cos(base) * Math.cos(p)];
  }
  setFilter(f: string) { if (f === this.filterSet) return; this.filterSet = f; this.g.gfx.renderer.domElement.style.filter = f; }

  /** HUD: the vehicle panel (HTML) and the canvas overlay (reticle, turret indicator). */
  panel(s: Soldier): string {
    const v = s.vehicle!, seat = v.seatOf(s), st = v.seats[seat], mounts = v.mountsOf(seat);
    const kmh = Math.round(Math.abs(v.vf) * 3.6), integ = Math.max(0, Math.round(v.integrity));
    const state = [v.dead ? 'DESTROYED' : '', v.burning ? '<span class="bleed">ON FIRE — BAIL OUT (F)</span>' : '', v.tracked ? 'TRACK BROKEN' : '', v.engineOut ? 'ENGINE OUT' : '', v.turretJam ? 'TURRET DRIVE DAMAGED' : ''].filter(Boolean).join(' · ');
    const wpn = mounts.map((m, i) => {
      const names = m.def.ammo.map((a, k) => `${['AP', 'HE'][k] ?? 'MSL'} ${m.ready[k]}${m.def.rpm ? '' : ''}/${m.stowed[k]}`);
      const sel = st.def.view === 'gun' ? (i === this.weap) : true;
      const label = m.def.id === 'main' ? (v.def.id === 'm1a2' ? '120 mm' : '25 mm') : m.def.id === 'coax' ? 'Coax M240C' : m.def.id === 'tow' ? 'TOW' : m.def.id === 'cmdr' ? 'M2 .50 (CROWS)' : 'M240';
      const ammo = m.def.ammo.length > 1 ? names.map((n2, k) => (k === m.sel ? `<b>${n2}</b>` : n2)).join(' · ') : `${m.def.rpm ? m.belt + ' / ' : ''}${m.ready[0]}`;
      const st2 = v.blocked(m, seat);
      return `<div style="opacity:${sel ? 1 : 0.55}">${sel ? '▶ ' : ''}${label} — ${ammo}${st2 ? ` <i style="color:#d9b45a">${st2}</i>` : m.loaded || m.belt ? ' <i style="color:#8fd08a">READY</i>' : ''}</div>`;
    }).join('');
    return `<b>${v.def.name}</b> — ${st.def.label}<div class="mode">${kmh} km/h · ${v.onRoad ? 'ROAD' : 'CROSS-COUNTRY'}${v.range ? ` · RANGE ${v.range} m` : ''}${v.def.smoke ? ` · SMOKE ×${v.smoke}` : ''}</div>`
      + `<div class="bar" style="margin:4px 0"><i style="width:${integ}%;background:${integ > 50 ? '#8fd08a' : integ > 25 ? '#d9b45a' : '#c84a3a'}"></i></div>${state ? `<div class="mode">${state}</div>` : ''}${wpn}`
      + `<div class="extra"><span>F1–F${v.seats.length} seats · F exit${st.def.role !== 'driver' ? ' · Y drive there · H stop' : ''}</span></div>`;
  }

  draw(x: CanvasRenderingContext2D, W: number, H: number, s: Soldier) {
    const v = s.vehicle!, st = v.seats[v.seatOf(s)], d = st.def, cx = W / 2, cy = H / 2;
    // Turret / hull indicator (bottom left): hull outline, turret line, view direction.
    const ix = 90, iy = H - 110;
    x.save(); x.translate(ix, iy);
    x.strokeStyle = 'rgba(220,215,190,0.8)'; x.lineWidth = 2; x.strokeRect(-14, -24, 28, 48);
    x.rotate(-v.turretYaw); x.beginPath(); x.arc(0, 0, 10, 0, 7); x.stroke(); x.beginPath(); x.moveTo(0, 0); x.lineTo(0, -38); x.stroke();
    x.restore();
    if (d.view === 'gun') {
      // Gunner's sight: a cross with a gap, stadia, and the aim marker (where the turret is being driven to).
      x.strokeStyle = this.thermal ? 'rgba(10,10,10,0.95)' : 'rgba(240,60,40,0.95)'; x.lineWidth = 1.6;
      const g2 = 10;
      x.beginPath(); x.moveTo(cx - 140, cy); x.lineTo(cx - g2, cy); x.moveTo(cx + g2, cy); x.lineTo(cx + 140, cy); x.moveTo(cx, cy + g2); x.lineTo(cx, cy + 110); x.moveTo(cx, cy - g2); x.lineTo(cx, cy - 40); x.stroke();
      for (let i = 1; i <= 4; i++) { x.beginPath(); x.moveTo(cx - 6, cy + i * 22); x.lineTo(cx + 6, cy + i * 22); x.stroke(); }
      // Aim marker: the difference between the wanted aim and the turret's actual direction.
      const dyaw = Math.atan2(Math.sin(v.aimYaw - v.yaw() - v.turretYaw), Math.cos(v.aimYaw - v.yaw() - v.turretYaw));
      const fov = (BASE_FOV / this.zoom(d)) * Math.PI / 180, k = H / fov;
      const mx = cx - dyaw * k, my = cy - (v.aimPitch - (v.gunPitch - v.fcs) - v.hullPitch() * Math.cos(v.turretYaw)) * k;
      if (Math.abs(mx - cx) > 3 || Math.abs(my - cy) > 3) { x.strokeStyle = 'rgba(240,220,120,0.8)'; x.beginPath(); x.arc(clamp(mx, 20, W - 20), clamp(my, 20, H - 20), 7, 0, 7); x.stroke(); }
      x.fillStyle = 'rgba(240,60,40,0.9)'; x.font = '600 14px system-ui, sans-serif'; x.textAlign = 'left';
      x.fillText(`${this.zoom(d)}×${this.thermal ? '  WHOT' : ''}`, cx + 150, cy - 8);
      if (v.range) x.fillText(`${v.range} m`, cx + 150, cy + 14);
      // Guided missile in flight: keep the sight on the target.
      if (v.mountsOf(v.seatOf(s))[this.weap]?.def.aim === 'launcher') { x.fillText(v.stillT < 4 ? 'LAUNCHER — HALT' : 'TOW READY', cx + 150, cy + 36); }
      x.textAlign = 'start';
    } else if (d.view === 'station' || d.view === 'hatch') {
      x.strokeStyle = 'rgba(230,230,210,0.85)'; x.lineWidth = 1.4;
      x.beginPath(); x.arc(cx, cy, 14, 0, 7); x.moveTo(cx - 30, cy); x.lineTo(cx - 14, cy); x.moveTo(cx + 14, cy); x.lineTo(cx + 30, cy); x.moveTo(cx, cy + 14); x.lineTo(cx, cy + 30); x.stroke();
    } else if (d.view === 'hull' || d.view === 'cargo') {
      // Vision blocks: the view is framed by the periscope slit.
      x.fillStyle = 'rgba(0,0,0,0.88)'; x.fillRect(0, 0, W, H * 0.22); x.fillRect(0, H * 0.72, W, H * 0.28);
    }
  }
}

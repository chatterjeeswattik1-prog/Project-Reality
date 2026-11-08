// The player in a vehicle: seats, views and weapons, after Project Reality's armour.
//   F1–F9 change seat (crew seats need the Crewman kit), F gets out.
//   Driver: W/S throttle, A/D pivot steering; the mouse looks round the vision blocks.
//   Gunner: the mouse aims, the turret follows at its traverse rate (the view is the sight); LMB fires; 1 AP / sabot,
//     2 HE / HEAT (switching rounds means a reload), 3 coax, 4 TOW (at a halt, wire-guided: keep the sight on the
//     target); RMB zoom; R laser rangefinder (the FCS sets the superelevation); T day / thermal; G smoke; B 25 mm rate.
//   Commander (M1A2): the CROWS .50 from inside — the mouse drives the mount (it slews after the aim), the view is its
//     sight camera; LMB fires, RMB zoom, R laser range, T day / thermal. (The M1A2 is crewed by three, the Bradley by two.)
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
    if (st.def.crew && s.kit.role !== 'crew' && !this.g.sandbox) { this.g.hud?.flash('Crewman kit required'); return false; }
    // Sandbox: an empty vehicle changes hands (it fights for whoever gets in).
    if (this.g.sandbox && v.team !== s.team) {
      if (v.seats.some((x) => x.who && x.who !== s)) { this.g.hud?.flash('Enemy crew aboard'); return false; }
      v.team = s.team;
    }
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
        const mt = mounts[0], stn = mt?.def.station;
        // A pintle gun: the commander looks where he wants it and hauls it round after his eye (Vehicle.update slews it).
        if (mt && stn) { mt.aimYaw += dx; mt.aimPitch = clamp(mt.aimPitch + dy, stn.elev[0], stn.elev[1]); }
        if (stn?.remote && I.hit(BIND.reload)) {
          const o = this.eye(v, st, s), h = g.P.castRay(o, this.stationDir(v, mt), 2000);
          this.cmdRange = h ? Math.round(h.dist) : 0; g.hud?.flash(h ? `RANGE ${this.cmdRange} m` : 'NO RETURN'); g.audio.play('switch_fire_mode', null, { gain: 0.3, rate: 1.6 });
        }
        else if (mt) { mt.yaw += dx; mt.pitch = clamp(mt.pitch + dy, -0.35, 0.9); }
        else { this.lookYaw += dx; this.lookPitch = clamp(this.lookPitch + dy, -0.5, 0.8); }
        if (mt && I.mouse.left) { if (!v.fire(mt, seat, this.stationDir(v, mt))) { const b = v.blocked(mt, seat); if (b && I.mouse.leftPressed) g.hud?.flash(b.toUpperCase()); } }
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
    // (Stabilized sights — the gunner's, the CROWS camera — stay level; vision blocks and hatches roll with the hull.)
    const roll = d.view === 'gun' || v.mountsOf(v.seats.indexOf(st))[0]?.def.station?.remote ? 0 : -this.hullRoll(v) * 0.8;
    const sh = g.player?.shake ?? 0, n = performance.now() / 1000;
    cam.rotation.set(pitch + Math.sin(n * 47) * sh * 0.01, yaw + Math.sin(n * 39) * sh * 0.01, roll, 'YXZ');
    cam.fov = BASE_FOV / this.zoom(d); cam.updateProjectionMatrix();
    this.setFilter(this.thermal && d.thermal ? 'grayscale(1) contrast(1.9) brightness(1.25)' : '');
    // The Abrams driver sits under the gun: his periscope view would be filled by the mantlet and the turret bustle as
    // it traverses, so the turret is not drawn for him (it still turns and fires meanwhile).
    this.hideTurret(d.role === 'driver' && v.def.sights === 'abrams' ? v : null);
  }
  private hidden: Vehicle | null = null;
  private hideTurret(v: Vehicle | null) {
    if (this.hidden === v) return;
    if (this.hidden) this.hidden.turret.visible = true;
    if (v) v.turret.visible = false;
    this.hidden = v;
  }
  /** Out of the vehicle: undo the view's effects (turret hidden, sight filter). */
  release() { this.hideTurret(null); this.setFilter(''); }

  zoom(d: { zoom: number[] }) { return d.zoom[Math.min(this.zoomI, d.zoom.length - 1)]; }
  private hullRoll(v: Vehicle) { const r = new THREE.Vector3(1, 0, 0).applyQuaternion(v.root.quaternion); return Math.asin(clamp(r.y, -1, 1)); }
  private eye(v: Vehicle, st: Vehicle['seats'][number], s: Soldier): V3 {
    void s;
    // Pintle gunner: his head out of the hatch, behind his gun (it swings round him).
    const stn = v.mountsOf(v.seats.indexOf(st))[0]?.def.station;
    // CROWS: the sight camera in its box on the left of the gun cradle.
    if (stn?.remote) { const gn = v.nodes.get(stn.pitch); if (gn) { const p = gn.localToWorld(this.sightOff.set(-0.24, 0.1, -0.85)); return [p.x, p.y, p.z]; } }
    if (stn) return v.nodePos(stn.eye);
    const e = v.nodePos(st.def.node);
    // Driver: the periscope head sits a hand above the hull roof.
    // (The Bradley's vision blocks sit higher, in the hatch ring above the sloped roof.)
    if (st.def.role === 'driver') { const up = new THREE.Vector3(0, 1, 0).applyQuaternion(v.root.quaternion), k = v.def.sights === 'bradley' ? 0.4 : 0.12; return [e[0] + up.x * k, e[1] + up.y * k, e[2] + up.z * k]; }
    return e;
  }
  /** Station machine guns aim on their own (relative to the turret). */
  stationDir(v: Vehicle, mt: Mount): V3 {
    if (mt.def.station) return v.nodeDir(mt.def.station.pitch);
    const yaw = v.yaw() + v.turretYaw + mt.yaw, p = mt.pitch;
    return [-Math.sin(yaw) * Math.cos(p), Math.sin(p), -Math.cos(yaw) * Math.cos(p)];
  }
  /** Where a pintle gunner is looking (his aim, in the turret's frame: the gun follows it). */
  private stationLook(v: Vehicle, mt: Mount): V3 {
    v.turret.getWorldQuaternion(this.tq);
    const d = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(mt.aimPitch, mt.aimYaw, 0, 'YXZ')).applyQuaternion(this.tq);
    return [d.x, d.y, d.z];
  }
  private tq = new THREE.Quaternion(); private sightOff = new THREE.Vector3();
  /** CROWS laser range (m, 0 = none). */ cmdRange = 0;
  viewDir(v: Vehicle, st: Vehicle['seats'][number]): V3 {
    const d = st.def, seat = v.seats.indexOf(st), mounts = v.mountsOf(seat);
    if (d.view === 'gun') return v.sightDir();
    if ((d.view === 'station' || d.view === 'hatch') && mounts[0]) { const stn = mounts[0].def.station; return stn && !stn.remote ? this.stationLook(v, mounts[0]) : this.stationDir(v, mounts[0]); }
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
      const st2 = v.netRemote ? (v.netBlocked[m.def.id] ?? null) : v.blocked(m, seat);
      return `<div style="opacity:${sel ? 1 : 0.55}">${sel ? '▶ ' : ''}${label} — ${ammo}${st2 ? ` <i style="color:#d9b45a">${st2}</i>` : m.loaded || m.belt ? ' <i style="color:#8fd08a">READY</i>' : ''}</div>`;
    }).join('');
    return `<b>${v.def.name}</b> — ${st.def.label}<div class="mode">${kmh} km/h · ${v.onRoad ? 'ROAD' : 'CROSS-COUNTRY'}${v.range ? ` · RANGE ${v.range} m` : ''}${v.def.smoke ? ` · SMOKE ×${v.smoke}` : ''}</div>`
      + `<div class="bar" style="margin:4px 0"><i style="width:${integ}%;background:${integ > 50 ? '#8fd08a' : integ > 25 ? '#d9b45a' : '#c84a3a'}"></i></div>${state ? `<div class="mode">${state}</div>` : ''}${wpn}`
      + `<div class="extra"><span>F1–F${v.seats.length} seats · F exit${st.def.role !== 'driver' ? ' · Y drive there · H stop' : ''}</span></div>`;
  }

  /**
   * View masks, drawn once per screen size: 'periscope' — the Abrams driver's periscope window (soft-edged, rounded);
   * 'eyepiece' — a round sight eyepiece; 'blocks' — the Bradley driver's bank of vision blocks round the main window.
   */
  private masks = new Map<string, HTMLCanvasElement>();
  private mask(kind: 'periscope' | 'eyepiece' | 'blocks' | 'monitor', W: number, H: number): HTMLCanvasElement {
    const key = `${kind}|${W}|${H}`;
    let c = this.masks.get(key); if (c) return c;
    c = document.createElement('canvas'); c.width = W; c.height = H;
    const x = c.getContext('2d')!;
    const rr = (x0: number, y0: number, w: number, h: number, r: number) => { x.beginPath(); x.roundRect(x0, y0, w, h, r); };
    x.fillStyle = kind === 'blocks' ? '#0d0e0d' : kind === 'monitor' ? '#141615' : '#000'; x.fillRect(0, 0, W, H);
    x.globalCompositeOperation = 'destination-out';
    if (kind === 'periscope') { x.filter = `blur(${Math.round(H * 0.025)}px)`; rr(W * 0.125, H * 0.17, W * 0.75, H * 0.73, H * 0.05); x.fill(); }
    else if (kind === 'eyepiece') { x.filter = `blur(${Math.round(H * 0.02)}px)`; x.beginPath(); x.arc(W / 2, H / 2, Math.min(W * 0.4, H * 0.6), 0, 7); x.fill(); }
    else if (kind === 'monitor') { rr(W * 0.06, H * 0.05, W * 0.88, H * 0.9, H * 0.02); x.fill(); }
    else { x.filter = 'blur(2px)'; rr(W * 0.14, H * 0.125, W * 0.715, H * 0.755, H * 0.035); x.fill(); }
    x.filter = 'none'; x.globalCompositeOperation = 'source-over';
    if (kind === 'blocks') {
      // The vision blocks: bevelled glass squares in a row along the top and bottom and up both sides.
      const b = H * 0.063, block = (cx: number, cy: number) => {
        x.fillStyle = '#2a2e30'; rr(cx - b / 2 - 3, cy - b / 2 - 3, b + 6, b + 6, b * 0.22); x.fill();
        const gr = x.createLinearGradient(cx - b / 2, cy - b / 2, cx + b / 2, cy + b / 2); gr.addColorStop(0, '#9aa6aa'); gr.addColorStop(0.5, '#6d777b'); gr.addColorStop(1, '#4a5255');
        x.fillStyle = gr; rr(cx - b / 2, cy - b / 2, b, b, b * 0.18); x.fill();
        x.strokeStyle = 'rgba(255,255,255,0.25)'; x.lineWidth = 1; rr(cx - b / 2 + 3, cy - b / 2 + 3, b - 6, b - 6, b * 0.14); x.stroke();
      };
      for (let k = 0; k < 7; k++) { const cx = W * (0.216 + k * 0.0933); block(cx, H * 0.045); block(cx, H * 0.955); }
      for (let k = 0; k < 6; k++) { const cy = H * (0.2 + k * 0.128); block(W * 0.095, cy); block(W * 0.9, cy); }
    }
    this.masks.set(key, c);
    return c;
  }

  /**
   * CROWS display (commander's monitor): the sight camera's picture with a white reticle — open centre box, crosshair
   * with a gap, range ticks for the .50 below it — the commanded-aim marker while the mount is still slewing, and the
   * status lines (azimuth relative to the hull, elevation, laser range, rounds, zoom, day / thermal).
   */
  private crows(x: CanvasRenderingContext2D, W: number, H: number, v: Vehicle, mt: Mount, d: { zoom: number[] }) {
    const cx = W / 2, cy = H / 2, u = H / 720, col = this.thermal ? 'rgba(20,20,20,0.95)' : 'rgba(235,240,235,0.92)';
    x.strokeStyle = col; x.fillStyle = col; x.lineWidth = Math.max(1, 1.4 * u);
    const L = (a: number, b: number, c: number, e: number) => { x.moveTo(cx + a * u, cy + b * u); x.lineTo(cx + c * u, cy + e * u); };
    x.beginPath();
    x.rect(cx - 7 * u, cy - 7 * u, 14 * u, 14 * u);
    L(-170, 0, -22, 0); L(22, 0, 170, 0); L(0, -120, 0, -22); L(0, 22, 0, 26);
    // .50 range ticks (500 / 1000 / 1500 m) under the centre.
    for (const [k, w] of [[44, 12], [70, 9], [104, 6]] as const) L(-w, k, w, k);
    L(0, 44, 0, 104);
    // Corner brackets of the field.
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) { L(sx * 300, sy * 200, sx * 270, sy * 200); L(sx * 300, sy * 200, sx * 300, sy * 175); }
    x.stroke();
    x.font = `${Math.round(10 * u)}px monospace`; x.textAlign = 'left';
    for (const [k, t] of [[44, '5'], [70, '10'], [104, '15']] as const) x.fillText(t, cx + 16 * u, cy + (k + 3) * u);
    // Where the joystick is driving the mount (it lags behind a fast swing).
    const dyaw = Math.atan2(Math.sin(mt.aimYaw - mt.yaw), Math.cos(mt.aimYaw - mt.yaw)), dp = mt.aimPitch - mt.pitch;
    const fov = (BASE_FOV / this.zoom(d)) * Math.PI / 180, k = H / fov;
    if (Math.abs(dyaw) + Math.abs(dp) > 0.004) { x.strokeStyle = 'rgba(240,210,90,0.9)'; x.beginPath(); x.arc(clamp(cx - dyaw * k, 30, W - 30), clamp(cy - dp * k, 30, H - 30), 8 * u, 0, 7); x.stroke(); }
    // Status lines.
    x.fillStyle = this.thermal ? 'rgba(20,20,20,0.95)' : 'rgba(235,240,235,0.85)'; x.font = `600 ${Math.round(14 * u)}px monospace`;
    const az = ((-(v.turretYaw + mt.yaw) * 180 / Math.PI) % 360 + 360) % 360, el = mt.pitch * 180 / Math.PI;
    x.fillText(`CROWS M153   ${this.thermal ? 'TV-THERMAL WHT' : 'TV-DAY'}   ${this.zoom(d)}×`, W * 0.08, H * 0.09);
    x.fillText(`AZ ${az.toFixed(0).padStart(3, '0')}°   EL ${el >= 0 ? '+' : ''}${el.toFixed(1)}°`, W * 0.08, H * 0.09 + 20 * u);
    x.textAlign = 'right';
    x.fillText(`RNG ${this.cmdRange ? String(this.cmdRange).padStart(4, '0') : '----'} m`, W * 0.92, H * 0.09);
    const b = v.blocked(mt, v.seats.findIndex((q) => q.def.role === 'commander'));
    x.fillText(`M2 .50  ${mt.belt}/${mt.ready[0]}${b ? '  ' + b.toUpperCase() : ''}`, W * 0.92, H * 0.09 + 20 * u);
    x.textAlign = 'start';
  }

  /** Abrams gunner's primary sight (day): red ring reticle with stadia dashes (reference 1052 × 582 px units). */
  private reticleAbrams(x: CanvasRenderingContext2D, cx: number, cy: number, u: number) {
    x.strokeStyle = this.thermal ? 'rgba(10,10,10,0.95)' : 'rgba(235,45,30,0.95)'; x.lineWidth = Math.max(1.2, 1.6 * u);
    const L = (a: number, b: number, c: number, d: number) => { x.moveTo(cx + a * u, cy + b * u); x.lineTo(cx + c * u, cy + d * u); };
    x.beginPath(); x.arc(cx, cy, 8 * u, 0, 7);
    L(0, -8, 0, -20); L(0, 8, 0, 20);
    for (const sg of [1, -1]) { L(sg * 8, 0, sg * 40, 0); L(sg * 22, -5, sg * 40, -5); L(sg * 58, 0, sg * 80, 0); }
    x.stroke();
  }
  /** Bradley gunner's sight (ISU): green — split vertical line, centre ring, stadia brackets, the 25 mm range ladder
   *  (0.5–3.0 km) and the laser range read-out. */
  private reticleBradley(x: CanvasRenderingContext2D, cx: number, cy: number, u: number, range: number) {
    const col = this.thermal ? 'rgba(10,10,10,0.95)' : 'rgba(70,225,95,0.95)';
    x.strokeStyle = col; x.fillStyle = col; x.lineWidth = Math.max(1, 1.3 * u);
    const L = (a: number, b: number, c: number, d: number) => { x.moveTo(cx + a * u, cy + b * u); x.lineTo(cx + c * u, cy + d * u); };
    x.beginPath(); x.arc(cx, cy, 7 * u, 0, 7);
    for (const dx of [-1.5, 1.5]) { L(dx, -100, dx, -7); L(dx, 7, dx, 80); }
    for (const sg of [1, -1]) { L(sg * 95, 0, sg * 127, 0); L(sg * 30, -21, sg * 62, -21); L(sg * 30, 21, sg * 62, 21); }
    // Range ladder (aim the HE so the target sits on its range mark) and its base line.
    L(-82, 109, 85, 67); L(-82, 120, 85, 120);
    x.stroke();
    const marks: [number, string][] = [[0, '3.0'], [0.18, '2.0'], [0.42, '1.0'], [1, '0.5']];
    x.font = `${Math.round(11 * u)}px monospace`; x.textAlign = 'center';
    for (const [t, lab] of marks) {
      const px = -82 + t * 167, py = 109 - t * 42;
      x.beginPath(); L(px, py, px, py - 7); x.stroke();
      x.fillText(lab, cx + px * u, cy + (py - 10) * u);
    }
    x.font = `${Math.round(13 * u)}px monospace`;
    x.fillText(String(Math.min(9999, Math.round(range))).padStart(4, '0'), cx, cy + 146 * u);
    x.textAlign = 'start';
  }

  draw(x: CanvasRenderingContext2D, W: number, H: number, s: Soldier) {
    const v = s.vehicle!, st = v.seats[v.seatOf(s)], d = st.def, cx = W / 2, cy = H / 2;
    // The sight's eyepiece / the driver's periscope or vision blocks (under the indicator and the reticle).
    if (d.view === 'gun') x.drawImage(this.mask('eyepiece', W, H), 0, 0);
    else if (d.view === 'station' && v.mountsOf(v.seatOf(s))[0]?.def.station?.remote) x.drawImage(this.mask('monitor', W, H), 0, 0);
    else if (d.view === 'hull' && d.role === 'driver') x.drawImage(this.mask(v.def.sights === 'bradley' ? 'blocks' : 'periscope', W, H), 0, 0);
    // Turret / hull indicator (bottom left): hull outline, turret line, view direction.
    const ix = 90, iy = H - 110;
    x.save(); x.translate(ix, iy);
    x.strokeStyle = 'rgba(220,215,190,0.8)'; x.lineWidth = 2; x.strokeRect(-14, -24, 28, 48);
    x.rotate(-v.turretYaw); x.beginPath(); x.arc(0, 0, 10, 0, 7); x.stroke(); x.beginPath(); x.moveTo(0, 0); x.lineTo(0, -38); x.stroke();
    x.restore();
    if (d.view === 'gun') {
      // Gunner's sight: the eyepiece and the vehicle's reticle.
      const u = H / 582;
      if (v.def.sights === 'bradley') this.reticleBradley(x, cx, cy, u, v.range); else this.reticleAbrams(x, cx, cy, u);
      // Aim marker: the difference between the wanted aim and the turret's actual direction.
      const dyaw = Math.atan2(Math.sin(v.aimYaw - v.yaw() - v.turretYaw), Math.cos(v.aimYaw - v.yaw() - v.turretYaw));
      const fov = (BASE_FOV / this.zoom(d)) * Math.PI / 180, k = H / fov;
      const mx = cx - dyaw * k, my = cy - (v.aimPitch - (v.gunPitch - v.fcs) - v.hullPitch() * Math.cos(v.turretYaw)) * k;
      if (Math.abs(mx - cx) > 3 || Math.abs(my - cy) > 3) { x.strokeStyle = 'rgba(240,220,120,0.8)'; x.beginPath(); x.arc(clamp(mx, 20, W - 20), clamp(my, 20, H - 20), 7, 0, 7); x.stroke(); }
      x.fillStyle = v.def.sights === 'bradley' ? 'rgba(70,225,95,0.9)' : 'rgba(240,60,40,0.9)'; x.font = '600 14px system-ui, sans-serif'; x.textAlign = 'left';
      x.fillText(`${this.zoom(d)}×${this.thermal ? '  WHOT' : ''}`, cx + 150, cy - 8);
      if (v.range && v.def.sights !== 'bradley') x.fillText(`${v.range} m`, cx + 150, cy + 14);
      // Guided missile in flight: keep the sight on the target.
      if (v.mountsOf(v.seatOf(s))[this.weap]?.def.aim === 'launcher') { x.fillText(v.stillT < 4 ? 'LAUNCHER — HALT' : 'TOW READY', cx + 150, cy + 36); }
      x.textAlign = 'start';
    } else if ((d.view === 'station' || d.view === 'hatch') && v.mountsOf(v.seatOf(s))[0]?.def.station?.remote) {
      this.crows(x, W, H, v, v.mountsOf(v.seatOf(s))[0], d);
    } else if ((d.view === 'station' || d.view === 'hatch') && v.mountsOf(v.seatOf(s))[0]?.def.station) {
      // Pintle gun: no reticle — he aims over the gun's own sights (a faint point of focus only).
      x.fillStyle = 'rgba(235,235,215,0.55)'; x.beginPath(); x.arc(cx, cy, 1.6, 0, 7); x.fill();
    } else if (d.view === 'station' || d.view === 'hatch') {
      x.strokeStyle = 'rgba(230,230,210,0.85)'; x.lineWidth = 1.4;
      x.beginPath(); x.arc(cx, cy, 14, 0, 7); x.moveTo(cx - 30, cy); x.lineTo(cx - 14, cy); x.moveTo(cx + 14, cy); x.lineTo(cx + 30, cy); x.moveTo(cx, cy + 14); x.lineTo(cx, cy + 30); x.stroke();
    } else if (d.view === 'hull' && d.role === 'driver') {
      // (Driver: the mask drawn above.)
    } else if (d.view === 'hull' || d.view === 'cargo') {
      // Vision blocks: the view is framed by the periscope slit.
      x.fillStyle = 'rgba(0,0,0,0.88)'; x.fillRect(0, 0, W, H * 0.22); x.fillRect(0, H * 0.72, W, H * 0.28);
    }
  }
}

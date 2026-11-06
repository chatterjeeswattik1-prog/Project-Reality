// The local player: input → soldier, first-person camera (eye height, bob, recoil, zoom), viewmodel.
import * as THREE from 'three';
import { BIND, type Input } from '../core/input';
import { GL_RANGES, type Soldier } from '../game/soldier';
import type { Game } from '../game/game';
import { CAM_RECOIL, Viewmodel } from './viewmodel';
import { WeaponLight, hasLight } from './weaponlight';
import { clamp, damp } from '../core/rng';
import { G_WORLD } from '../world/physics';
import { VehicleControl } from '../vehicles/control';
import type { Vehicle } from '../vehicles/vehicle';
type V3 = [number, number, number];

/** Vertical field of view (degrees); PR/BF2 is about 55° vertical (≈ 90° horizontal at 16:9). Set from the menu. */
export let BASE_FOV = 55;
export function setBaseFov(v: number) { BASE_FOV = v; }

export class Player {
  vm: Viewmodel;
  light: WeaponLight;
  shake = 0;
  zoom = 1;
  private wallDist = 2;
  third = false;
  private sprintLock = false;
  private indoorT = 0; private indoor = 0; private filt = 0;
  /** Freelook (hold Alt): the head turns, the weapon stays on the aim. */
  freeYaw = 0; freePitch = 0;
  /** Controls while riding in a vehicle. */
  vc: VehicleControl;

  constructor(private g: Game, public s: Soldier, private input: Input) {
    this.vm = new Viewmodel(g.gfx.camera, g.assets.weapons, s.team === 'us' ? 0x7d7f6c : 0x5a4e3e, g.assets.fpRigs);
    this.vm.preload(s.slots.map((x) => x.def.model));
    this.vm.set(s.weapon.model, s);
    this.vm.setBody(g.assets.models.get(s.kit.model[0]));
    this.vm.onCue = (name, gain) => g.audio.play(name, null, { gain });
    this.vm.onEject = (p, v, link) => g.fx.casing(p, v, link);
    this.light = new WeaponLight(g.gfx.scene, g.gfx.quality);
    this.vc = new VehicleControl(g, input);
    s.isPlayer = true;
  }

  /** The friendly vehicle within reach (hull within ~2.5 m) and the seat F would take. */
  vehicleFor(s: Soldier): { v: Vehicle; seat: number } | null {
    let best: Vehicle | null = null, bd = 1e9;
    for (const v of this.g.vehicles) {
      if (v.dead || v.team !== s.team) continue;
      const p = v.pos(), d = Math.hypot(p[0] - s.pos[0], p[2] - s.pos[2]) - Math.max(v.def.hull[0], v.def.hull[2]) / 2;
      if (d < 2.5 && d < bd && Math.abs(p[1] - s.pos[1]) < 3) { bd = d; best = v; }
    }
    if (!best) return null;
    const crew = s.kit.role === 'crew';
    const order = ['driver', 'gunner', 'commander', 'loader', 'cargo'];
    for (const role of order) {
      const i = best.seats.findIndex((x) => x.def.role === role && (!x.def.crew || crew) && (!x.who || (!x.who.isPlayer && crew && x.def.crew)));
      if (i >= 0) return { v: best, seat: i };
    }
    return { v: best, seat: -1 };
  }

  setSoldier(s: Soldier) { this.s = s; s.isPlayer = true; this.vm.preload(s.slots.map((x) => x.def.model)); this.vm.set(s.weapon.model, s); this.vm.setBody(this.g.assets.models.get(s.kit.model[0])); }

  /** Per-shot feel: the weapon kicks back into the shoulder and the view shakes a little (the aim itself climbs in Soldier.recoil). */
  onShot(up: number, side: number) {
    this.vm.kick(up, side);
    this.shake += up * 0.0015;
  }

  update(dt: number) {
    const s = this.s, I = this.input, cam = this.g.gfx.camera;
    // In a vehicle: its seat, views and weapons (vehicles/control.ts).
    if (s.vehicle) {
      this.vc.update(dt, s); this.zoom = 1; this.shake *= Math.exp(-5 * dt);
      this.vm.group.visible = false; this.g.hud?.prompt(null);
      return;
    }
    this.vc.setFilter('');
    if (s.alive && I.locked) {
      // Look: slower when zoomed.
      const sens = I.sens / Math.max(1, this.zoom * 0.85);
      const dyaw = -I.mouse.dx * sens, dpitch = -I.mouse.dy * sens;
      const free = I.is(BIND.freeLook) && s.ads < 0.5;
      if (free) { this.freeYaw = clamp(this.freeYaw + dyaw, -1.75, 1.75); this.freePitch = clamp(this.freePitch + dpitch, -1.0, 1.0); }
      else { s.yaw += dyaw; s.pitch = clamp(s.pitch + dpitch, -1.45, 1.45); }
      // Lean (hold Q / E).
      s.leanWant = (I.is(BIND.leanR) ? 1 : 0) - (I.is(BIND.leanL) ? 1 : 0);
      if (s.stance === 'prone') s.pitch = clamp(s.pitch, -0.35, 0.6);
      // A deployed bipod only traverses so far (wider prone, where the body can pivot round it).
      if (s.support === 'bipod') {
        const lim = s.stance === 'prone' ? 0.6 : 0.45;
        let dy = s.yaw - s.bipodYaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        s.yaw = s.bipodYaw + clamp(dy, -lim, lim); s.pitch = clamp(s.pitch, s.bipodPitch - 0.2, s.bipodPitch + 0.25);
      }

      // Stance.
      if (I.hit(BIND.crouch) || I.hit(BIND.crouch2)) s.setStance(s.stance === 'crouch' ? 'stand' : 'crouch', this.g.time);
      if (I.hit(BIND.prone)) s.setStance(s.stance === 'prone' ? 'stand' : 'prone', this.g.time);
      if (I.hit(BIND.jump) && s.stance !== 'stand') { s.setStance('stand', this.g.time); }
      // Weapons.
      for (let i = 0; i < 5; i++) if (I.hit(`Digit${i + 1}`)) {
        if (i === s.cur && s.slot.gl !== undefined) { s.underSel = !s.underSel; s.switchT = 0.5; }
        else s.select(i);
      }
      if (I.mouse.wheel && !s.sprinting) s.select((s.cur + I.mouse.wheel + s.slots.length) % s.slots.length);
      if (I.hit(BIND.reload)) this.g.reload(s);
      // M203 quadrant sight: PageUp / PageDown set the range (the sight tips the rifle up for it).
      if (s.slot.gl !== undefined && (I.hit(BIND.rangeUp) || I.hit(BIND.rangeDown))) {
        const i = GL_RANGES.indexOf(s.glRange), j = Math.max(0, Math.min(GL_RANGES.length - 1, (i < 0 ? 4 : i) + (I.hit(BIND.rangeUp) ? 1 : -1)));
        s.glRange = GL_RANGES[j]; this.g.audio.play('switch_fire_mode', null, { gain: 0.35, rate: 0.8 }); this.g.hud.flash(`M203 ${s.glRange} m`);
      }
      if (I.hit(BIND.mode)) { const m = s.weapon.modes; s.slot.mode = m[(m.indexOf(s.slot.mode) + 1) % m.length]; this.g.audio.play('switch_fire_mode', null, { gain: 0.5 }); this.g.hud.flash(`${s.slot.mode.toUpperCase()}`); }
      // F: get into a vehicle beside you, pick up the weapon looked at, else open/close the door in front, otherwise
      // apply a field dressing.
      const vh = s.alive ? this.vehicleFor(s) : null;
      const pk = s.alive && !vh ? this.g.pickupFor(s) : null;
      if (vh) this.g.hud?.prompt(vh.seat >= 0 ? `F — get in the ${vh.v.def.name} (${vh.v.seats[vh.seat].def.label})` : `${vh.v.def.name}: crew seats need the Crewman kit`);
      if (vh && I.hit(BIND.use)) { if (vh.seat >= 0) this.vc.trySeat(s, vh.v, vh.seat); }
      else if (!vh) this.g.hud?.prompt(pk ? `F — pick up ${pk.slot.def.name} (${pk.slot.mags.length + (pk.slot.loaded > 0 ? 1 : 0)} mag${pk.slot.mags.length + (pk.slot.loaded > 0 ? 1 : 0) === 1 ? '' : 's'})` : null);
      if (vh) { /* handled above */ }
      else if (I.hit(BIND.use) && pk) { this.g.pickUp(s, pk); this.g.hud?.flash(pk.slot.def.name.toUpperCase()); }
      else if (I.hit(BIND.use)) {
        if (this.g.doors?.use(s.eye, s.aimDir())) this.g.audio.play('car_door', null, { gain: 0.5, rate: 0.8 });
        else if (s.startBandage()) this.g.audio.play('bandage', null);
      }
      if (I.hit(BIND.bipod)) {
        const was = s.support === 'bipod', on = s.toggleBipod();
        if (on) { this.g.audio.play('bolt_release', null, { gain: 0.5, rate: 0.7 }); this.g.hud.flash('BIPOD DEPLOYED'); }
        else if (was) this.g.audio.play('bolt_release', null, { gain: 0.35, rate: 0.8 });
        else this.g.hud.flash(s.weapon.bipod ? 'Nothing to deploy the bipod on' : 'No bipod on this weapon');
      }
      // Fireteam orders (the player leads the bots on their team): move there / hold–form up / suppress there.
      const ft = this.g.fireteam;
      if (ft && ft.team === s.team && (I.hit(BIND.orderMove) || I.hit(BIND.orderSuppress) || I.hit(BIND.orderHold))) {
        const d = s.aimDir(), h = this.g.P.castRay(s.eye, d, 150);
        const p: [number, number, number] | undefined = h ? [h.point[0], h.point[1], h.point[2]] : undefined;
        if (I.hit(BIND.orderHold)) ft.command('hold');
        else if (I.hit(BIND.orderMove)) { if (p) ft.command('move', [p[0] - d[0] * 0.8, p[1], p[2] - d[2] * 0.8]); }
        else if (p) ft.command('suppress', p);
        this.g.audio.play('radio_squelch', null, { gain: 0.4 });
      }
      if (I.hit(BIND.light) && hasLight(s)) { s.light = !s.light; this.g.audio.play('switch_fire_mode', null, { gain: 0.35, rate: 1.4 }); }
    }
    // Aiming (hold right mouse). Raising the sights takes longer with heavy weapons.
    const canAim = s.alive && s.reloadT <= 0 && s.switchT <= 0 && s.bandageT <= 0 && !s.sprinting && s.weapon.optic !== 'none';
    s.aiming = canAim && this.input.mouse.right;
    const rate = 1 / (0.18 + s.weapon.mass * 0.03);
    s.ads = clamp(s.ads + (s.aiming ? rate : -rate * 1.6) * dt, 0, 1);
    // Hold breath (Shift while aimed and not walking forward): steadier sights for a few seconds.
    s.holdBreath = s.aiming && s.ads > 0.9 && I.is(BIND.sprint) && !I.is(BIND.fwd);
    // Movement.
    const f = (I.is(BIND.fwd) ? 1 : 0) - (I.is(BIND.back) ? 1 : 0), r = (I.is(BIND.right) ? 1 : 0) - (I.is(BIND.left) ? 1 : 0);
    // Once exhausted, sprint stays locked until Shift is released or stamina is back above half (PR style).
    if (s.stamina <= 0.5) this.sprintLock = true;
    if (this.sprintLock && (!I.is(BIND.sprint) || s.stamina > 50)) this.sprintLock = false;
    s.sprinting = s.alive && I.is(BIND.sprint) && f > 0 && s.stance !== 'prone' && !this.sprintLock && (s.sprinting || s.stamina > 15) && s.reloadT <= 0;
    if (s.sprinting && s.stance === 'crouch') s.setStance('stand', this.g.time);
    const sp = s.maxSpeed(), len = Math.hypot(f, r) || 1;
    const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw), rx = Math.cos(s.yaw), rz = -Math.sin(s.yaw);
    const want: [number, number] = [(fx * f + rx * r) / len * sp, (fz * f + rz * r) / len * sp];
    if (!I.locked) { want[0] = want[1] = 0; }
    s.move(dt, want, I.locked && I.hit(BIND.jump) && s.stance === 'stand');
    // Trigger.
    if (I.locked) this.g.trigger(s, I.mouse.left, I.mouse.leftPressed, I.mouse.right);
    // Camera.
    this.shake *= Math.exp(-7 * dt);
    if (!I.is(BIND.freeLook) || s.ads >= 0.5) { const k = Math.exp(-14 * dt); this.freeYaw *= k; this.freePitch *= k; if (Math.abs(this.freeYaw) + Math.abs(this.freePitch) < 1e-3) this.freeYaw = this.freePitch = 0; }
    const def = s.underSel ? null : s.weapon, mag = s.ads > 0.95 && def ? def.zoom : 1 + (def ? (def.zoom > 1.5 ? 0.25 : def.zoom - 1) : 0) * s.ads;
    this.zoom += (mag - this.zoom) * damp(14, dt);
    cam.fov = BASE_FOV / this.zoom; cam.updateProjectionMatrix();
    const e = s.eye;
    const bob = s.onGround ? Math.sin(performance.now() / 1000 * 9) * 0.02 * Math.min(1, s.moving / 4) * (1 - s.ads) : 0;
    cam.position.set(e[0], e[1] + bob, e[2]);
    const sh = this.shake, n = performance.now() / 1000;
    const wounded = s.state === 'wounded';
    // The view follows most of the recoil climb; the rest, and the sway, move the weapon in front of the eye
    // (Viewmodel.update rotates it about the eye), so the sights always point where the round goes.
    // Leaning tilts the view with the body; freelook turns the head away from the weapon.
    const aimP = s.pitch + s.rcP * CAM_RECOIL + Math.sin(n * 47) * sh * 0.02, aimY = s.yaw + s.rcY * CAM_RECOIL + Math.sin(n * 39) * sh * 0.02, roll = -s.lean * 0.2;
    cam.rotation.set(wounded ? -0.9 : aimP + this.freePitch, aimY + this.freeYaw, wounded ? 0.5 : Math.sin(n * 31) * sh * 0.01 + roll, 'YXZ');
    // The weapon (child of the camera) keeps pointing along the aim while the head looks round.
    if (this.freeYaw || this.freePitch) { cam.updateMatrixWorld(); this.vm.group.quaternion.copy(cam.quaternion).invert().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(aimP, aimY, roll, 'YXZ'))); }
    else this.vm.group.quaternion.identity();
    if (wounded || s.state === 'dead') cam.position.y = s.pos[1] + 0.25;
    // Wall distance for the viewmodel pull-back.
    // The eye line, plus the barrel line at the hip (below and right of the eye) so a lowered rifle does not go
    // through a parapet the eye looks over.
    const d = s.aimDir(), hip = 1 - s.ads, dn = (s.stance === 'prone' ? 0.1 : 0.22) * hip, rt = 0.12 * hip;
    const rgt: V3 = [Math.cos(s.yaw), 0, -Math.sin(s.yaw)];
    const up: V3 = [rgt[1] * d[2] - rgt[2] * d[1], rgt[2] * d[0] - rgt[0] * d[2], rgt[0] * d[1] - rgt[1] * d[0]];
    let wd = 2;
    for (const [a, b] of [[0, 0], [dn, rt], [dn * 0.5, rt * 0.5]]) {
      const o: V3 = [e[0] - up[0] * a + rgt[0] * b, e[1] - up[1] * a + rgt[1] * b, e[2] - up[2] * a + rgt[2] * b];
      const hit = this.g.P.castRay(o, d, 1.2, G_WORLD); if (hit) wd = Math.min(wd, hit.dist);
    }
    this.wallDist = wd;
    this.vm.set(s.weapon.model, s);
    // Suppression (Squad): the picture drains of colour and, under heavy fire, blurs; it comes back as the fire stops.
    const sup = s.alive ? s.suppress : 0;
    if (Math.abs(sup - this.filt) > 0.03 || (sup === 0 && this.filt !== 0)) {
      this.filt = sup;
      this.g.gfx.renderer.domElement.style.filter = sup < 0.05 ? '' : `saturate(${(1 - sup * 0.6).toFixed(2)}) contrast(${(1 + sup * 0.12).toFixed(2)})${sup > 0.55 ? ` blur(${((sup - 0.55) * 3).toFixed(2)}px)` : ''}`;
    }
    // Indoors the weapon reflects the dim room, not the sky.
    if ((this.indoorT -= dt) <= 0) { this.indoorT = 0.5; this.indoor = this.g.audio.indoorAt(e) ? 1 : 0; }
    this.vm.setEnv(THREE.MathUtils.lerp(0.75, 0.22, this.indoor));
    this.vm.update(dt, s, [I.mouse.dx, I.mouse.dy], this.wallDist, def?.optic ?? 'irons');
    // Hide the model when looking through a magnified optic (the HUD draws the scope).
    this.vm.group.visible = s.alive && !(this.scoped());
    this.light.update(s, this.vm, cam);
  }

  /** True when the view is through a magnified optic (scope overlay). */
  scoped() { const d = this.s.weapon; return !this.s.underSel && this.s.ads > 0.97 && d.zoom >= 2.5; }

  /** Camera forward (for audio). */
  forward(): [number, number, number] { const v = new THREE.Vector3(0, 0, -1).applyQuaternion(this.g.gfx.camera.quaternion); return [v.x, v.y, v.z]; }
}

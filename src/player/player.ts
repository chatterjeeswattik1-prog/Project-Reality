// The local player: input → soldier, first-person camera (eye height, bob, recoil, zoom), viewmodel.
import * as THREE from 'three';
import { BIND, type Input } from '../core/input';
import type { Soldier } from '../game/soldier';
import type { Game } from '../game/game';
import { Viewmodel } from './viewmodel';
import { WeaponLight, hasLight } from './weaponlight';
import { clamp, damp } from '../core/rng';

/** Vertical field of view (degrees); PR/BF2 is about 55° vertical (≈ 90° horizontal at 16:9). Set from the menu. */
export let BASE_FOV = 55;
export function setBaseFov(v: number) { BASE_FOV = v; }

export class Player {
  vm: Viewmodel;
  light: WeaponLight;
  /** View recoil offsets (rad), recovered over time. */
  kickP = 0; kickY = 0;
  shake = 0;
  zoom = 1;
  private wallDist = 2;
  third = false;
  private sprintLock = false;

  constructor(private g: Game, public s: Soldier, private input: Input) {
    this.vm = new Viewmodel(g.gfx.camera, g.assets.weapons, s.team === 'us' ? 0x7d7f6c : 0x5a4e3e);
    this.vm.set(s.weapon.model);
    this.vm.setBody(g.assets.models.get(s.kit.model[0]));
    this.light = new WeaponLight(g.gfx.scene, g.gfx.quality);
    s.isPlayer = true;
  }

  setSoldier(s: Soldier) { this.s = s; s.isPlayer = true; this.vm.set(s.weapon.model); this.vm.setBody(this.g.assets.models.get(s.kit.model[0])); this.kickP = this.kickY = 0; }

  onShot(up: number, side: number) {
    this.kickP += up * 0.001; this.kickY += side * 0.001;
    this.vm.kick(up);
    this.shake += up * 0.002;
  }

  update(dt: number) {
    const s = this.s, I = this.input, cam = this.g.gfx.camera;
    if (s.alive && I.locked) {
      // Look: slower when zoomed.
      const sens = I.sens / Math.max(1, this.zoom * 0.85);
      const dyaw = -I.mouse.dx * sens, dpitch = -I.mouse.dy * sens;
      s.yaw += dyaw; s.pitch = clamp(s.pitch + dpitch, -1.45, 1.45);
      if (s.stance === 'prone') s.pitch = clamp(s.pitch, -0.35, 0.6);
      // Turning quickly unsettles the aim (PR).
      s.dev = Math.max(s.dev, s.dev + Math.abs(dyaw) * 220 + Math.abs(dpitch) * 160);

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
      if (I.hit(BIND.mode)) { const m = s.weapon.modes; s.slot.mode = m[(m.indexOf(s.slot.mode) + 1) % m.length]; this.g.audio.play('switch_fire_mode', null, { gain: 0.5 }); this.g.hud.flash(`${s.slot.mode.toUpperCase()}`); }
      if (I.hit(BIND.bandage)) { if (s.startBandage()) this.g.audio.play('bandage', null); }
      if (I.hit(BIND.light) && hasLight(s)) { s.light = !s.light; this.g.audio.play('switch_fire_mode', null, { gain: 0.35, rate: 1.4 }); }
      if (I.hit(BIND.use) && this.g.doors?.use(s.eye, s.aimDir())) this.g.audio.play('car_door', null, { gain: 0.5, rate: 0.8 });
    }
    // Aiming (hold right mouse). Raising the sights takes longer with heavy weapons.
    const canAim = s.alive && s.reloadT <= 0 && s.switchT <= 0 && s.bandageT <= 0 && !s.sprinting && s.weapon.optic !== 'none';
    s.aiming = canAim && this.input.mouse.right;
    const rate = 1 / (0.18 + s.weapon.mass * 0.03);
    s.ads = clamp(s.ads + (s.aiming ? rate : -rate * 1.6) * dt, 0, 1);
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
    this.kickP *= Math.exp(-6 * dt); this.kickY *= Math.exp(-6 * dt);
    this.shake *= Math.exp(-5 * dt);
    const def = s.underSel ? null : s.weapon, mag = s.ads > 0.95 && def ? def.zoom : 1 + (def ? (def.zoom > 1.5 ? 0.25 : def.zoom - 1) : 0) * s.ads;
    this.zoom += (mag - this.zoom) * damp(14, dt);
    cam.fov = BASE_FOV / this.zoom; cam.updateProjectionMatrix();
    const e = s.eye;
    const bob = s.onGround ? Math.sin(performance.now() / 1000 * 9) * 0.02 * Math.min(1, s.moving / 4) * (1 - s.ads) : 0;
    cam.position.set(e[0], e[1] + bob, e[2]);
    const sh = this.shake, n = performance.now() / 1000;
    const wounded = s.state === 'wounded';
    // Aimed: the view itself sways with the unsettled aim (the sight's centre is where the round goes).
    const wy = s.wob[0] * s.ads, wp = s.wob[1] * s.ads;
    cam.rotation.set(wounded ? -0.9 : s.pitch + wp + this.kickP + Math.sin(n * 47) * sh * 0.02, s.yaw + wy + this.kickY + Math.sin(n * 39) * sh * 0.02, wounded ? 0.5 : Math.sin(n * 31) * sh * 0.01, 'YXZ');
    if (wounded || s.state === 'dead') cam.position.y = s.pos[1] + 0.25;
    // Wall distance for the viewmodel pull-back.
    const d = s.aimDir(); const hit = this.g.P.castRay(e, d, 1.2);
    this.wallDist = hit ? hit.dist : 2;
    this.vm.set(s.underSel ? s.weapon.model : s.weapon.model);
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

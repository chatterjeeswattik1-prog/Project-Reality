// First-person weapon: hip and aimed poses (the weapon's `eye` empty is brought onto the camera axis), sway, bob,
// recoil spring, reload motion (the `mag`/`box` node drops and returns), wall pull-back, and simple gloved arms.
import * as THREE from 'three';
import type { Soldier } from '../game/soldier';
import { damp } from '../core/rng';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { armIK, wrapHand, wristTarget } from '../game/rig';

const EYE_RELIEF: Record<string, number> = { acog: 0.07, rco: 0.07, scope10: 0.09, pso1: 0.08, pgo7: 0.07, irons: 0.17, none: 0.2 };

export class Viewmodel {
  group = new THREE.Group();
  private model: THREE.Object3D | null = null;
  private id = '';
  private mag: THREE.Object3D | null = null; private magHome = new THREE.Vector3();
  private eyeLocal = new THREE.Vector3(0, 0.1, 0); private muzzleLocal = new THREE.Vector3(0, 0.08, -0.6);
  private gripR = new THREE.Vector3(); private gripL = new THREE.Vector3(0, 0, -0.3);
  private arms: THREE.Group;
  sway = new THREE.Vector2(); private swayV = new THREE.Vector2();
  recoil = 0; private recoilV = 0; private roll = 0;
  bob = 0; private pull = 0;
  ads = 0;
  private sprintK = 0; private switchK = 0;
  private cheekLocal: THREE.Vector3 | null = null;
  private cheekGl: THREE.Vector3 | null = null; private glTilt = 0;
  /** First-person body: the player's character with only its arms shown, posed by IK onto the weapon grips. */
  private body: THREE.Object3D | null = null;
  private bones: Record<string, THREE.Bone> = {};
  private bind = new Map<THREE.Bone, THREE.Quaternion>();

  constructor(camera: THREE.PerspectiveCamera, private weapons: Map<string, THREE.Object3D>, sleeve: number) {
    camera.add(this.group);
    const sleeveM = new THREE.MeshStandardMaterial({ color: sleeve, roughness: 0.9 }), glove = new THREE.MeshStandardMaterial({ color: 0x5a4a36, roughness: 0.8 });
    this.arms = new THREE.Group();
    for (const side of ['r', 'l']) {
      const fore = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 0.42, 10).rotateX(Math.PI / 2).translate(0, 0, 0.21), sleeveM); fore.name = `fore_${side}`;
      const hand = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.1, 0.11), glove); hand.name = `hand_${side}`;
      this.arms.add(fore, hand);
    }
    this.arms.traverse((o) => { (o as THREE.Mesh).castShadow = false; });
    this.group.add(this.arms);
  }

  setBody(src: THREE.Object3D | null | undefined) {
    if (this.body) this.group.remove(this.body);
    this.body = null; this.bones = {}; this.bind.clear();
    this.arms.visible = !src;
    if (!src) return;
    const b = SkeletonUtils.clone(src);
    b.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (m.isMesh) { m.visible = /arms/i.test(m.name) || /arms/i.test(m.geometry?.name ?? ''); m.castShadow = false; m.receiveShadow = true; m.frustumCulled = false; }
      const bn = o as THREE.Bone; if (bn.isBone) { this.bones[bn.name] = bn; this.bind.set(bn, bn.quaternion.clone()); }
    });
    // A uniform 8% scale gives the arms enough reach for long guns from a camera-attached body. (Non-uniform bone
    // scaling would shear the wrist once the arm rotates.)
    b.scale.setScalar(1.08);
    this.group.add(b);
    this.group.updateMatrixWorld(true);
    // Put the head bone just behind and above the eye so the shoulders sit below the view.
    const head = this.bones.Head ?? this.bones.head ?? this.bones.neck_01;
    if (head) { const h = this.group.worldToLocal(head.getWorldPosition(new THREE.Vector3())); b.position.sub(h).add(new THREE.Vector3(0, -0.04, 0.03)); }
    this.body = b;
  }

  set(id: string) {
    if (id === this.id) return;
    this.id = id;
    if (this.model) this.group.remove(this.model);
    const src = this.weapons.get(id);
    this.model = src ? src.clone() : this.placeholder();
    this.model.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = false; m.receiveShadow = true; } });
    this.group.add(this.model);
    const e = (n: string, def: THREE.Vector3) => this.model!.getObjectByName(n)?.position.clone() ?? def;
    this.eyeLocal = e('eye', new THREE.Vector3(0, 0.12, 0));
    this.cheekLocal = this.model.getObjectByName('cheek')?.position.clone() ?? null;
    // M203 leaf sight: its own cheek point and a sight line (eye_gl → front_gl) tilted up from the bore.
    const cg = this.model.getObjectByName('cheek_gl'), eg = this.model.getObjectByName('eye_gl'), fg = this.model.getObjectByName('front_gl');
    this.cheekGl = cg ? cg.position.clone() : null;
    this.glTilt = eg && fg ? Math.atan2(fg.position.y - eg.position.y, -(fg.position.z - eg.position.z)) : 0;
    this.muzzleLocal = e('muzzle', new THREE.Vector3(0, 0.08, -0.6));
    this.gripR = e('grip_r', new THREE.Vector3()); this.gripL = e('grip_l', new THREE.Vector3(0, 0.03, -0.3));
    this.mag = this.model.getObjectByName('mag') ?? this.model.getObjectByName('box') ?? this.model.getObjectByName('rocket') ?? null;
    if (this.mag) this.magHome.copy(this.mag.position);
    this.recoil = 0; this.ads = 0;
  }
  private placeholder(): THREE.Object3D {
    const g = new THREE.Group(), m = new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.5, metalness: 0.4 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.1, 0.5), m); body.position.set(0, 0.06, -0.15); g.add(body);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.35, 8).rotateX(Math.PI / 2), m); barrel.position.set(0, 0.08, -0.55); g.add(barrel);
    const eye = new THREE.Object3D(); eye.name = 'eye'; eye.position.set(0, 0.14, 0); g.add(eye);
    const mz = new THREE.Object3D(); mz.name = 'muzzle'; mz.position.set(0, 0.08, -0.72); g.add(mz);
    return g;
  }

  kick(up: number) { this.recoilV += up * 0.14; this.roll += (Math.random() - 0.5) * up * 0.004; }

  /** Muzzle world position (for flashes). */
  /** Barrel direction in world space (models point −Z); false when no model. */
  forward(out: THREE.Vector3) { if (!this.model) return false; this.model.getWorldDirection(out).negate(); return true; }
  muzzleWorld(out = new THREE.Vector3()) { return this.model ? this.model.localToWorld(out.copy(this.muzzleLocal)) : out.set(0, 0, 0); }

  update(dt: number, s: Soldier, mouse: [number, number], wallDist: number, optic: string) {
    if (!this.model) return;
    this.ads = s.ads;
    const t = performance.now() / 1000, ads = THREE.MathUtils.smoothstep(this.ads, 0, 1);
    // Sway: lag behind the mouse, spring back; breathing; more when tired.
    // The weapon lags behind fast mouse motion. Springs are integrated in fixed 240 Hz substeps (semi-implicit Euler),
    // so they behave the same at 20 or 144 FPS — a single explicit step per frame went unstable at low frame rates and
    // flipped the weapon between two poses every frame.
    const mvx = mouse[0] / Math.max(dt, 1e-3), mvy = mouse[1] / Math.max(dt, 1e-3);
    const tx = THREE.MathUtils.clamp(-mvx * 0.000012, -0.035, 0.035), ty = THREE.MathUtils.clamp(mvy * 0.000012, -0.035, 0.035);
    const n = Math.min(40, Math.ceil(dt * 240)), h = dt / n;
    for (let i = 0; i < n; i++) {
      // Sway: critically damped spring towards the lag target (ω = 14 rad/s).
      this.swayV.x += ((tx - this.sway.x) * 196 - this.swayV.x * 28) * h; this.swayV.y += ((ty - this.sway.y) * 196 - this.swayV.y * 28) * h;
      this.sway.x += this.swayV.x * h; this.sway.y += this.swayV.y * h;
      // Recoil: under-damped spring back to rest (ω = 22 rad/s, ζ ≈ 0.6).
      this.recoilV += (-this.recoil * 484 - this.recoilV * 26) * h; this.recoil += this.recoilV * h;
    }
    this.sway.clampScalar(-0.05, 0.05); this.recoil = THREE.MathUtils.clamp(this.recoil, -0.05, 0.12);
    const tired = 1 + (100 - s.stamina) / 40;
    const breathe = new THREE.Vector2(Math.sin(t * 0.9) * 0.0016 * tired, Math.sin(t * 1.8) * 0.0012 * tired);
    // Walk bob.
    const sp = Math.hypot(s.vel[0], s.vel[2]);
    this.bob += dt * sp * (s.sprinting ? 2.2 : 2.6);
    const bobA = Math.min(1, sp / 3) * (s.stance === 'prone' ? 0.3 : 1) * (1 - ads * 0.85);
    const bx = Math.sin(this.bob) * 0.012 * bobA, by = -Math.abs(Math.cos(this.bob)) * 0.01 * bobA;
    // Recoil spring.
    this.roll *= Math.exp(-8 * dt);
    // Poses: hip (low right), aimed (sight on the camera axis), sprint (canted down), reload (tilted).
    const relief = EYE_RELIEF[optic] ?? 0.15;
    // Aimed: the weapon's `cheek` point (cheek weld) sits at the camera; older models fall back to the sight + relief.
    const gl = s.underSel && this.cheekGl;
    const hip = new THREE.Vector3(0.13, -0.15, -0.18), aim = gl ? this.cheekGl!.clone().applyEuler(new THREE.Euler(-this.glTilt, 0, 0, "YXZ")).negate() : this.cheekLocal ? this.cheekLocal.clone().negate() : new THREE.Vector3(-this.eyeLocal.x, -this.eyeLocal.y, -relief - this.eyeLocal.z);
    const kind = s.weapon.kind;
    // Launchers ride on the shoulder (just below the aimed position); throwables are held low in the firing hand.
    // Long guns sit a little closer so the support hand reaches their handguard.
    hip.z += Math.max(0, -0.3 - this.gripL.z) * 0.7;
    if (kind === 'launcher') hip.copy(aim).add(new THREE.Vector3(0.1, -0.09, 0.06));
    else if (kind === 'grenade' || kind === 'charge') hip.set(0.17, -0.2, -0.33);
    const pos = hip.lerp(aim, ads);
    let rx = 0, ry = 0, rz = 0;
    // Sprint carry: blended in and out (never snapped) so brief speed changes do not flip the weapon up and down.
    this.sprintK += ((s.sprinting && sp > 0.8 ? 1 : 0) - this.sprintK) * damp(s.sprinting ? 7 : 5, dt);
    const sk = THREE.MathUtils.smoothstep(this.sprintK, 0, 1);
    pos.add(new THREE.Vector3(0.06 * sk, -0.08 * sk, 0.04 * sk)); rx = -0.5 * sk; ry = 0.6 * sk; rz = 0.25 * sk;
    const reloading = s.reloadT > 0 ? Math.sin(Math.min(1, 1 - s.reloadT / Math.max(0.1, s.reloadDur)) * Math.PI) : 0;
    rz += reloading * 0.45; rx += reloading * 0.25; pos.y -= reloading * 0.04;
    this.switchK += ((s.switchT > 0 ? Math.min(1, s.switchT * 2) : 0) - this.switchK) * damp(12, dt);
    pos.y -= this.switchK * 0.25;
    if (s.bandageT > 0) pos.y -= 0.3;
    // Pull back from walls so the barrel does not poke through.
    this.pull += (Math.max(0, 0.75 - wallDist) - this.pull) * damp(12, dt);
    pos.z += this.pull * 0.45; rx += this.pull * 0.6;
    pos.x += bx + this.sway.x * (1 - ads * 0.7) + breathe.x; pos.y += by + this.sway.y * (1 - ads * 0.7) + breathe.y;
    pos.z += this.recoil * 0.35;
    this.model.position.copy(pos);
    // Aiming the M203: tilt the rifle down so the leaf sight line (not the bore) points where the camera looks.
    if (gl) rx -= this.glTilt * ads;
    // From the hip the weapon itself wanders with the unsettled aim.
    rx += s.wob[1] * (1 - ads) * 1.5; ry += s.wob[0] * (1 - ads) * 1.5;
    this.model.rotation.set(rx + this.recoil * 1.2, ry, rz + this.roll, 'YXZ');
    if (this.mag) {
      this.mag.position.copy(this.magHome);
      if (s.reloadT > 0) { const k = Math.sin(Math.min(1, 1 - s.reloadT / Math.max(0.1, s.reloadDur)) * Math.PI); this.mag.position.y -= k * 0.25; this.mag.position.z += k * 0.05; }
      this.mag.visible = !(s.weapon.kind === 'launcher' && s.slot.loaded === 0 && s.reloadT <= 0);
    }
    // Arms: forearms reach back from the grips towards the elbows (below and behind the view).
    this.model.updateMatrix();
    const place = (side: 'r' | 'l', grip: THREE.Vector3, elbow: THREE.Vector3) => {
      const g = grip.clone().applyMatrix4(this.model!.matrix);
      const hand = this.arms.getObjectByName(`hand_${side}`)!, fore = this.arms.getObjectByName(`fore_${side}`)!;
      hand.position.copy(g); hand.quaternion.copy(this.model!.quaternion);
      fore.position.copy(g); fore.lookAt(this.group.localToWorld(elbow.clone()));
    };
    if (!this.body) {
      place('r', this.gripR, new THREE.Vector3(0.28, -0.42, 0.05));
      place('l', this.gripL, new THREE.Vector3(-0.2, -0.45, -0.05));
    } else {
      // Arms from the shoulders to the grips (world space), elbows down and out, hands wrapped round the grips.
      for (const [bn, q] of this.bind) if (/arm|hand|clavicle|index|middle|ring|pinky|thumb/.test(bn.name)) bn.quaternion.copy(q);
      this.group.updateMatrixWorld(true);
      const B = this.bones, wq = this.model.getWorldQuaternion(new THREE.Quaternion());
      const gr = this.model.localToWorld(this.gripR.clone()), gl = this.model.localToWorld(this.gripL.clone());
      if (B.upperarm_r && B.lowerarm_r && B.hand_r) { armIK(B, 'r', wristTarget(gr, wq, 'r'), this.group.localToWorld(new THREE.Vector3(0.5, -0.7, 0.1)), 0.06); wrapHand(B, wq, 'r', this.bind); }
      const oneHand = s.weapon.kind === 'grenade' || s.weapon.kind === 'charge';
      // One-handed items: the support arm hangs down out of view.
      const lt = oneHand ? this.group.localToWorld(new THREE.Vector3(-0.28, -0.75, -0.05)) : wristTarget(gl, wq, 'l');
      if (B.upperarm_l && B.lowerarm_l && B.hand_l) { armIK(B, 'l', lt, this.group.localToWorld(new THREE.Vector3(-0.45, -0.7, -0.15))); if (!oneHand) wrapHand(B, wq, 'l', this.bind); }
    }
    this.group.visible = s.alive;
  }
}

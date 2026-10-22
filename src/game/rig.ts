// Third-person body for a soldier: skinned Quaternius character + shared animation library (locomotion by stance and
// velocity), spine pitched to the aim and two-bone IK putting the hands on the weapon's grip points. Falls back to a
// posed mannequin when the character files are missing. Distant bodies update at a lower rate.
import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { Soldier } from './soldier';
import { damp } from '../core/rng';

export interface CharAssets { models: Map<string, THREE.Object3D>; clips: Map<string, THREE.AnimationClip>; weapons: Map<string, THREE.Object3D>; tpWeapons: Map<string, THREE.Object3D> }

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3(), _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();

/** Rotate `bone` (world space) so the direction from it to `child` turns from `from` to `to`. */
function aimBone(bone: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3) {
  _q1.setFromUnitVectors(from, to);
  bone.getWorldQuaternion(_q2);
  _q2.premultiply(_q1);
  // world → local
  const parentQ = bone.parent ? bone.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
  bone.quaternion.copy(parentQ.invert().multiply(_q2));
  bone.updateMatrixWorld(true);
}

/** Analytic two-bone IK: upper → lower → hand reaches `target`, elbow bent towards `pole`. */
export function twoBoneIK(upper: THREE.Bone, lower: THREE.Bone, hand: THREE.Bone, target: THREE.Vector3, pole: THREE.Vector3) {
  const A = upper.getWorldPosition(_v1), B = lower.getWorldPosition(_v2), C = hand.getWorldPosition(_v3);
  const a = A.distanceTo(B), b = B.distanceTo(C);
  const AT = _v4.copy(target).sub(A); let d = AT.length();
  if (d < 1e-4) return;
  d = Math.min(d, (a + b) * 0.999); const dir = AT.normalize();
  const cosA = THREE.MathUtils.clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1), sinA = Math.sqrt(1 - cosA * cosA);
  const pv = pole.clone().sub(A); pv.sub(dir.clone().multiplyScalar(pv.dot(dir)));
  if (pv.lengthSq() < 1e-8) pv.set(0, -1, 0); pv.normalize();
  const elbow = A.clone().addScaledVector(dir, a * cosA).addScaledVector(pv, a * sinA);
  aimBone(upper, B.clone().sub(A).normalize(), elbow.clone().sub(A).normalize());
  const B2 = lower.getWorldPosition(new THREE.Vector3()), C2 = hand.getWorldPosition(new THREE.Vector3());
  aimBone(lower, C2.sub(B2).normalize(), target.clone().sub(B2).normalize());
}

const GROUND_BONES = ['pelvis', 'spine_02', 'spine_03', 'Head', 'hand_l', 'hand_r', 'lowerarm_l', 'lowerarm_r', 'calf_l', 'calf_r', 'foot_l', 'foot_r'];

/** Generous bounds for skinned bodies (any pose, including prone) so frustum culling stays correct. */
const BODY_SPHERE = new THREE.Sphere(new THREE.Vector3(0, 0.8, 0), 2.0);

/**
 * Hand poses on a long gun, as world directions in the weapon frame (−Z muzzle, +Y up, +X right):
 *  r — firing hand on the pistol grip: fingers (wrist → knuckles) forward-down along the grip, palm to the weapon's left;
 *  l — support hand under the handguard: fingers across to the right, palm up.
 * Bones run along local +Y; which local direction is the palm is measured from the skeleton (see palmOf).
 */
function handTarget(wq: THREE.Quaternion, side: 'r' | 'l') {
  const y = (side === 'r' ? new THREE.Vector3(0, -0.55, -1) : new THREE.Vector3(1, 0.1, -0.3)).applyQuaternion(wq).normalize();
  const palm = (side === 'r' ? new THREE.Vector3(-1, 0, 0) : new THREE.Vector3(0, 1, 0)).applyQuaternion(wq);
  palm.sub(y.clone().multiplyScalar(palm.dot(y))).normalize();
  return { y, palm };
}

/** Where the wrist (hand bone) must be so the palm closes on `grip`. */
export function wristTarget(grip: THREE.Vector3, wq: THREE.Quaternion, side: 'r' | 'l'): THREE.Vector3 {
  const a = handTarget(wq, side);
  return grip.clone().addScaledVector(a.y, -0.075).addScaledVector(a.palm, -0.035);
}

const FINGERS = ['index', 'middle', 'ring', 'pinky'];
const CURL: Record<'r' | 'l', number[]> = { r: [1.05, 1.25, 0.85], l: [0.8, 1.0, 0.65] };
const curlQ = (a: number) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), a);

/** The palm direction in hand-local space: the way the middle fingertip moves when the fingers curl. Cached per bone. */
const palmCache = new WeakMap<THREE.Bone, THREE.Vector3>();
function palmOf(bones: Record<string, THREE.Bone>, side: 'r' | 'l', bind?: Map<THREE.Bone, THREE.Quaternion>): THREE.Vector3 {
  const hand = bones[`hand_${side}`];
  const c = palmCache.get(hand); if (c) return c;
  const segs = [1, 2, 3].map((j) => bones[`middle_0${j}_${side}`]).filter(Boolean), tip = bones[`middle_04_leaf_${side}`] ?? segs[segs.length - 1];
  const saved = segs.map((b) => b.quaternion.clone());
  segs.forEach((b) => b.quaternion.copy(bind?.get(b) ?? b.quaternion)); hand.updateMatrixWorld(true);
  const p0 = hand.worldToLocal(tip.getWorldPosition(new THREE.Vector3()));
  segs.forEach((b, i) => b.quaternion.multiply(curlQ(CURL[side][i]))); hand.updateMatrixWorld(true);
  const p1 = hand.worldToLocal(tip.getWorldPosition(new THREE.Vector3()));
  segs.forEach((b, i) => b.quaternion.copy(saved[i])); hand.updateMatrixWorld(true);
  const d = p1.sub(p0); d.y = 0;
  const palm = d.lengthSq() > 1e-8 ? d.normalize() : new THREE.Vector3(side === 'r' ? -1 : 1, 0, 0);
  palmCache.set(hand, palm);
  return palm;
}

/** Orient the hand on the grip (with forearm twist) and curl the fingers round it. */
export function wrapHand(bones: Record<string, THREE.Bone>, wq: THREE.Quaternion, side: 'r' | 'l', bind?: Map<THREE.Bone, THREE.Quaternion>) {
  const hand = bones[`hand_${side}`]; if (!hand) return;
  const t = handTarget(wq, side), pl = palmOf(bones, side, bind);
  // Rotation taking hand-local (Y, palm, Y×palm) to world (y, palm, y×palm).
  const L = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 1, 0), pl, new THREE.Vector3(0, 1, 0).cross(pl));
  const Wm = new THREE.Matrix4().makeBasis(t.y, t.palm, t.y.clone().cross(t.palm));
  const world = new THREE.Quaternion().setFromRotationMatrix(Wm.multiply(L.transpose()));
  // Forearm twist: rotate the lower arm about its own axis so most of the roll happens along the forearm, not the wrist.
  const fore = hand.parent as THREE.Bone | null;
  if (fore && fore.isBone) {
    const fq = fore.getWorldQuaternion(new THREE.Quaternion());
    const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(fq).normalize();
    const proj = (v: THREE.Vector3) => v.clone().sub(axis.clone().multiplyScalar(v.dot(axis))).normalize();
    const cur = proj(pl.clone().applyQuaternion(fq)), want = proj(t.palm);
    let ang = Math.acos(THREE.MathUtils.clamp(cur.dot(want), -1, 1));
    if (cur.clone().cross(want).dot(axis) < 0) ang = -ang;
    const fp = fore.parent ? fore.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
    fore.quaternion.copy(fp.invert().multiply(new THREE.Quaternion().setFromAxisAngle(axis, ang * 0.75).multiply(fq)));
    fore.updateMatrixWorld(true);
  }
  const parentQ = hand.parent ? hand.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
  hand.quaternion.copy(parentQ.invert().multiply(world));
  for (const f of FINGERS) for (let j = 1; j <= 3; j++) {
    const b = bones[`${f}_0${j}_${side}`]; if (!b) continue;
    b.quaternion.copy(bind?.get(b) ?? b.quaternion).multiply(curlQ(CURL[side][j - 1] * (f === 'index' && side === 'r' ? 0.55 : 1)));
  }
  for (const j of [2, 3]) { const b = bones[`thumb_0${j}_${side}`]; if (b) b.quaternion.copy(bind?.get(b) ?? b.quaternion).multiply(curlQ(0.35)); }
  hand.updateMatrixWorld(true);
}

/**
 * Two-bone IK with shoulder protraction: if the target is beyond the arm's reach, the clavicle first swings the
 * shoulder towards it (up to `maxShift` m, as a real shoulder rolls forward on a rifle), then the arm solves.
 */
export function armIK(B: Record<string, THREE.Bone>, side: 'l' | 'r', target: THREE.Vector3, pole: THREE.Vector3, maxShift = 0.13) {
  const cl = B[`clavicle_${side}`], ua = B[`upperarm_${side}`], la = B[`lowerarm_${side}`], hd = B[`hand_${side}`];
  if (!ua || !la || !hd) return;
  if (cl) {
    const sh = ua.getWorldPosition(new THREE.Vector3()), elb = la.getWorldPosition(new THREE.Vector3()), wr = hd.getWorldPosition(new THREE.Vector3());
    const reach = (sh.distanceTo(elb) + elb.distanceTo(wr)) * 0.97, d = sh.distanceTo(target);
    if (d > reach) {
      const cp = cl.getWorldPosition(new THREE.Vector3()), shift = Math.min(maxShift, d - reach);
      const want = sh.clone().add(target.clone().sub(sh).normalize().multiplyScalar(shift));
      aimBone(cl, sh.clone().sub(cp).normalize(), want.sub(cp).normalize());
    }
  }
  twoBoneIK(ua, la, hd, target, pole);
}

const CLIP_SPEED: Record<string, number> = { Walk_Loop: 1.45, Jog_Fwd_Loop: 3.4, Sprint_Loop: 5.8, Crouch_Fwd_Loop: 1.3, Prone_Crawl_Loop: 0.6, Walk_Bwd_Loop: 1.3, Strafe_L_Loop: 1.4, Strafe_R_Loop: 1.4 };

export class Rig {
  root = new THREE.Group();
  private mixer: THREE.AnimationMixer | null = null;
  private actions = new Map<string, THREE.AnimationAction>();
  private current = '';
  private bones: Record<string, THREE.Bone> = {};
  weapon: THREE.Object3D | null = null;
  private weaponId = '';
  private mannequin: THREE.Group | null = null;
  private acc = 0;
  private deathClip = '';
  aimPitch = 0;
  muzzle = new THREE.Vector3();
  visible = true;
  private shadow = true;
  private kAim = 0; private kPort = 0; private lastDt = 0.016;
  private bind = new Map<THREE.Bone, THREE.Quaternion>();
  private lift = 0;

  constructor(private A: CharAssets, modelId: string, private teamColor: number) {
    const src = A.models.get(modelId);
    if (src) {
      const m = SkeletonUtils.clone(src);
      m.traverse((o) => {
        const b = o as THREE.Bone; if (b.isBone) { this.bones[b.name] = b; this.bind.set(b, b.quaternion.clone()); }
        const sk = o as THREE.SkinnedMesh; if (sk.isMesh) { sk.castShadow = true; sk.receiveShadow = true; sk.frustumCulled = true; sk.geometry.boundingSphere = BODY_SPHERE; }
      });
      this.root.add(m);
      this.mixer = new THREE.AnimationMixer(m);
      for (const [name, clip] of A.clips) this.actions.set(name, this.mixer.clipAction(clip));
    } else this.root.add(this.mannequin = this.buildMannequin());
  }

  private buildMannequin(): THREE.Group {
    const g = new THREE.Group(), m = new THREE.MeshStandardMaterial({ color: this.teamColor, roughness: 0.85 }), skin = new THREE.MeshStandardMaterial({ color: 0x9a7a5e, roughness: 0.7 });
    const part = (name: string, geo: THREE.BufferGeometry, mat: THREE.Material, y: number) => { const o = new THREE.Mesh(geo, mat); o.name = name; o.position.y = y; o.castShadow = true; g.add(o); return o; };
    part('torso', new THREE.CapsuleGeometry(0.19, 0.42, 4, 10), m, 1.2);
    part('head', new THREE.SphereGeometry(0.115, 12, 10), skin, 1.66);
    part('legL', new THREE.CapsuleGeometry(0.09, 0.72, 4, 8), m, 0.48).position.x = -0.11;
    part('legR', new THREE.CapsuleGeometry(0.09, 0.72, 4, 8), m, 0.48).position.x = 0.11;
    return g;
  }

  setWeapon(id: string) {
    if (id === this.weaponId) return;
    this.weaponId = id;
    if (this.weapon) this.root.parent?.remove(this.weapon);
    const src = this.A.tpWeapons.get(id) ?? this.A.weapons.get(id);
    this.weapon = src ? src.clone() : null;
    if (this.weapon) { this.weapon.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; }); this.root.parent?.add(this.weapon); }
  }

  private play(name: string, fade = 0.25, speed = 1) {
    const a = this.actions.get(name) ?? this.actions.get('Idle_Loop');
    if (!a) return;
    a.timeScale = speed;
    if (this.current === name) return;
    const prev = this.actions.get(this.current);
    a.reset().setEffectiveWeight(1).fadeIn(fade).play();
    if (name.startsWith('Death') || name === 'Stand_To_Prone') { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
    prev?.fadeOut(fade);
    this.current = name;
  }

  update(dt: number, s: Soldier, camDist: number, now = 0) {
    // Update rate by distance (full rate within 40 m).
    this.acc += dt;
    const interval = camDist < 40 ? 0 : camDist < 120 ? 1 / 20 : 1 / 8;
    if (this.acc < interval) return;
    const step = this.acc; this.acc = 0; this.lastDt = step;
    this.root.position.set(s.pos[0], s.pos[1] + this.lift, s.pos[2]);
    this.root.rotation.set(0, s.yaw, 0);
    this.aimPitch += (s.pitch - this.aimPitch) * damp(12, step);
    if (this.mixer) this.animate(step, s, camDist); else this.poseMannequin(s);
    this.placeWeapon(s, camDist, now);
  }

  private animate(dt: number, s: Soldier, camDist: number) {
    // Local velocity (forward = −z in body space).
    const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw), fwd = s.vel[0] * fx + s.vel[2] * fz, side = s.vel[0] * -fz + s.vel[2] * fx;
    const sp = Math.hypot(s.vel[0], s.vel[2]);
    let clip = 'Idle_Loop';
    if (s.state === 'dead') clip = this.deathClip ||= ['Death01', 'Death02', 'Death03'][s.id % 3];
    else if (s.state === 'wounded') clip = s.downT < 1.3 && this.actions.has('Death02') ? 'Death02' : 'Wounded_Loop';
    else if (s.stance === 'prone') clip = sp > 0.15 ? 'Prone_Crawl_Loop' : 'Prone_Idle_Loop';
    else if (s.stance === 'crouch') clip = sp > 0.3 ? (fwd < -0.3 && this.actions.has('Crouch_Bwd_Loop') ? 'Crouch_Bwd_Loop' : 'Crouch_Fwd_Loop') : 'Crouch_Idle_Loop';
    else if (sp > 0.3) {
      if (s.sprinting) clip = 'Sprint_Loop';
      else if (fwd < -0.4 && this.actions.has('Walk_Bwd_Loop')) clip = 'Walk_Bwd_Loop';
      else if (Math.abs(side) > Math.abs(fwd) && this.actions.has('Strafe_L_Loop')) clip = side > 0 ? 'Strafe_R_Loop' : 'Strafe_L_Loop';
      else clip = sp > 2.4 ? 'Jog_Fwd_Loop' : 'Walk_Loop';
    }
    if (!this.actions.has(clip)) clip = s.state !== 'alive' ? 'Death01' : 'Idle_Loop';
    const cs = CLIP_SPEED[clip];
    this.play(clip, 0.22, cs ? Math.max(0.4, Math.min(2, sp / cs)) : 1);
    this.mixer!.update(dt);
    this.ground(s, dt);
    if (s.state !== 'alive' || camDist > 160) return;
    // Upper body: pitch the spine to the aim, then IK the hands onto the weapon.
    const sp1 = this.bones.spine_01, sp2 = this.bones.spine_02, sp3 = this.bones.spine_03;
    if (sp1 && sp2 && sp3 && s.stance !== 'prone') {
      const share = (-this.aimPitch / 3) * this.kAim;
      for (const b of [sp1, sp2, sp3]) b.rotateX(share);
    }
    this.root.updateMatrixWorld(true);
  }

  /**
   * Lying poses (prone, wounded, dead) come from clips authored for one outfit; settle the body so its lowest bones
   * rest just above the ground instead of floating or sinking.
   */
  private ground(s: Soldier, dt: number) {
    const lying = s.stance === 'prone' || s.state !== 'alive';
    let want = 0;
    if (lying) {
      this.root.updateMatrixWorld(true);
      let minY = Infinity;
      for (const n of GROUND_BONES) { const b = this.bones[n]; if (b) minY = Math.min(minY, b.getWorldPosition(_v1).y); }
      if (minY < Infinity) want = this.lift - (minY - (s.pos[1] + 0.09));
    }
    this.lift += (want - this.lift) * Math.min(1, dt * 8);
    this.root.position.y = s.pos[1] + this.lift;
    this.root.updateMatrixWorld(true);
  }

  /** A short flinch when hit but still standing. */
  hit(part: string) {
    if (!this.mixer) return;
    const a = this.actions.get(part === 'head' ? 'Hit_Head' : 'Hit_Chest'); if (!a) return;
    a.reset(); a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = false; a.setEffectiveWeight(0.85); a.fadeIn(0.04).play();
    setTimeout(() => a.fadeOut(0.15), Math.max(120, a.getClip().duration * 1000 - 150));
  }

  private poseMannequin(s: Soldier) {
    const g = this.mannequin!, torso = g.getObjectByName('torso')!, head = g.getObjectByName('head')!, lL = g.getObjectByName('legL')!, lR = g.getObjectByName('legR')!;
    const down = s.state !== 'alive' || s.stance === 'prone';
    g.rotation.set(down ? -Math.PI / 2 : 0, 0, 0); g.position.set(0, down ? 0.2 : 0, down ? 0.75 : 0);
    const k = s.stance === 'crouch' && !down ? 0.7 : 1;
    torso.position.y = 1.2 * k; head.position.y = 1.66 * k; lL.scale.y = lR.scale.y = k; lL.position.y = lR.position.y = 0.48 * k;
    this.root.updateMatrixWorld(true);
  }

  /**
   * Weapon carry, blended between three poses so it never snaps:
   *  aim — shouldered on the sight line (aiming, or fired in the last 2 s);
   *  low — low ready, muzzle ~30° down (moving or standing, not engaged);
   *  port — port arms across the chest, muzzle up-left (sprinting).
   * Anchored to the chest bone so it follows the animation's lean and bob. Hands are IK'd to the grips and wrapped.
   */
  private placeWeapon(s: Soldier, camDist: number, now: number) {
    const w = this.weapon; if (!w) return;
    w.visible = this.visible && s.state === 'alive';
    if (!w.visible) return;
    const shadow = camDist < 40;
    if (shadow !== this.shadow) { this.shadow = shadow; w.traverse((o) => { o.castShadow = shadow; }); this.root.traverse((o) => { o.castShadow = shadow; }); }
    const engaged = s.ads > 0.25 || now - s.lastShotT < 2 || s.stance === 'prone';
    const tAim = engaged ? 1 : 0, tPort = !engaged && s.sprinting ? 1 : 0;
    const k = Math.min(1, this.lastDt * 6);
    this.kAim += (tAim - this.kAim) * k; this.kPort += (tPort - this.kPort) * k;
    const yawQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, s.yaw, 0));
    const chest = this.bones.spine_03 ? this.bones.spine_03.getWorldPosition(new THREE.Vector3()) : this.root.position.clone().add(new THREE.Vector3(0, s.eyeH - 0.32, 0));
    // Aimed: butt in the right shoulder pocket, weapon on the aim pitch.
    const qAim = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.aimPitch, s.yaw, 0, 'YXZ'));
    // Cheek weld: the weapon's `cheek` point (or its rear sight plus a typical eye relief) goes to the soldier's eye.
    const headB = this.bones.Head;
    const eyeW = headB ? headB.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.07, -0.09).applyQuaternion(qAim)) : chest.clone().add(new THREE.Vector3(0, 0.42, -0.05));
    const cheekL = w.getObjectByName('cheek')?.position.clone() ?? (w.getObjectByName('eye')?.position.clone() ?? new THREE.Vector3(0, 0.12, 0)).add(new THREE.Vector3(0, 0, 0.16));
    // A shouldered rifle sits slightly right of the eye (cheek on the stock's left side).
    const pAim = eyeW.clone().add(new THREE.Vector3(0.025, 0, 0).applyQuaternion(yawQ)).sub(cheekL.applyQuaternion(qAim));
    // Low ready: grip at the right hip/chest, muzzle down and slightly inboard.
    const qLow = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.55 + this.aimPitch * 0.3, s.yaw - 0.28, -0.1, 'YXZ'));
    const pLow = chest.clone().add(new THREE.Vector3(0.2, -0.16, -0.2).applyQuaternion(yawQ));
    // Port arms: across the chest, muzzle up and to the left.
    const qPort = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.65, s.yaw + 0.95, 0.35, 'YXZ'));
    const pPort = chest.clone().add(new THREE.Vector3(0.14, -0.2, -0.24).applyQuaternion(yawQ));
    const q = qLow.clone().slerp(qPort, this.kPort).slerp(qAim, this.kAim);
    const pos = pLow.clone().lerp(pPort, this.kPort).lerp(pAim, this.kAim);
    w.quaternion.copy(q); w.position.copy(pos);
    w.updateMatrixWorld(true);
    w.getObjectByName('muzzle')?.getWorldPosition(this.muzzle);
    // Hands on the grips, elbows down/out, fingers wrapped.
    if (!this.mixer || camDist > 70) return;
    const b = this.bones, gr = w.getObjectByName('grip_r'), gl = w.getObjectByName('grip_l');
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(yawQ);
    if (b.upperarm_r && b.lowerarm_r && b.hand_r && gr) {
      armIK(b, 'r', wristTarget(gr.getWorldPosition(new THREE.Vector3()), q, 'r'), b.upperarm_r.getWorldPosition(new THREE.Vector3()).addScaledVector(right, 0.35).add(new THREE.Vector3(0, -0.55, 0)), 0.06);
      wrapHand(b, q, 'r', this.bind);
    }
    if (b.upperarm_l && b.lowerarm_l && b.hand_l && gl) {
      armIK(b, 'l', wristTarget(gl.getWorldPosition(new THREE.Vector3()), q, 'l'), b.upperarm_l.getWorldPosition(new THREE.Vector3()).addScaledVector(right, -0.25).add(new THREE.Vector3(0, -0.6, 0)));
      wrapHand(b, q, 'l', this.bind);
    }
  }

  /** World position of the chest (for blood pools). */
  chest(): [number, number, number] | null { const b = this.bones.spine_02; if (!b) return null; const v = b.getWorldPosition(new THREE.Vector3()); return [v.x, v.y, v.z]; }

  /** Leave the weapon lying on the ground next to the body. */
  dropWeapon(s: Soldier) {
    const w = this.weapon; if (!w) return;
    const rx = Math.cos(s.yaw), rz = -Math.sin(s.yaw);
    w.position.set(s.pos[0] + rx * 0.55, s.pos[1] + 0.04, s.pos[2] + rz * 0.55);
    w.quaternion.setFromEuler(new THREE.Euler(0, s.yaw + 0.6 + (s.id % 5) * 0.3, Math.PI / 2, 'YXZ'));
    w.visible = true; w.updateMatrixWorld(true);
  }

  dispose() { this.root.parent?.remove(this.root); if (this.weapon) this.weapon.parent?.remove(this.weapon); }
}

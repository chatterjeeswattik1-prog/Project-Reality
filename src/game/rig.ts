// Third-person body for a soldier: skinned Quaternius character + shared animation library (locomotion by stance and
// velocity), spine pitched to the aim and two-bone IK putting the hands on the weapon's grip points. Falls back to a
// posed mannequin when the character files are missing. Distant bodies update at a lower rate.
import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { Soldier } from './soldier';
import { damp } from '../core/rng';
import { choreo, hand as handTrack, num, step, vec, PISTOL_GRIP_L, PISTOL_RELIEF, type HandAt, type V3 } from '../player/handling';
import { Ragdoll } from './ragdoll';
import type { Physics } from '../world/physics';

export interface CharAssets {
  models: Map<string, THREE.Object3D>; clips: Map<string, THREE.AnimationClip>; weapons: Map<string, THREE.Object3D>; tpWeapons: Map<string, THREE.Object3D>;
  /** First-person rigs by pack id (player/fprig.ts). */ fpRigs: Map<string, { scene: THREE.Object3D; animations: THREE.AnimationClip[] }>;
}

const _r3: V3 = [0, 0, 0];
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

/** Rotate `bone` about a world-space axis (its children follow). */
function rotateWorld(bone: THREE.Object3D, axis: THREE.Vector3, ang: number) {
  bone.updateWorldMatrix(true, false);
  const w = bone.getWorldQuaternion(new THREE.Quaternion()).premultiply(new THREE.Quaternion().setFromAxisAngle(axis, ang));
  const pq = bone.parent ? bone.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
  bone.quaternion.copy(pq.invert().multiply(w));
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
/** How a hand holds the weapon: on a long gun, or the support hand of a two-handed pistol grip (wrapped round the
 *  firing hand: heel of the palm filling the gap on the grip's left, fingers over the firing hand's fingers under the
 *  trigger guard, palm facing in to the right). */
export type GripStyle = 'rifle' | 'pistol';
function handTarget(wq: THREE.Quaternion, side: 'r' | 'l', style: GripStyle = 'rifle') {
  const pl = side === 'l' && style === 'pistol';
  const y = (side === 'r' ? new THREE.Vector3(0, -0.55, -1) : pl ? new THREE.Vector3(0.35, -0.7, -0.65) : new THREE.Vector3(1, 0.1, -0.3)).applyQuaternion(wq).normalize();
  const palm = (side === 'r' ? new THREE.Vector3(-1, 0, 0) : pl ? new THREE.Vector3(1, 0, 0.1) : new THREE.Vector3(0, 1, 0)).applyQuaternion(wq);
  palm.sub(y.clone().multiplyScalar(palm.dot(y))).normalize();
  return { y, palm };
}

/** Where the wrist (hand bone) must be so the palm closes on `grip`. */
export function wristTarget(grip: THREE.Vector3, wq: THREE.Quaternion, side: 'r' | 'l', style: GripStyle = 'rifle'): THREE.Vector3 {
  const a = handTarget(wq, side, style);
  return grip.clone().addScaledVector(a.y, -0.075).addScaledVector(a.palm, -0.035);
}

/**
 * Bullet wound on clothing/skin: a dark hole in a wet, irregular blood stain soaking outwards (alpha), a few runs below.
 * Exit wounds use the same texture larger.
 */
let woundMat: THREE.MeshPhongMaterial | null = null;
function woundMaterial(): THREE.MeshPhongMaterial {
  if (woundMat) return woundMat;
  const S = 128, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d')!;
  let seed = 9; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // Soaked stain: many overlapping soft blobs, darker in the middle.
  for (let i = 0; i < 26; i++) {
    const a = rnd() * Math.PI * 2, r = rnd() * S * 0.2, x = S / 2 + Math.cos(a) * r, y = S / 2 + Math.sin(a) * r * 0.8 + r * 0.25, rr = S * (0.07 + rnd() * 0.1);
    const gr = g.createRadialGradient(x, y, 0, x, y, rr);
    gr.addColorStop(0, 'rgba(105,8,5,0.8)'); gr.addColorStop(0.7, 'rgba(115,10,6,0.55)'); gr.addColorStop(1, 'rgba(115,10,6,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, rr, 0, Math.PI * 2); g.fill();
  }
  // Runs down from the wound.
  g.strokeStyle = 'rgba(95,6,4,0.85)'; g.lineCap = 'round';
  for (let i = 0; i < 4; i++) { const x = S / 2 + (rnd() - 0.5) * S * 0.25; g.lineWidth = 2 + rnd() * 3; g.beginPath(); g.moveTo(x, S / 2); g.lineTo(x + (rnd() - 0.5) * 6, S / 2 + S * (0.2 + rnd() * 0.25)); g.stroke(); }
  // Wet dark centre and the hole.
  let gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S * 0.16);
  gr.addColorStop(0, 'rgba(55,3,2,0.98)'); gr.addColorStop(1, 'rgba(85,5,3,0)');
  g.fillStyle = gr; g.beginPath(); g.arc(S / 2, S / 2, S * 0.16, 0, Math.PI * 2); g.fill();
  gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S * 0.05);
  gr.addColorStop(0, 'rgba(8,0,0,1)'); gr.addColorStop(0.6, 'rgba(25,1,1,1)'); gr.addColorStop(1, 'rgba(70,5,3,0.9)');
  g.fillStyle = gr; g.beginPath(); g.arc(S / 2, S / 2, S * 0.05, 0, Math.PI * 2); g.fill();
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  // Wet: blood soaking cloth is glossy where it is fresh (sun highlight only: a sky reflection on dark red reads purple).
  woundMat = new THREE.MeshPhongMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, specular: 0x2a1614, shininess: 60 });
  return woundMat;
}
const woundGeo = new THREE.PlaneGeometry(1, 1);
/** Bones a wound can sit on (nearest to the hit point wins). */
const WOUND_BONES = ['Head', 'neck_01', 'spine_03', 'spine_02', 'spine_01', 'pelvis', 'upperarm_l', 'upperarm_r', 'lowerarm_l', 'lowerarm_r', 'thigh_l', 'thigh_r', 'calf_l', 'calf_r'];
const _ray = new THREE.Raycaster();

/**
 * Distant soldiers read as dark figures, as people do in the field (and in Project Reality): at a few pixels the shaded
 * half of the body and its folds are no longer resolved, and the eye sees their average — a silhouette darker than the
 * sunlit ground. The shader darkens a soldier (and his weapon) progressively from ~40 m to ~55 % at 260 m, and the haze
 * acts on him at under half the scene's density, so distant enemies keep their contrast instead of melting into sand.
 */
const farPatched = new WeakSet<THREE.Material>();
export function farFigure(o: THREE.Object3D) {
  o.traverse((m) => {
    const mats = (m as THREE.Mesh).isMesh ? ([] as THREE.Material[]).concat((m as THREE.Mesh).material) : [];
    for (const mat of mats) {
      if (farPatched.has(mat) || !(mat as THREE.MeshStandardMaterial).isMeshStandardMaterial) continue;
      farPatched.add(mat);
      mat.onBeforeCompile = (sh) => {
        sh.fragmentShader = sh.fragmentShader.replace('#include <fog_fragment>', `
          gl_FragColor.rgb *= mix(1.0, 0.35, smoothstep(30.0, 220.0, length(vViewPosition)));
          #ifdef USE_FOG
            #ifdef FOG_EXP2
              float fogFactor = 1.0 - exp(- fogDensity * fogDensity * 0.18 * vFogDepth * vFogDepth);
            #else
              float fogFactor = smoothstep(fogNear, fogFar, vFogDepth) * 0.5;
            #endif
            gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor);
          #endif`);
      };
      mat.customProgramCacheKey = () => 'farFigure';
      mat.needsUpdate = true;
    }
  });
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
export function wrapHand(bones: Record<string, THREE.Bone>, wq: THREE.Quaternion, side: 'r' | 'l', bind?: Map<THREE.Bone, THREE.Quaternion>, style: GripStyle = 'rifle') {
  const hand = bones[`hand_${side}`]; if (!hand) return;
  const t = handTarget(wq, side, style), pl = palmOf(bones, side, bind);
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

const _cq = new THREE.Quaternion(), _cq2 = new THREE.Quaternion(), _cx = new THREE.Vector3(1, 0, 0);
/** Share of the running clip's leg swing taken out (shorter stride, quicker cadence). */
const STRIDE_CUT = 0.3;
/** Ground speed of the motion-captured run (set when it is retargeted at load). */
export const RUN_SPEED = { mocap: 0 };
const CLIP_SPEED: Record<string, number> = { Walk_Loop: 1.45, Jog_Fwd_Loop: 3.4, Sprint_Loop: 5.8, Crouch_Fwd_Loop: 1.3, Prone_Crawl_Loop: 0.6, Walk_Bwd_Loop: 1.3, Strafe_L_Loop: 1.4, Strafe_R_Loop: 1.4 };

export class Rig {
  root = new THREE.Group();
  private mixer: THREE.AnimationMixer | null = null;
  private actions = new Map<string, THREE.AnimationAction>();
  private current = '';
  private bones: Record<string, THREE.Bone> = {};
  weapon: THREE.Object3D | null = null;
  private weaponId = '';
  /** Weapon magazine part, its seat and withdrawal direction (pistol reloads move it). */
  private mag: THREE.Object3D | null = null; private magHome = new THREE.Vector3(); private magDir = new THREE.Vector3(0, -1, 0);
  private mannequin: THREE.Group | null = null;

  private deathClip = '';
  aimPitch = 0;
  muzzle = new THREE.Vector3();
  visible = true;
  private shadow = true;
  private kAim = 0; private kPort = 0; private lastDt = 0.016;
  private bind = new Map<THREE.Bone, THREE.Quaternion>();
  private bindPos = new Map<THREE.Bone, THREE.Vector3>();
  private lift = 0;
  /** Hit stagger: spine bend (pitch back, roll sideways, twist) as a damped spring, kicked by each hit. */
  private stag = new THREE.Vector3(); private stagV = new THREE.Vector3();
  /** Speed-up of the fall clip right after a hit (the body drops hard, then the clip eases out). */
  private fallBoost = 0;
  /** Physics world for the ragdoll (set by the game; without it bodies fall with the death clips). */
  P: Physics | null = null;
  /** Ragdoll simulating the body (null once it has settled); `ragged` while the pose belongs to it. */
  rag: Ragdoll | null = null; ragged = false;
  private gunLoose = false;
  private wounds: { m: THREE.Mesh; t: number; size: number }[] = [];
  private meshes: THREE.SkinnedMesh[] = [];

  constructor(private A: CharAssets, modelId: string, private teamColor: number) {
    const src = A.models.get(modelId);
    if (src) {
      const m = SkeletonUtils.clone(src);
      m.traverse((o) => {
        const b = o as THREE.Bone; if (b.isBone) { this.bones[b.name] = b; this.bind.set(b, b.quaternion.clone()); this.bindPos.set(b, b.position.clone()); }
        const sk = o as THREE.SkinnedMesh; if (sk.isMesh) { sk.castShadow = true; sk.receiveShadow = true; sk.frustumCulled = true; sk.geometry.boundingSphere = BODY_SPHERE; if (sk.isSkinnedMesh) this.meshes.push(sk); }
      });
      this.root.add(m);
      farFigure(m);
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
    if (this.weapon) { this.weapon.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; }); farFigure(this.weapon); this.root.parent?.add(this.weapon); }
    this.mag = this.weapon?.getObjectByName('mag') ?? null;
    if (this.mag) {
      this.magHome.copy(this.mag.position);
      const md = this.weapon!.getObjectByName('mag_dir');
      this.magDir.copy(md ? md.position.clone().sub(this.magHome) : new THREE.Vector3(0, -1, 0.08)).normalize();
    }
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
    // Every soldier is animated every frame: reduced update rates at range made runners stutter visibly.
    const step = dt; this.lastDt = step;
    this.growWounds(dt);
    // Down: the body is a ragdoll (started here if nothing has shoved it yet, e.g. bleeding out). Revived: back to clips.
    if (s.state !== 'alive' && !this.ragged && this.mixer && this.P) this.startRag(s);
    if (this.ragged) {
      if (s.state === 'alive') this.unrag();
      else { this.updateRag(dt, s); return; }
    }
    this.root.position.set(s.pos[0], s.pos[1] + this.lift, s.pos[2]);
    this.root.rotation.set(0, s.yaw, 0);
    // A prone body cannot lift the rifle above ~25-30°, whatever the soldier is looking at.
    this.aimPitch += ((s.stance === 'prone' ? Math.min(0.5, s.pitch) : s.pitch) - this.aimPitch) * damp(12, step);
    if (this.mixer) this.animate(step, s, camDist); else this.poseMannequin(s);
    this.placeWeapon(s, camDist, now);
  }

  /**
   * The animation library's locomotion is civilian (shoulders and torso swing as if the hands were free). Pull the spine,
   * neck, head and shoulders most of the way back to a steady carry posture, leaning into the movement: the legs work,
   * the upper body stays quiet behind the rifle — as soldiers move in the Project Reality footage.
   */
  private soldierCarry(sp: number, crouch: boolean) {
    const run = THREE.MathUtils.clamp((sp - 2) / 3, 0, 1);
    const k = Math.min(1, sp / 1.2) * (crouch ? 0.8 : 0.55 + run * 0.3);
    if (k <= 0.01) return;
    // Running, the body leans into the run from the hips (~15° at a sprint), head up looking ahead.
    const lean = (crouch ? 0.32 : 0.04) + run * 0.26;
    const B = this.bones;
    for (const [n, w, l] of [['spine_01', 1, 0.35], ['spine_02', 1, 0.35], ['spine_03', 1, 0.3], ['neck_01', 0.8, -0.4], ['Head', 0.8, -0.5], ['clavicle_l', 0.7, 0], ['clavicle_r', 0.7, 0]] as const) {
      const b = B[n], q0 = b && this.bind.get(b); if (!b || !q0) continue;
      _cq.copy(q0); if (l) _cq.multiply(_cq2.setFromAxisAngle(_cx, lean * l));
      b.quaternion.slerp(_cq, k * w);
    }
  }

  /**
   * Shorten the running stride: pull the hips, knees and ankles part of the way back to the standing pose, so the
   * legs swing less far (no bounding leaps with the rear heel kicked up) and keep the pelvis' bounce down.
   */
  private gait(cut: number) {
    const B = this.bones;
    for (const [n, w] of [['thigh_l', 1], ['thigh_r', 1], ['calf_l', 1.25], ['calf_r', 1.25], ['foot_l', 0.6], ['foot_r', 0.6]] as const) {
      const b = B[n], q0 = b && this.bind.get(b); if (b && q0) b.quaternion.slerp(q0, cut * w);
    }
    const pv = B.pelvis, p0 = pv && this.bindPos.get(pv);
    if (pv && p0) pv.position.y += (p0.y - pv.position.y) * 0.5;
  }

  private animate(dt: number, s: Soldier, camDist: number) {
    // Local velocity (forward = −z in body space).
    const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw), fwd = s.vel[0] * fx + s.vel[2] * fz, side = s.vel[0] * -fz + s.vel[2] * fx;
    const sp = Math.hypot(s.vel[0], s.vel[2]);
    let clip = 'Idle_Loop';
    if (s.state === 'dead') clip = this.deathClip ||= ['Death01', 'Death02', 'Death03'][s.id % 3];
    else if (s.state === 'wounded') clip = s.downT < 1.3 && this.actions.has('Death02') ? 'Death02' : 'Wounded_Loop';
    else if (s.stance === 'prone') clip = sp > 0.15 ? 'Prone_Crawl_Loop' : 'Prone_Idle_Loop';
    // Crouched: creeping uses the crouch walk; moving faster, the library's squat-walk looks like a duck walk, so a
    // walk (or jog) with the torso bent low over the rifle is used instead (soldierCarry adds the bend).
    else if (s.stance === 'crouch') clip = sp > 0.65 ? (sp > 2.4 ? 'Jog_Fwd_Loop' : 'Walk_Loop') : sp > 0.2 ? (fwd < -0.3 && this.actions.has('Crouch_Bwd_Loop') ? 'Crouch_Bwd_Loop' : 'Crouch_Fwd_Loop') : 'Crouch_Idle_Loop';
    else if (sp > 0.3) {
      // The library's sprint is a hunched cartoon dash: soldiers run with the jog, played faster (see CLIP_SPEED).
      if (s.sprinting) clip = 'Jog_Fwd_Loop';
      else if (fwd < -0.4 && this.actions.has('Walk_Bwd_Loop')) clip = 'Walk_Bwd_Loop';
      else if (Math.abs(side) > Math.abs(fwd) && this.actions.has('Strafe_L_Loop')) clip = side > 0 ? 'Strafe_R_Loop' : 'Strafe_L_Loop';
      else clip = sp > 2.4 ? 'Jog_Fwd_Loop' : 'Walk_Loop';
    }
    if (!this.actions.has(clip)) clip = s.state !== 'alive' ? 'Death01' : 'Idle_Loop';
    // Running and sprinting use the motion-captured run when it is loaded (legs and hips; the arms stay on the weapon).
    if (clip === 'Jog_Fwd_Loop' && RUN_SPEED.mocap > 0 && this.actions.has('Run_Mocap') && (s.sprinting || sp > 2.6)) clip = 'Run_Mocap';
    const cs = clip === 'Run_Mocap' ? RUN_SPEED.mocap : CLIP_SPEED[clip], falling = s.state !== 'alive';
    // Running with a rifle and kit: shorter, quicker steps than the library's long-striding jog (see gait()); the clip
    // plays faster to keep the feet planted with the shorter stride.
    const short = s.state === 'alive' && clip === 'Jog_Fwd_Loop' ? STRIDE_CUT : 0;
    this.play(clip, falling ? 0.08 : 0.22, falling ? 1 + this.fallBoost : cs ? Math.max(0.4, Math.min(2.2, sp / (cs * (1 - short)))) : 1);
    this.fallBoost = Math.max(0, this.fallBoost - dt * 1.2);
    this.mixer!.update(dt);
    if (short) this.gait(short);
    if (s.state === 'alive' && s.stance !== 'prone') this.soldierCarry(sp, s.stance === 'crouch' && sp > 0.65);
    // Stagger spring (ω ≈ 14 rad/s, ζ ≈ 0.35), added to the spine on top of the clip.
    for (let i = 0, n = Math.max(1, Math.ceil(dt * 120)), h = dt / n; i < n; i++) { this.stagV.addScaledVector(this.stag, -196 * h).multiplyScalar(1 - 10 * h); this.stag.addScaledVector(this.stagV, h); }
    if (s.state === 'alive' && this.stag.lengthSq() > 1e-6) {
      for (const [bn, w] of [['spine_01', 0.25], ['spine_02', 0.35], ['spine_03', 0.4]] as const) { const b = this.bones[bn]; if (b) { b.rotateX(-this.stag.x * w); b.rotateZ(this.stag.z * w); b.rotateY(this.stag.y * w); } }
      const hd = this.bones.Head; if (hd) hd.rotateX(-this.stag.x * 0.3);
    }
    this.ground(s, dt);
    if (s.state !== 'alive' || camDist > 160) return;
    // Upper body: pitch the spine to the aim, then IK the hands onto the weapon.
    const sp1 = this.bones.spine_01, sp2 = this.bones.spine_02, sp3 = this.bones.spine_03;
    if (sp1 && sp2 && sp3 && s.stance !== 'prone') {
      const share = (-this.aimPitch / 3) * this.kAim;
      for (const b of [sp1, sp2, sp3]) b.rotateX(share);
      // Lean: roll the spine about the body's forward axis (the head goes out ~0.36 m at full lean).
      if (Math.abs(s.lean) > 0.01) { const f = new THREE.Vector3(-Math.sin(s.yaw), 0, -Math.cos(s.yaw)); for (const [b, w] of [[sp1, 0.3], [sp2, 0.35], [sp3, 0.35]] as const) rotateWorld(b, f, s.lean * 0.42 * w); }
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

  /**
   * Hit while still standing: the torso snaps away from the bullet (a spring on the spine bones, strongest for chest
   * hits from full-power rounds) on top of a short flinch clip.
   */
  hit(part: string, dir?: [number, number, number], power = 1) {
    if (dir) {
      // Bullet direction in body space (forward = −z): pitch back when hit from the front, roll when hit from the side.
      const c = Math.cos(this.root.rotation.y), sn = Math.sin(this.root.rotation.y);
      const lx = dir[0] * c - dir[2] * sn, lz = dir[0] * sn + dir[2] * c;
      const k = power * (part === 'head' ? 1.4 : part === 'leg' ? 0.5 : 1);
      this.stagV.x += lz * 9 * k; this.stagV.z += -lx * 8 * k; this.stagV.y += (Math.random() - 0.5) * 8 * k;
    }
    if (!this.mixer) return;
    const a = this.actions.get(part === 'head' ? 'Hit_Head' : 'Hit_Chest'); if (!a) return;
    a.reset(); a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = false; a.setEffectiveWeight(0.85); a.fadeIn(0.04).play();
    setTimeout(() => a.fadeOut(0.15), Math.max(120, a.getClip().duration * 1000 - 150));
  }

  /** Went down from a hit: the fall starts fast. */
  /** Going down: the death clip plays a little faster for a hard hit (a body drops; it does not slam flat). */
  fall(power = 1) { this.fallBoost = 0.1 + power * 0.18; }

  // ---------------- ragdoll ----------------
  private startRag(s: Soldier) {
    this.ragged = true;
    this.root.updateMatrixWorld(true);
    // The weapon goes with the body (as a loose box) unless it is hidden.
    this.gunLoose = !!(this.weapon && this.weapon.visible);
    this.rag = new Ragdoll(this.P!, this.bones, [s.vel[0], Math.max(-2, s.vel[1]), s.vel[2]], this.gunLoose ? this.weapon : null, this.right());
    this.mixer?.stopAllAction(); this.current = '';
  }
  /** Advance the ragdoll; keep the downed soldier's position and heading (hit boxes, medics) on the body. */
  updateRag(dt: number, s?: Soldier) {
    if (!this.rag) return;
    // While the body moves its skinned bounds are stale: no culling until it settles (refreshBounds).
    if (this.meshes[0]?.frustumCulled) for (const m of this.meshes) m.frustumCulled = false;
    if (!this.rag.sync(dt)) { this.rag = null; this.refreshBounds(); return; }
    const sp = s ? this.rag.spine() : null;
    if (s && sp) {
      const dx = sp.head[0] - sp.pelvis[0], dz = sp.head[2] - sp.pelvis[2], L = Math.hypot(dx, dz) || 1;
      s.pos[0] = sp.pelvis[0] + (dx / L) * 0.2; s.pos[2] = sp.pelvis[2] + (dz / L) * 0.2;
      s.yaw = Math.atan2(-dx, -dz);
    }
  }
  get ragActive() { return !!this.rag; }
  /** The body's right in the world (from the pelvis). */
  private right() { return new THREE.Vector3(1, 0, 0).applyQuaternion(this.root.quaternion); }
  /** Skinned bounds (culling, wound ray casts) from the current pose, with a margin for a moving body. */
  private refreshBounds() { for (const m of this.meshes) { m.computeBoundingSphere(); m.boundingSphere!.radius *= 1.4; m.frustumCulled = true; } }
  private unrag() {
    this.rag?.finish(); this.rag = null; this.ragged = false; this.gunLoose = false;
    for (const [b, q] of this.bind) { b.quaternion.copy(q); const p0 = this.bindPos.get(b); if (p0) b.position.copy(p0); }
    this.current = '';
  }
  /** Settled body coming alive again (shot or blasted): a new ragdoll from the pose it lies in. */
  private wake(s: Soldier | null): boolean {
    if (this.rag) return true;
    if (!this.mixer || !this.P) return false;
    if (this.ragged) { this.rag = new Ragdoll(this.P, this.bones, [0, 0, 0], null, this.right()); return true; }
    if (s) { this.startRag(s); return true; }
    return false;
  }
  /** A shove at a world point (N·s): someone going down, or a body hit again. */
  shove(s: Soldier, p: V3, imp: V3) { if (this.wake(s)) this.rag!.push(p, imp); }
  /** Blast wave (corpses and the downed are thrown). */
  blast(s: Soldier | null, c: V3, k: number) { if (this.wake(s)) this.rag!.blast(c, k); }

  // ---------------- wounds ----------------
  /**
   * A bullet wound where the round went in (and, for a through-and-through, where it came out): a decal on the body's
   * surface, carried by the nearest bone, whose stain soaks outwards over a few seconds.
   */
  wound(p: V3, dir: V3, exit: boolean) {
    if (!this.meshes.length) return;
    this.root.updateMatrixWorld(true);
    this.refreshBounds();
    const d = new THREE.Vector3(...dir).normalize();
    const o = new THREE.Vector3(...p).addScaledVector(d, exit ? 0.6 : -0.6);
    _ray.set(o, exit ? d.clone().negate() : d); _ray.far = 1.2;
    const hit = _ray.intersectObjects(this.meshes, false)[0];
    const at = hit ? hit.point : new THREE.Vector3(...p);
    // Facing the way the round came (entry) or went (exit).
    const n = exit ? d.clone() : d.clone().negate();
    let bone: THREE.Bone | null = null, bd = Infinity;
    for (const bn of WOUND_BONES) { const b = this.bones[bn]; if (!b) continue; const q = b.getWorldPosition(_v1).distanceToSquared(at); if (q < bd) { bd = q; bone = b; } }
    if (!bone || bd > 0.5 * 0.5) return;
    const m = new THREE.Mesh(woundGeo, woundMaterial());
    m.renderOrder = 3; m.castShadow = false;
    m.position.copy(at).addScaledVector(n, 0.012);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n).multiply(_q1.setFromAxisAngle(new THREE.Vector3(0, 0, 1), (Math.random() - 0.5) * 0.6));
    const size = (exit ? 0.3 : 0.2) * (0.85 + Math.random() * 0.3);
    m.scale.setScalar(size * 0.35);
    this.root.parent?.add(m); m.updateMatrixWorld(true);
    bone.attach(m);
    this.wounds.push({ m, t: 0, size });
    if (this.wounds.length > 10) { const w = this.wounds.shift()!; w.m.parent?.remove(w.m); }
  }
  private growWounds(dt: number) {
    for (const w of this.wounds) {
      if (w.t >= 6) continue;
      w.t += dt;
      const k = 0.35 + 0.65 * (1 - Math.exp(-w.t / 1.8));
      // attach() divided the decal's scale by the bone's world scale: grow relative to it.
      const ws = w.m.parent ? w.m.parent.getWorldScale(_v2).x : 1;
      w.m.scale.setScalar((w.size * k) / (ws || 1));
    }
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
    const pistol = s.weapon.kind === 'pistol';
    // Reloading: the same choreography as in first person (player/handling.ts), with the weapon brought in to the chest.
    const cho = s.reloadT > 0 && !s.underSel && s.stance !== 'prone' ? choreo(s.weapon, s.reloadEmpty) : null;
    const rp = cho ? Math.min(1, Math.max(0, 1 - s.reloadT / Math.max(0.1, s.reloadDur))) : 0;
    const tAim = cho ? (pistol ? 0.3 : 0.45) : engaged ? 1 : 0, tPort = !engaged && !cho && s.sprinting ? 1 : 0;
    const k = Math.min(1, this.lastDt * 6);
    this.kAim += (tAim - this.kAim) * k; this.kPort += (tPort - this.kPort) * k;
    const yawQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, s.yaw, 0));
    const chest = this.bones.spine_03 ? this.bones.spine_03.getWorldPosition(new THREE.Vector3()) : this.root.position.clone().add(new THREE.Vector3(0, s.eyeH - 0.32, 0));
    // Aimed: butt in the right shoulder pocket, weapon on the aim pitch.
    const qAim = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.aimPitch, s.yaw, 0, 'YXZ'));
    // Cheek weld: the weapon's `cheek` point (or its rear sight plus a typical eye relief) goes to the soldier's eye.
    const headB = this.bones.Head;
    const eyeW = headB ? headB.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.07, -0.09).applyQuaternion(qAim)) : chest.clone().add(new THREE.Vector3(0, 0.42, -0.05));
    // A pistol is aimed at arm's length (both arms out, the sights half a metre ahead of the eyes, centred).
    const eyeP = w.getObjectByName('eye')?.position.clone() ?? new THREE.Vector3(0, 0.12, 0);
    const cheekL = pistol ? eyeP.add(new THREE.Vector3(0, 0, PISTOL_RELIEF)) : w.getObjectByName('cheek')?.position.clone() ?? eyeP.add(new THREE.Vector3(0, 0, 0.16));
    // A shouldered rifle sits slightly right of the eye (cheek on the stock's left side).
    const pAim = eyeW.clone().add(new THREE.Vector3(pistol ? 0 : 0.025, 0, 0).applyQuaternion(yawQ)).sub(cheekL.applyQuaternion(qAim));
    // Low ready: grip at the right hip/chest, muzzle down and slightly inboard.
    // (Pistol: low ready in both hands in front of the belly, muzzle ~40° down.)
    const qLow = new THREE.Quaternion().setFromEuler(pistol ? new THREE.Euler(-0.7 + this.aimPitch * 0.3, s.yaw - 0.05, 0, 'YXZ') : new THREE.Euler(-0.55 + this.aimPitch * 0.3, s.yaw - 0.28, -0.1, 'YXZ'));
    const pLow = chest.clone().add((pistol ? new THREE.Vector3(0.06, -0.14, -0.3) : new THREE.Vector3(0.2, -0.16, -0.2)).applyQuaternion(yawQ));
    // Low port (running): diagonally across the chest, muzzle forward-down to the left, as soldiers run with a rifle;
    // a pistol is tucked in close, muzzle down.
    const qPort = new THREE.Quaternion().setFromEuler(pistol ? new THREE.Euler(-1.0, s.yaw, 0, 'YXZ') : new THREE.Euler(-0.5, s.yaw + 0.6, 0.35, 'YXZ'));
    const pPort = chest.clone().add((pistol ? new THREE.Vector3(0.05, -0.2, -0.2) : new THREE.Vector3(0.12, -0.2, -0.26)).applyQuaternion(yawQ));
    const q = qLow.clone().slerp(qPort, this.kPort).slerp(qAim, this.kAim);
    const pos = pLow.clone().lerp(pPort, this.kPort).lerp(pAim, this.kAim);
    if (cho) { const r = vec(cho.rot, rp, _r3); q.multiply(_q1.setFromEuler(new THREE.Euler(r[0] * 0.8, r[1], r[2], 'YXZ'))); }
    w.quaternion.copy(q); w.position.copy(pos);
    // Pistol reload: the magazine drops out of the grip and the new one goes in (as in first person).
    if (this.mag) {
      this.mag.position.copy(this.magHome); this.mag.visible = true;
      if (cho && pistol) {
        const m = vec(cho.magPos, rp, _r3);
        this.mag.position.add(new THREE.Vector3(m[0], m[1], m[2])).addScaledVector(this.magDir, num(cho.magSlide, rp));
        this.mag.visible = step(cho.magShow, rp) > 0.5;
      }
    }
    w.updateMatrixWorld(true);
    w.getObjectByName('muzzle')?.getWorldPosition(this.muzzle);
    // Hands on the grips, elbows down/out, fingers wrapped.
    if (!this.mixer || camDist > 300) return;
    const b = this.bones, gr = w.getObjectByName('grip_r'), gl = w.getObjectByName('grip_l');
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(yawQ);
    if (b.upperarm_r && b.lowerarm_r && b.hand_r && gr) {
      armIK(b, 'r', wristTarget(gr.getWorldPosition(new THREE.Vector3()), q, 'r'), b.upperarm_r.getWorldPosition(new THREE.Vector3()).addScaledVector(right, 0.35).add(new THREE.Vector3(0, -0.55, 0)), pistol ? 0.13 : 0.06);
      wrapHand(b, q, 'r', this.bind);
    }
    if (b.upperarm_l && b.lowerarm_l && b.hand_l && gl && gr && pistol) {
      // Pistol support hand: wrapped round the firing hand; in a reload it fetches the magazine and pushes it in from
      // below (palm up), and on an empty one racks the slide overhand (palm down).
      const gripL = () => w.localToWorld(gr.position.clone().add(new THREE.Vector3(...PISTOL_GRIP_L)));
      const at = (h: HandAt): THREE.Vector3 => {
        if (h === 'mag' && this.mag) return w.localToWorld(this.mag.position.clone().addScaledVector(this.magDir, 0.12));
        if (h === 'away') return chest.clone().add(new THREE.Vector3(-0.1, -0.3, -0.12).applyQuaternion(yawQ));
        if (h === 'charge') { const c = w.getObjectByName('charge'); return c ? c.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.02, 0).applyQuaternion(q)) : w.localToWorld(eyeP.set(0, 0.07, 0.01)); }
        return gripL();
      };
      const roll = (h: HandAt) => q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), h === 'charge' ? Math.PI : h === 'away' ? -Math.PI / 2 : 0));
      const [h0, h1, ht] = cho ? handTrack(cho.hand, rp) : ['grip', 'grip', 0] as [HandAt, HandAt, number];
      const lt = at(h0).lerp(at(h1), ht), lq = roll(h0).slerp(roll(h1), ht), style = (ht < 0.5 ? h0 : h1) === 'grip' ? 'pistol' : 'rifle';
      armIK(b, 'l', wristTarget(lt, lq, 'l', style), b.upperarm_l.getWorldPosition(new THREE.Vector3()).addScaledVector(right, -0.3).add(new THREE.Vector3(0, -0.6, 0)), 0.13);
      wrapHand(b, lq, 'l', this.bind, style);
    } else if (b.upperarm_l && b.lowerarm_l && b.hand_l && gl) {
      let lt = gl.getWorldPosition(new THREE.Vector3());
      if (cho && gr) {
        // Support hand: magazine well (following the magazine's path), the pouch at the left hip, the charging handle.
        const g0 = gr.getWorldPosition(new THREE.Vector3());
        const at = (h: HandAt): THREE.Vector3 => {
          if (h === 'mag' || h === 'catch' || h === 'cover') { const m = vec(cho.magPos, rp, _r3); return g0.clone().add(new THREE.Vector3(m[0] - 0.02, -0.05 + m[1] - num(cho.magSlide, rp) * 0.8, -0.13 + m[2]).applyQuaternion(q)); }
          if (h === 'away') return chest.clone().add(new THREE.Vector3(-0.12, -0.32, -0.08).applyQuaternion(yawQ));
          if (h === 'charge') return g0.clone().add(new THREE.Vector3(0.06, 0.07, -0.12).applyQuaternion(q));
          return gl.getWorldPosition(new THREE.Vector3());
        };
        const [h0, h1, ht] = handTrack(cho.hand, rp);
        lt = at(h0).lerp(at(h1), ht);
      }
      armIK(b, 'l', wristTarget(lt, q, 'l'), b.upperarm_l.getWorldPosition(new THREE.Vector3()).addScaledVector(right, -0.25).add(new THREE.Vector3(0, -0.6, 0)));
      wrapHand(b, q, 'l', this.bind);
    }
  }

  /** World position of the chest (for blood pools). */
  chest(): [number, number, number] | null { const b = this.bones.spine_02; if (!b) return null; const v = b.getWorldPosition(new THREE.Vector3()); return [v.x, v.y, v.z]; }

  /** Leave the weapon lying on the ground next to the body. */
  dropWeapon(s: Soldier) {
    const w = this.weapon; if (!w || this.gunLoose) return;
    const rx = Math.cos(s.yaw), rz = -Math.sin(s.yaw);
    w.position.set(s.pos[0] + rx * 0.55, s.pos[1] + 0.04, s.pos[2] + rz * 0.55);
    w.quaternion.setFromEuler(new THREE.Euler(0, s.yaw + 0.6 + (s.id % 5) * 0.3, Math.PI / 2, 'YXZ'));
    w.visible = true; w.updateMatrixWorld(true);
  }

  dispose() {
    // The clone's skeleton owns a bone texture on the GPU: free it with the body (a long match leaked one per death).
    for (const m of this.meshes) m.skeleton?.dispose();
    for (const w of this.wounds) w.m.parent?.remove(w.m);
    this.wounds = [];
    this.rag?.finish(); this.rag = null; this.root.parent?.remove(this.root); if (this.weapon) this.weapon.parent?.remove(this.weapon); }
}

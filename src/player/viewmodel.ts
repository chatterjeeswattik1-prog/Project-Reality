// First-person weapon: hip and aimed poses (the weapon's `cheek` point is brought to the camera), sway and recoil
// rotate the weapon about the eye (the sights show where the round goes), mouse lag, walk bob, wall pull-back, the
// per-shot cycle of the charging handle with ejected brass, and the reload choreography from handling.ts: the
// magazine (or belt box, rocket) and the charging handle move, and the support hand follows them by IK.
import * as THREE from 'three';
import type { Soldier } from '../game/soldier';
import { damp } from '../core/rng';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { armIK, wrapHand, wristTarget } from '../game/rig';
import { choreo, hand as handTrack, num, step, styleOf, vec, type Choreo, type HandAt, type Style, type V3 } from './handling';
import { FpRig, PACKS, PACK_OF, type ClipName } from './fprig';
import { gltf } from '../core/assets';

/** Share of the recoil climb that moves the camera; the weapon shows the rest (it turns about the eye). */
export const CAM_RECOIL = 0.6;
/** Vertical field of view the first-person weapon and arms are drawn with (degrees). */
export const VM_FOV = 55;
const EYE_RELIEF: Record<string, number> = { acog: 0.07, rco: 0.07, scope10: 0.09, pso1: 0.08, pgo7: 0.07, irons: 0.17, none: 0.2 };
/** Charging handle / slide / bolt travel when the model has no `charge_back` empty (m, rearwards). */
const TRAVEL: Record<Style, number> = { ak: 0.09, ar: 0.07, belt: 0.08, bolt: 0.1, pistol: 0.035, rpg: 0, none: 0 };
/** Support-hand frame per target, relative to the weapon (a roll about the bore turns the palm-up handguard grip). */
const HAND_ROLL: Record<HandAt, number> = { grip: 0, mag: -Math.PI / 2, catch: -Math.PI / 2, away: -Math.PI / 2, charge: Math.PI / 2, cover: Math.PI };
const _M = new THREE.Matrix4(), _M2 = new THREE.Matrix4(), _s = new THREE.Vector3(), _one = new THREE.Vector3(1, 1, 1);
const _q3 = new THREE.Quaternion(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _z = new THREE.Vector3(0, 0, 1);

export class Viewmodel {
  group = new THREE.Group();
  private model: THREE.Object3D | null = null;
  private id = '';
  private style: Style = 'none';
  // Animated parts and their rest poses (model space).
  private mag: THREE.Object3D | null = null; private magHome = new THREE.Vector3(); private magHomeQ = new THREE.Quaternion();
  private magDir = new THREE.Vector3(0, -1, 0); private handMag = new THREE.Vector3();
  private charge: THREE.Object3D | null = null; private chargeHome = new THREE.Vector3(); private chargeBack = new THREE.Vector3(); private handCharge = new THREE.Vector3();
  private cover: THREE.Object3D | null = null; private coverHomeQ = new THREE.Quaternion(); private handCover = new THREE.Vector3();
  private eject = new THREE.Vector3(0.02, 0.05, -0.05);
  private eyeLocal = new THREE.Vector3(0, 0.1, 0); private muzzleLocal = new THREE.Vector3(0, 0.08, -0.6);
  private gripR = new THREE.Vector3(); private gripL = new THREE.Vector3(0, 0, -0.3);
  private arms: THREE.Group;
  sway = new THREE.Vector2(); private swayV = new THREE.Vector2();
  recoil = 0; private recoilV = 0; private roll = 0; private rollV = 0;
  bob = 0; private pull = 0;
  ads = 0;
  private sprintK = 0; private switchK = 0;
  private cheekLocal: THREE.Vector3 | null = null;
  private cheekGl: THREE.Vector3 | null = null; private glTilt = 0;
  /** Sight line (eye -> front post) angles in the model: turned onto the view axis when aiming. */
  private sightPitch = 0; private sightYaw = 0;
  /** Per-shot action cycle (s since the shot) and bolt-action cycle progress. */
  private cycleT = 9; private boltT = 9;
  private reloadWas = 0; private lastP = 0;
  /** Sound cue and ejected-case callbacks (set by the Player). */
  onCue: (name: string, gain: number) => void = () => undefined;
  onEject: (p: V3, v: V3, big: boolean) => void = () => undefined;
  /** First-person body: the player's character with only its arms shown, posed by IK onto the weapon grips. */
  private body: THREE.Object3D | null = null;
  private bones: Record<string, THREE.Bone> = {};
  private bind = new Map<THREE.Bone, THREE.Quaternion>();
  /** Animated first-person rig (fprig.ts) for weapons of the M4 / AK families: replaces the IK arms and choreography. */
  private rig: FpRig | null = null; private rigs = new Map<string, FpRig>();
  private magRest = new THREE.Matrix4(); private chargeHomeQ = new THREE.Quaternion(); private chargeFollows = false;
  private drawT = 9; private drawRate = 1;
  /** The packs swap magazines by snapping one magazine bone from the dropped mag to the hand at the pouch: when it
   *  jumps, a copy of the old magazine keeps falling out of view instead of vanishing in mid-air. */
  private magPrev = new THREE.Vector3(); private magPrevQ = new THREE.Quaternion(); private magVel = new THREE.Vector3(); private magSeen = false;
  private drop: { o: THREE.Object3D; v: THREE.Vector3; spin: THREE.Vector3; t: number } | null = null;

  constructor(camera: THREE.PerspectiveCamera, private weapons: Map<string, THREE.Object3D>, sleeve: number,
    private rigSrc: Map<string, { scene: THREE.Object3D; animations: THREE.AnimationClip[] }> = new Map()) {
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
    // Put the head bone below and behind the eye so the shoulders sit under the view and the arms rise into it from
    // the bottom edge (as in Squad), instead of the upper arms filling the sides of the screen.
    const head = this.bones.Head ?? this.bones.head ?? this.bones.neck_01;
    if (head) { const h = this.group.worldToLocal(head.getWorldPosition(new THREE.Vector3())); b.position.sub(h).add(new THREE.Vector3(0, -0.1, 0.07)); }
    this.body = b;
  }

  /** Full-detail first-person models (models/weapons/<id>.glb), loaded on demand for the player's own weapons. */
  private full = new Map<string, THREE.Object3D | null>();
  private lastS: Soldier | undefined;
  preload(ids: string[]) {
    for (const id of ids) {
      if (this.full.has(id)) continue;
      this.full.set(id, null);
      void gltf(`models/weapons/${id}.glb`).then((g) => {
        if (!g) return;
        this.full.set(id, g.scene.getObjectByName(id) ?? g.scene);
        // Swap in the detailed model if this weapon is in hand.
        if (this.id === id) { this.id = ''; this.set(id, this.lastS); }
      });
    }
  }

  set(id: string, s?: Soldier) {
    if (id === this.id) return;
    this.id = id; this.lastS = s;
    this.preload([id]);
    if (this.model) this.group.remove(this.model);
    const src = this.full.get(id) ?? this.weapons.get(id);
    this.model = src ? src.clone() : this.placeholder();
    this.model.position.set(0, 0, 0); this.model.quaternion.identity(); this.model.updateMatrixWorld(true);
    // Own material copies: their sky reflection is turned down indoors (see setEnv), where blued steel otherwise
    // mirrors the blue sky and reads as navy plastic.
    this.mats = [];
    this.model.traverse((o) => {
      const m = o as THREE.Mesh; if (!m.isMesh) return;
      m.castShadow = false; m.receiveShadow = true;
      m.material = Array.isArray(m.material) ? m.material.map((x) => x.clone()) : m.material.clone();
      for (const x of Array.isArray(m.material) ? m.material : [m.material]) if ((x as THREE.MeshStandardMaterial).isMeshStandardMaterial) this.mats.push(x as THREE.MeshStandardMaterial);
    });
    this.setEnv(this.env, true);
    this.group.add(this.model);
    const M = this.model, inv = M.matrixWorld.clone().invert();
    const node = (n: string) => M.getObjectByName(n) ?? null;
    const e = (n: string, def: THREE.Vector3) => node(n)?.position.clone() ?? def;
    /** Model-space bounds of a part. */
    const box = (o: THREE.Object3D) => new THREE.Box3().setFromObject(o).applyMatrix4(inv);
    this.eyeLocal = e('eye', new THREE.Vector3(0, 0.12, 0));
    this.cheekLocal = node('cheek')?.position.clone() ?? null;
    // M203 leaf sight: its own cheek point and a sight line (eye_gl → front_gl) tilted up from the bore.
    const cg = node('cheek_gl'), eg = node('eye_gl'), fg = node('front_gl');
    this.cheekGl = cg ? cg.position.clone() : null;
    this.glTilt = eg && fg ? Math.atan2(fg.position.y - eg.position.y, -(fg.position.z - eg.position.z)) : 0;
    this.muzzleLocal = e('muzzle', new THREE.Vector3(0, 0.08, -0.6));
    const fp = node('front_post'), ey = node('eye');
    const d = fp && ey ? fp.position.clone().sub(ey.position) : null;
    this.sightPitch = d ? Math.atan2(d.y, -d.z) : 0; this.sightYaw = d ? Math.atan2(d.x, -d.z) : 0;
    // The aim point must lie on the sight line, or the rear and front sights part when the line is turned onto the view:
    // keep the cheek's distance behind the eye but put it on the line.
    if (d && ey) {
      const u = d.clone().normalize(), back = this.cheekLocal ? Math.max(0.05, ey.position.clone().sub(this.cheekLocal).dot(u)) : 0.13;
      this.cheekLocal = ey.position.clone().addScaledVector(u, -back);
    }
    this.eject = e('eject', new THREE.Vector3(0.02, 0.05, -0.05));
    this.gripR = e('grip_r', new THREE.Vector3()); this.gripL = e('grip_l', new THREE.Vector3(0, 0.03, -0.3));
    this.style = s ? styleOf(s.weapon) : 'none';
    // Magazine (belt box, rocket): its seat, withdrawal direction and where the hand holds it (mag-local).
    this.mag = node('mag') ?? node('box') ?? node('rocket');
    if (this.mag) {
      this.magHome.copy(this.mag.position); this.magHomeQ.copy(this.mag.quaternion);
      const md = node('mag_dir');
      this.magDir.copy(md ? md.position.clone().sub(this.magHome) : new THREE.Vector3(0, -1, 0.08)).normalize();
      const hm = this.mag.getObjectByName('hand_mag');
      if (hm) this.handMag.copy(hm.position);
      else { const b = box(this.mag), c = b.getCenter(new THREE.Vector3()); this.handMag.set(b.min.x - 0.004, c.y, c.z).sub(this.magHome); }
    }
    // Charging handle / slide / bolt.
    this.charge = node('charge') ?? node('bolt') ?? node('slide');
    if (this.charge) {
      this.chargeHome.copy(this.charge.position);
      this.chargeBack.copy(node('charge_back')?.position ?? this.chargeHome.clone().add(new THREE.Vector3(0, 0, TRAVEL[this.style])));
      const hc = this.charge.getObjectByName('hand_charge');
      if (hc) this.handCharge.copy(hc.position);
      else { const b = box(this.charge), c = b.getCenter(new THREE.Vector3()); this.handCharge.set(b.max.x + 0.01, c.y, c.z).sub(this.chargeHome); }
    } else this.handCharge.set(0, 0, 0);
    // Feed cover (belt-fed).
    this.cover = node('cover');
    if (this.cover) {
      this.coverHomeQ.copy(this.cover.quaternion);
      const hc = this.cover.getObjectByName('hand_cover');
      if (hc) this.handCover.copy(hc.position);
      else { const b = box(this.cover); this.handCover.set((b.min.x + b.max.x) / 2, b.max.y + 0.01, b.min.z + (b.max.z - b.min.z) * 0.3).sub(this.cover.position); }
    }
    this.recoil = 0; this.ads = 0; this.cycleT = this.boltT = 9;
    // Animated rig for this weapon family, if its pack is loaded.
    this.rig?.root.removeFromParent();
    const pk = PACK_OF[M.name] ?? PACK_OF[id];
    const rs = pk ? this.rigSrc.get(pk) : undefined;
    this.rig = rs ? (this.rigs.get(pk) ?? this.rigs.set(pk, new FpRig(rs, PACKS[pk])).get(pk)!) : null;
    if (this.rig) {
      this.group.add(this.rig.root);
      if (this.mag) this.magRest.compose(this.magHome, this.magHomeQ, this.mag.scale);
      this.chargeFollows = !!this.charge && this.rig.def.chargeFollows.includes(M.name);
      if (this.charge) this.chargeHomeQ.copy(this.charge.quaternion);
      this.drawT = 0; this.drawRate = s && s.switchT > 0 ? this.rig.duration('draw') / s.switchT : 1e9;
    }
  }
  private placeholder(): THREE.Object3D {
    const g = new THREE.Group(), m = new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.5, metalness: 0.4 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.1, 0.5), m); body.position.set(0, 0.06, -0.15); g.add(body);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.35, 8).rotateX(Math.PI / 2), m); barrel.position.set(0, 0.08, -0.55); g.add(barrel);
    const eye = new THREE.Object3D(); eye.name = 'eye'; eye.position.set(0, 0.14, 0); g.add(eye);
    const mz = new THREE.Object3D(); mz.name = 'muzzle'; mz.position.set(0, 0.08, -0.72); g.add(mz);
    return g;
  }

  private mats: THREE.MeshStandardMaterial[] = []; private env = 1;
  /** Sky reflection strength for the first-person materials (1 outdoors, low indoors). */
  setEnv(k: number, force = false) {
    if (!force && Math.abs(k - this.env) < 0.01) return;
    this.env = k;
    for (const m of this.mats) m.envMapIntensity = k;
  }

  /** A shot: the weapon slams back into the shoulder and rolls a little; the action cycles and throws a case. */
  kick(up: number, side: number) {
    this.recoilV += up * 0.16; this.rollV += side * 0.05 + (Math.random() - 0.5) * up * 0.012;
    this.cycleT = 0;
    if (this.style === 'bolt') this.boltT = -0.25;
    else if (this.model && this.style !== 'rpg' && this.style !== 'none') {
      const p = this.model.localToWorld(this.eject.clone()), q = this.model.getWorldQuaternion(_q);
      const v = new THREE.Vector3(2.2 + Math.random() * 1.2, 1.2 + Math.random() * 1.0, 0.4 + Math.random() * 0.6).applyQuaternion(q);
      this.onEject([p.x, p.y, p.z], [v.x, v.y, v.z], this.style === 'belt');
    }
  }

  /** Barrel direction in world space (models point −Z); false when no model. */
  forward(out: THREE.Vector3) { if (!this.model) return false; this.model.getWorldDirection(out).negate(); return true; }
  /** Muzzle world position (for flashes). */
  muzzleWorld(out = new THREE.Vector3()) { return this.model ? this.model.localToWorld(out.copy(this.muzzleLocal)) : out.set(0, 0, 0); }

  update(dt: number, s: Soldier, mouse: [number, number], wallDist: number, optic: string) {
    if (!this.model) return;
    this.ads = s.ads;
    // Viewmodel field of view: the weapon and arms are drawn as through a camera of VM_FOV (the arm meshes of the
    // animated packs end above the elbow; a wide view shows the cut ends). Scaling the camera-attached group by k in x
    // and y is exactly a narrower projection for it; the screen centre (the sights) does not move.
    const cam = this.group.parent as THREE.PerspectiveCamera | null;
    const k = cam?.isPerspectiveCamera ? Math.max(1, Math.tan((cam.fov * Math.PI) / 360) / Math.tan((VM_FOV * Math.PI) / 360)) : 1;
    this.group.scale.set(k, k, 1);
    const t = performance.now() / 1000, ads = THREE.MathUtils.smoothstep(this.ads, 0, 1);
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
      // Recoil: under-damped spring back to rest (ω = 26 rad/s, ζ ≈ 0.55); roll likewise.
      this.recoilV += (-this.recoil * 676 - this.recoilV * 28) * h; this.recoil += this.recoilV * h;
      this.rollV += (-this.roll * 400 - this.rollV * 22) * h; this.roll += this.rollV * h;
    }
    this.sway.clampScalar(-0.05, 0.05); this.recoil = THREE.MathUtils.clamp(this.recoil, -0.05, 0.12);
    const tired = 1 + (100 - s.stamina) / 40;
    const breathe = new THREE.Vector2(Math.sin(t * 0.9) * 0.0016 * tired, Math.sin(t * 1.8) * 0.0012 * tired);
    // Walk bob.
    const sp = Math.hypot(s.vel[0], s.vel[2]);
    this.bob += dt * sp * (s.sprinting ? 2.2 : 2.6);
    const bobA = Math.min(1, sp / 3) * (s.stance === 'prone' ? 0.3 : 1) * (1 - ads * 0.85);
    const bx = Math.sin(this.bob) * 0.012 * bobA, by = -Math.abs(Math.cos(this.bob)) * 0.01 * bobA;
    // Poses: hip (low right, canted in a touch), aimed (cheek weld at the camera), sprint (canted down), reload.
    const relief = EYE_RELIEF[optic] ?? 0.15;
    const gl = s.underSel && this.cheekGl;
    // Aimed: the sight line (eye -> front post) is turned onto the view axis, about the cheek point.
    const sq = _q3.setFromEuler(_e.set(gl ? -this.glTilt : -this.sightPitch, gl ? 0 : this.sightYaw, 0, 'YXZ'));
    const aim = gl ? this.cheekGl!.clone().applyQuaternion(sq).negate() : this.cheekLocal ? this.cheekLocal.clone().applyQuaternion(sq).negate() : new THREE.Vector3(-this.eyeLocal.x, -this.eyeLocal.y, -relief - this.eyeLocal.z).applyQuaternion(sq);
    // Hip: the sights ride ~7 cm below the eye (tall LMG receivers stay out of the face), the grip at least 13 cm down.
    const hip = new THREE.Vector3(0.07, Math.min(-0.13, -0.07 - this.eyeLocal.y), -0.17);
    const kind = s.weapon.kind;
    // Launchers ride on the shoulder (just below the aimed position); throwables and charges are held low in the firing
    // hand by their grip point. Long guns sit a little closer so the support hand reaches their handguard.
    hip.z += Math.max(0, -0.3 - this.gripL.z) * 0.7;
    if (kind === 'launcher') hip.copy(aim).add(new THREE.Vector3(0.11, -0.05, 0.04));
    else if (kind === 'grenade' || kind === 'charge') hip.set(0.17, -0.17, -0.33).sub(this.gripR);
    const rig = this.rig;
    if (rig && kind !== 'launcher') hip.fromArray(rig.def.hip);
    const pos = hip.lerp(aim, ads);
    const hr = rig ? rig.def.hipRot : [0, 0.035, -0.04];
    let rx = hr[0] * (1 - ads), ry = hr[1] * (1 - ads), rz = hr[2] * (1 - ads);
    // Sprint carry: blended in and out (never snapped) so brief speed changes do not flip the weapon up and down.
    this.sprintK += ((s.sprinting && sp > 0.8 ? 1 : 0) - this.sprintK) * damp(s.sprinting ? 7 : 5, dt);
    const sk = THREE.MathUtils.smoothstep(this.sprintK, 0, 1);
    pos.add(new THREE.Vector3(0.06 * sk, -0.08 * sk, 0.04 * sk)); rx += -0.5 * sk; ry += 0.6 * sk; rz += 0.25 * sk;

    // Reload choreography.
    if (s.reloadT > 0 && this.reloadWas <= 0) this.lastP = 0;
    this.reloadWas = s.reloadT;
    const cho: Choreo | null = s.reloadT > 0 && !s.underSel && !rig ? choreo(s.weapon, s.reloadEmpty) : null;
    const p = s.reloadT > 0 ? THREE.MathUtils.clamp(1 - s.reloadT / Math.max(0.1, s.reloadDur), 0, 1) : 0;
    const tmp: V3 = [0, 0, 0];
    if (cho) {
      vec(cho.pos, p, tmp); pos.x += tmp[0]; pos.y += tmp[1]; pos.z += tmp[2];
      vec(cho.rot, p, tmp); rx += tmp[0]; ry += tmp[1]; rz += tmp[2];
      for (const [ct, name, g] of cho.cues) if (ct > this.lastP && ct <= p) this.onCue(name, g ?? 0.7);
      this.lastP = p;
    } else if (s.reloadT > 0) {
      // Under-barrel grenade: tip the rifle and load it.
      const k = Math.sin(p * Math.PI); rz -= k * 0.35; rx += k * 0.3; pos.y -= k * 0.03;
    }
    this.switchK += ((s.switchT > 0 ? Math.min(1, s.switchT * 2) : 0) - this.switchK) * damp(12, dt);
    if (!rig) pos.y -= this.switchK * 0.25;
    if (s.bandageT > 0) pos.y -= 0.3;
    // Pull back from walls so the barrel does not poke through.
    this.pull += (Math.max(0, 0.75 - wallDist) - this.pull) * damp(12, dt);
    pos.z += this.pull * 0.45; rx += this.pull * 0.6;
    // Hip: lag, breathing and bob slide the weapon. Aimed: they turn it about the eye instead (added to qAim below), so
    // the rear and front sights stay lined up and only the sight picture moves.
    const lagX = bx + this.sway.x + breathe.x, lagY = by + this.sway.y + breathe.y;
    pos.x += lagX * (1 - ads); pos.y += lagY * (1 - ads);
    pos.z += this.recoil * 0.35;
    // Aiming the M203: tilt the rifle down so the leaf sight line (not the bore) points where the camera looks.
    if (gl) rx -= this.glTilt * ads;
    else { rx -= this.sightPitch * ads; ry += this.sightYaw * ads; }
    rx += this.recoil * 0.5;
    // The sights' sway and the part of the recoil climb the camera does not follow turn the whole weapon about the
    // eye, so the sight picture moves on screen exactly as the aim does.
    const qAim = _q2.setFromEuler(_e.set(s.wob[1] + s.rcP * (1 - CAM_RECOIL) + lagY * 2.2 * ads, s.wob[0] + s.rcY * (1 - CAM_RECOIL) - lagX * 2.2 * ads, 0, 'YXZ'));
    this.model.position.copy(pos).applyQuaternion(qAim);
    this.model.quaternion.setFromEuler(_e.set(rx, ry, rz + this.roll, 'YXZ')).premultiply(qAim);
    this.model.updateMatrix();
    // Animated rig: pick the clip and time, place the rig on this pose and let the clip move the weapon.
    if (rig) {
      this.drawT += dt * this.drawRate;
      let clip: ClipName = 'fire', ct = 0;
      if (s.reloadT > 0 && !s.underSel) { clip = s.reloadEmpty ? 'reload_empty' : 'reload'; ct = p * rig.duration(clip); }
      else if (this.drawT < rig.duration('draw')) { clip = 'draw'; ct = this.drawT; }
      rig.pose(clip, ct);
      rig.place(this.model.matrix, _M);
      _M.decompose(this.model.position, this.model.quaternion, _s);
      this.model.updateMatrix();
      if (clip === 'reload' || clip === 'reload_empty') {
        for (const [ct2, name, g] of rig.cues(clip)) if (ct2 > this.lastP && ct2 <= p) this.onCue(name, g ?? 0.7);
        this.lastP = p;
      }
    }

    // Animated parts.
    const mag = this.mag;
    if (mag) {
      mag.position.copy(this.magHome); mag.quaternion.copy(this.magHomeQ);
      if (cho) {
        vec(cho.magPos, p, tmp); mag.position.x += tmp[0]; mag.position.y += tmp[1]; mag.position.z += tmp[2];
        mag.position.addScaledVector(this.magDir, num(cho.magSlide, p));
        mag.quaternion.multiply(_q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), num(cho.magRock, p)));
        mag.visible = step(cho.magShow, p) > 0.5;
      } else mag.visible = !(kind === 'launcher' && s.slot.loaded === 0);
      if (rig) {
        rig.partLocal('mag', this.magRest, _M).decompose(mag.position, mag.quaternion, mag.scale); mag.visible = true;
        // Track the magazine in viewmodel-group space; a jump of more than 12 cm in one frame is the bone snapping back.
        this.model.updateMatrix(); mag.updateMatrix();
        _M2.multiplyMatrices(this.model.matrix, mag.matrix);
        const gp = _v.setFromMatrixPosition(_M2);
        if (this.magSeen && s.reloadT > 0 && dt > 0) {
          const jump = gp.distanceTo(this.magPrev);
          if (jump > 0.12 && !this.drop) {
            const o = mag.clone(); o.matrixAutoUpdate = true;
            o.position.copy(this.magPrev); o.quaternion.copy(this.magPrevQ); o.scale.copy(mag.scale);
            this.group.add(o);
            this.drop = { o, v: this.magVel.clone(), spin: new THREE.Vector3((Math.random() - 0.5) * 4, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 4), t: 0 };
          } else this.magVel.copy(gp).sub(this.magPrev).divideScalar(dt);
        }
        this.magPrev.copy(gp); this.magPrevQ.setFromRotationMatrix(_M2); this.magSeen = s.reloadT > 0;
      }
    }
    this.cycleT += dt; this.boltT += dt;
    // Charging handle: reload track, the bolt cycle of a bolt-action, or the carrier slamming back per shot (and held
    // open on an empty AR / pistol).
    let travel = cho ? num(cho.charge, p) : 0, boltK = 0;
    if (!cho) {
      if (this.style === 'bolt') { const b = this.boltT; boltK = b > 0 && b < 1 ? Math.sin(Math.PI * Math.min(1, b / 0.9)) : 0; travel = b > 0.15 && b < 0.85 ? Math.sin(Math.PI * (b - 0.15) / 0.7) : 0; if (b > 0.15 && this.boltT - dt <= 0.15) this.onCue('bolt_action_cycle', 0.8); }
      else { const cyc = Math.min(0.06, (60 / s.weapon.rpm) * 0.8); travel = this.cycleT < cyc ? Math.sin(Math.PI * this.cycleT / cyc) : 0; if (s.slot.loaded === 0 && (this.style === 'ar' || this.style === 'pistol')) travel = 1; }
      // On the rig, only a part that is the bolt carrier cycles (an AR's T-handle stays put when firing).
      if (rig && !this.chargeFollows) travel = 0;
    }
    if (this.charge) {
      this.charge.position.lerpVectors(this.chargeHome, this.chargeBack, travel);
      // A bolt-action bolt rotates up (~60°) before it slides back.
      if (this.style === 'bolt') this.charge.quaternion.setFromAxisAngle(_z, -Math.min(1, boltK * 3) * 1.05 * (cho ? Math.min(1, travel * 4) : 1));
      if (rig && this.chargeFollows) {
        // The carrier's own cycle, carried by the charge bone's motion in the clip (pulled back and released).
        _M2.compose(this.charge.position, this.chargeHomeQ, _one);
        rig.partLocal('charge', _M2, _M).decompose(this.charge.position, this.charge.quaternion, this.charge.scale);
      }
    }
    // Feed covers hinge at their front: opening lifts the rear (negative angle about +X).
    if (this.cover && cho?.cover) this.cover.quaternion.copy(this.coverHomeQ).multiply(_q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -num(cho.cover, p) * 0.95));

    if (this.drop) {
      const d = this.drop; d.t += dt; d.v.y -= 9.81 * dt;
      d.o.position.addScaledVector(d.v, dt);
      d.o.rotation.x += d.spin.x * dt; d.o.rotation.y += d.spin.y * dt; d.o.rotation.z += d.spin.z * dt;
      if (d.t > 0.9) { this.group.remove(d.o); this.drop = null; }
    }
    // Arms: the rig's own, or the character's arms by IK.
    if (this.body) this.body.visible = !rig;
    this.arms.visible = !this.body && !rig;
    if (rig) { this.group.visible = s.alive; return; }
    const ht: [HandAt, HandAt, number] = cho ? handTrack(cho.hand, p) : ['grip', 'grip', 0];
    const wq = this.model.getWorldQuaternion(new THREE.Quaternion());
    const targetOf = (at: HandAt): THREE.Vector3 => {
      switch (at) {
        case 'mag': return mag ? mag.localToWorld(this.handMag.clone()) : this.model!.localToWorld(this.gripL.clone());
        case 'charge': return this.charge ? this.charge.localToWorld(this.handCharge.clone()) : this.model!.localToWorld(this.eject.clone().add(new THREE.Vector3(0.04, 0, -0.04)));
        case 'catch': return this.model!.localToWorld(this.style === 'bolt' ? this.eject.clone().add(new THREE.Vector3(0.02, 0.03, 0)) : this.magHome.clone().add(new THREE.Vector3(-0.03, 0.035, 0.01)));
        case 'cover': return this.cover ? this.cover.localToWorld(this.handCover.clone()) : this.model!.localToWorld(this.eyeLocal.clone());
        case 'away': return this.group.localToWorld(new THREE.Vector3(-0.32, -0.6, -0.1));
        default: return this.model!.localToWorld(this.gripL.clone());
      }
    };
    const frame = (at: HandAt) => wq.clone().multiply(new THREE.Quaternion().setFromAxisAngle(_z, HAND_ROLL[at]));
    const lPos = targetOf(ht[0]).lerp(targetOf(ht[1]), ht[2]), lQ = frame(ht[0]).slerp(frame(ht[1]), ht[2]);
    // Bolt-action: the firing hand leaves the grip to work the bolt.
    const rOff = boltK > 0 && this.charge ? Math.min(1, boltK * 2.5) : 0;
    const rPos = this.model.localToWorld(this.gripR.clone()).lerp(this.charge ? this.charge.localToWorld(this.handCharge.clone()) : _v.set(0, 0, 0), rOff);
    if (!this.body) {
      const place = (side: 'r' | 'l', g: THREE.Vector3, q: THREE.Quaternion, elbow: THREE.Vector3) => {
        const hand = this.arms.getObjectByName(`hand_${side}`)!, fore = this.arms.getObjectByName(`fore_${side}`)!;
        const gl = this.group.worldToLocal(g.clone());
        hand.position.copy(gl); hand.quaternion.copy(q);
        fore.position.copy(gl); fore.lookAt(this.group.localToWorld(elbow.clone()));
      };
      place('r', rPos, wq, new THREE.Vector3(0.28, -0.42, 0.05));
      place('l', lPos, lQ, new THREE.Vector3(-0.2, -0.45, -0.05));
    } else {
      // Arms from the shoulders to the targets (world space), elbows down and out, hands wrapped round what they hold.
      for (const [bn, q] of this.bind) if (/arm|hand|clavicle|index|middle|ring|pinky|thumb/.test(bn.name)) bn.quaternion.copy(q);
      this.group.updateMatrixWorld(true);
      const B = this.bones;
      if (B.upperarm_r && B.lowerarm_r && B.hand_r) { armIK(B, 'r', wristTarget(rPos, wq, 'r'), this.group.localToWorld(new THREE.Vector3(0.5, -0.7, 0.1)), 0.06); wrapHand(B, wq, 'r', this.bind); }
      const oneHand = kind === 'grenade' || kind === 'charge';
      // One-handed items: the support arm hangs down out of view.
      const lt = oneHand ? this.group.localToWorld(new THREE.Vector3(-0.28, -0.75, -0.05)) : wristTarget(lPos, lQ, 'l');
      if (B.upperarm_l && B.lowerarm_l && B.hand_l) { armIK(B, 'l', lt, this.group.localToWorld(new THREE.Vector3(-0.45, -0.7, -0.15))); if (!oneHand) wrapHand(B, lQ, 'l', this.bind); }
    }
    this.group.visible = s.alive;
  }
}

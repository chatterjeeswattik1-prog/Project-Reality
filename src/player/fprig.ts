// Animated first-person rigs from the user's packs (scripts/fprig.mjs, tools/blender/fpweapons.py): the pack's arms
// and weapon bones play its authored clips (reload, empty reload, draw), and any contract weapon of the same family hangs
// on the weapon bone. The rig is placed so that, at the idle frame, the weapon bone carries the contract frame exactly
// where the Viewmodel put the weapon (hip, aim, sway, recoil): a clip then moves gun and arms together relative to that
// pose. The weapon's magazine (and on the AK rig its charging handle) follows its bone's motion relative to idle.
import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';

type V3 = [number, number, number];
export interface PackDef {
  url: string;
  /** Weapon body, magazine and (optional) charging-handle bones. */ bone: string; mag: string; charge: string;
  /** Contract frame of the pack's own weapon at the idle pose, Blender world (fpweapons.py `FRAME`). */
  frame: { o: V3; r: V3; f: V3; u: V3 };
  /** Weapons whose `charge` part follows the charge bone (the AR rig's bolt is the carrier, not the T-handle). */
  chargeFollows: string[];
  /** Hip position of the grip and hip rotation (rad, YXZ) in camera space: the pose the pack was animated for, relative
   *  to its own camera (other poses show the cut-off ends of the arms and the magazine swap off-screen in the pack). */ hip: V3; hipRot: V3;
  /** Sound when the charge bone comes home in a reload (bolt release / charging handle let go). */ chargeSound: string;
}
export const PACKS: Record<string, PackDef> = {
  m4: {
    url: 'models/fp/fp_m4.glb', bone: 'Main_j_049', mag: 'Mag1_j_050', charge: 'Bolt_j_052',
    frame: { o: [-0.06023, -0.04109, 1.37307], r: [-1, 0, 0], f: [0, -1, 0], u: [0, 0, 1] },
    chargeFollows: ['m4a1'], chargeSound: 'bolt_release', hip: [0.0711, -0.1662, -0.1417], hipRot: [0, 0, 0],
  },
  ak: {
    url: 'models/fp/fp_ak.glb', bone: 'wpn_body_068', mag: 'wpn_magazine_072', charge: 'wpn_zatvor_069',
    frame: { o: [0.11354, 0.23363, -0.16501], r: [0.98734, 0.02089, 0.15722], f: [-0.0309, 0.99763, 0.06152], u: [-0.15556, -0.0656, 0.98565] },
    chargeFollows: ['aks74u', 'akm', 'ak47', 'rpk', 'svd'], chargeSound: 'charging_handle_ak', hip: [0.1333, -0.1539, -0.3587], hipRot: [0.0616, 0.031, 0.1582],
  },
};
/** Which rig a weapon model uses (the user asked for the M4 clips on the M16 too, the AKS-74U clips on every AK rifle). */
export const PACK_OF: Record<string, string> = {
  m4a1: 'm4', m4a1_m203: 'm4', m16a4: 'm4',
  aks74u: 'ak', akm: 'ak', ak47: 'ak', rpk: 'ak', svd: 'ak',
};
export type ClipName = 'fire' | 'reload' | 'reload_empty' | 'draw' | 'holster';

/** Blender world (Z up) -> three.js world (Y up). */
const cv = (v: V3) => new THREE.Vector3(v[0], v[2], -v[1]);
const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _inv = new THREE.Matrix4();

/** One live rig instance (cloned per Viewmodel). */
export class FpRig {
  root: THREE.Object3D;
  private mixer: THREE.AnimationMixer;
  private actions = new Map<string, THREE.AnimationAction>();
  private bone: THREE.Object3D; private magBone: THREE.Object3D | null; private chargeBone: THREE.Object3D | null;
  /** Contract frame in rig-root space at idle, its inverse, and the bone poses at idle (rig-root space). */
  private F = new THREE.Matrix4(); private Finv = new THREE.Matrix4();
  private A = new THREE.Matrix4();
  private magIdleInv = new THREE.Matrix4(); private chargeIdleInv = new THREE.Matrix4();
  /** Current bone poses (rig-root space). */
  private B = new THREE.Matrix4(); private Mg = new THREE.Matrix4(); private Ch = new THREE.Matrix4();
  private cur: THREE.AnimationAction | null = null;

  constructor(src: { scene: THREE.Object3D; animations: THREE.AnimationClip[] }, public def: PackDef) {
    this.root = SkeletonUtils.clone(src.scene);
    this.root.matrixAutoUpdate = false;
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) { m.frustumCulled = false; m.castShadow = false; m.receiveShadow = true; }
    });
    this.mixer = new THREE.AnimationMixer(this.root);
    for (const c of src.animations) {
      const a = this.mixer.clipAction(c); a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true;
      this.actions.set(c.name, a);
    }
    this.bone = this.root.getObjectByName(def.bone)!;
    this.magBone = this.root.getObjectByName(def.mag) ?? null;
    this.chargeBone = this.root.getObjectByName(def.charge) ?? null;
    // Contract frame at idle: three.js axes of a contract model are X right, Y up, Z = -forward.
    const f = def.frame, r = cv(f.r).normalize(), u = cv(f.u).normalize(), fw = cv(f.f).normalize();
    this.F.makeBasis(r, u, fw.negate()).setPosition(cv(f.o));
    this.Finv.copy(this.F).invert();
    this.pose('fire', 0);
    this.A.copy(this.B).invert().multiply(this.F);
    this.magIdleInv.copy(this.Mg).invert();
    this.chargeIdleInv.copy(this.Ch).invert();
    for (const c of ['reload', 'reload_empty'] as ClipName[]) this.cueList.set(c, this.findCues(c));
    this.pose('fire', 0);
  }

  /** Reload sound cues [progress 0..1, sound, gain] read off the clip: magazine out / in, charge bone coming home. */
  cues(name: ClipName) { return this.cueList.get(name) ?? []; }
  private cueList = new Map<ClipName, [number, string, number?][]>();
  private findCues(name: ClipName): [number, string, number?][] {
    const dur = this.duration(name); if (!dur) return [];
    const mi = new THREE.Vector3().setFromMatrixPosition(this.Mg), ci = new THREE.Vector3().setFromMatrixPosition(this.Ch);
    const v = new THREE.Vector3(), out: [number, string, number?][] = [];
    let magOut = false, chOut = false;
    const N = 120;
    for (let i = 0; i <= N; i++) {
      const t = (i / N) * dur;
      this.pose(name, t);
      const dm = v.setFromMatrixPosition(this.Mg).distanceTo(mi), dc = v.setFromMatrixPosition(this.Ch).distanceTo(ci);
      if (!magOut && dm > 0.025) { magOut = true; out.push([i / N, 'mag_out']); out.push([i / N + 0.12, 'aim_cloth', 0.4]); }
      else if (magOut && dm < 0.006) { magOut = false; out.push([i / N, 'mag_in']); }
      if (!chOut && dc > 0.03) chOut = true;
      else if (chOut && dc < 0.008) { chOut = false; out.push([i / N, this.def.chargeSound]); }
    }
    // A bolt already back at the start (empty AR) still slams home when released.
    if (chOut) out.push([0.92, this.def.chargeSound]);
    return out;
  }

  duration(name: ClipName) { return this.actions.get(name)?.getClip().duration ?? 0; }

  /** Pose the rig at `t` seconds into a clip and read the bone matrices (rig-root space). */
  pose(name: ClipName, t: number) {
    const a = this.actions.get(name) ?? this.actions.get('fire')!;
    if (a !== this.cur) { this.cur?.stop(); a.reset().play(); this.cur = a; }
    a.time = Math.min(t, a.getClip().duration - 1e-4);
    this.mixer.update(0);
    const keep = this.root.matrix.clone();
    this.root.matrix.identity(); this.root.updateMatrixWorld(true);
    const P = this.root.parent; const pw = P ? _inv.copy(P.matrixWorld).invert() : _inv.identity();
    // root matrixWorld = parentWorld (root matrix is identity now), so bone-in-root = inv(parentWorld) * boneWorld
    this.B.multiplyMatrices(pw, this.bone.matrixWorld);
    if (this.magBone) this.Mg.multiplyMatrices(pw, this.magBone.matrixWorld);
    if (this.chargeBone) this.Ch.multiplyMatrices(pw, this.chargeBone.matrixWorld);
    this.root.matrix.copy(keep);
  }

  /**
   * Place the rig for weapon pose H (the contract weapon's matrix in the Viewmodel group) and return the animated weapon
   * matrix (same space) in `outW`. Call after pose().
   */
  place(H: THREE.Matrix4, outW: THREE.Matrix4) {
    this.root.matrix.multiplyMatrices(H, this.Finv);
    this.root.matrixWorldNeedsUpdate = true;
    outW.multiplyMatrices(this.root.matrix, _m.multiplyMatrices(this.B, this.A));
  }

  /**
   * Local matrix (in the weapon model) for a part that follows `which` bone: its rest local matrix `rest` carried by
   * the bone's motion since idle.
   */
  partLocal(which: 'mag' | 'charge', rest: THREE.Matrix4, out: THREE.Matrix4) {
    const K = which === 'mag' ? this.Mg : this.Ch, Ki = which === 'mag' ? this.magIdleInv : this.chargeIdleInv;
    // rig space: K(t) · K(idle)⁻¹ · F · rest ; model local = (B(t)·A)⁻¹ · that
    _m.multiplyMatrices(K, Ki).multiply(this.F).multiply(rest);
    _m2.multiplyMatrices(this.B, this.A).invert();
    return out.multiplyMatrices(_m2, _m);
  }
}

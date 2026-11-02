// Motion-captured run (Mixamo rig, public/models/chars/mocap/run.glb) retargeted onto the game's Unreal-style
// skeleton at load time and baked into an ordinary clip ("Run_Mocap").
// Method: pose the source skeleton frame by frame; for every mapped bone take its world rotation relative to its own
// rest pose, turn that delta into the target's facing, and apply it to the target bone's rest (world) rotation; then
// convert to local rotations parent-first. The pelvis gets the source hips' bob and sway (scaled by leg length; any
// forward root motion removed so the clip runs in place). Only the legs, hips and spine matter in game: Rig keeps the
// arms on the weapon (IK) and the torso in a carry posture, so this becomes a soldier running with his rifle.
import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';

/** Mixamo bone (prefix and Sketchfab's _NN suffix stripped) → target bone. */
const MAP: Record<string, string> = {
  Hips: 'pelvis', Spine: 'spine_01', Spine1: 'spine_02', Spine2: 'spine_03', Neck: 'neck_01', Head: 'Head',
  LeftShoulder: 'clavicle_l', LeftArm: 'upperarm_l', LeftForeArm: 'lowerarm_l', LeftHand: 'hand_l',
  RightShoulder: 'clavicle_r', RightArm: 'upperarm_r', RightForeArm: 'lowerarm_r', RightHand: 'hand_r',
  LeftUpLeg: 'thigh_l', LeftLeg: 'calf_l', LeftFoot: 'foot_l', LeftToeBase: 'ball_l',
  RightUpLeg: 'thigh_r', RightLeg: 'calf_r', RightFoot: 'foot_r', RightToeBase: 'ball_r',
};
const clean = (n: string) => n.replace(/^mixamorig[:_]?/, '').replace(/_\d+$/, '');

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3();

export interface Retargeted { clip: THREE.AnimationClip; /** Ground speed the clip is authored for (m/s, approximate). */ speed: number }

export function retargetRun(src: { scene: THREE.Object3D; animations: THREE.AnimationClip[] }, targetModel: THREE.Object3D, name = 'Run_Mocap', fps = 30): Retargeted | null {
  const anim = src.animations[0]; if (!anim) return null;
  const sScene = SkeletonUtils.clone(src.scene), tScene = SkeletonUtils.clone(targetModel);
  const sb = new Map<string, THREE.Bone>(), tb = new Map<string, THREE.Bone>();
  sScene.traverse((o) => { if ((o as THREE.Bone).isBone) sb.set(clean(o.name), o as THREE.Bone); });
  tScene.traverse((o) => { if ((o as THREE.Bone).isBone) tb.set(o.name, o as THREE.Bone); });
  const pairs: { s: THREE.Bone; t: THREE.Bone; sRest: THREE.Quaternion; tRest: THREE.Quaternion; depth: number }[] = [];
  sScene.updateMatrixWorld(true); tScene.updateMatrixWorld(true);
  for (const [sn, tn] of Object.entries(MAP)) {
    const s = sb.get(sn), t = tb.get(tn); if (!s || !t) continue;
    let depth = 0; for (let p = t.parent; p; p = p.parent) depth++;
    pairs.push({ s, t, sRest: s.getWorldQuaternion(new THREE.Quaternion()), tRest: t.getWorldQuaternion(new THREE.Quaternion()), depth });
  }
  if (pairs.length < 12) return null;
  pairs.sort((a, b) => a.depth - b.depth);
  // Facing: heel → toe of the left foot, flattened, in each rest pose.
  const fwd = (a?: THREE.Bone, b?: THREE.Bone) => (a && b ? b.getWorldPosition(new THREE.Vector3()).sub(a.getWorldPosition(new THREE.Vector3())).setY(0).normalize() : new THREE.Vector3(0, 0, 1));
  const fS = fwd(sb.get('LeftFoot'), sb.get('LeftToeBase')), fT = fwd(tb.get('foot_l'), tb.get('ball_l'));
  const R = new THREE.Quaternion().setFromUnitVectors(fS, fT), Ri = R.clone().invert();
  // Scale: hip height above the feet.
  const hipH = (h?: THREE.Bone, f?: THREE.Bone) => (h && f ? h.getWorldPosition(new THREE.Vector3()).y - f.getWorldPosition(new THREE.Vector3()).y : 1);
  const scale = hipH(tb.get('pelvis'), tb.get('foot_l')) / hipH(sb.get('Hips'), sb.get('LeftFoot'));
  const sHips = sb.get('Hips')!, tPelvis = tb.get('pelvis')!;
  const hipRest = sHips.getWorldPosition(new THREE.Vector3()), pelRest = tPelvis.getWorldPosition(new THREE.Vector3());

  const mixer = new THREE.AnimationMixer(sScene);
  mixer.clipAction(anim).play();
  const n = Math.max(2, Math.round(anim.duration * fps)), times: number[] = [];
  const qv = new Map<THREE.Bone, number[]>(), hips: THREE.Vector3[] = [];
  let maxSep = 0;
  for (let f = 0; f <= n; f++) {
    const t = (f / n) * anim.duration; times.push(t);
    mixer.setTime(f === n ? 0 : t); sScene.updateMatrixWorld(true);
    for (const p of pairs) {
      // world delta from rest, in the target's facing
      const d = p.s.getWorldQuaternion(_q).multiply(_q2.copy(p.sRest).invert());
      const dT = R.clone().multiply(d).multiply(Ri);
      const w = dT.multiply(p.tRest);
      const parentW = p.t.parent!.getWorldQuaternion(_q2);
      p.t.quaternion.copy(parentW.invert().multiply(w));
      p.t.updateMatrixWorld(true);
      (qv.get(p.t) ?? qv.set(p.t, []).get(p.t)!).push(p.t.quaternion.x, p.t.quaternion.y, p.t.quaternion.z, p.t.quaternion.w);
    }
    hips.push(sHips.getWorldPosition(new THREE.Vector3()).sub(hipRest).applyQuaternion(R).multiplyScalar(scale));
    const a = sb.get('LeftFoot')!.getWorldPosition(_v), b = sb.get('RightFoot')!.getWorldPosition(_v2);
    maxSep = Math.max(maxSep, Math.abs(a.sub(b).applyQuaternion(R).dot(fT)) * scale);
  }
  // Remove forward drift (root motion) so the clip runs in place; keep bob and sway.
  const drift = hips[hips.length - 1].clone().sub(hips[0]);
  const pos: number[] = [];
  for (let f = 0; f <= n; f++) {
    const h = hips[f].clone().addScaledVector(drift, -f / n);
    h.addScaledVector(fT, -h.dot(fT) + 0); // no fore-aft surge
    const w = pelRest.clone().add(h);
    const lp = tPelvis.parent!.worldToLocal(w);
    pos.push(lp.x, lp.y, lp.z);
  }
  const tracks: THREE.KeyframeTrack[] = [];
  for (const [bone, v] of qv) tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, v));
  tracks.push(new THREE.VectorKeyframeTrack(`${tPelvis.name}.position`, times, pos));
  mixer.stopAllAction();
  // A running stride: the feet's greatest fore-aft spread is roughly one step; two steps per cycle.
  return { clip: new THREE.AnimationClip(name, anim.duration, tracks), speed: (2 * maxSep * 1.15) / anim.duration };
}

// Ragdoll: when a soldier goes down, the body's main bones become Rapier capsules joined by ball joints, started from
// the animated pose with the body's velocity and shoved by the hit. The bones follow the capsules until they settle;
// the bodies are then removed and the pose stays (a corpse costs nothing). The weapon falls as a loose box.
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { G_DEBRIS, G_VEH, G_WORLD, groups, type Physics } from '../world/physics';

type V3 = [number, number, number];

/** Body segments: bone, the bone its capsule reaches to (null: along the parent → bone line), radius, mass (kg). */
interface Seg { bone: string; end: string | null; r: number; m: number; parent: string | null; extend?: number }
const SEGS: Seg[] = [
  { bone: 'pelvis', end: 'spine_02', r: 0.13, m: 12, parent: null },
  { bone: 'spine_02', end: 'neck_01', r: 0.15, m: 26, parent: 'pelvis' },
  { bone: 'Head', end: null, r: 0.1, m: 5, parent: 'spine_02', extend: 0.2 },
  { bone: 'upperarm_l', end: 'lowerarm_l', r: 0.05, m: 2.5, parent: 'spine_02' },
  { bone: 'lowerarm_l', end: 'hand_l', r: 0.045, m: 2, parent: 'upperarm_l', extend: 0.1 },
  { bone: 'upperarm_r', end: 'lowerarm_r', r: 0.05, m: 2.5, parent: 'spine_02' },
  { bone: 'lowerarm_r', end: 'hand_r', r: 0.045, m: 2, parent: 'upperarm_r', extend: 0.1 },
  { bone: 'thigh_l', end: 'calf_l', r: 0.075, m: 8.5, parent: 'pelvis' },
  { bone: 'calf_l', end: 'foot_l', r: 0.055, m: 4.5, parent: 'thigh_l', extend: 0.08 },
  { bone: 'thigh_r', end: 'calf_r', r: 0.075, m: 8.5, parent: 'pelvis' },
  { bone: 'calf_r', end: 'foot_r', r: 0.055, m: 4.5, parent: 'thigh_r', extend: 0.08 },
];
/** Collides with the world and vehicles only: not with itself, characters, bullets or sight lines. */
const COL = groups(G_DEBRIS, G_WORLD | G_VEH);

const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);

/** body: its frame starts with the world's orientation, so every joint starts at rest (motor target 0 = the pose at the
 *  moment of death); off: the bone's rotation in the body frame. */
interface Part { bone: THREE.Bone; body: RAPIER.RigidBody; seg: Seg; off: THREE.Quaternion; joint: RAPIER.ImpulseJoint | null; hinge: boolean }
/** Knees and elbows are hinges that bend one way only (max flex, rad); the rest are ball joints. */
const HINGE: Record<string, { max: number; side: 1 | -1 }> = { calf_l: { max: 2.4, side: -1 }, calf_r: { max: 2.4, side: -1 }, lowerarm_l: { max: 2.6, side: 1 }, lowerarm_r: { max: 2.6, side: 1 } };
/** Rapier 0.21 hands joints back untyped: motor and limit calls go through the joint set. */
type RawJoints = { jointConfigureMotorPosition(h: number, ax: number, t: number, k: number, d: number): void; jointSetLimits(h: number, ax: number, lo: number, hi: number): void };
const raw = (j: RAPIER.ImpulseJoint) => (j as unknown as { rawSet: RawJoints }).rawSet;

export class Ragdoll {
  private parts: Part[] = [];
  private joints: RAPIER.ImpulseJoint[] = [];
  private gun: { obj: THREE.Object3D; body: RAPIER.RigidBody; off: THREE.Vector3 } | null = null;
  t = 0;
  private tone = -1;
  /** Bodies removed; the bones keep the last pose. */
  done = false;

  /** right: the body's right (world), the fallback hinge axis for a straight knee or elbow. */
  constructor(private P: Physics, bones: Record<string, THREE.Bone>, vel: V3, weapon: THREE.Object3D | null, right = new THREE.Vector3(1, 0, 0)) {
    const R = P.R, w = P.world;
    const byName = new Map<string, Part>();
    for (const sg of SEGS) {
      const bone = bones[sg.bone]; if (!bone) continue;
      bone.updateWorldMatrix(true, false);
      const p = bone.getWorldPosition(new THREE.Vector3()), q = bone.getWorldQuaternion(new THREE.Quaternion());
      // Capsule axis from the bone to its end, in the body's (bone's) frame.
      let endW: THREE.Vector3;
      if (sg.end && bones[sg.end]) endW = bones[sg.end].getWorldPosition(new THREE.Vector3());
      else { const par = bones[sg.parent ?? ''] ?? bone.parent!; endW = p.clone().add(p.clone().sub(par.getWorldPosition(new THREE.Vector3())).normalize().multiplyScalar(sg.extend ?? 0.2)); }
      const dirW = endW.clone().sub(p).normalize();
      const d = endW.sub(p).applyQuaternion(q.clone().invert());
      let len = d.length(); if (len < 1e-3) { d.set(0, 1, 0); len = 0.1; }
      if (sg.end && sg.extend) len += sg.extend;
      d.normalize();
      const half = Math.max(0.02, len / 2 - sg.r * 0.6);
      const body = w.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(p.x, p.y, p.z)
        .setLinvel(vel[0], vel[1], vel[2]).setLinearDamping(0.3).setAngularDamping(1.2).setCanSleep(true).setCcdEnabled(true));
      // Capsule along the bone, expressed in the (world-aligned) body frame.
      const cq = q.clone().multiply(new THREE.Quaternion().setFromUnitVectors(_up, d)), mid = d.clone().multiplyScalar(len / 2).applyQuaternion(q);
      w.createCollider(R.ColliderDesc.capsule(half, sg.r).setTranslation(mid.x, mid.y, mid.z).setRotation({ x: cq.x, y: cq.y, z: cq.z, w: cq.w })
        .setMass(sg.m).setFriction(0.9).setRestitution(0.05).setCollisionGroups(COL), body);
      const hg = HINGE[sg.bone];
      const part: Part = { bone, body, seg: sg, off: q.clone(), joint: null, hinge: !!hg };
      this.parts.push(part); byName.set(sg.bone, part);
      const par = sg.parent ? byName.get(sg.parent) : null;
      if (par) {
        // Joint at this bone's origin (both body frames are world-aligned here, so the joint starts at rest).
        const pp = par.body.translation(), a1 = { x: p.x - pp.x, y: p.y - pp.y, z: p.z - pp.z }, a2 = { x: 0, y: 0, z: 0 };
        let j: RAPIER.ImpulseJoint;
        if (hg) {
          // Hinge about the plane of the bend (or the body's right when the limb is straight), flexing from the pose it
          // is in up to the anatomical limit and not past straight.
          const dp = p.clone().sub(par.bone.getWorldPosition(new THREE.Vector3())).normalize();
          const n = dp.clone().cross(dirW);
          const axis = n.length() > 0.2 ? n.normalize() : right.clone().multiplyScalar(hg.side);
          const a0 = Math.atan2(dp.clone().cross(dirW).dot(axis), dp.dot(dirW));
          j = w.createImpulseJoint(R.JointData.revoluteWithAxes(a1, a2, { x: axis.x, y: axis.y, z: axis.z }, { x: axis.x, y: axis.y, z: axis.z }), par.body, body, true);
          raw(j).jointSetLimits(j.handle, 3, -a0 - 0.03, hg.max - a0);
        } else j = w.createImpulseJoint(R.JointData.spherical(a1, a2), par.body, body, true);
        j.setContactsEnabled(false);
        this.joints.push(j); part.joint = j;
      }
    }
    if (weapon && weapon.visible) {
      // The weapon drops as a box round its mesh.
      weapon.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(weapon), c = bb.getCenter(new THREE.Vector3()), sz = bb.getSize(new THREE.Vector3());
      const q = weapon.getWorldQuaternion(new THREE.Quaternion()), p = weapon.getWorldPosition(new THREE.Vector3());
      // Half extents in the weapon's frame (approximate from the world box of the rotated mesh, capped).
      const lb = new THREE.Box3();
      weapon.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && m.geometry) { m.geometry.computeBoundingBox(); lb.union(m.geometry.boundingBox!.clone().applyMatrix4(new THREE.Matrix4().copy(weapon.matrixWorld).invert().multiply(m.matrixWorld))); } });
      const he = lb.isEmpty() ? sz.multiplyScalar(0.5) : lb.getSize(new THREE.Vector3()).multiplyScalar(0.5);
      const lc = lb.isEmpty() ? c.clone().sub(p).applyQuaternion(q.clone().invert()) : lb.getCenter(new THREE.Vector3());
      const body = w.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(p.x, p.y, p.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setLinvel(vel[0] * 0.8, vel[1], vel[2] * 0.8).setAngularDamping(1.5).setLinearDamping(0.2));
      w.createCollider(R.ColliderDesc.cuboid(Math.max(0.02, he.x), Math.max(0.02, he.y), Math.max(0.02, he.z)).setTranslation(lc.x, lc.y, lc.z)
        .setMass(3.5).setFriction(0.8).setRestitution(0.1).setCollisionGroups(COL), body);
      this.gun = { obj: weapon, body, off: lc };
    }
  }

  /** The part whose bone is nearest a world point. */
  private nearest(p: V3): Part | null {
    let best: Part | null = null, bd = Infinity;
    for (const pt of this.parts) { const t = pt.body.translation(), d = (t.x - p[0]) ** 2 + (t.y - p[1]) ** 2 + (t.z - p[2]) ** 2; if (d < bd) { bd = d; best = pt; } }
    return best;
  }

  /** A shove at a point (N·s): most on the part hit, some carried to the whole body. */
  push(p: V3, imp: V3, share = 0.3) {
    if (this.done) return;
    const n = this.nearest(p);
    if (n) n.body.applyImpulseAtPoint({ x: imp[0] * (1 - share), y: imp[1] * (1 - share), z: imp[2] * (1 - share) }, { x: p[0], y: p[1], z: p[2] }, true);
    const each = share / this.parts.length;
    for (const pt of this.parts) pt.body.applyImpulse({ x: imp[0] * each, y: imp[1] * each, z: imp[2] * each }, true);
  }

  /** Blast: every part is thrown away from the centre (N·s per kg at the part). */
  blast(c: V3, k: number) {
    if (this.done) return;
    for (const pt of [...this.parts, ...(this.gun ? [{ body: this.gun.body, seg: { m: 3.5 } as Seg }] : [])]) {
      const t = pt.body.translation(), d: V3 = [t.x - c[0], t.y - c[1] + 0.6, t.z - c[2]], L = Math.hypot(...d) || 1;
      const s = k * pt.seg.m;
      pt.body.applyImpulse({ x: (d[0] / L) * s, y: (d[1] / L) * s + s * 0.35, z: (d[2] / L) * s }, true);
      pt.body.applyTorqueImpulse({ x: (Math.random() - 0.5) * s * 0.05, y: (Math.random() - 0.5) * s * 0.05, z: (Math.random() - 0.5) * s * 0.05 }, true);
    }
  }

  /** Copy the bodies onto the bones (parents first). Returns false once settled and removed. */
  sync(dt: number): boolean {
    if (this.done) return false;
    this.t += dt;
    // Muscle tone: the joints hold the pose loosely at first and let go over about a second, so the body sags and
    // folds at the knees and hips instead of balling up or flailing; almost none stays (more held the legs locked
    // straight, and bodies came to rest propped like planks on head and heels).
    const tone = 0.025 + 0.975 * Math.exp(-this.t / 0.45);
    if (Math.abs(tone - this.tone) > 0.02) {
      this.tone = tone;
      for (const pt of this.parts) if (pt.joint) {
        const k = pt.seg.m >= 8 ? 1.4 : pt.seg.m >= 4 ? 1 : 0.7;
        const js = raw(pt.joint);
        for (const ax of pt.hinge ? [3] : [3, 4, 5]) js.jointConfigureMotorPosition(pt.joint.handle, ax, 0, 70 * tone * k, 9 * Math.sqrt(tone) * k);
      }
    }
    let moving = false;
    for (const pt of this.parts) {
      const b = pt.body, t = b.translation(), r = b.rotation(), v = b.linvel();
      if (v.x * v.x + v.y * v.y + v.z * v.z > 0.04) moving = true;
      // Fell through the world (a gap in the collision): stop here.
      if (t.y < -50) { this.finish(); return false; }
      const bone = pt.bone, par = bone.parent!;
      par.updateWorldMatrix(true, false);
      _q.set(r.x, r.y, r.z, r.w).multiply(pt.off);
      par.getWorldQuaternion(_q2);
      bone.quaternion.copy(_q2.invert().multiply(_q));
      if (!pt.seg.parent) bone.position.copy(par.worldToLocal(_p.set(t.x, t.y, t.z)));
      bone.updateMatrixWorld(true);
    }
    if (this.gun) {
      const b = this.gun.body, t = b.translation(), r = b.rotation();
      this.gun.obj.quaternion.set(r.x, r.y, r.z, r.w);
      this.gun.obj.position.set(t.x, t.y, t.z);
      this.gun.obj.updateMatrixWorld(true);
      const v = b.linvel(); if (v.x * v.x + v.y * v.y + v.z * v.z > 0.04) moving = true;
    }
    if ((this.t > 2.5 && !moving) || this.t > 9) { this.finish(); return false; }
    return true;
  }

  /** World position of the pelvis and the head (for placing the downed soldier's hit boxes). */
  spine(): { pelvis: V3; head: V3 } | null {
    const pv = this.parts.find((p) => p.seg.bone === 'pelvis'), hd = this.parts.find((p) => p.seg.bone === 'Head');
    if (!pv || !hd) return null;
    const a = pv.bone.getWorldPosition(_v), pel: V3 = [a.x, a.y, a.z], b = hd.bone.getWorldPosition(_v);
    return { pelvis: pel, head: [b.x, b.y, b.z] };
  }

  finish() {
    if (this.done) return;
    this.done = true;
    const w = this.P.world;
    // Frozen before it had settled (too many bodies falling at once, or the time limit) or resting propped up: let the
    // body down onto the floor under it, so no corpse is left hanging in the air.
    const pel = this.parts.find((p) => p.seg.bone === 'pelvis');
    if (pel) {
      let low = Infinity;
      for (const pt of this.parts) { const t = pt.body.translation(); low = Math.min(low, t.y - pt.seg.r); }
      const pv = pel.bone.getWorldPosition(new THREE.Vector3());
      const fl = this.P.castRay([pv.x, pv.y + 0.3, pv.z], [0, -1, 0], 6, G_WORLD);
      if (fl && low - fl.point[1] > 0.06) {
        pv.y -= Math.min(low - fl.point[1] - 0.02, 3);
        pel.bone.position.copy(pel.bone.parent!.worldToLocal(pv));
        pel.bone.updateMatrixWorld(true);
      }
    }
    for (const j of this.joints) w.removeImpulseJoint(j, false);
    for (const pt of this.parts) w.removeRigidBody(pt.body);
    if (this.gun) w.removeRigidBody(this.gun.body);
    this.joints = []; this.parts = []; this.gun = null;
  }
}

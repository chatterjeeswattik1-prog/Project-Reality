// Doors in the doorways of houses (after "Six Days in Fallujah": doorways are the fatal funnel). Each leaf swings on
// a hinge with a kinematic collider — it blocks movement, sight and (metal) bullets; wooden doors can be shot through.
// The player toggles the nearest door with E; bots push doors open as they walk up to them. They start closed, ajar
// or open at random. All leaves are drawn by two instanced meshes (wood, metal) and found through a grid, so the full map
// (thousands of doors) costs two draw calls and bots only look at the doors next to them.
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { City } from '../world/citygen';
import { G_WORLD, groups, type Physics } from '../world/physics';
import { tex } from '../core/assets';
import { mulberry } from '../core/rng';
import type { V3 } from './projectiles';

interface Door {
  hinge: THREE.Vector3; w: number; h: number; th: number; base: number; swing: 1 | -1;
  angle: number; target: number; body: RAPIER.RigidBody; metal: boolean; inst: number;
}
const CELL = 8;
const OPEN = Math.PI / 2 * 0.95;

export class Doors {
  list: Door[] = [];
  private q = new THREE.Quaternion(); private up = new THREE.Vector3(0, 1, 0);
  private grid = new Map<number, Door[]>();
  private im: { wood: THREE.InstancedMesh; metal: THREE.InstancedMesh } | null = null;
  private m4 = new THREE.Matrix4(); private sc = new THREE.Vector3();
  private key(x: number, z: number) { return (Math.floor(x / CELL) + 2048) * 4096 + (Math.floor(z / CELL) + 2048); }
  /** Doors whose hinge lies within ~r of (x, z). */
  private near(x: number, z: number, r: number): Door[] {
    const out: Door[] = [];
    for (let ix = Math.floor((x - r) / CELL); ix <= Math.floor((x + r) / CELL); ix++) for (let iz = Math.floor((z - r) / CELL); iz <= Math.floor((z + r) / CELL); iz++) {
      const l = this.grid.get((ix + 2048) * 4096 + (iz + 2048)); if (l) out.push(...l);
    }
    return out;
  }

  constructor(private P: Physics, scene: THREE.Scene, city: City, area?: { x0: number; z0: number; x1: number; z1: number }) {
    const rng = mulberry(9001);
    const wood = new THREE.MeshStandardMaterial({ map: tex('assets/tex/distressed_painted_planks/diff.jpg'), roughness: 0.85, color: 0xb8a890 });
    const metal = new THREE.MeshStandardMaterial({ map: tex('assets/tex/green_metal_rust/diff.jpg'), roughness: 0.6, metalness: 0.4, color: 0xa0a8a0 });
    const pending: Door[] = [];
    for (const b of city.buildings) {
      const c = [(b.spec.x0 + b.spec.x1) / 2, (b.spec.z0 + b.spec.z1) / 2];
      if (area && (c[0] < area.x0 || c[0] > area.x1 || c[1] < area.z0 || c[1] > area.z1)) continue;
      for (const d of b.doorways) {
        if (!d.exterior && rng() < 0.3) continue; // some inner doorways have no door
        // Only a doorway in a standing wall gets a leaf: wall on both sides of the opening and a lintel over it (battle
        // damage or a collapse next to it would leave a door hanging in the air).
        {
          const ax = d.axis === 'x' ? 1 : 0, az = 1 - ax, off = d.w / 2 + 0.2;
          const solidAt = (x: number, y: number, z: number) => !!P.boxAt(x, y, z);
          const ok = solidAt(d.x + ax * off, d.y + 1.0, d.z + az * off) && solidAt(d.x - ax * off, d.y + 1.0, d.z - az * off)
            && solidAt(d.x + ax * off, d.y + 1.9, d.z + az * off) && solidAt(d.x - ax * off, d.y + 1.9, d.z - az * off)
            && solidAt(d.x, d.y + d.h + 0.12, d.z);
          if (!ok) continue;
        }
        const isMetal = d.exterior && rng() < 0.45, w = d.w - 0.04, h = d.h - 0.03, th = isMetal ? 0.04 : 0.05;
        // Hinge at one end of the opening; the leaf lies along the wall axis when closed.
        const end = rng() < 0.5 ? -1 : 1, along = d.axis === 'x' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
        const hinge = new THREE.Vector3(d.x, d.y, d.z).addScaledVector(along, (end * d.w) / 2);
        // Closed: the leaf points from the hinge back across the opening.
        const base = Math.atan2(-along.x * end, -along.z * end) - Math.PI / 2;
        // Exterior doors swing inwards (towards the building centre); inner doors either way.
        const toC = new THREE.Vector3(c[0] - d.x, 0, c[1] - d.z), normal = d.axis === 'x' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
        const inward = Math.sign(toC.dot(normal)) || 1;
        const R = P.R, body = P.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(hinge.x, hinge.y, hinge.z));
        const col = P.world.createCollider(R.ColliderDesc.cuboid(w / 2, h / 2, th / 2).setTranslation(w / 2, h / 2, 0).setCollisionGroups(groups(G_WORLD, 0xffff)), body);
        P.surf.set(col.handle, isMetal ? 'metal' : 'wood');
        const roll = rng(), start = roll < 0.45 ? 0 : roll < 0.7 ? 0.5 + rng() * 0.4 : OPEN;
        const door: Door = { hinge, w, h, th, base, swing: 1, angle: start, target: start, body, metal: isMetal, inst: 0 };
        // Which way "open" turns: towards the inside for exterior doors.
        const test = this.leafDir(door, OPEN);
        door.swing = Math.sign(test.dot(normal)) === inward ? 1 : -1;
        pending.push(door);
      }
    }
    // Two instanced meshes: a unit box, hinge at its left edge, scaled per door.
    const unit = new THREE.BoxGeometry(1, 1, 1).translate(0.5, 0.5, 0);
    const mk = (mat: THREE.Material, n: number) => { const m = new THREE.InstancedMesh(unit, mat, Math.max(1, n)); m.name = 'door'; m.count = n; m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; scene.add(m); return m; };
    this.im = { wood: mk(wood, pending.filter((d) => !d.metal).length), metal: mk(metal, pending.filter((d) => d.metal).length) };
    let iw = 0, imt = 0;
    for (const d of pending) {
      d.inst = d.metal ? imt++ : iw++;
      this.list.push(d);
      const k = this.key(d.hinge.x, d.hinge.z); (this.grid.get(k) ?? this.grid.set(k, []).get(k)!).push(d);
      this.pose(d);
    }
    this.im.wood.instanceMatrix.needsUpdate = true; this.im.metal.instanceMatrix.needsUpdate = true;
    this.im.wood.computeBoundingSphere(); this.im.metal.computeBoundingSphere();
  }

  private leafDir(d: Door, a: number) { const yaw = d.base + d.swing * a; return new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw)); }
  private pose(d: Door) {
    this.q.setFromAxisAngle(this.up, d.base + d.swing * d.angle);
    if (this.im) {
      const im = d.metal ? this.im.metal : this.im.wood;
      im.setMatrixAt(d.inst, this.m4.compose(d.hinge, this.q, this.sc.set(d.w, d.h, d.th)));
      im.instanceMatrix.needsUpdate = true;
    }
    d.body.setNextKinematicTranslation(d.hinge); d.body.setNextKinematicRotation(this.q);
  }

  /** Toggle the door nearest the point within reach (player's E). Returns true if one was used. */
  use(p: V3, dir: V3): boolean {
    let best: Door | null = null, bd = 2.2;
    for (const d of this.near(p[0], p[2], 4)) {
      if (d.w <= 0) continue;
      const mid = d.hinge.clone().addScaledVector(this.leafDir(d, d.angle), d.w / 2);
      const dx = mid.x - p[0], dz = mid.z - p[2], dist = Math.hypot(dx, dz);
      if (Math.abs(mid.y + 1 - p[1]) > 2.2 || dist > bd) continue;
      if ((dx * dir[0] + dz * dir[2]) / (dist || 1) < 0.3 && dist > 0.8) continue;
      bd = dist; best = d;
    }
    if (!best) return false;
    best.target = best.target > 0.4 ? 0 : OPEN; this.moving.add(best);
    return true;
  }

  /** Bots: open any closed door right in front of them. */
  openNear(p: V3, vel: [number, number, number]) {
    const sp = Math.hypot(vel[0], vel[2]); if (sp < 0.3) return;
    for (const d of this.near(p[0], p[2], 3)) {
      if (d.target > 0.4 || d.w <= 0) continue;
      const mid = d.hinge.clone().addScaledVector(this.leafDir(d, 0), d.w / 2);
      const dx = mid.x - p[0], dz = mid.z - p[2], dist = Math.hypot(dx, dz);
      if (dist < 1.6 && Math.abs(mid.y - p[1]) < 1.5 && (dx * vel[0] + dz * vel[2]) / (dist * sp) > 0.2) { d.target = OPEN; this.moving.add(d); }
    }
  }

  /**
   * A blast at p: leaves within `r` are torn off, and so is any door whose wall or lintel has just been blown away.
   * Returns the boxes (min, max) of the removed leaves, for splinters.
   */
  blast(p: V3, r: number): { min: number[]; max: number[]; metal: boolean }[] {
    const out: { min: number[]; max: number[]; metal: boolean }[] = [];
    const solidAt = (x: number, y: number, z: number) => !!this.P.boxAt(x, y, z);
    for (const d of this.near(p[0], p[2], r + 4)) {
      if (d.w <= 0) continue;
      const dir = this.leafDir(d, 0), mid = d.hinge.clone().addScaledVector(dir, d.w / 2), c = mid.clone().addScaledVector(dir, 0);
      // The doorway's axis (along the wall) and the wall test from the constructor, against today's walls.
      const ax = Math.abs(dir.x), az = Math.abs(dir.z), off = d.w / 2 + 0.2;
      const standing = solidAt(c.x + ax * off, d.hinge.y + 1.0, c.z + az * off) && solidAt(c.x - ax * off, d.hinge.y + 1.0, c.z - az * off)
        && solidAt(c.x, d.hinge.y + d.h + 0.15, c.z);
      const near = Math.hypot(mid.x - p[0], d.hinge.y + d.h / 2 - p[1], mid.z - p[2]) < r;
      if (!near && standing) continue;
      this.P.world.removeRigidBody(d.body);
      d.w = 0; this.moving.delete(d);
      const im = d.metal ? this.im!.metal : this.im!.wood;
      im.setMatrixAt(d.inst, this.m4.makeScale(0, 0, 0)); im.instanceMatrix.needsUpdate = true;
      const e = d.h / 2;
      out.push({ min: [mid.x - 0.5, d.hinge.y, mid.z - 0.5], max: [mid.x + 0.5, d.hinge.y + e * 2, mid.z + 0.5], metal: d.metal });
    }
    return out;
  }

  /** Doors swinging right now (only these are updated). */
  private moving = new Set<Door>();
  update(dt: number) {
    for (const d of this.moving) {
      if (Math.abs(d.target - d.angle) < 1e-3) { this.moving.delete(d); continue; }
      d.angle += Math.sign(d.target - d.angle) * Math.min(Math.abs(d.target - d.angle), dt * 2.6);
      this.pose(d);
    }
  }
}

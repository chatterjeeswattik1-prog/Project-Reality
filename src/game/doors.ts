// Doors in the doorways of houses (after "Six Days in Fallujah": doorways are the fatal funnel). Each leaf swings on
// a hinge with a kinematic collider — it blocks movement, sight and (metal) bullets; wooden doors can be shot through.
// The player toggles the nearest door with E; bots push doors open as they walk up to them. They start closed, ajar
// or open at random.
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { City } from '../world/citygen';
import { G_WORLD, groups, type Physics } from '../world/physics';
import { tex } from '../core/assets';
import { mulberry } from '../core/rng';
import type { V3 } from './projectiles';

interface Door {
  hinge: THREE.Vector3; w: number; h: number; base: number; swing: 1 | -1;
  angle: number; target: number; mesh: THREE.Mesh; body: RAPIER.RigidBody; metal: boolean;
}
const OPEN = Math.PI / 2 * 0.95;

export class Doors {
  list: Door[] = [];
  private q = new THREE.Quaternion(); private up = new THREE.Vector3(0, 1, 0);

  constructor(P: Physics, scene: THREE.Scene, city: City, area?: { x0: number; z0: number; x1: number; z1: number }) {
    const rng = mulberry(9001);
    const wood = new THREE.MeshStandardMaterial({ map: tex('assets/tex/distressed_painted_planks/diff.jpg'), roughness: 0.85, color: 0xb8a890 });
    const metal = new THREE.MeshStandardMaterial({ map: tex('assets/tex/green_metal_rust/diff.jpg'), roughness: 0.6, metalness: 0.4, color: 0xa0a8a0 });
    for (const b of city.buildings) {
      const c = [(b.spec.x0 + b.spec.x1) / 2, (b.spec.z0 + b.spec.z1) / 2];
      if (area && (c[0] < area.x0 || c[0] > area.x1 || c[1] < area.z0 || c[1] > area.z1)) continue;
      for (const d of b.doorways) {
        if (!d.exterior && rng() < 0.3) continue; // some inner doorways have no door
        const isMetal = d.exterior && rng() < 0.45, w = d.w - 0.04, h = d.h - 0.03, th = isMetal ? 0.04 : 0.05;
        // Hinge at one end of the opening; the leaf lies along the wall axis when closed.
        const end = rng() < 0.5 ? -1 : 1, along = d.axis === 'x' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
        const hinge = new THREE.Vector3(d.x, d.y, d.z).addScaledVector(along, (end * d.w) / 2);
        // Closed: the leaf points from the hinge back across the opening.
        const base = Math.atan2(-along.x * end, -along.z * end) - Math.PI / 2;
        // Exterior doors swing inwards (towards the building centre); inner doors either way.
        const toC = new THREE.Vector3(c[0] - d.x, 0, c[1] - d.z), normal = d.axis === 'x' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
        const inward = Math.sign(toC.dot(normal)) || 1;
        const geo = new THREE.BoxGeometry(w, h, th).translate(w / 2, h / 2, 0);
        const mesh = new THREE.Mesh(geo, isMetal ? metal : wood); mesh.castShadow = true; mesh.receiveShadow = true;
        scene.add(mesh);
        const R = P.R, body = P.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(hinge.x, hinge.y, hinge.z));
        const col = P.world.createCollider(R.ColliderDesc.cuboid(w / 2, h / 2, th / 2).setTranslation(w / 2, h / 2, 0).setCollisionGroups(groups(G_WORLD, 0xffff)), body);
        P.surf.set(col.handle, isMetal ? 'metal' : 'wood');
        const roll = rng(), start = roll < 0.45 ? 0 : roll < 0.7 ? 0.5 + rng() * 0.4 : OPEN;
        const door: Door = { hinge, w, h, base, swing: 1, angle: start, target: start, mesh, body, metal: isMetal };
        // Which way "open" turns: towards the inside for exterior doors.
        const test = this.leafDir(door, OPEN);
        door.swing = Math.sign(test.dot(normal)) === inward ? 1 : -1;
        this.list.push(door);
        this.pose(door);
      }
    }
  }

  private leafDir(d: Door, a: number) { const yaw = d.base + d.swing * a; return new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw)); }
  private pose(d: Door) {
    this.q.setFromAxisAngle(this.up, d.base + d.swing * d.angle);
    d.mesh.position.copy(d.hinge); d.mesh.quaternion.copy(this.q);
    d.body.setNextKinematicTranslation(d.hinge); d.body.setNextKinematicRotation(this.q);
  }

  /** Toggle the door nearest the point within reach (player's E). Returns true if one was used. */
  use(p: V3, dir: V3): boolean {
    let best: Door | null = null, bd = 2.2;
    for (const d of this.list) {
      const mid = d.hinge.clone().addScaledVector(this.leafDir(d, d.angle), d.w / 2);
      const dx = mid.x - p[0], dz = mid.z - p[2], dist = Math.hypot(dx, dz);
      if (Math.abs(mid.y + 1 - p[1]) > 2.2 || dist > bd) continue;
      if ((dx * dir[0] + dz * dir[2]) / (dist || 1) < 0.3 && dist > 0.8) continue;
      bd = dist; best = d;
    }
    if (!best) return false;
    best.target = best.target > 0.4 ? 0 : OPEN;
    return true;
  }

  /** Bots: open any closed door right in front of them. */
  openNear(p: V3, vel: [number, number, number]) {
    const sp = Math.hypot(vel[0], vel[2]); if (sp < 0.3) return;
    for (const d of this.list) {
      if (d.target > 0.4) continue;
      const mid = d.hinge.clone().addScaledVector(this.leafDir(d, 0), d.w / 2);
      const dx = mid.x - p[0], dz = mid.z - p[2], dist = Math.hypot(dx, dz);
      if (dist < 1.6 && Math.abs(mid.y - p[1]) < 1.5 && (dx * vel[0] + dz * vel[2]) / (dist * sp) > 0.2) d.target = OPEN;
    }
  }

  update(dt: number) {
    for (const d of this.list) {
      if (Math.abs(d.target - d.angle) < 1e-3) continue;
      d.angle += Math.sign(d.target - d.angle) * Math.min(Math.abs(d.target - d.angle), dt * 2.6);
      this.pose(d);
    }
  }
}

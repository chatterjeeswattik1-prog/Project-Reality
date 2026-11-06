// Insurgent anti-armour (after PR's insurgency layers): command-wire IEDs on the approaches, set off by a triggerman
// watching from a house when a vehicle (or a group on foot) is on top of them; and 9M113 Konkurs ATGM teams on roofs
// at the eastern edge of the town, covering the farmland the armour must cross. The ATGM gunner keeps his sight on
// the target for the whole flight (SACLOS): kill him or blind him with smoke and the missile flies off.
import * as THREE from 'three';
import type { Game } from '../game/game';
import type { Soldier } from '../game/soldier';
import type { V3 } from '../game/projectiles';
import { AMMO } from '../game/data/weapons';
import type { Vehicle } from '../vehicles/vehicle';
import { G_WORLD } from '../world/physics';

export interface Ied { p: V3; trigger: Soldier | null; spent: boolean; spotted: boolean; mesh: THREE.Object3D }
export interface AtgmSite { p: V3; yaw: number; gunner: Soldier | null; missiles: number; reloadT: number; mesh: THREE.Group; tube: THREE.Object3D; target: Vehicle | null; trackT: number; destroyed: boolean }

export class InsurgentAT {
  ieds: Ied[] = [];
  sites: AtgmSite[] = [];
  constructor(private g: Game) {}

  /** A buried command-wire IED (a 155 mm shell under a pile of rubbish beside the road). */
  addIed(p: V3) {
    const m = new THREE.Mesh(new THREE.DodecahedronGeometry(0.55, 0), new THREE.MeshStandardMaterial({ color: 0x5a5148, roughness: 1 }));
    m.scale.set(1.3, 0.35, 1); m.position.set(p[0], p[1] + 0.05, p[2]); m.rotation.y = Math.random() * 6;
    m.castShadow = true; this.g.gfx.scene.add(m);
    const ied: Ied = { p, trigger: null, spent: false, spotted: false, mesh: m };
    this.ieds.push(ied);
    return ied;
  }

  /** A Konkurs launcher on its tripod (9P135), facing `yaw`. */
  addSite(p: V3, yaw: number): AtgmSite {
    const grp = new THREE.Group(), dark = new THREE.MeshStandardMaterial({ color: 0x3d4234, roughness: 0.8, metalness: 0.3 });
    const legG = new THREE.CylinderGeometry(0.02, 0.02, 1.4, 5);
    for (let i = 0; i < 3; i++) { const l = new THREE.Mesh(legG, dark); const a = i * 2.1; l.position.set(Math.sin(a) * 0.25, 0.65, Math.cos(a) * 0.25); l.rotation.set(Math.cos(a) * 0.45, 0, -Math.sin(a) * 0.45); grp.add(l); }
    const tube = new THREE.Group(); tube.position.y = 1.3; // raised over the roof parapet
    const t = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 1.25, 10).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x55603f, roughness: 0.7 }));
    const sight = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.18, 0.3), dark); sight.position.set(0.16, 0.05, 0.2);
    tube.add(t, sight); grp.add(tube);
    grp.position.set(p[0], p[1], p[2]); grp.rotation.y = yaw;
    grp.traverse((o) => { (o as THREE.Mesh).castShadow = true; });
    this.g.gfx.scene.add(grp);
    const s: AtgmSite = { p, yaw, gunner: null, missiles: 4, reloadT: 0, mesh: grp, tube, target: null, trackT: 0, destroyed: false };
    this.sites.push(s);
    return s;
  }

  update(dt: number) {
    const g = this.g;
    // IEDs: the triggerman (alive, within ~250 m and able to see it) sets it off under a vehicle, or a group on foot.
    for (const d of this.ieds) {
      if (d.spent) continue;
      const tm = d.trigger;
      if (!tm?.alive || Math.hypot(tm.pos[0] - d.p[0], tm.pos[2] - d.p[2]) > 260) continue;
      const veh = g.vehicles.find((v) => !v.dead && v.team !== tm.team && Math.hypot(v.pos()[0] - d.p[0], v.pos()[2] - d.p[2]) < 6);
      const foot = g.soldiers.filter((s) => s.team !== tm.team && s.alive && !s.vehicle && Math.hypot(s.pos[0] - d.p[0], s.pos[2] - d.p[2]) < 5).length;
      // He watches from his post (or a spotter does): alive and in range is enough (command wire).
      if (veh || foot >= 2) {
        d.spent = true; g.gfx.scene.remove(d.mesh);
        g.explode([d.p[0], d.p[1] + 0.2, d.p[2]], AMMO.ied, tm, [0, 1, 0]);
      }
      // Spotted by infantry close by (a fresh mound beside the road): marked; vehicles steer round it.
      if (!d.spotted) for (const s of g.soldiers) if (s.team !== tm.team && s.alive && !s.vehicle && Math.hypot(s.pos[0] - d.p[0], s.pos[2] - d.p[2]) < 9 && Math.random() < dt * 0.3) { d.spotted = true; g.mode?.say(`IED spotted at the roadside — vehicles keep clear!`, 'us'); break; }
    }
    // ATGM sites.
    for (const st of this.sites) {
      if (st.destroyed) continue;
      // A blast close to the launcher wrecks it.
      const gn = st.gunner, manned = !!gn?.alive && Math.hypot(gn.pos[0] - st.p[0], gn.pos[2] - st.p[2]) < 4;
      st.reloadT -= dt;
      if (!manned || st.missiles <= 0) { st.target = null; continue; }
      const eye: V3 = [st.p[0], st.p[1] + 1.45, st.p[2]]; // the sight over the parapet
      // Target: the nearest enemy vehicle in view within 3.5 km (not hidden by smoke).
      if (!st.target || st.target.dead || !this.sees(eye, st.target)) {
        st.target = null;
        let bd = 3500;
        for (const v of g.vehicles) { if (v.dead || v.team === gn!.team) continue; const p = v.pos(), d = Math.hypot(p[0] - eye[0], p[2] - eye[2]); if (d < bd && d > 150 && this.sees(eye, v)) { bd = d; st.target = v; } }
        st.trackT = 0;
      }
      const T = st.target; if (!T) continue;
      const tp = T.pos(), dx = tp[0] - eye[0], dz = tp[2] - eye[2];
      const yaw = Math.atan2(-dx, -dz) - st.yaw; st.tube.rotation.y += Math.atan2(Math.sin(yaw - st.tube.rotation.y), Math.cos(yaw - st.tube.rotation.y)) * Math.min(1, dt * 2);
      gn!.yaw = Math.atan2(-dx, -dz);
      st.trackT += dt;
      // Lay on for a few seconds, then launch (one in the air at a time).
      if (st.trackT > 4 && st.reloadT <= 0 && !g.proj.bullets.some((b) => b.owner === gn && b.ammo.id === '9m113')) {
        st.missiles--; st.reloadT = 25; st.trackT = 0;
        const L = Math.hypot(dx, tp[1] + 1.4 - eye[1], dz), d: V3 = [dx / L, (tp[1] + 1.4 - eye[1]) / L + 0.03, dz / L];
        g.proj.fire(gn!, null, '9m113', [eye[0] + d[0] * 0.8, eye[1] + d[1] * 0.8, eye[2] + d[2] * 0.8], d, false, (p) => {
          // Wire guidance: the gunner keeps the cross on the hull; he has to be alive and see it.
          if (!gn!.alive || T.dead || !this.sees(eye, T)) return null;
          const q = T.pos(); void p; return [q[0], q[1] + 1.3, q[2]];
        });
        g.fx.muzzle(eye, d, 1.6, false);
        g.audio.play('rpg_launch', eye, { range: 1500, gain: 1.1, rate: 0.8 });
        T.ai?.warn(eye);
        g.mode?.say('ATGM launch!', 'us');
      }
    }
  }

  private sees(eye: V3, v: Vehicle) { const p = v.pos(), c: V3 = [p[0], p[1] + 1.5, p[2]]; return this.g.P.clear(eye, c, G_WORLD) && !this.g.smokeBlocks(eye, c); }

  /** A blast wrecks a launcher within 4 m. */
  blast(p: V3) { for (const st of this.sites) if (!st.destroyed && Math.hypot(st.p[0] - p[0], st.p[1] - p[1], st.p[2] - p[2]) < 4) { st.destroyed = true; st.mesh.rotation.z = 1.2; st.mesh.position.y -= 0.3; } }
}

// Blood as a liquid, drawn with a liquid puddle model (models/fx/blood_spot.glb, CC0: an irregular spot whose normal
// map carries the rounded, surface-tension edge and the slight dome of a puddle), glossy and deep red.
//  Pools: a body bleeds into a puddle under the wound that grows as it fills; when it is full, the blood runs on from
//   its rim — downhill where the ground falls, otherwise wherever the surface leads — as a chain of further puddles
//   that fill one after another, each smaller, so a stream visibly flows away from the body and then stops (blood is
//   sticky: it does not run on as water would). Puddles never run over a ledge or up a step. They darken and dull as
//   they dry.
//  Drops: spray landing on a surface sits as small beads (the same spot, small). On a wall the heavier ones run down:
//   one bead stretched downwards as it goes, slowing as it leaves blood behind, then stopping.
import * as THREE from 'three';
import { gltf } from '../core/assets';

type V3 = [number, number, number];

interface Lobe { i: number; p: V3; r: number; R: number; rot: number; t: number; tau: number; next?: { dir: [number, number]; left: number }; pool: Pool }
interface Pool { y: number; age: number; lobes: Lobe[]; litres: number; dirFall: [number, number] | null }
interface Runner { i: number; p0: V3; n: V3; r: number; run: number; v: number }

const MAX_LOBES = 420, MAX_BEADS = 1200, MAX_RUNS = 260;
const RED = new THREE.Color(0x4a0503), DRY = new THREE.Color(0x1c0604);
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _c = new THREE.Color();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);

/** Puddle mesh normalised to 1 m across (X, Z) and 1 m thick (Y), standing on its base at the origin. */
async function blobGeometry(): Promise<{ geo: THREE.BufferGeometry; normal: THREE.Texture | null } | null> {
  const g = await gltf('models/fx/blood_spot.glb'); if (!g) return null;
  let mesh: THREE.Mesh | null = null; g.scene.updateMatrixWorld(true);
  g.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh && !mesh) mesh = o as THREE.Mesh; });
  if (!mesh) return null;
  const m = mesh as THREE.Mesh, geo = m.geometry.clone().applyMatrix4(m.matrixWorld);
  geo.computeBoundingBox(); const b = geo.boundingBox!, sz = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3());
  geo.translate(-c.x, -b.min.y, -c.z);
  geo.scale(1 / Math.max(sz.x, sz.z), 1 / Math.max(1e-4, sz.y), 1 / Math.max(sz.x, sz.z));
  for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv', 'tangent'].includes(k)) geo.deleteAttribute(k);
  const normal = (m.material as THREE.MeshStandardMaterial).normalMap ?? null;
  return { geo, normal };
}

export class LiquidBlood {
  private lobes: THREE.InstancedMesh | null = null; private lobeN = 0;
  private beads: THREE.InstancedMesh | null = null; private beadN = 0;
  private runs: THREE.InstancedMesh | null = null; private runN = 0;
  private live: Lobe[] = []; private pools: Pool[] = [];
  private runners: Runner[] = [];
  private queue: (() => void)[] = [];

  constructor(private scene: THREE.Scene, private floorAt: (p: V3) => number | null, private surfaceAt: (o: V3, d: V3, len: number) => { dist: number; normal: V3 } | null) {
    void blobGeometry().then((b) => {
      if (!b) return;
      // Wet blood: deep red, very smooth, the reflection tinted warm (blue sky mirrored in dark red reads purple).
      const mat = new THREE.MeshPhysicalMaterial({
        color: 0xffffff, roughness: 0.07, metalness: 0, normalMap: b.normal, normalScale: new THREE.Vector2(1, 1),
        specularColor: new THREE.Color(1, 0.62, 0.55), specularIntensity: 1, envMapIntensity: 0.55, ior: 1.36,
        polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
      });
      const mk = (n: number) => { const im = new THREE.InstancedMesh(b.geo, mat, n); im.count = 0; im.frustumCulled = false; im.receiveShadow = true; im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3); this.scene.add(im); return im; };
      this.lobes = mk(MAX_LOBES); this.beads = mk(MAX_BEADS); this.runs = mk(MAX_RUNS);
      for (const f of this.queue) f(); this.queue = [];
    });
  }

  private set(im: THREE.InstancedMesh, i: number, p: V3, n: V3, w: number, l: number, h: number, rot: number, down?: THREE.Vector3) {
    // Basis: local Y along the surface normal; local Z along `down` (a run) or turned by `rot` about the normal.
    _y.set(n[0], n[1], n[2]).normalize();
    if (down) _z.copy(down);
    else { _z.set(0, 0, 1); if (Math.abs(_y.z) > 0.9) _z.set(1, 0, 0); _z.addScaledVector(_y, -_z.dot(_y)).normalize().applyAxisAngle(_y, rot); }
    _z.addScaledVector(_y, -_z.dot(_y)).normalize();
    _x.crossVectors(_y, _z);
    _m.makeBasis(_x, _y, _z); _q.setFromRotationMatrix(_m);
    _m.compose(_p.set(p[0], p[1], p[2]), _q, _s.set(w, h, l));
    im.setMatrixAt(i, _m); im.instanceMatrix.needsUpdate = true;
  }
  private tint(im: THREE.InstancedMesh, i: number, dry: number) { im.setColorAt(i, _c.copy(RED).lerp(DRY, dry)); im.instanceColor!.needsUpdate = true; }

  // ---------------- pools ----------------
  /** A body bleeding out at p (on the ground): `litres` of blood (≈1 dead, less wounded). */
  pool(p: V3, litres: number) {
    if (!this.lobes) { this.queue.push(() => this.pool(p, litres)); return; }
    const y = this.floorAt([p[0], p[1] + 0.4, p[2]]) ?? p[1];
    // Fall of the ground (probes 40 cm round the body): the stream follows it.
    const h = (dx: number, dz: number) => this.floorAt([p[0] + dx, y + 0.4, p[2] + dz]) ?? y;
    const gx = h(-0.4, 0) - h(0.4, 0), gz = h(0, -0.4) - h(0, 0.4), fall = Math.hypot(gx, gz);
    const P: Pool = { y, age: 0, lobes: [], litres, dirFall: fall > 0.008 ? [gx / fall, gz / fall] : null };
    this.pools.push(P); if (this.pools.length > 40) this.pools.shift();
    // The puddle under the wound, about 0.5–0.7 m across when a litre has run into it.
    const R = 0.22 + 0.22 * Math.min(1.5, litres);
    const a = P.dirFall ? Math.atan2(P.dirFall[1], P.dirFall[0]) + (Math.random() - 0.5) * 0.8 : Math.random() * Math.PI * 2;
    this.addLobe(P, [p[0], y, p[2]], R, 7, { dir: [Math.cos(a), Math.sin(a)], left: 2 + Math.floor(Math.random() * 3) + (P.dirFall ? 2 : 0) });
    // A second puddle beside it (blood comes from more than one point of a body).
    const b = Math.random() * Math.PI * 2;
    this.addLobe(P, [p[0] + Math.cos(b) * R * 0.45, y, p[2] + Math.sin(b) * R * 0.45], R * 0.7, 9);
  }
  private addLobe(P: Pool, p: V3, R: number, tau: number, next?: Lobe['next']) {
    const i = this.lobeN % MAX_LOBES; this.lobeN++;
    this.live = this.live.filter((l) => l.i !== i);
    const L: Lobe = { i, p, r: 0.02, R, rot: Math.random() * Math.PI * 2, t: 0, tau, next, pool: P };
    P.lobes.push(L); this.live.push(L);
    this.lobes!.count = Math.min(MAX_LOBES, this.lobeN);
    this.tint(this.lobes!, i, 0);
  }

  // ---------------- drops ----------------
  /** A drop of radius r (m) landing on a surface with normal n: a bead; on a wall a heavy one runs down. */
  bead(p: V3, n: V3, r: number) {
    if (!this.beads || !this.runs) return;
    if (Math.abs(n[1]) < 0.55 && r > 0.0045 && Math.random() < 0.7) {
      const i = this.runN % MAX_RUNS; this.runN++;
      this.runners = this.runners.filter((b) => b.i !== i);
      this.runners.push({ i, p0: [...p] as V3, n: [...n] as V3, r, run: 0, v: 0.02 + r * 6 });
      this.runs.count = Math.min(MAX_RUNS, this.runN); this.tint(this.runs, i, 0);
      return;
    }
    const i = this.beadN % MAX_BEADS; this.beadN++;
    const o = 0.0008;
    this.set(this.beads, i, [p[0] + n[0] * o, p[1] + n[1] * o, p[2] + n[2] * o], n, r * 2.4, r * 2.4, Math.min(0.004, r * 0.5), Math.random() * Math.PI * 2);
    this.beads.count = Math.min(MAX_BEADS, this.beadN); this.tint(this.beads, i, 0);
  }
  /** Spray hitting a surface: a cluster of drops (most small), scattered along it. */
  spatter(p: V3, n: V3, amount: number) {
    const cnt = Math.round(5 + amount * 18);
    const nv = new THREE.Vector3(n[0], n[1], n[2]).normalize(), t1 = new THREE.Vector3().crossVectors(nv, Math.abs(nv.y) < 0.9 ? _up : new THREE.Vector3(1, 0, 0)).normalize(), t2 = new THREE.Vector3().crossVectors(nv, t1);
    const ns: V3 = [nv.x, nv.y, nv.z], sx = 0.6 + Math.random() * 0.8, sy = 0.6 + Math.random() * 0.8, span = amount * 0.35 + 1e-3;
    for (let k = 0; k < cnt; k++) {
      const a = Math.random() * Math.PI * 2, d = Math.pow(Math.random(), 1.6) * span;
      const q: V3 = [p[0] + (t1.x * Math.cos(a) * sx + t2.x * Math.sin(a) * sy) * d, p[1] + (t1.y * Math.cos(a) * sx + t2.y * Math.sin(a) * sy) * d, p[2] + (t1.z * Math.cos(a) * sx + t2.z * Math.sin(a) * sy) * d];
      this.bead(q, ns, (0.002 + Math.random() * 0.005) * (1 + 1.6 * (1 - d / span)) * (0.7 + amount * 0.5));
    }
  }

  update(dt: number) {
    if (!this.lobes || !this.beads || !this.runs) return;
    // Puddles filling; a full one spills on from its rim (the stream), each further puddle smaller.
    for (let k = this.live.length - 1; k >= 0; k--) {
      const L = this.live[k];
      L.t += dt;
      const f = 1 - Math.exp(-L.t / L.tau);
      L.r = Math.max(0.02, L.R * f);
      const th = Math.min(0.0045, 0.0015 + L.r * 0.006);
      this.set(this.lobes, L.i, [L.p[0], L.p[1] + 0.0015, L.p[2]], [0, 1, 0], L.r * 2, L.r * 2, th, L.rot);
      if (L.next && L.next.left > 0 && f > 0.55) {
        const nx = L.next;
        // Next puddle at the rim, along the stream (bending a little; downhill pulls it back on line).
        let a = Math.atan2(nx.dir[1], nx.dir[0]) + (Math.random() - 0.5) * 0.7;
        const fl = L.pool.dirFall; if (fl) a = a * 0.5 + Math.atan2(fl[1], fl[0]) * 0.5;
        const R2 = L.R * (0.55 + Math.random() * 0.15), d = L.R * 0.75 + R2 * 0.55;
        const q: V3 = [L.p[0] + Math.cos(a) * d, L.p[1], L.p[2] + Math.sin(a) * d];
        const fy = this.floorAt([q[0], L.p[1] + 0.3, q[2]]);
        // It runs on only over the same floor: not over a ledge, not up a step or into a wall.
        if (fy !== null && Math.abs(fy - L.p[1]) < 0.04 && R2 > 0.04) this.addLobe(L.pool, [q[0], fy, q[2]], R2, 3 + Math.random() * 2, { dir: [Math.cos(a), Math.sin(a)], left: nx.left - 1 });
        L.next = undefined;
      }
      if (f > 0.995 && !L.next) this.live.splice(k, 1);
    }
    // Drying: darker and duller over ~4 minutes (by pool, every 5 s).
    for (const P of this.pools) {
      P.age += dt;
      if (P.age < 300 && Math.floor(P.age / 5) !== Math.floor((P.age - dt) / 5)) for (const L of P.lobes) this.tint(this.lobes, L.i, Math.min(1, P.age / 240));
    }
    // Runs down walls: the drop stretches downwards as it goes, slowing as blood is left behind, and stops.
    for (let k = this.runners.length - 1; k >= 0; k--) {
      const b = this.runners[k], n = b.n;
      const down = new THREE.Vector3(0, -1, 0).addScaledVector(_y.set(n[0], n[1], n[2]), n[1]).normalize();
      b.run += b.v * dt; b.v *= Math.exp(-dt * 0.9);
      const len = b.run + b.r * 2.4, o = 0.0008;
      const mid: V3 = [b.p0[0] + down.x * (b.run / 2) + n[0] * o, b.p0[1] + down.y * (b.run / 2) + n[1] * o, b.p0[2] + down.z * (b.run / 2) + n[2] * o];
      this.set(this.runs, b.i, mid, n, b.r * 2.2 * (1 - Math.min(0.4, b.run * 0.8)), len, Math.min(0.004, b.r * 0.5), 0, down);
      const tip: V3 = [b.p0[0] + down.x * b.run, b.p0[1] + down.y * b.run, b.p0[2] + down.z * b.run];
      const on = this.surfaceAt([tip[0] + n[0] * 0.02, tip[1] + n[1] * 0.02, tip[2] + n[2] * 0.02], [-n[0], -n[1], -n[2]], 0.05);
      if (!on || b.v < 0.003 || b.run > 0.6) this.runners.splice(k, 1);
    }
  }
}

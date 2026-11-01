// Blood as a liquid, not a painted decal.
//  Pools: a thin-film flow simulation on a small height-field grid laid over the real ground under the body. Blood is
//   fed in at the wound and flows down the gradient of its surface (ground height + depth) with a lubrication-law
//   mobility (∝ depth³). A yield depth makes it sticky: once the film thins to ~1–2 mm it stops spreading and stays put,
//   as blood does, so a pool grows to a ragged, finite size, runs downhill on a slope, gathers in dips and stops at
//   ledges and walls. It is drawn as a real surface: the grid displaced by the depth, normals from the surface gradient
//   (the rounded edge catches the light like a meniscus), colour by thickness (thin film brighter red, deep pool almost
//   black-red), glossy and clear-coated; it darkens and dulls as it dries.
//  Beads: drops of the spray that land are glossy liquid beads sitting on the surface. On a wall the bigger ones creep
//   down, slowing as they leave a wet streak behind them, and stop when they have run out — blood is sticky, it does not
//   stream like water.
import * as THREE from 'three';

type V3 = [number, number, number];

/** Pool grid: cells per side and cell size (m) → 1.6 m square (2.5 cm cells keep the edge crisp). */
const N = 64, C = 0.025;
/** Effective thin-film constant ρg / (3μ_eff), with μ_eff well above blood's 4 mPa·s: surface tension, the ground
 *  soaking it up and clotting make a real pool spread over tens of seconds, not instantly (approximate, tuned). */
const K = 30000;
/** Depth (m) below which the film no longer flows (pinning / yield: what makes it sticky). */
const H_YIELD = 0.0008;
const SIM_DT = 1 / 30;

interface Pool {
  mesh: THREE.Mesh; geo: THREE.BufferGeometry; mat: THREE.MeshPhysicalMaterial;
  x0: number; z0: number; y0: number;
  /** Ground height (relative to y0) per cell; NaN = no floor / drop-off (liquid that reaches it is lost over the edge);
   *  `wall` = blocked (a step up or a wall). */
  z: Float32Array; wall: Uint8Array; h: Float32Array;
  src: { i: number; w: number }[]; vol: number; fed: number; t: number; tau: number;
  acc: number; quiet: number; settled: boolean; dryT: number;
  /** Cells the flow step covers: [i0, i1, j0, j1]. */ bb: [number, number, number, number];
}

interface Bead { i: number; p: V3; n: V3; r: number; run: number; v: number; trailAcc: number }

const MAX_POOLS = 14, MAX_BEADS = 900, MAX_TRAIL = 2500;
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _n = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);

export class LiquidBlood {
  private pools: Pool[] = [];
  /** Scratch buffers for a flow step (outflow per cell, depth change). */
  private out = new Float32Array(N * N); private dh = new Float32Array(N * N);
  private beads: THREE.InstancedMesh; private beadN = 0;
  /** Wet streaks left by beads running down walls. */
  private trail: THREE.InstancedMesh; private trailN = 0;
  private runners: Bead[] = [];

  /** floorAt: height of the walkable surface below a point (or null); wallAt: is there a surface along a ray. */
  constructor(private scene: THREE.Scene, private floorAt: (p: V3) => number | null, private surfaceAt: (o: V3, d: V3, len: number) => { dist: number; normal: V3 } | null) {
    const mat = new THREE.MeshPhysicalMaterial({ color: 0x3a0302, roughness: 0.1, metalness: 0, specularColor: new THREE.Color(1, 0.62, 0.55), envMapIntensity: 0.8, ior: 1.36 });
    this.beads = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 12, 8), mat, MAX_BEADS);
    this.beads.count = 0; this.beads.frustumCulled = false; this.beads.receiveShadow = true;
    scene.add(this.beads);
    this.trail = new THREE.InstancedMesh(this.beads.geometry, mat, MAX_TRAIL);
    this.trail.count = 0; this.trail.frustumCulled = false; this.trail.receiveShadow = true;
    scene.add(this.trail);
  }

  // ---------------- pools ----------------
  /** A body bleeding out at p (on the ground): `litres` of blood fed in over ~τ seconds. */
  pool(p: V3, litres: number, tau = 7) {
    const x0 = p[0] - (N * C) / 2, z0 = p[2] - (N * C) / 2, y0 = p[1];
    // Ground under the grid from a 9 × 9 lattice of probes (bilinear between them); a cell whose probe finds a floor
    // more than 6 cm above the body's floor is a wall / step, one more than 30 cm below (or none) is a drop-off.
    const M = 9, lat = new Float32Array(M * M), span = N * C;
    for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) {
      const f = this.floorAt([x0 + (i / (M - 1)) * span, y0 + 0.5, z0 + (j / (M - 1)) * span]);
      lat[j * M + i] = f === null ? NaN : f - y0;
    }
    const z = new Float32Array(N * N), wall = new Uint8Array(N * N), h = new Float32Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const u = ((i + 0.5) / N) * (M - 1), v = ((j + 0.5) / N) * (M - 1), iu = Math.min(M - 2, Math.floor(u)), iv = Math.min(M - 2, Math.floor(v)), fu = u - iu, fv = v - iv;
      const a = lat[iv * M + iu], b = lat[iv * M + iu + 1], c = lat[(iv + 1) * M + iu], d = lat[(iv + 1) * M + iu + 1];
      const near = lat[Math.round(v) * M + Math.round(u)];
      const k = j * N + i;
      if (Number.isNaN(near) || near < -0.3) { z[k] = NaN; continue; }
      if (near > 0.06) { wall[k] = 1; z[k] = near; continue; }
      const ok = [a, b, c, d].every((x) => !Number.isNaN(x) && Math.abs(x) < 0.06);
      z[k] = ok ? (a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + d * fu) * fv : near;
    }
    // Ground texture: no floor is flat at the millimetre scale. A few octaves of value noise (±1.5 mm) give the blood
    // channels to run along and bumps to go round, so the pool fingers out raggedly instead of growing as a disc
    // (approximate: ±3 mm).
    const seed = Math.random() * 1000, hash = (a: number, b: number) => { const x = Math.sin(a * 127.1 + b * 311.7 + seed) * 43758.5453; return x - Math.floor(x); };
    const vn = (x: number, y: number) => { const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy); return (hash(ix, iy) * (1 - sx) + hash(ix + 1, iy) * sx) * (1 - sy) + (hash(ix, iy + 1) * (1 - sx) + hash(ix + 1, iy + 1) * sx) * sy; };
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i; if (wall[k] || Number.isNaN(z[k])) continue;
      z[k] += ((vn(i / 10, j / 10) - 0.5) * 0.004 + (vn(i / 4, j / 4) - 0.5) * 0.002 + (vn(i / 2, j / 2) - 0.5) * 0.0008);
    }
    // Fed in round the centre (the chest), a few cells wide.
    const src: { i: number; w: number }[] = []; let ws = 0;
    for (let j = -4; j <= 4; j++) for (let i = -4; i <= 4; i++) {
      const k = (N / 2 + j) * N + (N / 2 + i), w = Math.exp(-(i * i + j * j) / 7);
      if (!wall[k] && !Number.isNaN(z[k])) { src.push({ i: k, w }); ws += w; }
    }
    for (const s of src) s.w /= ws;
    // Surface mesh: one vertex per cell.
    const geo = new THREE.BufferGeometry(), pos = new Float32Array(N * N * 3), nor = new Float32Array(N * N * 3), col = new Float32Array(N * N * 4);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const k = j * N + i; pos[k * 3] = (i + 0.5) * C; pos[k * 3 + 1] = Number.isNaN(z[k]) ? -1 : z[k]; pos[k * 3 + 2] = (j + 0.5) * C; nor[k * 3 + 1] = 1; }
    const idx: number[] = [];
    for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) { const a = j * N + i, b = a + 1, c = a + N, d = c + 1; idx.push(a, c, b, b, c, d); }
    geo.setIndex(idx);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3((N * C) / 2, 0, (N * C) / 2), N * C);
    const mat = new THREE.MeshPhysicalMaterial({
      // The reflection is tinted warm (specularColor; no untinted clear coat): blue sky mirrored in dark red reads purple.
      vertexColors: true, transparent: true, depthWrite: false, roughness: 0.08, metalness: 0, specularColor: new THREE.Color(1, 0.62, 0.55), specularIntensity: 1,
      envMapIntensity: 0.45, ior: 1.36, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x0, y0 + 0.002, z0); mesh.receiveShadow = true; mesh.renderOrder = 2;
    this.scene.add(mesh);
    const P: Pool = { mesh, geo, mat, x0, z0, y0, z, wall, h, src, vol: litres / 1000, fed: 0, t: 0, tau, acc: 0, quiet: 0, settled: false, dryT: 0, bb: [N / 2 - 6, N / 2 + 6, N / 2 - 6, N / 2 + 6] };
    this.pools.push(P);
    if (this.pools.length > MAX_POOLS) { const o = this.pools.shift()!; this.scene.remove(o.mesh); o.geo.dispose(); o.mat.dispose(); }
  }

  private stepPool(P: Pool, dt: number): number {
    const { h, z, wall } = P;
    // Feed: the wound empties over ~τ (exponential), into the source cells.
    P.t += dt;
    const want = P.vol * (1 - Math.exp(-P.t / P.tau)), add = want - P.fed; P.fed = want;
    if (add > 0) for (const s of P.src) h[s.i] += (add * s.w) / (C * C);
    // Thin-film flow between neighbours (8 of them, so it spreads round rather than square): flux ∝ (upwind depth above
    // the yield)³ × surface slope. Fluxes are worked out from this step's depths and then applied together (in-place
    // updates drift the flow along the scan direction); a cell never gives away more than it has above the yield.
    const out = this.out, dh = this.dh; out.fill(0); dh.fill(0);
    let moved = 0;
    const flux = (a: number, b: number, w: number, dist: number, pass: number) => {
      if (wall[a] || wall[b]) return;
      const za = z[a], zb = z[b], lostA = Number.isNaN(za), lostB = Number.isNaN(zb);
      if (lostA && lostB) return;
      let up: number, dn: number, ds: number;
      // A drop-off: liquid at the edge runs over it and is lost (onto the floor below).
      if (lostA || lostB) { up = lostB ? a : b; dn = -1; ds = h[up] + 0.02; }
      else { const sa = za + h[a], sb = zb + h[b]; up = sa > sb ? a : b; dn = up === a ? b : a; ds = Math.abs(sa - sb); }
      const e = h[up] - H_YIELD; if (e <= 0) return;
      let q = Math.min(K * e * e * e * (ds / dist) * dt / C * w, ds * 0.2 * w);
      if (pass === 0) { out[up] += q; return; }
      const avail = e * 0.5; if (out[up] > avail) q *= avail / out[up];
      dh[up] -= q; if (dn >= 0) dh[dn] += q; moved += q;
    };
    const D = C * Math.SQRT2;
    // Only the part of the grid the blood has reached (plus a cell) is worked on.
    const [i0, i1, j0, j1] = P.bb;
    for (let pass = 0; pass < 2; pass++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * N + i;
      if (i < N - 1) flux(k, k + 1, 1, C, pass);
      if (j < N - 1) {
        flux(k, k + N, 1, C, pass);
        if (i < N - 1) flux(k, k + N + 1, 0.5, D, pass);
        if (i > 0) flux(k, k + N - 1, 0.5, D, pass);
      }
    }
    let a0 = N, a1 = -1, b0 = N, b1 = -1;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const k = j * N + i; h[k] += dh[k]; if (h[k] > 1e-6) { if (i < a0) a0 = i; if (i > a1) a1 = i; if (j < b0) b0 = j; if (j > b1) b1 = j; } }
    if (a1 >= 0) P.bb = [Math.max(0, a0 - 1), Math.min(N - 1, a1 + 1), Math.max(0, b0 - 1), Math.min(N - 1, b1 + 1)];
    return moved;
  }

  private drawPool(P: Pool) {
    const { h, z } = P, pos = P.geo.attributes.position.array as Float32Array, nor = P.geo.attributes.normal.array as Float32Array, col = P.geo.attributes.color.array as Float32Array;
    // Drying: deep red → brown-black, glossy → dull over ~4 minutes.
    const dry = Math.min(1, P.dryT / 240);
    const S = (k: number) => (Number.isNaN(z[k]) ? z[P.src[0]?.i ?? 0] - 0.3 : z[k]) + h[k] * 6;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i, d = h[k];
      pos[k * 3 + 1] = (Number.isNaN(z[k]) ? -1 : z[k]) + d;
      // Normals from the (depth-exaggerated) surface: flat on top, tilted at the rounded edge.
      const l = S(j * N + Math.max(0, i - 1)), r = S(j * N + Math.min(N - 1, i + 1)), b = S(Math.max(0, j - 1) * N + i), f = S(Math.min(N - 1, j + 1) * N + i);
      _n.set(-(r - l) / (2 * C), 1, -(f - b) / (2 * C)).normalize();
      nor[k * 3] = _n.x; nor[k * 3 + 1] = _n.y; nor[k * 3 + 2] = _n.z;
      // Colour by thickness (Beer–Lambert-ish): a thin film is a brighter red, a deep pool nearly black-red.
      const th = Math.min(1, d / 0.005);
      col[k * 4] = (0.1 - 0.075 * th) * (1 - dry * 0.55); col[k * 4 + 1] = (0.009 - 0.006 * th) * (1 - dry * 0.3); col[k * 4 + 2] = (0.007 - 0.004 * th);
      // Edge: fade in over the first fraction of a millimetre (the meniscus), nothing where there is no blood.
      col[k * 4 + 3] = THREE.MathUtils.smoothstep(d, 0.0002, 0.00045) * 0.98;
    }
    P.geo.attributes.position.needsUpdate = true; P.geo.attributes.normal.needsUpdate = true; P.geo.attributes.color.needsUpdate = true;
    P.mat.roughness = 0.08 + dry * 0.45; P.mat.specularIntensity = 1 - dry * 0.6;
  }

  // ---------------- beads ----------------
  /** A drop of radius r (m) landing on a surface with normal n: a liquid bead; on a wall a big one creeps down. */
  bead(p: V3, n: V3, r: number) {
    const i = this.beadN % MAX_BEADS; this.beadN++;
    this.runners = this.runners.filter((b) => b.i !== i);
    this.setBead(i, p, n, r, 0.45);
    this.beads.count = Math.min(MAX_BEADS, this.beadN);
    if (Math.abs(n[1]) < 0.55 && r > 0.0045 && Math.random() < 0.75) this.runners.push({ i, p: [...p] as V3, n: [...n] as V3, r, run: 0, v: 0.02 + r * 6, trailAcc: 0 });
  }
  private setBead(i: number, p: V3, n: V3, r: number, flat: number, into = this.beads) {
    _q.setFromUnitVectors(_up, _n.set(n[0], n[1], n[2]));
    _m.compose(_p.set(p[0] + n[0] * r * 0.12, p[1] + n[1] * r * 0.12, p[2] + n[2] * r * 0.12), _q, _s.set(r, r * flat, r));
    into.setMatrixAt(i, _m); into.instanceMatrix.needsUpdate = true;
  }
  /** Spray hitting a surface: a cluster of beads (most small), thrown along the surface. */
  spatter(p: V3, n: V3, amount: number) {
    const cnt = Math.round(6 + amount * 22);
    // Two tangents of the surface.
    const nv = _n.set(n[0], n[1], n[2]).normalize(), t1 = new THREE.Vector3().crossVectors(nv, Math.abs(nv.y) < 0.9 ? _up : new THREE.Vector3(1, 0, 0)).normalize(), t2 = new THREE.Vector3().crossVectors(nv, t1);
    const ns: V3 = [nv.x, nv.y, nv.z];
    const sx = 0.6 + Math.random() * 0.8, sy = 0.6 + Math.random() * 0.8;
    for (let k = 0; k < cnt; k++) {
      const a = Math.random() * Math.PI * 2, d = Math.pow(Math.random(), 1.6) * amount * 0.35;
      const q: V3 = [p[0] + (t1.x * Math.cos(a) * sx + t2.x * Math.sin(a) * sy) * d, p[1] + (t1.y * Math.cos(a) * sx + t2.y * Math.sin(a) * sy) * d, p[2] + (t1.z * Math.cos(a) * sx + t2.z * Math.sin(a) * sy) * d];
      // Bigger drops near the centre, a fine scatter outside.
      const r = (0.002 + Math.random() * 0.005) * (1 + 1.6 * (1 - d / (amount * 0.35 + 1e-3))) * (0.7 + amount * 0.5);
      this.bead(q, ns, r);
    }
  }

  update(dt: number) {
    for (const P of this.pools) {
      if (P.settled) {
        // Settled: only the drying is redrawn now and then.
        P.dryT += dt; P.acc += dt;
        if (P.acc > 3 && P.dryT < 260) { P.acc = 0; this.drawPool(P); }
        continue;
      }
      P.acc += dt; P.dryT += dt;
      let moved = 0, steps = 0;
      while (P.acc >= SIM_DT && steps < 3) { P.acc -= SIM_DT; moved += this.stepPool(P, SIM_DT); steps++; }
      if (steps) this.drawPool(P);
      // Settled once fed and nothing has moved for a couple of seconds.
      P.quiet = moved < 2e-7 && P.t > P.tau * 3 ? P.quiet + dt : 0;
      if (P.quiet > 2) P.settled = true;
    }
    // Runners on walls: creep down, slowing (viscous, and losing blood to the streak behind them).
    for (let k = this.runners.length - 1; k >= 0; k--) {
      const b = this.runners[k], n = b.n;
      const down = _p.set(0, -1, 0).addScaledVector(_n.set(n[0], n[1], n[2]), n[1]).normalize();
      const dx = down.x, dy = down.y, dz = down.z, step = b.v * dt;
      b.p[0] += dx * step; b.p[1] += dy * step; b.p[2] += dz * step; b.run += step;
      b.v *= Math.exp(-dt * 0.9); b.trailAcc += step;
      // The streak: small flattened beads left every few millimetres.
      if (b.trailAcc > 0.0025) {
        b.trailAcc = 0; b.r *= 0.994;
        const i = this.trailN % MAX_TRAIL; this.trailN++; this.trail.count = Math.min(MAX_TRAIL, this.trailN);
        this.setBead(i, [b.p[0] - dx * 0.004, b.p[1] - dy * 0.004, b.p[2] - dz * 0.004], n, b.r * 0.6, 0.2, this.trail);
      }
      this.setBead(b.i, b.p, n, b.r, 0.5);
      // Stops when it has slowed right down, run thin, or left the wall (a window, an edge, the floor).
      const on = this.surfaceAt([b.p[0] + n[0] * 0.02, b.p[1] + n[1] * 0.02, b.p[2] + n[2] * 0.02], [-n[0], -n[1], -n[2]], 0.05);
      if (!on || b.v < 0.003 || b.r < 0.0025 || b.run > 0.6) this.runners.splice(k, 1);
    }
  }
}

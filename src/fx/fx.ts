// Visual effects: muzzle flashes (with a small pool of lights so shaders never recompile), tracers, particle puffs
// (dust, sparks, blood, smoke, fire), bullet-hole and scorch decals, explosions and smoke screens.
import * as THREE from 'three';
import type { Surface } from '../world/sink';

type V3 = [number, number, number];
const MAX_P = 6000, MAX_DECALS = 1500, MAX_TRACERS = 300;

function softDot(): THREE.Texture {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d')!, g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.4, 'rgba(255,255,255,0.65)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function puffTexture(): THREE.Texture {
  // Billowing smoke sprite: fractal noise inside a soft round mask, shaded as if lit from above (lighter top-left
  // lobes, darker undersides) so overlapping puffs read as a 3-D cloud rather than a blur.
  const N = 128, c = document.createElement('canvas'); c.width = c.height = N;
  const x = c.getContext('2d')!, img = x.createImageData(N, N);
  const g = new Float32Array(33 * 33).map(() => Math.random());
  const vn = (u: number, v: number, f: number) => {
    const X = u * f, Y = v * f, ix = Math.floor(X), iy = Math.floor(Y), tx = X - ix, ty = Y - iy, s = (t: number) => t * t * (3 - 2 * t);
    const at = (i: number, j: number) => g[((j % 32) + 32) % 32 * 33 + ((i % 32) + 32) % 32];
    return (at(ix, iy) * (1 - s(tx)) + at(ix + 1, iy) * s(tx)) * (1 - s(ty)) + (at(ix, iy + 1) * (1 - s(tx)) + at(ix + 1, iy + 1) * s(tx)) * s(ty);
  };
  const fbm = (u: number, v: number) => vn(u, v, 4) * 0.5 + vn(u, v, 8) * 0.28 + vn(u, v, 16) * 0.15 + vn(u, v, 32) * 0.07;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const u = i / N, v = j / N, dx = u - 0.5, dy = v - 0.5, r = Math.hypot(dx, dy) * 2;
    const d = fbm(u, v), mask = Math.max(0, 1 - Math.pow(r / (0.75 + d * 0.35), 2.2));
    const dens = Math.max(0, mask * (0.55 + d * 0.9) - 0.15);
    const light = 0.72 + (fbm(u - 0.03, v - 0.04) - d) * 2.2 + (0.5 - v) * 0.35;
    const k = (j * N + i) * 4, L = Math.max(0.35, Math.min(1.15, light)) * 255;
    img.data[k] = Math.min(255, L); img.data[k + 1] = Math.min(255, L * 0.98); img.data[k + 2] = Math.min(255, L * 0.95); img.data[k + 3] = Math.min(255, dens * 255);
  }
  x.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function holeTexture(): THREE.Texture {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d')!;
  let g = x.createRadialGradient(32, 32, 0, 32, 32, 30);
  g.addColorStop(0, 'rgba(10,8,6,1)'); g.addColorStop(0.18, 'rgba(25,20,15,0.95)'); g.addColorStop(0.3, 'rgba(70,60,50,0.55)'); g.addColorStop(1, 'rgba(120,110,95,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  for (let i = 0; i < 7; i++) { x.strokeStyle = 'rgba(40,35,30,0.5)'; x.lineWidth = 1; x.beginPath(); x.moveTo(32, 32); const a = Math.random() * 6.28, r = 8 + Math.random() * 16; x.lineTo(32 + Math.cos(a) * r, 32 + Math.sin(a) * r); x.stroke(); }
  g = x.createRadialGradient(32, 32, 0, 32, 32, 6); g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

function bloodTexture(): THREE.Texture {
  // Irregular splatter: a dense core, satellite drops and a few streaks (dark arterial red).
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d')!;
  const blob = (bx: number, by: number, r: number, a: number) => { const g = x.createRadialGradient(bx, by, 0, bx, by, r); g.addColorStop(0, `rgba(70,4,4,${a})`); g.addColorStop(0.7, `rgba(90,8,6,${a * 0.9})`); g.addColorStop(1, 'rgba(90,8,6,0)'); x.fillStyle = g; x.beginPath(); x.arc(bx, by, r, 0, 7); x.fill(); };
  for (let i = 0; i < 9; i++) blob(64 + (Math.random() - 0.5) * 30, 64 + (Math.random() - 0.5) * 30, 14 + Math.random() * 16, 0.95);
  for (let i = 0; i < 26; i++) { const a = Math.random() * 6.28, d = 25 + Math.random() * 36; blob(64 + Math.cos(a) * d, 64 + Math.sin(a) * d, 1.5 + Math.random() * 4, 0.9); }
  x.strokeStyle = 'rgba(80,6,5,0.8)'; x.lineCap = 'round';
  for (let i = 0; i < 6; i++) { const a = Math.random() * 6.28, d = 20 + Math.random() * 30; x.lineWidth = 1 + Math.random() * 3; x.beginPath(); x.moveTo(64 + Math.cos(a) * 12, 64 + Math.sin(a) * 12); x.lineTo(64 + Math.cos(a) * d, 64 + Math.sin(a) * d); x.stroke(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function poolTexture(): THREE.Texture {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d')!;
  for (let i = 0; i < 7; i++) { const bx = 64 + (Math.random() - 0.5) * 34, by = 64 + (Math.random() - 0.5) * 34, r = 22 + Math.random() * 18; const g = x.createRadialGradient(bx, by, 0, bx, by, r); g.addColorStop(0, 'rgba(45,2,2,0.97)'); g.addColorStop(0.8, 'rgba(60,4,3,0.9)'); g.addColorStop(1, 'rgba(60,4,3,0)'); x.fillStyle = g; x.beginPath(); x.arc(bx, by, r, 0, 7); x.fill(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

const PARTICLE_VS = `
attribute float size; attribute float alpha; attribute vec3 tint; attribute float rot;
varying float vA; varying vec3 vT; varying float vR;
#include <fog_pars_vertex>
uniform float uScale;
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = size * uScale / max(0.1, -mvPosition.z);
  vA = alpha; vT = tint; vR = rot;
  #include <fog_vertex>
}`;
const PARTICLE_FS = `
uniform sampler2D map; varying float vA; varying vec3 vT; varying float vR;
#include <fog_pars_fragment>
void main() {
  vec2 c = gl_PointCoord - 0.5; float s = sin(vR), co = cos(vR);
  vec2 uv = vec2(c.x * co - c.y * s, c.x * s + c.y * co) + 0.5;
  vec4 t = texture2D(map, uv);
  gl_FragColor = vec4(vT * t.rgb, t.a * vA);
  if (gl_FragColor.a < 0.004) discard;
  #include <fog_fragment>
}`;

class ParticleSet {
  points: THREE.Points;
  pos = new Float32Array(MAX_P * 3); vel = new Float32Array(MAX_P * 3); size = new Float32Array(MAX_P); grow = new Float32Array(MAX_P);
  alpha = new Float32Array(MAX_P); a0 = new Float32Array(MAX_P); life = new Float32Array(MAX_P); age = new Float32Array(MAX_P);
  tint = new Float32Array(MAX_P * 3); rot = new Float32Array(MAX_P); drag = new Float32Array(MAX_P); grav = new Float32Array(MAX_P);
  /** Start and end colours (the tint is interpolated over the particle's life). */
  t0 = new Float32Array(MAX_P * 3); t1 = new Float32Array(MAX_P * 3);
  n = 0; next = 0;
  constructor(tex: THREE.Texture, additive: boolean, scene: THREE.Scene) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('tint', new THREE.BufferAttribute(this.tint, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('rot', new THREE.BufferAttribute(this.rot, 1).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    const m = new THREE.ShaderMaterial({
      uniforms: { map: { value: tex }, uScale: { value: 600 }, ...THREE.UniformsLib.fog }, vertexShader: PARTICLE_VS, fragmentShader: PARTICLE_FS,
      transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, fog: true,
    });
    this.points = new THREE.Points(g, m); this.points.frustumCulled = false; this.points.renderOrder = additive ? 11 : 10;
    scene.add(this.points);
  }
  spawn(p: V3, v: V3, size: number, grow: number, life: number, alpha: number, tint: V3, drag = 1, grav = 0, tintEnd?: V3) {
    const i = this.next; this.next = (this.next + 1) % MAX_P; this.n = Math.max(this.n, i + 1);
    this.pos.set(p, i * 3); this.vel.set(v, i * 3); this.size[i] = size; this.grow[i] = grow; this.life[i] = life; this.age[i] = 0;
    this.a0[i] = alpha; this.alpha[i] = alpha; this.tint.set(tint, i * 3); this.t0.set(tint, i * 3); this.t1.set(tintEnd ?? tint, i * 3);
    this.rot[i] = Math.random() * 6.28; this.drag[i] = drag; this.grav[i] = grav;
  }
  update(dt: number, wind: V3) {
    for (let i = 0; i < this.n; i++) {
      if (this.age[i] >= this.life[i]) { this.alpha[i] = 0; continue; }
      this.age[i] += dt;
      const t = this.age[i] / this.life[i], k = Math.exp(-this.drag[i] * dt);
      this.vel[i * 3] = this.vel[i * 3] * k + wind[0] * (1 - k); this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * k - this.grav[i] * dt; this.vel[i * 3 + 2] = this.vel[i * 3 + 2] * k + wind[2] * (1 - k);
      this.pos[i * 3] += this.vel[i * 3] * dt; this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt; this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] += this.grow[i] * dt;
      this.alpha[i] = this.a0[i] * (t < 0.08 ? t / 0.08 : 1 - (t - 0.08) / 0.92);
      for (let k = 0; k < 3; k++) this.tint[i * 3 + k] = this.t0[i * 3 + k] + (this.t1[i * 3 + k] - this.t0[i * 3 + k]) * t;
      this.rot[i] += dt * 0.3;
    }
    const g = this.points.geometry;
    for (const k of ['position', 'size', 'alpha', 'tint', 'rot']) (g.getAttribute(k) as THREE.BufferAttribute).needsUpdate = true;
    g.setDrawRange(0, this.n);
  }
}

const DUST: Record<Surface, V3> = {
  masonry: [0.72, 0.64, 0.52], concrete: [0.66, 0.64, 0.6], metal: [0.5, 0.5, 0.5], wood: [0.55, 0.42, 0.28], glass: [0.8, 0.85, 0.9],
  dirt: [0.62, 0.53, 0.4], sandbag: [0.7, 0.62, 0.48], water: [0.85, 0.9, 0.9], flesh: [0.45, 0.04, 0.03],
};

export class FX {
  smoke: ParticleSet; glow: ParticleSet;
  decals: THREE.InstancedMesh; decalN = 0;
  scorch: THREE.InstancedMesh; scorchN = 0;
  tracers: THREE.LineSegments; private tr = new Float32Array(MAX_TRACERS * 6); private trc = new Float32Array(MAX_TRACERS * 6); private trLife = new Float32Array(MAX_TRACERS); private trN = 0;
  lights: THREE.PointLight[] = []; private lightT: number[] = [];
  flashes: THREE.Sprite[] = []; private flashT: number[] = [];
  wind: V3 = [0.6, 0, 0.3];
  splats: THREE.InstancedMesh; private bloodN = 0;
  pools: THREE.InstancedMesh; private poolN = 0; private growing: { i: number; p: V3; r: number; max: number; rot: number }[] = [];
  private bodies = new Map<number, THREE.Object3D>();
  private rings: { m: THREE.Mesh; t: number; r: number }[] = [];
  private m4 = new THREE.Matrix4(); private q = new THREE.Quaternion(); private up = new THREE.Vector3(0, 0, 1);
  constructor(public scene: THREE.Scene) {
    this.smoke = new ParticleSet(puffTexture(), false, scene);
    this.glow = new ParticleSet(softDot(), true, scene);
    const dg = new THREE.PlaneGeometry(1, 1);
    this.decals = new THREE.InstancedMesh(dg, new THREE.MeshStandardMaterial({ map: holeTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, roughness: 1 }), MAX_DECALS);
    this.decals.count = 0; this.decals.frustumCulled = false; scene.add(this.decals);
    const sc = document.createElement('canvas'); sc.width = sc.height = 128; const sx = sc.getContext('2d')!;
    const sg = sx.createRadialGradient(64, 64, 0, 64, 64, 64); sg.addColorStop(0, 'rgba(15,12,10,0.95)'); sg.addColorStop(0.5, 'rgba(30,25,20,0.6)'); sg.addColorStop(1, 'rgba(40,35,30,0)'); sx.fillStyle = sg; sx.fillRect(0, 0, 128, 128);
    const st = new THREE.CanvasTexture(sc); st.colorSpace = THREE.SRGBColorSpace;
    this.scorch = new THREE.InstancedMesh(dg, new THREE.MeshStandardMaterial({ map: st, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3, roughness: 1 }), 120);
    this.scorch.count = 0; this.scorch.frustumCulled = false; scene.add(this.scorch);
    const bm = (map: THREE.Texture, o: number) => new THREE.MeshStandardMaterial({ map, color: 0x8c8c8c, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: o, polygonOffsetUnits: o, roughness: 0.55, metalness: 0, envMapIntensity: 0.3 });
    this.splats = new THREE.InstancedMesh(dg, bm(bloodTexture(), -5), 400); this.splats.count = 0; this.splats.frustumCulled = false; scene.add(this.splats);
    this.pools = new THREE.InstancedMesh(dg, bm(poolTexture(), -6), 60); this.pools.count = 0; this.pools.frustumCulled = false; scene.add(this.pools);
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(this.tr, 3).setUsage(THREE.DynamicDrawUsage));
    tg.setAttribute('color', new THREE.BufferAttribute(this.trc, 3).setUsage(THREE.DynamicDrawUsage));
    this.tracers = new THREE.LineSegments(tg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    this.tracers.frustumCulled = false; scene.add(this.tracers);
    for (let i = 0; i < 3; i++) { const l = new THREE.PointLight(0xffb060, 0, 14, 2); this.lights.push(l); this.lightT.push(0); scene.add(l); }
    const fm = new THREE.SpriteMaterial({ map: softDot(), color: 0xffc070, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
    for (let i = 0; i < 8; i++) { const s = new THREE.Sprite(fm); s.visible = false; this.flashes.push(s); this.flashT.push(0); scene.add(s); }
    const rg = new THREE.RingGeometry(0.85, 1, 48).rotateX(-Math.PI / 2);
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(rg, new THREE.MeshBasicMaterial({ color: 0xd8c8a8, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
      m.visible = false; scene.add(m); this.rings.push({ m, t: 1, r: 1 });
    }
  }

  private light(p: V3, intensity: number, dur: number, range = 14) {
    let k = 0; for (let i = 1; i < this.lights.length; i++) if (this.lightT[i] < this.lightT[k]) k = i;
    const l = this.lights[k]; l.position.set(p[0], p[1], p[2]); l.intensity = intensity; l.distance = range; this.lightT[k] = dur;
  }
  muzzle(p: V3, dir: V3, big: number, firstPerson: boolean) {
    let k = this.flashT.indexOf(Math.min(...this.flashT));
    if (k < 0) k = 0;
    const s = this.flashes[k];
    s.position.set(p[0] + dir[0] * 0.08, p[1] + dir[1] * 0.08, p[2] + dir[2] * 0.08);
    s.scale.setScalar((firstPerson ? 0.25 : 0.45) * big * (0.8 + Math.random() * 0.5)); s.visible = true; s.material.rotation = Math.random() * 6.28;
    this.flashT[k] = 0.035;
    this.light(p, 6 * big, 0.05);
    for (let i = 0; i < 3; i++) this.smoke.spawn([p[0] + dir[0] * 0.2, p[1] + dir[1] * 0.2, p[2] + dir[2] * 0.2], [dir[0] * 1.5 + (Math.random() - 0.5) * 0.5, dir[1] * 1.5 + 0.3, dir[2] * 1.5 + (Math.random() - 0.5) * 0.5], 0.15 * big, 0.6, 0.8, 0.18, [0.8, 0.78, 0.74], 2.5, -0.2);
  }
  tracer(a: V3, b: V3, col: V3 = [1.0, 0.45, 0.2]) {
    const i = this.trN; this.trN = (this.trN + 1) % MAX_TRACERS;
    this.tr.set([...a, ...b], i * 6); this.trc.set([col[0] * 0.3, col[1] * 0.3, col[2] * 0.3, ...col], i * 6); this.trLife[i] = 0.05;
  }
  impact(p: V3, n: V3, surf: Surface, big = 1) {
    const c = DUST[surf] ?? DUST.concrete;
    if (surf === 'water') { for (let i = 0; i < 6; i++) this.smoke.spawn(p, [(Math.random() - 0.5) * 1.5, 3 + Math.random() * 3, (Math.random() - 0.5) * 1.5], 0.3, 0.6, 0.7, 0.5, c, 1, 9.8); return; }
    const k = surf === 'dirt' || surf === 'sandbag' ? 7 : 4;
    for (let i = 0; i < k * big; i++) this.smoke.spawn([p[0] + n[0] * 0.05, p[1] + n[1] * 0.05, p[2] + n[2] * 0.05], [n[0] * (1 + Math.random() * 2) + (Math.random() - 0.5), n[1] * (1 + Math.random() * 2) + Math.random() * 0.8, n[2] * (1 + Math.random() * 2) + (Math.random() - 0.5)], 0.18 * big, 0.9 * big, 0.7 + Math.random() * 0.8, 0.55, c, 3, 0.4);
    // Chips/debris (small, falling).
    for (let i = 0; i < 3; i++) this.smoke.spawn(p, [n[0] * 3 + (Math.random() - 0.5) * 3, n[1] * 3 + Math.random() * 2, n[2] * 3 + (Math.random() - 0.5) * 3], 0.035, 0, 0.6, 0.9, [c[0] * 0.6, c[1] * 0.6, c[2] * 0.6], 0.5, 9.8);
    if (surf === 'metal' || surf === 'concrete') for (let i = 0; i < (surf === 'metal' ? 5 : 2); i++) this.glow.spawn(p, [n[0] * 4 + (Math.random() - 0.5) * 6, n[1] * 4 + Math.random() * 3, n[2] * 4 + (Math.random() - 0.5) * 6], 0.05, 0, 0.18, 1, [1, 0.75, 0.4], 0.5, 9.8);
    if (surf !== 'flesh' && surf !== 'glass') this.decal(p, n, 0.07 + Math.random() * 0.04);
  }
  /** Bullet hit on a body: a mist puff, a spray of droplets thrown along the bullet's path, and a few that fall. */
  blood(p: V3, dir: V3, big = 1) {
    for (let i = 0; i < 10 * big; i++) this.smoke.spawn(p, [dir[0] * (0.8 + Math.random() * 1.6) + (Math.random() - 0.5) * 0.8, dir[1] * 1.2 + (Math.random() - 0.3) * 0.8, dir[2] * (0.8 + Math.random() * 1.6) + (Math.random() - 0.5) * 0.8], 0.18, 0.9, 0.35 + Math.random() * 0.25, 0.85, [0.42, 0.02, 0.02], 4, 1.5);
    for (let i = 0; i < 14 * big; i++) this.smoke.spawn(p, [dir[0] * (2 + Math.random() * 4) + (Math.random() - 0.5) * 2, dir[1] * 2 + Math.random() * 1.5, dir[2] * (2 + Math.random() * 4) + (Math.random() - 0.5) * 2], 0.025 + Math.random() * 0.02, 0, 0.5 + Math.random() * 0.4, 1, [0.32, 0.01, 0.01], 0.4, 9.8);
  }
  /** Splatter on a surface (wall behind the victim, the ground below). */
  bloodDecal(p: V3, n: V3, size: number) {
    const i = this.bloodN % 400; this.bloodN++;
    this.q.setFromUnitVectors(this.up, new THREE.Vector3(n[0], n[1], n[2])).multiply(new THREE.Quaternion().setFromAxisAngle(this.up, Math.random() * 6.28));
    this.m4.compose(new THREE.Vector3(p[0] + n[0] * 0.012, p[1] + n[1] * 0.012, p[2] + n[2] * 0.012), this.q, new THREE.Vector3(size, size, size));
    this.splats.setMatrixAt(i, this.m4); this.splats.count = Math.min(400, this.bloodN); this.splats.instanceMatrix.needsUpdate = true;
  }
  /** A pool that spreads under a downed body over ~15 s. */
  bloodPool(p: V3, max = 1.3) {
    const i = this.poolN % 60; this.poolN++;
    this.growing = this.growing.filter((g) => g.i !== i);
    this.growing.push({ i, p, r: 0.15, max: max * (0.8 + Math.random() * 0.4), rot: Math.random() * 6.28 });
    this.pools.count = Math.min(60, this.poolN);
  }
  decal(p: V3, n: V3, size: number) {
    const i = this.decalN % MAX_DECALS; this.decalN++;
    this.q.setFromUnitVectors(this.up, new THREE.Vector3(n[0], n[1], n[2]));
    this.m4.compose(new THREE.Vector3(p[0] + n[0] * 0.01, p[1] + n[1] * 0.01, p[2] + n[2] * 0.01), this.q, new THREE.Vector3(size, size, size));
    this.decals.setMatrixAt(i, this.m4); this.decals.count = Math.min(MAX_DECALS, this.decalN); this.decals.instanceMatrix.needsUpdate = true;
  }
  /**
   * Explosion: white flash, a fireball that cools from yellow to sooty brown, a dust skirt racing out along the ground,
   * dirt jets (ground hits), debris and sparks on ballistic arcs, a ground shockwave ring, and a dark smoke column that
   * rises and spreads for 10+ s. `power` ≈ 1 grenade, 2 RPG/AT4, 3 IED/cache.
   */
  explosion(p: V3, power: number, n: V3 = [0, 1, 0]) {
    const P = power * 1.5, rnd = Math.random, up = n[1] > 0.6;
    this.light([p[0] + n[0], p[1] + n[1] + 1.5, p[2] + n[2]], 90 * P, 0.22, 45 * P);
    this.glow.spawn([p[0], p[1] + 0.5, p[2]], [0, 0, 0], 5 * P, 10 * P, 0.09, 1, [1, 0.95, 0.8], 0, 0, [1, 0.7, 0.3]);
    // Fireball (additive) — cools as it expands.
    for (let i = 0; i < 14 * P; i++) {
      const v: V3 = [(rnd() - 0.5) * 7 * P + n[0] * 3, rnd() * 5 * P + n[1] * 3, (rnd() - 0.5) * 7 * P + n[2] * 3];
      this.glow.spawn([p[0] + (rnd() - 0.5) * 1.2, p[1] + 0.3 + rnd() * 1.2, p[2] + (rnd() - 0.5) * 1.2], v, (1.5 + rnd()) * P, 5 * P, 0.3 + rnd() * 0.5, 1, [1, 0.85, 0.45], 4, -1.5, [0.6, 0.18, 0.04]);
    }
    // Dark smoke column: billows up and spreads, lightening as it rises.
    for (let i = 0; i < 26 * P; i++) {
      const tone = 0.1 + rnd() * 0.1, h = rnd();
      this.smoke.spawn([p[0] + (rnd() - 0.5) * 2.5 * P, p[1] + 0.4 + h * 2.5 * P, p[2] + (rnd() - 0.5) * 2.5 * P], [(rnd() - 0.5) * 3, 1.5 + h * 5 * P, (rnd() - 0.5) * 3], (0.8 + rnd() * 1.6) * P, (0.6 + rnd()) * P, 6 + rnd() * 9, 0.75 + rnd() * 0.2, [tone, tone * 0.95, tone * 0.88], 0.8, -0.1, [0.46, 0.44, 0.4]);
    }
    // Dust skirt along the ground.
    if (up) for (let i = 0; i < 22 * P; i++) {
      const a = rnd() * Math.PI * 2, sp = 7 + rnd() * 9;
      this.smoke.spawn([p[0] + Math.cos(a) * 0.8, p[1] + 0.3, p[2] + Math.sin(a) * 0.8], [Math.cos(a) * sp * Math.sqrt(P), 0.6 + rnd() * 1.2, Math.sin(a) * sp * Math.sqrt(P)], 0.9 * P, 2.8 * P, 2.2 + rnd() * 2.5, 0.8, [0.66, 0.58, 0.45], 2.6, -0.05, [0.72, 0.66, 0.55]);
    }
    // Dirt jets thrown up from a ground hit.
    if (up) for (let j = 0; j < 7; j++) {
      const a = rnd() * Math.PI * 2, tilt = 0.15 + rnd() * 0.35;
      for (let k = 0; k < 5 * P; k++) this.smoke.spawn([p[0], p[1] + 0.2, p[2]], [Math.cos(a) * tilt * 14 * P, (11 + rnd() * 6) * Math.sqrt(P), Math.sin(a) * tilt * 14 * P], 0.35 + rnd() * 0.4, 0.8, 1.2 + rnd() * 0.8, 0.95, [0.38, 0.32, 0.25], 0.6, 9.8, [0.55, 0.48, 0.38]);
    }
    // Debris chunks and sparks.
    for (let i = 0; i < 30 * P; i++) this.smoke.spawn(p, [(rnd() - 0.5) * 26, 4 + rnd() * 16, (rnd() - 0.5) * 26], 0.06 + rnd() * 0.08, 0, 1.4 + rnd() * 1.2, 1, [0.2, 0.18, 0.16], 0.15, 9.8);
    for (let i = 0; i < 24 * P; i++) this.glow.spawn(p, [(rnd() - 0.5) * 34, rnd() * 20, (rnd() - 0.5) * 34], 0.05, 0, 0.4 + rnd() * 0.7, 1, [1, 0.8, 0.45], 0.25, 9.8, [1, 0.35, 0.1]);
    // Ground shockwave.
    if (up) { const r = this.rings.find((x) => x.t >= 1) ?? this.rings[0]; r.t = 0; r.r = 9 * P; r.m.position.set(p[0], p[1] + 0.08, p[2]); r.m.visible = true; }
    if (up) {
      const i = this.scorchN % 120; this.scorchN++;
      this.q.setFromUnitVectors(this.up, new THREE.Vector3(0, 1, 0));
      this.m4.compose(new THREE.Vector3(p[0], p[1] - 0.05, p[2]), this.q, new THREE.Vector3(3.5 * P, 3.5 * P, 1));
      this.scorch.setMatrixAt(i, this.m4); this.scorch.count = Math.min(120, this.scorchN); this.scorch.instanceMatrix.needsUpdate = true;
    }
  }
  /** Smoke grenade: emits for ~50 s. */
  smokeScreens: { p: V3; t: number; col: V3 }[] = [];
  smokeGrenade(p: V3, col: V3 = [0.86, 0.86, 0.84]) { this.smokeScreens.push({ p, t: 0, col }); }

  /** Visual for flying rockets/grenades (simple meshes; models can replace them). */
  body(id: number, kind: string, p: V3 | null, v?: V3) {
    let o = this.bodies.get(id);
    if (!p) { if (o) { this.scene.remove(o); this.bodies.delete(id); } return; }
    if (!o) {
      const geo = kind === 'rocket' ? new THREE.CylinderGeometry(0.04, 0.04, 0.9, 8).rotateX(Math.PI / 2) : new THREE.SphereGeometry(kind === 'gl' ? 0.02 : 0.035, 8, 6);
      o = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: kind === 'smoke' ? 0x4a5a3a : 0x3a4030, roughness: 0.6 }));
      this.scene.add(o); this.bodies.set(id, o);
    }
    o.position.set(p[0], p[1], p[2]);
    if (v && kind === 'rocket') {
      o.lookAt(p[0] + v[0], p[1] + v[1], p[2] + v[2]);
      // Rocket motor glow and smoke trail.
      this.glow.spawn(p, [0, 0, 0], 0.5, -0.5, 0.06, 1, [1, 0.7, 0.3]);
      this.smoke.spawn(p, [(Math.random() - 0.5) * 0.4, 0.2, (Math.random() - 0.5) * 0.4], 0.35, 1.2, 2.2, 0.45, [0.82, 0.8, 0.77], 1.2, -0.1);
    }
  }

  update(dt: number) {
    for (let i = 0; i < this.flashes.length; i++) { this.flashT[i] -= dt; if (this.flashT[i] <= 0) this.flashes[i].visible = false; }
    for (let i = 0; i < this.lights.length; i++) { this.lightT[i] -= dt; if (this.lightT[i] <= 0) this.lights[i].intensity = 0; else this.lights[i].intensity *= 0.75; }
    for (let i = 0; i < MAX_TRACERS; i++) {
      if (this.trLife[i] <= 0) continue;
      this.trLife[i] -= dt;
      if (this.trLife[i] <= 0) for (let k = 0; k < 6; k++) this.trc[i * 6 + k] = 0;
    }
    (this.tracers.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.tracers.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    for (let i = this.smokeScreens.length - 1; i >= 0; i--) {
      const s = this.smokeScreens[i]; s.t += dt;
      const rate = s.t < 3 ? 6 : s.t < 45 ? 4 : 0;
      if (Math.random() < rate * dt * 6) this.smoke.spawn([s.p[0] + (Math.random() - 0.5) * 0.3, s.p[1] + 0.2, s.p[2] + (Math.random() - 0.5) * 0.3], [(Math.random() - 0.5) * 2.5, 1.2 + Math.random(), (Math.random() - 0.5) * 2.5], 1.5, 2.2, 18 + Math.random() * 8, 0.85, s.col, 0.5, -0.02);
      if (s.t > 60) this.smokeScreens.splice(i, 1);
    }
    for (const r of this.rings) {
      if (r.t >= 1) continue;
      r.t = Math.min(1, r.t + dt / 0.35);
      const k = 1 - Math.pow(1 - r.t, 2); r.m.scale.setScalar(0.5 + r.r * k);
      (r.m.material as THREE.MeshBasicMaterial).opacity = 0.45 * (1 - r.t);
      if (r.t >= 1) r.m.visible = false;
    }
    for (const g of this.growing) {
      if (g.r >= g.max) continue;
      g.r = Math.min(g.max, g.r + dt * (g.max - g.r) * 0.25 + dt * 0.01);
      this.q.setFromUnitVectors(this.up, new THREE.Vector3(0, 1, 0)).multiply(new THREE.Quaternion().setFromAxisAngle(this.up, g.rot));
      this.m4.compose(new THREE.Vector3(g.p[0], g.p[1] + 0.015, g.p[2]), this.q, new THREE.Vector3(g.r * 2, g.r * 2, 1));
      this.pools.setMatrixAt(g.i, this.m4); this.pools.instanceMatrix.needsUpdate = true;
    }
    this.smoke.update(dt, this.wind); this.glow.update(dt, [0, 0, 0]);
  }
  setScale(h: number) { for (const s of [this.smoke, this.glow]) (s.points.material as THREE.ShaderMaterial).uniforms.uScale.value = h * 0.9; }
}

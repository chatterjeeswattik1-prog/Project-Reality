import RAPIER from '@dimforge/rapier3d-compat';
import { generateCity } from '../src/world/citygen';
await RAPIER.init();
const city = generateCity(1337);
const mode = process.argv[2] ?? 'one';
const w = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
let t = performance.now();
const body = w.createRigidBody(RAPIER.RigidBodyDesc.fixed());
if (mode === 'tri') {
  const chunks = new Map<number, { v: number[]; i: number[] }>();
  for (const c of city.sink.colliders) {
    const k = Math.floor((c.c[0] + 2048) / 128) + Math.floor((c.c[2] + 2048) / 128) * 64;
    let ch = chunks.get(k); if (!ch) chunks.set(k, ch = { v: [], i: [] });
    const b = ch.v.length / 3;
    for (let n = 0; n < 8; n++) ch.v.push(c.c[0] + (n & 1 ? 1 : -1) * c.h[0], c.c[1] + (n & 2 ? 1 : -1) * c.h[1], c.c[2] + (n & 4 ? 1 : -1) * c.h[2]);
    for (const [a, b2, cc, d] of [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]]) ch.i.push(b + a, b + b2, b + cc, b + a, b + cc, b + d);
  }
  for (const ch of chunks.values()) w.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array(ch.v), new Uint32Array(ch.i), 0 as never), body);
  console.log('chunks', chunks.size);
} else
for (const c of city.sink.colliders) {
  const d = RAPIER.ColliderDesc.cuboid(c.h[0], c.h[1], c.h[2]).setTranslation(c.c[0], c.c[1], c.c[2]);
  if (c.q) d.setRotation({ x: c.q[0], y: c.q[1], z: c.q[2], w: c.q[3] });
  if (mode === 'one') w.createCollider(d, body); else w.createCollider(d);
}
console.log('create', Math.round(performance.now() - t), 'ms', city.sink.colliders.length);
const caps = [];
for (let i = 0; i < (process.argv[3] === 'nokin' ? 0 : 32); i++) { const b = w.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(-100 + i * 3, 1, -100)); w.createCollider(RAPIER.ColliderDesc.capsule(0.6, 0.3), b); caps.push(b); }
for (let f = 0; f < 6; f++) {
  t = performance.now();
  for (const b of caps) { const p = b.translation(); b.setNextKinematicTranslation({ x: p.x + 0.05, y: p.y, z: p.z }); }
  w.step();
  const ts = performance.now() - t; t = performance.now();
  const ray = new RAPIER.Ray({ x: 0, y: 1.6, z: 0 }, { x: 1, y: 0, z: 0 });
  for (let i = 0; i < 1000; i++) { ray.origin = { x: -300 + i * 0.6, y: 1.6, z: -100 }; ray.dir = { x: Math.cos(i), y: 0, z: Math.sin(i) }; { const h = w.castRayAndGetNormal(ray, 100, true); if (i === 0 && f === 1 && h) console.log('feature', h.featureType, h.featureId); } }
  console.log(`frame ${f}: step ${ts.toFixed(1)} ms, 1000 rays ${(performance.now() - t).toFixed(1)} ms`);
}

// Environment audit (test area): finds places where what you see and what collides disagree, and where the navmesh
// runs through walls.   node scripts/envaudit.mjs [rays=6000] [navPairs=4000] [outJson]
//  A. Random rays (0.2–6 m up, any horizontal direction, 15 m) against the visible city meshes (building layers 0–2,
//     props, terrain) and against the physics world. Physics hit > 0.3 m before the visible one = INVISIBLE wall;
//     visible hit > 0.3 m before the physics one = NO-COLLISION surface.
//  B. Random navmesh point pairs 1–8 m apart that the navmesh says are straight-walkable, tested with physics rays at
//     0.5 m and 1.2 m above the mesh: both blocked = the navmesh crosses a wall (bots walk through it).
// Hits are clustered on a 1 m grid and printed with the building tag (collider tag) where known.
import { launch } from './browser.mjs';
import fs from 'node:fs';
const [rays = '6000', pairs = '4000', out = '', rect = ''] = process.argv.slice(2);
// rect "x0,z0,x1,z1": audit that part of the full map instead of the test area.
const b = await launch();
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.goto(rect ? 'http://localhost:5173/?q=low&bots=0&shot=0,40,0,0,-89' : 'http://localhost:5173/?mode=test&auto=us&shot');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
const res = await p.evaluate(async ({ NR, NP, RECT }) => {
  const T = window.__THREE, g = window.__game, P = g.P, city = window.__city, nav = window.__nav, world = window.__world;
  const A = RECT ? { x0: RECT[0], z0: RECT[1], x1: RECT[2], z1: RECT[3] } : city.area;
  // seeded rng (repeatable runs)
  let s = 12345; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const meshes = [];
  world.root.traverse((o) => {
    if (!o.isMesh) return;
    const m = /^city:\d+:(\d)$/.exec(o.name);
    if (m && m[1] === '3') return; // far LOD shells: no collider by design
    if (/^impostor:|^grass|^canal$/.test(o.name)) return;
    meshes.push(o);
  });
  g.gfx.scene.traverse((o) => { if (o.isMesh && /^prop:|^terrain$|^asphalt$|^door$/.test(o.name) && !meshes.includes(o)) meshes.push(o); });
  for (const m of meshes) { const mats = Array.isArray(m.material) ? m.material : [m.material]; for (const x of mats) x.side = T.DoubleSide; m.updateMatrixWorld(true); }
  const rc = new T.Raycaster(); rc.firstHitOnly = true;
  const groundAt = (x, z) => { const h = P.castRay([x, 60, z], [0, -1, 0], 120); return h ? h.point[1] : 0; };
  const invisible = new Map(), nocol = new Map(), navx = new Map();
  const key = (pt) => `${Math.round(pt[0])},${Math.round(pt[1])},${Math.round(pt[2])}`;
  const note = (map, pt, info) => { const k = key(pt); const e = map.get(k); if (e) e.n++; else map.set(k, { n: 1, pt: pt.map((v) => +v.toFixed(2)), ...info }); };
  let tested = 0;
  for (let i = 0; i < NR; i++) {
    const x = A.x0 + rnd() * (A.x1 - A.x0), z = A.z0 + rnd() * (A.z1 - A.z0);
    const y = groundAt(x, z) + 0.2 + rnd() * 6;
    const o = [x, y, z];
    if (P.boxAt(x, y, z)) continue; // origin inside something solid
    const a = rnd() * Math.PI * 2, dy = (rnd() - 0.5) * 0.3, d = [Math.cos(a), dy, Math.sin(a)], L = Math.hypot(...d);
    d[0] /= L; d[1] /= L; d[2] /= L;
    const max = 15;
    rc.set(new T.Vector3(...o), new T.Vector3(...d)); rc.far = max;
    const vh = rc.intersectObjects(meshes, false)[0];
    const ph = P.castRay(o, d, max, 0x0001);
    const vd = vh ? vh.distance : Infinity, pd = ph ? ph.dist : Infinity;
    tested++;
    if (pd + 0.3 < vd) {
      const q = ph.point; let best = null, bd = 4;
      for (const pr of city.props) { const dd = Math.hypot(pr.x - q[0], pr.z - q[2]); if (dd < bd) { bd = dd; best = pr.id; } }
      note(invisible, ph.point, { tag: ph.tag, surf: ph.surf, normal: ph.normal.map((v) => +v.toFixed(2)), vis: vh ? vh.object.name : 'none', prop: best, pd: +bd.toFixed(1) });
    }
    else if (vd + 0.3 < pd) {
      const pt = [o[0] + d[0] * vd, o[1] + d[1] * vd, o[2] + d[2] * vd];
      // The drawn triangle that was hit (extent) and the static boxes nearby, to trace the generator.
      const pos = vh.object.geometry.attributes.position, f = vh.face, tri = [f.a, f.b, f.c].map((i) => [pos.getX(i), pos.getY(i), pos.getZ(i)]);
      const ext = [0, 1, 2].map((k) => [Math.min(...tri.map((v) => v[k])), Math.max(...tri.map((v) => v[k]))].map((v) => +v.toFixed(2)));
      const near = P.boxesNear(pt[0], pt[2], 1.2).filter((bx) => Math.abs(bx.c[1] - pt[1]) < bx.h[1] + 1).slice(0, 3).map((bx) => ({ c: bx.c.map((v) => +v.toFixed(2)), h: bx.h.map((v) => +v.toFixed(2)), s: bx.s }));
      note(nocol, pt, { mesh: vh.object.name, phys: ph ? +(pd - vd).toFixed(2) : 'none', n: [f.normal.x, f.normal.y, f.normal.z].map((v) => +v.toFixed(2)), ext, near });
    }
  }
  // B. navmesh vs walls
  let navTested = 0;
  for (let i = 0; i < NP; i++) {
    const r1 = nav.q.findRandomPoint(); if (!r1.success) continue;
    const a = r1.randomPoint, ang = rnd() * Math.PI * 2, len = 1 + rnd() * 7;
    const tgt = [a.x + Math.cos(ang) * len, a.y, a.z + Math.sin(ang) * len];
    const rr = nav.q.raycast(r1.randomPolyRef, a, { x: tgt[0], y: tgt[1], z: tgt[2] });
    if (!rr || rr.t < 1) continue; // navmesh says blocked: fine
    const bp = nav.q.findClosestPoint({ x: tgt[0], y: tgt[1], z: tgt[2] }); if (!bp.success) continue;
    const bb = bp.point;
    if (Math.abs(bb.y - a.y) > 0.8) continue; // stairs/ramps: skip
    navTested++;
    let blocked = 0;
    for (const h of [0.5, 1.2]) if (!P.clear([a.x, a.y + h, a.z], [bb.x, bb.y + h, bb.z])) blocked++;
    if (blocked === 2) {
      const dx = bb.x - a.x, dz = bb.z - a.z, L2 = Math.hypot(dx, dz);
      const hit = P.castRay([a.x, a.y + 0.8, a.z], [dx / L2, 0, dz / L2], L2);
      note(navx, hit ? hit.point : [a.x, a.y, a.z], { tag: hit ? hit.tag : -1, surf: hit ? hit.surf : '?' });
    }
  }
  const top = (m) => [...m.values()].sort((u, v) => v.n - u.n);
  return { tested, navTested, invisible: top(invisible), nocol: top(nocol), navx: top(navx), area: A };
}, { NR: Number(rays), NP: Number(pairs), RECT: rect ? rect.split(',').map(Number) : null });
console.log(`rays ${res.tested}: invisible-wall spots ${res.invisible.length}, no-collision spots ${res.nocol.length}; nav segments ${res.navTested}: through-wall spots ${res.navx.length}`);
const show = (name, l) => { console.log(`--- ${name} (top 25)`); for (const e of l.slice(0, 25)) console.log(JSON.stringify(e)); };
show('INVISIBLE (physics, nothing drawn)', res.invisible); show('NO COLLISION (drawn, physics passes)', res.nocol); show('NAVMESH THROUGH WALL', res.navx);
if (out) fs.writeFileSync(out, JSON.stringify(res, null, 1));
await b.close();

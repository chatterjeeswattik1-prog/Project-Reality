// Destruction check: blow holes in house walls (RPG, C4 at the foot of a wall, IED) in the test area, and report
// whether a ray now passes through the hole, the time each blast took, what fell, and screenshots before/after.
// Also fires a few tiny blasts that cut nothing big: nothing may fall from them (no false "floating" pieces).
//   node scripts/breach.mjs <outPrefix>
import { launch } from './browser.mjs';
const out = process.argv[2] || 'breach';
const b = await launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}]`, m.text().slice(0, 200)); });
const t0 = Date.now();
await p.goto(process.env.FULL ? 'http://localhost:5173/?q=medium&bots=0&shot=0,30,0,0,0' : 'http://localhost:5173/?mode=test&q=medium&bots=0&shot=0,30,0,0,0');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
console.log('load s', ((Date.now() - t0) / 1000).toFixed(1), JSON.stringify(await p.evaluate(() => window.__mem?.slice(-3))));
const targets = await p.evaluate(() => {
  const A = window.__city.area ?? { x0: -260, x1: 60, z0: -330, z1: -100 }, P = window.__game.P;
  const ok = window.__city.buildings.filter((x) => { const s = x.spec; return !s.hall && s.x0 > A.x0 + 5 && s.x1 < A.x1 - 5 && s.z0 > A.z0 + 5 && s.z1 < A.z1 - 5 && !s.party.includes('front'); });
  const res = [];
  for (const bi of ok) {
    const s = bi.spec, d = [[0, -1], [1, 0], [0, 1], [-1, 0]][s.orient], cx = (s.x0 + s.x1) / 2, cz = (s.z0 + s.z1) / 2;
    const half = s.orient % 2 === 0 ? (s.z1 - s.z0) / 2 : (s.x1 - s.x0) / 2, side = s.orient % 2 === 0 ? (s.x1 - s.x0) / 2 : (s.z1 - s.z0) / 2;
    // A point on the front wall away from the door (a quarter of the way along), 1.3 m above the ground floor.
    const tx = -d[1], tz = d[0], off = side * 0.45;
    const wx = cx + d[0] * half + tx * off, wz = cz + d[1] * half + tz * off, y = s.y0 + 0.15 + 1.3;
    const o = [wx + d[0] * 6 + tx * 1.5, y + 0.4, wz + d[1] * 6 + tz * 1.5], h = P.castRay(o, [-d[0], 0, -d[1]], 12);
    if (!h || Math.abs(h.dist - 6) > 0.2) continue;
    res.push({ id: bi.id, n: [d[0], 0, d[1]], wall: h.point, y0: s.y0 });
    if (res.length >= 4) break;
  }
  return res;
});
console.log('targets', targets.length);
const shoot = async (t, ammo, at, name) => {
  const view = await p.evaluate(([t]) => {
    const cam = window.__G.camera; window.__hold = true;
    cam.position.set(t.wall[0] + t.n[0] * 4.5 - t.n[2] * 1.5, t.wall[1] + 0.4, t.wall[2] + t.n[2] * 4.5 + t.n[0] * 1.5);
    cam.lookAt(t.wall[0], t.wall[1], t.wall[2]);
    return true;
  }, [t]);
  void view;
  await p.waitForTimeout(800);
  await p.screenshot({ path: `${out}_${name}_0.png` });
  const r = await p.evaluate(([t, ammo, at]) => {
    const g = window.__game, P = g.P, A = window.__AMMO[ammo];
    const e = [t.wall[0] + t.n[0] * 0.2, at === 'foot' ? t.y0 + 0.25 : t.wall[1], t.wall[2] + t.n[2] * 0.2];
    const probe = (y) => { const o = [t.wall[0] + t.n[0] * 3, y, t.wall[2] + t.n[2] * 3], h = P.castRay(o, [-t.n[0], 0, -t.n[2]], 8); return h ? +h.dist.toFixed(2) : 'none'; };
    const py = at === 'foot' ? t.y0 + 0.9 : t.wall[1];
    const before = probe(py), rm0 = g.destruct.removed;
    const t0 = performance.now();
    const br = g.destruct.blast(e, A.explosive.breach, A.explosive.light, 1.5);
    const ms = performance.now() - t0;
    g.fx.explosion(e, 1.5, t.n);
    for (const h of br.holes) { g.fx.dust(h.p, h.n, h.r); }
    return { prof: g.destruct.prof, before, after: probe(py), ms: +ms.toFixed(1), holes: br.holes.length, vol: +br.volume.toFixed(2), fell: br.fell, removed: g.destruct.removed - rm0 };
  }, [t, ammo, at]);
  console.log(name, JSON.stringify(r));
  await p.waitForTimeout(600);
  await p.screenshot({ path: `${out}_${name}_1.png` });
  await p.waitForTimeout(6000);
  await p.screenshot({ path: `${out}_${name}_2.png` });
  await p.waitForTimeout(14000);
  await p.screenshot({ path: `${out}_${name}_3.png` });
};
if (targets[0]) await shoot(targets[0], 'pg7vl', 'mid', 'rpg');
if (targets[1]) await shoot(targets[1], 'c4', 'foot', 'c4');
if (targets[2]) await shoot(targets[2], 'ied', 'foot', 'ied');
// Roof: C4 on a flat roof holes the slab (look down into the top floor).
const roof = await p.evaluate(() => {
  const g = window.__game, P = g.P, A = window.__city.area ?? { x0: -260, x1: 60, z0: -330, z1: -100 };
  const bi = window.__city.buildings.find((x) => x.roof.length && x.roof[0][0] > A.x0 + 10 && x.roof[0][0] < A.x1 - 10 && x.roof[0][2] > A.z0 + 10 && x.roof[0][2] < A.z1 - 10);
  if (!bi) return null;
  const r = bi.roof[0], down = () => { const h = P.castRay([r[0], r[1] + 1, r[2]], [0, -1, 0], 10); return h ? +h.dist.toFixed(2) : 'none'; };
  const before = down();
  const br = g.destruct.blast([r[0], r[1] + 0.1, r[2]], 1.3, 2, 1.5);
  const cam = window.__G.camera; cam.position.set(r[0] + 2.5, r[1] + 3.2, r[2] + 2.5); cam.lookAt(r[0], r[1] - 1, r[2]);
  return { before, after: down(), holes: br.holes.length, fell: br.fell, props: br.props };
});
console.log('roof', JSON.stringify(roof));
await p.waitForTimeout(9000);
await p.screenshot({ path: `${out}_roof.png` });
// Tiny blasts: nothing may fall.
const tiny = await p.evaluate(() => {
  const g = window.__game, A = window.__city.area ?? { x0: -260, x1: 60, z0: -330, z1: -100 }; let fell = 0, n = 0, s0 = 3;
  const rnd = () => ((s0 = (s0 * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 400 && n < 25; i++) {
    const x = A.x0 + rnd() * (A.x1 - A.x0), z = A.z0 + rnd() * (A.z1 - A.z0), y = 1 + rnd() * 8;
    const h = g.P.castRay([x, y, z], [1, 0, 0], 15); if (!h) continue;
    const r = g.destruct.blast([h.point[0] - 0.05, h.point[1], h.point[2]], 0.15, 0, 0.5); fell += r.fell; n++;
  }
  return { n, fell };
});
console.log('tiny blasts', JSON.stringify(tiny));
// Full pipeline: game.explode() with C4 next to a door (sound, cover cells, doors) — the door must go.
const door = await p.evaluate(() => {
  const g = window.__game, D = g.doors; const A = window.__city.area ?? { x0: -260, x1: 60, z0: -330, z1: -100 };
  const d = D.list.find((x) => x.w > 0 && x.hinge.x > A.x0 + 10 && x.hinge.x < A.x1 - 10 && x.hinge.z > A.z0 + 10 && x.hinge.z < A.z1 - 10);
  if (!d) return 'no door';
  const before = D.list.filter((x) => x.w > 0).length;
  g.explode([d.hinge.x + 0.5, d.hinge.y + 0.3, d.hinge.z + 0.5], window.__AMMO.c4, null);
  return { before, after: D.list.filter((x) => x.w > 0).length, gone: d.w === 0 };
});
console.log('door', JSON.stringify(door));
await p.waitForTimeout(3000);
const stats = await p.evaluate(() => ({ colliders: window.__game.P.world.colliders.len(), bodies: window.__game.P.world.bodies.len() }));
console.log('physics', JSON.stringify(stats));
await b.close();

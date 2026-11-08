// Crumbling check (test area): a C4 hole in an upper floor off-centre under a rug (it must fall through; furniture
// near the blast knocked over), and close-ups of an RPG and a C4 hole in house walls (ragged courses, bricks, marks).
//   node scripts/crumble.mjs <outPrefix>
import { launch } from './browser.mjs';
const out = process.argv[2] || 'crumble';
const b = await launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
p.on('pageerror', (e) => { errs.push(e.message); console.log('[pageerror]', e.message, (e.stack ?? '').split(String.fromCharCode(10)).slice(0, 5).join(' | ')); });
await p.goto('http://localhost:5173/?mode=test&q=high&bots=0&shot=0,30,0,0,0');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
await p.waitForTimeout(1500);
// 1. Furniture over a holed floor: an upper-floor room with furniture; C4 under the middle of its floor.
const room = await p.evaluate(() => {
  const g = window.__game, c = window.__city, A = c.area;
  for (const b of c.buildings) {
    for (const r of b.rooms) {
      if (r.floor < 1 || r.x0 < A.x0 + 8 || r.x1 > A.x1 - 8 || r.z0 < A.z0 + 8 || r.z1 > A.z1 - 8 || (r.x1 - r.x0) * (r.z1 - r.z0) < 12) continue;
      const inside = c.props.map((q, i) => [q, i]).filter(([q]) => q.x > r.x0 && q.x < r.x1 && q.z > r.z0 && q.z < r.z1 && Math.abs(q.y - r.y) < 0.3);
      if (inside.length < 3) continue;
      window.__room = { r, ids: inside.map(([, i]) => i) };
      const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2, cam = window.__G.camera; window.__hold = true;
      cam.position.set(r.x0 + 0.5, r.y + 2.4, r.z0 + 0.5); cam.lookAt(cx, r.y, cz);
      return { room: [r.x0, r.z0, r.x1, r.z1].map((x) => +x.toFixed(1)), y: r.y, props: inside.map(([q]) => q.id) };
    }
  }
  return null;
});
console.log('room', JSON.stringify(room));
if (room) {
  await p.waitForTimeout(1200);
  await p.screenshot({ path: `${out}_rug0.png` });
  await p.evaluate(() => { const g = window.__game, { r } = window.__room; g.explode([(r.x0 + r.x1) / 2, r.y - 0.55, (r.z0 + r.z1) / 2], window.__AMMO.c4, null, [0, -1, 0]); });
  await p.waitForTimeout(3500);
  console.log('after', await p.evaluate(() => { const g = window.__game, d = g.destruct, c = window.__city; return window.__room.ids.map((i) => `${c.props[i].id}:${d.propGone.has(i) ? 'fell/moved' : 'stays'}`).join(' '); }));
  await p.screenshot({ path: `${out}_rug1.png` });
  // From the room below, looking up at the hole in its ceiling.
  await p.evaluate(() => { const { r } = window.__room, cam = window.__G.camera, cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2; cam.position.set(cx + 1.6, r.y - 1.6, cz + 1.2); cam.lookAt(cx, r.y, cz); });
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `${out}_ceiling.png` });
}
// 2. Walls: an RPG and a C4 on house fronts; close-ups after the rubble settles.
const walls = await p.evaluate(() => {
  const A = window.__city.area, P = window.__game.P, out = [];
  for (const bi of window.__city.buildings) {
    const s = bi.spec; if (s.hall || s.x0 < A.x0 + 5 || s.x1 > A.x1 - 5 || s.z0 < A.z0 + 5 || s.z1 > A.z1 - 5 || s.party.includes('front')) continue;
    const d = [[0, -1], [1, 0], [0, 1], [-1, 0]][s.orient], cx = (s.x0 + s.x1) / 2, cz = (s.z0 + s.z1) / 2;
    const half = s.orient % 2 === 0 ? (s.z1 - s.z0) / 2 : (s.x1 - s.x0) / 2, side = s.orient % 2 === 0 ? (s.x1 - s.x0) / 2 : (s.z1 - s.z0) / 2, tx = -d[1], tz = d[0];
    const o = [cx + d[0] * (half + 6) + tx * side * 0.45, s.y0 + 1.8, cz + d[1] * (half + 6) + tz * side * 0.45], h = P.castRay(o, [-d[0], 0, -d[2] ?? -d[1]].length ? [-d[0], 0, -d[1]] : [0, 0, 0], 12);
    if (!h || Math.abs(h.dist - 6) > 0.2) continue;
    out.push({ n: [d[0], 0, d[1]], wall: h.point, y0: s.y0 });
    if (out.length >= 2) break;
  }
  return out;
});
for (const [k, [ammo, foot]] of [['pg7vl', false], ['c4', true]].entries()) {
  const t = walls[k]; if (!t) continue;
  await p.evaluate(([t, ammo, foot]) => {
    const g = window.__game, e = [t.wall[0] + t.n[0] * 0.2, foot ? t.y0 + 0.4 : t.wall[1], t.wall[2] + t.n[2] * 0.2];
    g.explode(e, window.__AMMO[ammo], null, t.n);
    const cam = window.__G.camera; window.__hold = true;
    cam.position.set(t.wall[0] + t.n[0] * 4 + t.n[2] * 1.2, e[1] + 0.6, t.wall[2] + t.n[2] * 4 - t.n[0] * 1.2); cam.lookAt(e[0], e[1], e[2]);
  }, [t, ammo, foot]);
  await p.waitForTimeout(16000);
  await p.screenshot({ path: `${out}_${ammo}.png` });
  // From inside the room, looking out through the breach.
  await p.evaluate(([t, foot]) => { const cam = window.__G.camera, y = foot ? t.y0 + 0.9 : t.wall[1]; cam.position.set(t.wall[0] - t.n[0] * 2.6 + t.n[2] * 0.4, y + 0.5, t.wall[2] - t.n[2] * 2.6 - t.n[0] * 0.4); cam.lookAt(t.wall[0], y, t.wall[2]); }, [t, foot]);
  await p.waitForTimeout(1200);
  await p.screenshot({ path: `${out}_${ammo}_in.png` });
}
console.log('errors', errs.length);
await b.close();

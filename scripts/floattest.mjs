// Floating check: a barrage (RPGs up a facade, C4 at its foot, a second-floor C4) on one house in the test area, then
// after the rubble settles: settled rubble with nothing under it, and pieces of wall left with nothing below them
// (fragments must rest on something or be bonded at a side into sound wall). Screenshot of the facade.
//   node scripts/floattest.mjs <outPrefix>
import { launch } from './browser.mjs';
const out = process.argv[2] || 'float';
const b = await launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
p.on('pageerror', (e) => { errs.push(e.message); console.log('[pageerror]', e.message); });
await p.goto('http://localhost:5173/?mode=test&q=high&bots=0&shot=0,30,0,0,0');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
await p.waitForTimeout(1500);
const t = await p.evaluate(() => {
  const A = window.__city.area, P = window.__game.P;
  for (const bi of window.__city.buildings) {
    const s = bi.spec; if (s.hall || s.floors < 2 || s.x0 < A.x0 + 5 || s.x1 > A.x1 - 5 || s.z0 < A.z0 + 5 || s.z1 > A.z1 - 5 || s.party.includes('front')) continue;
    const d = [[0, -1], [1, 0], [0, 1], [-1, 0]][s.orient], cx = (s.x0 + s.x1) / 2, cz = (s.z0 + s.z1) / 2;
    const half = s.orient % 2 === 0 ? (s.z1 - s.z0) / 2 : (s.x1 - s.x0) / 2;
    const o = [cx + d[0] * (half + 6), s.y0 + 1.6, cz + d[1] * (half + 6)], h = P.castRay(o, [-d[0], 0, -d[1]], 12);
    if (!h || Math.abs(h.dist - 6) > 0.2) continue;
    return { n: [d[0], 0, d[1]], wall: h.point, y0: s.y0, tan: [-d[1], 0, d[0]] };
  }
});
console.log('target', JSON.stringify(t));
const shots = [[0, 1.6, 'pg7vl'], [1.2, 2.4, 'pg7vl'], [-1.0, 4.6, 'pg7vl'], [0.4, 5.4, 'pg7vl'], [-0.8, 0.4, 'c4'], [1.8, 4.0, 'pg7vl'], [0.9, 0.4, 'c4']];
for (const [u, y, ammo] of shots) {
  await p.evaluate(([t, u, y, ammo]) => {
    const g = window.__game, e = [t.wall[0] + t.tan[0] * u + t.n[0] * 0.2, t.y0 + y, t.wall[2] + t.tan[2] * u + t.n[2] * 0.2];
    g.explode(e, window.__AMMO[ammo], null, t.n);
  }, [t, u, y, ammo]);
  await p.waitForTimeout(900);
}
await p.evaluate((t) => { const cam = window.__G.camera; window.__hold = true; cam.position.set(t.wall[0] + t.n[0] * 9 + t.tan[0] * 2, t.y0 + 3, t.wall[2] + t.n[2] * 9 + t.tan[2] * 2); cam.lookAt(t.wall[0], t.y0 + 3, t.wall[2]); }, t);
await p.waitForTimeout(3000);
await p.screenshot({ path: `${out}_mid.png` });
await p.waitForTimeout(22000);
const r = await p.evaluate((t) => {
  const d = window.__game.destruct, P = window.__game.P, T = d.T;
  let floating = 0, frozen = 0;
  for (const f of d.frozen.values()) {
    if (Math.hypot(f.p[0] - t.wall[0], f.p[2] - t.wall[2]) > 30) continue;
    frozen++;
    const half = Math.max(f.s.x, f.s.y, f.s.z) * 0.5, h = P.castRay(f.p, [0, -1, 0], half + 0.3, 1);
    if (!h) floating++;
  }
  // Fragments (made by cuts) near the facade with nothing at all under them and no side neighbour.
  let frag = 0, loose = 0;
  for (let i = d.n0; i < T.n; i++) {
    if (T.dead[i]) continue;
    const o = i * 6, bx = T.box; const c = [(bx[o] + bx[o + 3]) / 2, bx[o + 1], (bx[o + 2] + bx[o + 5]) / 2];
    if (Math.hypot(c[0] - t.wall[0], c[2] - t.wall[2]) > 12) continue;
    frag++;
    const h = P.castRay([c[0], c[1] + 0.02, c[2]], [0, -1, 0], 0.08, 1);
    if (!h) loose++;
  }
  return { active: d.active.length, frozen, floatingRubble: floating, fragments: frag, noFloorUnder: loose };
}, t);
console.log(JSON.stringify(r));
await p.screenshot({ path: `${out}_end.png` });
console.log('errors', errs.length);
await b.close();

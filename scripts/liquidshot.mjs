// Liquid blood on its own: a pool on open flat ground and one on the slope/edge nearest a kerb, beads spattered on a
// wall; photographed as they spread.  node scripts/liquidshot.mjs <outPrefix>
import { launch } from './browser.mjs';
const out = process.argv[2] || 'liquid';
const b = await launch();
const p = await b.newPage({ viewport: { width: 960, height: 540 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.goto('http://localhost:5173/?mode=test&q=medium&shot=0,0,0,0,0');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
const spot = await p.evaluate(() => {
  const g = window.__game, P = g.P, A = window.__city.area;
  for (const bt of window.__skirm.bots.values()) { bt.update = () => {}; bt.s.health = 1e6; bt.s.pos[1] -= 50; }
  let s0 = 5, best = null; const rnd = () => ((s0 = (s0 * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 3000 && !best; i++) {
    const x = A.x0 + rnd() * (A.x1 - A.x0), z = A.z0 + rnd() * (A.z1 - A.z0);
    const h = P.castRay([x, 60, z], [0, -1, 0], 120); if (!h || h.point[1] > 1) continue;
    let ok = true; for (let k = 0; k < 8 && ok; k++) { const a = k / 8 * Math.PI * 2; if (P.castRay([x, h.point[1] + 0.5, z], [Math.cos(a), 0, Math.sin(a)], 4)) ok = false; }
    if (ok) best = [x, h.point[1], z];
  }
  g.fx.liquid.pool(best, 1.1, 7);
  window.__hold = true;
  return best;
});
const cam = (o, t) => p.evaluate(({ o, t, s }) => { const c = window.__G.camera; c.position.set(s[0] + o[0], s[1] + o[1], s[2] + o[2]); c.lookAt(s[0] + t[0], s[1] + t[1], s[2] + t[2]); }, { o, t, s: spot });
for (const [tt, name] of [[2000, 'a'], [8000, 'b'], [20000, 'c']]) {
  await p.waitForTimeout(tt);
  await cam([0.9, 0.8, 0.9], [0, 0, 0]); await p.waitForTimeout(60); await p.screenshot({ path: `${out}_${name}.png` });
}
await cam([0.05, 1.3, 0.05], [0, 0, 0]); await p.waitForTimeout(60); await p.screenshot({ path: `${out}_top.png` });
await cam([-1.8, 0.6, -1.8], [0, 0, 0]); await p.waitForTimeout(60); await p.screenshot({ path: `${out}_low.png` });
await b.close();

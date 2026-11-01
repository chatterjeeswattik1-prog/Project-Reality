// M203 quadrant sight: aimed screenshots at a few range settings, and where a grenade fired level actually lands.
//   node scripts/glsight.mjs <outPrefix>
import { launch } from './browser.mjs';
const out = process.argv[2] || 'gl';
const b = await launch();
const p = await b.newPage({ viewport: { width: 960, height: 540 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.goto('http://localhost:5173/?mode=test&auto=us&kit=us_gren&q=medium&bots=0');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
await p.evaluate(() => {
  const g = window.__game, P = g.P, A = window.__city.area, s = g.player.s; window.__input.locked = true;
  for (const bt of window.__skirm?.bots?.values() ?? []) { bt.update = () => {}; bt.s.health = 1e6; }
  // open ground with 400 m of clear flat run to the north (-z) — or the longest found
  let best = null, bl = 0; let s0 = 3; const rnd = () => ((s0 = (s0 * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 3000; i++) {
    const x = A.x0 + rnd() * (A.x1 - A.x0), z = A.z0 + rnd() * (A.z1 - A.z0);
    const h = P.castRay([x, 60, z], [0, -1, 0], 120); if (!h || h.point[1] > 1) continue;
    const f = P.castRay([x, h.point[1] + 3, z], [0, 0, -1], 450); const L = f ? f.dist : 450;
    if (L > bl) { bl = L; best = [x, h.point[1], z]; }
  }
  s.pos = [best[0], best[1] + 0.05, best[2]]; s.body.setTranslation({ x: best[0], y: best[1] + 0.95, z: best[2] }, true); s.yaw = 0; s.pitch = 0;
  window.__boom = []; const ex = g.explode.bind(g); g.explode = (pt, a, by, n) => { window.__boom.push(pt); return ex(pt, a, by, n); };
  window.__clear = bl;
});
await p.keyboard.press('Digit1'); await p.waitForTimeout(1200);
console.log('clear run', await p.evaluate(() => window.__clear.toFixed(0)), 'under', await p.evaluate(() => window.__game.player.s.underSel));
for (const r of [50, 150, 300]) {
  const res = await p.evaluate(async (r) => {
    const g = window.__game, s = g.player.s, I = window.__input;
    s.glRange = r; s.pitch = 0; s.yaw = 0; I.mouse.right = true; s.slot.glLoaded = 1;
    await new Promise((q) => setTimeout(q, 1800));
    return { glLoaded: s.slot.glLoaded };
  }, r);
  await p.screenshot({ path: `${out}_${r}.png` });
  const land = await p.evaluate(async () => {
    const g = window.__game, s = g.player.s, I = window.__input; const n = window.__boom.length;
    s.pitch = 0; I.mouse.left = true; I.mouse.leftPressed = true; await new Promise((q) => setTimeout(q, 120)); I.mouse.left = false;
    for (let i = 0; i < 80 && window.__boom.length === n; i++) await new Promise((q) => setTimeout(q, 100));
    const b = window.__boom[n]; I.mouse.right = false;
    return b ? Math.hypot(b[0] - s.pos[0], b[2] - s.pos[2]).toFixed(0) : 'none';
  });
  console.log('range', r, 'landed at', land, JSON.stringify(res));
  await p.waitForTimeout(2500);
}
await b.close();

// Wound decals: shoot a standing bot (kept alive) in the chest, belly, arm and leg from the front, then photograph it
// from the front and the back.  node scripts/woundshot.mjs <outPrefix>
import { launch } from './browser.mjs';
const out = process.argv[2] || 'wound';
const b = await launch();
const p = await b.newPage({ viewport: { width: 960, height: 540 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.goto('http://localhost:5173/?mode=test&q=medium&shot=0,0,0,0,0');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
const r = await p.evaluate(() => {
  const g = window.__game, P = g.P, A = window.__city.area;
  const bots = [...window.__skirm.bots.values()];
  for (const bt of bots) { bt.update = () => {}; bt.s.health = 1e6; }
  let s0 = 7; const rnd = () => ((s0 = (s0 * 1664525 + 1013904223) >>> 0) / 4294967296);
  let best = null;
  for (let i = 0; i < 3000 && !best; i++) {
    const x = A.x0 + rnd() * (A.x1 - A.x0), z = A.z0 + rnd() * (A.z1 - A.z0);
    const h = P.castRay([x, 60, z], [0, -1, 0], 120); if (!h || h.point[1] > 1) continue;
    const y = h.point[1] + 1; let ok = true;
    for (let k = 0; k < 16 && ok; k++) { const a = k / 16 * Math.PI * 2; if (P.castRay([x, y, z], [Math.cos(a), 0, Math.sin(a)], 12)) ok = false; }
    if (ok) best = [x, h.point[1], z];
  }
  const place = (s, x, z, yaw) => { s.pos = [x, best[1] + 0.05, z]; s.body.setTranslation({ x, y: best[1] + 1, z }, true); s.yaw = yaw; s.vel = [0, 0, 0]; };
  const v = bots[0].s, sh = bots[3].s;
  place(v, best[0], best[2], Math.PI); place(sh, best[0], best[2] + 10, 0);
  window.__v = v; window.__sh = sh;
  return best;
});
await p.waitForTimeout(800);
await p.evaluate(() => {
  const g = window.__game, v = window.__v, sh = window.__sh, A = window.__AMMO;
  window.__hold = true; window.__G.camera.position.set(v.pos[0], v.pos[1] + 1.5, v.pos[2] + 3);
  const hits = [['chest', 1.35, 0.06], ['stomach', 1.05, -0.05], ['arm', 1.3, 0.24], ['leg', 0.55, -0.1]];
  for (const [part, h, x] of hits) g.hitSoldier(v, [v.pos[0] + x, v.pos[1] + h, v.pos[2] + 0.12], part, { ...A['762x39'], dmg: 1 }, sh);
  v.health = 1e6;
});
const shot = async (name, dz, wait) => {
  await p.waitForTimeout(wait);
  await p.evaluate((dz) => { window.__hold = true; const v = window.__v, c = window.__G.camera; c.position.set(v.pos[0] + 0.2, v.pos[1] + 1.25, v.pos[2] + dz); c.lookAt(v.pos[0], v.pos[1] + 1.0, v.pos[2]); }, dz);
  await p.waitForTimeout(40);
  await p.screenshot({ path: `${out}_${name}.png` });
};
await shot('front0', 2.0, 300);
await shot('front1', 2.0, 3500);
await shot('back', -2.0, 100);
console.log(await p.evaluate(() => window.__game.rigs.get(window.__v.id).wounds.map((w) => [w.m.parent.name, +w.size.toFixed(2)])));
await b.close();

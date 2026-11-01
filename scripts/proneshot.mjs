// A bot lying prone and aiming (at level, and up at a target 3 m higher), photographed from the front, side and
// above.  node scripts/proneshot.mjs <outPrefix> [weapon]
import { launch } from './browser.mjs';
const [out = 'prone', weapon = ''] = process.argv.slice(2);
const b = await launch();
const p = await b.newPage({ viewport: { width: 800, height: 450 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.goto('http://localhost:5173/?mode=test&q=medium&shot=0,0,0,0,0');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
await p.evaluate((weapon) => {
  const g = window.__game, P = g.P, A = window.__city.area;
  const bots = [...window.__skirm.bots.values()];
  for (const bt of bots) { bt.update = () => {}; bt.s.health = 1e6; }
  let s0 = 7; const rnd = () => ((s0 = (s0 * 1664525 + 1013904223) >>> 0) / 4294967296);
  let best = null;
  for (let i = 0; i < 3000 && !best; i++) {
    const x = A.x0 + rnd() * (A.x1 - A.x0), z = A.z0 + rnd() * (A.z1 - A.z0);
    const h = P.castRay([x, 60, z], [0, -1, 0], 120); if (!h || h.point[1] > 1) continue;
    let ok = true; for (let k = 0; k < 16 && ok; k++) { const a = k / 16 * Math.PI * 2; if (P.castRay([x, h.point[1] + 1, z], [Math.cos(a), 0, Math.sin(a)], 6)) ok = false; }
    if (ok) best = [x, h.point[1], z];
  }
  const bt = bots.find((x) => x.s.team === 'ins') ?? bots[4], s = bt.s;
  if (weapon) { const i = s.slots.findIndex((x) => x.def.id === weapon); if (i >= 0) s.cur = i; }
  s.pos = [best[0], best[1] + 0.05, best[2]]; s.body.setTranslation({ x: best[0], y: best[1] + 0.95, z: best[2] }, true);
  s.yaw = 0; s.setStance('prone', g.time); s.lastShotT = g.time + 1e6; s.ads = 1;
  bt.update = () => { s.lastShotT = g.time; s.ads = 1; s.pitch = window.__pitch ?? 0; s.yaw = 0; };
  window.__v = s;
}, weapon);
const shots = [['front', [0, 0.6, -2.2]], ['side', [2.2, 0.6, -0.4]], ['top', [0.6, 2.4, 0.2]]];
for (const pitch of [0, 0.5]) {
  await p.evaluate((pt) => { window.__pitch = pt; }, pitch);
  await p.waitForTimeout(1500);
  for (const [n, o] of shots) {
    await p.evaluate((o) => { window.__hold = true; const s = window.__v, c = window.__G.camera; c.position.set(s.pos[0] + o[0], s.pos[1] + o[1], s.pos[2] + o[2]); c.lookAt(s.pos[0], s.pos[1] + 0.25, s.pos[2] - 0.4); }, o);
    await p.waitForTimeout(80);
    await p.screenshot({ path: `${out}_${pitch}_${n}.png` });
  }
}
console.log(await p.evaluate(() => window.__v.weapon.id));
await b.close();

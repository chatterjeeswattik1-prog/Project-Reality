// Ragdoll check: put a bot in the open, shoot it down (wounded), film the fall; then kill it on the ground and film;
// then a standing kill with a head shot. Logs body positions (no flying off, no sinking).  node scripts/ragfilm.mjs <outPrefix>
import { launch } from './browser.mjs';
const out = process.argv[2] || 'rag';
const b = await launch();
const p = await b.newPage({ viewport: { width: 960, height: 540 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
p.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text()); });
await p.goto('http://localhost:5173/?mode=test&q=medium&shot=0,0,0,0,0');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
await p.evaluate(() => {
  const g = window.__game, P = g.P, A = window.__city.area;
  const bots = [...window.__skirm.bots.values()];
  for (const bt of bots) { bt.update = () => {}; bt.s.health = 1e6; }
  let s0 = 7; const rnd = () => ((s0 = (s0 * 1664525 + 1013904223) >>> 0) / 4294967296);
  let best = null;
  for (let i = 0; i < 3000 && !best; i++) {
    const x = A.x0 + rnd() * (A.x1 - A.x0), z = A.z0 + rnd() * (A.z1 - A.z0);
    const h = P.castRay([x, 60, z], [0, -1, 0], 120); if (!h || h.point[1] > 1) continue;
    const y = h.point[1] + 1; let ok = true;
    for (let k = 0; k < 16 && ok; k++) { const a = k / 16 * Math.PI * 2; if (P.castRay([x, y, z], [Math.cos(a), 0, Math.sin(a)], 7)) ok = false; }
    if (ok) best = [x, h.point[1], z];
  }
  window.__spot = best;
  const place = (bt, dx, dz, yaw) => { const s = bt.s; s.health = 100; s.pos = [best[0] + dx, best[1] + 0.05, best[2] + dz]; s.body.setTranslation({ x: s.pos[0], y: s.pos[1] + 0.95, z: s.pos[2] }, true); s.yaw = yaw; s.vel = [0, 0, 0]; };
  place(bots[0], 0, 0, Math.PI / 2);
  place(bots[1], 2.5, 1.5, 0);
  window.__v = [bots[0].s, bots[1].s];
});
const cam = (tgt, dist, side) => p.evaluate(({ tgt, dist, side }) => { const c = window.__G.camera, s = window.__v[tgt]; window.__hold = true; c.position.set(s.pos[0] + Math.cos(side) * dist, s.pos[1] + 1.2, s.pos[2] + Math.sin(side) * dist); c.lookAt(s.pos[0], s.pos[1] + 0.5, s.pos[2]); }, { tgt, dist, side });
const shoot = (tgt, part, dmg, h) => p.evaluate(({ tgt, part, dmg, h }) => {
  const g = window.__game, v = window.__v[tgt], A = window.__AMMO, me = [...window.__skirm.bots.values()][3].s;
  const pt = [v.pos[0], v.pos[1] + h, v.pos[2]];
  v.health = Math.min(v.health, dmg);
  g.hitSoldier(v, pt, part, { ...A['762x39'] }, me);
  return v.state;
}, { tgt, part, dmg, h });
const snap = async (pre, n, tgt, dist, side, gap = 120) => { for (let i = 0; i < n; i++) { await cam(tgt, dist, side); await p.waitForTimeout(30); await p.screenshot({ path: `${out}_${pre}${String(i).padStart(2, '0')}.png` }); await p.waitForTimeout(gap); } };
const body = (tgt) => p.evaluate((tgt) => { const r = window.__game.rigs.get(window.__v[tgt].id); const c = r.chest(); return { state: window.__v[tgt].state, chest: c && c.map((x) => +x.toFixed(2)), active: r.ragActive, ragged: r.ragged }; }, tgt);
await p.waitForTimeout(800);
await snap('a', 1, 0, 3.5, 0); console.log('before', JSON.stringify(await body(0)), await p.evaluate(() => JSON.stringify([window.__spot, window.__v[0].pos, window.__G.camera.position])));
console.log('down:', await shoot(0, 'chest', 20, 1.3));
await snap('a', 1 + 9, 0, 3.5, 0);
console.log(JSON.stringify(await body(0)));
await p.waitForTimeout(2500);
console.log('settled', JSON.stringify(await body(0)));
console.log('kill on ground:', await shoot(0, 'head', 100, 0.3));
await snap('b', 6, 0, 3.5, 0.0);
console.log(JSON.stringify(await body(0)));
// standing head shot on bot 1, close-up of wounds after
console.log('kill standing:', await shoot(1, 'chest', 200, 1.25));
await snap('c', 10, 1, 4, 1.2);
await p.waitForTimeout(3000);
console.log(JSON.stringify(await body(1)));
await snap('d', 1, 1, 1.6, 1.0);
await b.close();

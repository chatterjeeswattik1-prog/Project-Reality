// Blood check: a bot standing in front of a wall is shot several times (spray onto the wall, drops on the ground), then
// killed; screenshots right after and after the pool has spread.  node scripts/bloodshot.mjs <outPrefix>
import { launch } from './browser.mjs';
const out = process.argv[2] || 'blood';
const b = await launch();
const p = await b.newPage({ viewport: { width: 960, height: 540 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.goto('http://localhost:5173/?mode=test&q=medium&shot=0,0,0,0,0');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
await p.evaluate(async () => {
  const g = window.__game, P = g.P, A = window.__city.area;
  const bots = [...window.__skirm.bots.values()];
  for (const bt of bots) { bt.update = () => {}; bt.s.health = 1e6; }
  let s0 = 11, spot = null; const rnd = () => ((s0 = (s0 * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 4000 && !spot; i++) {
    const x = A.x0 + rnd() * (A.x1 - A.x0), z = A.z0 + rnd() * (A.z1 - A.z0);
    const h = P.castRay([x, 60, z], [0, -1, 0], 120); if (!h || h.point[1] > 1) continue;
    const a = rnd() * Math.PI * 2, d = [Math.cos(a), 0, Math.sin(a)];
    const w = P.castRay([x, h.point[1] + 1.2, z], d, 4); if (!w || Math.abs(w.normal[1]) > 0.2 || w.dist < 2) continue;
    if (P.castRay([x, h.point[1] + 1.2, z], [-d[0], 0, -d[2]], 8)) continue;
    spot = { x: w.point[0] + w.normal[0] * 1.2, y: h.point[1], z: w.point[2] + w.normal[2] * 1.2, n: [w.normal[0], w.normal[2]] };
  }
  const v = bots[0].s, sh = bots[3].s;
  v.pos = [spot.x, spot.y + 0.05, spot.z]; v.body.setTranslation({ x: spot.x, y: spot.y + 0.95, z: spot.z }, true); v.yaw = Math.atan2(-spot.n[0], -spot.n[1]);
  sh.pos = [spot.x + spot.n[0] * 8, spot.y + 0.05, spot.z + spot.n[1] * 8]; sh.body.setTranslation({ x: sh.pos[0], y: spot.y + 0.95, z: sh.pos[2] }, true);
  window.__hold = true; const c = window.__G.camera;
  c.position.set(spot.x + spot.n[0] * 3.2 + spot.n[1] * 1.2, spot.y + 2.1, spot.z + spot.n[1] * 3.2 - spot.n[0] * 1.2); c.lookAt(spot.x - spot.n[0] * 0.5, spot.y + 0.5, spot.z - spot.n[1] * 0.5);
  window.__v = v; window.__sh = sh; window.__spot = spot;
  await new Promise((r) => setTimeout(r, 800));
  const Am = window.__AMMO;
  for (let k = 0; k < 4; k++) { g.hitSoldier(v, [v.pos[0], v.pos[1] + 1.0 + k * 0.12, v.pos[2]], 'chest', { ...Am['762x39'], dmg: 5 }, sh); v.health = 1e6; await new Promise((r) => setTimeout(r, 250)); }
  v.health = 10; g.hitSoldier(v, [v.pos[0], v.pos[1] + 1.3, v.pos[2]], 'chest', { ...Am['762x39'] }, sh);
});
const close = (k) => p.evaluate((k) => { const v = window.__v, c = window.__G.camera, r = window.__game.rigs.get(v.id).chest(); if (k === 'wall') { c.position.set(window.__spot.x + window.__spot.n[0] * 1.6, window.__spot.y + 1.3, window.__spot.z + window.__spot.n[1] * 1.6); c.lookAt(window.__spot.x - window.__spot.n[0] * 1.2, window.__spot.y + 1.0, window.__spot.z - window.__spot.n[1] * 1.2); } else { c.position.set(r[0] + 1.3, v.pos[1] + 1.1, r[2] + 0.9); c.lookAt(r[0], v.pos[1], r[2]); } }, k);
await p.waitForTimeout(2000); await p.screenshot({ path: `${out}_0.png` });
await p.waitForTimeout(8000); await close('pool'); await p.waitForTimeout(100); await p.screenshot({ path: `${out}_pool10.png` });
await close('wall'); await p.waitForTimeout(100); await p.screenshot({ path: `${out}_wall.png` });
await p.waitForTimeout(20000); await close('pool'); await p.waitForTimeout(100); await p.screenshot({ path: `${out}_pool30.png` });
await b.close();

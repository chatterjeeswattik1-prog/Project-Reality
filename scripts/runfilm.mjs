// Film a bot moving in the open from the side (gait check).  node scripts/runfilm.mjs <outPrefix> <gait: sprint|run|walk|crouch|crouchrun> [frames=12] [side=90]
import { launch } from './browser.mjs';
const [out, gait = 'sprint', frames = '12', sideDeg = '90'] = process.argv.slice(2);
const b = await launch();
const p = await b.newPage({ viewport: { width: 960, height: 540 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.goto('http://localhost:5173/?mode=test&q=medium&shot=0,0,0,0,0');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
await p.evaluate((G) => {
  const g = window.__game, P = g.P, city = window.__city, A = city.area;
  const bots = [...window.__skirm.bots.values()];
  for (const bt of bots) { bt.update = () => {}; bt.s.health = 1e6; }
  // open spot: 14 m clear in 16 directions at 1 m, and 30 m along +x
  let best = null;
  let s0 = 7; const rnd = () => ((s0 = (s0 * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 3000 && !best; i++) {
    const x = A.x0 + rnd() * (A.x1 - A.x0), z = A.z0 + rnd() * (A.z1 - A.z0);
    const h = P.castRay([x, 60, z], [0, -1, 0], 120); if (!h || h.point[1] > 1) continue;
    const y = h.point[1] + 1; let ok = true;
    for (let k = 0; k < 16 && ok; k++) { const a = k / 16 * Math.PI * 2; if (P.castRay([x, y, z], [Math.cos(a), 0, Math.sin(a)], 9)) ok = false; }
    if (ok && !P.castRay([x, y, z], [1, 0, 0], 40)) best = [x, h.point[1], z];
  }
  const bt = bots[0], s = bt.s;
  s.pos = [best[0], best[1] + 0.05, best[2]]; s.body.setTranslation({ x: best[0], y: best[1] + 0.95, z: best[2] }, true);
  s.yaw = -Math.PI / 2; // facing +x
  const st = G === 'crouch' || G === 'crouchrun' ? 'crouch' : 'stand';
  s.setStance(st, g.time);
  bt.update = (dt) => {
    s.sprinting = G === 'sprint'; s.yaw = -Math.PI / 2;
    const sp = G === 'walk' ? 1.4 : G === 'crouch' ? 1.0 : G === 'crouchrun' ? 2.2 : s.maxSpeed();
    s.move(dt, [sp, 0], false);
  };
  window.__film = s;
}, gait);
await p.waitForTimeout(1500);
for (let i = 0; i < Number(frames); i++) {
  const info = await p.evaluate((SD) => {
    const t = window.__film, cam = window.__G.camera, a = SD * Math.PI / 180;
    // camera at angle a from the soldier's facing (+x), 4.5 m, a little ahead
    cam.position.set(t.pos[0] + Math.cos(a) * 4.5 + 0.8, t.pos[1] + 1.2, t.pos[2] + Math.sin(a) * 4.5);
    cam.lookAt(t.pos[0], t.pos[1] + 0.95, t.pos[2]);
    return Math.hypot(t.vel[0], t.vel[2]).toFixed(2) + ' ' + t.stance;
  }, Number(sideDeg));
  if (i === 0) console.log('speed', info);
  await p.waitForTimeout(30);
  await p.screenshot({ path: `${out}_${String(i).padStart(2, '0')}.png` });
  await p.waitForTimeout(40);
}
await b.close();

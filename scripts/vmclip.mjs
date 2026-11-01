// Viewmodel against walls: stand the player close to a wall (and on a roof at a parapet), facing it, and screenshot.
//   node scripts/vmclip.mjs <outPrefix>
import { launch } from './browser.mjs';
const out = process.argv[2] || 'vmclip';
const b = await launch();
const p = await b.newPage({ viewport: { width: 960, height: 540 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.goto('http://localhost:5173/?mode=test&auto=us');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
const spots = await p.evaluate(() => {
  const g = window.__game, P = g.P, city = window.__city;
  for (const bt of window.__skirm.bots.values()) { bt.update = () => {}; bt.s.health = 1e6; }
  const s = g.player.s, res = [];
  // 1. a wall near the spawn
  for (let k = 0; k < 32; k++) {
    const a = k / 32 * Math.PI * 2, d = [Math.cos(a), 0, Math.sin(a)];
    const h = P.castRay([s.pos[0], s.pos[1] + 1.2, s.pos[2]], d, 15);
    if (h && Math.abs(h.normal[1]) < 0.2) { for (const dd of [0.45, 0.7, 0.95]) res.push({ x: h.point[0] + h.normal[0] * dd, y: s.pos[1], z: h.point[2] + h.normal[2] * dd, yaw: Math.atan2(h.normal[0], h.normal[2]), pitch: 0 }); break; }
  }
  // 2. a roof parapet: stand on a roof 0.45 m from its edge wall, looking down over it
  for (const B of city.buildings) {
    const sp = B.spec, cx = (sp.x0 + sp.x1) / 2, ry = B.roofY;
    const top = P.castRay([cx, ry + 3, sp.z1 - 1.2], [0, -1, 0], 6); if (!top) continue;
    const w = P.castRay([cx, top.point[1] + 0.5, sp.z1 - 1.2], [0, 0, 1], 3); if (!w) continue;
    res.push({ x: cx, y: top.point[1], z: w.point[2] - 0.45, yaw: Math.PI, pitch: -0.3, roof: true, crouch: true }); break;
  }
  return res;
});
console.log(JSON.stringify(spots));
let i = 0;
for (const sp of spots) for (const ads of [false, true]) {
  await p.evaluate(({ sp, ads }) => {
    const g = window.__game, s = g.player.s, I = window.__input;
    s.pos = [sp.x, sp.y + 0.05, sp.z]; s.body.setTranslation({ x: sp.x, y: sp.y + 0.95, z: sp.z }, true); s.vel = [0, 0, 0];
    s.yaw = sp.yaw; s.pitch = sp.pitch; I.mouse.right = ads; s.setStance(sp.crouch ? 'crouch' : 'stand', g.time);
  }, { sp, ads });
  await p.waitForTimeout(1200);
  const info = await p.evaluate(() => { const pl = window.__game.player; return { wall: pl.wallDist, pull: pl.vm.pull }; });
  console.log(i, ads ? 'ads' : 'hip', JSON.stringify(info));
  await p.screenshot({ path: `${out}_${i++}.png` });
}
await b.close();

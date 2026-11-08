// 25 mm against a house wall (test area): HE and AP bursts from 60 m, then what was cut and a screenshot.
//   node scripts/cannonwall.mjs <outPrefix>
import { launch } from './browser.mjs';
const out = process.argv[2] || 'cannonwall';
const b = await launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
p.on('pageerror', (e) => { errs.push(e.message); console.log('[pageerror]', e.message); });
await p.goto('http://localhost:5173/?mode=test&q=high&bots=0&auto=us');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
await p.waitForTimeout(1500);
const t = await p.evaluate(() => {
  const A = window.__city.area, P = window.__game.P;
  for (const bi of window.__city.buildings) {
    const s = bi.spec; if (s.hall || s.x0 < A.x0 + 5 || s.x1 > A.x1 - 5 || s.z0 < A.z0 + 5 || s.z1 > A.z1 - 5 || s.party.includes('front')) continue;
    const d = [[0, -1], [1, 0], [0, 1], [-1, 0]][s.orient], cx = (s.x0 + s.x1) / 2, cz = (s.z0 + s.z1) / 2;
    const half = s.orient % 2 === 0 ? (s.z1 - s.z0) / 2 : (s.x1 - s.x0) / 2;
    const o = [cx + d[0] * (half + 6), s.y0 + 1.6, cz + d[1] * (half + 6)], h = P.castRay(o, [-d[0], 0, -d[1]], 12);
    if (!h || Math.abs(h.dist - 6) > 0.2) continue;
    return { n: [d[0], 0, d[1]], wall: h.point, y0: s.y0, tan: [-d[1], 0, d[0]], surf: h.surf };
  }
});
console.log('wall', JSON.stringify(t));
const r0 = await p.evaluate(() => window.__game.destruct.removed);
const fire = (ammo, u, y) => p.evaluate(([t, ammo, u, y]) => {
  const g = window.__game, sh = g.player.s;
  const tgt = [t.wall[0] + t.tan[0] * u, t.y0 + y, t.wall[2] + t.tan[2] * u];
  const o = [tgt[0] + t.n[0] * 60, tgt[1] + 0.5, tgt[2] + t.n[2] * 60], d = [tgt[0] - o[0], tgt[1] - o[1], tgt[2] - o[2]], L = Math.hypot(...d);
  g.proj.fire(sh, null, ammo, o, d.map((x) => x / L), true);
}, [t, ammo, u, y]);
for (let k = 0; k < 6; k++) { await fire('25he', -1.2 + (k % 3) * 0.12, 1.4 + Math.floor(k / 3) * 0.12); await p.waitForTimeout(150); }
await p.waitForTimeout(800);
const r1 = await p.evaluate(() => window.__game.destruct.removed);
for (let k = 0; k < 6; k++) { await fire('25ap', 1.2 + (k % 3) * 0.1, 1.4 + Math.floor(k / 3) * 0.1); await p.waitForTimeout(150); }
await p.waitForTimeout(800);
const r2 = await p.evaluate(() => window.__game.destruct.removed);
console.log(JSON.stringify({ heRemoved: r1 - r0, apRemoved: r2 - r1 }));
const view = (t, back, name) => p.evaluate(([t, back]) => {
  const g = window.__game, me = g.player.s, k = back ? -2.4 : 5;
  const x = t.wall[0] + t.n[0] * k, z = t.wall[2] + t.n[2] * k;
  me.pos = [x, t.y0, z]; me.body.setTranslation({ x, y: t.y0 + 0.9, z }, true); me.vel = [0, 0, 0];
  me.yaw = Math.atan2(t.n[0] * (back ? -1 : 1), t.n[2] * (back ? -1 : 1)); me.pitch = -0.05;
  const vm = g.player.vm; vm.update = () => {}; vm.group.visible = false;
}, [t, back]);
await view(t, false); await p.waitForTimeout(3000); await p.screenshot({ path: `${out}_front.png` });
await view(t, true); await p.waitForTimeout(1200); await p.screenshot({ path: `${out}_inside.png` });
console.log('errors', errs.length);
await b.close();

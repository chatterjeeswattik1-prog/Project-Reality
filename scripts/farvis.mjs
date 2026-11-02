// Distant-enemy visibility: on the full map find a long clear sight line from street level, stand enemy soldiers at
// 100, 200 and 300 m along it (and one prone at 150 m), screenshot from the player's eye, hip and aimed.
//   node scripts/farvis.mjs <outPrefix> [q=medium]
import { launch } from './browser.mjs';
const [out = 'farvis', q = 'medium'] = process.argv.slice(2);
const b = await launch();
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.goto(`http://localhost:${process.env.PORT ?? 5173}/?auto=us&q=${q}`);
await p.waitForFunction(() => window.__ready === true, null, { timeout: 400000 });
const info = await p.evaluate(() => {
  const g = window.__game, P = g.P, me = g.player.s;
  for (const s of g.soldiers) if (!s.isPlayer) { s.health = 1e6; }
  window.__fullDirector && (window.__fullDirector.update = () => {});
  // a clear line ≥ 320 m at 1.5 m height from somewhere on the open ground
  let best = null;
  for (let tries = 0; tries < 4000 && !best; tries++) {
    const x = (Math.random() - 0.5) * 1100, z = (Math.random() - 0.5) * 1100;
    const h = P.castRay([x, 80, z], [0, -1, 0], 160); if (!h || h.point[1] > 3) continue;
    const a = Math.random() * Math.PI * 2, d = [Math.cos(a), 0, Math.sin(a)];
    const o = [x, h.point[1] + 1.6, z];
    if (P.castRay(o, d, 330)) continue;
    // the ground along it must exist (no falling off the map)
    const e = P.castRay([x + d[0] * 300, 80, z + d[2] * 300], [0, -1, 0], 160); if (!e || Math.abs(e.point[1] - h.point[1]) > 6) continue;
    best = { o, d, y: h.point[1] };
  }
  if (!best) return null;
  me.pos = [best.o[0], best.y + 0.05, best.o[2]]; me.body.setTranslation({ x: best.o[0], y: best.y + 0.95, z: best.o[2] }, true);
  me.yaw = Math.atan2(-best.d[0], -best.d[2]); me.pitch = 0; me.health = 1e6;
  const ins = g.soldiers.filter((s) => s.team === 'ins' && s.alive);
  const place = (s, dist, side, prone) => {
    const x = best.o[0] + best.d[0] * dist - best.d[2] * side, z = best.o[2] + best.d[2] * dist + best.d[0] * side;
    const h = P.castRay([x, 80, z], [0, -1, 0], 160); const y = h ? h.point[1] : best.y;
    s.pos = [x, y + 0.05, z]; s.body.setTranslation({ x, y: y + 0.95, z }, true); s.yaw = me.yaw + Math.PI; s.vel = [0, 0, 0];
    if (prone) s.setStance('prone', g.time);
  };
  const bots = window.__fullDirector?.bots ?? [];
  for (const bt of (bots.values ? [...bots.values()] : bots)) bt.update = () => {};
  place(ins[0], 100, 3, false); place(ins[1], 200, -4, false); place(ins[2], 300, 2, false); place(ins[3], 150, -2, true);
  return { o: best.o.map((v) => +v.toFixed(0)), n: ins.length };
});
console.log(JSON.stringify(info));
await p.waitForTimeout(2500);
await p.screenshot({ path: `${out}_hip.png` });
await p.evaluate(() => { window.__input.locked = true; window.__input.mouse.right = true; });
await p.waitForTimeout(1500);
await p.screenshot({ path: `${out}_ads.png` });
await b.close();

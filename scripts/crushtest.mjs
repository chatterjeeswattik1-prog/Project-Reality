// Crushing check (full map): the player drives an M1A2 east into the North Woods for 8 s; then the AI drives the
// other through a farmstead's garden wall. Reports what went down, and screenshots.
//   node scripts/crushtest.mjs <outPrefix>
import { launch } from './browser.mjs';
const out = process.argv[2] || 'crush';
const b = await launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message, (e.stack ?? '').split(String.fromCharCode(10)).slice(0, 6).join(' | ')));
await p.goto('http://localhost:5173/?q=medium&auto=us&kit=us_crew&nobots');
await p.waitForFunction(() => window.__ready === true && window.__game?.player, null, { timeout: 300000 });
const I = (js) => p.evaluate(js);
await p.waitForTimeout(2000);
await I(`(() => { const g = window.__game, v = g.vehicles[0], me = g.player.s; const gy = (x, z) => g.P.castRay([x, 300, z], [0, -1, 0], 600, 1).point[1]; v.body.setTranslation({ x: 688, y: gy(688, -220) + 0.4, z: -220 }, true); v.body.setRotation({ x: 0, y: Math.sin(-Math.PI / 4), z: 0, w: Math.cos(-Math.PI / 4) }, true); g.player.vc.trySeat(me, v, 0); })()`);
await p.waitForTimeout(2500);
await I(`window.__input.down.add('KeyW')`);
for (let i = 0; i < 16; i++) { await p.waitForTimeout(500); await p.screenshot({ path: `${out}_w${i}.png` }); }
await I(`window.__input.down.delete('KeyW')`);
console.log('woods', await I(`(() => { const g = window.__game, v = g.vehicles[0]; return JSON.stringify({ pos: v.pos().map((x) => +x.toFixed(0)), kmh: +(v.vf * 3.6).toFixed(0), crushed: g.destruct.propGone.size, removed: g.destruct.removed }); })()`));
// Third-person look back at the lane.
await I(`(() => { const g = window.__game, v = g.vehicles[0], me = g.player.s; v.exit(me, true); })()`);
await p.waitForTimeout(300);
await I(`(() => { const v = window.__game.vehicles[0], q = v.pos(), cam = window.__G.camera; window.__hold = true; window.__game.player.s.pos = [q[0] + 10, q[1], q[2] + 12]; })()`);
await p.waitForTimeout(1500);
await p.screenshot({ path: `${out}_lane.png` });
// AI through a compound: find a farmstead wall and drive the other tank to the far side of it.
const r = await I(`(() => { const g = window.__game, v = g.vehicles[1];
  const b = window.__city.buildings.find((x) => window.__city.districtOf.get(x.id) === 'rural' && x.spec.x0 > 540 && x.spec.x0 < 660);
  if (!b) return 'no farm';
  const cx = (b.spec.x0 + b.spec.x1) / 2, cz = (b.spec.z0 + b.spec.z1) / 2;
  const gy = (x, z) => g.P.castRay([x, 300, z], [0, -1, 0], 600, 1).point[1];
  v.body.setTranslation({ x: cx, y: gy(cx, cz + 45) + 0.4, z: cz + 45 }, true); v.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
  setTimeout(() => { v.ai.path = [[cx, 0, cz - 45]]; v.ai.goal = [cx, 0, cz - 45]; v.ai.pi = 0; }, 1500);
  return { farm: [cx, cz] }; })()`);
console.log('farm', JSON.stringify(r));
for (let i = 0; i < 6; i++) { await p.waitForTimeout(5000); console.log('  ai', await I(`(() => { const g = window.__game, v = g.vehicles[1]; return JSON.stringify({ pos: v.pos().map((x) => +x.toFixed(0)), kmh: +(v.vf * 3.6).toFixed(0), goal: !!v.ai.goal, pts: v.ai.path.length, removed: g.destruct.removed }); })()`)); }
await b.close();

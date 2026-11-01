// Fire a burst in the test area, look down at the feet and screenshot (are cases visible?).  node scripts/caseshot.mjs out.png
import { launch } from './browser.mjs';
const out = process.argv[2] || 'caseshot.png';
const b = await launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.goto('http://localhost:5173/?mode=test&auto=us');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
const r = await p.evaluate(async () => {
  const g = window.__game, I = window.__input; const s = g.player.s;
  for (const bt of window.__skirm.bots.values()) { bt.update = () => {}; bt.s.health = 1e6; }
  s.pitch = -0.2; s.slot.loaded = s.weapon.mag; s.slot.mode = 'auto';
  I.mouse.left = true; I.mouse.leftPressed = true;
  await new Promise((r) => setTimeout(r, 1500));
  I.mouse.left = false;
  await new Promise((r) => setTimeout(r, 2500));
  const cs = g.fx.cs.filter(Boolean), yaw0 = s.yaw;
  const c0 = cs[0].p, dx = c0.x - s.pos[0], dz = c0.z - s.pos[2];
  const rel = [dx * Math.cos(yaw0) - dz * Math.sin(yaw0), -(dx * -Math.sin(yaw0) + dz * -Math.cos(yaw0))]; // [right, back]
  s.yaw = Math.atan2(-dx, -dz); s.pitch = -Math.atan2(1.6, Math.hypot(dx, dz));
  await new Promise((r) => setTimeout(r, 600));
  return { rel, n: cs.length, me: s.pos.map((v) => +v.toFixed(2)), cs: cs.slice(0, 8).map((c) => [c.p.x, c.p.y, c.p.z].map((v) => +v.toFixed(2)).concat([c.rest ? 1 : 0, +c.floor.toFixed(2)])), count: g.fx.cases.count, vis: g.fx.cases.visible, inScene: !!g.fx.cases.parent };
});
console.log(JSON.stringify(r));
await p.screenshot({ path: out });
await b.close();

// Settled-body check: drop 8 soldiers (shot down from standing, running, crouched; on open ground), wait for them to
// settle, and report each body's bone heights above the ground (a body lying flat has torso/thighs ~0.1–0.2 m up; a
// "plank" propped on head and heels has them much higher). Screenshot from low to the side.
//   node scripts/ragsettle.mjs <outPrefix>
import { launch } from './browser.mjs';
const out = process.argv[2] || 'settle';
const b = await launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.goto('http://localhost:5173/?mode=test&q=medium&shot=0,0,0,0,0');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
const spot = await p.evaluate(async () => {
  const g = window.__game, P = g.P, A = window.__city.area, bots = [...window.__skirm.bots.values()];
  for (const bt of bots) { bt.update = () => {}; bt.s.health = 1e6; }
  let s0 = 7, best = null; const rnd = () => ((s0 = (s0 * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 3000 && !best; i++) {
    const x = A.x0 + rnd() * (A.x1 - A.x0), z = A.z0 + rnd() * (A.z1 - A.z0);
    const h = P.castRay([x, 60, z], [0, -1, 0], 120); if (!h || h.point[1] > 1) continue;
    let ok = true; for (let k = 0; k < 16 && ok; k++) { const a = k / 16 * Math.PI * 2; if (P.castRay([x, h.point[1] + 1, z], [Math.cos(a), 0, Math.sin(a)], 9)) ok = false; }
    if (ok) best = [x, h.point[1], z];
  }
  const sh = bots[bots.length - 1].s, A2 = window.__AMMO;
  const vs = bots.slice(0, 8).filter((x) => x.s !== sh);
  vs.forEach((bt, i) => {
    const s = bt.s, x = best[0] + (i % 4) * 2.2 - 3.3, z = best[2] + Math.floor(i / 4) * 3 - 1.5;
    s.pos = [x, best[1] + 0.05, z]; s.body.setTranslation({ x, y: best[1] + 0.95, z }, true); s.yaw = i * 0.9; s.vel = [0, 0, 0];
    if (i % 3 === 1) { s.vel = [Math.sin(s.yaw) * -4, 0, Math.cos(s.yaw) * -4]; s.sprinting = true; }
    if (i % 3 === 2) s.setStance('crouch', g.time);
  });
  await new Promise((r) => setTimeout(r, 800));
  vs.forEach((bt, i) => { const s = bt.s; s.health = 10; g.hitSoldier(s, [s.pos[0], s.pos[1] + 1.3, s.pos[2]], i % 2 ? 'chest' : 'head', { ...A2['762x39'] }, sh); });
  window.__vs = vs.map((x) => x.s); window.__rigs = vs.map((x) => g.rigs.get(x.s.id)); window.__spot = best;
  return best;
});
await p.waitForTimeout(9000);
const r = await p.evaluate(() => {
  const g = window.__game, P = g.P, T = window.__THREE;
  return window.__vs.map((s, i) => {
    const rig = window.__rigs[i]; if (!rig) return 'no rig';
    const gap = (n) => { const v = rig.bones[n].getWorldPosition(new T.Vector3()); const h = P.castRay([v.x, v.y + 0.5, v.z], [0, -1, 0], 5, 1); return h ? +(v.y - h.point[1]).toFixed(2) : null; };
    return { state: s.state, active: rig.ragActive, pelvis: gap('pelvis'), chest: gap('spine_03'), head: gap('Head'), thighL: gap('thigh_l'), calfL: gap('calf_l'), footL: gap('foot_l'), footR: gap('foot_r') };
  });
});
for (const x of r) console.log(JSON.stringify(x));
await p.evaluate(() => { window.__hold = true; const c = window.__G.camera, s = window.__spot; c.position.set(s[0] - 6, s[1] + 0.8, s[2] + 5); c.lookAt(s[0], s[1] + 0.2, s[2]); });
await p.waitForTimeout(300); await p.screenshot({ path: `${out}_side.png` });
await b.close();

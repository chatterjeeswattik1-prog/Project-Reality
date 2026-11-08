// Abrams commander on the CROWS .50 (sandbox): the mount slews after the aim (nodes move), the view is its sight
// camera, a burst at a target dummy hits it (no impacts on the tank itself, no stray blasts), and a rifle round at where
// the commander's head would be does not touch him (he is inside).   node scripts/cmdrtest.mjs <outPrefix>
import { launch } from './browser.mjs';
const out = process.argv[2] || 'cmdr';
const b = await launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
p.on('pageerror', (e) => { errs.push(e.message); console.log('[pageerror]', e.message); });
await p.goto('http://localhost:5173/?mode=sandbox&q=medium&auto=us&kit=us_crew');
await p.waitForFunction(() => window.__ready === true && window.__game?.player, null, { timeout: 300000 });
await p.waitForTimeout(1500);
await p.evaluate(() => {
  // Open ground: the first spot with nothing within 40 m at 2.5 m height in 16 directions (the farmland has orchards).
  const g = window.__game, me = g.player.s;
  let at = [640, 110];
  search: for (let x = 300; x <= 950; x += 50) for (let z = -600; z <= 600; z += 50) {
    const h = g.P.castRay([x, 300, z], [0, -1, 0], 600, 1); if (!h) continue;
    for (let k = 0; k < 16; k++) { const a = k / 16 * Math.PI * 2; if (g.P.castRay([x, h.point[1] + 2.5, z], [Math.cos(a), 0, Math.sin(a)], 40)) continue search; }
    at = [x, z]; break search;
  }
  const h = g.P.castRay([at[0], 300, at[1]], [0, -1, 0], 600, 1);
  me.pos = [at[0], h.point[1] + 0.05, at[1]]; me.body.setTranslation({ x: at[0], y: h.point[1] + 0.95, z: at[1] }, true); me.yaw = Math.PI / 2;
  console.log('open ground at', at);
  const t = window.__tools; t.toggle(true); t.act('m1a2');
});
await p.waitForTimeout(3000);
const r1 = await p.evaluate(async () => {
  const g = window.__game, me = g.player.s, v = g.vehicles.filter((x) => x.def.id === 'm1a2').pop(); window.__v = v;
  g.player.vc.trySeat(me, v, v.seats.findIndex((s) => s.def.role === 'commander'));
  await new Promise((r) => setTimeout(r, 800));
  const mt = v.mountsOf(v.seatOf(me))[0]; window.__mt = mt;
  return { seat: v.seats[v.seatOf(me)].def.label, node: mt.def.node };
});
console.log(JSON.stringify(r1));
await p.screenshot({ path: `${out}_ahead.png` });
// Swing 70° right and 15° up: the gun follows at its slew rate.
const swing = await p.evaluate(async () => {
  const mt = window.__mt, v = window.__v; mt.aimYaw = -1.22; mt.aimPitch = 0.26;
  const t = []; for (let k = 0; k < 6; k++) { await new Promise((r) => setTimeout(r, 150)); t.push(`${mt.yaw.toFixed(2)}/${mt.pitch.toFixed(2)}`); }
  const gun = v.nodes.get('cws_gun'), post = v.nodes.get('cws');
  return { track: t.join(' '), nodes: `post.rotY ${post.rotation.y.toFixed(2)} gun.rotX ${gun.rotation.x.toFixed(2)}` };
});
console.log('swing', JSON.stringify(swing));
await p.waitForTimeout(600);
await p.screenshot({ path: `${out}_swung.png` });
// A target dummy 60 m out where the gun points (level); fire a burst.
const res = await p.evaluate(async () => {
  const g = window.__game, me = g.player.s, v = window.__v, mt = window.__mt, seat = v.seatOf(me);
  mt.aimYaw = 0; mt.aimPitch = 0; await new Promise((r) => setTimeout(r, 1500));
  const d = v.nodeDir('cws_gun'), o = v.nodePos('cws_muzzle'), L = Math.hypot(d[0], d[2]);
  const at = [o[0] + d[0] / L * 60, 0, o[2] + d[2] / L * 60], h = g.P.castRay([at[0], 300, at[2]], [0, -1, 0], 600, 1);
  const t = g.mode.spawn('ins', [at[0], h.point[1] + 0.05, at[2]], 0, false);
  await new Promise((r) => setTimeout(r, 500));
  // Aim at its chest.
  // Aim at its chest, in the turret's frame (the pintle rides on the turret, which tilts with the hull).
  const c = [t.pos[0], t.pos[1] + 1.25, t.pos[2]], e = v.nodePos('cws_muzzle');
  const tq = v.turret.getWorldQuaternion(v.turret.quaternion.clone()).invert();
  const wd = { x: c[0] - e[0], y: c[1] - e[1], z: c[2] - e[2] }, Lw = Math.hypot(wd.x, wd.y, wd.z);
  const ld = v.turret.position.clone().set(wd.x / Lw, wd.y / Lw, wd.z / Lw).applyQuaternion(tq);
  mt.aimYaw = Math.atan2(-ld.x, -ld.z); mt.aimPitch = Math.asin(ld.y);
  await new Promise((r) => setTimeout(r, 800));
  const vp = v.pos(), log = [];
  const oe = g.explode.bind(g); g.explode = (...a) => { log.push('EXPLODE'); return oe(...a); };
  const oi = g.proj.H.impact; g.proj.H.impact = (pp, n, surf, a, dd) => { if (Math.hypot(pp[0] - vp[0], pp[2] - vp[2]) < 6) log.push(`near impact ${surf}`); return oi(pp, n, surf, a, dd); };
  let shots = 0;
  for (let k = 0; k < 24; k++) { if (v.fire(mt, seat)) shots++; await new Promise((r) => setTimeout(r, 125)); }
  await new Promise((r) => setTimeout(r, 1200));
  return { shots, target: `${t.state} hp ${Math.round(t.health)}`, log: [...new Set(log)], climb: mt.pitch.toFixed(3) };
});
console.log('burst', JSON.stringify(res));
// An insurgent rifleman 40 m away shoots at the commander's head.
const hit = await p.evaluate(async () => {
  const g = window.__game, me = g.player.s, v = window.__v; me.god = false; me.health = 100;
  const e = v.nodePos('cws_eye');
  const sh = g.mode.spawn('ins', [e[0] + 40, e[1] - 1.6, e[2]], 0, false);
  await new Promise((r) => setTimeout(r, 300));
  const o = [sh.pos[0], e[1], sh.pos[2]], d = [e[0] - o[0], e[1] + 0.02 - o[1], e[2] - o[2]], L = Math.hypot(...d);
  g.proj.fire(sh, sh.weapon, sh.weapon.ammo, o.map((x, i) => x + d[i] / L * 0.5), d.map((x) => x / L), true);
  await new Promise((r) => setTimeout(r, 600));
  return `commander ${me.state} hp ${Math.round(me.health)}; log ${g.mode.log.slice(-2).map((l) => l.text).join(' | ')}`;
});
console.log('exposed', hit);
console.log('errors', errs.length);
await b.close();

// Armour check on the full map (crewman kit at FOB Hammer, the motor pool's M1A2s and M2A3s, no bots):
// suspension settle, the player driving (pivot, speed), the AI driver's route to the ridge, the gunner (lase, HEAT
// and sabot into a farm wall), armour (RPG front / side, PG-7VR, 7.62, 25 mm on a Bradley), screenshots.
//   node scripts/tanktest.mjs <outPrefix>
import { launch } from './browser.mjs';
const out = process.argv[2] || 'tank';
const b = await launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
p.on('pageerror', (e) => { errs.push(e.message); console.log('[pageerror]', e.message, (e.stack ?? '').split(String.fromCharCode(10)).slice(0, 10).join(' | ')); });
p.on('console', (m) => { if (m.type() === 'error') console.log('[error]', m.text().slice(0, 300)); });
await p.goto('http://localhost:5173/?q=medium&auto=us&kit=us_crew&nobots');
await p.waitForFunction(() => window.__ready === true && window.__game?.player, null, { timeout: 300000 });
const I = (js) => p.evaluate(js);
await I(`window.__deaths = []; const ev = window.__game.events, prev = ev.onDown; ev.onDown = (v, by, k) => { window.__deaths.push(v.name + (k ? ' killed' : ' down') + ' by ' + (by?.name ?? '?') + ' t=' + window.__game.time.toFixed(1)); prev?.(v, by, k); };`);
await p.waitForTimeout(3000);
console.log('settle', JSON.stringify(await I(`window.__game.vehicles.map((v) => ({ id: v.def.id, pos: v.pos().map((x) => +x.toFixed(1)), yaw: +(v.yaw() * 57.3).toFixed(0), grounded: v.grounded, pitch: +v.hullPitch().toFixed(3), crew: v.seats.filter((s) => s.who).length }))`)));
console.log('player', await I(`window.__game.player.s.pos.map((x) => +x.toFixed(1))`));
// Into tank 0's driver seat.
console.log('enter', JSON.stringify(await I(`(() => { const g = window.__game, v = g.vehicles[0], me = g.player.s; const ok = g.player.vc.trySeat(me, v, 0); return { ok, crew: v.seats.map((s) => s.who ? (s.who.isPlayer ? 'YOU' : s.who.name) : '-') }; })()`)));
await p.waitForTimeout(500);
// Pivot left 3 s.
const y0 = await I(`window.__game.vehicles[0].yaw()`);
await I(`window.__input.down.add('KeyA')`); await p.waitForTimeout(3000); await I(`window.__input.down.delete('KeyA')`);
await p.waitForTimeout(800);
const y1 = await I(`window.__game.vehicles[0].yaw()`);
console.log('pivot 3 s (deg)', ((y1 - y0) * 180 / Math.PI).toFixed(1));
await p.screenshot({ path: `${out}_driver.png` });
// Forward 5 s.
await I(`window.__input.down.add('KeyW')`);
const sp = [];
for (let i = 0; i < 5; i++) { await p.waitForTimeout(1000); sp.push(await I(`+(window.__game.vehicles[0].vf * 3.6).toFixed(1)`)); }
await I(`window.__input.down.delete('KeyW')`);
console.log('speed km/h by second', sp.join(' '), 'pos', await I(`window.__game.vehicles[0].pos().map((x) => +x.toFixed(1))`));
// AI driver: tank 1 to the ridge.
const plan = await I(`(() => { const g = window.__game, v = g.vehicles[1], t0 = performance.now(); v.ai.driveTo([662, 0, -40]); return { ms: +(performance.now() - t0).toFixed(1), pts: v.ai.path.length, from: v.pos().map((x) => +x.toFixed(0)) }; })()`);
console.log('plan', JSON.stringify(plan));
for (let i = 0; i < 6; i++) { await p.waitForTimeout(5000); console.log('  ai', await I(`(() => { const v = window.__game.vehicles[1]; return JSON.stringify({ pos: v.pos().map((x) => +x.toFixed(0)), kmh: +(v.vf * 3.6).toFixed(0), pi: v.ai.pi, goal: !!v.ai.goal }); })()`)); }
// Gunner (F2): the tank moved onto open farmland facing the town; aim at the nearest building wall.
await I(`(() => { const g = window.__game, v = g.vehicles[0], me = g.player.s; v.body.setTranslation({ x: 600, y: g.P.castRay([600, 300, 120], [0, -1, 0], 600, 1).point[1] + 0.4, z: 120 }, true); v.body.setRotation({ x: 0, y: Math.sin(Math.PI / 4), z: 0, w: Math.cos(Math.PI / 4) }, true); v.body.setLinvel({ x: 0, y: 0, z: 0 }, true); g.player.vc.trySeat(me, v, 1); })()`);
await p.waitForTimeout(2000);
const aim = await I(`(() => { const g = window.__game, v = g.vehicles[0], o = v.nodePos('seat_gunner'); let best = null;
  for (let a = 0; a < 90; a++) { const yaw = a / 90 * Math.PI * 2, d = [-Math.sin(yaw), 0, -Math.cos(yaw)], h = g.P.castRay([o[0] + d[0] * 6, o[1] - 1.0, o[2] + d[2] * 6], d, 400, 1); if (h && h.dist > 40 && h.tag >= 0 && (!best || h.dist < best.d)) best = { d: +h.dist.toFixed(0), yaw: +yaw.toFixed(3) }; }
  if (best) { v.aimYaw = best.yaw; v.aimPitch = -0.004; } return best; })()`);
console.log('aim', JSON.stringify(aim));
await p.waitForTimeout(14000);
console.log('lase', await I(`window.__game.vehicles[0].lase()`));
await p.screenshot({ path: `${out}_sight.png` });
const fire = async (type, name) => {
  await I(`(() => { const v = window.__game.vehicles[0]; v.selectAmmo(v.mounts[0], ${type}); })()`);
  await p.waitForTimeout(7000);
  const rm0 = await I(`window.__game.destruct.removed`);
  const f = await I(`(() => { const v = window.__game.vehicles[0]; return { fired: v.fire(v.mounts[0], 1), blocked: v.blocked(v.mounts[0], 1), ready: v.mounts[0].ready.join('/') }; })()`);
  await p.waitForTimeout(300);
  await p.screenshot({ path: `${out}_${name}.png` });
  await p.waitForTimeout(2500);
  console.log(name, JSON.stringify(f), 'pieces removed', (await I(`window.__game.destruct.removed`)) - rm0);
};
await fire(1, 'heat');
await fire(0, 'sabot');
// Armour: the M1A2 and a Bradley moved into open farmland; an insurgent shoots each face from 15 m.
await I(`(() => { const g = window.__game; for (const [i, x, z] of [[0, 600, 120], [3, 600, 160]]) { const v = g.vehicles[i]; for (const st of v.seats) if (st.who?.isPlayer) v.exit(st.who, true); v.body.setTranslation({ x, y: g.P.castRay([x, 300, z], [0, -1, 0], 600, 1).point[1] + 0.4, z }, true); v.body.setLinvel({ x: 0, y: 0, z: 0 }, true); v.ai?.stop(); } })()`);
await p.waitForTimeout(3000);
const armour = await I(`(() => {
  const g = window.__game, A = window.__AMMO, out = [];
  const ins = g.spawn(g.soldiers[0].kit, 'ins', [0, -50, 0], 'target practice');
  const shoot = (v, ammo, face, h = 1.2) => {
    v.integrity = 100; v.burning = false; v.tracked = false; v.engineOut = false;
    const p = v.pos(), yaw = v.yaw() + ({ front: 0, left: Math.PI / 2, rear: Math.PI, right: -Math.PI / 2 })[face];
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw), o = [p[0] + fx * 15, p[1] + h, p[2] + fz * 15], d = [-fx, 0, -fz];
    const wh = g.P.castRay(o, d, 30);
    if (!wh || g.vehicleOf.get(wh.collider.handle) !== v) return ammo + ' ' + face + ': blocked';
    g.proj.H.armour(wh, d, A[ammo].rocket ? 290 : A[ammo].v0, A[ammo], ins);
    return ammo + ' ' + face + ': →' + v.integrity.toFixed(0) + (v.tracked ? ' TRACK' : '') + (v.engineOut ? ' ENGINE' : '') + (v.burning ? ' FIRE' : '') + (v.dead ? ' DEAD' : '');
  };
  const t = g.vehicles[0], br = g.vehicles[3];
  for (const [v, a, f, h] of [[t, 'pg7vl', 'front'], [t, 'pg7vr', 'front'], [t, 'pg7vl', 'left'], [t, 'pg7vl', 'left', 0.55], [t, 'pg7vr', 'left'], [t, 'pg7vl', 'rear'], [t, '9m113', 'front'], [t, '50bmg', 'left'],
                              [br, '762x51', 'left'], [br, '50bmg', 'left'], [br, '25ap', 'front'], [br, 'pg7vl', 'left'], [br, 'pg7vl', 'front'], [br, 'pg7vr', 'left'], [br, '120apfsds', 'front']]) out.push(shoot(v, a, f, h ?? 1.3));
  t.integrity = 100; t.burning = false; br.integrity = 100; br.burning = false;
  return out;
})()`);
console.log('armour', JSON.stringify(armour));
await p.waitForTimeout(2500);
await p.evaluate(() => { const g = window.__game, v = g.vehicles[3], cam = window.__G.camera, me = g.player.s; if (me.vehicle) me.vehicle.exit(me, true); const q = v.pos(); window.__hold = true; cam.position.set(q[0] - 10, q[1] + 3.5, q[2] + 9); cam.lookAt(q[0], q[1] + 1, q[2]); });
await p.waitForTimeout(1500);
await p.screenshot({ path: `${out}_ext.png` });
console.log('deaths', JSON.stringify(await I('window.__deaths')));
console.log('fps', await I('window.__fps'), 'errors', errs.length);
await b.close();

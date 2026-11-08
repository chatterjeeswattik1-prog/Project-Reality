// Coax check (sandbox): an empty M1A2 with the player as gunner, a target dummy 60 m ahead; the turret slews onto it
// and the coax fires a burst. The dummy must take hits.
//   node scripts/coaxtest.mjs
import { launch } from './browser.mjs';
const b = await launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
p.on('pageerror', (e) => { errs.push(e.message); console.log('[pageerror]', e.message); });
await p.goto('http://localhost:5173/?mode=sandbox&q=low&auto=us&kit=us_rifle');
await p.waitForFunction(() => window.__ready === true && window.__game?.player, null, { timeout: 300000 });
await p.waitForTimeout(1500);
await p.evaluate(() => { const g = window.__game, me = g.player.s, h = g.P.castRay([640, 300, 110], [0, -1, 0], 600, 1); me.pos = [640, h.point[1] + 0.05, 110]; me.body.setTranslation({ x: 640, y: h.point[1] + 0.95, z: 110 }, true); me.yaw = Math.PI / 2; me.pitch = 0; });
await p.waitForTimeout(500);
await p.evaluate(() => { const t = window.__tools; t.toggle(true); t.act('m1a2'); });
await p.waitForTimeout(3000);
const r = await p.evaluate(async () => {
  const g = window.__game, me = g.player.s, v = g.vehicles.find((x) => x.def.id === 'm1a2');
  const gi = v.seats.findIndex((s) => s.def.role === 'gunner');
  g.player.vc.trySeat(me, v, gi);
  await new Promise((r) => setTimeout(r, 800));
  await new Promise((r) => setTimeout(r, 11000));
  const q = v.pos(), gd = v.nodeDir('gun'), gl = Math.hypot(gd[0], gd[2]), fwd = [gd[0] / gl, 0, gd[2] / gl];
  const at = [q[0] + fwd[0] * 60, q[1], q[2] + fwd[2] * 60], h = g.P.castRay([at[0], 300, at[2]], [0, -1, 0], 600, 1);
  const t = g.mode.spawn('us', [at[0], h.point[1] + 0.05, at[2]], 0, false);
  await new Promise((r) => setTimeout(r, 600));
  const coax = v.mountsOf(gi).find((m) => m.def.id === 'coax');
  const c = v.nodePos('coax'), dx = t.pos[0] - c[0], dy = t.pos[1] + 1.1 - c[1], dz = t.pos[2] - c[2];
  v.aimYaw = Math.atan2(-dx, -dz); v.aimPitch = Math.atan2(dy, Math.hypot(dx, dz));
  await new Promise((r) => setTimeout(r, 3000));
  const dist = Math.round(Math.hypot(t.pos[0] - q[0], t.pos[2] - q[2])), driver = v.seats.map((x) => x.who?.name ?? '-').join(','), before = `${t.state} hp ${Math.round(t.health)}`, why = v.blocked(coax, gi);
  const H = g.proj.H, trace = [];
  const oa = H.armour, oi = H.impact;
  H.armour = (wh, d, sp, a, by) => { const r = oa(wh, d, sp, a, by); if (a.id === '762x51' || String(a.id ?? '').includes('762')) trace.push(`armour veh=${g.vehicleOf.get(wh.collider.handle)?.def.id} own=${H.ownVehicle?.(wh.collider.handle, by)} d=${wh.dist.toFixed(2)} stop=${r}`); return r; };
  H.impact = (...x) => { trace.push(`impact ${x[0]?.map?.((v) => v.toFixed(1)).join(',')}`); return oi(...x); };
  const c0 = v.nodePos('coax'), gd2 = v.nodeDir('gun');
  trace.push(`coax ${c0.map((x) => x.toFixed(2))} dir ${gd2.map((x) => x.toFixed(3))} tgt ${t.pos.map((x) => x.toFixed(2))}`);
  let shots = 0;
  for (let k = 0; k < 40; k++) { if (v.fire(coax, gi)) shots++; await new Promise((r) => setTimeout(r, 90)); }
  await new Promise((r) => setTimeout(r, 1000));
  return { trace: trace.slice(0, 14), dist, driver, me: me.name, before, why, gunPitch: v.gunPitch, turretYaw: v.turretYaw, seat: me.vehicle ? v.seats.findIndex((s) => s.who === me) : -1, shots, target: `${t.state} hp ${Math.round(t.health)}`, log: g.mode.log.slice(-4).map((l) => l.text) };
});
console.log(JSON.stringify(r, null, 1));
console.log('errors', errs.length);
await b.close();

// Crew views: the player in each seat of an M1A2 and an M2A3 (sandbox, open ground facing the town); the driver with
// the turret at 0°, 90° and 180°; the gunner (day sight, both zooms). Screenshots <outPrefix>_<veh>_<seat>….png
//   node scripts/vehview.mjs <outPrefix>
import { launch } from './browser.mjs';
const out = process.argv[2] || 'vehview';
const b = await launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
p.on('pageerror', (e) => { errs.push(e.message); console.log('[pageerror]', e.message); });
await p.goto('http://localhost:5173/?mode=sandbox&q=medium&auto=us&kit=us_crew');
await p.waitForFunction(() => window.__ready === true && window.__game?.player, null, { timeout: 300000 });
await p.waitForTimeout(1500);
for (const veh of ['m1a2', 'm2a3']) {
  await p.evaluate((veh) => {
    const g = window.__game, me = g.player.s;
    if (me.vehicle) me.vehicle.exit(me, true);
    const h = g.P.castRay([640, 300, 110], [0, -1, 0], 600, 1);
    me.pos = [640, h.point[1] + 0.05, 110]; me.body.setTranslation({ x: 640, y: h.point[1] + 0.95, z: 110 }, true); me.yaw = Math.PI / 2; me.pitch = 0;
    const t = window.__tools; t.toggle(true); t.act('clearveh'); t.toggle(true); t.act(veh);
  }, veh);
  await p.waitForTimeout(3000);
  const seats = await p.evaluate((veh) => { const v = window.__game.vehicles.filter((x) => x.def.id === veh).pop(); window.__v = v; return v.seats.map((s) => s.def.role); }, veh);
  console.log(veh, 'seats', seats.join(','));
  for (const role of ['driver', 'gunner']) {
    await p.evaluate((role) => { const g = window.__game, me = g.player.s, v = window.__v; g.player.vc.trySeat(me, v, v.seats.findIndex((s) => s.def.role === role)); }, role);
    await p.waitForTimeout(1500);
    if (role === 'driver') {
      for (const ty of [0, 1.57, 3.14]) {
        await p.evaluate((ty) => { const v = window.__v; v.turretYaw = ty; v.aimYaw = v.yaw() + ty; v.aimPitch = 0; window.__g = v.gunPitch = 0; }, ty);
        await p.waitForTimeout(700);
        await p.screenshot({ path: `${out}_${veh}_driver_${Math.round(ty * 57)}.png` });
      }
    } else {
      await p.waitForTimeout(13000); // turret warm-up
      await p.evaluate(() => { const v = window.__v; v.aimYaw = v.yaw(); v.aimPitch = 0; });
      for (const z of [0, 1]) { await p.evaluate((z) => { window.__game.player.vc.zoomI = z; }, z); await p.waitForTimeout(2000); await p.screenshot({ path: `${out}_${veh}_gunner_z${z}.png` }); }
    }
  }
}
console.log('errors', errs.length);
await b.close();

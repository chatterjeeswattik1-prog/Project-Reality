// Sandbox check: empty full map, tools panel spawns (targets, fighters, a crewed tank), shooting a dummy (hit log),
// a C4 blast on a row of dummies, getting into an empty vehicle as a rifleman (AI crew joins), switching side.
//   node scripts/sandboxtest.mjs <outPrefix>
import { launch } from './browser.mjs';
const out = process.argv[2] || 'sandbox';
const b = await launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
p.on('pageerror', (e) => { errs.push(e.message); console.log('[pageerror]', e.message, (e.stack ?? '').split(String.fromCharCode(10)).slice(0, 6).join(' | ')); });
await p.goto('http://localhost:5173/?mode=sandbox&q=medium&auto=us&kit=us_rifle');
await p.waitForFunction(() => window.__ready === true && window.__game?.player, null, { timeout: 300000 });
await p.waitForTimeout(2000);
const st = () => p.evaluate(() => { const g = window.__game; return { soldiers: g.soldiers.length, us: g.soldiers.filter((s) => s.team === 'us').length, ins: g.soldiers.filter((s) => s.team === 'ins').length, vehicles: g.vehicles.map((v) => `${v.def.id}/${v.team}/crew ${v.seats.filter((s) => s.who).length}`).join(' '), ieds: g.insAT?.ieds.length ?? 0, log: g.mode.log.slice(-6).map((l) => l.text) }; });
console.log('start', JSON.stringify(await st()));
// Look west across open ground and open the tools; spawn a row, a fighter, an RPG gunner.
await p.evaluate(() => { const g = window.__game, me = g.player.s, h = g.P.castRay([640, 300, 110], [0, -1, 0], 600, 1); me.pos = [640, h.point[1] + 0.05, 110]; me.body.setTranslation({ x: 640, y: h.point[1] + 0.95, z: 110 }, true); me.yaw = Math.PI / 2; me.pitch = -0.05; });
await p.waitForTimeout(800);
await p.waitForTimeout(500);
await p.evaluate(() => { const t = window.__tools; t.toggle(true); t.act('ins_row'); t.toggle(true); t.act('ins_fighter'); });
await p.waitForTimeout(1500);
console.log('after spawns', JSON.stringify(await st()));
await p.screenshot({ path: `${out}_targets.png` });
// Shoot the first dummy in the chest with the player's rifle round, then C4 the rest of the row.
const shot = await p.evaluate(() => {
  const g = window.__game, me = g.player.s, t = window.__game.mode.spawned[0];
  const c = [t.pos[0], t.pos[1] + 1.3, t.pos[2]], e = me.eye, d = [c[0] - e[0], c[1] - e[1], c[2] - e[2]], L = Math.hypot(...d);
  g.proj.fire(me, me.weapon, me.weapon.ammo, e, d.map((x) => x / L), true);
  return Math.round(L);
});
await p.waitForTimeout(1500);
console.log('shot at', shot, 'm →', JSON.stringify((await st()).log));
await p.evaluate(() => { const g = window.__game, row = g.mode.spawned.slice(1, 5), c = row[2].pos; g.explode([c[0], c[1] + 0.3, c[2] + 1], window.__AMMO.c4, g.player.s); });
await p.waitForTimeout(2500);
console.log('after C4', JSON.stringify((await st()).log));
await p.screenshot({ path: `${out}_blast.png` });
// A crewed tank where we look (it should engage an insurgent player later), then into an empty Bradley as a rifleman.
await p.evaluate(() => { const t = window.__tools; t.toggle(true); t.act('m1a2_crew'); });
await p.waitForTimeout(3000);
const enter = await p.evaluate(() => { const g = window.__game, me = g.player.s, v = g.vehicles.find((x) => x.def.id === 'm2a3' && !x.seats.some((s) => s.who)); const q = v.pos(); me.pos = [q[0] + 3.5, q[1], q[2]]; me.body.setTranslation({ x: q[0] + 3.5, y: q[1] + 0.9, z: q[2] }, true); const vf = g.player.vehicleFor(me); return vf ? `${vf.v.def.id} seat ${vf.seat} (${vf.v.seats[vf.seat]?.def.role})` : 'none'; });
console.log('vehicleFor (rifleman)', enter);
await p.evaluate(() => { const g = window.__game, me = g.player.s, vf = g.player.vehicleFor(me); g.player.vc.trySeat(me, vf.v, vf.seat); });
await p.waitForTimeout(3000);
console.log('in vehicle', JSON.stringify(await st()));
// Switch side: respawn as an insurgent at a clicked point.
await p.evaluate(() => { const g = window.__game; if (g.player.s.vehicle) g.player.s.vehicle.exit(g.player.s, true); window.__tools.act('side'); });
await p.waitForTimeout(800);
const ok = await p.evaluate(() => { const ss = document.querySelector('.spawn'); if (!ss || ss.style.display === 'none') return 'no spawn screen'; ss.querySelector('.sp-sides button[data-f=ins]').click(); ss.querySelector('.deploy').click(); return 'deployed'; });
await p.waitForTimeout(2000);
console.log('switch side', ok, await p.evaluate(() => { const me = window.__game.player.s; return `${me.team} ${me.kit.id} at ${me.pos.map((x) => Math.round(x)).join(',')}`; }));
await p.screenshot({ path: `${out}_spawn.png` });
console.log('errors', errs.length);
await b.close();

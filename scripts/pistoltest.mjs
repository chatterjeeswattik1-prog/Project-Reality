// Pistol handling check, both factions: first person (hip, aimed, reload stages, empty-reload slide) and third person
// (a target soldier with the sidearm: low ready, aimed, reload), seen from the side and front.
//   node scripts/pistoltest.mjs <outPrefix> [us|ins]
import { launch } from './browser.mjs';
const out = process.argv[2] || 'pistol', side = process.argv[3] || 'us';
const kit = side === 'us' ? 'us_sl' : 'ins_cell';
const b = await launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
p.on('pageerror', (e) => { errs.push(e.message); console.log('[pageerror]', e.message, (e.stack ?? '').split('\n').slice(0, 4).join(' | ')); });
await p.goto(`http://localhost:5173/?mode=sandbox&q=medium&auto=${side}&kit=${kit}`);
await p.waitForFunction(() => window.__ready === true && window.__game?.player, null, { timeout: 300000 });
await p.waitForTimeout(1500);
// Open ground, facing west; the pistol in hand.
await p.evaluate(() => {
  const g = window.__game, me = g.player.s, h = g.P.castRay([640, 300, 110], [0, -1, 0], 600, 1);
  me.pos = [640, h.point[1] + 0.05, 110]; me.body.setTranslation({ x: 640, y: h.point[1] + 0.95, z: 110 }, true); me.yaw = Math.PI / 2; me.pitch = -0.02;
  me.select(me.slots.findIndex((s) => s.def.kind === 'pistol'));
});
await p.waitForTimeout(2500);
const shot = async (name) => { await p.screenshot({ path: `${out}_${name}.png` }); };
await shot('fp_hip');
await p.evaluate(() => { window.__game.player.input.mouse.right = true; });
await p.waitForTimeout(1200);
await shot('fp_ads');
await p.evaluate(() => { window.__game.player.input.mouse.right = false; });
await p.waitForTimeout(800);
// Reload stages (frozen: a long reload duration, progress set directly).
const stage = async (prog, empty, name) => {
  await p.evaluate(([prog, empty]) => { const s = window.__game.player.s; s.reloadDur = 1000; s.reloadT = 1000 * (1 - prog); s.reloadEmpty = empty; }, [prog, empty]);
  await p.waitForTimeout(500);
  await shot(name);
};
for (const [pr, e, n] of [[0.1, false, 'fp_r10'], [0.22, false, 'fp_r22'], [0.4, false, 'fp_r40'], [0.55, false, 'fp_r55'], [0.66, false, 'fp_r66'], [0.8, true, 'fp_e80']]) await stage(pr, e, n);
await p.evaluate(() => { const s = window.__game.player.s; s.reloadT = 0; });
await p.waitForTimeout(500);
await p.waitForTimeout(1000);
await shot('fp_hip2');
console.log('fp', await p.evaluate(() => { const s = window.__game.player.s; return `${s.weapon.id} switchT ${s.switchT.toFixed(2)} vm ${window.__game.player.vm.group.visible}`; }));
// Third person: a target soldier of this side with the kit's sidearm, 3 m in front, seen from its right side.
const info = await p.evaluate((kit) => {
  const g = window.__game, me = g.player.s, m = g.mode;
  const at = [me.pos[0] - 3, me.pos[1], me.pos[2]];
  const t = m.spawn(me.team, at, Math.PI / 2, false, kit);
  t.select(t.slots.findIndex((s) => s.def.kind === 'pistol')); t.switchT = 0;
  window.__t = t; window.__hold = true;
  return { weapon: t.weapon.id };
}, kit);
console.log('third person', JSON.stringify(info));
const tp = async (name, setup, view) => {
  await p.evaluate(([setup, view]) => {
    const t = window.__t, g = window.__game, me = g.player.s;
    t.ads = setup.ads; t.lastShotT = -99; t.reloadDur = 1000; t.reloadT = setup.reload ? 1000 * (1 - setup.reload) : 0; t.reloadEmpty = !!setup.empty;
    const f = [-Math.sin(t.yaw), 0, -Math.cos(t.yaw)], r = [Math.cos(t.yaw), 0, -Math.sin(t.yaw)];
    const v = view === 'side' ? [r[0] * 1.9 + f[0] * 0.5, r[2] * 1.9 + f[2] * 0.5] : view === 'front' ? [f[0] * 2.3 + r[0] * 0.5, f[2] * 2.3 + r[2] * 0.5] : [-f[0] * 1.3 + r[0] * 0.7, -f[2] * 1.3 + r[2] * 0.7];
    // Look from the player's eye (first-person weapon hidden).
    const x = t.pos[0] + v[0], z = t.pos[2] + v[1];
    me.pos = [x, t.pos[1], z]; me.body.setTranslation({ x, y: t.pos[1] + 0.9, z }, true); me.vel = [0, 0, 0];
    const dx = t.pos[0] + f[0] * 0.25 - x, dz = t.pos[2] + f[2] * 0.25 - z;
    me.yaw = Math.atan2(-dx, -dz); me.pitch = -0.12;
    const vm = g.player.vm; vm.update = () => {}; vm.group.visible = false;
    window.__keep = setup;
  }, [setup, view]);
  // Keep the pose (the soldier's own update lowers ads / runs the reload clock).
  for (let i = 0; i < 12; i++) { await p.evaluate(() => { const t = window.__t, s = window.__keep; t.ads = s.ads; if (s.reload) t.reloadT = 1000 * (1 - s.reload); }); await p.waitForTimeout(60); }
  await shot(name);
};
await tp('tp_low_side', { ads: 0 }, 'side');
await tp('tp_aim_side', { ads: 1 }, 'side');
await tp('tp_aim_front', { ads: 1 }, 'front');
await tp('tp_aim_back', { ads: 1 }, 'back');
await tp('tp_r30_side', { ads: 0, reload: 0.3 }, 'side');
await tp('tp_r55_side', { ads: 0, reload: 0.55 }, 'side');
await tp('tp_r55_back', { ads: 0, reload: 0.55 }, 'back');
await tp('tp_e80_side', { ads: 0, reload: 0.8, empty: true }, 'side');
console.log('errors', errs.length);
await b.close();

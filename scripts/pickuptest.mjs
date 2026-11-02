// Weapon pickup: kill an insurgent beside the player, look at his dropped rifle, press F; then pick our own back.
import { launch } from './browser.mjs';
const b = await launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message, (e.stack ?? '').split(String.fromCharCode(10)).slice(1, 4).join(' | ')));
await p.goto('http://localhost:5173/?mode=test&auto=us&q=low');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
await p.waitForTimeout(1500);
await p.evaluate(async () => {
  const g = window.__game, s = g.player.s, bots = [...window.__skirm.bots.values()];
  for (const bt of bots) { bt.update = () => {}; bt.s.health = 1e6; }
  const v = bots.find((x) => x.s.team !== s.team).s;
  const f = [-Math.sin(s.yaw), -Math.cos(s.yaw)];
  v.pos = [s.pos[0] + f[0] * 1.6, s.pos[1], s.pos[2] + f[1] * 1.6]; v.body.setTranslation({ x: v.pos[0], y: v.pos[1] + 0.95, z: v.pos[2] }, true); v.yaw = s.yaw;
  await new Promise((r) => setTimeout(r, 500));
  v.health = 5; g.hitSoldier(v, [v.pos[0], v.pos[1] + 1.6, v.pos[2]], 'head', { ...window.__AMMO['556'] }, s);
  window.__v = v;
});
await p.waitForTimeout(4000);
const look = () => p.evaluate(() => {
  const g = window.__game, s = g.player.s, k = g.pickups[g.pickups.length - 1]; if (!k) return 'no pickups';
  const q = k.obj.getWorldPosition(new window.__THREE.Vector3()), e = s.eye, dx = q.x - e[0], dy = q.y - e[1], dz = q.z - e[2];
  s.yaw = Math.atan2(-dx, -dz); s.pitch = Math.atan2(dy, Math.hypot(dx, dz)); window.__input.locked = true;
  return `pickups=${g.pickups.length} looking at ${k.slot.def.id} dist=${Math.hypot(q.x - s.pos[0], q.z - s.pos[2]).toFixed(2)}`;
});
const state = () => p.evaluate(() => { const s = window.__game.player.s; return `weapon=${s.weapon.id} loaded=${s.slot.loaded} mags=${s.slot.mags.length} slots=${s.slots.map((x) => x.def.id)} prompt=${[...document.querySelectorAll('.hud div')].map((d) => d.textContent).find((t) => t && t.startsWith('F —')) ?? '-'}`; });
console.log(await look()); await p.waitForTimeout(300); console.log('before', await state());
await p.keyboard.press('KeyF'); await p.waitForTimeout(1500); console.log('after F', await state());
console.log(await look()); await p.waitForTimeout(300); await p.keyboard.press('KeyF'); await p.waitForTimeout(1500); console.log('after F again', await state());
await p.screenshot({ path: 'C:/Users/ADMINI~1/AppData/Local/Temp/claude/e--Terraform-Automation-Project-Reality/dfe00d10-5890-47cc-a760-eb0ace214135/scratchpad/pickup.png' });
await b.close();

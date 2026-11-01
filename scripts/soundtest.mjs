// Combat sound check (audio running, autoplay allowed): log every sound the game plays while the player walks,
// sprints until blown, goes prone and crawls, fires, takes near misses and impacts, a blast goes off close by and a bot
// is killed next to him. Prints counts per sound and the loop levels.   node scripts/soundtest.mjs
import { launch } from './browser.mjs';
const b = await launch(['--autoplay-policy=no-user-gesture-required']);
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.goto('http://localhost:5173/?mode=test&auto=us&q=low');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
await p.evaluate(() => {
  const g = window.__game, A = g.audio; A.resume();
  window.__log = new Map(); window.__drop = 0;
  const orig = A.play.bind(A);
  A.play = (name, pos, o) => { const r = orig(name, pos, o); const k = name + (r ? '' : ' (dropped)'); window.__log.set(k, (window.__log.get(k) ?? 0) + 1); return r; };
  for (const bt of window.__skirm.bots.values()) { bt.update = () => {}; bt.s.health = 1e6; }
});
const press = async (keys, ms) => { for (const k of keys) await p.keyboard.down(k); await p.waitForTimeout(ms); for (const k of keys) await p.keyboard.up(k); };
await p.evaluate(() => { const I = window.__input; I.locked = true; });
const state = () => p.evaluate(() => { const s = window.__game.player.s; return `stamina=${s.stamina.toFixed(0)} stance=${s.stance} ctx=${window.__game.audio.ctx.state}`; });
await press(['KeyW'], 2500); console.log('walked', await state());
await press(['ShiftLeft', 'KeyW'], 7000); console.log('sprinted', await state());
await p.waitForTimeout(300);
await p.evaluate(() => { const g = window.__game; console.log; window.__loops = { b: g.foley.breath, h: g.foley.heart }; });
await p.keyboard.press('KeyZ'); await p.waitForTimeout(800); await press(['KeyW'], 1500); console.log('crawled', await state());
await p.evaluate(async () => {
  const g = window.__game, s = g.player.s, A = window.__AMMO, bots = [...window.__skirm.bots.values()];
  const sh = bots.find((x) => x.s.team !== s.team).s;
  // fire a burst
  window.__input.mouse.left = true; window.__input.mouse.leftPressed = true;
  await new Promise((r) => setTimeout(r, 900)); window.__input.mouse.left = false;
  // near misses and impacts round the player
  for (let i = 0; i < 6; i++) { g.crack(s, [s.pos[0] + 1, s.pos[1] + 1.5, s.pos[2]], A['762x39'], sh); g.impactSound([s.pos[0] + 2, s.pos[1], s.pos[2] + 1], [0, 1, 0], 'concrete', A['762x39'], [0.9, -0.2, 0]); await new Promise((r) => setTimeout(r, 120)); }
  // a grenade 6 m away
  g.explode([s.pos[0] + 6, s.pos[1] + 0.3, s.pos[2]], A['frag'], sh);
  // a bot killed beside the player
  const v = bots.find((x) => x.s.team !== s.team && x.s !== sh).s;
  v.pos = [s.pos[0] - 3, s.pos[1], s.pos[2]]; v.body.setTranslation({ x: v.pos[0], y: v.pos[1] + 0.95, z: v.pos[2] }, true); v.health = 10;
  await new Promise((r) => setTimeout(r, 300));
  g.hitSoldier(v, [v.pos[0], v.pos[1] + 1.3, v.pos[2]], 'chest', A['556'], s);
  s.health = 30; s.bleed = 2;
  await new Promise((r) => setTimeout(r, 1500));
});
const r = await p.evaluate(() => ({ log: Object.fromEntries([...window.__log.entries()].sort()), voices: window.__game.audio.voices }));
console.log(JSON.stringify(r, null, 0));
await b.close();

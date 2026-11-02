// Repeated death and redeploy on the full map (the player killed by a head shot, spawn screen, deploy), N times.
//   node scripts/deathloop.mjs [n=6]
import { launch } from './browser.mjs';
const n = Number(process.argv[2] ?? 6);
const b = await launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message, (e.stack ?? '').split(String.fromCharCode(10)).slice(1, 5).join(' | ')));
await p.goto(`http://localhost:${process.env.PORT ?? 5173}/?auto=us&q=low`);
await p.waitForFunction(() => window.__ready === true, null, { timeout: 400000 });
for (let i = 0; i < n; i++) {
  const r = await p.evaluate(() => {
    const g = window.__game, s = g.player.s, A = window.__AMMO, en = g.soldiers.find((o) => o.team !== s.team);
    window.__input.locked = true; window.__input.mouse.left = true; window.__input.mouse.leftPressed = true;
    setTimeout(() => { window.__input.mouse.left = false; }, 600);
    return new Promise((res) => setTimeout(() => { s.health = 5; g.hitSoldier(s, [s.pos[0], s.pos[1] + 1.6, s.pos[2]], 'head', { ...A['762x39'] }, en); res(`${s.state} kit=${s.kit.id}`); }, 900));
  });
  await p.waitForFunction(() => { const b = document.querySelector('.spawn .deploy'); const sp = document.querySelector('.spawn'); return sp && sp.style.display !== 'none' && b && !b.disabled; }, null, { timeout: 60000 });
  const kits = await p.$$('.spawn .kits button'); await kits[i % kits.length].click();
  await p.click('.spawn .deploy'); await p.waitForTimeout(2500);
  console.log(i, r, '->', await p.evaluate(() => { const s = window.__game.player.s; return `${s.state} kit=${s.kit.id} weapon=${s.weapon.id} soldiers=${window.__game.soldiers.length}`; }));
}
await b.close();

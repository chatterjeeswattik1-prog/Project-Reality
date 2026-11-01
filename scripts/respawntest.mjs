// Respawn: kill the player (mouse released, as after Esc), check the spawn screen opens, pick another kit, deploy.
//   node scripts/respawntest.mjs [query]
import { launch } from './browser.mjs';
const q = process.argv[2] ?? 'mode=test&auto=us&q=low';
const b = await launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message, (e.stack ?? '').split(String.fromCharCode(10)).slice(0, 12).join(' | ')));
await p.goto(`http://localhost:5173/?${q}`);
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
await p.waitForTimeout(1500);
const st = () => p.evaluate(() => { const g = window.__game, s = g.player?.s; const sp = document.querySelector('.spawn'); return { state: s?.state, kit: s?.kit.id, spawnScreen: sp && sp.style.display !== 'none', btn: document.querySelector('.spawn .deploy')?.textContent }; });
console.log('start', JSON.stringify(await st()));
await p.evaluate(() => { const s = window.__game.player.s; s.die(null); window.__input.locked = false; });
await p.waitForTimeout(5500);
console.log('dead +5.5s', JSON.stringify(await st()));
// pick the second kit in the list
const kits = await p.$$('.spawn .kits button'); console.log('kits', kits.length);
if (kits[2]) await kits[2].click();
await p.waitForTimeout(13000);
console.log('before deploy', JSON.stringify(await st()));
await p.click('.spawn .deploy');
await p.waitForTimeout(1500);
console.log('after deploy', JSON.stringify(await st()));
await b.close();

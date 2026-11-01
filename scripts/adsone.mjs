// Aimed first-person screenshot of one kit's primary: node scripts/adsone.mjs <kit> <team> <out.png>
import { launch } from './browser.mjs';
const [kit, team, out] = process.argv.slice(2);
const b = await launch();
const p = await b.newPage({ viewport: { width: 960, height: 540 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.goto(`http://localhost:5173/?mode=test&auto=${team}&kit=${kit}&q=medium&bots=0`);
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
await p.evaluate(() => { window.__input.locked = true; const s = window.__game.player.s; s.pitch = 0; for (const bt of window.__skirm?.bots?.values() ?? []) { bt.update = () => {}; } });
await p.waitForTimeout(2500);
await p.evaluate(() => { window.__input.mouse.right = true; });
await p.waitForTimeout(2500);
await p.screenshot({ path: out });
console.log(await p.evaluate(() => window.__game.player.s.weapon.id));
await b.close();

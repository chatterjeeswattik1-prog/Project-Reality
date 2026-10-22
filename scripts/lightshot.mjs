// Weapon light check: player spawned in the US base, screenshots with the light off and on.
import { chromium } from 'playwright-core';
const out = process.argv[2] ?? 'light';
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, env: { ...process.env, DRI_PRIME: '1' }, args: ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
const logs = []; p.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await p.goto(`http://localhost:5173/?auto=us&mode=test&q=medium&bots=0&yaw=${process.env.YAW ?? 0}`);
await p.waitForFunction(() => window.__ready === true, null, { timeout: 180000 });
await p.waitForTimeout(4000);
for (const on of [true, false]) {
  await p.evaluate((on) => { const me = window.__game.soldiers.find((s) => s.isPlayer); me.light = on; }, on);
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `${out}_${on ? 'on' : 'off'}.png` });
}
console.log(await p.evaluate(() => `fps ${window.__fps}`));
console.log(logs.join('\n'));
await b.close();

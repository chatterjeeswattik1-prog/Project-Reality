// Spawn, hold W, report how far the player moved: node scripts/movetest.mjs "auto=ins" [seconds]
import { chromium } from 'playwright-core';
const [q = 'auto=ins', secs = '4'] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, env: { ...process.env, DRI_PRIME: '1' }, args: ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 960, height: 540 } });
p.on('pageerror', (e) => console.log('pageerror', e.message));
await p.goto(`http://localhost:5173/?${q}&q=low`);
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
await p.waitForTimeout(3000);
const pos = () => p.evaluate(() => { const g = window.__game, s = g.player?.s; return s ? [s.pos.map((v) => +v.toFixed(2)), s.kit.id, s.yaw.toFixed(2)] : null; });
console.log('spawn', JSON.stringify(await pos()));
for (const [key, label] of [['KeyW', 'fwd'], ['KeyA', 'left'], ['KeyS', 'back'], ['KeyD', 'right']]) {
  await p.keyboard.down(key); await p.waitForTimeout(Number(secs) * 250); await p.keyboard.up(key);
  console.log(label, JSON.stringify(await pos()));
}
await p.screenshot({ path: process.env.OUT ?? 'movetest.png' });
await b.close();

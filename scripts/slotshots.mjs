// Screenshot the first-person view for each weapon slot: node scripts/slotshots.mjs <kit> <outPrefix>
import { chromium } from 'playwright-core';
const [kit = 'us_lat', out = 'slot'] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, env: { ...process.env, DRI_PRIME: '1' }, args: ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 960, height: 540 } });
p.on('pageerror', (e) => console.log('pageerror', e.message));
await p.goto(`http://localhost:5173/?auto=us&kit=${kit}&q=medium`);
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
await p.waitForTimeout(2500);
const n = await p.evaluate(() => window.__game.player.s.slots.length);
for (let i = 0; i < n; i++) { await p.keyboard.press(`Digit${i + 1}`); await p.waitForTimeout(1800); await p.screenshot({ path: `${out}_${i}.png` }); }
await b.close();

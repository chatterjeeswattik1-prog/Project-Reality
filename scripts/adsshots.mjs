// Hip and aimed first-person screenshots for each slot of a kit: node scripts/adsshots.mjs <kit> <team> <outPrefix>
import { chromium } from 'playwright-core';
const [kit = 'us_rifle', team = 'us', out = 'ads'] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, env: { ...process.env, DRI_PRIME: '1' }, args: ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 960, height: 540 } });
p.on('pageerror', (e) => console.log('pageerror', e.message, (e.stack ?? '').split('\n').slice(0, 8).join(' | ')));
await p.goto(`http://localhost:5173/?mode=test&auto=${team}&kit=${kit}&q=medium&bots=0`);
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
await p.waitForTimeout(2500);
const slots = Number(process.env.SLOTS ?? 1);
for (let i = 0; i < slots; i++) {
  await p.keyboard.press(`Digit${i + 1}`); await p.waitForTimeout(1500);
  await p.screenshot({ path: `${out}_${i}_hip.png` });
  await p.mouse.move(480, 270); await p.mouse.down({ button: 'right' }); await p.waitForTimeout(2200);
  await p.screenshot({ path: `${out}_${i}_ads.png` }); await p.mouse.up({ button: 'right' }); await p.waitForTimeout(600);
}
await b.close();

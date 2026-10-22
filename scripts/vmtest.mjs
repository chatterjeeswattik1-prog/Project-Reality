// Drive the player with mouse + keys and dump per-frame viewmodel state.
import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, env: { ...process.env, DRI_PRIME: '1' }, args: ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 960, height: 540 } });
p.on('pageerror', (e) => console.log('pageerror', e.message));
await p.goto(`http://localhost:5173/?auto=us&kit=us_lat&q=low&vmlog`);
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
await p.waitForTimeout(2500);
await p.mouse.move(480, 270);
for (let i = 0; i < 40; i++) { await p.mouse.move(480 + Math.sin(i / 3) * 60, 270 + Math.cos(i / 4) * 20); await p.waitForTimeout(50); }
await p.keyboard.down('KeyW'); await p.waitForTimeout(1500); await p.keyboard.up('KeyW');
await p.waitForTimeout(1000);
const log = await p.evaluate(() => window.__vmlog);
const keys = (r) => JSON.stringify(r.slice(0, 9).concat([r[10]]));
let flips = 0; for (let i = 1; i < log.length; i++) if (keys(log[i]) !== keys(log[i - 1])) flips++;
console.log('frames', log.length, 'state changes', flips);
const uniq = new Map(); for (const r of log) { const k = keys(r); uniq.set(k, (uniq.get(k) ?? 0) + 1); }
for (const [k, n] of uniq) console.log(n, k);
console.log('sample vm pos', log.slice(-5).map((r) => r[9]).join(' | '));
await b.close();

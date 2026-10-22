// Screenshot helper: node scripts/shot.mjs "<query>" out.png [waitMs]
import { chromium } from 'playwright-core';
const [q = '', out = 'shot.png', wait = '6000'] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, env: { ...process.env, DRI_PRIME: process.env.GPU === 'intel' ? '0' : '1' }, args: ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
p.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
p.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await p.goto(`http://localhost:5173/?${q}`);
await p.waitForFunction(() => window.__ready === true, null, { timeout: 180000 }).catch(() => logs.push('timeout waiting for __ready'));
await p.waitForTimeout(Number(wait));
const fps = await p.evaluate(() => `${window.__fps ?? ''} | ${window.__prof ?? ''} | ${JSON.stringify(window.__game?.prof ?? {})} | soldiers=${window.__game?.soldiers.length}`);
const n = Number(process.env.SHOTS ?? 1), iv = Number(process.env.INTERVAL ?? 500);
for (let i = 0; i < n; i++) { await p.screenshot({ path: n > 1 ? out.replace(/\.png$/, `_${i}.png`) : out }); if (i < n - 1) await p.waitForTimeout(iv); }
console.log(logs.filter((l) => !l.includes('Download the React')).slice(0, 30).join('\n'));
if (fps) console.log('fps', fps);
await b.close();

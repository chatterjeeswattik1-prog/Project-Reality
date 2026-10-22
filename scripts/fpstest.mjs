// Frame rate in play (player deployed, bots fighting): node scripts/fpstest.mjs "<query>" [seconds]
import { chromium } from 'playwright-core';
const [q = 'mode=test&auto=us&q=low', secs = '20'] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, env: { ...process.env, DRI_PRIME: '1' }, args: ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', (e) => console.log('pageerror', e.message));
await p.goto(`http://localhost:5173/?${q}`);
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
await p.waitForTimeout(3000);
const r = await p.evaluate((secs) => new Promise((res) => {
  const t0 = performance.now(); let n = 0, worst = 0, last = t0;
  const f = () => { const t = performance.now(); worst = Math.max(worst, t - last); last = t; n++; if (t - t0 < secs * 1000) requestAnimationFrame(f); else res({ fps: (n * 1000 / (t - t0)).toFixed(1), worstMs: worst.toFixed(0), prof: window.__prof }); };
  requestAnimationFrame(f);
}), Number(secs));
console.log(JSON.stringify(r));
await b.close();

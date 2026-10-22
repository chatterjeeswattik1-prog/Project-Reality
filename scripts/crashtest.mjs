import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, env: { ...process.env, DRI_PRIME: '1' }, args: ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 480, height: 270 } });
p.on('pageerror', (e) => console.log('PAGEERROR', e.message, '\n  ' + (e.stack ?? '').split('\n').slice(0, 14).join('\n  ')));
p.on('console', (m) => { if (m.type() === 'error') console.log('console.error', m.text().slice(0, 300)); });
await p.goto(`http://localhost:5173/?mode=test&auto=${process.argv[2] ?? 'ins'}&q=low`);
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
for (let i = 0; i < Number(process.argv[3] ?? 18); i++) {
  await p.waitForTimeout(5000);
  console.log(await p.evaluate(() => { const g = window.__game; return `t=${g.time.toFixed(0)} ${g.mode.hudTop().replace(/<[^>]+>/g, ' ')}`; }));
}
await b.close();

// Print the nav path from each US bot to its order target and watch one bot for 10 s.
import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, env: { ...process.env, DRI_PRIME: '1' }, args: ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 480, height: 270 } });
p.on('pageerror', (e) => console.log('pageerror', e.message));
await p.goto(`http://localhost:5173/?mode=test&q=low&shot=-115,60,132,0,-89`);
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
await p.waitForTimeout(500);
console.log(await p.evaluate(() => {
  const d = window.__skirm, f = (v) => v.map((x) => x.toFixed(1)).join(',');
  const bt = [...d.bots.values()][0];
  const r = bt.nav.path(bt.s.pos, bt.order.pos);
  return `${bt.s.name} from ${f(bt.s.pos)}\n` + r.map(f).join(' -> ');
}));
for (let i = 0; i < 20; i++) {
  await p.waitForTimeout(500);
  console.log(await p.evaluate(() => {
    const d = window.__skirm, f = (v) => v ? v.map((x) => x.toFixed(1)).join(',') : '-';
    const bt = [...d.bots.values()][0];
    return `t=${window.__game.time.toFixed(1)} pos=${f(bt.s.pos)} vel=${f(bt.s.vel)} bound=${f(bt.bound)} pathI=${bt.pathI}/${bt.path.length} next=${f(bt.path[bt.pathI])} tac=${bt.tac} stuck=${bt.stuckT?.toFixed(1)}`;
  }));
}
await b.close();

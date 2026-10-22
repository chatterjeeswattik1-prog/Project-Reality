// Probe bot movement: order, bound, path, nav reachability of the order target.
import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, env: { ...process.env, DRI_PRIME: '1' }, args: ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 480, height: 270 } });
p.on('pageerror', (e) => console.log('pageerror', e.message));
await p.goto(`http://localhost:5173/?mode=test&q=low&shot=-115,60,132,0,-89`);
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
for (let i = 0; i < 4; i++) {
  await p.waitForTimeout(5000);
  console.log(await p.evaluate(() => {
    const g = window.__game, d = window.__skirm, f = (v) => v ? v.map((x) => x.toFixed(1)).join(',') : '-';
    return `t=${g.time.toFixed(0)} area=${JSON.stringify(g.city.area)}\n` + [...d.bots.values()].map((bt) => {
      const r = bt.nav?.path(bt.s.pos, bt.order.pos);
      return `  ${bt.s.team}:${bt.s.name.split(' ').pop()} order=${bt.order.kind}@${f(bt.order.pos)} pos=${f(bt.s.pos)} bound=${f(bt.bound)} boundT=${bt.boundT.toFixed(1)} path=${bt.path.length}/${bt.pathI} goal=${f(bt.goal)} navToOrder=${r ? r.length + ' end ' + f(r[r.length - 1]) : 'null'} movers=${g.movers(bt.s.team)}`;
    }).join('\n');
  }));
}
await b.close();

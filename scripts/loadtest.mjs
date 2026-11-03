// Loading screen on a throttled connection (production build on the preview server): screenshots of the boot screen,
// the main menu and the loading screen, and the progress text over time.  node scripts/loadtest.mjs <outPrefix> [Mbit=40]
import { launch } from './browser.mjs';
const [out = 'load', mbit = '40'] = process.argv.slice(2);
const b = await launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 720 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
const cdp = await ctx.newCDPSession(p);
await cdp.send('Network.enable');
await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 40, downloadThroughput: (Number(mbit) * 1e6) / 8, uploadThroughput: 1e6 });
await p.goto(`http://localhost:${process.env.PORT ?? 4173}/`);
await p.waitForTimeout(400); await p.screenshot({ path: `${out}_boot.png` });
await p.waitForSelector('.menu', { timeout: 120000 });
await p.waitForTimeout(3000); await p.screenshot({ path: `${out}_menu.png` });
console.log('menu corner:', await p.evaluate(() => document.querySelector('.bgdl')?.textContent));
// start the game (first big button in the menu)
const btn = await p.$('.menu button.big'); await btn.click();
for (let i = 0; i < 40; i++) {
  await p.waitForTimeout(3000);
  const r = await p.evaluate(() => ({ ready: !!window.__ready, msg: document.querySelector('.loading .msg')?.textContent, net: document.querySelector('.loading .net')?.textContent, bar: document.querySelector('.loading .bar > i')?.style.width }));
  console.log(`${(i + 1) * 3}s`, JSON.stringify(r));
  if (i === 2) await p.screenshot({ path: `${out}_loading.png` });
  if (r.ready) break;
}
await b.close();

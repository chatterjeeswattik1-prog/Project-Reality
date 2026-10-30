// Peak renderer memory while loading a page: node scripts/memwatch.mjs "<query>" [seconds]
// Samples CDP Memory/Performance metrics every 0.5 s (JS heap, and the process's private memory via SystemInfo).
import { launch } from './browser.mjs';
const [q = 'q=medium&auto=us', secs = '60'] = process.argv.slice(2);
const b = await launch(['--enable-precise-memory-info']);
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
const cdp = await p.context().newCDPSession(p);
await cdp.send('Performance.enable');
const stages = [];
p.on('console', (m) => { if (m.type() === 'error') stages.push('ERR ' + m.text().slice(0, 100)); });
p.on('crash', () => stages.push('CRASH'));
p.goto(`http://localhost:5173/?${q}`).catch(() => {});
let peak = 0, peakJs = 0; const t0 = Date.now();
while (Date.now() - t0 < Number(secs) * 1000) {
  await new Promise((r) => setTimeout(r, 500));
  try {
    const { metrics } = await cdp.send('Performance.getMetrics');
    const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
    const pi = await cdp.send('SystemInfo.getProcessInfo').catch(() => null);
    const js = m.JSHeapUsedSize / 1e6;
    peakJs = Math.max(peakJs, js);
    const st = await p.evaluate(() => (window.__mem ?? []).map((x) => x[0].slice(0, 14)).pop() ?? '').catch(() => '?');
    const ready = await p.evaluate(() => window.__ready === true).catch(() => false);
    console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s js=${js.toFixed(0)}MB stage=${st}${ready ? ' READY' : ''}`);
    if (ready) break;
  } catch (e) { console.log('err', e.message.slice(0, 80)); break; }
}
console.log('peak js', peakJs.toFixed(0), stages.join(' | '));
await b.close();

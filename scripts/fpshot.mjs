// Screenshot the dev rig viewer: node scripts/fpshot.mjs out.png "<query>" [more "out|query" pairs...]
import { launch } from './browser.mjs';
const jobs = []; const a = process.argv.slice(2);
for (let i = 0; i < a.length; i += 2) jobs.push([a[i], a[i + 1]]);
const b = await launch();
const p = await b.newPage({ viewport: { width: Number(process.env.W ?? 960), height: Number(process.env.H ?? 540) } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
p.on('console', (m) => { if (m.type() === 'error') console.log('[error]', m.text()); });
for (const [out, q] of jobs) {
  await p.goto(`http://localhost:5173/fpview.html?${q}`);
  await p.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
  await p.screenshot({ path: out });
  console.log(out, JSON.stringify(await p.evaluate(() => window.__info)));
}
await b.close();

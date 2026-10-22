// Watch a bot-only 3v3 round in the test area and print each bot's tactical state over time.
import { chromium } from 'playwright-core';
const secs = Number(process.argv[2] ?? 60);
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, env: { ...process.env, DRI_PRIME: '1' }, args: ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
p.on('pageerror', (e) => console.log('pageerror', e.message));
await p.goto(`http://localhost:5173/?mode=test&q=low&shot=-115,60,132,0,-89`);
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
for (let t = 0; t < secs; t += 4) {
  await p.waitForTimeout(4000);
  const r = await p.evaluate(() => {
    const g = window.__game, d = window.__skirm;
    const rows = [...d.bots.values()].map((bt) => `${bt.s.team}:${bt.s.name.split(' ').pop()} ${bt.s.state[0]} ${bt.tac}${bt.coverPt ? (bt.coverPt.low ? '(lo)' : '(hi)') : ''} ${bt.s.stance[0]} hp${Math.round(bt.s.health)} tgt=${bt.target ? 'Y' : '-'} mag=${bt.s.slot.loaded} shots=${bt.s.shots} pos=${bt.s.pos.map((v) => v.toFixed(0)).join(",")} seen=${bt.lastSeen ? (g.time - bt.lastSeen.t).toFixed(0) : "-"}`);
    return `t=${g.time.toFixed(0)} ${g.mode.hudTop().replace(/<[^>]+>/g, '')}\n  ` + rows.join('\n  ') + '\n  log: ' + g.mode.log.slice(-2).map((l) => l.text).join(' | ');
  });
  console.log(r);
}
await b.close();

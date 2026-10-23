// Watch a bot-only round in the test area (US fireteam v insurgent cell) and print the team brains' states and each
// bot's task and tactical state over time: node scripts/aitest.mjs [seconds] [extra query]
import { launch } from './browser.mjs';
const secs = Number(process.argv[2] ?? 60);
const b = await launch();
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
p.on('pageerror', (e) => console.log('pageerror', e.message));
await p.goto(`http://localhost:5173/?mode=test&q=low&shot=-115,60,132,0,-89${process.argv[3] ? '&' + process.argv[3] : ''}`);
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
for (let t = 0; t < secs; t += 4) {
  await p.waitForTimeout(4000);
  const r = await p.evaluate(() => {
    const g = window.__game, d = window.__skirm;
    const rows = [...d.bots.values()].map((bt) => `${bt.s.team}:${bt.s.name.split(' ').pop()} ${bt.s.state[0]} ${bt.task ? bt.task.kind + (bt.taskDone ? '✓' : '') : '-'} ${bt.tac}${bt.coverPt ? (bt.coverPt.low ? '(lo)' : '(hi)') : ''} ${bt.s.stance[0]} hp${Math.round(bt.s.health)} tgt=${bt.target ? 'Y' : '-'} mag=${bt.s.slot.loaded} shots=${bt.s.shots} pos=${bt.s.pos.map((v) => v.toFixed(0)).join(",")} seen=${bt.lastSeen ? (g.time - bt.lastSeen.t).toFixed(0) : "-"}`);
    return `t=${g.time.toFixed(0)} ${g.mode.hudTop().replace(/<[^>]+>/g, '')}\n  ` + rows.join('\n  ') + '\n  log: ' + g.mode.log.slice(-2).map((l) => l.text).join(' | ');
  });
  console.log(r);
}
await b.close();

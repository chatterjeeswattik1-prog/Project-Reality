import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, env: { ...process.env, DRI_PRIME: '1' }, args: ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 480, height: 270 } });
p.on('pageerror', (e) => console.log('pageerror', e.message));
await p.goto(`http://localhost:5173/?mode=test&q=low&shot=-115,60,132,0,-89`);
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
// Force round 1 to end: wound all insurgents.
await p.waitForTimeout(2000);
await p.evaluate(() => { const g = window.__game; for (const s of g.soldiers) if (s.team === 'ins') g.hitSoldier(s, s.eye, 'chest', { id: '556', dmg: 300, pen: 1, v0: 900, k: 0.001 }, g.soldiers.find((o) => o.team === 'us')); });
for (let i = 0; i < 30; i++) {
  await p.waitForTimeout(400);
  const r = await p.evaluate(() => { const g = window.__game; return `t=${g.time.toFixed(1)} ${g.mode.hudTop().replace(/<[^>]+>/g, ' ')} | ` + g.soldiers.map((s) => `${s.team}:${s.state[0]}${Math.round(s.health)}@${s.pos[0].toFixed(0)},${s.pos[1].toFixed(1)},${s.pos[2].toFixed(0)}`).join(' '); });
  console.log(r);
}
await b.close();

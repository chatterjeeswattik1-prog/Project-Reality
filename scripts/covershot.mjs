import { chromium } from 'playwright-core';
const out = process.argv[2] ?? 'cover';
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, env: { ...process.env, DRI_PRIME: '1' }, args: ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 960, height: 540 } });
await p.goto(`http://localhost:5173/?mode=test&q=medium&shot=-115,60,132,0,-89`);
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
let n = 0;
for (let i = 0; i < 60 && n < 3; i++) {
  await p.waitForTimeout(700);
  const info = await p.evaluate(() => {
    const g = window.__game, d = window.__skirm, cam = g.gfx.camera;
    const b = [...d.bots.values()].find((x) => (x.tac === 'hide' || x.tac === 'peek') && x.coverPt && x.lastSeen && x.s.alive);
    if (!b) return null;
    const s = b.s, t = b.lastSeen.p, dx = t[0] - s.pos[0], dz = t[2] - s.pos[2], L = Math.hypot(dx, dz) || 1;
    // Look from the side-front (between the bot and its threat, offset sideways) so the bot and its cover are visible.
    cam.position.set(s.pos[0] + dx / L * 5 - dz / L * 3, s.pos[1] + 2.2, s.pos[2] + dz / L * 5 + dx / L * 3);
    cam.lookAt(s.pos[0], s.pos[1] + 0.8, s.pos[2]);
    window.__hold = true;
    return `${s.team} ${s.name} ${b.tac} ${b.coverPt.low ? 'low' : 'high'} h=${b.coverPt.h.toFixed(1)} stance=${s.stance}`;
  });
  if (info) { await p.waitForTimeout(60); await p.screenshot({ path: `${out}_${n}.png` }); console.log(n, info); n++; await p.waitForTimeout(2500); }
}
await b.close();

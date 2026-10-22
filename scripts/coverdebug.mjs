import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, env: { ...process.env, DRI_PRIME: '1' }, args: ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 320, height: 180 } });
await p.goto(`http://localhost:5173/?mode=test&q=low&shot=-115,60,132,0,-89`);
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
for (let i = 0; i < 40; i++) {
  await p.waitForTimeout(600);
  const r = await p.evaluate(() => {
    const g = window.__game, d = window.__skirm;
    const b = [...d.bots.values()].find((x) => x.tac === 'hide' && x.coverPt && x.lastSeen && x.s.alive);
    if (!b) return null;
    const c = b.coverPt, t = b.lastSeen.p, eye = [t[0], t[1] + 1.5, t[2]], chest = [c.p[0], c.p[1] + (c.low ? 0.85 : 1.35), c.p[2]];
    const dx = chest[0] - eye[0], dy = chest[1] - eye[1], dz = chest[2] - eye[2], L = Math.hypot(dx, dy, dz);
    const hit = g.P.castRay(eye, [dx / L, dy / L, dz / L], L - 0.05);
    return { bot: b.s.name, cover: c.p.map((v) => +v.toFixed(1)), n: c.n.map((v) => +v.toFixed(2)), low: c.low, h: +c.h.toFixed(2), threat: t.map((v) => +v.toFixed(1)), hit: hit ? { d: +hit.dist.toFixed(1), of: +L.toFixed(1), p: hit.point.map((v) => +v.toFixed(1)), surf: hit.surf } : null };
  });
  if (r) { console.log(JSON.stringify(r)); break; }
}
await b.close();

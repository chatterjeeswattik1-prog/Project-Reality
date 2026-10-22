import { chromium } from 'playwright-core';
const out = process.argv[2];
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, env: { ...process.env, DRI_PRIME: '1' }, args: ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
const logs = []; p.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`)); p.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
await p.goto('http://localhost:5173/?mode=test&q=medium&bots=0&shot=-110,1.6,140,0,0');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 180000 });
await p.waitForTimeout(3000);
const info = await p.evaluate(() => { const d = window.__game.doors; return { n: d.list.length, s: d.list.slice(0, 40).map((x) => [x.hinge.x.toFixed(1), x.hinge.y.toFixed(1), x.hinge.z.toFixed(1), x.base.toFixed(2), x.swing, x.angle.toFixed(2), x.w.toFixed(2), x.metal]) }; });
console.log('doors', info.n);
// pick 3 ground-floor doors and view each from 3 m on one side
const picks = await p.evaluate(() => window.__game.doors.list.filter((d) => d.hinge.y < 1).slice(0, 4).map((d) => { const yaw = d.base; return { x: d.hinge.x, y: d.hinge.y, z: d.hinge.z, yaw, w: d.w }; }));
let i = 0;
for (const d of picks) {
  for (const side of [1, -1]) {
    await p.evaluate(({ d, side }) => {
      const cam = window.__game.camera ?? null;
      const W = window; W.__hold = true;
      const c = W.__cam ?? null;
    }, { d, side });
    await p.evaluate(({ d, side }) => {
      const THREE = window.__THREE; const g = window.__game;
      const cam = window.__G.camera;
      // leaf direction closed
      const lx = Math.cos(d.yaw), lz = -Math.sin(d.yaw); const nx = -lz * side, nz = lx * side;
      const mx = d.x + lx * d.w / 2, mz = d.z + lz * d.w / 2;
      cam.position.set(mx + nx * 3, d.y + 1.6, mz + nz * 3); cam.lookAt(mx, d.y + 1.1, mz);
    }, { d, side });
    await p.waitForTimeout(800);
    await p.screenshot({ path: `${out}_${i++}.png` });
  }
}
console.log(logs.join('\n'));
await b.close();

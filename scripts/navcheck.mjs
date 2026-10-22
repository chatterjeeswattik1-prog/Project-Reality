// Navmesh check at a point: polygon, step towards a target, and raycast.
import { chromium } from 'playwright-core';
const [from = '-159.9,0.4,131.3', to = '-161.1,0.4,128.1'] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, env: { ...process.env, DRI_PRIME: '1' }, args: ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 480, height: 270 } });
p.on('pageerror', (e) => console.log('pageerror', e.message));
await p.goto(`http://localhost:5173/?mode=test&q=low&bots=0&shot=-115,60,132,0,-89`);
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
console.log(await p.evaluate(([a, c]) => {
  const d = window.__skirm, nav = d.nav ?? [...d.bots.values()][0]?.nav ?? window.__nav;
  if (!nav) return 'no nav: ' + Object.keys(d).join(',');
  const A = a.split(',').map(Number), B = c.split(',').map(Number), q = nav.q;
  const ref = nav.ref(A), out = [`ref=${ref}`];
  let pos = A, r = ref;
  for (let i = 0; i < 40; i++) { const s = nav.step(r, pos, [pos[0] + (B[0] - pos[0]) * 0.1, pos[1], pos[2] + (B[2] - pos[2]) * 0.1]); if (!s) { out.push('step null'); break; } pos = s.p; r = s.ref; }
  out.push(`after steps: ${pos.map((v) => v.toFixed(2))}`);
  const path = nav.path(A, B); out.push(`path: ${path?.map((v) => v.map((x) => x.toFixed(1)).join(',')).join(' -> ')}`);
  const rc = q.raycast(ref, { x: A[0], y: A[1], z: A[2] }, { x: B[0], y: B[1], z: B[2] }); out.push(`raycast t=${rc.t} hitNormal=${JSON.stringify(rc.hitNormal)} path=${rc.path?.length}`);
  return out.join('\n');
}, [from, to]));
await b.close();

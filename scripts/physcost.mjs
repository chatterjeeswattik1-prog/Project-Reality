// Physics cost on the full map: mean world.step() time and the cost of 2000 ray casts (bots' sight lines).
//   node scripts/physcost.mjs
import { launch } from './browser.mjs';
const b = await launch();
const p = await b.newPage({ viewport: { width: 800, height: 450 } });
await p.goto('http://localhost:5173/?q=low&bots=0&shot=0,30,0,0,0');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
await p.waitForTimeout(3000);
console.log(JSON.stringify(await p.evaluate(() => {
  const P = window.__game.P; let s0 = 5; const rnd = () => ((s0 = (s0 * 1664525 + 1013904223) >>> 0) / 4294967296);
  let t = performance.now(); for (let i = 0; i < 120; i++) P.world.step(); const step = (performance.now() - t) / 120;
  t = performance.now(); let hits = 0;
  for (let i = 0; i < 2000; i++) { const x = (rnd() - 0.5) * 900, z = (rnd() - 0.5) * 900, a = rnd() * 6.28; if (P.castRay([x, 1.5, z], [Math.cos(a), 0, Math.sin(a)], 120)) hits++; }
  const ray = (performance.now() - t) / 2000 * 1000;
  return { stepMs: +step.toFixed(2), rayUs: +ray.toFixed(1), hits, colliders: P.world.colliders.len() };
})));
await b.close();

// Probe every building's outer walls at low heights (10–60 cm above the outside ground) with rays from 2 m outside
// towards the centre: a ray that gets more than 0.6 m past the footprint edge without hitting anything went under or
// through the wall (unless a doorway is there). node scripts/wallgap.mjs
import { launch } from './browser.mjs';
const b = await launch();
const p = await b.newPage({ viewport: { width: 400, height: 300 } });
await p.goto('http://localhost:5173/?mode=test&auto=us&shot');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
const r = await p.evaluate(() => {
  const g = window.__game, P = g.P, city = window.__city, out = [];
  const gy = (x, z) => { const h = P.castRay([x, 40, z], [0, -1, 0], 80); return h ? h.point[1] : 0; };
  let rays = 0;
  for (const bd of g.city?.buildings ?? city.buildings) {
    const s = bd.spec, cx = (s.x0 + s.x1) / 2, cz = (s.z0 + s.z1) / 2;
    const near = (x, z) => bd.doorways.some((d) => Math.hypot(d.x - x, d.z - z) < d.w / 2 + 0.6);
    for (const side of [0, 1, 2, 3]) for (let k = 0.1; k < 0.95; k += 0.1) {
      const ex = side === 0 ? s.x0 : side === 1 ? s.x1 : s.x0 + (s.x1 - s.x0) * k, ez = side === 2 ? s.z0 : side === 3 ? s.z1 : s.z0 + (s.z1 - s.z0) * k;
      if (near(ex, ez)) continue;
      const nx = side === 0 ? -1 : side === 1 ? 1 : 0, nz = side === 2 ? -1 : side === 3 ? 1 : 0;
      const ox = ex + nx * 2, oz = ez + nz * 2, g0 = gy(ox, oz);
      for (const h of [0.1, 0.3, 0.6]) {
        rays++;
        const hit = P.castRay([ox, g0 + h, oz], [-nx, 0, -nz], 4);
        if (!hit || hit.dist > 2.6) out.push({ b: bd.id, side, h, at: [+ex.toFixed(2), +(g0 + h).toFixed(2), +ez.toFixed(2)], floorY: +s.y0.toFixed(2), hit: hit ? +hit.dist.toFixed(2) : null });
      }
    }
  }
  return { rays, n: out.length, out: out.slice(0, 40), byB: Object.entries(out.reduce((m, o) => (m[o.b] = (m[o.b] || 0) + 1, m), {})) };
});
console.log('rays', r.rays, 'gaps', r.n, 'per building', JSON.stringify(r.byB));
for (const o of r.out) console.log(JSON.stringify(o));
await b.close();

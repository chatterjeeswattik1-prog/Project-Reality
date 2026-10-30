// Props stuck into walls: sample points inside each prop's collision boxes (shrunk 25%) and test them against the
// city's static boxes (walls, floors, kerbs). node scripts/overlapcheck.mjs [test]
import { launch } from './browser.mjs';
const test = process.argv[2] === 'test';
const b = await launch();
const p = await b.newPage({ viewport: { width: 400, height: 300 } });
await p.goto(test ? 'http://localhost:5173/?mode=test&auto=us&shot' : 'http://localhost:5173/?q=low&bots=0&shot=0,40,0,0,-89');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
const r = await p.evaluate(() => {
  const P = window.__game.P, B = P.boxes, N = P.cityBoxN, out = {}, ex = [];
  const rot = (q, v) => { const [x, y, z, w] = q, [vx, vy, vz] = v; const ix = w * vx + y * vz - z * vy, iy = w * vy + z * vx - x * vz, iz = w * vz + x * vy - y * vx, iw = -x * vx - y * vy - z * vz; return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x]; };
  const inCity = (x, y, z) => {
    for (const bx of P.boxesNear(x, z, 3)) {
      const i = B.indexOf(bx); if (i < 0 || i >= N) continue;
      let dx = x - bx.c[0], dy = y - bx.c[1], dz = z - bx.c[2];
      if (bx.q) { const v = rot([-bx.q[0], -bx.q[1], -bx.q[2], bx.q[3]], [dx, dy, dz]); dx = v[0]; dy = v[1]; dz = v[2]; }
      if (Math.abs(dx) < bx.h[0] - 0.02 && Math.abs(dy) < bx.h[1] - 0.02 && Math.abs(dz) < bx.h[2] - 0.02) return bx;
    }
    return null;
  };
  // group prop boxes by placement (consecutive boxes with the same id and close centres)
  let n = 0;
  for (let i = N; i < B.length; i++) {
    const bx = B[i]; n++;
    let hit = null;
    for (const s of [[0, 0, 0], [0.75, 0, 0.75], [-0.75, 0, 0.75], [0.75, 0, -0.75], [-0.75, 0, -0.75], [0, 0.6, 0]]) {
      let v = [s[0] * bx.h[0], s[1] * bx.h[1], s[2] * bx.h[2]]; if (bx.q) v = rot(bx.q, v);
      hit = inCity(bx.c[0] + v[0], bx.c[1] + v[1], bx.c[2] + v[2]); if (hit) break;
    }
    if (hit) { const k = `${bx.s}`; out[k] = (out[k] || 0) + 1; if (ex.length < 400) ex.push({ c: bx.c.map((v) => +v.toFixed(1)), wall: [hit.c.map((v) => +v.toFixed(1)), hit.h.map((v) => +v.toFixed(2)), hit.tag] }); }
  }
  // name the props at the hits
  const props = window.__city.props;
  const named = {};
  for (const e of ex) { let best = null, bd = 3; for (const pr of props) { const d = Math.hypot(pr.x - e.c[0], pr.z - e.c[2]); if (d < bd && pr.solid) { bd = d; best = pr.id; } } e.id = best; named[best] = (named[best] || 0) + 1; }
  return { n, out, named, ex: ex.slice(0, 15) };
});
console.log('prop boxes', r.n, 'overlapping city geometry by surface', JSON.stringify(r.out));
console.log('by prop', JSON.stringify(Object.entries(r.named).sort((a, b) => b[1] - a[1])));
for (const e of r.ex) console.log(JSON.stringify(e));
await b.close();

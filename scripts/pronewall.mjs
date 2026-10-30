// Prone into walls: place the player prone 0.6 m outside building walls (away from doorways), crawl into the wall for
// 3 s (also at 35° to it), and report any case where the body ends up past the wall line. node scripts/pronewall.mjs [n=24] [stance=prone]
import { launch } from './browser.mjs';
const n = Number(process.argv[2] ?? 24), stance = process.argv[3] ?? 'prone';
const b = await launch();
const p = await b.newPage({ viewport: { width: 400, height: 300 } });
await p.goto('http://localhost:5173/?mode=test&auto=us');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
if (process.argv[4] === 'any') await p.evaluate(() => { window.__anyWall = true; });
// No bots shooting the test subject: everyone else is taken out of play.
await p.evaluate(() => { for (const o of window.__game.soldiers) if (!o.isPlayer) { o.state = 'dead'; o.pos = [o.pos[0], -100, o.pos[2]]; } });
const cases = await p.evaluate(({ n }) => {
  const g = window.__game, P = g.P, city = window.__city, out = [];
  const gy = (x, z, top) => { const h = P.castRay([x, top, z], [0, -1, 0], top + 5); return h ? h.point[1] : 0; };
  // Any thin tall static box (yard and compound walls, interior walls, fences, low walls) as well as building walls.
  if (window.__anyWall) {
    for (const bx of P.boxes) {
      if (bx.q || bx.tag === undefined) continue;
      const thinX = bx.h[0] < 0.2 && bx.h[2] > 0.6, thinZ = bx.h[2] < 0.2 && bx.h[0] > 0.6;
      if (!(thinX || thinZ) || bx.h[1] < 0.4) continue;
      for (const sg of [-1, 1]) {
        const nx = thinX ? sg : 0, nz = thinZ ? sg : 0, ex = bx.c[0] + nx * bx.h[0], ez = bx.c[2] + nz * bx.h[2];
        const ox = ex + nx * 0.7, oz = ez + nz * 0.7, y = gy(ox, oz, bx.c[1] + bx.h[1] + 3);
        if (y > bx.c[1] - bx.h[1] + 0.3 || y < bx.c[1] - bx.h[1] - 0.5) continue; // the wall must stand on this ground
        if (!P.fits([ox, y, oz])) continue;
        out.push({ b: 'box', ex, ez, nx, nz, ox, oz, y, wall: [bx.c.map((v) => +v.toFixed(2)), bx.h.map((v) => +v.toFixed(2)), bx.s] });
      }
    }
    return out.sort(() => 0.5 - Math.random()).slice(0, n);
  }
  for (const bd of city.buildings) {
    const s = bd.spec;
    for (const side of [0, 1, 2, 3]) for (const k of [0.3, 0.7]) {
      const ex = side === 0 ? s.x0 : side === 1 ? s.x1 : s.x0 + (s.x1 - s.x0) * k, ez = side === 2 ? s.z0 : side === 3 ? s.z1 : s.z0 + (s.z1 - s.z0) * k;
      if (bd.doorways.some((d) => Math.hypot(d.x - ex, d.z - ez) < d.w / 2 + 1)) continue;
      const nx = side === 0 ? -1 : side === 1 ? 1 : 0, nz = side === 2 ? -1 : side === 3 ? 1 : 0;
      const ox = ex + nx * 0.7, oz = ez + nz * 0.7, y = gy(ox, oz, s.y0 + 1.5);
      if (Math.abs(y - s.y0) > 1.2) continue;
      if (!P.fits([ox, y, oz])) continue;
      out.push({ b: bd.id, ex, ez, nx, nz, ox, oz, y });
    }
  }
  return out.sort(() => 0.5 - Math.random()).slice(0, n);
}, { n });
const fails = [];
for (const c of cases) for (const ang of [0, 0.6]) {
  const r = await p.evaluate(async ({ c, ang, stance }) => {
    const g = window.__game, s = g.player.s, I = window.__input;
    if (!s.alive) return { skip: true, past: 0, eyePast: 0 };
    s.setStance('stand', 0);
    s.pos = [c.ox, c.y + 0.05, c.oz]; s.vel = [0, 0, 0];
    s.body.setTranslation({ x: c.ox, y: c.y + 0.95, z: c.oz }, true);
    // face the wall (forward = -sin(yaw), -cos(yaw)), optionally at an angle
    s.yaw = Math.atan2(c.nx, c.nz) + ang; s.pitch = 0;
    await new Promise((r) => setTimeout(r, 200));
    s.setStance(stance, 0);
    await new Promise((r) => setTimeout(r, 900));
    I.down.add('KeyW');
    await new Promise((r) => setTimeout(r, 3000));
    I.down.delete('KeyW');
    // signed distance past the wall line (positive = inside the building)
    const past = -((s.pos[0] - c.ex) * c.nx + (s.pos[2] - c.ez) * c.nz);
    const eye = s.eye, eyePast = -((eye[0] - c.ex) * c.nx + (eye[2] - c.ez) * c.nz);
    return { past: +past.toFixed(2), eyePast: +eyePast.toFixed(2), stance: s.stance, y: +s.pos[1].toFixed(2) };
  }, { c, ang, stance });
  if (r.past > 0.05 || r.eyePast > 0.05) fails.push({ b: c.b, wall: c.wall, at: [+c.ex.toFixed(2), +c.ez.toFixed(2)], n: [c.nx, c.nz], ang, ...r });
}
console.log(`cases ${cases.length * 2}, through-wall ${fails.length}`);
for (const f of fails) console.log(JSON.stringify(f));
await b.close();

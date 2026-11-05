// Building texture check: screenshots of buildings with a given wall material (default: the plaster/clay sets).
//   node scripts/texshot.mjs <outPrefix> [mat,mat,...]
import { launch } from './browser.mjs';
const out = process.argv[2] || 'tex';
const mats = (process.argv[3] || 'plaster_a,plaster_b,clay').split(',');
const b = await launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.goto('http://localhost:5173/?q=high&bots=0&shot=0,40,0,0,-10');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
for (const m of mats) {
  for (let k = 0; k < 2; k++) {
    const ok = await p.evaluate(([m, k]) => {
      const bs = window.__city.buildings.filter((x) => x.spec.wall === m && !x.spec.hall);
      const bi = bs[(k * 37 + 5) % Math.max(1, bs.length)]; if (!bi) return false;
      const s = bi.spec, cx = (s.x0 + s.x1) / 2, cz = (s.z0 + s.z1) / 2;
      // Stand in front of the street face, 14 m out, at eye height + a bit, looking at the facade.
      const d = [[0, -1], [1, 0], [0, 1], [-1, 0]][s.orient], half = s.orient % 2 === 0 ? (s.z1 - s.z0) / 2 : (s.x1 - s.x0) / 2;
      const x = cx + d[0] * (half + 14), z = cz + d[1] * (half + 14);
      const cam = window.__G.camera; window.__hold = true;
      cam.position.set(x + d[1] * 4, s.y0 + 3, z - d[0] * 4);
      cam.lookAt(cx, s.y0 + 4, cz);
      return `${m} #${bi.id} at ${cx.toFixed(0)},${cz.toFixed(0)}`;
    }, [m, k]);
    console.log(ok);
    if (!ok) continue;
    await p.waitForTimeout(2500);
    await p.screenshot({ path: `${out}_${m}_${k}.png` });
  }
}
await b.close();

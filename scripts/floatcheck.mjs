// Props with nothing under them: for each prop cast a ray down from 0.3 m above its base; a gap > 0.35 m is floating.
// node scripts/floatcheck.mjs [test]
import { launch } from './browser.mjs';
const test = process.argv[2] === 'test';
const b = await launch();
const p = await b.newPage({ viewport: { width: 400, height: 300 } });
await p.goto(test ? 'http://localhost:5173/?mode=test&auto=us&shot' : 'http://localhost:5173/?q=low&bots=0&shot=0,40,0,0,-89');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
const r = await p.evaluate(() => {
  const P = window.__game.P, city = window.__city, out = {}, ex = [];
  const skip = /^(ceiling_fan|bulb_hanging|wall_shelf|picture_frame|curtain_|street_light|power_pole|palm|bush|grass|veh:|flag)/;
  let n = 0;
  for (const pr of city.props) {
    if (skip.test(pr.id)) continue;
    if (city.area && (pr.x < city.area.x0 || pr.x > city.area.x1 || pr.z < city.area.z0 || pr.z > city.area.z1)) continue;
    n++;
    const h = P.castRay([pr.x, pr.y + 0.3, pr.z], [0, -1, 0], 20);
    const gap = h ? h.dist - 0.3 : 99;
    if (gap > 0.35) { out[pr.id] = (out[pr.id] || 0) + 1; if (ex.length < 12) ex.push({ id: pr.id, p: [pr.x, pr.y, pr.z].map((v) => +v.toFixed(1)), gap: +gap.toFixed(2) }); }
  }
  return { n, out, ex };
});
console.log('props checked', r.n, JSON.stringify(r.out)); for (const e of r.ex) console.log(JSON.stringify(e));
await b.close();

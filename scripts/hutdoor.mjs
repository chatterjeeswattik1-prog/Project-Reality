// Close-ups of roof-hut doorways (located by their lintel): node scripts/hutdoor.mjs <outPrefix> [ids...]
import { launch } from './browser.mjs';
const [out, ...ids] = process.argv.slice(2);
const b = await launch();
const p = await b.newPage({ viewport: { width: 960, height: 540 } });
await p.goto('http://localhost:5173/?mode=test&auto=us');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
await p.evaluate(() => { for (const o of window.__game.soldiers) if (!o.isPlayer) { o.state = 'dead'; o.pos = [o.pos[0], -100, o.pos[2]]; o.body.setTranslation({ x: o.pos[0], y: -100, z: o.pos[2] }, true); } });
for (const id of ids.map(Number)) for (const [k, side] of [[0, 1.4], [1, -1.4], [2, 0]]) {
  const r = await p.evaluate(async ({ id, side }) => {
    const g = window.__game, s = g.player.s, B = window.__city.buildings[id], sp = B.spec, ry = B.roofY;
    const L = g.P.boxesNear((sp.x0 + sp.x1) / 2, (sp.z0 + sp.z1) / 2, 30).filter((x) => x.tag === B.id && Math.abs(x.c[1] - (ry + 2.3)) < 0.12 && x.h[1] < 0.25 && Math.min(x.h[0], x.h[2]) < 0.2 && Math.max(x.h[0], x.h[2]) < 0.6);
    if (!L.length) return null;
    const d = L[0], thinX = d.h[0] < d.h[2];
    // the open-roof side: the side of the lintel away from the building centre is outside; inside the hut is the stair
    const cx = (sp.x0 + sp.x1) / 2, cz = (sp.z0 + sp.z1) / 2;
    let nx = thinX ? Math.sign(cx - d.c[0]) || 1 : 0, nz = thinX ? 0 : Math.sign(cz - d.c[2]) || 1;
    const px = d.c[0] + nx * 3.2 + (thinX ? 0 : side), pz = d.c[2] + nz * 3.2 + (thinX ? side : 0);
    const h = g.P.castRay([px, ry + 3, pz], [0, -1, 0], 6), y = h ? h.point[1] : ry;
    s.pos = [px, y + 0.05, pz]; s.body.setTranslation({ x: px, y: y + 0.95, z: pz }, true); s.vel = [0, 0, 0];
    s.yaw = Math.atan2(px - d.c[0], pz - d.c[2]); s.pitch = 0.12;
    await new Promise((r) => setTimeout(r, 900));
    return { lintel: d.c, h: d.h };
  }, { id, side });
  if (!r) { console.log('no lintel', id); break; }
  console.log(id, k, JSON.stringify(r));
  await p.screenshot({ path: `${out}_${id}_${k}.png` });
}
await b.close();

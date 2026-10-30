// Screenshots round roof stair huts: node scripts/roofhut.mjs <outPrefix> [buildingIndex...]
import { launch } from './browser.mjs';
const [out, ...ids] = process.argv.slice(2);
const b = await launch();
const p = await b.newPage({ viewport: { width: 960, height: 540 } });
await p.goto('http://localhost:5173/?mode=test&auto=us');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
await p.evaluate(() => { window.__R = 7; }); await p.evaluate(() => { for (const o of window.__game.soldiers) if (!o.isPlayer) { o.state = 'dead'; o.pos = [o.pos[0], -100, o.pos[2]]; } });
const list = await p.evaluate(() => window.__city.buildings.map((b, i) => ({ i, stairs: b.spec.stairs, floors: b.spec.floors, roof: b.roof.length, parapet: b.spec.parapet, hall: b.spec.hall })));
console.log(JSON.stringify(list));
for (const id of ids.length ? ids.map(Number) : list.filter((x) => x.roof).slice(0, 3).map((x) => x.i)) {
  for (const [k, yawOff] of [[0, 0], [1, Math.PI / 2], [2, Math.PI], [3, -Math.PI / 2]]) {
    const r = await p.evaluate(async ({ id, yawOff }) => {
      const g = window.__game, s = g.player.s, B = window.__city.buildings[id];
      // the hut: highest static box above roofY near the building — aim at the centre of colliders above roofY + 1
      const sp = B.spec, ys = B.roofY;
      const near = g.P.boxesNear((sp.x0 + sp.x1) / 2, (sp.z0 + sp.z1) / 2, Math.max(sp.x1 - sp.x0, sp.z1 - sp.z0)).filter((x) => x.c[1] > ys + 1 && x.c[1] < ys + 3 && x.tag === B.id);
      if (!near.length) return null;
      const hc = [near.reduce((a, x) => a + x.c[0], 0) / near.length, near.reduce((a, x) => a + x.c[2], 0) / near.length];
      const R = Number(window.__R ?? 3.6), px = hc[0] + Math.sin(yawOff) * R, pz = hc[1] + Math.cos(yawOff) * R;
      const h = g.P.castRay([px, ys + 3, pz], [0, -1, 0], 6); const y = h ? h.point[1] : ys;
      s.pos = [px, y + 0.05, pz]; s.body.setTranslation({ x: px, y: y + 0.95, z: pz }, true); s.vel = [0, 0, 0];
      s.yaw = Math.atan2(px - hc[0], pz - hc[1]); s.pitch = 0.05;
      await new Promise((r) => setTimeout(r, 900));
      return { hc, y };
    }, { id, yawOff });
    if (!r) { console.log('no hut', id); break; }
    await p.screenshot({ path: `${out}_${id}_${k}.png` });
  }
}
await b.close();

// Close-up burst of a moving bot (third person): node scripts/watchbot.mjs <outPrefix> [frames] [dist] [query]
import { launch } from './browser.mjs';
const [out, frames = '8', dist = '4', q = 'mode=test&q=medium&shot=0,0,0,0,0'] = process.argv.slice(2);
const b = await launch();
const p = await b.newPage({ viewport: { width: 960, height: 540 } });
await p.goto(`http://localhost:5173/?${q}`);
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
await p.waitForTimeout(2500);
for (let i = 0; i < Number(frames); i++) {
  await p.evaluate((D) => {
    const g = window.__game, cam = window.__G.camera;
    const s = g.soldiers.filter((x) => x.alive && Math.hypot(x.vel[0], x.vel[2]) > 1.2).sort((a, b) => a.id - b.id)[0] ?? g.soldiers.find((x) => x.alive);
    window.__watched = window.__watched && window.__watched.alive ? window.__watched : s;
    const t = window.__watched, sx = -Math.sin(t.yaw), sz = -Math.cos(t.yaw);
    // from the side and a little ahead
    cam.position.set(t.pos[0] + sz * D + sx * 1.0, t.pos[1] + 1.3, t.pos[2] - sx * D + sz * 1.0);
    cam.lookAt(t.pos[0], t.pos[1] + 1.0, t.pos[2]);
  }, Number(dist));
  await p.waitForTimeout(60);
  await p.screenshot({ path: `${out}_${String(i).padStart(2, '0')}.png` });
  await p.waitForTimeout(170);
}
await b.close();

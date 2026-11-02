// Screenshots of furnished rooms in the test area: node scripts/roomshot.mjs out_prefix [count]
import { launch } from './browser.mjs';
const [out = 'room', count = '6'] = process.argv.slice(2);
const b = await launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
const logs = []; p.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await p.goto('http://localhost:5173/?mode=test&q=medium&bots=0&shot=-110,1.6,140,0,0');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 180000 });
const rooms = await p.evaluate(() => {
  const g = window.__game, a = g.city.area, r = [];
  for (const b of g.city.buildings) for (const rm of b.rooms) {
    const cx = (rm.x0 + rm.x1) / 2, cz = (rm.z0 + rm.z1) / 2;
    if (a && (cx < a.x0 || cx > a.x1 || cz < a.z0 || cz > a.z1)) continue;
    if (rm.x1 - rm.x0 > 3 && rm.z1 - rm.z0 > 3) r.push({ ...rm, id: b.id });
  }
  const kinds = {}; for (const x of r) kinds[x.kind] = (kinds[x.kind] ?? 0) + 1;
  return { kinds, pick: ['living', 'kitchen', 'bedroom', 'store', 'shop', 'hall'].flatMap((k) => r.filter((x) => x.kind === k).slice(0, 2)) };
});
console.log(JSON.stringify(rooms.kinds));
let i = 0;
for (const rm of rooms.pick.slice(0, Number(count))) {
  await p.evaluate((rm) => {
    window.__hold = true; const cam = window.__G.camera;
    cam.position.set(rm.x0 + 0.35, rm.y + 1.65, rm.z0 + 0.35); cam.lookAt((rm.x0 + rm.x1) / 2 + (rm.x1 - rm.x0) * 0.25, rm.y + 0.6, (rm.z0 + rm.z1) / 2 + (rm.z1 - rm.z0) * 0.25);
  }, rm);
  await p.waitForTimeout(1200);
  await p.screenshot({ path: `${out}_${i++}.png` });
  console.log(i - 1, rm.kind, rm.id, rm.floor);
}
console.log(logs.join('\n'));
await b.close();

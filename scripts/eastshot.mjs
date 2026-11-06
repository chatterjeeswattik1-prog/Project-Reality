// Eastern belt check (full map): views from the ridge, the woods, over the FOB, a high overview, and the map sheet.
//   node scripts/eastshot.mjs <outPrefix>
import { launch } from './browser.mjs';
import fs from 'node:fs';
const out = process.argv[2] || 'east';
const b = await launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
p.on('console', (m) => { if (m.type() === 'error') console.log('[error]', m.text().slice(0, 200)); });
await p.goto('http://localhost:5173/?q=high&bots=0&shot=800,40,0,-90,-10');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
const views = {
  overview: [[1150, 260, 120], [450, 0, -40]],
  ridge: [[668, 0, -70], [300, 0, -30]],
  woods: [[760, 0, -150], [700, 6, -60]],
  fob: [[1010, 45, -120], [925, 0, 0]],
  approach: [[560, 0, 40], [900, 4, 20]],
  farms: [[600, 22, -250], [700, 0, -420]],
};
for (const [name, [eye, at]] of Object.entries(views)) {
  await p.evaluate(([eye, at]) => {
    const cam = window.__G.camera, g = window.__game.P;
    const gy = (x, z) => { const h = g.castRay([x, 300, z], [0, -1, 0], 600); return h ? h.point[1] : 0; };
    cam.position.set(eye[0], eye[1] < 5 ? gy(eye[0], eye[2]) + 1.8 : eye[1], eye[2]);
    cam.lookAt(at[0], gy(at[0], at[2]) + at[1], at[2]);
    window.__hold = true;
  }, [eye, at]);
  await p.waitForTimeout(2500);
  await p.screenshot({ path: `${out}_${name}.png` });
}
const url = await p.evaluate(async () => { const m = await import('/src/ui/map.ts'); return m.renderBaseMap(window.__city, 1100).toDataURL('image/png'); });
fs.writeFileSync(`${out}_map.png`, Buffer.from(url.split(',')[1], 'base64'));
console.log('fps', await p.evaluate(() => window.__fps));
await b.close();

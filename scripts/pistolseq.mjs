// Pistol reload as a contact sheet (first person): frames at progress 0, 0.1 … 1 of a normal and an empty reload.
//   node scripts/pistolseq.mjs <out.png> [us|ins]
import { launch } from './browser.mjs';
import sharp from 'sharp';
const out = process.argv[2] || 'pistolseq.png', side = process.argv[3] || 'us';
const b = await launch();
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.goto(`http://localhost:5173/?mode=sandbox&q=low&auto=${side}&kit=${side === 'us' ? 'us_sl' : 'ins_cell'}`);
await p.waitForFunction(() => window.__ready === true && window.__game?.player, null, { timeout: 300000 });
await p.waitForTimeout(1000);
await p.evaluate(() => {
  const g = window.__game, me = g.player.s, h = g.P.castRay([640, 300, 110], [0, -1, 0], 600, 1);
  me.pos = [640, h.point[1] + 0.05, 110]; me.body.setTranslation({ x: 640, y: h.point[1] + 0.95, z: 110 }, true); me.yaw = Math.PI / 2; me.pitch = 0;
  me.select(me.slots.findIndex((s) => s.def.kind === 'pistol'));
});
await p.waitForTimeout(2500);
const tiles = [];
for (const empty of [false, true]) for (let i = 0; i <= 10; i++) {
  await p.evaluate(([pr, e]) => { const s = window.__game.player.s; s.reloadDur = 1000; s.reloadT = 1000 * (1 - pr); s.reloadEmpty = e; }, [i / 10, empty]);
  await p.waitForTimeout(250);
  tiles.push(await p.screenshot());
}
const W = 640, H = 360, cols = 6, rows = Math.ceil(tiles.length / cols);
await sharp({ create: { width: W * cols, height: H * rows, channels: 3, background: '#000' } })
  .composite(tiles.map((t, k) => ({ input: t, left: (k % cols) * W, top: Math.floor(k / cols) * H }))).png().toFile(out);
console.log('wrote', out);
await b.close();

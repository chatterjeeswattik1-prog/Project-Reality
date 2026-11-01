// Ragdolls on the full map: run an Insurgency bot battle and every 10 s report active ragdolls, settled bodies, the
// physics / rig cost and frame rate; then audit every body: pelvis under the ground, floating, or inside a wall.
//   node scripts/ragmap.mjs [seconds=240]
import { launch } from './browser.mjs';
const secs = Number(process.argv[2] ?? 240);
const b = await launch();
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
p.on('pageerror', (e) => console.log('pageerror', e.message));
await p.goto('http://localhost:5173/?q=low&shot=0,40,0,0,-89');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
const audit = () => p.evaluate(() => {
  const g = window.__game, bad = []; if (!g) return { bodies: 0, bad };
  const P = g.P;
  const all = [...g.soldiers.filter((s) => s.state !== 'alive').map((s) => g.rigs.get(s.id)), ...g.corpses].filter(Boolean);
  let n = 0;
  for (const r of all) {
    const c = r.chest(); if (!c || !r.ragged) continue; n++;
    const pv = r.bones.pelvis.getWorldPosition(new window.__THREE.Vector3());
    const down = P.castRay([pv.x, pv.y + 0.4, pv.z], [0, -1, 0], 30, 1);
    const gap = down ? pv.y - down.point[1] : 99;
    const inside = !!P.boxAt(pv.x, pv.y, pv.z) || !!P.boxAt(c[0], c[1], c[2]);
    if (gap > 0.6 || gap < -0.25 || inside) bad.push({ pelvis: [pv.x, pv.y, pv.z].map((v) => +v.toFixed(1)), gap: +gap.toFixed(2), inside, active: r.ragActive });
  }
  return { bodies: n, bad };
});
let maxPhys = 0, maxActive = 0;
for (let t = 0; t < secs; t += 10) {
  await p.waitForTimeout(10000);
  const r = await p.evaluate(() => {
    const g = window.__game; if (!g) return { none: true };
    const rigs = [...g.rigs.values(), ...g.corpses];
    return { active: rigs.filter((x) => x.ragActive).length, down: g.soldiers.filter((s) => s.state !== 'alive').length, corpses: g.corpses.length, alive: g.soldiers.filter((s) => s.alive).length, phys: +g.prof.phys.toFixed(2), rigs: +g.prof.rigs.toFixed(2), fps: window.__fps };
  });
  if (r.none) { console.log(`t=${t + 10} no game`); continue; }
  if (r.active) { const a = await audit(); if (a.bad.length) console.log('  bad now', JSON.stringify(a.bad.slice(0, 3))); }
  maxPhys = Math.max(maxPhys, r.phys); maxActive = Math.max(maxActive, r.active);
  console.log(`t=${t + 10}`, JSON.stringify(r));
}
const a = await audit();
console.log('max active', maxActive, 'max phys ms', maxPhys);
console.log('bodies', a.bodies, 'bad', a.bad.length); for (const x of a.bad.slice(0, 15)) console.log(JSON.stringify(x));
await b.close();

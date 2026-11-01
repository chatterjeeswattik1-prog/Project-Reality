// Ragdolls against walls and at roof edges (test area). Each case: put a bot in place, shoot it down (or blast it),
// wait for the body to settle, then check it is not inside anything, not through the wall (it must still see where it
// stood) and not floating. Writes a screenshot per case.   node scripts/ragwall.mjs <outPrefix>
import { launch } from './browser.mjs';
const out = process.argv[2] || 'ragwall';
const b = await launch();
const p = await b.newPage({ viewport: { width: 800, height: 450 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.goto('http://localhost:5173/?mode=test&q=medium&shot=0,0,0,0,0');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
const cases = await p.evaluate(() => {
  const g = window.__game, P = g.P, city = window.__city, A = city.area;
  for (const bt of window.__skirm.bots.values()) { bt.update = () => {}; bt.s.health = 1e6; }
  const res = [];
  let s0 = 11; const rnd = () => ((s0 = (s0 * 1664525 + 1013904223) >>> 0) / 4294967296);
  // walls: ground-level points 0.35 m in front of a wall; the bot faces away from it (shot from the front: falls back)
  for (let i = 0; i < 4000 && res.length < 3; i++) {
    const x = A.x0 + rnd() * (A.x1 - A.x0), z = A.z0 + rnd() * (A.z1 - A.z0);
    const h = P.castRay([x, 60, z], [0, -1, 0], 120); if (!h || h.point[1] > 1) continue;
    const a = rnd() * Math.PI * 2, d = [Math.cos(a), 0, Math.sin(a)];
    const w = P.castRay([x, h.point[1] + 1.2, z], d, 5); if (!w || Math.abs(w.normal[1]) > 0.2) continue;
    const px = w.point[0] + w.normal[0] * 0.4, pz = w.point[2] + w.normal[2] * 0.4;
    if (!P.castRay([px, h.point[1] + 1.2, pz], [w.normal[0], 0, w.normal[2]], 4) === false) continue; // need room in front
    res.push({ kind: 'wall', x: px, y: h.point[1], z: pz, n: [w.normal[0], w.normal[2]], imp: 18 });
  }
  // roof edges: on a roof, 0.4 m from its edge wall/parapet, falling outwards (shot from inside; one blasted outwards)
  for (const B of city.buildings) {
    if (res.filter((r) => r.kind.startsWith('roof')).length >= 4) break;
    const sp = B.spec, cx = (sp.x0 + sp.x1) / 2;
    const top = P.castRay([cx, B.roofY + 3, sp.z1 - 1.5], [0, -1, 0], 6); if (!top || top.point[1] < 2) continue;
    const w = P.castRay([cx, top.point[1] + 0.3, sp.z1 - 1.5], [0, 0, 1], 3);
    const ez = w ? w.point[2] - 0.4 : sp.z1 - 0.4;
    const parapet = w ? (P.castRay([cx, top.point[1] + 0.9, sp.z1 - 1.5], [0, 0, 1], 3) ? 'high' : 'low') : 'none';
    res.push({ kind: 'roof-' + parapet, x: cx, y: top.point[1], z: ez, n: [0, -1], imp: 18 });
    res.push({ kind: 'roofblast-' + parapet, x: cx, y: top.point[1], z: ez, n: [0, -1], blast: true });
  }
  return res;
});
console.log(cases.length, 'cases');
let i = 0;
for (const c of cases) {
  const r = await p.evaluate(async ({ c, bi }) => {
    const g = window.__game, P = g.P, T = window.__THREE;
    const bots = [...window.__skirm.bots.values()], s = bots[bi].s, sh = bots[3].s;
    const rig = g.rigs.get(s.id);
    s.body.setTranslation({ x: c.x, y: c.y + 0.95, z: c.z }, true); s.pos = [c.x, c.y + 0.05, c.z]; s.vel = [0, 0, 0];
    s.yaw = Math.atan2(c.n[0], c.n[1]); // forward = (-sin, -cos) = -n -> facing the wall; we want back to wall:
    s.yaw = Math.atan2(-c.n[0], -c.n[1]); // forward = n (away from the wall)
    window.__hold = true; const cam = window.__G.camera;
    cam.position.set(c.x + c.n[0] * 3.5 + 2.5, c.y + 3.2, c.z + c.n[1] * 3.5); cam.lookAt(c.x, c.y + 0.3, c.z);
    await new Promise((r) => setTimeout(r, 700));
    const A = window.__AMMO;
    if (c.blast) { s.health = 1; s.damage(500, 'chest', [c.x + c.n[0] * 1.5, c.y + 0.5, c.z + c.n[1] * 1.5], sh, g.time, true); rig.blast(s, [c.x + c.n[0] * 1.5, c.y + 0.3, c.z + c.n[1] * 1.5], 4.5); }
    else { s.health = 20; g.hitSoldier(s, [c.x, c.y + 1.3, c.z], 'chest', { ...A['762x39'] }, sh); const k = c.imp, d = [-c.n[0], 0, -c.n[1]]; rig.shove(s, [c.x, c.y + 1.3, c.z], [d[0] * k, 0, d[2] * k]); }
    await new Promise((r) => setTimeout(r, 4500));
    const pv = rig.bones.pelvis.getWorldPosition(new T.Vector3()), hd = rig.bones.Head.getWorldPosition(new T.Vector3()), ch = rig.chest();
    const down = P.castRay([pv.x, pv.y + 0.3, pv.z], [0, -1, 0], 40, 1);
    const inside = ['pelvis', 'spine_02', 'Head', 'calf_l', 'calf_r'].filter((n) => { const v = rig.bones[n].getWorldPosition(new T.Vector3()); return P.boxAt(v.x, v.y, v.z); });
    const through = !P.clear([c.x, c.y + 0.6, c.z], [pv.x, pv.y + 0.1, pv.z]);
    // the body, out of the way of the next case
    return { kind: c.kind, state: s.state, pelvis: [pv.x, pv.y, pv.z].map((v) => +v.toFixed(2)), start: [c.x, c.y, c.z].map((v) => +v.toFixed(2)), gap: down ? +(pv.y - down.point[1]).toFixed(2) : 'none', inside, through, active: rig.ragActive };
  }, { c, bi: [0, 4, 1, 5, 2, 6, 7][i % 7] });
  console.log(JSON.stringify(r));
  await p.screenshot({ path: `${out}_${i++}_${c.kind}.png` });
}
await b.close();

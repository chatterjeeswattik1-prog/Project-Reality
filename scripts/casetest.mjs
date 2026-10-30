// Fire a long burst standing beside a wall (ejection side towards it) and check where every case comes to rest:
// on a real surface (ray down hits within 2 cm) and not inside or behind the wall. node scripts/casetest.mjs
import { launch } from './browser.mjs';
const b = await launch();
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
await p.goto('http://localhost:5173/?mode=test&auto=us');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
const r = await p.evaluate(async () => {
  const g = window.__game, P = g.P, I = window.__input, city = window.__city; let s = g.player.s;
  // Bots frozen in place (killing them would end the round and respawn the player).
  for (const bt of window.__skirm.bots.values()) { bt.update = () => {}; bt.s.health = 1e6; }
  const out = [];
  for (const bi of [0, 2, 5]) {
    const B = city.buildings[bi], sp = B.spec;
    // stand on the roof 0.6 m from the hut's door-side wall, facing along it so the ejection port (right) points at it
    const ry = B.roofY, L = P.boxesNear((sp.x0 + sp.x1) / 2, (sp.z0 + sp.z1) / 2, 30).filter((x) => x.tag === B.id && Math.abs(x.c[1] - (ry + 2.3)) < 0.12 && x.h[1] < 0.25);
    if (!L.length) continue;
    const d = L[0], thinX = d.h[0] < d.h[2], cx = (sp.x0 + sp.x1) / 2, cz = (sp.z0 + sp.z1) / 2;
    const nx = thinX ? Math.sign(cx - d.c[0]) : 0, nz = thinX ? 0 : Math.sign(cz - d.c[2]);
    s = g.player.s;
    const px = d.c[0] + nx * 0.75 + (thinX ? 0 : 1.6), pz = d.c[2] + nz * 0.75 + (thinX ? 1.6 : 0);
    const h = P.castRay([px, ry + 3, pz], [0, -1, 0], 6), y = h ? h.point[1] : ry;
    s.pos = [px, y + 0.05, pz]; s.body.setTranslation({ x: px, y: y + 0.95, z: pz }, true); s.vel = [0, 0, 0];
    // face so that the right side points at the wall: right = (cos yaw, -sin yaw) ; want right = (-nx, -nz)
    s.yaw = Math.atan2(nz, -nx); s.pitch = 0.1;
    s.slot.loaded = s.weapon.mag; s.slot.mode = 'auto';
    await new Promise((r) => setTimeout(r, 500));
    I.mouse.left = true; I.mouse.leftPressed = true;
    await new Promise((r) => setTimeout(r, 2400));
    I.mouse.left = false; s.slot.loaded = s.weapon.mag;
    await new Promise((r) => setTimeout(r, 300));
    I.mouse.left = true; I.mouse.leftPressed = true;
    await new Promise((r) => setTimeout(r, 2400));
    I.mouse.left = false;
    await new Promise((r) => setTimeout(r, 2500));
    out.push({ bi, wall: [d.c[0], d.c[2]], n: [nx, nz], from: [px, y + 1.2, pz] });
  }
  const fx = g.fx, bad = [], ok = [];
  for (const c of fx.cs) {
    if (!c) continue;
    const pt = [c.p.x, c.p.y, c.p.z];
    const down = P.castRay([pt[0], pt[1] + 0.03, pt[2]], [0, -1, 0], 0.5);
    const gap = down ? down.dist - 0.03 : 9;
    const inside = !!P.boxAt(pt[0], pt[1] + 0.03, pt[2]);
    // behind a wall: no clear line from the shooter's position to the case
    const seenFrom = out.some((o) => P.clear([o.from[0], o.from[1], o.from[2]], [pt[0], pt[1] + 0.05, pt[2]]));
    (gap > 0.03 || inside || !c.rest || !seenFrom ? bad : ok).push({ p: pt.map((v) => +v.toFixed(2)), gap: +gap.toFixed(3), inside, rest: c.rest, seenFrom });
  }
  return { spots: out, cases: ok.length + bad.length, bad: bad.length, sample: bad.slice(0, 10) };
});
console.log(JSON.stringify(r, null, 1));
await b.close();

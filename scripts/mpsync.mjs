// Multiplayer sync check: doors (a joiner's use, the host's), weapon pick-ups (a body's weapon, picked up by a joiner,
// gone for everyone, his old one left in its place), a guided missile's flight on the joiners, and a late joiner who
// must rebuild the same wall damage, doors and weapons on the ground.
//   node scripts/mpsync.mjs <outPrefix>
import { launch } from './browser.mjs';
const b = await launch();
const errs = [];
const page = async (url, tag) => {
  const p = await b.newPage({ viewport: { width: 800, height: 450 } });
  p.on('pageerror', (e) => { errs.push(`${tag}: ${e.message}`); console.log(`[${tag} pageerror]`, e.message); });
  p.on('dialog', (d) => { console.log(`[${tag} dialog]`, d.message()); void d.dismiss(); });
  await p.goto(url);
  return p;
};
const ready = (p) => p.waitForFunction(() => window.__ready === true && window.__game?.player && (window.__net?.role === 'host' || window.__net?.client()?.connected), null, { timeout: 400000 });
const H = await page('http://localhost:5173/?mp=host&auto=us&kit=us_rifle&name=Hosty&q=low', 'host'); await ready(H);
const J1 = await page('http://localhost:5173/?mp=join&auto=us&kit=us_rifle&name=J1&q=low', 'j1');
const J2 = await page('http://localhost:5173/?mp=join&auto=ins&kit=ins_rifle&name=J2&q=low', 'j2');
await ready(J1); await ready(J2);
await J1.evaluate(() => { const c = window.__net.client(); const oe = c.onEvent.bind(c); window.__drops = []; c.onEvent = (e) => { if (e.t === 'drop' || e.t === 'take') { const r = e.s ? c.remotes.get(e.s) : null; window.__drops.push(`${e.t}#${e.id} s=${e.s ?? '-'} remote=${r ? (r.s.state + (window.__game.rigs.get(r.s.id)?.weapon ? '+w' : '-w')) : 'none'}`); } return oe(e); }; });
await H.waitForTimeout(3000);
console.log('connected: host + 2 joiners');

// ---- 1. Doors ----
// A door near the host's spawn; joiner 1 uses it (it swings on his screen at once; the host and joiner 2 follow).
const di = await H.evaluate(() => { const g = window.__game, me = g.player.s; let bi = 0, bd = 1e9; g.doors.list.forEach((d, i) => { if (d.w <= 0) return; const dd = Math.hypot(d.hinge.x - me.pos[0], d.hinge.z - me.pos[2]); if (dd < bd) { bd = dd; bi = i; } }); return bi; });
const doorT = (p) => p.evaluate((i) => window.__game.doors.list[i].target.toFixed(2), di);
const before = [await doorT(H), await doorT(J1), await doorT(J2)];
await J1.evaluate((i) => {
  const g = window.__game, d = g.doors.list[i], OPEN = 1.4;
  // Stand by the leaf's middle, facing it, and use it.
  const yaw = d.base + d.swing * d.angle, dir = [Math.cos(yaw), 0, -Math.sin(yaw)], mid = [d.hinge.x + dir[0] * d.w / 2, d.hinge.y + 1, d.hinge.z + dir[2] * d.w / 2];
  const from = [mid[0] + dir[2] * 0.8, mid[1], mid[2] - dir[0] * 0.8], to = [mid[0] - from[0], 0, mid[2] - from[2]], L = Math.hypot(to[0], to[2]);
  void OPEN; return g.doors.use([from[0], mid[1] + 0.6, from[2]], [to[0] / L, 0, to[2] / L]);
}, di);
await H.waitForTimeout(1500);
console.log(`door ${di}: before ${before.join('/')} → after joiner 1 used it: host ${await doorT(H)}, joiner 1 ${await doorT(J1)}, joiner 2 ${await doorT(J2)}`);
await H.evaluate((i) => { const g = window.__game, d = g.doors.list[i]; g.doors.setState(i, d.target > 0.4 ? 0 : 1.4, false); g.doors.onChange(i, g.doors.list[i].target, false, false); }, di);
await H.waitForTimeout(1500);
console.log(`host swung it back: host ${await doorT(H)}, joiner 1 ${await doorT(J1)}, joiner 2 ${await doorT(J2)}`);

// ---- 2. Pick-ups ----
// A bot near joiner 1 dies (on the host): his weapon lies there for everyone; joiner 1 picks it up.
const bot = await H.evaluate(() => {
  const g = window.__game, j = g.soldiers.find((s) => s.name === 'J1'), t = g.soldiers.find((s) => !s.isPlayer && !s.netProxy && s.alive && s.team === 'us' && !s.vehicle);
  if (!j || !t) return null;
  t.pos = [j.pos[0] + 1.5, j.pos[1], j.pos[2]]; t.body.setTranslation({ x: t.pos[0], y: t.pos[1] + 0.9, z: t.pos[2] }, true);
  t.die(null);
  return { id: t.id, weapon: t.weapon.id };
});
await H.waitForTimeout(2500);
const pk = await J1.evaluate(() => window.__game.pickups.map((k) => `${k.id}:${k.slot.def.id}`).join(' '));
console.log('j1 drop log', await J1.evaluate(() => window.__drops.join(' | ')), '| j1 pickups parents', await J1.evaluate(() => window.__game.pickups.map((k) => `${k.id}:${!!k.obj.parent}`).join(' ')));
console.log('bot down', JSON.stringify(bot), '→ joiner 1 pickups', pk, '| host pickups', await H.evaluate(() => window.__game.pickups.map((k) => `${k.id}:${k.slot.def.id}`).join(' ')));
const got = await J1.evaluate(async () => {
  const g = window.__game, me = g.player.s, V = new window.__THREE.Vector3(); let k = null, bd = 1e9; for (const x of g.pickups) { const q = x.obj.getWorldPosition(V), d = Math.hypot(q.x - me.pos[0], q.z - me.pos[2]); if (d < bd) { bd = d; k = x; } } if (!k) return 'none to pick up';
  const was = me.weapon.id, id = k.id;
  me.slot.loaded = 7; // a part-used magazine: the rifle left behind must keep it
  // Stand by the weapon (bodies roll a little).
  const kp = k.obj.getWorldPosition(new window.__THREE.Vector3()); me.pos = [kp.x + 0.8, me.pos[1], kp.z]; me.body.setTranslation({ x: kp.x + 0.8, y: me.pos[1] + 0.9, z: kp.z }, true);
  await new Promise((r) => setTimeout(r, 400));
  const msgs = []; const c = window.__net.client(); const om = c.onMessage.bind(c); c.onMessage = (m) => { if (m.t === 'got' || m.t === 'gotno') msgs.push(m.t); return om(m); };
  window.__pkmsgs = msgs;
  g.pickUp(me, k);
  await new Promise((r) => setTimeout(r, 1500));
  window.__pkdbg = { msgs, kpos: k.obj.getWorldPosition(new window.__THREE.Vector3()).toArray().map((x) => +x.toFixed(1)), me: me.pos.map((x) => +x.toFixed(1)) };
  return { id, was, now: me.weapon.id, loadedNow: me.slot.loaded, dbg: window.__pkdbg };
});
await H.waitForTimeout(800);
const list = async (p) => p.evaluate(() => window.__game.pickups.map((k) => `${k.id}:${k.slot.def.id}/${k.slot.loaded}`).join(' '));
console.log('joiner 1 picked up', JSON.stringify(got), '→ host', await list(H), '| j1', await list(J1), '| j2', await list(J2));

// ---- 3. Guided missile: a TOW steered sideways on the host; the joiners' copies follow its flight ----
await H.evaluate(() => {
  const g = window.__game, me = g.player.s, e = me.eye, yaw = me.yaw, d = [-Math.sin(yaw) * 0.99, 0.12, -Math.cos(yaw) * 0.99];
  const side = [Math.cos(yaw), 0, -Math.sin(yaw)];
  // The "sight" swings 60 m to the right over the flight: the missile curves after it.
  const t0 = performance.now();
  const b = g.proj.fire(me, null, 'tow2', [e[0] + d[0] * 2, e[1] + 1.5, e[2] + d[2] * 2], d, true, (p) => { const k = Math.min(1, (performance.now() - t0) / 1500); return [e[0] + d[0] * 400 + side[0] * 60 * k, e[1] + 40, e[2] + d[2] * 400 + side[2] * 60 * k]; });
  window.__msl = b;
});
for (let k = 0; k < 4; k++) {
  await H.waitForTimeout(200);
  const [a, c] = await Promise.all([H.evaluate(() => { const b = window.__msl; return window.__game.proj.bullets.includes(b) ? [b.p.map((x) => +x.toFixed(1)), b.v.map((x) => +x.toFixed(0)), window.__game.time.toFixed(2)] : null; }), J1.evaluate(() => { const m = window.__net.client().missiles; const b = [...m.values()].pop(); return b && window.__game.proj.bullets.includes(b) ? [b.p.map((x) => +x.toFixed(1)), b.v.map((x) => +x.toFixed(0)), window.__game.time.toFixed(2), Math.round(window.__net.client().rtt)] : null; })]);
  console.log('  msl sample', JSON.stringify(a), JSON.stringify(c));
}
const hp = await H.evaluate(() => { const b = window.__msl; return window.__game.proj.bullets.includes(b) ? b.p : null; });
const jp = await J1.evaluate(() => { const m = window.__net.client().missiles; const b = [...m.values()].pop(); return b && window.__game.proj.bullets.includes(b) ? b.p : null; });
console.log('missile after 0.7 s: host', JSON.stringify(hp?.map((x) => +x.toFixed(1))), 'joiner 1 copy', JSON.stringify(jp?.map((x) => +x.toFixed(1))), hp && jp ? `gap ${Math.hypot(hp[0] - jp[0], hp[1] - jp[1], hp[2] - jp[2]).toFixed(1)} m` : '');

// ---- 4. Late joiner: wall damage, doors and weapons as the host has them ----
await H.evaluate(() => {
  const g = window.__game, P = g.P, me = g.player.s;
  for (let r = 15; r < 250; r += 15) for (let k = 0; k < 16; k++) {
    const a = k / 16 * Math.PI * 2, o = [me.pos[0], me.pos[1] + 1.2, me.pos[2]], d = [Math.cos(a), 0, Math.sin(a)], h = P.castRay(o, d, r);
    if (h && Math.abs(h.normal[1]) < 0.2 && (h.surf === 'masonry' || h.surf === 'concrete')) { g.explode([h.point[0] + h.normal[0] * 0.15, h.point[1], h.point[2] + h.normal[2] * 0.15], window.__AMMO.c4, me, h.normal); return; }
  }
});
await H.waitForTimeout(2500);
const J3 = await page('http://localhost:5173/?mp=join&auto=us&kit=us_rifle&name=Late&q=low', 'j3'); await ready(J3);
await J3.waitForTimeout(3000);
const state = (p) => p.evaluate(() => { const g = window.__game; return { removed: g.destruct.removed, doors: g.doors.list.map((d) => (d.w <= 0 ? -1 : Math.round(d.target * 100))).join(','), pickups: g.pickups.map((k) => k.id).sort((a, b) => a - b).join(',') }; });
const sh = await state(H), s3 = await state(J3);
{ const a = sh.doors.split(','), c = s3.doors.split(','); const diff = []; a.forEach((x, i) => { if (x !== c[i]) diff.push(`${i}:${x}/${c[i]}`); }); console.log('door diffs', diff.length, diff.slice(0, 8).join(' ')); }
console.log(`late joiner: wall pieces removed host ${sh.removed} / late ${s3.removed}; doors match ${sh.doors === s3.doors}; pickups host [${sh.pickups}] late [${s3.pickups}]`);
console.log('errors', errs.length, errs.slice(0, 4).join(' | '));
await b.close();

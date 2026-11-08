// Multiplayer check (dev server): one browser tab hosts the match, N others join (WebRTC between tabs, the lobby and
// handshake through the dev server's /api). Checks: joiners connect and see the host's soldiers; the host's stand-in
// for a joiner follows him; a joiner's shot wounds the host player (the host decides the hit); a C4 breach on the host
// cuts the same wall on the joiners (same seed); the host's upload rate and frame rate with N joiners.
//   node scripts/mptest.mjs [joiners=2] [outPrefix]
import { launch } from './browser.mjs';
const N = Number(process.argv[2] ?? 2), out = process.argv[3] || 'mp';
const b = await launch();
const errs = [];
const page = async (url, tag) => {
  const p = await b.newPage({ viewport: { width: 960, height: 540 } });
  p.on('pageerror', (e) => { errs.push(`${tag}: ${e.message}`); console.log(`[${tag} pageerror]`, e.message); });
  p.on('dialog', (d) => { console.log(`[${tag} dialog]`, d.message()); void d.dismiss(); });
  await p.goto(url);
  return p;
};
const t0 = Date.now(), el = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;
const H = await page('http://localhost:5173/?mp=host&auto=us&kit=us_rifle&name=Hosty&q=low', 'host');
await H.waitForFunction(() => window.__ready === true && window.__game?.player, null, { timeout: 300000 });
console.log(el(), 'host ready', await H.evaluate(() => `${window.__game.soldiers.length} soldiers`));
const C = [];
for (let i = 0; i < N; i++) C.push(await page(`http://localhost:5173/?mp=join&auto=${i % 2 || i === 0 ? 'us' : 'ins'}&kit=${i % 2 ? 'us_crew' : i === 0 ? 'us_rifle' : 'ins_rifle'}&name=Joiner${i + 1}&q=low`, `c${i + 1}`));
for (const [i, p] of C.entries()) {
  await p.waitForFunction(() => window.__ready === true && window.__game?.player && window.__net?.client()?.connected, null, { timeout: 400000 });
  console.log(el(), `joiner ${i + 1} connected`);
}
await H.waitForTimeout(4000);
console.log('host sees', await H.evaluate(() => { const g = window.__game, h = window.__net.host(); return `${h.players} players, peers ${JSON.stringify(h.peerList())}, proxies ${g.soldiers.filter((s) => s.netProxy).map((s) => s.name).join(',')}`; }));
for (const [i, p] of C.entries()) console.log(`joiner ${i + 1} sees`, await p.evaluate(() => { const g = window.__game, c = window.__net.client(); const rs = c.remoteList(); return `${rs.length} remote soldiers (${rs.filter((s) => !s.netHidden && s.pos[1] > -100).length} placed), host player visible: ${rs.some((s) => s.name === 'Hosty' && s.pos[1] > -100)}, ping ${Math.round(c.rtt)} ms, myNid ${c.myNid}`; }));

// 1. Joiner 1 walks 6 m east: the host's stand-in follows.
const j1 = C[0];
const before = await j1.evaluate(() => { const me = window.__game.player.s; return me.pos.slice(); });
await j1.evaluate(() => { const me = window.__game.player.s; me.pos = [me.pos[0] + 6, me.pos[1], me.pos[2]]; me.body.setTranslation({ x: me.pos[0], y: me.pos[1] + 0.9, z: me.pos[2] }, true); });
await H.waitForTimeout(800);
console.log('stand-in follows', await H.evaluate((b0) => { const s = window.__game.soldiers.find((x) => x.name === 'Joiner1'); return s ? `moved ${(s.pos[0] - b0[0]).toFixed(2)} m east` : 'no stand-in'; }, before));

// 2. Bring joiner 1 next to the host player and shoot him in the chest from 15 m.
await H.evaluate(() => { const me = window.__game.player.s; me.god = false; me.health = 100; });
const hp = await H.evaluate(() => window.__game.player.s.pos.slice());
// (A spot 15 m away with a clear line to the host player: the FOB has HESCO walls everywhere.)
const spot = await H.evaluate((hp) => {
  const P = window.__game.P;
  for (let k = 0; k < 24; k++) {
    const a = k / 24 * Math.PI * 2, x = hp[0] + Math.cos(a) * 15, z = hp[2] + Math.sin(a) * 15, g = P.castRay([x, hp[1] + 20, z], [0, -1, 0], 40, 1);
    if (!g || Math.abs(g.point[1] - hp[1]) > 1) continue;
    if (P.clear([x, g.point[1] + 1.6, z], [hp[0], hp[1] + 1.3, hp[2]])) return [x, g.point[1], z];
  }
  return null;
}, hp);
console.log('clear spot', JSON.stringify(spot));
await j1.evaluate((sp) => { const me = window.__game.player.s; me.pos = [sp[0], sp[1], sp[2]]; me.body.setTranslation({ x: sp[0], y: sp[1] + 0.9, z: sp[2] }, true); }, spot);
await j1.waitForTimeout(1500);
await H.evaluate(() => { const g = window.__game, H = g.proj.H; window.__hlog = []; const oi = H.impact, oh = H.hit, oa = H.armour; H.impact = (p, n, surf, a, d) => { window.__hlog.push(`impact ${surf} at ${p.map((x) => x.toFixed(1))}`); return oi(p, n, surf, a, d); }; H.hit = (s, ...r) => { window.__hlog.push(`HIT ${s.name}`); return oh(s, ...r); }; H.armour = (wh, ...r) => { const v = oa(wh, ...r); if (v) window.__hlog.push('armour'); return v; }; const f = g.proj.fire; g.proj.fire = (o, ...r) => { if (o.netProxy) window.__hlog.push(`proxy fire from ${r[2].map((x) => x.toFixed(1))} owner pos ${o.pos.map((x) => x.toFixed(1))} me ${g.player.s.pos.map((x) => x.toFixed(1))}`); return f(o, ...r); }; });
const shot = await j1.evaluate(() => {
  const g = window.__game, me = g.player.s, c = window.__net.client(), h = c.remoteList().find((s) => s.name === 'Hosty');
  if (!h) return 'host player not seen';
  const tgt = [h.pos[0], h.pos[1] + 1.25, h.pos[2]], e = me.eye, d = [tgt[0] - e[0], tgt[1] - e[1], tgt[2] - e[2]], L = Math.hypot(...d);
  g.proj.fire(me, me.weapon, me.weapon.ammo, e, d.map((x) => x / L), true);
  return `fired at ${L.toFixed(1)} m`;
});
await H.waitForTimeout(1200);
console.log('host trace', await H.evaluate(() => window.__hlog.slice(0, 6).join(' | ')), '| joiner 1 stand-in', await H.evaluate(() => { const s = window.__game.soldiers.find((x) => x.name === 'Joiner1'); return s ? `${s.team} ${s.state}` : 'none'; }));
console.log('shot', shot, '→ host player', await H.evaluate(() => { const me = window.__game.player.s; return `${me.state} health ${Math.round(me.health)}`; }), '| log:', await H.evaluate(() => window.__game.mode.log.slice(-2).map((l) => l.text).join(' / ')));

// 4. Vehicles: joiner 2 (crewman) takes the gunner's seat of the host's M1A2, traverses the turret and fires.
if (C[1]) {
  const j2 = C[1];
  const seat = await j2.evaluate(() => {
    const g = window.__game, me = g.player.s, v = g.vehicles.find((x) => x.def.id === 'm1a2'); if (!v) return 'no M1A2'; if (me.state === 'dead') return `joiner 2 is ${me.state}`;
    const q = v.pos(); me.pos = [q[0] + 4, q[1] - 1, q[2]]; me.body.setTranslation({ x: q[0] + 4, y: q[1], z: q[2] }, true);
    const gi = v.seats.findIndex((x) => x.def.role === 'gunner'); g.player.vc.trySeat(me, v, gi);
    window.__v = v; window.__vi = g.vehicles.indexOf(v);
    return `vehicle ${window.__vi}, local seat ${v.seatOf(me)}`;
  });
  await H.waitForTimeout(1500);
  console.log('seat', seat, '→ host:', await H.evaluate((i) => { const v = window.__game.vehicles[i]; return v.seats.map((x) => `${x.def.role}:${x.who?.name ?? '-'}`).join(' '); }, await j2.evaluate(() => window.__vi)));
  const ty0 = await H.evaluate((i) => window.__game.vehicles[i].turretYaw, await j2.evaluate(() => window.__vi));
  await j2.evaluate(() => { const v = window.__v; v.aimYaw = v.yaw() + v.turretYaw + 1.0; v.aimPitch = 0.02; });
  await H.waitForTimeout(15000);
  const ty1 = await H.evaluate((i) => window.__game.vehicles[i].turretYaw, await j2.evaluate(() => window.__vi));
  console.log(`turret traversed on the host by ${(ty1 - ty0).toFixed(2)} rad; joiner sees ${await j2.evaluate(() => window.__v.turretYaw.toFixed(2))}`);
  const fired = await j2.evaluate(async () => {
    const g = window.__game, v = window.__v, me = g.player.s; let n = 0;
    const f = g.proj.fire; g.proj.fire = (o, d, a, ...r) => { if (String(a).startsWith('120')) n++; return f(o, d, a, ...r); };
    v.fire(v.mounts[0], v.seatOf(me));
    await new Promise((r) => setTimeout(r, 1500));
    return `${n} main-gun shot(s) shown on the joiner; panel: ${v.mounts[0].ready.join('/')} ready, blocked=${v.netBlocked.main}`;
  });
  console.log('fire:', fired);
}

// 3. C4 on a house wall near the host: the same cut on the joiners.
const wall = await H.evaluate(() => {
  const g = window.__game, P = g.P, me = g.player.s;
  for (let r = 10; r < 200; r += 10) for (let k = 0; k < 12; k++) {
    const a = k / 12 * Math.PI * 2, o = [me.pos[0], me.pos[1] + 1.2, me.pos[2]], d = [Math.cos(a), 0, Math.sin(a)], h = P.castRay(o, d, r);
    if (h && h.surf !== 'dirt' && Math.abs(h.normal[1]) < 0.2 && (h.surf === 'masonry' || h.surf === 'concrete')) return { p: [h.point[0] + h.normal[0] * 0.15, h.point[1], h.point[2] + h.normal[2] * 0.15], n: h.normal };
  }
  return null;
});
if (wall) {
  const r0h = await H.evaluate(() => window.__game.destruct.removed), r0c = await Promise.all(C.map((p) => p.evaluate(() => window.__game.destruct.removed)));
  await H.evaluate((w) => window.__game.explode(w.p, window.__AMMO.c4, window.__game.player.s, w.n), wall);
  await H.waitForTimeout(2000);
  const r1h = await H.evaluate(() => window.__game.destruct.removed), r1c = await Promise.all(C.map((p) => p.evaluate(() => window.__game.destruct.removed)));
  console.log('C4 breach: host removed', r1h - r0h, 'pieces; joiners removed', r1c.map((x, i) => x - r0c[i]).join(', '));
} else console.log('no wall found near the host');

// 5. Load: host upload and frame rate.
await H.waitForTimeout(3000);
console.log('host load', await H.evaluate(() => `upload ${(window.__net.host().rate / 1024).toFixed(1)} KB/s for ${window.__net.host().players - 1} joiners · ${window.__fps}`));
await H.screenshot({ path: `${out}_host.png` });
await C[0].screenshot({ path: `${out}_joiner1.png` });
console.log('errors', errs.length, errs.slice(0, 5).join(' | '));
await b.close();

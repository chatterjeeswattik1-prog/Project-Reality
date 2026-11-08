// Dedicated-server check: with scripts/dedicated.mjs running against the dev site (GAME_URL=http://localhost:5173),
// two players join the server's match, see its soldiers, one shoots a bot (the server decides the hit), and the
// server's status page reports them.   node scripts/dedtest.mjs
import { launch } from './browser.mjs';
const b = await launch();
const st = async () => { try { return await (await fetch('http://127.0.0.1:8790/')).json(); } catch { return null; } };
for (let i = 0; i < 120; i++) { const s = await st(); if (s?.state === 'running') break; await new Promise((r) => setTimeout(r, 5000)); }
console.log('server', JSON.stringify(await st()));
const join = async (side, name) => {
  const p = await b.newPage({ viewport: { width: 800, height: 450 } });
  p.on('pageerror', (e) => console.log(`[${name}]`, e.message));
  p.on('dialog', (d) => { console.log(`[${name} dialog]`, d.message()); void d.dismiss(); });
  await p.goto(`http://localhost:5173/?mp=join&auto=${side}&kit=${side}_rifle&name=${name}&q=low`);
  await p.waitForFunction(() => window.__ready === true && window.__game?.player && window.__net?.client()?.connected, null, { timeout: 400000 });
  return p;
};
const A = await join('us', 'Alice'), B = await join('ins', 'Bob');
await A.waitForTimeout(4000);
for (const [n, p] of [['Alice', A], ['Bob', B]]) console.log(n, 'sees', await p.evaluate(() => { const c = window.__net.client(), rs = c.remoteList(); return `${rs.length} soldiers (${rs.filter((s) => s.pos[1] > -100).length} placed), ping ${Math.round(c.rtt)} ms, host "${rs.length ? 'ok' : '-'}"`; }));
// Alice shoots the nearest US bot in the chest from where she stands (friendly fire is on: the server decides).
const r = await A.evaluate(async () => {
  const g = window.__game, me = g.player.s, c = window.__net.client();
  const t = c.remoteList().filter((s) => s.state === 'alive' && !s.netHidden && s.pos[1] > -100).sort((a, b) => Math.hypot(a.pos[0] - me.pos[0], a.pos[2] - me.pos[2]) - Math.hypot(b.pos[0] - me.pos[0], b.pos[2] - me.pos[2]))[0];
  if (!t) return 'no target';
  const e = me.eye, tgt = [t.pos[0], t.pos[1] + 1.25, t.pos[2]], d = [tgt[0] - e[0], tgt[1] - e[1], tgt[2] - e[2]], L = Math.hypot(...d);
  // Move next to it first (a clear line).
  me.pos = [t.pos[0] + 3, t.pos[1], t.pos[2]]; me.body.setTranslation({ x: me.pos[0], y: me.pos[1] + 0.9, z: me.pos[2] }, true);
  await new Promise((r) => setTimeout(r, 800));
  const e2 = me.eye, d2 = [tgt[0] - e2[0], tgt[1] - e2[1], tgt[2] - e2[2]], L2 = Math.hypot(...d2);
  for (let k = 0; k < 3; k++) { g.proj.fire(me, me.weapon, me.weapon.ammo, e2, d2.map((x) => x / L2), true); await new Promise((r) => setTimeout(r, 150)); }
  await new Promise((r) => setTimeout(r, 2000));
  void L; void d;
  return `${t.name}: ${t.state}`;
});
console.log('Alice fired 3 rounds →', r);
await A.waitForTimeout(12000);
console.log('server', JSON.stringify(await st()));
await b.close();

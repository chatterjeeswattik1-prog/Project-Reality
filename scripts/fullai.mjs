// Watch the full map (Insurgency) with the team brains: node scripts/fullai.mjs [seconds=180] [speed]
// Prints every 10 s: US squads (phase, brain state, where the leader is, distance to the marker), insurgent cells
// (role, brain state), tickets / caches, kills and the radio log; then counts bots that spent time above ground floor.
import { launch } from './browser.mjs';
const secs = Number(process.argv[2] ?? 180);
const b = await launch();
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
p.on('pageerror', (e) => console.log('pageerror', e.message));
await p.goto('http://localhost:5173/?q=low&shot=0,40,0,0,-89');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
await p.evaluate(() => { window.__hi = new Map(); });
for (let t = 0; t < secs; t += 10) {
  await p.waitForTimeout(10000);
  const r = await p.evaluate(() => {
    const g = window.__game, d = window.__skirm ?? window.__director, m = g.mode;
    const D = window.__fullDirector;
    if (!D) return 'no director';
    for (const s of g.soldiers) if (s.alive) { const B = window.__city.buildings.find((b) => s.pos[0] > b.spec.x0 && s.pos[0] < b.spec.x1 && s.pos[2] > b.spec.z0 && s.pos[2] < b.spec.z1); if (B && s.pos[1] > B.spec.y0 + 2) window.__hi.set(s.id, s.team); }
    const sq = D.squads.map((q) => { const L = q.brain?.leader(); const tg = q.target; return `${q.name}:${q.phase}/${q.brain?.state} n=${q.members.filter((x) => x.alive).length} L=${L ? L.pos.map((v) => v.toFixed(0)).join(',') : '-'} toMarker=${tg && L ? Math.hypot(tg.marker[0] - L.pos[0], tg.marker[1] - L.pos[2]).toFixed(0) : '-'} plan=${q.planI}/${q.plan.length}`; }).join(' | ');
    const cl = D.cells.map((c) => `${c.role[0]}${c.id}:${c.brain?.state}/${c.members.filter((x) => x.alive).length}`).join(' ');
    return `t=${g.time.toFixed(0)} tickets=${m.tickets} caches=${m.destroyed} intel=${m.intel} alive us=${g.soldiers.filter((s) => s.team === 'us' && s.alive).length} ins=${g.soldiers.filter((s) => s.team === 'ins' && s.alive).length}\n  ${sq}\n  cells ${cl}\n  log: ${m.log.slice(-3).map((l) => l.text).join(' | ')}`;
  });
  console.log(r);
}
console.log('bots seen above ground floor:', await p.evaluate(() => JSON.stringify([...window.__hi.values()].reduce((a, t) => (a[t] = (a[t] || 0) + 1, a), {}))));
await b.close();

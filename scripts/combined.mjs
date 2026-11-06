// Combined-arms check (full map, all bots, the player a rifleman at the FOB standing still): every 15 s the US squads'
// mechanised phase and brain state, the vehicles (position, speed, integrity, crew), IEDs and ATGM sites, deaths.
//   node scripts/combined.mjs [seconds] [outPrefix]
import { launch } from './browser.mjs';
const secs = Number(process.argv[2] ?? 180), out = process.argv[3] ?? 'combined';
const b = await launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
p.on('pageerror', (e) => { errs.push(e.message); console.log('[pageerror]', e.message, (e.stack ?? '').split(String.fromCharCode(10)).slice(0, 6).join(' | ')); });
await p.goto('http://localhost:5173/?q=low&auto=us&kit=us_rifle');
await p.waitForFunction(() => window.__ready === true && window.__game?.player, null, { timeout: 300000 });
await p.evaluate(() => {
  const g = window.__game; window.__log = [];
  const ev = g.events, prev = ev.onDown, pv = ev.onVehicle;
  ev.onDown = (v, by, k) => { window.__log.push(`${k ? 'KIA' : 'WIA'} ${v.team}:${v.name}${v.vehicle ? ` (in ${v.vehicle.def.id})` : ''} by ${by?.name ?? '?'}${by?.vehicle ? ` (${by.vehicle.def.id})` : ''} @${g.time.toFixed(0)}`); prev?.(v, by, k); };
  ev.onVehicle = (v, w) => { window.__log.push(`VEH ${v.def.id} ${w} @${g.time.toFixed(0)}`); pv?.(v, w); };
});
for (let t = 0; t < secs; t += 15) {
  await p.waitForTimeout(15000);
  console.log(await p.evaluate(() => {
    const g = window.__game, d = window.__fullDirector, at = g.insAT;
    const sq = d.squads.map((q) => `${q.name}: ${q.mech}/${q.phase}/${q.brain?.state}${q.brain?.clearing ? ` (clearing #${q.brain.clearing.id})` : ''} alive ${q.members.filter((m) => m.alive).length} mounted ${q.members.filter((m) => m.vehicle).length}`);
    const v = g.vehicles.map((v) => `${v.def.id} [${Math.round(v.pos()[0])},${Math.round(v.pos()[2])}] ${Math.round(v.vf * 3.6)} km/h ${Math.round(v.integrity)}%${v.dead ? ' DEAD' : ''}${v.tracked ? ' TRK' : ''} crew ${v.seats.filter((s) => s.who).length}${v.ai?.target ? ' TGT' : ''}${v.ai?.goal ? ' →' + v.ai.goal.map((x) => Math.round(x)).filter((_, i) => i !== 1).join(',') : ''}`);
    return `t=${g.time.toFixed(0)} fps ${window.__fps}\n  ${sq.join('\n  ')}\n  ${v.join('\n  ')}\n  IED spent ${at.ieds.filter((x) => x.spent).length}/${at.ieds.length}, ATGM ${at.sites.map((s) => `${s.missiles}${s.gunner?.alive ? '' : 'x'} d${s.gunner ? Math.hypot(s.gunner.pos[0] - s.p[0], s.gunner.pos[2] - s.p[2]).toFixed(1) : '-'} t${s.target ? s.target.def.id : '-'} k${s.trackT.toFixed(1)}`).join(' | ')}, cleared ${g.cleared.us.size}\n  ${window.__log.splice(0).join('\n  ')}`;
  }));
}
await p.screenshot({ path: `${out}_end.png` });
console.log('errors', errs.length);
await b.close();

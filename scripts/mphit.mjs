// Multiplayer hit check (deterministic): a host tab (a player host, mp=host: the lobby must be free) freezes a few bots
// where they stand; a joiner walks up to each (3-4 m, clear line), fires 4 rounds at its chest and then reads what the
// host decided, both on the host (by soldier id) and as the joiner sees it (snapshots).
//   node scripts/mphit.mjs [targets=3]
import { launch } from './browser.mjs';

const N = Number(process.argv[2] ?? 3), URL0 = `http://localhost:${process.env.PORT ?? 5173}`;
const b = await launch();
const H = await b.newPage({ viewport: { width: 640, height: 360 } });
H.on('pageerror', (e) => console.log('[host pageerror]', e.message));
H.on('dialog', (d) => { console.log('[host dialog]', d.message()); void d.dismiss(); });
await H.goto(`${URL0}/?mp=host&auto=us&kit=us_rifle&name=HostTab&q=low`);
await H.waitForFunction(() => window.__ready === true && window.__fullDirector && window.__net?.host(), null, { timeout: 400000 });
await H.waitForTimeout(3000);
// Freeze N bots that are alive, on the ground and well apart from one another.
const frozen = await H.evaluate((n) => {
  const g = window.__game, D = window.__fullDirector, out = [];
  for (const [id, bot] of D.bots) {
    const s = bot.s;
    if (!s.alive || s.vehicle || s.pos[1] > 2 || out.some((o) => Math.hypot(o.p[0] - s.pos[0], o.p[2] - s.pos[2]) < 40)) continue;
    bot.update = () => { s.vel[0] = s.vel[2] = 0; s.move?.(0.016, [0, 0], false); };
    out.push({ id, name: s.name, team: s.team, p: [...s.pos] });
    if (out.length >= n) break;
  }
  void g;
  return out;
}, N);
console.log('frozen on the host:', frozen.map((f) => `${f.name} #${f.id} (${f.team})`).join(', '));

const J = await b.newPage({ viewport: { width: 640, height: 360 } });
J.on('pageerror', (e) => console.log('[joiner pageerror]', e.message));
J.on('dialog', (d) => { console.log('[joiner dialog]', d.message()); void d.dismiss(); });
await J.goto(`${URL0}/?mp=join&auto=us&kit=us_rifle&name=Shooter&q=low`);
await J.waitForFunction(() => window.__ready === true && window.__game?.player && window.__net?.client()?.connected, null, { timeout: 400000 });
await J.waitForTimeout(4000);

let ok = 0;
for (const f of frozen) {
  const r = await J.evaluate(async (nid) => {
    const g = window.__game, me = g.player.s, c = window.__net.client(), sleep = (ms) => new Promise((k) => setTimeout(k, ms));
    const t = c.remotes.get(nid)?.s;
    if (!t) return { err: 'not in the joiner\'s view' };
    for (const [ox, oz] of [[3.5, 0], [-3.5, 0], [0, 3.5], [0, -3.5], [2.5, 2.5], [-2.5, -2.5], [2.5, -2.5], [-2.5, 2.5]]) {
      const pos = [t.pos[0] + ox, t.pos[1], t.pos[2] + oz];
      me.pos = [...pos]; me.vel = [0, 0, 0]; me.body.setTranslation({ x: pos[0], y: pos[1] + 0.9, z: pos[2] }, true); me.teleported = true;
      await sleep(100);
      // Clear line to the point we will shoot at (a crouched bot is often behind a low wall from some sides).
      const aimH = t.stance === 'prone' ? 0.22 : t.stance === 'crouch' ? 0.78 : 1.2;
      if (Math.hypot(me.pos[0] - pos[0], me.pos[2] - pos[2]) > 0.5 || !g.P.clear(me.eye, [t.pos[0], t.pos[1] + aimH, t.pos[2]])) continue;
      await sleep(1500); // the host gets the new position
      for (let k = 0; k < 4; k++) {
        // Chest height for the stance it is in (bots holding a post crouch).
        const ch = t.stance === 'prone' ? 0.22 : t.stance === 'crouch' ? 0.78 : 1.2;
        const e = me.eye, tg = [t.pos[0], t.pos[1] + ch, t.pos[2]], d = [tg[0] - e[0], tg[1] - e[1], tg[2] - e[2]], L = Math.hypot(...d);
        g.proj.fire(me, me.weapon, me.weapon.ammo, e, d.map((x) => x / L), true);
        await sleep(250);
      }
      await sleep(2500);
      return { range: Math.hypot(ox, oz).toFixed(1), seen: t.state, stance: t.stance };
    }
    return { err: 'no clear line from any side' };
  }, f.id);
  const host = await H.evaluate((id) => { const s = window.__game.soldiers.find((x) => x.id === id); return s ? `${s.state} (${Math.round(s.health)} hp)` : 'gone'; }, f.id);
  if (r.err) { console.log(`${f.name} #${f.id}: ${r.err}; host: ${host}`); continue; }
  const down = !host.startsWith('alive');
  if (down && r.seen !== 'alive') ok++;
  console.log(`${f.name} #${f.id} (${r.stance}) at ${r.range} m → host: ${host}; joiner sees: ${r.seen}`);
}
console.log(`${ok}/${frozen.length} targets downed and seen as down by the joiner`);
await b.close();

// Long-run stability: the full map (Insurgency, bots, the player auto-redeploying after each death) for N minutes.
// Every 30 s: JS heap, GPU objects (geometries / textures / programs), physics bodies / colliders / joints, soldiers,
// corpses, frame rate; page errors and a lost WebGL context are printed when they happen.
//   node scripts/soak.mjs [minutes=25] [query]
import { launch } from './browser.mjs';
const mins = Number(process.argv[2] ?? 25), q = process.argv[3] ?? 'auto=us&q=medium';
const b = await launch(['--js-flags=--expose-gc']);
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', (e) => console.log(`[pageerror ${new Date().toISOString().slice(11, 19)}]`, e.message, (e.stack ?? '').split(String.fromCharCode(10)).slice(1, 6).join(' | ')));
p.on('crash', () => console.log('[PAGE CRASHED]'));
p.on('console', (m) => { const t = m.text(); if (/context lost|out of memory|WebGL/i.test(t)) console.log('[console]', t); });
await p.goto(`http://localhost:${process.env.PORT ?? 5173}/?${q}`);
await p.waitForFunction(() => window.__ready === true, null, { timeout: 400000 });
await p.evaluate(() => {
  const cv = window.__G.renderer.domElement; cv.addEventListener('webglcontextlost', () => console.log('WebGL context lost'));
  // Keep the player deploying (as a player would) whenever the spawn screen is up.
  // Play: burst-fire now and then, get hit, and every ~2 minutes get killed (respawn path), switch weapons.
  let n = 0;
  setInterval(() => {
    const g = window.__game, s = g.player?.s, I = window.__input; if (!s) return; n++;
    if (s.alive) {
      I.locked = true; s.yaw += (Math.random() - 0.5) * 1.5;
      if (n % 3 === 0) { I.mouse.left = true; I.mouse.leftPressed = true; setTimeout(() => { I.mouse.left = false; }, 700); }
      if (n % 7 === 0) { s.slot.loaded = s.weapon.mag; }
      if (n % 11 === 0) g.hitSoldier(s, [s.pos[0], s.pos[1] + 1.2, s.pos[2]], 'arm', { ...window.__AMMO['762x39'], dmg: 10 }, g.soldiers.find((o) => o.team !== s.team) ?? s);
      if (n % 40 === 0) { s.health = 5; g.hitSoldier(s, [s.pos[0], s.pos[1] + 1.3, s.pos[2]], 'head', { ...window.__AMMO['762x39'] }, g.soldiers.find((o) => o.team !== s.team) ?? s); }
    }
  }, 3000);
  setInterval(() => { const sp = document.querySelector('.spawn'); const btn = document.querySelector('.spawn .deploy'); if (sp && sp.style.display !== 'none' && btn && !btn.disabled) btn.click(); }, 1000);
});
const t0 = Date.now();
while (Date.now() - t0 < mins * 60000) {
  await p.waitForTimeout(30000);
  try {
    const r = await p.evaluate(() => {
      const g = window.__game, R = window.__G.renderer, w = g.P.world, m = performance.memory;
      return { min: 0, heap: m ? Math.round(m.usedJSHeapSize / 1e6) : -1, geo: R.info.memory.geometries, tex: R.info.memory.textures, prog: R.info.programs?.length ?? -1, bodies: w.bodies.len(), cols: w.colliders.len(), joints: w.impulseJoints.len(), soldiers: g.soldiers.length, corpses: g.corpses.length, scene: window.__G.scene.children.length, fps: window.__fps, me: g.player?.s.state, deaths: g.player?.s.deaths ?? 0 };
    });
    r.min = +((Date.now() - t0) / 60000).toFixed(1);
    console.log(JSON.stringify(r));
  } catch (e) { console.log('[evaluate failed]', e.message); break; }
}
await b.close();

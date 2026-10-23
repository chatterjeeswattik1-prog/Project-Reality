// Scripted play: node scripts/drive.mjs "<query>" <outPrefix> '<steps JSON>'
// Steps: {"wait":ms} {"key":"KeyR"} (press) {"down":"KeyW"} {"up":"KeyW"} {"mouse":"down"|"up", "button":"left"|"right"}
//        {"pose":[p, empty?, "name"]} (freeze the player's reload at progress p and screenshot it)
//        {"shot":"name"} (→ <outPrefix>_name.png) {"burst":[n, intervalMs, "name"]} (n screenshots) {"eval":"js"} (prints the result)
// Input goes straight into window.__input (pointer lock does not exist headless).
import { launch } from './browser.mjs';
const [q = 'mode=test&auto=us', out = 'drive', stepsJson = '[]'] = process.argv.slice(2);
const steps = JSON.parse(stepsJson);
const b = await launch();
const p = await b.newPage({ viewport: { width: Number(process.env.W ?? 1280), height: Number(process.env.H ?? 720) } });
const logs = [];
p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning' || m.text().startsWith('[t]')) logs.push(`[${m.type()}] ${m.text()}`); });
p.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await p.goto(`http://localhost:5173/?${q}`);
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000 }).catch(() => logs.push('timeout waiting for __ready'));
const I = (js) => p.evaluate(js);
for (const s of steps) {
  if (s.wait) await p.waitForTimeout(s.wait);
  if (s.key) await I(`(() => { const i = window.__input; i.pressed.add(${JSON.stringify(s.key)}); i.down.add(${JSON.stringify(s.key)}); setTimeout(() => i.down.delete(${JSON.stringify(s.key)}), 60); })()`);
  if (s.down) await I(`window.__input.down.add(${JSON.stringify(s.down)})`);
  if (s.up) await I(`window.__input.down.delete(${JSON.stringify(s.up)})`);
  if (s.mouse) { const btn = s.button ?? 'left'; await I(`(() => { const m = window.__input.mouse; m.${btn} = ${s.mouse === 'down'}; if (${s.mouse === 'down'}) m.${btn}Pressed = true; })()`); }
  if (s.look) await I(`(() => { const m = window.__input.mouse; m.dx += ${s.look[0]}; m.dy += ${s.look[1]}; })()`);
  if (s.pose) {
    const [pr, empty, name] = s.pose;
    await I(`(() => { const s = window.__game.player.s; s.reloadDur = 1e5; s.reloadT = 1e5 * (1 - ${pr}); s.reloadEmpty = ${!!empty}; s.ads = 0; })()`);
    await p.waitForTimeout(400); await p.screenshot({ path: `${out}_${name}.png` });
    await I(`(() => { const s = window.__game.player.s; s.reloadT = 0; })()`);
  }
  if (s.shot) await p.screenshot({ path: `${out}_${s.shot}.png` });
  if (s.burst) { const [n, iv, name] = s.burst; for (let i = 0; i < n; i++) { await p.screenshot({ path: `${out}_${name}${String(i).padStart(2, '0')}.png` }); await p.waitForTimeout(iv); } }
  if (s.eval) console.log('eval:', JSON.stringify(await I(s.eval)));
}
console.log(logs.slice(0, 40).join('\n'));
console.log('fps', await I(`String(window.__fps ?? '')`));
await b.close();

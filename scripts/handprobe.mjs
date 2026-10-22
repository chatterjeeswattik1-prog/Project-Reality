import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, env: { ...process.env, DRI_PRIME: '1' }, args: ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
p.on('pageerror', (e) => console.log('pageerror', e.message));
await p.goto(`http://localhost:5173/?${process.argv[2] ?? "auto=us&kit=us_rifle"}&q=low&yaw=90`);
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
await p.waitForTimeout(3000);
const r = await p.evaluate(() => {
  const vm = window.__game.player.vm, B = vm.bones, cam = window.__game.gfx.camera;
  const f = (v) => v.toArray().map((x) => +x.toFixed(2));
  const out = {};
  const camQ = cam.getWorldQuaternion(cam.quaternion.clone()).invert();
  for (const side of ['l', 'r']) {
    const h = B[`hand_${side}`], q = h.getWorldQuaternion(h.quaternion.clone()).premultiply(camQ);
    const Y = h.up.clone().set(0, 1, 0).applyQuaternion(q), X = h.up.clone().set(1, 0, 0).applyQuaternion(q), Z = h.up.clone().set(0, 0, 1).applyQuaternion(q);
    const wp = h.getWorldPosition(h.position.clone()), lp = vm.group.worldToLocal(wp.clone());
    const tip = B[`middle_03_${side}`].getWorldPosition(h.position.clone()); const tl = vm.group.worldToLocal(tip);
    out[side] = { handY_cam: f(Y), handX_cam: f(X), handZ_cam: f(Z), wrist_cam: f(lp), midTip_cam: f(tl), scale: f(h.scale) };
  }
  const m = vm.model; out.weaponQ = f(m.quaternion); out.gripL = f(vm.gripL); out.gripR = f(vm.gripR); out.modelPos = f(m.position);
  return out;
});
console.log(JSON.stringify(r, null, 1));
await b.close();

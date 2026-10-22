import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, env: { ...process.env, DRI_PRIME: '1' }, args: ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
p.on('pageerror', (e) => console.log('pageerror', e.message));
await p.goto(`http://localhost:5173/?mode=test&auto=us&q=low`);
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
await p.waitForTimeout(2500);
const st = () => p.evaluate(() => { const s = window.__game.player.s; return `sprint=${s.sprinting} stam=${s.stamina.toFixed(0)} spd=${Math.hypot(s.vel[0], s.vel[2]).toFixed(2)} moving=${s.moving.toFixed(2)} stance=${s.stance} pos=${s.pos.map((v) => v.toFixed(1))}`; });
await p.keyboard.down('ShiftLeft'); await p.keyboard.down('KeyW');
for (let i = 0; i < 8; i++) { await p.waitForTimeout(500); console.log(await st()); }
await p.keyboard.up('KeyW'); await p.keyboard.up('ShiftLeft');
await b.close();

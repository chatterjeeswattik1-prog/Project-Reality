// Always-on match host (dedicated server) for multiplayer: runs the game headless in Chrome on this machine, hosting the
// one online match with no player of its own and drawing nothing. Players connect to it browser-to-browser (WebRTC),
// so this machine needs no public IP — only outbound internet (HTTPS to the Vercel site, UDP for the players).
//
//   GAME_URL=https://your-game.vercel.app DEDICATED_KEY=… node scripts/dedicated.mjs
//
// Environment:
//   GAME_URL        the deployed game (required)
//   DEDICATED_KEY   the same secret as DEDICATED_KEY on Vercel (lets the server take over the lobby)
//   SERVER_NAME     shown to players (default "Server")
//   CHROME          Chrome executable (default /usr/bin/google-chrome, else google-chrome-stable)
//   STATUS_PORT     local status page, http://127.0.0.1:<port>/ (default 8790; 0 = off)
//
// Restarts Chrome if the page crashes, hangs or stops simulating; logs a status line every minute. The match starts a
// new round by itself 30 s after one ends (players rejoin automatically). See docs/DEDICATED.md for the CentOS setup.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import http from 'node:http';

const URL0 = process.env.GAME_URL;
if (!URL0) { console.error('GAME_URL is required (the deployed game, e.g. https://your-game.vercel.app)'); process.exit(2); }
const KEY = process.env.DEDICATED_KEY ?? '', NAME = process.env.SERVER_NAME ?? 'Server';
const STATUS_PORT = Number(process.env.STATUS_PORT ?? 8790);
const chrome = process.env.CHROME ?? ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'].find((p) => fs.existsSync(p));
const url = `${URL0.replace(/\/$/, '')}/?${new URLSearchParams({ mp: 'dedicated', auto: 'us', q: 'low', name: NAME, ...(KEY ? { key: KEY } : {}) })}`;

const log = (...a) => console.log(new Date().toISOString(), ...a);
let status = { state: 'starting' }, browser = null, stopping = false;

// Local status page (JSON): players, frame rate, upload, round.
if (STATUS_PORT) http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(status, null, 1)); }).listen(STATUS_PORT, '127.0.0.1', () => log(`status on http://127.0.0.1:${STATUS_PORT}/`));

async function runOnce() {
  log('starting Chrome', chrome ?? '(Playwright Chromium)');
  browser = await chromium.launch({
    executablePath: chrome, headless: true,
    args: [
      // No GPU needed: the server draws nothing (software WebGL only for the scene set-up).
      '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
      // Never throttle the simulation's timers.
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
      '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage', '--js-flags=--max-old-space-size=6144',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  let crashed = false;
  page.on('crash', () => { crashed = true; log('page crashed'); });
  page.on('pageerror', (e) => log('[page error]', e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') { const t = m.text(); if (!/404|GPU|WebGL|X4122|X3595/.test(t)) log(`[page ${m.type()}]`, t.slice(0, 300)); } });
  page.on('dialog', (d) => { log('[page dialog]', d.message()); void d.dismiss(); });
  log('loading', url.replace(/key=[^&]+/, 'key=…'));
  await page.goto(url, { timeout: 120000 });
  await page.waitForFunction(() => window.__ready === true && !!window.__status, null, { timeout: 15 * 60000 });
  log('match running');
  let stalls = 0, lastLog = 0;
  while (!stopping && !crashed && browser.isConnected()) {
    await new Promise((r) => setTimeout(r, 10000));
    let st = null;
    try { st = await page.evaluate(() => (window.__status ? window.__status() : null)); } catch { st = null; } // reloading (new round)
    if (!st) {
      // Between rounds the page reloads: give it time to load the map again.
      try { await page.waitForFunction(() => window.__ready === true && !!window.__status, null, { timeout: 15 * 60000 }); log('new round'); continue; } catch { log('page did not come back'); break; }
    }
    status = { state: 'running', at: new Date().toISOString(), ...st };
    stalls = st.fps < 5 ? stalls + 1 : 0;
    if (stalls >= 6) { log('simulation stalled for a minute: restarting'); break; }
    if (Date.now() - lastLog > 60000) {
      lastLog = Date.now();
      log(`players ${st.players}/20 · ${st.fps} fps · upload ${st.upKBs} KB/s · lobby ${st.holding ? 'held' : 'NOT HELD'} · ${st.top}${st.over ? ` · round over (${st.over} won)` : ''}`);
      if (st.peers.length) log('  ' + st.peers.map((p) => `${p.name} (${p.side}, ${p.rtt} ms)`).join(', '));
    }
  }
  try { await browser.close(); } catch { /* already gone */ }
  browser = null;
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { stopping = true; log(`${sig}: shutting down`); try { await browser?.close(); } catch { /* */ } process.exit(0); });

// Run for ever: any failure restarts Chrome after a short pause.
while (!stopping) {
  try { await runOnce(); } catch (e) { log('error:', e.message); try { await browser?.close(); } catch { /* */ } }
  if (stopping) break;
  status = { state: 'restarting', at: new Date().toISOString() };
  await new Promise((r) => setTimeout(r, 15000));
}

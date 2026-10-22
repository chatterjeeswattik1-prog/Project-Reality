// Offline check of the reverb levels: dry M4 shot vs shot + room / street reverb (peak, RMS, tail energy).
import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage();
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.goto('http://localhost:5173/?mode=test&q=low&bots=0&shot=-110,1.6,140,0,0');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 180000 });
const r = await p.evaluate(async () => {
  const a = window.__game.audio, shot = a.buffers.get('m4_shot')?.[0];
  if (!shot) return 'no m4_shot';
  const out = {};
  for (const [k, ir, lvl, send] of [['dry', null, 0, 0], ['room', a.roomIR(), 1.3, 0.55], ['street', a.streetIR(), 0.85, 0.45], ['street@150m', a.streetIR(), 0.85, 0.45 * 2.8]]) {
    const len = shot.duration + 3.5, oc = new OfflineAudioContext(2, Math.ceil(len * 48000), 48000);
    const s = oc.createBufferSource(); s.buffer = shot; s.connect(oc.destination);
    if (ir) { const g = oc.createGain(); g.gain.value = send; const c = oc.createConvolver(); c.normalize = false; c.buffer = ir; const o = oc.createGain(); o.gain.value = lvl; s.connect(g).connect(c).connect(o).connect(oc.destination); }
    s.start();
    const buf = await oc.startRendering(), d = buf.getChannelData(0);
    let pk = 0, e = 0, tail = 0; const t0 = Math.floor((shot.duration + 0.1) * 48000);
    for (let i = 0; i < d.length; i++) { pk = Math.max(pk, Math.abs(d[i])); e += d[i] * d[i]; if (i > t0) tail += d[i] * d[i]; }
    // decay: time until a 50 ms window drops 40 dB under the peak window
    let peakW = 0, dec = 0; const W = 2400;
    for (let i = 0; i + W < d.length; i += W) { let w = 0; for (let k = 0; k < W; k++) w += d[i + k] ** 2; w = Math.sqrt(w / W); if (w > peakW) peakW = w; if (w > peakW / 100) dec = (i + W) / 48000; }
    out[k] = { peak: pk.toFixed(2), rms: Math.sqrt(e / d.length).toFixed(4), tailE: tail.toFixed(1), decay40dB: dec.toFixed(2) };
  }
  return { shotLen: shot.duration.toFixed(2), ...out };
});
console.log(JSON.stringify(r, null, 1));
await b.close();

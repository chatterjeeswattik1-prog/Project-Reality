// Synthesised vehicle sound (no CC0 recordings of these engines): the M1A2's AGT1500 gas turbine (a high whine that
// rises with the throttle over a broadband jet roar), the Bradley's V8 diesel (a low pulsing firing rhythm), and the
// track clatter whose rate follows the track speed. One positional voice per vehicle, levels set every frame.
type V3 = [number, number, number];

export class EngineSound {
  private out: GainNode; private pan: PannerNode;
  private oscs: OscillatorNode[] = []; private srcs: AudioBufferSourceNode[] = [];
  private whine?: OscillatorNode; private whine2?: OscillatorNode; private roarG: GainNode; private lowG: GainNode;
  private fire?: OscillatorNode; private fire2?: OscillatorNode; private dieselG?: GainNode;
  private trackG: GainNode; private trackLfo: OscillatorNode; private trackAm: GainNode;
  private stopped = false;

  constructor(private ctx: AudioContext, dest: AudioNode, private kind: 'turbine' | 'diesel') {
    const c = ctx;
    this.pan = c.createPanner(); this.pan.panningModel = 'equalpower'; this.pan.distanceModel = 'linear'; this.pan.rolloffFactor = 0; this.pan.maxDistance = 1e6;
    this.out = c.createGain(); this.out.gain.value = 0;
    this.pan.connect(this.out).connect(dest);
    const noise = c.createBuffer(1, c.sampleRate * 2, c.sampleRate), nd = noise.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    const noiseSrc = (): AudioBufferSourceNode => { const s = c.createBufferSource(); s.buffer = noise; s.loop = true; s.start(); this.srcs.push(s); return s; };
    // Low rumble (both): filtered noise.
    const low = c.createBiquadFilter(); low.type = 'lowpass'; low.frequency.value = 140;
    this.lowG = c.createGain(); this.lowG.gain.value = 0.5;
    noiseSrc().connect(low).connect(this.lowG).connect(this.pan);
    // Roar (turbine: jet hiss; diesel: mechanical noise).
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = kind === 'turbine' ? 2600 : 900; bp.Q.value = 0.7;
    this.roarG = c.createGain(); this.roarG.gain.value = 0.05;
    noiseSrc().connect(bp).connect(this.roarG).connect(this.pan);
    if (kind === 'turbine') {
      const f = c.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 6; f.frequency.value = 1800;
      this.whine = c.createOscillator(); this.whine.type = 'sawtooth'; this.whine.frequency.value = 900;
      this.whine2 = c.createOscillator(); this.whine2.type = 'sine'; this.whine2.frequency.value = 2400;
      const wg = c.createGain(), w2 = c.createGain(); wg.gain.value = 0.05; w2.gain.value = 0.03;
      this.whine.connect(f).connect(wg).connect(this.pan); this.whine2.connect(w2).connect(this.pan);
      this.whine.start(); this.whine2.start(); this.oscs.push(this.whine, this.whine2);
    } else {
      // Diesel: firing pulses (a square at the firing frequency through a resonant low-pass) and its second harmonic.
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420; lp.Q.value = 3;
      this.fire = c.createOscillator(); this.fire.type = 'square'; this.fire.frequency.value = 30;
      this.fire2 = c.createOscillator(); this.fire2.type = 'sawtooth'; this.fire2.frequency.value = 60;
      this.dieselG = c.createGain(); this.dieselG.gain.value = 0.18;
      const g2 = c.createGain(); g2.gain.value = 0.5;
      this.fire.connect(lp); this.fire2.connect(g2).connect(lp); lp.connect(this.dieselG).connect(this.pan);
      this.fire.start(); this.fire2.start(); this.oscs.push(this.fire, this.fire2);
    }
    // Track clatter: bright noise amplitude-modulated at the link rate.
    const tb = c.createBiquadFilter(); tb.type = 'bandpass'; tb.frequency.value = 1500; tb.Q.value = 0.8;
    this.trackAm = c.createGain(); this.trackAm.gain.value = 0;
    this.trackLfo = c.createOscillator(); this.trackLfo.type = 'square'; this.trackLfo.frequency.value = 10;
    const lfoG = c.createGain(); lfoG.gain.value = 0.5; this.trackLfo.connect(lfoG).connect(this.trackAm.gain); this.trackLfo.start(); this.oscs.push(this.trackLfo);
    this.trackG = c.createGain(); this.trackG.gain.value = 0;
    noiseSrc().connect(tb).connect(this.trackAm).connect(this.trackG).connect(this.pan);
  }

  /** rpm 0..1 (0 = engine off), load 0..1 (throttle), track speed (m/s). */
  update(p: V3, listener: V3, rpm: number, load: number, trackV: number, crewed: boolean) {
    if (this.stopped) return;
    const c = this.ctx, t = c.currentTime;
    if (this.pan.positionX) { this.pan.positionX.value = p[0]; this.pan.positionY.value = p[1] + 1.2; this.pan.positionZ.value = p[2]; }
    else this.pan.setPosition(p[0], p[1] + 1.2, p[2]);
    const d = Math.hypot(p[0] - listener[0], p[1] - listener[1], p[2] - listener[2]);
    // Audible to ~600 m (the turbine whine carries; the clatter does not).
    const on = rpm > 0 && crewed ? 1 : rpm > 0 ? 0.35 : 0;
    const vol = on * Math.max(0, 1 - d / 650) ** 1.6;
    this.out.gain.setTargetAtTime(vol * 0.9, t, 0.2);
    if (this.kind === 'turbine') {
      this.whine!.frequency.setTargetAtTime(700 + 1300 * rpm, t, 0.6);
      this.whine2!.frequency.setTargetAtTime(1900 + 2200 * rpm, t, 0.6);
      this.roarG.gain.setTargetAtTime(0.04 + 0.12 * rpm, t, 0.4);
    } else {
      const f = 22 + 48 * rpm;
      this.fire!.frequency.setTargetAtTime(f, t, 0.3); this.fire2!.frequency.setTargetAtTime(f * 2, t, 0.3);
      this.dieselG!.gain.setTargetAtTime(0.12 + 0.18 * load, t, 0.3);
      this.roarG.gain.setTargetAtTime(0.03 + 0.06 * load, t, 0.3);
    }
    this.lowG.gain.setTargetAtTime(0.35 + 0.4 * load, t, 0.3);
    // Track links: ~0.19 m pitch (T-158 / T-161 track shoes); clatter rate follows, level with speed, louder close up.
    const v = Math.abs(trackV);
    this.trackLfo.frequency.setTargetAtTime(Math.max(2, Math.min(60, v / 0.19)), t, 0.2);
    this.trackG.gain.setTargetAtTime(Math.min(1, v / 4) * 0.5 * Math.max(0, 1 - d / 250), t, 0.2);
  }

  stop() {
    if (this.stopped) return; this.stopped = true;
    for (const o of this.oscs) try { o.stop(); } catch { /* */ }
    for (const s of this.srcs) try { s.stop(); } catch { /* */ }
    this.out.disconnect();
  }
}

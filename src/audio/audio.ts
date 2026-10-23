// Positional game audio (WebAudio). Distant shots arrive late (343 m/s), lose their highs, and switch to the far
// "boom/echo" recordings; sounds behind walls are muffled. Files come from public/audio/manifest.json (CC0, Freesound);
// anything missing is synthesised so the game always has sound.
// Acoustics (after Six Days in Fallujah's audio work: a shot inside a room sounds nothing like one in the street):
// every sound also feeds one of two reverbs, chosen by whether its *source* is under a roof — a short, dense,
// bright room (plaster and concrete, ~0.7 s) or the street: discrete slapbacks off the facades, then a long dark
// tail rolling over the rooftops. The wet share grows with distance, so far fights are mostly echo.
import { audioBuffer } from '../core/assets';

type V3 = [number, number, number];
interface Entry { files: string[]; gain: number; loop?: boolean }
const BASE = import.meta.env.BASE_URL;
const SPEED_OF_SOUND = 343;

export class Audio {
  ctx: AudioContext;
  master: GainNode; sfx: GainNode; amb: GainNode;
  manifest: Record<string, Entry> = {};
  buffers = new Map<string, AudioBuffer[]>();
  listener: { p: V3; f: V3 } = { p: [0, 0, 0], f: [0, 0, -1] };
  private voices = 0;
  private noise: AudioBuffer;
  /** Line-of-sight test supplied by the game (for muffling). */
  occluded: (a: V3, b: V3) => boolean = () => false;
  muffle = 0; // tinnitus / suppression dulling 0..1
  private muffleFilter: BiquadFilterNode;
  /** Is this point under a roof? Supplied by the game (an upward ray); picks the room or street reverb. */
  indoorAt: (p: V3) => boolean = () => false;
  private room: GainNode; private street: GainNode;
  private listenerIndoor = false; private indoorT = 0;

  constructor(public hrtf: boolean) {
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain(); this.master.gain.value = 0.8;
    this.muffleFilter = this.ctx.createBiquadFilter(); this.muffleFilter.type = 'lowpass'; this.muffleFilter.frequency.value = 22000;
    const comp = this.ctx.createDynamicsCompressor(); comp.threshold.value = -12; comp.ratio.value = 6; comp.attack.value = 0.002; comp.release.value = 0.2;
    this.master.connect(this.muffleFilter).connect(comp).connect(this.ctx.destination);
    this.sfx = this.ctx.createGain(); this.sfx.connect(this.master);
    this.amb = this.ctx.createGain(); this.amb.gain.value = 0.5; this.amb.connect(this.master);
    // IRs are unit-energy, so `level` × send is the wet/dry amplitude ratio for an impulsive sound.
    this.room = this.reverb(this.roomIR(), 1.3); this.street = this.reverb(this.streetIR(), 0.85);
    this.noise = this.ctx.createBuffer(1, this.ctx.sampleRate, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  async load(names?: string[]) {
    try { const r = await fetch(`${BASE}audio/manifest.json`); if (r.ok) this.manifest = await r.json(); } catch { /* none yet */ }
    const list = names ?? Object.keys(this.manifest);
    await Promise.all(list.map(async (n) => {
      const e = this.manifest[n]; if (!e) return;
      const bufs = (await Promise.all(e.files.map((f) => audioBuffer(this.ctx, f)))).filter((b): b is AudioBuffer => !!b);
      if (bufs.length) this.buffers.set(n, bufs);
    }));
  }
  resume() { if (this.ctx.state !== 'running') void this.ctx.resume(); }
  /**
   * Low-frequency punch under a close gunshot (the chest thump recordings lose): a sine sweep ~95 → 38 Hz with a
   * fast decay plus a short filtered noise crack. `k` scales it (~0.6 pistol, 1 rifle, 1.4 full-power, 2 heavy MG).
   */
  punch(k: number, gain = 1) {
    if (this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime, g = this.ctx.createGain(), o = this.ctx.createOscillator();
    o.type = 'sine'; o.frequency.setValueAtTime(95, t); o.frequency.exponentialRampToValueAtTime(38, t + 0.12);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.55 * k * gain, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09 + 0.05 * k);
    o.connect(g).connect(this.sfx); o.start(t); o.stop(t + 0.25);
    const n = this.ctx.createBufferSource(), f = this.ctx.createBiquadFilter(), ng = this.ctx.createGain();
    n.buffer = this.noise; f.type = 'lowpass'; f.frequency.value = 900;
    ng.gain.setValueAtTime(0.25 * k * gain, t); ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    n.connect(f).connect(ng).connect(this.sfx); n.start(t, Math.random() * 0.5, 0.08);
  }
  setVolume(v: number) { this.master.gain.value = v; }

  setListener(p: V3, f: V3) {
    this.listener = { p, f };
    const L = this.ctx.listener, t = this.ctx.currentTime;
    if (L.positionX) { L.positionX.setValueAtTime(p[0], t); L.positionY.setValueAtTime(p[1], t); L.positionZ.setValueAtTime(p[2], t); L.forwardX.setValueAtTime(f[0], t); L.forwardY.setValueAtTime(f[1], t); L.forwardZ.setValueAtTime(f[2], t); L.upX.setValueAtTime(0, t); L.upY.setValueAtTime(1, t); L.upZ.setValueAtTime(0, t); }
    else { L.setPosition(p[0], p[1], p[2]); L.setOrientation(f[0], f[1], f[2], 0, 1, 0); }
    this.muffleFilter.frequency.setTargetAtTime(22000 * (1 - this.muffle) + 700 * this.muffle, t, 0.05);
    // Indoors the outdoor ambience (wind, birds, the distant battle) comes through the walls, quieter and duller.
    if (t > this.indoorT) {
      this.indoorT = t + 0.3; const ind = this.indoorAt(p);
      if (ind !== this.listenerIndoor) { this.listenerIndoor = ind; this.amb.gain.setTargetAtTime(ind ? 0.22 : 0.5, t, 0.4); }
    }
  }

  // ---------- reverbs ----------
  private reverb(ir: AudioBuffer, level: number): GainNode {
    const send = this.ctx.createGain(), conv = this.ctx.createConvolver(), out = this.ctx.createGain();
    conv.normalize = false; conv.buffer = ir; out.gain.value = level;
    send.connect(conv).connect(out).connect(this.sfx);
    return send;
  }
  /** Decaying stereo noise; `damp(t)` 0..1 is the one-pole low-pass coefficient over time (highs die first). */
  private tail(len: number, rt60: number, damp: (t: number) => number, gain: number, into?: AudioBuffer): AudioBuffer {
    const sr = this.ctx.sampleRate, n = Math.floor(len * sr), b = into ?? this.ctx.createBuffer(2, n, sr);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c); let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr, a = damp(t);
        lp += (1 - a) * ((Math.random() * 2 - 1) - lp);
        d[i] += lp * gain * Math.pow(10, (-3 * t) / rt60) * Math.min(1, t / 0.004);
      }
    }
    return b;
  }
  private normalize(b: AudioBuffer) {
    let e = 0; for (let c = 0; c < 2; c++) for (const v of b.getChannelData(c)) e += v * v;
    const k = 1 / Math.sqrt(e / 2); for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] *= k; }
    return b;
  }
  private tap(b: AudioBuffer, t: number, amp: number, spread: number, pan: number) {
    const sr = this.ctx.sampleRate;
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c), g = amp * (c === 0 ? 1 - pan * 0.5 : 1 + pan * 0.5), i0 = Math.floor(t * sr), w = Math.floor(spread * sr);
      for (let k = 0; k < w && i0 + k < d.length; k++) d[i0 + k] += g * (Math.random() * 2 - 1) * Math.exp(-k / (w * 0.3));
    }
  }
  /** A plastered concrete room, 3–5 m: dense early reflections in the first 25 ms, bright ~0.7 s decay. */
  private roomIR() {
    const b = this.tail(0.9, 0.7, (t) => 0.15 + t * 0.6, 0.22);
    for (let i = 0; i < 14; i++) this.tap(b, 0.003 + Math.random() * 0.024, 0.35 * (1 - i / 16), 0.002, Math.random() * 2 - 1);
    return this.normalize(b);
  }
  /** A street between two- and three-storey buildings: slapbacks off near and far facades, then a long dark tail. */
  private streetIR() {
    const b = this.tail(3.2, 2.6, (t) => Math.min(0.97, 0.55 + t * 0.25), 0.07);
    const echoes = [[0.045, 0.32], [0.075, 0.26], [0.12, 0.2], [0.19, 0.15], [0.27, 0.1], [0.38, 0.08], [0.55, 0.05], [0.8, 0.035]];
    for (const [t, a] of echoes) this.tap(b, t * (0.9 + Math.random() * 0.2), a, 0.012 + t * 0.03, Math.random() * 2 - 1);
    return this.normalize(b);
  }

  /** A buffer for a sound; `variant` fixes the take (gunshots: one recording per weapon, so every shot sounds the same gun). */
  private pick(name: string, variant?: number): AudioBuffer | null { const b = this.buffers.get(name); return b ? b[variant !== undefined ? Math.min(variant, b.length - 1) : Math.floor(Math.random() * b.length)] : null; }

  /**
   * Play a sound. `pos` null = non-positional (first person). `range` is the distance where it fades out.
   * `far`: name of the distant variant crossfaded in beyond `nearDist`.
   */
  play(name: string, pos: V3 | null, o: { gain?: number; range?: number; far?: string; nearDist?: number; rate?: number; delay?: boolean; loop?: boolean; variant?: number; verb?: number } = {}): AudioBufferSourceNode | null {
    if (this.ctx.state !== 'running' || this.voices > 40) return null;
    const ctx = this.ctx, g0 = (o.gain ?? 1) * (this.manifest[name]?.gain ?? 1);
    let dist = 0, t = ctx.currentTime;
    if (pos) {
      const l = this.listener.p; dist = Math.hypot(pos[0] - l[0], pos[1] - l[1], pos[2] - l[2]);
      const range = o.range ?? 120; if (dist > range) return null;
      if (o.delay !== false && dist > 20) t += dist / SPEED_OF_SOUND;
    }
    const useFar = !!(o.far && pos && dist > (o.nearDist ?? 60));
    const buf = (useFar ? this.pick(o.far!) : this.pick(name, o.variant)) ?? this.pick(name, o.variant);
    const src = ctx.createBufferSource();
    let out: AudioNode;
    if (buf) { src.buffer = buf; src.playbackRate.value = (o.rate ?? 1) * (o.variant !== undefined ? 0.985 + Math.random() * 0.03 : 0.96 + Math.random() * 0.08); out = src; }
    else { src.buffer = this.noise; out = this.synth(src, name); }
    src.loop = !!o.loop;
    const g = ctx.createGain();
    let gain = g0;
    let chain: AudioNode = out;
    if (pos) {
      const range = o.range ?? 120;
      gain *= Math.max(0, 1 - dist / range) ** 1.3 * (useFar ? (o.far ? (this.manifest[o.far]?.gain ?? 1) / (this.manifest[name]?.gain ?? 1) : 1) : 1);
      const occ = this.occluded(this.listener.p, pos);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
      lp.frequency.value = Math.max(500, 18000 / (1 + dist / 120)) * (occ ? 0.25 : 1);
      if (occ) gain *= 0.6;
      const pan = ctx.createPanner(); pan.panningModel = this.hrtf && dist < 60 ? 'HRTF' : 'equalpower'; pan.distanceModel = 'linear'; pan.refDistance = 1; pan.maxDistance = 1e6; pan.rolloffFactor = 0;
      if (pan.positionX) { pan.positionX.value = pos[0]; pan.positionY.value = pos[1]; pan.positionZ.value = pos[2]; } else pan.setPosition(pos[0], pos[1], pos[2]);
      chain.connect(lp); lp.connect(pan); chain = pan;
    }
    g.gain.value = gain * (o.variant !== undefined ? 0.94 + Math.random() * 0.06 : 1); chain.connect(g); g.connect(this.sfx);
    // Reverb send: loud sounds excite the space; quiet handling sounds barely do. Far = mostly wet.
    const loud = /shot|launch|explosion|far|crack/.test(name), verb = o.verb ?? (loud ? 1 : 0.3);
    if (verb > 0 && !o.loop) {
      const indoor = pos ? this.indoorAt(pos) : this.listenerIndoor;
      const send = ctx.createGain(); send.gain.value = gain * verb * (indoor ? 0.55 : 0.45) * Math.min(2.8, 1 + dist / 60);
      out.connect(send).connect(indoor ? this.room : this.street);
    }
    this.voices++;
    src.onended = () => { this.voices--; g.disconnect(); };
    src.start(t);
    if (!buf) src.stop(t + this.synthLen(name));
    return src;
  }

  /** Looping ambience bed (non-positional). */
  ambience(name: string, gain: number) {
    const b = this.pick(name); if (!b) return;
    const s = this.ctx.createBufferSource(); s.buffer = b; s.loop = true;
    const g = this.ctx.createGain(); g.gain.value = gain; s.connect(g).connect(this.amb); s.start();
  }

  // ---------- fallbacks ----------
  private synthLen(name: string) { return name.includes('explosion') ? 2.0 : name.includes('shot') || name.includes('launch') ? 0.5 : name.includes('crack') ? 0.08 : 0.15; }
  private synth(src: AudioBufferSourceNode, name: string): AudioNode {
    const ctx = this.ctx, t = ctx.currentTime, f = ctx.createBiquadFilter(), g = ctx.createGain();
    const len = this.synthLen(name), big = name.includes('explosion') || name.includes('m2') || name.includes('dshk');
    f.type = name.includes('crack') ? 'highpass' : 'lowpass';
    f.frequency.value = name.includes('crack') ? 2500 : big ? 600 : name.includes('far') ? 900 : 4000;
    g.gain.setValueAtTime(name.includes('step') ? 0.15 : 1, t); g.gain.exponentialRampToValueAtTime(0.001, t + len);
    src.connect(f).connect(g);
    return g;
  }
}

#!/usr/bin/env python3
"""
Build the game's sound library (public/audio/*.ogg + manifest.json + CREDITS.txt)
from CC0 Freesound recordings, plus a few synthesised layers.

    python3 scripts/build-audio.py              # fetch missing sources, build everything
    python3 scripts/build-audio.py m4_shot ...  # rebuild only these names
    python3 scripts/build-audio.py --stats      # print duration / peak / RMS of every output

Requirements: numpy, scipy, and an ffmpeg with libvorbis. ffmpeg is taken from $FFMPEG,
then PATH, then the imageio-ffmpeg wheel (pip install --user imageio-ffmpeg scipy).

Sources: every Freesound id used below is downloaded (HQ preview MP3) into tools/audio-src/
together with <id>.json (title, author, url, licence). The fetcher refuses any sound whose
page does not show the Creative Commons 0 licence. All processing is deterministic
(seeded noise), so re-running gives the same files.
"""
import json, os, re, shutil, subprocess, sys, html, tempfile, time, wave
import numpy as np
from scipy import signal

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'tools', 'audio-src')
OUT = os.path.join(ROOT, 'public', 'audio')
SR = 44100


def find_ffmpeg():
    if os.environ.get('FFMPEG'):
        return os.environ['FFMPEG']
    if shutil.which('ffmpeg'):
        return shutil.which('ffmpeg')
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        sys.exit('ffmpeg not found: install it or `pip install --user imageio-ffmpeg`')


FF = find_ffmpeg()

# ----------------------------------------------------------------------------- fetching

def fetch(i):
    """Download Freesound sound <i> (HQ preview) after checking it is CC0. Returns metadata."""
    os.makedirs(SRC, exist_ok=True)
    mp3, meta = f'{SRC}/{i}.mp3', f'{SRC}/{i}.json'
    if os.path.exists(mp3) and os.path.exists(meta):
        return json.load(open(meta))
    h = subprocess.run(['curl', '-sL', '-A', 'Mozilla/5.0', f'https://freesound.org/s/{i}/'],
                       capture_output=True, text=True).stdout
    if not ('publicdomain/zero/1.0' in h and 'Creative Commons 0' in h):
        raise SystemExit(f'Freesound {i}: licence is not CC0 (or page unavailable) - refusing')
    m = re.search(r'og:audio" content="[^"]*?(https://cdn\.freesound\.org/previews/[^"]+?)-lq\.mp3"', h)
    t = re.search(r'<title>Freesound - (.*?) by ([^<]+)</title>', h, re.S)
    ds = re.search(r'twitter:description" content="([^"]*)"', h)
    if not (m and t):
        raise SystemExit(f'Freesound {i}: could not parse page')
    d = dict(id=int(i), title=html.unescape(t.group(1).strip()), author=html.unescape(t.group(2).strip()),
             url=f'https://freesound.org/s/{i}/', license='CC0 1.0', mp3=m.group(1) + '-hq.mp3',
             desc=html.unescape(ds.group(1)) if ds else '')
    subprocess.run(['curl', '-sL', '--retry', '3', '-o', mp3, d['mp3']], check=True)
    json.dump(d, open(meta, 'w'), indent=1)
    time.sleep(0.3)
    return d


# ----------------------------------------------------------------------------- I/O

_cache = {}
_used = None          # set of Freesound ids used by the file being built
_synth = None         # list of synthesised layer descriptions for the file being built


def S(i, ch=1):
    """Load Freesound sound i as float32 (mono: (n,), stereo: (n,2)) at 44.1 kHz."""
    if _used is not None:
        _used.add(int(i))
    key = (int(i), ch)
    if key not in _cache:
        fetch(i)
        raw = subprocess.run([FF, '-v', 'quiet', '-i', f'{SRC}/{i}.mp3', '-f', 'f32le', '-ac', str(ch),
                              '-ar', str(SR), '-'], capture_output=True, check=True).stdout
        x = np.frombuffer(raw, np.float32).astype(np.float64)
        _cache[key] = x.reshape(-1, 2) if ch == 2 else x
    return _cache[key].copy()


def synth(desc):
    if _synth is not None and desc not in _synth:
        _synth.append(desc)


def encode(path, x, quality):
    x = np.clip(x, -1, 1)
    ch = 1 if x.ndim == 1 else 2
    pcm = (x * 32767).astype('<i2').tobytes()
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
        tmp = f.name
    with wave.open(tmp, 'wb') as w:
        w.setnchannels(ch); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm)
    subprocess.run([FF, '-v', 'error', '-y', '-i', tmp, '-c:a', 'libvorbis', '-q:a', str(quality),
                    '-ar', str(SR), path], check=True)
    os.unlink(tmp)


def decode(path):
    raw = subprocess.run([FF, '-v', 'quiet', '-i', path, '-f', 'f32le', '-ar', str(SR), '-'],
                         capture_output=True, check=True).stdout
    ch = 2 if 'stereo' in subprocess.run([FF, '-hide_banner', '-i', path], capture_output=True,
                                         text=True).stderr else 1
    x = np.frombuffer(raw, np.float32).astype(np.float64)
    return x.reshape(-1, 2) if ch == 2 else x


# ----------------------------------------------------------------------------- DSP helpers

def sec(t):
    return int(round(t * SR))


def seg(x, t0, t1=None):
    return x[sec(t0):(sec(t1) if t1 is not None else None)].copy()


def mono(x):
    return x.mean(axis=1) if x.ndim == 2 else x


def db(v):
    return 20 * np.log10(max(float(v), 1e-12))


def peak(x):
    return float(np.max(np.abs(x))) if len(x) else 0.0


def rms(x):
    return float(np.sqrt(np.mean(np.square(x)))) if len(x) else 0.0


def norm(x, peak_db=-1.0):
    p = peak(x)
    return x * (10 ** (peak_db / 20) / p) if p > 0 else x


def norm_rms(x, rms_db, max_peak_db=-1.0):
    """Normalise to an RMS level, but never let the peak exceed max_peak_db (soft-limits instead)."""
    x = x * (10 ** (rms_db / 20) / max(rms(x), 1e-9))
    lim = 10 ** (max_peak_db / 20)
    if peak(x) > lim:
        x = softclip(x, lim)
    return x


def softclip(x, ceiling=0.95, drive=1.0):
    return ceiling * np.tanh(drive * x / ceiling)


def _sos(kind, f, order=2):
    return signal.butter(order, f, btype=kind, fs=SR, output='sos')


def _apply(sos, x):
    return signal.sosfilt(sos, x, axis=0)


def hp(x, f, order=2):
    return _apply(_sos('highpass', f, order), x)


def lp(x, f, order=2):
    return _apply(_sos('lowpass', f, order), x)


def bp(x, f0, f1, order=2):
    return _apply(_sos('bandpass', [f0, f1], order), x)


def _biquad(kind, f, gain_db, q=0.707):
    """RBJ cookbook biquads: 'peak', 'low' (shelf), 'high' (shelf)."""
    A = 10 ** (gain_db / 40); w = 2 * np.pi * f / SR; cw, sw = np.cos(w), np.sin(w); al = sw / (2 * q)
    if kind == 'peak':
        b = [1 + al * A, -2 * cw, 1 - al * A]; a = [1 + al / A, -2 * cw, 1 - al / A]
    elif kind == 'low':
        s = 2 * np.sqrt(A) * al
        b = [A * ((A + 1) - (A - 1) * cw + s), 2 * A * ((A - 1) - (A + 1) * cw), A * ((A + 1) - (A - 1) * cw - s)]
        a = [(A + 1) + (A - 1) * cw + s, -2 * ((A - 1) + (A + 1) * cw), (A + 1) + (A - 1) * cw - s]
    else:
        s = 2 * np.sqrt(A) * al
        b = [A * ((A + 1) + (A - 1) * cw + s), -2 * A * ((A - 1) + (A + 1) * cw), A * ((A + 1) + (A - 1) * cw - s)]
        a = [(A + 1) - (A - 1) * cw + s, 2 * ((A - 1) - (A + 1) * cw), (A + 1) - (A - 1) * cw - s]
    return np.array(b) / a[0], np.array(a) / a[0]


def eq(x, kind, f, gain_db, q=0.707):
    b, a = _biquad(kind, f, gain_db, q)
    return signal.lfilter(b, a, x, axis=0)


def fade(x, fin=0.0, fout=0.0):
    x = x.copy(); n = len(x)
    if fin > 0:
        k = min(sec(fin), n); r = np.linspace(0, 1, k)
        x[:k] = (x[:k].T * r).T
    if fout > 0:
        k = min(sec(fout), n); r = np.linspace(1, 0, k) ** 2
        x[n - k:] = (x[n - k:].T * r).T
    return x


def env_db(x, ms=2.0):
    m = mono(x); f = max(1, int(SR * ms / 1000))
    e = np.sqrt(np.convolve(m ** 2, np.ones(f) / f, 'same'))
    return 20 * np.log10(e + 1e-9)


def trim_start(x, rel_db=-30.0, pre_ms=1.0):
    """Cut leading silence: start pre_ms before the first sample within rel_db of the peak."""
    m = np.abs(mono(x)); thr = m.max() * 10 ** (rel_db / 20)
    i = int(np.argmax(m > thr))
    i = max(0, i - int(SR * pre_ms / 1000))
    return fade(x[i:], fin=0.0005)


def trim_end(x, rel_db=-55.0, fout=0.03, min_len=0.0):
    """Cut trailing quiet part (envelope below rel_db re peak), with a short fade."""
    e = env_db(x, 10); thr = e.max() + rel_db
    idx = np.where(e > thr)[0]
    end = idx[-1] + sec(0.01) if len(idx) else len(x)
    end = min(len(x), max(end, sec(min_len)))
    return fade(x[:end], fout=fout)


def cut(x, t0, dur, fout=0.05):
    return fade(seg(x, t0, t0 + dur), fout=fout)


def onsets(x, rel_db=-24.0, rise_db=10.0, min_gap=0.05, hpf=1500.0):
    """Transient times (s): high-passed 1 ms envelope rising rise_db within 4 ms, above rel_db re peak."""
    e = env_db(hp(mono(x), hpf, 2), 1.0)[::int(SR / 1000)]
    top = e.max()
    cand = np.where((e[4:] > top + rel_db) & (e[4:] - e[:-4] > rise_db))[0] + 4
    res, last = [], -10 ** 9
    for k in cand:
        if (k - last) / 1000.0 > min_gap:
            res.append(max(0, k - 3) / 1000.0); last = k
    return res


def shot_at(x, t, length, pre=0.002):
    """Cut a shot whose transient is at time t (s), starting pre seconds earlier."""
    y = seg(x, max(0.0, t - pre), t + length)
    return trim_start(y, rel_db=-30, pre_ms=1.0)


def pad(x, n):
    if len(x) >= n:
        return x
    shape = (n - len(x),) + x.shape[1:]
    return np.concatenate([x, np.zeros(shape)])


def mix(*layers):
    """mix((x, gain, offset_s), ...) -> sum, padded to the longest."""
    n = max(sec(o) + len(x) for x, g, o in layers)
    st = any(x.ndim == 2 for x, g, o in layers)
    y = np.zeros((n, 2) if st else n)
    for x, g, o in layers:
        if st and x.ndim == 1:
            x = np.stack([x, x], 1)
        y[sec(o):sec(o) + len(x)] += x * g
    return y


def stretch(x, ratio):
    """Resample so the sound plays `ratio` times slower (ratio>1 = lower pitch & longer)."""
    n = int(len(x) * ratio)
    return signal.resample(x, n, axis=0) if n > 0 else x


def pitch(x, semitones):
    return stretch(x, 2 ** (-semitones / 12))


_rng = np.random.default_rng(1234)


def rng(seed):
    return np.random.default_rng(seed)


def noise(dur, seed=0, ch=1):
    r = rng(seed); n = sec(dur)
    return r.standard_normal((n, 2) if ch == 2 else n)


def thump(f0=110, f1=45, dur=0.25, decay=0.06, seed=0):
    """Synthesised low-end punch: falling sine + a little low-passed noise."""
    synth('low-end thump layer')
    t = np.arange(sec(dur)) / SR
    f = f1 + (f0 - f1) * np.exp(-t / (decay * 0.6))
    ph = 2 * np.pi * np.cumsum(f) / SR
    y = np.sin(ph) * np.exp(-t / decay)
    y += 0.35 * lp(noise(dur, seed), 300, 2) * np.exp(-t / (decay * 0.5))
    y = fade(y, fin=0.0008)
    return y / peak(y)


def ir(rt60=1.2, predelay=0.0, lpf=5000.0, seed=0, ch=1, early=()):
    """Exponentially decaying noise impulse response (+ optional early reflections (t, gain))."""
    n = sec(rt60 * 1.1 + predelay)
    t = np.arange(n) / SR
    r = rng(seed)
    nz = r.standard_normal((n, ch)) if ch == 2 else r.standard_normal(n)
    envl = np.exp(-6.9 * t / rt60)
    h = (nz.T * envl).T
    h = lp(h, lpf, 1)
    h[:sec(predelay)] = 0
    h = h / np.sqrt(np.sum(np.square(h)) / (ch if ch == 2 else 1)) * 0.5
    for te, g in early:
        h[sec(te)] += g
    return h


def convolve(x, h):
    if x.ndim == 1 and h.ndim == 1:
        return signal.fftconvolve(x, h)
    if x.ndim == 1:
        x = np.stack([x, x], 1)
    if h.ndim == 1:
        h = np.stack([h, h], 1)
    return np.stack([signal.fftconvolve(x[:, c], h[:, c]) for c in range(2)], 1)


def reverb(x, rt60=1.2, wet=0.3, predelay=0.01, lpf=5000.0, seed=0):
    synth('procedural reverb')
    y = convolve(x, ir(rt60, predelay, lpf, seed))
    return mix((x, 1 - wet, 0), (y, wet, 0))


def distant(x, lpf=1800.0, rt60=1.8, wet=0.75, slaps=((0.18, 0.5), (0.41, 0.3), (0.7, 0.18)), seed=0):
    """Far-away version: air absorption (low-pass), urban slapback echoes and a long tail."""
    synth('distance processing (low-pass, slapback, reverb)')
    d = lp(hp(x, 90, 2), lpf, 2)
    d = eq(d, 'peak', 300, 3, 0.8)
    h = ir(rt60, 0.03, lpf * 0.8, seed, early=slaps)
    y = convolve(d, h)
    y = mix((d, 1 - wet, 0), (y, wet * 1.5, 0))
    return trim_start(y, -30, 1.0)


def loopify(x, xfade=1.5):
    """Make a seamless loop: the last `xfade` seconds are crossfaded (equal power) into the start."""
    k = sec(xfade)
    body = x[:len(x) - k].copy()
    tail = x[len(x) - k:]
    t = np.linspace(0, np.pi / 2, k)
    fi, fo = np.sin(t), np.cos(t)
    body[:k] = (body[:k].T * fi).T + (tail.T * fo).T
    return body


def seam_jump(x):
    """Loop-seam discontinuity: the end->start sample step divided by the 99th percentile of the
    signal's own sample-to-sample steps. Values below ~1 cannot produce an audible click."""
    m = x if x.ndim == 1 else x
    step = np.abs(np.atleast_1d(m[0] - m[-1])).max()
    d = np.abs(np.diff(m, axis=0)).ravel()
    return float(step / max(np.percentile(d, 99), 1e-9))


def stereo_from_mono(x, seed=0, width=0.012):
    """Decorrelated pseudo-stereo for mono ambience (short delay + opposite comb)."""
    synth('pseudo-stereo widening')
    d = sec(width)
    l = x
    r = np.concatenate([np.zeros(d), x[:-d]])
    return np.stack([l * 0.9 + r * 0.1, r * 0.9 + l * 0.1], 1)


# ----------------------------------------------------------------------------- recipe registry

RECIPES = {}   # name -> dict(fn, n, gain, loop, stereo, quality)


def out(name, n=1, level=-20.0, loop=False, stereo=False, q=3):
    """Register a recipe. `level` is the intended playback loudness in dBFS (loudest 300 ms RMS for
    one-shots, overall RMS for loops); the manifest gain is derived from it so that all sounds sit at
    sensible relative levels when the game multiplies by `gain`."""
    def deco(fn):
        RECIPES[name] = dict(fn=fn, n=n, level=level, loop=loop, stereo=stereo, q=q)
        return fn
    return deco


def loudness(x, loop=False):
    m = mono(x)
    if loop or len(m) < sec(0.3) or len(m) > sec(8.0):
        return db(rms(m))
    w = sec(0.3)
    c = np.cumsum(np.concatenate([[0.0], m ** 2]))
    return db(np.sqrt(np.max(c[w:] - c[:-w]) / w))


def build(names=None):
    global _used, _synth
    os.makedirs(OUT, exist_ok=True)
    man_path = os.path.join(OUT, 'manifest.json')
    cred_path = os.path.join(OUT, 'credits.json')  # machine-readable, used to rebuild CREDITS.txt
    manifest = json.load(open(man_path)) if (names and os.path.exists(man_path)) else {}
    credits = json.load(open(cred_path)) if (names and os.path.exists(cred_path)) else {}
    todo = names or list(RECIPES)
    ceiling = 10 ** (-1.5 / 20)   # leave headroom for Vorbis overshoot
    for name in todo:
        r = RECIPES[name]
        xs, creds = [], []
        for k in range(r['n']):
            _used, _synth = set(), []
            x = r['fn'](k)
            if not r['stereo'] and x.ndim == 2:
                x = mono(x)
            if r['stereo'] and x.ndim == 1:
                x = np.stack([x, x], 1)
            xs.append(x); creds.append(dict(sources=sorted(_used), synth=list(_synth)))
        louds = [loudness(x, r['loop']) for x in xs]
        if len(xs) > 1:   # match variants to their median loudness so randomising sounds even
            target = float(np.median(louds))
            xs = [x * 10 ** ((target - l) / 20) for x, l in zip(xs, louds)]
        xs = [x * min(1.0, ceiling / max(peak(x), 1e-9)) for x in xs]
        louds = [loudness(x, r['loop']) for x in xs]
        gain = round(float(min(1.0, 10 ** ((r['level'] - np.median(louds)) / 20))), 3)
        files = []
        for k, x in enumerate(xs):
            fn = f'{name}_{k + 1}.ogg' if r['n'] > 1 else f'{name}.ogg'
            encode(os.path.join(OUT, fn), x, r['q'])
            files.append(fn); credits[fn] = creds[k]
            print(f'  {fn:28s} {len(x) / SR:6.2f}s peak {db(peak(x)):6.1f} dBFS  rms {db(rms(x)):6.1f}  loud {louds[k]:6.1f}'
                  + (f'  seam {seam_jump(x):.2f}' if r['loop'] else '') + (f'  -> gain {gain}' if k == 0 else ''), flush=True)
        manifest[name] = dict(files=files, gain=gain, loop=r['loop'])
    manifest = {k: manifest[k] for k in RECIPES if k in manifest}
    json.dump(manifest, open(man_path, 'w'), indent=1)
    json.dump(credits, open(cred_path, 'w'), indent=1)
    write_credits(credits)


def write_credits(credits):
    lines = ['Sound credits for public/audio. Every source recording is from Freesound and is licensed',
             'Creative Commons 0 (CC0 1.0, public domain dedication). Files were cut, filtered, layered and',
             'normalised by scripts/build-audio.py; synthesised layers are our own work, also CC0.',
             'Format: <file>: <source title> by <author> <url> CC0 1.0 [; more sources] [; synthesised parts]', '']
    for fn in sorted(credits):
        c = credits[fn]; parts = []
        for i in c['sources']:
            m = json.load(open(f'{SRC}/{i}.json'))
            parts.append(f'"{m["title"]}" by {m["author"]} {m["url"]} CC0 1.0')
        if c['synth']:
            parts.append('synthesised (CC0): ' + ', '.join(c['synth']))
        lines.append(f'{fn}: ' + '; '.join(parts))
    open(os.path.join(OUT, 'CREDITS.txt'), 'w').write('\n'.join(lines) + '\n')


def stats():
    tot = 0
    man = json.load(open(os.path.join(OUT, 'manifest.json')))
    loops = {f for v in man.values() if v['loop'] for f in v['files']}
    for fn in sorted(os.listdir(OUT)):
        if not fn.endswith('.ogg'):
            continue
        p = os.path.join(OUT, fn); tot += os.path.getsize(p)
        x = decode(p)
        m = np.abs(mono(x)); thr = m.max() * 10 ** (-30 / 20)
        lead = np.argmax(m > thr) / SR * 1000
        print(f'{fn:30s} {len(x) / SR:6.2f}s  peak {db(peak(x)):6.1f}  rms {db(rms(x)):6.1f}  '
              f'lead {lead:5.1f}ms  {"st" if x.ndim == 2 else "mo"}  {os.path.getsize(p) // 1024:5d} KB'
              + (f'  seam {seam_jump(x):.2f}' if fn in loops else ''))
    print(f'total {tot / 1e6:.2f} MB')


# ============================================================================= RECIPES
# Each recipe is called once per variant k (0-based) and returns float audio at 44.1 kHz.
# Freesound ids are given inline; S(id) loads (and fetches) the CC0 source and records credit.

def next_onset(x, t, min_after=0.03, within_db=8.0):
    """Next onset after t that is another shot (not an echo): its level is within `within_db` of the shot at t."""
    e = env_db(hp(mono(x), 1500, 2), 1.0)
    lvl = lambda u: float(e[sec(max(0, u)):sec(u + 0.015)].max())
    ref = lvl(t)
    for o in onsets(x, rel_db=-30):
        if o > t + min_after and lvl(o) > ref - within_db:
            return o
    return None


def shot(i, t=0.0, length=1.2, maxhead=None, single=False):
    """Isolate one shot at time t. If another shot follows within `length`, keep only the head
    up to that shot and grow a synthetic outdoor tail from it (so bursts yield clean singles)."""
    x = S(i)
    nxt = None if single else next_onset(x, t)
    if maxhead and (nxt is None or nxt - t > maxhead):
        # machine-gun source: if the signal right after `maxhead` is still near shot level the burst
        # continues with quieter rounds, so cut there and grow a tail instead
        e = env_db(x, 5)
        ref = float(e[sec(t):sec(t + 0.02)].max())
        if float(np.median(e[sec(t + maxhead):sec(t + maxhead + 0.2)])) > ref - 18:
            nxt = t + maxhead
    if nxt is not None and nxt - t < length:
        print(f'    [shot {i}@{t}: next shot at {nxt:.3f}s -> head + synthetic tail]')
        head = fade(seg(x, max(0, t - 0.002), nxt - 0.003), fout=0.004)
        head = trim_start(head, -30, 1.0)
        synth('synthetic tail (reverb grown from the shot head)')
        tail = convolve(lp(head, 4500, 2), ir(1.1, 0.012, 3500, seed=int(t * 1000) % 97,
                                              early=((0.09, 0.35), (0.23, 0.2))))
        return mix((head, 1.0, 0), (tail, 0.55, 0))
    return trim_start(seg(x, max(0, t - 0.002), t + length), -30, 1.0)


def gunshot(y, th=(110, 45, 0.06, 0.45), hpf=45, sat=1.6, tail_db=-54, maxlen=None, eqs=(), pitch_st=0.0):
    """Common first-person gunshot chain: clean low end, add synthesised thump, EQ, saturate, trim."""
    if pitch_st:
        y = pitch(y, pitch_st)
    y = hp(y, hpf, 2)
    for e in eqs:
        y = eq(y, *e)
    y = norm(y, -2)
    f0, f1, dec, g = th
    if g > 0:
        y = mix((y, 1.0, 0), (thump(f0, f1, max(0.3, dec * 6), dec), g, 0))
    y = softclip(y * sat, 0.97) / sat ** 0.5
    if maxlen:
        y = y[:sec(maxlen)]
    y = trim_end(y, tail_db, fout=min(0.25, len(y) / SR * 0.3))
    y = trim_start(y, -26, 0.5)
    return norm(y, -1)


# ---------------------------------------------------------------- weapons (close, first person)
RIFLE_TH = (120, 48, 0.05, 0.45)
MG_TH = (105, 42, 0.065, 0.55)
SNIPER_TH = (95, 38, 0.085, 0.6)
PISTOL_TH = (160, 60, 0.035, 0.3)
HMG_TH = (75, 30, 0.11, 0.8)


@out('m4_shot', n=3, level=-12)
def _(k):  # real M4A1 shots, US Army range (DVIDS, public domain) via qubodup
    i = [854230, 854228, 854233][k]
    return gunshot(shot(i, 0, 1.3, single=True), RIFLE_TH, eqs=[('peak', 2800, 2, 1.0)])


@out('m249_shot', n=3, level=-12)
def _(k):  # 5.56 automatic: burst ends of a Colt 733, an M16A1 and the KAC LAMG (areniporgen)
    i, t = [(704511, 0.239), (693546, 7.196), (693856, 21.689)][k]
    return gunshot(shot(i, t, 1.1, maxhead=0.1), (110, 45, 0.055, 0.5), eqs=[('peak', 1200, 2, 0.8)], maxlen=1.1)


@out('m240_shot', n=3, level=-11)
def _(k):  # 7.62 NATO MG: M240 single shot + burst end (DVIDS via qubodup), IWI Negev NG-7 (areniporgen)
    i, t = [(854641, 0.075), (854637, 0.346), (725798, 1.33)][k]
    return gunshot(shot(i, t, 1.0, maxhead=0.1), MG_TH, eqs=[('peak', 700, 2, 0.9)], maxlen=1.0)


@out('m24_shot', n=3, level=-11)
def _(k):  # M2010 ESR sniper shots in a field (DVIDS via qubodup)
    i = [855606, 855607, 855608][k]
    return gunshot(shot(i, 0, 1.6, single=True), SNIPER_TH, eqs=[('peak', 2200, 2, 1.0)], tail_db=-58)


@out('m9_shot', n=3, level=-14)
def _(k):  # 9x19 pistols: SIG P226, Glock 19X (areniporgen), 9 mm pistol (michorvath)
    i, t = [(711549, 0.023), (828786, 0.005), (427592, 0.122)][k]
    return gunshot(shot(i, t, 0.9, single=True), PISTOL_TH, eqs=[('peak', 3500, 2, 1.0)], maxlen=0.9)


@out('ak_shot', n=3, level=-12)
def _(k):  # 7.62x39 Kalashnikov pattern: Saiga MK-030 (areniporgen), AK-47 (serotonin)
    i, t = [(698984, 4.344), (698984, 9.775), (855843, 0.0)][k]
    return gunshot(shot(i, t, 1.2, single=(i == 855843)), (110, 44, 0.06, 0.5),
                   eqs=[('peak', 900, 3, 0.9), ('peak', 4500, 1.5, 1.2)], maxlen=1.2)


@out('pkm_shot', n=3, level=-11)
def _(k):  # 7.62 full-power MG stand-ins: HK51 and G3 burst ends (areniporgen), pitched down slightly
    i, t = [(693547, 5.533), (712577, 3.445), (693547, 4.522)][k]
    return gunshot(shot(i, t, 1.0, maxhead=0.1), MG_TH, eqs=[('peak', 550, 3, 0.9)], maxlen=1.0, pitch_st=-0.7)


@out('svd_shot', n=3, level=-11)
def _(k):  # semi-auto full-power rifles: Saiga MK-106 .308, FN SCAR-H (areniporgen), M40A6 (DVIDS)
    i, t = [(696023, 0.019), (702225, 0.03), (855604, 0.0)][k]
    return gunshot(shot(i, t, 1.4, single=True), SNIPER_TH, eqs=[('peak', 1000, 2, 0.9)], tail_db=-50)


@out('makarov_shot', n=3, level=-15)
def _(k):  # small 9 mm pistols: Vektor CP1, ASP, SIG P220 (areniporgen), pitched up a touch
    i, t = [(712087, 0.018), (734061, 0.037), (712085, 0.016)][k]
    return gunshot(shot(i, t, 0.8, single=True), (170, 65, 0.03, 0.25), eqs=[('peak', 2500, 2, 1.0)],
                   maxlen=0.8, pitch_st=0.8)


@out('m2_shot', n=3, level=-10)
def _(k):  # .50 BMG: Avenger M3P training (US Army) and vehicle 50 Cal MG (qubodup)
    i, t = [(160355, 2.281), (239138, 0.451), (239138, 1.742)][k]
    return gunshot(shot(i, t, 1.4, maxhead=0.13), HMG_TH, eqs=[('low', 150, 3)], maxlen=1.4, tail_db=-50)


@out('dshk_shot', n=3, level=-10)
def _(k):  # 12.7 mm: .50 cal recordings with a harsher mid voicing and lower pitch
    i, t = [(668071, 0.015), (160355, 3.297), (239138, 2.728)][k]
    return gunshot(shot(i, t, 1.3, maxhead=0.13), HMG_TH, eqs=[('peak', 650, 4, 0.8), ('high', 6000, -2)],
                   maxlen=1.3, pitch_st=-1.2, tail_db=-50)


@out('m203_launch', n=2, level=-13)
def _(k):  # M203 firing on an aircraft carrier (US Gov video via qubodup)
    i = [162402, 162401][k]
    y = trim_start(S(i), -30, 1.0)
    return gunshot(y, (140, 55, 0.05, 0.6), sat=1.3)


@out('rpg_launch', n=3, level=-10)
def _(k):  # RPG launcher exterior firings (klangfabrik)
    t = [0.105, 3.975, 7.89][k]
    y = trim_start(seg(S(249298), t - 0.08, t + 3.6), -30, 1.0)
    return gunshot(y, (85, 34, 0.1, 0.7), sat=1.4, tail_db=-50)


@out('at4_launch', n=2, level=-9)
def _(k):  # soldiers firing AT weapons on a range (US Gov video via qubodup)
    t = [0.0, 10.0][k]
    y = seg(S(184274), t, t + 4.5)
    y = trim_start(y, -30, 1.0)
    return gunshot(y, (70, 28, 0.14, 0.8), sat=1.3, tail_db=-50)


@out('spg9_launch', n=1, level=-9)
def _(k):  # recoilless gun: cannon shot (craigsmith) + rocket motor from the RPG recording
    boom = trim_start(S(675612), -30, 1.0)
    motor = lp(seg(S(249298), 0.35, 2.4), 3000, 2)
    y = mix((norm(boom, -2), 1.0, 0), (fade(motor, 0.05, 0.6), 0.35, 0.02))
    return gunshot(y, (65, 26, 0.15, 0.85), sat=1.3, tail_db=-50, maxlen=4.0)


@out('grenade_pin', n=1, level=-30)
def _(k):  # key-ring clink (JL_barrett) + 1911 slide release snap (areniporgen) = ring pull and pin out
    ring = hp(trim_start(S(156179)), 800)
    snap = hp(trim_start(S(827946)), 600)
    y = mix((norm(ring, -3), 1.0, 0.0), (norm(snap, -3), 0.7, 0.07))
    return norm(trim_end(y, -50, 0.02), -1)


@out('grenade_throw', n=1, level=-28)
def _(k):  # arm swing: clothing ruffle (WhiteFire43) + whip swish (denao270)
    cloth = fade(seg(S(641387), 0.04, 0.5), 0.02, 0.15)
    whip = trim_start(S(346373), -30)
    y = mix((norm(cloth, -3), 0.6, 0), (norm(whip, -3), 1.0, 0.08))
    return norm(trim_end(y, -50, 0.05), -1)


# ---------------------------------------------------------------- distant gunfire / explosions

@out('rifle_far', n=3, level=-24)
def _(k):  # isolated rifle shots, Afghanistan (US Gov video via qubodup) + urban slapback
    t = [2.01, 3.02, 4.015][k]
    y = trim_start(seg(S(172397), t - 0.01, t + 0.95), -30, 1.0)
    y = fade(y, fout=0.15)
    d = distant(y, lpf=2600, rt60=1.6, wet=0.45, seed=k)
    return norm(trim_end(d, -50, 0.3), -1)


@out('mg_far', n=2, level=-23)
def _(k):  # far MG single shot: close MG shot through air absorption, slapback and city reverb
    y = shot([854641, 693547][k], [0.075, 5.533][k], 0.8)
    d = distant(hp(y, 80), lpf=1500, rt60=2.0, wet=0.8, seed=10 + k)
    return norm(trim_end(d, -50, 0.4), -1)


@out('heavy_far', n=1, level=-21)
def _(k):  # far .50 / 12.7 mm
    y = shot(160355, 2.281, 1.0)
    d = distant(y, lpf=1100, rt60=2.4, wet=0.8, slaps=((0.22, 0.55), (0.5, 0.35), (0.85, 0.2)), seed=20)
    return norm(trim_end(d, -50, 0.4), -1)


@out('explosion_far', n=2, level=-18)
def _(k):
    if k == 0:  # distant explosion of a propelled grenade (qubodup) + long city tail
        y = trim_start(S(162363), -30)
        d = distant(y, lpf=1400, rt60=2.6, wet=0.6, seed=30)
    else:       # military training explosion (DVIDS via qubodup) pushed far away
        y = trim_start(seg(S(855245), 0, 2.4), -30)
        d = distant(y, lpf=700, rt60=3.0, wet=0.75, seed=31)
    d = mix((d, 1.0, 0), (thump(50, 25, 1.2, 0.25, seed=k), 0.25, 0.01))
    return norm(trim_end(d, -50, 0.6), -1)


# ---------------------------------------------------------------- explosions

@out('explosion_near', n=3, level=-9)
def _(k):  # M67 fragmentation grenades and an EOD charge (US military video via qubodup)
    i = [67472, 67474, 855798][k]
    y = norm(trim_start(S(i), -30), -2)
    deb = fade(seg(S(569736), 0.2, 3.5), 0.1, 1.0)
    y = mix((y, 1.0, 0), (thump(70, 26, 1.4, 0.2, seed=40 + k), 0.75, 0),
            (norm(hp(deb, 300), -6), 0.35, 0.35))
    y = softclip(y * 1.5, 0.97)
    return norm(trim_end(y, -52, 0.5), -1)


@out('explosion_big', n=1, level=-8)
def _(k):  # IED / car bomb: explosion with shockwave (DVIDS) + low boom (SamsterBirdies) + debris (Nox_Sound)
    y = norm(trim_start(seg(S(855247), 0, 4.5), -30), -2)
    boom = norm(lp(trim_start(seg(S(591999), 0, 6.0), -30), 400, 2), -3)
    deb = norm(fade(mono(seg(S(550342, 2), 0.0, 4.0)), 0.3, 1.5), -6)
    y = mix((y, 1.0, 0), (boom, 0.7, 0), (thump(55, 20, 2.5, 0.45, seed=50), 0.9, 0), (hp(deb, 250), 0.45, 1.0))
    y = softclip(y * 1.6, 0.97)
    return norm(trim_end(y, -55, 1.0), -1)


@out('debris_fall', n=1, level=-24)
def _(k):  # stones and debris falling (Nox_Sound)
    y = mono(seg(S(550342, 2), 19.0, 24.5))
    return norm(fade(trim_start(y, -35, 5), 0.01, 1.2), -1)


# ---------------------------------------------------------------- bullet effects

def snap(seed=0, dur=0.006, f=2500):
    synth('transient snap')
    t = np.arange(sec(dur)) / SR
    return hp(noise(dur, seed), f, 2) * np.exp(-t / 0.0015)


def nwave(us=380, seed=0):
    """Supersonic N-wave (sharp pressure rise, linear fall, sharp return) plus ground slap."""
    synth('supersonic N-wave crack')
    n = max(6, int(SR * us / 1e6))
    w = np.concatenate([np.zeros(4), np.linspace(1, -1, n), np.zeros(4)])
    w = hp(w, 400, 2)
    slap = 0.45 * np.concatenate([np.zeros(sec(0.006 + 0.004 * (seed % 3))), w])
    y = mix((w, 1.0, 0), (slap, 1.0, 0))
    h = ir(0.35, 0.004, 6000, seed=seed)
    return mix((y, 1.0, 0), (convolve(y, h), 0.25, 0))


@out('crack_supersonic', n=4, level=-16)
def _(k):  # synthesised N-wave layered with a real crack from "Bulletcrack chaos" (modusmogulus)
    t = [0.265, 0.466, 1.024, 3.763][k]
    real = fade(trim_start(seg(S(789225), t - 0.003, t + 0.11), -26, 0.3), fout=0.06)
    nw = nwave(320 + 40 * k, seed=60 + k)
    y = mix((norm(nw, -1), 0.9, 0), (norm(hp(real, 500), -1), 0.8, 0.0005))
    y = softclip(norm(y, -1) * 2.0, 0.97)
    return norm(trim_start(y, -26, 0.3), -1)


@out('whiz', n=3, level=-22)
def _(k):  # subsonic fly-bys (modusmogulus, Daleonfire)
    i = [789222, 789221, 505238][k]
    y = trim_start(S(i), -35, 5)
    return norm(trim_end(hp(y, 200), -45, 0.1), -1)


@out('impact_concrete', n=3, level=-22)
def _(k):  # snap + stone/rubble debris (Sheyvan) + a little dust
    i = [569497, 569502, 569508][k]
    deb = hp(trim_start(S(i), -30), 250)
    deb = trim_end(deb, -45, 0.1)[:sec(0.9)]
    dust = bp(noise(0.25, 70 + k), 2000, 9000) * np.exp(-np.arange(sec(0.25)) / SR / 0.06)
    y = mix((snap(70 + k), 0.9, 0), (norm(deb, -2), 1.0, 0.001), (dust, 0.06, 0.002),
            (thump(320, 140, 0.08, 0.015, seed=70 + k), 0.35, 0))
    return norm(fade(softclip(norm(y, -1) * 1.8, 0.97), fout=0.1), -1)


@out('impact_dirt', n=3, level=-23)
def _(k):  # bullet into ground (modusmogulus) / rock hits dirt (worthahep88) + thud and sand spray
    if k == 0:
        y = trim_start(S(789388), -30)
        y = trim_end(y, -45, 0.15)
    else:
        i, t = [(319222, 0.29), (319229, 0.335)][k - 1]
        hit = trim_start(seg(S(i), t - 0.01, t + 0.5), -30)
        sand = bp(noise(0.4, 80 + k), 1200, 7000) * np.exp(-np.arange(sec(0.4)) / SR / 0.09)
        y = mix((norm(hit, -2), 1.0, 0), (thump(200, 70, 0.15, 0.03, seed=80 + k), 0.6, 0),
                (sand, 0.05, 0.004), (snap(80 + k, f=1500), 0.4, 0))
    return norm(fade(y, fout=0.08), -1)


@out('impact_metal', n=3, level=-22)
def _(k):  # small/medium metal impacts (dorian.mastin) + snap
    i = [381608, 381603, 381619][k]
    y = hp(trim_start(S(i), -30), 250)
    y = mix((snap(90 + k, f=3000), 0.6, 0), (norm(y, -2), 1.0, 0.0005))
    return norm(trim_end(softclip(norm(y, -1) * 1.8, 0.97), -50, 0.1), -1)


@out('impact_flesh', n=2, level=-22)
def _(k):  # visceral bullet impacts (u1769092) + clothed body hit (Flem0527)
    t, ln = [(0.18, 0.5), (1.205, 0.33)][k]
    y = trim_start(seg(S(423301), t - 0.005, t + ln), -30)
    cloth = trim_start(S(629977), -30)
    y = mix((norm(y, -2), 1.0, 0), (norm(cloth, -4), 0.5, 0.002), (thump(130, 60, 0.12, 0.03, seed=95), 0.35, 0))
    return norm(fade(y, fout=0.08), -1)


@out('ricochet', n=3, level=-24)
def _(k):  # rifle ricochets (craigsmith)
    t = [0.188, 3.616, 8.201][k]
    y = trim_start(seg(S(675955), t - 0.01, t + 1.4), -30)
    return norm(trim_end(hp(y, 150), -48, 0.2), -1)


@out('glass_break', n=1, level=-20)
def _(k):  # glass shattering (C_Rogers)
    return norm(trim_end(trim_start(S(203375), -30), -50, 0.2), -1)


# ---------------------------------------------------------------- weapon handling

def foley(i, t0, t1, hpf=120, fin=0.005, fout=0.05, rel=-40):
    y = seg(S(i), t0, t1)
    y = hp(y, hpf, 2)
    y = trim_start(y, rel, 3)
    return norm(fade(trim_end(y, -50, fout), fin), -1)


@out('mag_out', level=-27)
def _(k):  # M16 empty reload sequence (serotonin): magazine release and removal
    return foley(725397, 0.12, 0.8)


@out('mag_in', level=-26)
def _(k):  # M16 reload: new magazine seated
    return foley(725397, 2.1, 2.75)


@out('bolt_release', level=-25)
def _(k):  # M16 reload: bolt catch released, bolt slams home
    return foley(725397, 6.48, 7.06)


@out('charging_handle_ak', level=-25)
def _(k):  # AK-47 cocked (serotonin): one full pull and release
    return foley(675008, 0.15, 0.95)


@out('bolt_action_cycle', level=-25)
def _(k):  # Mosin-Nagant bolt cycle (Zott820): up, back, forward, down
    return foley(370345, 0.05, 1.42)


@out('belt_box_open_close', level=-27)
def _(k):  # ammo can lid open and close (hotdogtornados)
    return foley(240329, 0.0, 2.41, hpf=100)


@out('dry_fire', level=-28)
def _(k):  # rifle dry fire (serotonin)
    return foley(725402, 0.0, 0.52)


@out('casing_drop', n=3, level=-33)
def _(k):  # brass casings on concrete (GrayJoy)
    t0, t1 = [(0.03, 1.0), (2.31, 3.3), (7.61, 8.6)][k]
    return foley(210102, t0, t1, hpf=400)


@out('shell_link', level=-31)
def _(k):  # .30 cal rounds dropping (MPierluissi) + brass on concrete (GrayJoy): casings and belt links
    a = foley(460859, 0.25, 1.4, hpf=400)
    b = foley(210102, 4.08, 4.9, hpf=500)
    return norm(mix((a, 1.0, 0), (pitch(b, 3), 0.6, 0.05)), -1)


@out('rpg_load', level=-27)
def _(k):  # inserting a rocket into an RPG-7 (serotonin), full sequence
    return foley(725401, 0.2, 7.75, fout=0.2)


@out('switch_fire_mode', level=-30)
def _(k):  # safety/selector switch click (NoonerBear)
    return foley(589843, 0.14, 0.45, hpf=300)


@out('aim_cloth', level=-34)
def _(k):  # short cloth rustle (martian)
    y = seg(S(19291), 0.48, 1.05)
    return norm(fade(hp(y, 150), 0.03, 0.15), -1)


# ---------------------------------------------------------------- movement

def step(i, t0=0.0, t1=None, hpf=70):
    y = seg(S(i), t0, t1)
    y = trim_start(hp(y, hpf, 2), -30, 2)
    return norm(trim_end(y, -45, 0.06), -1)


@out('step_concrete', n=4, level=-29)
def _(k):  # concrete footsteps (Yoyodaman234)
    return step([166509, 166507, 166506, 166508][k])


@out('step_dirt', n=4, level=-30)
def _(k):  # dirt footsteps (Yoyodaman234, simonjeffery13)
    if k < 3:
        return step([166510, 166511, 223154][k])
    return step(750794, 7.99, 8.35)


@out('step_gravel', n=3, level=-29)
def _(k):  # gravel footsteps (Ali_6868)
    return step([384871, 384875, 384877][k])


@out('land_jump', level=-25)
def _(k):  # landing after a jump (SoundDesignForYou) + boot on concrete + body thump
    a = step(646661)
    b = step(166507)
    y = mix((a, 1.0, 0), (b, 0.6, 0.004), (thump(120, 50, 0.2, 0.04, seed=100), 0.5, 0))
    return norm(y, -1)


@out('prone_down', level=-27)
def _(k):  # cloth rustle (martian) then body down (deleted_user_2104797)
    cloth = fade(hp(seg(S(19291), 0.45, 1.3), 150), 0.05, 0.3)
    body = trim_start(S(346695), -30, 2)
    y = mix((norm(cloth, -4), 0.7, 0), (norm(body, -1), 1.0, 0.18))
    return norm(trim_end(y, -50, 0.1), -1)


@out('crawl_cloth_loop', level=-32, loop=True)
def _(k):  # crawling (heavenly-roads)
    y = hp(seg(S(510214), 0.4, 17.4), 80)
    return norm_rms(loopify(y, 1.0), -22)


@out('breath_heavy_loop', level=-30, loop=True)
def _(k):  # heavy breathing (ShaneF91)
    y = hp(seg(S(386573), 0.2, 6.95), 80)
    return norm_rms(loopify(y, 0.3), -22)


@out('heartbeat_loop', level=-28, loop=True)
def _(k):  # synthesised 100 bpm heartbeat (loudernoises, CC0); ten beats, sample-exact period
    x = S(332808)
    o = onsets(x, rel_db=-30, hpf=40) or [0.0]
    t0 = max(0.0, o[0] - 0.01)
    y = seg(x, t0, t0 + 6.0 + 0.02)
    return norm(loopify(y, 0.02), -1)


@out('body_fall', level=-23)
def _(k):  # heavy body fall on dirt (leonelmail)
    return step(504626, hpf=50)


@out('bandage', level=-28)
def _(k):  # tape/bandage rip (SecureSubset) then wrapping cloth (ChuckleNutsDev)
    rip = trim_start(hp(S(800275), 200), -35, 3)
    wrap = fade(hp(seg(S(718668), 0.0, 2.2), 150), 0.05, 0.4)
    y = mix((norm(rip, -1), 1.0, 0), (norm(wrap, -3), 0.8, 0.45))
    return norm(trim_end(y, -50, 0.1), -1)


@out('zip_tie', level=-31)
def _(k):  # zip tie being pulled (joliestarr)
    return step(827501, hpf=300)


# ---------------------------------------------------------------- vehicles (mono, positional)

def steady_window(x, length, hop=0.5):
    """Start time of the `length`-second window whose short-term level varies least."""
    e = env_db(x, 100)[::sec(0.1)]
    w = int(length / 0.1); best, bt = 1e9, 0.0
    for s in range(0, max(1, len(e) - w), int(hop / 0.1)):
        v = float(np.std(e[s:s + w])) + 0.02 * float(np.max(e[s:s + w]) - np.median(e[s:s + w]))
        if v < best:
            best, bt = v, s * 0.1
    return bt


def vloop(i, t0=None, length=20.0, xf=2.0, hpf=30, rms_db=-18):
    x = mono(S(i))
    if t0 is None:
        t0 = steady_window(x, length + xf)
    y = hp(seg(x, t0, t0 + length + xf), hpf, 2)
    return norm_rms(loopify(y, xf), rms_db)


@out('humvee_idle_loop', level=-26, loop=True)
def _(k):  # diesel V8 news van idling (kyles) - the same family of engine as the HMMWV 6.5 L
    return vloop(453989, 30.0, 16.0)


@out('humvee_drive_loop', level=-22, loop=True)
def _(k):  # inside a Humvee in convoy (US Army video via qubodup), steadiest stretch
    return vloop(160357, None, 20.0)


@out('pickup_idle_loop', level=-27, loop=True)
def _(k):  # pickup truck idling (kyles)
    return vloop(450222, 6.0, 16.0)


@out('pickup_drive_loop', level=-23, loop=True)
def _(k):  # Toyota Land Cruiser driving slowly on a dirt road, interior (felix.blume)
    return vloop(668554, None, 20.0)


@out('car_door', level=-23)
def _(k):  # car door shut (BlondPanda)
    return step(778418, hpf=40)


@out('tyre_skid', level=-22)
def _(k):  # tyres squealing (RutgerMuller)
    y = trim_start(mono(S(104026)), -30, 5)
    return norm(trim_end(y, -45, 0.3), -1)


@out('vehicle_impact', level=-15)
def _(k):  # two cars crash foley, metallic bump (craigsmith) + crash with glass (magnuswaker)
    a = trim_start(seg(S(675466), 0, 2.5), -30)
    b = trim_start(S(592388), -30)
    y = mix((norm(a, -2), 1.0, 0), (norm(b, -3), 0.55, 0.01), (thump(90, 35, 0.6, 0.09, seed=110), 0.6, 0))
    return norm(trim_end(softclip(y * 1.3), -50, 0.3), -1)


# ---------------------------------------------------------------- ambience (stereo)

def amb(i, t0, length, xf=4.0, lpf=None, hpf=40):
    y = seg(S(i, 2), t0, t0 + length + xf)
    y = hp(y, hpf, 2)
    if lpf:
        y = lp(y, lpf, 2)
    return y, xf


@out('amb_city_wind', level=-32, loop=True, stereo=True, q=2)
def _(k):  # distant Middle-East city haze (kyles, Gaza 2016) + desert wind (felix.blume), 60 s
    city, xf = amb(406546, 20.0, 60.0)
    wind, _ = amb(146914, 30.0, 60.0, lpf=2500)
    y = mix((norm_rms(city, -24), 1.0, 0), (norm_rms(wind, -24), 0.55, 0))
    return norm_rms(loopify(y, xf), -22)


@out('amb_birds_dry', level=-34, loop=True, stereo=True, q=2)
def _(k):  # house sparrows (deleted_user_11205508) + feral pigeons (BeeProductive)
    sp, xf = amb(512805, 1.0, 56.0, hpf=300)
    pg, _ = amb(387207, 40.0, 56.0, hpf=150)
    y = mix((norm_rms(sp, -26), 1.0, 0), (norm_rms(pg, -26), 0.5, 0))
    return norm_rms(loopify(y, xf), -24)


@out('amb_dogs_distant', level=-36, loop=True, stereo=True, q=2)
def _(k):  # city night with distant dogs (thegreatbelow)
    y, xf = amb(548339, 0.0, 40.0, xf=3.0, lpf=5000)
    return norm_rms(loopify(y, xf), -26)


@out('amb_adhan_far', level=-33, loop=False, stereo=True, q=2)
def _(k):  # evening call to prayer, Colombo (3bagbrew), pushed further away. One-shot, ~75 s
    y = seg(S(345029, 2), 50.0, 125.0)
    y = lp(hp(y, 150, 2), 3500, 2)
    synth('distance processing (low-pass, reverb)')
    h = ir(2.2, 0.03, 3000, seed=120, ch=2)
    y = mix((y, 0.6, 0), (convolve(y, h), 0.6, 0))[:len(y)]
    return norm_rms(fade(y, 3.0, 4.0), -24)


@out('amb_distant_battle', level=-32, loop=True, stereo=True, q=2)
def _(k):  # bombardment with distant explosions (craigsmith) + far river firefight (US Gov video via qubodup)
    bomb, xf = amb(675609, 5.0, 60.0)
    ff = mono(seg(S(162406), 0.0, 30.0))
    ff = distant(ff, lpf=1600, rt60=2.2, wet=0.7, seed=130)
    ff = loopify(ff[:sec(32)], 2.0)                      # 30 s seamless, then tiled
    ff = np.tile(ff, 3)[:len(bomb)]
    y = mix((norm_rms(bomb, -24), 1.0, 0), (stereo_from_mono(norm_rms(ff, -30)), 0.6, 0))
    return norm_rms(loopify(y, xf), -24)


@out('amb_flies', level=-38, loop=True, stereo=True, q=2)
def _(k):  # flies buzzing, wide stereo (TRP)
    y, xf = amb(567732, 20.0, 30.0, xf=3.0, hpf=120)
    return norm_rms(loopify(y, xf), -28)


@out('radio_squelch', n=2, level=-25)
def _(k):  # radio squelch tails (JovianSounds, LukaCafuka)
    i = [524205, 760245][k]
    y = trim_start(mono(S(i)), -35, 2)
    return norm(trim_end(bp(y, 250, 6000), -50, 0.05), -1)


@out('radio_chatter_loop', level=-27, loop=True)
def _(k):  # military radio traffic (US Gov video via qubodup) made unintelligible: 220 ms grains reversed
    x = mono(seg(S(855900), 2.0, 24.0))
    g = sec(0.22); y = x.copy()
    for s in range(0, len(x) - g, g):
        y[s:s + g] = fade(x[s:s + g][::-1], 0.01, 0.01)
    synth('grain reversal, band-limiting, radio distortion and hiss')
    y = bp(y, 380, 2800, 2)
    y = softclip(norm(y, -1) * 2.5, 0.8)
    y = y + 0.02 * bp(noise(len(y) / SR, 140), 500, 5000)
    return norm_rms(loopify(y, 0.5), -20)


# ---------------------------------------------------------------- UI

@out('ui_click', level=-22)
def _(k):  # normal click (Breviceps)
    return norm(trim_start(mono(S(448086)), -35, 1), -1)


@out('ui_select', level=-22)
def _(k):  # UI click (finix473)
    return norm(trim_end(trim_start(mono(S(546974)), -35, 1), -50, 0.05), -1)


@out('tinnitus', level=-24)
def _(k):  # synthesised: ~4 kHz tone with slight wobble and a quieter partial, slow 7 s fade
    synth('tinnitus tone')
    d = 7.0; t = np.arange(sec(d)) / SR
    f = 4100 + 12 * np.sin(2 * np.pi * 0.35 * t)
    y = np.sin(2 * np.pi * np.cumsum(f) / SR) + 0.15 * np.sin(2 * np.pi * np.cumsum(f * 1.5) / SR)
    y += 0.02 * bp(noise(d, 150), 3000, 6000)
    envl = np.minimum(1, t / 0.08) * np.exp(-t / 2.2)
    return norm(fade(y * envl, 0, 0.5), -3)


if __name__ == '__main__':
    args = sys.argv[1:]
    if '--stats' in args:
        stats()
    else:
        build([a for a in args if not a.startswith('-')] or None)

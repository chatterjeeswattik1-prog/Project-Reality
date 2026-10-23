"""MakeHuman (CC0) body, proxies and clothes for tools/blender/characters.py (Blender 4.5, numpy, headless).

Sources (downloaded by hand into tools/blender/src-assets/, gitignored; see public/models/chars/CREDITS.txt):
  src-assets/mpfb2/src/mpfb/data/...      MPFB2 data: hm08 base mesh, targets, game_engine rig + weights (assets CC0)
  src-assets/makehuman/sys/...             MakeHuman system assets CC0 pack: skins, clothes, eyes, eyebrows, hair

Pipeline: base mesh + targets (macro body shape, face variation) -> MakeHuman joint positions -> every vertex is
moved by linear blend skinning from the MakeHuman joints onto OUR skeleton's rest pose (the Quaternius UBC
skeleton that anims.glb uses), so the body ends up exactly on our bones with MakeHuman's realistic proportions
and weights (the game_engine rig uses the same Unreal bone names). Clothes/proxies (.mhclo) are fitted on the
MakeHuman base mesh the MakeHuman way (barycentric + scaled offset), then go through the same mapping.

Coordinates: MakeHuman OBJ is decimetres, Y up, face +Z. Blender here: metres, Z up, face +Y  ->  (-x, z, y) / 10.
"""
import gzip
import json
import math
import os
import re

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MPFB = os.path.join(HERE, 'src-assets', 'mpfb2', 'src', 'mpfb', 'data')
SYS = os.path.join(HERE, 'src-assets', 'makehuman', 'sys')
NBODY = 13380                      # hm08: body vertices come first


def mh2bl(a):
    a = np.asarray(a, np.float64)
    return np.stack([-a[..., 0], a[..., 2], a[..., 1]], -1) * 0.1


def bl2mh_dir(a):
    """Blender direction (metres) -> MakeHuman axes (decimetres)."""
    a = np.asarray(a, np.float64)
    return np.stack([-a[..., 0], a[..., 2], a[..., 1]], -1) * 10.0

# ---------------------------------------------------------------------------------------------- OBJ / targets


def read_obj(path):
    """Minimal OBJ reader. Returns dict(v (N,3), vt (M,2), faces [(vidx tuple, vtidx tuple, group, mtl)])."""
    v, vt, faces = [], [], []
    group, mtl = None, None
    with open(path, encoding='utf-8', errors='replace') as f:
        for line in f:
            if line.startswith('v '):
                v.append([float(x) for x in line.split()[1:4]])
            elif line.startswith('vt '):
                vt.append([float(x) for x in line.split()[1:3]])
            elif line.startswith('f '):
                vi, ti = [], []
                for tok in line.split()[1:]:
                    p = tok.split('/')
                    vi.append(int(p[0]) - 1)
                    ti.append(int(p[1]) - 1 if len(p) > 1 and p[1] else -1)
                faces.append((tuple(vi), tuple(ti), group, mtl))
            elif line.startswith('g '):
                group = line.split(None, 1)[1].strip()
            elif line.startswith('usemtl '):
                mtl = line.split(None, 1)[1].strip()
    return {'v': np.array(v, np.float64), 'vt': np.array(vt, np.float64) if vt else np.zeros((0, 2)), 'faces': faces}


_target_cache = {}


def read_target(name):
    """name relative to MPFB targets dir, without extension, e.g. 'macrodetails/universal-male-young-...'."""
    if name in _target_cache:
        return _target_cache[name]
    path = os.path.join(MPFB, 'targets', name + '.target.gz')
    idx, d = [], []
    with gzip.open(path, 'rt') as f:
        for line in f:
            if not line or line[0] == '#':
                continue
            p = line.split()
            if len(p) == 4:
                idx.append(int(p[0]))
                d.append([float(x) for x in p[1:]])
    r = (np.array(idx, np.int64), np.array(d, np.float64).reshape(-1, 3))
    _target_cache[name] = r
    return r


class Base:
    """The hm08 base mesh with its vertex groups (joint cubes, helpers)."""

    def __init__(self):
        o = read_obj(os.path.join(MPFB, '3dobjs', 'base.obj'))
        self.v0 = o['v']
        self.vt = o['vt']
        self.faces = o['faces']
        self.groups = {}
        for vi, ti, g, m in self.faces:
            self.groups.setdefault(g, set()).update(vi)
        self.groups = {k: np.array(sorted(s)) for k, s in self.groups.items()}
        self.body_faces = [(vi, ti) for vi, ti, g, m in self.faces if g == 'body']
        self.helper_faces = {}
        for vi, ti, g, m in self.faces:
            if g and g.startswith('helper-'):
                self.helper_faces.setdefault(g, []).append((vi, ti))

    def shape(self, targets):
        """targets: {name: weight}. Returns morphed MakeHuman coordinates (N, 3)."""
        v = self.v0.copy()
        for name, w in targets.items():
            if abs(w) < 1e-6:
                continue
            idx, d = read_target(name)
            v[idx] += d * w
        return v


def macro_targets(muscle=0.5, weight=0.5, height=0.5, proportions=0.5, race=(0.0, 0.0, 1.0), age=0.5):
    """MakeHuman macro modifiers for an adult male (gender = 1). muscle/weight/height/proportions in 0..1
    (0.5 = average), race = (african, asian, caucasian) proportions, age 0.5 = 25 years, 1.0 = 90 years.
    Mirrors the weighting of makehuman/apps/humanmodifier.MacroModifier."""
    def split(x, lo, mid, hi):
        if x < 0.5:
            return {lo: 1 - x / 0.5, mid: x / 0.5}
        return {mid: 1 - (x - 0.5) / 0.5, hi: (x - 0.5) / 0.5}
    ages = split(age, 'child', 'young', 'old') if age >= 0.1875 else {'young': 1.0}
    if age >= 0.5:
        ages = {'young': 1 - (age - 0.5) / 0.5, 'old': (age - 0.5) / 0.5}
    mus = split(muscle, 'minmuscle', 'averagemuscle', 'maxmuscle')
    wts = split(weight, 'minweight', 'averageweight', 'maxweight')
    out = {}
    def add(k, w):
        if w > 1e-6:
            out[k] = out.get(k, 0.0) + w
    for a, wa in ages.items():
        for m, wm in mus.items():
            for wt, ww in wts.items():
                add('macrodetails/universal-male-%s-%s-%s' % (a, m, wt), wa * wm * ww)
                hk = 'maxheight' if height >= 0.5 else 'minheight'
                add('macrodetails/height/male-%s-%s-%s-%s' % (a, m, wt, hk), wa * wm * ww * abs(height - 0.5) * 2)
                pk = 'idealproportions' if proportions >= 0.5 else 'uncommonproportions'
                add('macrodetails/proportions/male-%s-%s-%s-%s' % (a, m, wt, pk), wa * wm * ww * abs(proportions - 0.5) * 2)
        for r, wr in zip(('african', 'asian', 'caucasian'), race):
            add('macrodetails/%s-male-%s' % (r, a), wa * wr)
    # drop targets that do not exist in this data set
    return {k: w for k, w in out.items() if os.path.exists(os.path.join(MPFB, 'targets', k + '.target.gz'))}


def modifier(name, value):
    """Two-sided modifier, e.g. modifier('nose/nose-scale-horiz', 0.3) -> {'nose/nose-scale-horiz-incr': 0.3}.
    Names with a '|' list the decr|incr suffixes explicitly: 'head/head-age|decr|incr'."""
    if '|' in name:
        base, lo, hi = name.split('|')
    else:
        base, lo, hi = name, 'decr', 'incr'
    if value >= 0:
        return {'%s-%s' % (base, hi): value}
    return {'%s-%s' % (base, lo): -value}

# ---------------------------------------------------------------------------------------------- rig / weights


def load_rig():
    with open(os.path.join(MPFB, 'rigs', 'standard', 'rig.game_engine.json')) as f:
        return json.load(f)


def load_weights(path=None):
    """{bone: (idx array, w array)} for the base mesh (game_engine rig)."""
    path = path or os.path.join(MPFB, 'rigs', 'standard', 'weights.game_engine.json')
    with open(path) as f:
        w = json.load(f)['weights']
    out = {}
    for b, lst in w.items():
        if lst:
            a = np.array(lst, np.float64)
            out[b] = (a[:, 0].astype(np.int64), a[:, 1])
    return out


def joint_positions(base, coords, rig):
    """MakeHuman bone heads/tails (Blender metres) for morphed MakeHuman coords."""
    def pt(spec):
        if spec['strategy'] == 'CUBE':
            idx = base.groups[spec['cube_name']]
        elif spec['strategy'] in ('MEAN', 'VERTEX'):
            idx = np.array(spec.get('vertex_indices') or [spec['vertex_index']])
        else:
            raise ValueError(spec['strategy'])
        return mh2bl(coords[idx].mean(0))
    return {b: (pt(d['head']), pt(d['tail'])) for b, d in rig.items()}


NAME = {'head': 'Head', 'Root': 'root'}


def our(b):
    return NAME.get(b, b)

# ---------------------------------------------------------------------------------------------- mapping onto our skeleton


def _frame(d, s):
    d = d / np.linalg.norm(d)
    s = s - d * d.dot(s)
    s = s / np.linalg.norm(s)
    return np.stack([d, s, np.cross(d, s)], 1)       # columns


# The "length" of a bone for scaling = distance from its head to this joint (head of the named bone);
# None = rigid (no stretch along the bone).
NEXT = {'pelvis': 'spine_01', 'spine_01': 'spine_02', 'spine_02': 'spine_03', 'spine_03': 'neck_01', 'neck_01': 'head',
        'head': None, 'Root': None}
for _s in 'lr':
    NEXT.update({'clavicle_%s' % _s: 'upperarm_%s' % _s, 'upperarm_%s' % _s: 'lowerarm_%s' % _s,
                 'lowerarm_%s' % _s: 'hand_%s' % _s, 'hand_%s' % _s: 'middle_01_%s' % _s,
                 'thigh_%s' % _s: 'calf_%s' % _s, 'calf_%s' % _s: 'foot_%s' % _s, 'foot_%s' % _s: 'ball_%s' % _s,
                 'ball_%s' % _s: None})
    for _f in ('thumb', 'index', 'middle', 'ring', 'pinky'):
        NEXT['%s_01_%s' % (_f, _s)] = '%s_02_%s' % (_f, _s)
        NEXT['%s_02_%s' % (_f, _s)] = '%s_03_%s' % (_f, _s)
        NEXT['%s_03_%s' % (_f, _s)] = '#tail'


class Mapper:
    """Per-bone similarity-ish transforms (rotation + stretch along the bone) from MakeHuman joints to our rest
    skeleton, blended by skin weights (linear blend skinning)."""

    def __init__(self, mh_joints, rest, radial=None):
        """mh_joints: {mh bone: (head, tail)} Blender metres; rest: {our bone: (head, tail)} Blender metres.
        radial: {mh bone: factor} optional thickness scale perpendicular to the bone."""
        self.T = {}
        radial = radial or {}
        for b, (hm, tm) in mh_joints.items():
            ob = our(b)
            if ob not in rest:
                continue
            ho, to = (np.array(x, np.float64) for x in rest[ob])
            if b == 'Root':
                self.T[b] = (np.eye(3), ho - hm)
                continue
            nxt = NEXT.get(b)
            if nxt == '#tail':
                em, eo = tm, to
            elif nxt:
                em, eo = mh_joints[nxt][0], np.array(rest[our(nxt)][0])
            else:
                em, eo = tm, to
            dm, do = em - hm, eo - ho
            if np.linalg.norm(dm) < 1e-6 or np.linalg.norm(do) < 1e-6:
                dm, do = tm - hm, to - ho
            side = b[-1] if b[-2:] in ('_l', '_r') else None
            if side and any(k in b for k in ('hand', 'thumb', 'index', 'middle', 'ring', 'pinky', 'lowerarm', 'upperarm', 'clavicle')):
                sm = mh_joints['index_01_' + side][0] - mh_joints['pinky_01_' + side][0]
                so = np.array(rest['index_01_' + side][0]) - np.array(rest['pinky_01_' + side][0])
            else:
                sm = so = np.array([1.0, 0, 0])
            if b.startswith(('thigh', 'calf')):
                sm = so = np.array([1.0, 0, 0])
            if b.startswith(('foot', 'ball')):
                sm = so = np.array([1.0, 0, 0])
            Fm, Fo = _frame(dm, sm), _frame(do, so)
            R = Fo @ Fm.T
            s = (np.linalg.norm(do) / np.linalg.norm(dm)) if nxt else 1.0
            u = dm / np.linalg.norm(dm)
            k = radial.get(b, 1.0)
            S = np.eye(3) * k + (s - k) * np.outer(u, u)
            A = R @ S
            self.T[b] = (A, ho - A @ hm)

    def apply(self, pts, W, names):
        """pts (N,3) Blender metres, W (N,B) weights for MakeHuman bone `names`."""
        out = np.zeros_like(pts)
        tot = np.zeros(len(pts))
        for j, b in enumerate(names):
            if b not in self.T:
                continue
            w = W[:, j]
            m = w > 0
            if not m.any():
                continue
            A, t = self.T[b]
            out[m] += w[m, None] * (pts[m] @ A.T + t)
            tot[m] += w[m]
        bad = tot < 1e-6
        out[~bad] /= tot[~bad, None]
        out[bad] = pts[bad]
        return out


def dense_weights(wdict, n, names):
    W = np.zeros((n, len(names)), np.float64)
    for j, b in enumerate(names):
        if b in wdict:
            idx, w = wdict[b]
            m = idx < n
            W[idx[m], j] = w[m]
    s = W.sum(1)
    W[s > 0] /= s[s > 0, None]
    return W

# ---------------------------------------------------------------------------------------------- proxies / clothes


class Clo:
    """A .mhclo / .proxy asset: obj + fitting data."""

    def __init__(self, path):
        self.path = path
        self.dir = os.path.dirname(path)
        self.hdr = {}
        refs, wts, offs = [], [], []
        dele = []
        mode = None
        with open(path, encoding='utf-8', errors='replace') as f:
            for line in f:
                s = line.strip()
                if not s or s.startswith('#'):
                    continue
                if s.startswith('verts'):
                    mode = 'v'
                    continue
                if s.startswith('delete_verts'):
                    mode = 'd'
                    continue
                if mode == 'v':
                    p = s.split()
                    if re.match(r'^-?\d', p[0]) is None:
                        pass                      # header keys may follow 'verts 0'
                    elif len(p) == 1:
                        refs.append((int(p[0]),) * 3)
                        wts.append((1.0, 0.0, 0.0))
                        offs.append((0.0, 0.0, 0.0))
                        continue
                    elif len(p) >= 9:
                        refs.append(tuple(int(x) for x in p[:3]))
                        wts.append(tuple(float(x) for x in p[3:6]))
                        offs.append(tuple(float(x) for x in p[6:9]))
                        continue
                if mode == 'd':
                    toks = s.split()
                    if toks and re.match(r'^\d', toks[0]):
                        i = 0
                        while i < len(toks):
                            if i + 2 < len(toks) and toks[i + 1] == '-':
                                dele.extend(range(int(toks[i]), int(toks[i + 2]) + 1))
                                i += 3
                            else:
                                dele.append(int(toks[i]))
                                i += 1
                        continue
                    mode = None
                p = s.split(None, 1)
                key = p[0]
                val = p[1] if len(p) > 1 else ''
                if key in ('x_scale', 'y_scale', 'z_scale'):
                    a, b, c = val.split()
                    self.hdr[key] = (int(a), int(b), float(c))
                else:
                    self.hdr.setdefault(key, val)
        self.refs = np.array(refs, np.int64)
        self.wts = np.array(wts, np.float64)
        self.offs = np.array(offs, np.float64)
        self.delete = np.array(sorted(set(dele)), np.int64)
        self.obj = read_obj(os.path.join(self.dir, self.hdr['obj_file'].split()[0]))
        self.name = self.hdr.get('name', os.path.splitext(os.path.basename(path))[0])

    def fit(self, coords):
        """Fitted MakeHuman coordinates of the asset's vertices on morphed base coords."""
        c = (coords[self.refs[:, 0]] * self.wts[:, 0, None] + coords[self.refs[:, 1]] * self.wts[:, 1, None] +
             coords[self.refs[:, 2]] * self.wts[:, 2, None])
        sc = np.ones(3)
        for i, k in enumerate(('x_scale', 'y_scale', 'z_scale')):
            if k in self.hdr:
                a, b, den = self.hdr[k]
                sc[i] = abs(coords[a, i] - coords[b, i]) / den
        return c + self.offs * sc

    def weights(self, Wbase):
        return (Wbase[self.refs[:, 0]] * self.wts[:, 0, None] + Wbase[self.refs[:, 1]] * self.wts[:, 1, None] +
                Wbase[self.refs[:, 2]] * self.wts[:, 2, None])

    def material(self):
        """{'diffuse': path, 'normal': path, 'ao': path, ...} from the .mhmat next to it."""
        m = self.hdr.get('material')
        path = os.path.join(self.dir, m) if m else None
        if not path or not os.path.exists(path):
            cands = [x for x in os.listdir(self.dir) if x.endswith('.mhmat')]
            path = os.path.join(self.dir, cands[0]) if cands else None
        return read_mhmat(path) if path else {}


def read_mhmat(path):
    out = {}
    d = os.path.dirname(path)
    with open(path, encoding='utf-8', errors='replace') as f:
        for line in f:
            p = line.split()
            if len(p) >= 2 and p[0] in ('diffuseTexture', 'normalmapTexture', 'aomapTexture', 'bumpmapTexture', 'specularmapTexture'):
                q = os.path.join(d, os.path.basename(p[1]))
                if os.path.exists(q):
                    out[p[0].replace('Texture', '').replace('map', '')] = q
    return out


def asset(kind, name):
    """Path of a system asset: asset('clothes', 'male_worksuit01') -> .../male_worksuit01.mhclo"""
    d = os.path.join(SYS, kind, name)
    for ext in ('.mhclo', '.proxy'):
        for f in os.listdir(d):
            if f.endswith(ext):
                return os.path.join(d, f)
    raise FileNotFoundError(d)

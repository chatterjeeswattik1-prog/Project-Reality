"""Helpers for the props kit (tools/blender/props.py): procedural numpy textures packed into a few atlas pages,
a light-weight mesh builder that writes one mesh per prop (one material slot per atlas page), preview sheets
and export statistics. Blender is Z up, +Y forward, metres.

Atlas pages: opaque pages carry a base colour image (JPEG) and a half-size metallic-roughness image (G = roughness,
B = metal); 'cutout' pages are RGBA PNGs on a double-sided alpha-clipped material (also used for thin cloth so it
renders from both sides). Every prop therefore costs one or two draw calls, and props of one block can be merged."""
import math, os, random, tempfile, zlib
import numpy as np
import bpy, bmesh
from mathutils import Vector, Matrix, Euler

# ------------------------------------------------------------------------------------------------ numpy painting
def resize(a, h, w):
    """Bilinear resize of a 2D (or HxWxC) array."""
    H, W = a.shape[:2]
    ys = np.linspace(0, H - 1, h); xs = np.linspace(0, W - 1, w)
    y0 = np.floor(ys).astype(int); x0 = np.floor(xs).astype(int)
    y1 = np.minimum(y0 + 1, H - 1); x1 = np.minimum(x0 + 1, W - 1)
    fy = (ys - y0)[:, None]; fx = (xs - x0)[None, :]
    if a.ndim == 3:
        fy = fy[..., None]; fx = fx[..., None]
    top = a[y0][:, x0] * (1 - fx) + a[y0][:, x1] * fx
    bot = a[y1][:, x0] * (1 - fx) + a[y1][:, x1] * fx
    return top * (1 - fy) + bot * fy

def fbm(h, w, rng, scale=32.0, octaves=4, persist=0.5, aspect=1.0):
    """Value-noise fBm in 0..1, feature size ~scale px (aspect stretches features along x)."""
    out = np.zeros((h, w)); amp = 1.0; tot = 0.0
    for o in range(octaves):
        s = scale / (2 ** o)
        gh = max(2, int(h / s) + 2); gw = max(2, int(w / (s * aspect)) + 2)
        g = rng.random((gh, gw))
        out += amp * resize(g, h, w); tot += amp; amp *= persist
    out /= tot
    lo, hi = np.percentile(out, 1), np.percentile(out, 99)
    return np.clip((out - lo) / max(1e-6, hi - lo), 0, 1)

def speckle(h, w, rng, density=0.02):
    return (rng.random((h, w)) < density).astype(float)

def col(rgb, h, w):
    return np.ones((h, w, 3)) * np.array(rgb, float)

def mix(a, b, t):
    t = np.asarray(t, float)
    if t.ndim == 2 and np.ndim(a) == 3:
        t = t[..., None]
    return a * (1 - t) + b * t

def _bb(x0, x1, y0, y1, W, H):
    return max(0, int(math.floor(x0))), min(W, int(math.ceil(x1)) + 1), max(0, int(math.floor(y0))), min(H, int(math.ceil(y1)) + 1)

def seg(rgb, a, p0, p1, r0, r1, c, alpha=1.0, shade=0.0, mode='over'):
    """Anti-aliased tapered segment p0->p1 (pixel coords, y up) radii r0..r1 painted with colour c into rgb (HxWx3)
    and coverage into a (HxW) - either may be None. shade darkens towards the edges (rounded look)."""
    H, W = (rgb if rgb is not None else a).shape[:2]
    rr = max(r0, r1) + 1.5
    xa, xb, ya, yb = _bb(min(p0[0], p1[0]) - rr, max(p0[0], p1[0]) + rr, min(p0[1], p1[1]) - rr, max(p0[1], p1[1]) + rr, W, H)
    if xa >= xb or ya >= yb:
        return
    ys, xs = np.mgrid[ya:yb, xa:xb]
    xs = xs + 0.5; ys = ys + 0.5
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    L2 = dx * dx + dy * dy + 1e-9
    t = np.clip(((xs - p0[0]) * dx + (ys - p0[1]) * dy) / L2, 0, 1)
    px = p0[0] + t * dx; py = p0[1] + t * dy
    d = np.hypot(xs - px, ys - py)
    r = r0 + (r1 - r0) * t
    cov = np.clip(r - d + 0.5, 0, 1) * alpha
    if rgb is not None:
        cc = np.array(c, float)[None, None, :] * (1 - shade * np.clip(d / np.maximum(r, 0.3), 0, 1) ** 2)[..., None]
        sub = rgb[ya:yb, xa:xb]
        rgb[ya:yb, xa:xb] = sub * (1 - cov[..., None]) + cc * cov[..., None]
    if a is not None:
        sa = a[ya:yb, xa:xb]
        a[ya:yb, xa:xb] = sa + cov * (1 - sa)

def polyline(rgb, a, pts, r0, r1, c, alpha=1.0, shade=0.0):
    n = len(pts) - 1
    for i in range(n):
        seg(rgb, a, pts[i], pts[i + 1], r0 + (r1 - r0) * i / n, r0 + (r1 - r0) * (i + 1) / n, c, alpha, shade)

def disc(rgb, a, c0, r, c, alpha=1.0, shade=0.0, hl=0.0):
    """Filled AA disc; shade darkens the rim, hl adds a highlight offset up-left (fruit, rivets)."""
    H, W = (rgb if rgb is not None else a).shape[:2]
    xa, xb, ya, yb = _bb(c0[0] - r - 1, c0[0] + r + 1, c0[1] - r - 1, c0[1] + r + 1, W, H)
    if xa >= xb or ya >= yb:
        return
    ys, xs = np.mgrid[ya:yb, xa:xb]
    d = np.hypot(xs + 0.5 - c0[0], ys + 0.5 - c0[1])
    cov = np.clip(r - d + 0.5, 0, 1) * alpha
    if rgb is not None:
        k = 1 - shade * np.clip(d / max(r, 0.5), 0, 1) ** 2
        if hl:
            dh = np.hypot(xs + 0.5 - (c0[0] - r * 0.35), ys + 0.5 - (c0[1] + r * 0.35))
            k = k + hl * np.clip(1 - dh / (r * 0.45), 0, 1)
        cc = np.clip(np.array(c, float)[None, None, :] * k[..., None], 0, 1)
        rgb[ya:yb, xa:xb] = rgb[ya:yb, xa:xb] * (1 - cov[..., None]) + cc * cov[..., None]
    if a is not None:
        sa = a[ya:yb, xa:xb]
        a[ya:yb, xa:xb] = sa + cov * (1 - sa)

def fill_poly(rgb, a, pts, c, alpha=1.0, ss=2):
    """Even-odd polygon fill with ss x ss supersampling."""
    H, W = (rgb if rgb is not None else a).shape[:2]
    P = np.array(pts, float)
    xa, xb, ya, yb = _bb(P[:, 0].min(), P[:, 0].max(), P[:, 1].min(), P[:, 1].max(), W, H)
    if xa >= xb or ya >= yb:
        return
    cov = np.zeros((yb - ya, xb - xa))
    for sy in range(ss):
        for sx in range(ss):
            ys, xs = np.mgrid[ya:yb, xa:xb]
            X = xs + (sx + 0.5) / ss; Y = ys + (sy + 0.5) / ss
            inside = np.zeros(X.shape, bool)
            n = len(P)
            for i in range(n):
                x1, y1 = P[i]; x2, y2 = P[(i + 1) % n]
                cond = ((y1 > Y) != (y2 > Y))
                xint = (x2 - x1) * (Y - y1) / ((y2 - y1) + 1e-12) + x1
                inside ^= cond & (X < xint)
            cov += inside
    cov = cov / (ss * ss) * alpha
    if rgb is not None:
        rgb[ya:yb, xa:xb] = rgb[ya:yb, xa:xb] * (1 - cov[..., None]) + np.array(c, float) * cov[..., None]
    if a is not None:
        sa = a[ya:yb, xa:xb]
        a[ya:yb, xa:xb] = sa + cov * (1 - sa)

def rect(rgb, x0, y0, x1, y1, c, alpha=1.0):
    H, W = rgb.shape[:2]
    xa, xb, ya, yb = max(0, int(x0)), min(W, int(x1)), max(0, int(y0)), min(H, int(y1))
    if xa < xb and ya < yb:
        rgb[ya:yb, xa:xb] = rgb[ya:yb, xa:xb] * (1 - alpha) + np.array(c, float) * alpha

def script_strokes(rgb, x0, y0, x1, y1, c, rng, thick=2.0):
    """Abstract Arabic-like calligraphy: a baseline with flowing loops, vertical alef-like strokes and dots
    (no real words)."""
    w = x1 - x0; h = y1 - y0
    base = y0 + h * 0.35
    x = x0 + w * 0.03
    while x < x1 - w * 0.05:
        wl = rng.uniform(0.08, 0.2) * w
        n = rng.randint(6, 14)
        pts = []
        for i in range(n + 1):
            t = i / n
            px = x + wl * t
            py = base + math.sin(t * math.pi * rng.uniform(1, 3)) * h * 0.08 * rng.random()
            pts.append((px, py))
        polyline(rgb, None, pts, thick, thick * 0.8, c)
        for _ in range(rng.randint(1, 3)):          # tall strokes
            sx = x + rng.uniform(0, wl)
            seg(rgb, None, (sx, base), (sx + rng.uniform(-1, 1) * h * 0.05, base + h * rng.uniform(0.3, 0.5)), thick, thick * 0.6, c)
        if rng.random() < 0.6:                       # descending tail loop
            sx = x + wl
            pts = [(sx - h * 0.15 * math.cos(a), base - h * 0.15 * math.sin(a)) for a in np.linspace(0, math.pi * 1.2, 7)]
            polyline(rgb, None, pts, thick * 0.9, thick * 0.5, c)
        for _ in range(rng.randint(0, 3)):           # dots
            disc(rgb, None, (x + rng.uniform(0, wl), base + h * rng.choice((-0.2, 0.25, 0.3))), thick * 1.1, c)
        x += wl + rng.uniform(0.02, 0.06) * w

def stencil_glyphs(rgb, x0, y0, h, n, c, rng, thick=None, alpha=1.0):
    """Blocky stencil 'letters' (Cyrillic/ Latin-ish shapes built from bars, no real words). Returns the end x."""
    thick = thick or max(1.0, h * 0.13)
    x = x0
    for _ in range(n):
        w = h * rng.uniform(0.45, 0.7)
        kind = rng.randrange(9)
        L = [(0, 0, 0, 1)]
        if kind == 0: L += [(0, 1, 1, 1), (1, 1, 1, 0)]                    # П
        elif kind == 1: L += [(0, 0, 1, 1), (1, 1, 1, 0)]                  # И
        elif kind == 2: L = [(0.5, 0, 0.5, 1), (0, 1, 1, 1)]               # Т
        elif kind == 3: L += [(0, 1, 1, 1), (0, 0.5, 0.8, 0.5), (0, 0, 1, 0)]  # Е
        elif kind == 4: L += [(1, 0, 1, 1), (0, 0.5, 1, 0.5)]              # Н
        elif kind == 5: L += [(0, 1, 1, 1), (1, 1, 1, 0.5), (1, 0.5, 0, 0.5)]  # Р
        elif kind == 6: L = [(0, 0, 0, 1), (0, 0, 1, 0), (1, 0, 1, 1), (1, 1, 0, 1)]  # О
        elif kind == 7: L = [(0, 0, 0.5, 1), (0.5, 1, 1, 0), (0.25, 0.45, 0.75, 0.45)]  # Л/A
        else: L = [(0, 1, 1, 0), (0, 0, 1, 1)]                              # Х
        for (ax, ay, bx, by) in L:
            seg(rgb, None, (x + ax * w, y0 + ay * h), (x + bx * w, y0 + by * h), thick / 2, thick / 2, c, alpha)
        x += w + h * 0.3
    return x

# ------------------------------------------------------------------------------------------------ atlas
class Cell:
    __slots__ = ('name', 'group', 'w', 'h', 'painter', 'rect', 'page', 'cutout')
    def __init__(self, name, group, w, h, painter, cutout):
        self.name, self.group, self.w, self.h, self.painter, self.cutout = name, group, w, h, painter, cutout
        self.rect = None; self.page = None
    def uv(self, u, v):
        x0, y0, x1, y1 = self.rect
        return (x0 + (x1 - x0) * u, y0 + (y1 - y0) * v)

class Atlas:
    """Collect texture cells per group, then pack each group into 1024 px pages."""
    PAD = 4
    def __init__(self, size=1024, seed=1):
        self.size = size
        self.cells = {}          # key -> Cell ; swatches are keyed 'name@group'
        self.swatches = {}       # name -> painter
        self.groups = {}         # group -> cutout flag
        self.pages = {}          # page name -> dict(material, cutout)
        self.seed = seed

    def group(self, name, cutout=False):
        self.groups[name] = cutout

    def cell(self, name, group, w, h, painter):
        self.cells[name] = Cell(name, group, w, h, painter, self.groups[group])
        return self.cells[name]

    def swatch(self, name, rgb, rough=0.7, metal=0.0, var=0.06, scale=6, dirt=0.0):
        """Small solid-colour cell (with a little noise) copied into every opaque group."""
        def p(w, h, rng):
            n = fbm(h, w, rng, scale, 3)
            c = col(rgb, h, w) * (1 + (n[..., None] - 0.5) * var * 2)
            if dirt:
                c = mix(c, c * 0.75, np.clip(fbm(h, w, rng, scale * 2, 2) - 0.5, 0, 1) * dirt * 2)
            return dict(rgb=c, rough=rough, metal=metal)
        self.swatches[name] = p

    def shared(self, name, groups, w, h, painter):
        """Same painter registered in several groups (looked up per prop group, like the swatches)."""
        for g in groups:
            self.cells[name + '@' + g] = Cell(name + '@' + g, g, w, h, painter, self.groups[g])

    def get(self, name, group):
        c = self.cells.get(name + '@' + group)
        if c is not None:
            return c
        c = self.cells.get(name)
        if c is None:
            raise KeyError(f'no texture cell {name!r} (group {group})')
        return c

    def pack(self, tmpdir):
        for g, cut in self.groups.items():
            if not cut:
                for n, p in self.swatches.items():
                    self.cells[n + '@' + g] = Cell(n + '@' + g, g, 24, 24, p, False)
        by_group = {}
        for c in self.cells.values():
            by_group.setdefault(c.group, []).append(c)
        S, P = self.size, self.PAD
        for g, cells in by_group.items():
            cells.sort(key=lambda c: (-(c.w if c.w > S // 2 else 0), -c.h, -c.w))   # full-width strips first
            pages = []                       # each: list of (cell, x, y)
            skylines = []                    # per page: list of [x, y, w] segments
            def fit(sk, cw, ch):
                best = None
                for i in range(len(sk)):
                    x = sk[i][0]
                    if x + cw > S:
                        break
                    y = 0; wl = cw; j = i
                    while wl > 0:
                        y = max(y, sk[j][1]); wl -= sk[j][2]; j += 1
                        if wl > 0 and j >= len(sk):
                            y = None; break
                    if y is None or y + ch > S:
                        continue
                    if best is None or (y, x) < (best[1], best[0]):
                        best = (x, y, i)
                return best
            def place(c):
                cw, ch = c.w + 2 * P, c.h + 2 * P
                for pi, sk in enumerate(skylines):
                    b = fit(sk, cw, ch)
                    if b:
                        break
                else:
                    skylines.append([[0, 0, S]]); pages.append([]); pi = len(pages) - 1; sk = skylines[-1]
                    b = fit(sk, cw, ch)
                x, y, i = b
                pages[pi].append((c, x, y))
                # update the skyline: insert the new segment, trim the ones it covers
                new = [x, y + ch, cw]
                out = []
                for seg_ in sk:
                    sx, sy, sw = seg_
                    if sx + sw <= x or sx >= x + cw:
                        out.append(seg_)
                    else:
                        if sx < x:
                            out.append([sx, sy, x - sx])
                        if sx + sw > x + cw:
                            out.append([x + cw, sy, sx + sw - (x + cw)])
                out.append(new)
                out.sort(key=lambda q: q[0])
                merged = []
                for q in out:
                    if merged and merged[-1][1] == q[1] and merged[-1][0] + merged[-1][2] == q[0]:
                        merged[-1][2] += q[2]
                    else:
                        merged.append(q)
                sk[:] = merged
            for c in cells:
                place(c)
            for pi, items in enumerate(pages):
                pname = f'props_{g}' + (f'_{pi}' if pi else '')
                self._render_page(pname, items, self.groups[g], tmpdir)
                used = sum((c.w + 2 * P) * (c.h + 2 * P) for c, _, _ in items)
                print(f'ATLAS {pname}: {len(items)} cells, {100 * used / S / S:.0f}% used')

    def _render_page(self, pname, items, cutout, tmpdir):
        S, P = self.size, self.PAD
        rgba = np.zeros((S, S, 4)); rgba[..., 3] = 0 if cutout else 1
        rgba[..., :3] = 0.5
        rough = np.full((S, S), 0.8); metal = np.zeros((S, S))
        for c, x, y in items:
            rng = np.random.default_rng(zlib.crc32(c.name.encode()) ^ self.seed)
            r = c.painter(c.w, c.h, rng)
            rgb = np.clip(np.asarray(r['rgb'], float), 0, 1)
            a = r.get('a', None)
            a = np.ones((c.h, c.w)) if a is None else np.clip(a, 0, 1)
            ro = np.broadcast_to(np.asarray(r.get('rough', 0.8), float), (c.h, c.w))
            me = np.broadcast_to(np.asarray(r.get('metal', 0.0), float), (c.h, c.w))
            if cutout:
                # Bleed colour into transparent texels so mip-mapped edges don't go dark.
                rgb = _bleed(rgb, a)
            def put(dst, src):
                padw = ((P, P), (P, P)) + ((0, 0),) * (src.ndim - 2)
                dst[y:y + c.h + 2 * P, x:x + c.w + 2 * P] = np.pad(src, padw, mode='edge')
            put(rgba[..., :3], rgb)
            put(rgba[..., 3], a if cutout else np.ones((c.h, c.w)))
            put(rough, np.array(ro)); put(metal, np.array(me))
            c.rect = ((x + P) / S, (y + P) / S, (x + P + c.w) / S, (y + P + c.h) / S)
            c.page = pname
        if cutout:
            path = os.path.join(tmpdir, pname + '.png')
            base = _save_image(pname, rgba, path, 'PNG', srgb=True, alpha=True)
            orm = None
        else:
            base = _save_image(pname, rgba, os.path.join(tmpdir, pname + '.jpg'), 'JPEG', srgb=True)
            h2 = S // 2
            r2 = rough.reshape(h2, 2, h2, 2).mean(axis=(1, 3)); m2 = metal.reshape(h2, 2, h2, 2).mean(axis=(1, 3))
            orm_a = np.ones((h2, h2, 4)); orm_a[..., 1] = r2; orm_a[..., 2] = m2
            orm = _save_image(pname + '_mr', orm_a, os.path.join(tmpdir, pname + '_mr.jpg'), 'JPEG', srgb=False)
        self.pages[pname] = dict(material=page_material(pname, base, orm, cutout), cutout=cutout)

def _bleed(rgb, a, iters=6):
    rgb = rgb.copy(); w = (a > 0.05).astype(float)
    acc = rgb * w[..., None]
    for _ in range(iters):
        k = np.zeros_like(w); s = np.zeros_like(rgb)
        for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            k += np.roll(w, (dy, dx), (0, 1)); s += np.roll(acc, (dy, dx), (0, 1))
        new = (w == 0) & (k > 0)
        acc[new] = s[new] / k[new][:, None]; w[new] = 1
    acc[w == 0] = rgb[w == 0]
    return acc

def _save_image(name, rgba, path, fmt, srgb=True, alpha=False):
    h, w = rgba.shape[:2]
    im = bpy.data.images.new(name, w, h, alpha=alpha)
    im.pixels.foreach_set(np.ascontiguousarray(rgba, np.float32).ravel())
    im.filepath_raw = path
    im.file_format = fmt
    im.save(filepath=path, quality=90)
    bpy.data.images.remove(im)
    im = bpy.data.images.load(path)
    im.name = name
    if not srgb:
        im.colorspace_settings.name = 'Non-Color'
    return im

def page_material(name, base, orm, cutout):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree; b = nt.nodes['Principled BSDF']
    t = nt.nodes.new('ShaderNodeTexImage'); t.image = base; t.location = (-600, 200)
    nt.links.new(t.outputs['Color'], b.inputs['Base Color'])
    if orm is not None:
        t2 = nt.nodes.new('ShaderNodeTexImage'); t2.image = orm; t2.location = (-600, -150)
        sp = nt.nodes.new('ShaderNodeSeparateColor'); sp.location = (-300, -150)
        nt.links.new(t2.outputs['Color'], sp.inputs['Color'])
        nt.links.new(sp.outputs['Green'], b.inputs['Roughness'])
        nt.links.new(sp.outputs['Blue'], b.inputs['Metallic'])
        m.use_backface_culling = True
    else:
        b.inputs['Roughness'].default_value = 0.85
        rnd = nt.nodes.new('ShaderNodeMath'); rnd.operation = 'ROUND'; rnd.location = (-300, 0)
        nt.links.new(t.outputs['Alpha'], rnd.inputs[0])
        nt.links.new(rnd.outputs[0], b.inputs['Alpha'])
        try:
            m.blend_method = 'CLIP'
        except Exception:
            pass
        m.use_backface_culling = False
    return m

# ------------------------------------------------------------------------------------------------ transforms
def T(loc=(0, 0, 0), rot=(0, 0, 0), scale=1.0):
    """Matrix from location, XYZ Euler rotation in degrees and uniform or (x, y, z) scale."""
    s = (scale, scale, scale) if isinstance(scale, (int, float)) else scale
    return Matrix.Translation(Vector(loc)) @ Euler([math.radians(a) for a in rot]).to_matrix().to_4x4() @ Matrix.Diagonal((*s, 1))

def look(frm, to, up=(0, 0, 1)):
    """Matrix placing local +Z along frm->to (for posts, braces), origin at frm, with local Z length unchanged."""
    d = Vector(to) - Vector(frm)
    q = d.to_track_quat('Z', 'Y')
    return Matrix.Translation(Vector(frm)) @ q.to_matrix().to_4x4()

# ------------------------------------------------------------------------------------------------ mesh builder
class MB:
    """Accumulates polygons for one prop. Every polygon has its own UVs mapped into an atlas cell; the material is
    the cell's page. Coordinates are object space (Z up, +Y forward, origin at the base centre)."""
    def __init__(self, atlas, group):
        self.A = atlas; self.group = group
        self.V = []; self.F = []

    def c(self, name):
        return self.A.get(name, self.group) if isinstance(name, str) else name

    def _v(self, p):
        self.V.append((p[0], p[1], p[2])); return len(self.V) - 1

    def poly(self, pts, uvs, cell, smooth=False, M=None):
        cell = self.c(cell)
        if M is not None:
            pts = [M @ Vector(p) for p in pts]
        ids = [self._v(p) for p in pts]
        self.F.append((ids, [cell.uv(min(1, max(0, u)), min(1, max(0, v))) for u, v in uvs], cell.page, smooth))

    def quad(self, p0, p1, p2, p3, cell, uv=(0, 0, 1, 1), M=None, smooth=False):
        u0, v0, u1, v1 = uv
        self.poly([p0, p1, p2, p3], [(u0, v0), (u1, v0), (u1, v1), (u0, v1)], cell, smooth, M)

    def surf(self, P, cell, closed=False, urep=1, vrep=1, smooth=True, M=None, uv=(0, 0, 1, 1), flip=False, s=None, t=None):
        """Quad grid from P[i][j] (i along u, j along v). closed wraps u. Texture repeats urep x vrep times over the
        surface (faces never straddle a repeat when the segment counts are multiples). s/t give custom u/v params."""
        cell = self.c(cell)
        ni = len(P); nj = len(P[0])
        if M is not None:
            P = [[M @ Vector(p) for p in row] for row in P]
        ids = []
        for i in range(ni):
            row = []
            for j in range(nj):
                row.append(self._v(P[i][j]))
            ids.append(row)
        # collapse poles (rows j where all i share a position) to a single vertex
        for j in range(nj):
            p0 = Vector(P[0][j])
            if all((Vector(P[i][j]) - p0).length < 1e-7 for i in range(ni)):
                for i in range(ni):
                    ids[i][j] = ids[0][j]
        nu = ni if closed else ni - 1
        S = s or [i / nu for i in range(nu + 1)]
        Tt = t or [j / (nj - 1) for j in range(nj)]
        u0, v0, u1, v1 = uv
        for i in range(nu):
            i2 = (i + 1) % ni
            for j in range(nj - 1):
                a, b, cc, d = ids[i][j], ids[i2][j], ids[i2][j + 1], ids[i][j + 1]
                ss = (S[i], S[i + 1]); tt = (Tt[j], Tt[j + 1])
                ku = math.floor(ss[0] * urep + 1e-6); kv = math.floor(tt[0] * vrep + 1e-6)
                def m(sv, tv):
                    lu = sv * urep - ku; lv = tv * vrep - kv
                    return cell.uv(min(1, max(0, u0 + (u1 - u0) * lu)), min(1, max(0, v0 + (v1 - v0) * lv)))
                q = [(a, m(ss[0], tt[0])), (b, m(ss[1], tt[0])), (cc, m(ss[1], tt[1])), (d, m(ss[0], tt[1]))]
                if flip:
                    q = q[::-1]
                # drop repeated vertices (poles)
                out = []
                for vi, uvv in q:
                    if not out or out[-1][0] != vi:
                        out.append((vi, uvv))
                if len(out) > 1 and out[0][0] == out[-1][0]:
                    out.pop()
                if len(out) >= 3:
                    self.F.append(([o[0] for o in out], [o[1] for o in out], cell.page, smooth))

    def lathe(self, prof, segs, cell, M=None, urep=1, vrep=1, smooth=True, cap0=False, cap1=False, capcell=None,
              a0=0.0, arc=360.0, uv=(0, 0, 1, 1), sx=1.0, sy=1.0, rfun=None):
        """Surface of revolution about Z: prof = [(r, z), ...] bottom to top, (r, z, 'S') marks a hard edge.
        rfun(angle, j) -> radial multiplier (dents, lumps). sx/sy squash the section into an ellipse."""
        closed = abs(arc - 360) < 1e-6
        n = segs if closed else segs + 1
        angs = [math.radians(a0 + arc * i / segs) for i in range(n)]
        L = [0.0]
        for k in range(1, len(prof)):
            L.append(L[-1] + math.hypot(prof[k][0] - prof[k - 1][0], prof[k][1] - prof[k - 1][1]))
        tt = [l / max(1e-9, L[-1]) for l in L]
        parts = []; cur = [0]
        for k in range(1, len(prof)):
            cur.append(k)
            if len(prof[k]) > 2 and prof[k][2] == 'S' and k < len(prof) - 1:
                parts.append(cur); cur = [k]
        parts.append(cur)
        for part in parts:
            P = []
            for i, a in enumerate(angs):
                row = []
                for k in part:
                    r = prof[k][0] * (rfun(a, k) if rfun else 1.0)
                    row.append((math.cos(a) * r * sx, math.sin(a) * r * sy, prof[k][1]))
                P.append(row)
            self.surf(P, cell, closed, urep, vrep, smooth, M, uv, t=[tt[k] for k in part])
        for which, on in ((0, cap0), (-1, cap1)):
            if not on or prof[which][0] < 1e-6:
                continue
            r, z = prof[which][0], prof[which][1]
            pts = [(math.cos(a) * r * sx, math.sin(a) * r * sy, z) for a in angs[:segs]]
            uvs = [(0.5 + 0.5 * math.cos(a), 0.5 + 0.5 * math.sin(a)) for a in angs[:segs]]
            if which == 0:
                pts = pts[::-1]; uvs = uvs[::-1]
            self.poly(pts, uvs, capcell or cell, False, M)

    def cyl(self, r, h, cell, M=None, segs=12, r2=None, cap0=True, cap1=True, urep=1, vrep=1, smooth=True, capcell=None, uv=(0, 0, 1, 1)):
        self.lathe([(r, 0), (r if r2 is None else r2, h)], segs, cell, M, urep, vrep, smooth, cap0, cap1, capcell, uv=uv)

    def bar(self, p0, p1, r, cell, segs=6, r2=None, caps=True, uv=(0, 0, 1, 1), urep=1, vrep=1, smooth=True):
        """Round bar/post from p0 to p1."""
        p0 = Vector(p0); p1 = Vector(p1)
        self.cyl(r, (p1 - p0).length, cell, look(p0, p1), segs, r2, caps, caps, urep, vrep, smooth, uv=uv)

    def beam(self, p0, p1, w, h, cell, uvscale=None, roll=0.0):
        """Rectangular timber/steel section from p0 to p1 (w across, h 'up')."""
        p0 = Vector(p0); p1 = Vector(p1); L = (p1 - p0).length
        d = (p1 - p0).normalized()
        up = Vector((0, 0, 1)) if abs(d.z) < 0.95 else Vector((0, 1, 0))
        x = d.cross(up).normalized(); z = x.cross(d).normalized()
        if roll:
            x, z = x * math.cos(roll) + z * math.sin(roll), z * math.cos(roll) - x * math.sin(roll)
        M = Matrix((x, d, z)).transposed().to_4x4(); M.translation = (p0 + p1) / 2
        self.box((w, L, h), cell, M, uvscale=uvscale)

    def box(self, size, cell, M=None, uvscale=None, loc=None, rot=None, faces='xyzXYZ', uv=(0, 0, 1, 1)):
        """Axis box centred at the origin of M (or loc/rot). uvscale (metres per cell) keeps texel density instead
        of stretching the cell on each face. faces: which faces to emit (x=-X, X=+X ...)."""
        if M is None:
            M = T(loc or (0, 0, 0), rot or (0, 0, 0))
        sx, sy, sz = size[0] / 2, size[1] / 2, size[2] / 2
        P = lambda x, y, z: (x * sx, y * sy, z * sz)
        F = {'x': ([P(-1, 1, -1), P(-1, -1, -1), P(-1, -1, 1), P(-1, 1, 1)], size[1], size[2]),
             'X': ([P(1, -1, -1), P(1, 1, -1), P(1, 1, 1), P(1, -1, 1)], size[1], size[2]),
             'y': ([P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1)], size[0], size[2]),
             'Y': ([P(1, 1, -1), P(-1, 1, -1), P(-1, 1, 1), P(1, 1, 1)], size[0], size[2]),
             'z': ([P(-1, 1, -1), P(1, 1, -1), P(1, -1, -1), P(-1, -1, -1)], size[0], size[1]),
             'Z': ([P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1)], size[0], size[1])}
        u0, v0, u1, v1 = uv
        for k in faces:
            pts, a, b = F[k]
            if uvscale:
                ua, vb = min(1, a / uvscale), min(1, b / uvscale)
                r = (u0, v0, u0 + (u1 - u0) * ua, v0 + (v1 - v0) * vb)
            else:
                r = uv
            self.quad(*pts, cell, r, M)

    def tube(self, pts, radii, cell, sides=6, closed=False, caps=False, smooth=True, urep=1, vrep=1, uv=(0, 0, 1, 1), twist=0.0, flat=None):
        """Sweep a circle (or a polygon) along a polyline with parallel-transport frames. radii: float or list.
        flat=(sx, sy) squashes the section."""
        pts = [Vector(p) for p in pts]
        n = len(pts)
        rs = radii if isinstance(radii, (list, tuple)) else [radii] * n
        tans = []
        for i in range(n):
            a = pts[max(0, i - 1)]; b = pts[min(n - 1, i + 1)]
            tans.append((b - a).normalized())
        ref = Vector((0, 0, 1)) if abs(tans[0].z) < 0.9 else Vector((1, 0, 0))
        nrm = tans[0].cross(ref).normalized()
        frames = []
        for i in range(n):
            if i:
                nrm = nrm - tans[i] * nrm.dot(tans[i])
                if nrm.length < 1e-6:
                    nrm = tans[i].orthogonal()
                nrm.normalize()
            frames.append((nrm.copy(), tans[i].cross(nrm).normalized()))
        fx, fy = flat or (1, 1)
        P = []
        for k in range(sides):
            a = 2 * math.pi * k / sides
            row = []
            for i in range(n):
                nn, bb = frames[i]
                aa = a + twist * i / max(1, n - 1)
                row.append(pts[i] + (nn * math.cos(aa) * fx + bb * math.sin(aa) * fy) * rs[i])
            P.append(row)
        L = [0.0]
        for i in range(1, n):
            L.append(L[-1] + (pts[i] - pts[i - 1]).length)
        self.surf(P, cell, True, urep, vrep, smooth, None, uv, t=[l / max(1e-9, L[-1]) for l in L])
        if caps:
            for i, sgn in ((0, -1), (n - 1, 1)):
                ring = [P[k][i] for k in range(sides)]
                if sgn < 0:
                    ring = ring[::-1]
                self.poly(ring, [(0.5 + 0.5 * math.cos(2 * math.pi * k / sides), 0.5 + 0.5 * math.sin(2 * math.pi * k / sides)) for k in range(sides)][::(-1 if sgn < 0 else 1)], cell)

    def ribbon(self, left, right, cell, uv=(0, 0, 1, 1), urep=1, s=None, smooth=True):
        """Strip between two polylines (u along the polylines, v from left to right)."""
        P = [[left[i], right[i]] for i in range(len(left))]
        self.surf(P, cell, False, urep, 1, smooth, None, uv, s=s)

    def sphere(self, r, cell, M=None, segs=10, rings=6, scale=(1, 1, 1), smooth=True, rfun=None, urep=1, z0=-90, z1=90):
        prof = [(r * math.cos(math.radians(z0 + (z1 - z0) * k / rings)), r * math.sin(math.radians(z0 + (z1 - z0) * k / rings))) for k in range(rings + 1)]
        S = Matrix.Diagonal((*scale, 1))
        self.lathe(prof, segs, cell, (M or Matrix()) @ S, urep=urep, smooth=smooth, rfun=rfun, cap0=z0 > -90, cap1=z1 < 90)

    def prism(self, outline, depth, cell, M=None, capcell=None, uvscale=None, smooth=False, bottom=True):
        """Extrude a 2D outline (x, y CCW) up by depth along local Z."""
        from mathutils.geometry import tessellate_polygon
        n = len(outline)
        per = 0.0; acc = [0.0]
        for i in range(n):
            a = outline[i]; b = outline[(i + 1) % n]
            per += math.hypot(b[0] - a[0], b[1] - a[1]); acc.append(per)
        for i in range(n):
            a = outline[i]; b = outline[(i + 1) % n]
            ua, ub = acc[i] / per, acc[i + 1] / per
            if uvscale:
                ua, ub = 0, min(1, math.hypot(b[0] - a[0], b[1] - a[1]) / uvscale)
            vv = min(1, depth / uvscale) if uvscale else 1
            self.quad((a[0], a[1], 0), (b[0], b[1], 0), (b[0], b[1], depth), (a[0], a[1], depth), cell, (ua, 0, ub, vv), M, smooth)
        xs = [p[0] for p in outline]; ys = [p[1] for p in outline]
        mnx, mny = min(xs), min(ys); w = max(1e-6, max(xs) - mnx); h = max(1e-6, max(ys) - mny)
        tris = tessellate_polygon([[Vector((p[0], p[1], 0)) for p in outline]])
        cc = capcell or cell
        for tri in tris:
            for z, order in ((depth, tri), (0, tri[::-1])):
                if z == 0 and not bottom:
                    continue
                pts = [(outline[k][0], outline[k][1], z) for k in order]
                # tessellate_polygon output winding is not guaranteed: fix it per triangle
                (x1, y1, _), (x2, y2, _), (x3, y3, _) = pts
                cross = (x2 - x1) * (y3 - y1) - (y2 - y1) * (x3 - x1)
                if (cross < 0) == (z > 0):
                    pts = pts[::-1]
                self.poly(pts, [((p[0] - mnx) / w, (p[1] - mny) / h) for p in pts], cc, False, M)

    def side(self, profile, width, cell, M=None, capcell=None, uvscale=None):
        """Extrude a (y, z) side profile across X, centred on x = 0 (barriers, T-walls)."""
        R = Matrix(((0, 0, 1, -width / 2), (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
        self.prism(profile, width, cell, (M or Matrix()) @ R, capcell, uvscale)

    def chamfer_box(self, size, bev, cell, M=None, jitter=0.0, rng=None, bulge=0.0):
        """Box with chamfered edges (44 triangles): sandbags, blocks, crates. jitter randomises vertices,
        bulge pushes the face centres out (pillow) by scaling the inset ring."""
        sx, sy, sz = size[0] / 2, size[1] / 2, size[2] / 2
        b = bev
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1.0)
        for v in bm.verts:
            v.co = Vector((v.co.x * 2 * sx, v.co.y * 2 * sy, v.co.z * 2 * sz))
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=b, segments=1, affect='EDGES', profile=0.5)
        if jitter and rng is not None:
            for v in bm.verts:
                v.co += Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1))) * jitter
        self.add_bm(bm, cell, M, smooth=True)
        bm.free()

    def add_bm(self, bm, cell, M=None, smooth=False, uvmode='box', bounds=None):
        """Append a bmesh with box-projected UVs (each axis fitted to the bounds)."""
        cell = self.c(cell)
        cos = [v.co.copy() for v in bm.verts]
        if bounds is None:
            mn = Vector((min(c.x for c in cos), min(c.y for c in cos), min(c.z for c in cos)))
            mx = Vector((max(c.x for c in cos), max(c.y for c in cos), max(c.z for c in cos)))
        else:
            mn, mx = Vector(bounds[0]), Vector(bounds[1])
        ext = mx - mn
        ext = Vector((max(ext.x, 1e-6), max(ext.y, 1e-6), max(ext.z, 1e-6)))
        bm.verts.index_update()
        base = len(self.V)
        for c in cos:
            self._v(M @ c if M is not None else c)
        for f in bm.faces:
            n = f.normal
            ax = max(range(3), key=lambda k: abs(n[k]))
            uvs = []
            for v in f.verts:
                c = (v.co - mn)
                if uvmode == 'top' or ax == 2:
                    uvs.append(cell.uv(c.x / ext.x, c.y / ext.y))
                elif ax == 0:
                    uvs.append(cell.uv(c.y / ext.y, c.z / ext.z))
                else:
                    uvs.append(cell.uv(c.x / ext.x, c.z / ext.z))
            self.F.append(([base + v.index for v in f.verts], uvs, cell.page, smooth))

    def merge(self, other, M=None):
        base = len(self.V)
        for p in other.V:
            self._v(M @ Vector(p) if M is not None else p)
        for ids, uvs, page, sm in other.F:
            self.F.append(([base + i for i in ids], list(uvs), page, sm))

    def transform(self, M, start=0):
        for i in range(start, len(self.V)):
            self.V[i] = tuple(M @ Vector(self.V[i]))

    def deform(self, fn, start=0):
        for i in range(start, len(self.V)):
            self.V[i] = tuple(fn(Vector(self.V[i])))

    def tris(self):
        return sum(len(f[0]) - 2 for f in self.F)

    def build(self, name, atlas=None):
        """Create the mesh object (one material slot per atlas page used)."""
        A = atlas or self.A
        pages = []
        for f in self.F:
            if f[2] not in pages:
                pages.append(f[2])
        me = bpy.data.meshes.new(name)
        me.from_pydata(self.V, [], [f[0] for f in self.F])
        uvl = me.uv_layers.new(name='UVMap')
        li = 0
        for pi, f in enumerate(self.F):
            for k in range(len(f[0])):
                uvl.data[li + k].uv = f[1][k]
            li += len(f[0])
        mi = [pages.index(f[2]) for f in self.F]
        me.polygons.foreach_set('material_index', mi)
        me.polygons.foreach_set('use_smooth', [bool(f[3]) for f in self.F])
        for p in pages:
            me.materials.append(A.pages[p]['material'])
        me.validate(clean_customdata=False)
        me.update()
        o = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(o)
        return o

def empty_at(name, loc, parent):
    o = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(o)
    o.empty_display_size = 0.2
    o.location = loc
    o.parent = parent
    return o

# ------------------------------------------------------------------------------------------------ stats / preview
def tri_count(o):
    n = 0
    for x in [o] + list(o.children_recursive):
        if x.type == 'MESH':
            n += sum(len(p.vertices) - 2 for p in x.data.polygons)
    return n

def bounds(o):
    pts = []
    for x in [o] + list(o.children_recursive):
        if x.type == 'MESH':
            mw = x.matrix_world
            pts += [mw @ v.co for v in x.data.vertices]
    if not pts:
        return Vector((0, 0, 0)), Vector((0, 0, 0))
    mn = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    mx = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return mn, mx

def setup_preview_scene():
    s = bpy.context.scene
    s.render.engine = 'CYCLES'; s.cycles.device = 'CPU'; s.cycles.samples = 12; s.cycles.use_denoising = True
    s.cycles.max_bounces = 3; s.cycles.transparent_max_bounces = 10
    s.view_settings.view_transform = 'AgX'
    s.view_settings.exposure = -0.6
    s.render.resolution_x, s.render.resolution_y = 960, 540
    s.render.image_settings.file_format = 'PNG'; s.render.image_settings.color_mode = 'RGB'
    w = bpy.data.worlds.new('pw'); s.world = w; w.use_nodes = True
    sky = w.node_tree.nodes.new('ShaderNodeTexSky')
    try:
        sky.sky_type = 'NISHITA'; sky.sun_elevation = math.radians(55); sky.sun_rotation = math.radians(140)
        sky.sun_disc = False
    except Exception:
        pass
    w.node_tree.links.new(sky.outputs['Color'], w.node_tree.nodes['Background'].inputs['Color'])
    w.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.35
    sun = bpy.data.lights.new('pv_sun', 'SUN'); sun.energy = 3.6; sun.angle = math.radians(1.0)
    sun.color = (1.0, 0.95, 0.86)
    so = bpy.data.objects.new('pv_sun', sun); s.collection.objects.link(so)
    so.rotation_euler = (math.radians(38), math.radians(0), math.radians(140 - 180 + 25))
    bpy.ops.mesh.primitive_plane_add(size=400, location=(0, 0, 0)); g = bpy.context.object; g.name = 'pv_ground'
    gm = bpy.data.materials.new('pv_ground'); gm.use_nodes = True
    gb = gm.node_tree.nodes['Principled BSDF']; gb.inputs['Base Color'].default_value = (0.42, 0.34, 0.24, 1); gb.inputs['Roughness'].default_value = 1
    g.data.materials.append(gm)
    cam = bpy.data.cameras.new('pv_cam'); co = bpy.data.objects.new('pv_cam', cam); s.collection.objects.link(co); s.camera = co
    return co

def preview_sheet(roots, path, lens=40, az=-28, el=14, gap=1.0, rows=1, target_z=None, dist_mul=1.0, all_roots=()):
    """Lay the given root objects in rows along X, frame them, render, restore."""
    s = bpy.context.scene
    co = bpy.data.objects.get('pv_cam') or setup_preview_scene()
    co.data.lens = lens
    for o in all_roots:
        hide = o not in roots
        for x in [o] + list(o.children_recursive):
            x.hide_render = hide
    per_row = math.ceil(len(roots) / rows)
    saved = {o: o.location.copy() for o in roots}
    y = 0.0; maxx = 0; maxz = 0; rowy = []
    for r in range(rows):
        row = roots[r * per_row:(r + 1) * per_row]
        dims = [bounds(o) for o in row]
        width = sum((mx.x - mn.x) for mn, mx in dims) + gap * (len(row) - 1)
        x = -width / 2; depth = max([mx.y - mn.y for mn, mx in dims] + [1])
        for o, (mn, mx) in zip(row, dims):
            o.location = (x - mn.x, y, 0)
            x += (mx.x - mn.x) + gap
            maxz = max(maxz, mx.z)
        maxx = max(maxx, width)
        rowy.append(y)
        y -= depth + gap * 2
    bpy.context.view_layer.update()
    span_y = abs(y)
    tz = target_z if target_z is not None else maxz * 0.4
    t = Vector((0, -span_y * 0.35, tz))
    fov = 2 * math.atan(36 / 2 / lens)
    dist = max(maxx * 0.62, maxz * 1.0 * 16 / 9 * 0.62) / math.tan(fov / 2) * dist_mul + span_y * 0.3
    a, e = math.radians(az), math.radians(el)
    co.location = t + Vector((math.sin(a) * math.cos(e), math.cos(a) * math.cos(e), math.sin(e))) * dist
    co.rotation_euler = (t - co.location).to_track_quat('-Z', 'Y').to_euler()
    co.data.clip_end = dist * 4
    s.render.filepath = path
    bpy.ops.render.render(write_still=True)
    for o, l in saved.items():
        o.location = l
    for o in all_roots:
        for x in [o] + list(o.children_recursive):
            x.hide_render = False
    print('PREVIEW', path)

def preview_cam(roots, path, loc, target, lens=40, all_roots=(), places=None):
    """Explicit camera render with optional per-root placements {root: (x, y, rotz_deg)}."""
    s = bpy.context.scene
    co = bpy.data.objects.get('pv_cam') or setup_preview_scene()
    co.data.lens = lens
    for o in all_roots:
        for x in [o] + list(o.children_recursive):
            x.hide_render = o not in roots
    saved = {o: (o.location.copy(), o.rotation_euler.copy()) for o in roots}
    for o, pl in (places or {}).items():
        x, y, rz = pl[:3]
        o.location = (x, y, pl[3] if len(pl) > 3 else 0); o.rotation_euler = (0, 0, math.radians(rz))
    co.location = loc
    co.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
    co.data.clip_end = 1000
    s.render.filepath = path
    bpy.ops.render.render(write_still=True)
    for o, (l, r) in saved.items():
        o.location = l; o.rotation_euler = r
    for o in all_roots:
        for x in [o] + list(o.children_recursive):
            x.hide_render = False
    print('PREVIEW', path)

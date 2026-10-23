"""Texture-space baking in numpy (no Cycles): rasterize a mesh's UV layout and interpolate per-corner attributes
(rest position, normal, source UV, ...) into every texel, so textures can be computed procedurally from 3D
position (camouflage continuous over seams, folds, wear by height) or resampled from source textures.

Image arrays here are (H, W, C) float32 with row 0 = v = 0 (bottom row, Blender's pixel order).
"""
import math
import os

import numpy as np

try:
    import bpy
except ImportError:          # usable from plain Python for tests
    bpy = None

# ---------------------------------------------------------------------------------------------- mesh -> corners


def mesh_corners(o, uv_name=None, extra_uv=None, world=True):
    """Triangulated corner data of a Blender mesh object (rest shape, no modifiers).
    Returns dict: uv (L,2) target UVs, P (L,3) positions, N (L,3) normals, tri (T,3) corner index triples,
    face (T,) polygon index, and 'uv_<name>' for each extra uv layer."""
    me = o.data
    me.calc_loop_triangles()
    nl = len(me.loops)
    uvl = me.uv_layers[uv_name] if uv_name else me.uv_layers.active
    uv = np.empty(nl * 2, np.float32)
    uvl.data.foreach_get('uv', uv)
    vi = np.empty(nl, np.int64)
    me.loops.foreach_get('vertex_index', vi)
    co = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    vn = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get('normal', vn)
    vn = vn.reshape(-1, 3)
    if world:
        mw = np.array(o.matrix_world)
        co = co @ mw[:3, :3].T + mw[:3, 3]
        vn = vn @ mw[:3, :3].T
    tri = np.empty(len(me.loop_triangles) * 3, np.int64)
    me.loop_triangles.foreach_get('loops', tri)
    face = np.empty(len(me.loop_triangles), np.int64)
    me.loop_triangles.foreach_get('polygon_index', face)
    out = {'uv': uv.reshape(-1, 2), 'P': co[vi], 'N': vn[vi], 'tri': tri.reshape(-1, 3), 'face': face, 'vi': vi}
    for name in (extra_uv or []):
        a = np.empty(nl * 2, np.float32)
        me.uv_layers[name].data.foreach_get('uv', a)
        out['uv_' + name] = a.reshape(-1, 2)
    return out

# ---------------------------------------------------------------------------------------------- rasterizer


def raster(uv, tri, attrs, res, tri_mask=None):
    """Rasterize triangles (corner indices `tri`) at target `uv` into a res x res grid.
    attrs: {name: (L, k) per-corner arrays}. Returns (mask (res,res) bool, tid (res,res) int, {name: (res,res,k)})."""
    H = W = res
    mask = np.zeros((H, W), bool)
    tid = np.full((H, W), -1, np.int64)
    out = {k: np.zeros((H, W, a.shape[1]), np.float32) for k, a in attrs.items()}
    U = uv * np.array([W, H]) - 0.5
    for t in range(len(tri)):
        if tri_mask is not None and not tri_mask[t]:
            continue
        a, b, c = tri[t]
        pa, pb, pc = U[a], U[b], U[c]
        x0 = max(int(math.floor(min(pa[0], pb[0], pc[0]))), 0)
        x1 = min(int(math.ceil(max(pa[0], pb[0], pc[0]))), W - 1)
        y0 = max(int(math.floor(min(pa[1], pb[1], pc[1]))), 0)
        y1 = min(int(math.ceil(max(pa[1], pb[1], pc[1]))), H - 1)
        if x1 < x0 or y1 < y0:
            continue
        den = (pb[1] - pc[1]) * (pa[0] - pc[0]) + (pc[0] - pb[0]) * (pa[1] - pc[1])
        if abs(den) < 1e-12:
            continue
        xs, ys = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
        w0 = ((pb[1] - pc[1]) * (xs - pc[0]) + (pc[0] - pb[0]) * (ys - pc[1])) / den
        w1 = ((pc[1] - pa[1]) * (xs - pc[0]) + (pa[0] - pc[0]) * (ys - pc[1])) / den
        w2 = 1 - w0 - w1
        e = -1e-3
        inside = (w0 >= e) & (w1 >= e) & (w2 >= e)
        if not inside.any():
            continue
        yy, xx = ys[inside], xs[inside]
        w0, w1, w2 = w0[inside], w1[inside], w2[inside]
        mask[yy, xx] = True
        tid[yy, xx] = t
        for k, arr in attrs.items():
            out[k][yy, xx] = w0[:, None] * arr[a] + w1[:, None] * arr[b] + w2[:, None] * arr[c]
    return mask, tid, out


def dilate(img, mask, iters=8):
    """Grow image content outside the mask (avoids dark seams with mipmapping)."""
    img = img.copy()
    m = mask.copy()
    for _ in range(iters):
        acc = np.zeros_like(img)
        cnt = np.zeros(m.shape, np.float32)
        for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0), (1, 1), (-1, -1), (1, -1), (-1, 1)):
            mm = np.roll(np.roll(m, dy, 0), dx, 1)
            ii = np.roll(np.roll(img, dy, 0), dx, 1)
            acc += ii * mm[..., None]
            cnt += mm
        grow = (~m) & (cnt > 0)
        img[grow] = acc[grow] / cnt[grow][:, None]
        m = m | grow
    # whatever is still empty: the mean colour
    if (~m).any() and m.any():
        img[~m] = img[m].mean(0)
    return img

# ---------------------------------------------------------------------------------------------- sampling, noise


def sample(img, uv, wrap=True):
    """Bilinear sample of img (H,W,C, row 0 = v 0) at uv (...,2)."""
    H, W = img.shape[:2]
    x = uv[..., 0] * W - 0.5
    y = uv[..., 1] * H - 0.5
    x0 = np.floor(x).astype(np.int64)
    y0 = np.floor(y).astype(np.int64)
    fx = (x - x0)[..., None]
    fy = (y - y0)[..., None]
    def g(yy, xx):
        if wrap:
            return img[yy % H, xx % W]
        return img[np.clip(yy, 0, H - 1), np.clip(xx, 0, W - 1)]
    return ((g(y0, x0) * (1 - fx) + g(y0, x0 + 1) * fx) * (1 - fy) +
            (g(y0 + 1, x0) * (1 - fx) + g(y0 + 1, x0 + 1) * fx) * fy)


def _hash3(i, j, k, seed):
    h = (i * 73856093) ^ (j * 19349663) ^ (k * 83492791) ^ (seed * 2654435761)
    h = (h ^ (h >> 13)) * 1274126177
    h = h ^ (h >> 16)
    return (h & 0xFFFFFF).astype(np.float64) / float(0xFFFFFF)


def vnoise(P, scale, seed=0):
    """Smooth 3D value noise in 0..1 at points P (...,3) with feature size `scale` metres."""
    p = np.asarray(P, np.float64) / scale
    i = np.floor(p).astype(np.int64)
    f = p - i
    u = f * f * (3 - 2 * f)
    out = 0
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                h = _hash3(i[..., 0] + dx, i[..., 1] + dy, i[..., 2] + dz, seed)
                w = ((u[..., 0] if dx else 1 - u[..., 0]) * (u[..., 1] if dy else 1 - u[..., 1]) *
                     (u[..., 2] if dz else 1 - u[..., 2]))
                out = out + h * w
    return out


def fbm(P, scale, octaves=4, seed=0, gain=0.5):
    s, a, tot, out = scale, 1.0, 0.0, 0.0
    for o in range(octaves):
        out = out + a * vnoise(P, s, seed + o * 17)
        tot += a
        s *= 0.5
        a *= gain
    return out / tot


def blur(img, r=1):
    out = img.copy()
    for ax in (0, 1):
        acc = np.zeros_like(out)
        for d in range(-r, r + 1):
            acc += np.roll(out, d, ax)
        out = acc / (2 * r + 1)
    return out


def height_to_normal(h, strength, mask=None):
    """Tangent-space normal map (OpenGL / glTF convention, +Y = +v) from a height map (H,W)."""
    dx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 0.5
    dy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * 0.5
    n = np.stack([-dx * strength, -dy * strength, np.ones_like(h)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n


def combine_normals(a, b):
    """Whiteout blend of two tangent-space normals (unit vectors, (...,3))."""
    n = np.stack([a[..., 0] + b[..., 0], a[..., 1] + b[..., 1], a[..., 2] * b[..., 2]], -1)
    return n / np.linalg.norm(n, axis=-1, keepdims=True)


def n2rgb(n):
    return n * 0.5 + 0.5


def rgb2n(c):
    n = c[..., :3] * 2 - 1
    return n / np.maximum(np.linalg.norm(n, axis=-1, keepdims=True), 1e-6)

# ---------------------------------------------------------------------------------------------- images


def load(path, size=None):
    """Image file -> float32 (H,W,4) array, row 0 = bottom (Blender order)."""
    im = bpy.data.images.load(path)
    if size and (im.size[0] != size or im.size[1] != size):
        im.scale(size, size)
    w, h = im.size
    a = np.empty(w * h * 4, np.float32)
    im.pixels.foreach_get(a)
    bpy.data.images.remove(im)
    return a.reshape(h, w, 4)


def to_image(name, arr, path, non_color=False):
    """float array (H,W,3|4) row 0 = bottom -> saved file (format by extension) loaded as a Blender image."""
    h, w = arr.shape[:2]
    if arr.shape[2] == 3:
        arr = np.concatenate([arr, np.ones((h, w, 1), np.float32)], 2)
    arr = np.clip(arr, 0, 1).astype(np.float32)
    old = bpy.data.images.get(name)
    if old:
        bpy.data.images.remove(old)
    im = bpy.data.images.new(name, w, h, alpha=path.lower().endswith('.png'))
    if non_color:
        im.colorspace_settings.name = 'Non-Color'
    im.pixels.foreach_set(arr.ravel())
    im.filepath_raw = path
    im.file_format = 'JPEG' if path.lower().endswith('.jpg') else 'PNG'
    bpy.context.scene.render.image_settings.quality = 90
    im.save()
    bpy.data.images.remove(im)
    im = bpy.data.images.load(path)
    im.name = name
    if non_color:
        im.colorspace_settings.name = 'Non-Color'
    return im


def srgb2lin(c):
    c = np.asarray(c, np.float64)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin2srgb(c):
    c = np.clip(np.asarray(c, np.float64), 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)

# ---------------------------------------------------------------------------------------------- UV atlas packing


def _islands(me, polys, uv):
    """Connected UV islands among the polygon indices `polys` (shared vertex + same UV)."""
    parent = {p: p for p in polys}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    seen = {}
    for p in polys:
        poly = me.polygons[p]
        for li in poly.loop_indices:
            k = (me.loops[li].vertex_index, round(float(uv[li, 0]) * 2e4), round(float(uv[li, 1]) * 2e4))
            q = seen.get(k)
            if q is None:
                seen[k] = p
            else:
                a, b = find(p), find(q)
                if a != b:
                    parent[a] = b
    groups = {}
    for p in polys:
        groups.setdefault(find(p), []).append(p)
    return list(groups.values())


def pack_atlas(items, res=1024, margin_px=4, src_layer='src'):
    """Jointly pack the UV islands of several (object, polygon mask, importance per polygon or scalar) into a new
    0..1 layout on each object's active UV layer, scaling every island uniformly (no rotation, so tangent-space
    normal maps stay valid) so that texel density follows world area x importance. The previous UVs are kept in
    a layer named `src_layer` for resampling. Returns the list of (object, polygon index array)."""
    isl = []          # (obj, polys, uv bbox (u0,v0,u1,v1), scale)
    for o, mask, imp in items:
        me = o.data
        if src_layer not in me.uv_layers:
            src = me.uv_layers.new(name=src_layer)
            a = np.empty(len(me.loops) * 2, np.float32)
            me.uv_layers[0].data.foreach_get('uv', a)
            src.data.foreach_set('uv', a)
        uvl = me.uv_layers[0]
        uv = np.empty(len(me.loops) * 2, np.float32)
        uvl.data.foreach_get('uv', uv)
        uv = uv.reshape(-1, 2)
        polys = [int(i) for i in np.nonzero(mask)[0]]
        co = np.empty(len(me.vertices) * 3, np.float32)
        me.vertices.foreach_get('co', co)
        co = co.reshape(-1, 3)
        impa = np.broadcast_to(np.asarray(imp, np.float64), (len(me.polygons),))
        for g in _islands(me, polys, uv):
            lis = [li for p in g for li in me.polygons[p].loop_indices]
            u = uv[lis]
            aw = sum(me.polygons[p].area for p in g)
            au = 0.0
            for p in g:
                L = list(me.polygons[p].loop_indices)
                q = uv[L]
                au += 0.5 * abs(np.dot(q[:, 0], np.roll(q[:, 1], -1)) - np.dot(q[:, 1], np.roll(q[:, 0], -1)))
            s = math.sqrt(max(aw, 1e-10) / max(au, 1e-10)) * float(max(impa[p] for p in g))
            isl.append((o, g, (u[:, 0].min(), u[:, 1].min(), u[:, 0].max(), u[:, 1].max()), s, uv))
    m = margin_px / res
    sizes = [((b[2] - b[0]) * s, (b[3] - b[1]) * s) for o, g, b, s, uv in isl]
    order = sorted(range(len(isl)), key=lambda i: -sizes[i][1])

    def place(k):
        """Skyline bottom-left packing in a unit square (None if it does not fit)."""
        cols = res
        sky = np.zeros(cols)
        pos = {}
        for i in order:
            w, h = sizes[i][0] * k + 2 * m, sizes[i][1] * k + 2 * m
            wc = max(int(math.ceil(w * cols)), 1)
            if wc > cols:
                return None
            win = np.lib.stride_tricks.sliding_window_view(sky, wc).max(1)
            x = int(win.argmin())
            y = float(win[x])
            if y + h > 1:
                return None
            sky[x:x + wc] = y + h
            pos[i] = (x / cols + m, y + m)
        return pos
    lo, hi = 0.0, 1.0
    while place(hi) is not None:
        hi *= 2
    for _ in range(40):
        mid = (lo + hi) / 2
        if place(mid) is None:
            hi = mid
        else:
            lo = mid
    pos = place(lo)
    new = {}
    for i, (o, g, b, s, uv) in enumerate(isl):
        if o.name not in new:
            new[o.name] = uv.copy()
        nu = new[o.name]
        px, py = pos[i]
        k = s * lo
        for p in g:
            for li in o.data.polygons[p].loop_indices:
                nu[li] = ((uv[li, 0] - b[0]) * k + px, (uv[li, 1] - b[1]) * k + py)
    out = []
    for o, mask, imp in items:
        o.data.uv_layers[0].data.foreach_set('uv', new[o.name].ravel())
        out.append((o, np.nonzero(mask)[0]))
    return out

"""Blender side of the MakeHuman-based characters (see mhcommon.py): builds skinned body / clothes / proxy meshes on
our armature. Used by tools/blender/characters.py."""
import os

import bpy
import bmesh
import numpy as np
from mathutils import Vector
from mathutils.kdtree import KDTree

import mhcommon as M

_base = None
_rig = None
_wd = None


def base():
    global _base, _rig, _wd
    if _base is None:
        _base = M.Base()
        _rig = M.load_rig()
        _wd = M.load_weights()
    return _base, _rig, _wd


def rest_of(arm):
    mw = arm.matrix_world
    return {b.name: (np.array(mw @ b.head_local), np.array(mw @ b.tail_local)) for b in arm.data.bones}


class Human:
    """A morphed MakeHuman body mapped onto `arm`'s rest skeleton."""

    def __init__(self, arm, targets, radial=None):
        b, rig, wd = base()
        self.arm = arm
        self.coords = b.shape(targets)
        self.names = list(rig.keys())
        self.W = M.dense_weights(wd, len(self.coords), self.names)
        self.J = M.joint_positions(b, self.coords, rig)
        self.mapper = M.Mapper(self.J, rest_of(arm), radial)
        self.P = self.mapper.apply(M.mh2bl(self.coords), self.W, self.names)

    def body(self, name='body', hide=None, mat=None):
        """Body mesh object (MakeHuman 'body' group). hide: base vertex indices whose faces are dropped."""
        b = base()[0]
        faces = b.body_faces
        if hide is not None and len(hide):
            h = np.zeros(len(self.P), bool)
            h[hide] = True
            faces = [(vi, ti) for vi, ti in faces if not all(h[v] for v in vi)]
        return make_mesh(name, self.P, faces, b.vt, self.W, self.names, mat, self.arm)

    def clo(self, clo, name=None, mat=None, push=0.0):
        """Fit a Clo (clothes/proxy) on this body. push: extra offset (m) along vertex normals after mapping."""
        c = clo.fit(self.coords)
        Wc = clo.weights(self.W)
        P = self.mapper.apply(M.mh2bl(c), Wc, self.names)
        faces = [(vi, ti) for vi, ti, g, m in clo.obj['faces']]
        o = make_mesh(name or clo.name, P, faces, clo.obj['vt'], Wc, self.names, mat, self.arm)
        if push:
            for v in o.data.vertices:
                v.co += v.normal * push
        return o


def make_mesh(name, P, faces, vt, W, names, mat, arm):
    used = sorted({v for vi, ti in faces for v in vi})
    remap = {v: i for i, v in enumerate(used)}
    me = bpy.data.meshes.new(name)
    verts = [tuple(P[v]) for v in used]
    polys = [[remap[v] for v in vi] for vi, ti in faces]
    me.from_pydata(verts, [], polys)
    me.update()
    if len(vt):
        uv = me.uv_layers.new(name='UVMap')
        k = 0
        for (vi, ti), p in zip(faces, me.polygons):
            for j, li in enumerate(p.loop_indices):
                t = ti[j]
                uv.data[li].uv = tuple(vt[t]) if t >= 0 else (0.0, 0.0)
    for p in me.polygons:
        p.use_smooth = True
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    if mat is not None:
        me.materials.append(mat)
    # vertex groups (our bone names), at most 4 influences per vertex
    Wu = W[used]
    groups = {}
    for i in range(len(used)):
        row = Wu[i]
        top = np.argsort(row)[::-1][:4]
        tot = row[top].sum()
        if tot <= 0:
            continue
        for j in top:
            if row[j] <= 1e-4:
                continue
            bn = M.our(names[j])
            if bn not in arm.data.bones:
                continue
            g = groups.get(bn) or o.vertex_groups.new(name=bn)
            groups[bn] = g
            g.add([i], float(row[j] / tot), 'REPLACE')
    o.parent = arm
    m = o.modifiers.new('Armature', 'ARMATURE')
    m.object = arm
    return o


def load_image(path, size=1024, name=None, non_color=False):
    im = bpy.data.images.load(path)
    if name:
        im.name = name
    if size and max(im.size) > size:
        im.scale(size, size)
    if non_color:
        im.colorspace_settings.name = 'Non-Color'
    return im

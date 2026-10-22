"""Shared helpers for the PARASHURAMA Blender build scripts (Blender 4.x, run headless:
    blender -b --factory-startup --python tools/blender/guns.py -- <out_dir>
Units are metres. Blender is Z-up with +Y forward; the glTF exporter turns that into +Y up with -Z forward,
which is what the web app expects (barrels along -Z)."""
import math
import bpy
import bmesh
from mathutils import Vector

def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    s = bpy.context.scene
    s.unit_settings.system = 'METRIC'
    return s

_mats = {}
def mat(name, rgb, rough=0.6, metal=0.0, emit=None):
    """Principled material (exports cleanly to glTF metallic-roughness)."""
    if name in _mats:
        return _mats[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*rgb, 1)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    if emit:
        b.inputs['Emission Color'].default_value = (*emit, 1)
        b.inputs['Emission Strength'].default_value = 1.0
    _mats[name] = m
    return m

def clear_mats():
    _mats.clear()

def _finish(o, m, parent, bevel, smooth, name):
    if name:
        o.name = name
    if m:
        o.data.materials.append(m)
    if bevel:
        mod = o.modifiers.new('bevel', 'BEVEL')
        mod.width = bevel
        mod.segments = 2
        mod.limit_method = 'ANGLE'
        mod.angle_limit = math.radians(35)
        mod.harden_normals = False
    if smooth:
        for p in o.data.polygons:
            p.use_smooth = True
        try:
            bpy.context.view_layer.objects.active = o
            bpy.ops.object.shade_smooth_by_angle(angle=math.radians(40))
        except Exception:
            pass
    if parent is not None:
        attach(o, parent)
    return o

def attach(o, parent):
    """Parent keeping the world transform (parts are modelled in world coordinates)."""
    bpy.context.view_layer.update()
    o.parent = parent
    o.matrix_parent_inverse = parent.matrix_world.inverted()

def box(size, loc=(0, 0, 0), m=None, parent=None, rot=(0, 0, 0), bevel=0.01, name=None):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=[math.radians(a) for a in rot])
    o = bpy.context.object
    o.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return _finish(o, m, parent, bevel, True, name)

def cyl(r, depth, loc=(0, 0, 0), m=None, parent=None, rot=(0, 0, 0), verts=24, r2=None, bevel=0.0, name=None):
    """Cylinder (or cone when r2 is given) along local Z, rotated by rot (degrees)."""
    if r2 is None:
        bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=depth, vertices=verts, location=loc, rotation=[math.radians(a) for a in rot])
    else:
        bpy.ops.mesh.primitive_cone_add(radius1=r, radius2=r2, depth=depth, vertices=verts, location=loc, rotation=[math.radians(a) for a in rot])
    return _finish(bpy.context.object, m, parent, bevel, True, name)

def tube_y(r, length, y0, x=0, z=0, m=None, parent=None, r2=None, verts=24, bevel=0.0, name=None):
    """A barrel-like cylinder running forwards along +Y from y0."""
    return cyl(r, length, (x, y0 + length / 2, z), m, parent, (-90, 0, 0), verts, r2, bevel, name)

def torus(R, r, loc=(0, 0, 0), m=None, parent=None, rot=(0, 0, 0), name=None):
    bpy.ops.mesh.primitive_torus_add(major_radius=R, minor_radius=r, location=loc, rotation=[math.radians(a) for a in rot], major_segments=32, minor_segments=12)
    return _finish(bpy.context.object, m, parent, 0, True, name)

def sphere(r, loc=(0, 0, 0), m=None, parent=None, scale=(1, 1, 1), name=None):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, location=loc, segments=20, ring_count=12)
    o = bpy.context.object
    o.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return _finish(o, m, parent, 0, True, name)

def empty(name, loc=(0, 0, 0), parent=None):
    o = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(o)
    o.location = loc
    if parent is not None:
        attach(o, parent)
    return o

def wheel(r, w, loc, parent=None, axis='X', tyre=None, hub=None, spokes=0):
    """Road wheel: tyre (torus-ish cylinder with rounded edge) and hub, axle along X by default."""
    rot = (0, 90, 0) if axis == 'X' else (90, 0, 0)
    t = cyl(r, w, loc, tyre, parent, rot, 32, bevel=w * 0.3)
    cyl(r * 0.62, w * 1.04, loc, hub, parent, rot, 24, bevel=0.01)
    cyl(r * 0.18, w * 1.2, loc, hub, parent, rot, 16, bevel=0.005)
    return t

def prism(points, depth, m=None, parent=None, loc=(0, 0, 0), bevel=0.01, name=None):
    """Extrude a 2D outline (x, y pairs in the XY plane) up by depth along Z."""
    me = bpy.data.meshes.new(name or 'prism')
    bm = bmesh.new()
    vs = [bm.verts.new((x, y, 0)) for x, y in points]
    f = bm.faces.new(vs)
    r = bmesh.ops.extrude_face_region(bm, geom=[f])
    for v in [e for e in r['geom'] if isinstance(e, bmesh.types.BMVert)]:
        v.co.z += depth
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name or 'prism', me)
    bpy.context.scene.collection.objects.link(o)
    o.location = loc
    return _finish(o, m, parent, bevel, True, None)

def side_prism(profile, width, m=None, parent=None, x=0, bevel=0.01, name=None):
    """Extrude a side profile given as (y, z) points across X (centred on x): for hulls, turrets, housings."""
    o = prism([(y, z) for y, z in profile], width, m, None, (0, 0, 0), 0, name)
    # Profile was built in XY with depth on Z: rotate so (y, z) are forward/up and the extrusion runs along X.
    o.rotation_euler = (math.radians(90), 0, math.radians(90))
    bpy.context.view_layer.objects.active = o
    o.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    o.location = (x - width / 2, 0, 0)
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)
    o.select_set(False)
    if bevel:
        mod = o.modifiers.new('bevel', 'BEVEL'); mod.width = bevel; mod.segments = 2; mod.limit_method = 'ANGLE'; mod.angle_limit = math.radians(35)
    for p in o.data.polygons:
        p.use_smooth = True
    if parent is not None:
        attach(o, parent)
    return o

def export(path, root_names):
    """Apply modifiers and export the named roots (with children) as one GLB."""
    bpy.ops.object.select_all(action='DESELECT')
    def sel(o):
        o.select_set(True)
        for c in o.children:
            sel(c)
    for n in root_names:
        sel(bpy.data.objects[n])
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=True, export_yup=True,
                              export_extras=True, export_cameras=False, export_lights=False, export_materials='EXPORT')

def preview(path, target=(0, 0, 1), dist=7.5, az=-35, el=18, res=(960, 600), lens=40, samples=24):
    """Quick Cycles render for checking a model (CPU, headless)."""
    s = bpy.context.scene
    s.render.engine = 'CYCLES'
    s.cycles.device = 'CPU'
    s.cycles.samples = samples
    s.cycles.use_denoising = True
    s.render.resolution_x, s.render.resolution_y = res
    s.render.film_transparent = False
    w = bpy.data.worlds.new('w'); s.world = w; w.use_nodes = True
    bg = w.node_tree.nodes['Background']; bg.inputs['Color'].default_value = (0.55, 0.65, 0.78, 1); bg.inputs['Strength'].default_value = 0.8
    sun = bpy.data.lights.new('sun', 'SUN'); sun.energy = 4.0
    so = bpy.data.objects.new('sun', sun); s.collection.objects.link(so); so.rotation_euler = (math.radians(50), math.radians(10), math.radians(-40))
    bpy.ops.mesh.primitive_plane_add(size=60, location=(0, 0, 0)); g = bpy.context.object; g.name = 'preview_ground'
    g.data.materials.append(mat('preview_ground', (0.32, 0.29, 0.22), 0.95))
    cam = bpy.data.cameras.new('cam'); cam.lens = lens
    co = bpy.data.objects.new('cam', cam); s.collection.objects.link(co)
    t = Vector(target); a, e = math.radians(az), math.radians(el)
    co.location = t + Vector((math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e))) * dist
    co.rotation_euler = (t - co.location).to_track_quat('-Z', 'Y').to_euler()
    s.camera = co
    s.render.filepath = path
    bpy.ops.render.render(write_still=True)
    for n in ('preview_ground', 'cam', 'sun'):
        o = bpy.data.objects.get(n)
        if o:
            bpy.data.objects.remove(o, do_unlink=True)

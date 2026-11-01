"""US weapons from the user-supplied models (E:/Terraform_Automation/New/US-Forces) -> public/models/weapons.
    blender -b --factory-startup --python tools/blender/uweapons_us.py -- m4a1_m203 [m16a4 ...]
Each build_<id>() follows ucommon's pipeline; coordinates are read off uexplore.py's gridded renders (weapon space
before the grip is moved to the origin, unless noted). See CLAUDE.md "Weapons" for the node contract.
Progress notes / measured nodes: tools/blender/AGENT_UWEAPONS_US.md."""
import sys, os, math
sys.path.insert(0, os.path.dirname(__file__))
import ucommon as U
from mathutils import Vector, Matrix


def finish(id_, body, grip, parts=(), nodes=None, tex=1024, ntex=None):
    """Move the grip to the origin, build the root with the body, the animated parts and the empties.
    parts: [(obj, origin)] child meshes with their origin (pre-move space); nodes: {name: (point, parent_name|None)}."""
    g = Vector(grip)
    U.move(-g)
    r = U.root(id_)
    U.parent(body, r)
    objs = {id_: r, body.name: body}
    for o, p in parts:
        if o is None:
            continue
        U.set_origin(o, Vector(p) - g)
        U.parent(o, r)
        objs[o.name] = o
    for name, (p, par) in (nodes or {}).items():
        U.empty(name, Vector(p) - g, objs[par] if par else r)
    rgb_images()
    U.shrink_textures(tex, ntex)
    return r


def flatten_posed():
    """ucommon.flatten() but with the armatures in their POSE position (m16_a4.glb only assembles correctly posed:
    at rest the body lies rotated 90 deg and the carry handle sits 0.1 m too far back). Armature-deformed meshes are
    baked here (vertex groups kept), so flatten() then treats them as static meshes."""
    import bpy
    for a in bpy.data.objects:
        if a.type == 'ARMATURE':
            a.data.pose_position = 'POSE'
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    for m in U.meshes():
        if any(mod.type == 'ARMATURE' for mod in m.modifiers):
            me = bpy.data.meshes.new_from_object(m.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
            m.data = me
            for mod in list(m.modifiers):
                m.modifiers.remove(mod)
    U.flatten()


def rgb_images():
    """Replace 8-bit grey / palette images (the glTF exporter fails to re-encode them: 'Could not write image') by RGBA
    copies made from the float pixel buffer."""
    import bpy
    for img in list(bpy.data.images):
        if not img.size[0] or img.depth >= 24:
            continue
        w, h = img.size
        n = bpy.data.images.new(img.name + '_rgb', w, h, alpha=True)
        n.pixels.foreach_set(list(img.pixels))
        n.colorspace_settings.name = img.colorspace_settings.name
        n.pack()
        img.user_remap(n)
        print('RGB IMAGE', img.name, '->', n.name)


def islands(o):
    """[(face indices, bbox min, bbox max)] of the connected pieces of mesh `o`."""
    import bmesh
    bm = bmesh.new(); bm.from_mesh(o.data); bm.faces.ensure_lookup_table()
    seen, out = set(), []
    for f in bm.faces:
        if f.index in seen:
            continue
        isl, st = [], [f]; seen.add(f.index)
        while st:
            g = st.pop(); isl.append(g)
            for e in g.edges:
                for h in e.link_faces:
                    if h.index not in seen:
                        seen.add(h.index); st.append(h)
        vs = [v.co.copy() for v in {v for g in isl for v in g.verts}]
        out.append(({g.index for g in isl}, Vector([min(v[i] for v in vs) for i in range(3)]),
                    Vector([max(v[i] for v in vs) for i in range(3)])))
    bm.free()
    return out


def split_pred(o, pred, name):
    """Cut the islands of `o` for which pred(bbox_min, bbox_max) is true into a new object `name`."""
    sel = set()
    for faces, a, b in islands(o):
        if pred(a, b):
            sel |= faces
    return U.split_faces(o, sel, name)


def split_in(o, lo, hi, name, pad=0.0):
    """Cut the connected pieces of `o` that lie ENTIRELY inside the box lo..hi (ucommon.split's 'island' mode only
    tests the centre, which grabs receiver-long rails passing through a small box)."""
    import bmesh
    lo, hi = Vector(lo) - Vector((pad,) * 3), Vector(hi) + Vector((pad,) * 3)
    bm = bmesh.new(); bm.from_mesh(o.data); bm.faces.ensure_lookup_table()
    seen, sel = set(), set()
    for f in bm.faces:
        if f.index in seen:
            continue
        isl, st = [], [f]; seen.add(f.index)
        while st:
            g = st.pop(); isl.append(g)
            for e in g.edges:
                for h in e.link_faces:
                    if h.index not in seen:
                        seen.add(h.index); st.append(h)
        if all(lo[i] <= v.co[i] <= hi[i] for g in isl for v in g.verts for i in range(3)):
            sel.update(g.index for g in isl)
    bm.free()
    return U.split_faces(o, sel, name)


def split_in_all(lo, hi, name, objs=None):
    """split_in() over several meshes, joined into one object `name`."""
    parts = [split_in(o, lo, hi, f'{name}_{i}') for i, o in enumerate(objs or U.meshes())]
    return U.join(parts, name)


def sight_nodes(eye, post, back=0.13):
    """eye (rear aperture centre / eyepiece axis), front_post (post tip) and cheek on the eye->post line `back` m
    behind the eye. Measured on 10000 px/m back/front orthographic renders (coordinator: the ring must be centred)."""
    return {'eye': (eye, None), 'front_post': (post, None),
            'cheek': (along(eye, Vector(eye) - Vector(post), back), None)}


def along(p, d, dist):
    """p + dist * normalised d (for mag_dir / cheek points on a sight line)."""
    return tuple(Vector(p) + Vector(d).normalized() * dist)


def _box(name, lo, hi, mat):
    import bpy, bmesh
    me = bpy.data.meshes.new(name); bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1)
    for v in bm.verts:
        v.co = Vector([lo[i] + (v.co[i] + 0.5) * (hi[i] - lo[i]) for i in range(3)])
    bm.to_mesh(me); bm.free(); me.materials.append(mat)
    o = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(o)
    return o


def _ring(name, c, r, t, mat):
    """Aperture ring of radius r (tube t) round the Y axis at c."""
    import bpy
    bpy.ops.mesh.primitive_torus_add(major_radius=r, minor_radius=t, major_segments=20, minor_segments=6, location=c, rotation=(math.pi / 2, 0, 0))
    o = bpy.context.active_object; o.name = name
    o.data.transform(o.matrix_basis); o.matrix_basis = Matrix.Identity(4)
    o.data.materials.append(mat)
    return o


def quadrant_sight():
    """M203 quadrant sight on the left of the carry handle (TM 9-1010-221-10): bracket, housing with the range scale,
    rear aperture and a front post between protective ears, 65 mm sight radius, its line parallel to the bore at the
    zero setting. The aperture, front post and ears are one part, `quad_sight`, pivoting about local X on the housing
    (QUAD_PIVOT): set for a range, the game turns the rifle up by the elevation and the sight back down by it, so the
    sight line stays on the target. Returns (housing meshes, sight part, eye, front_post)."""
    import bpy
    m = bpy.data.materials.new('quadrant'); m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (0.035, 0.036, 0.034, 1); b.inputs['Metallic'].default_value = 0.45; b.inputs['Roughness'].default_value = 0.55
    eye, post = (-0.038, -0.175, 0.2595), (-0.038, -0.110, 0.2595)
    housing = [
        _box('q_bracket', (-0.026, -0.172, 0.222), (-0.020, -0.118, 0.250), m),
        _box('q_housing', (-0.046, -0.181, 0.213), (-0.026, -0.104, 0.246), m),
        _box('q_scale', (-0.048, -0.174, 0.217), (-0.046, -0.111, 0.243), m),
    ]
    sight = U.join([
        _box('q_rail', (-0.0415, -0.179, 0.2455), (-0.0345, -0.106, 0.2475), m),
        _box('q_rear_post', (-0.0405, -0.1775, 0.246), (-0.0355, -0.1725, 0.2552), m),
        _ring('q_rear_ring', eye, 0.0042, 0.0011, m),
        _box('q_front_ear_l', (-0.0455, -0.1115, 0.246), (-0.0435, -0.1085, 0.2655), m),
        _box('q_front_ear_r', (-0.0325, -0.1115, 0.246), (-0.0305, -0.1085, 0.2655), m),
        _box('q_front_post', (-0.0387, -0.1108, 0.246), (-0.0373, -0.1092, post[2]), m),
    ], 'quad_sight')
    return housing, sight, eye, post


QUAD_PIVOT = (-0.038, -0.142, 0.246)


def build_m4a1_m203():
    U.load('US-Forces/a_colt_m4a1m203.glb'); U.flatten()
    # Source: +Y muzzle, +Z up (forward assist on +X), 27.09 units long -> 0.84 m (M4A1, stock extended + M203).
    U.scale_len(0.84)
    U.delete(lambda o: 'Bullet_556' in o.name)          # top round in the mag (4k tris for one cartridge)
    mag = U.join([o for o in U.meshes() if 'Mag2_Stanag' in o.name], 'mag')
    carrier = [o for o in U.meshes() if 'Bolt_D' in o.name]
    body = U.join([o for o in U.meshes() if o is not mag and o not in carrier], 'm4a1_m203_body')
    th = U.split(body, (-0.04, -0.216, 0.19), (0.035, -0.19, 0.216), 'th')   # T charging handle
    charge = U.join(carrier + [th], 'charge')
    # The leaf sight on the handguard rail is carried folded: hinge it forward flat onto its rail.
    leaf = U.split(body, (-0.007, 0.0725, 0.2175), (0.007, 0.0785, 0.2935), 'leaf')
    h = Vector((0, 0.078, 0.2258))
    U.xform(Matrix.Translation(h) @ Matrix.Rotation(math.radians(-90), 4, 'X') @ Matrix.Translation(-h), [leaf])
    # The grenadier aims with the quadrant sight on the left of the carry handle.
    quad, quad_sight, eye_gl, front_gl = quadrant_sight()
    body = U.join([body, leaf] + quad, 'm4a1_m203_body')
    eye, front = (0, -0.165, 0.252), (0, 0.233, 0.2515)    # A1 aperture centre, front post tip (10000 px/m renders)
    gl_dir = Vector(front_gl) - Vector(eye_gl)
    mag_o = (0, -0.058, 0.155)
    finish('m4a1_m203', body, (0, -0.185, 0.073),
           parts=[(mag, mag_o), (charge, (0, -0.203, 0.202)), (quad_sight, QUAD_PIVOT)],
           nodes={'muzzle': ((0, 0.42, 0.179), None), 'muzzle_gl': ((0, 0.405, 0.12), None),
                  **sight_nodes(eye, front),
                  'eye_gl': (eye_gl, None), 'front_gl': (front_gl, None), 'cheek_gl': (along(eye_gl, -gl_dir, 0.13), None),
                  'grip_r': ((0, -0.185, 0.073), None), 'grip_l': ((-0.02, 0.16, 0.10), None),
                  'eject': ((0.016, -0.075, 0.183), None), 'butt': ((0, -0.418, 0.14), None),
                  'mag_dir': (along(mag_o, (0, 0.1, -1), 0.12), None), 'hand_mag': ((-0.016, -0.06, 0.09), 'mag'),
                  'charge_back': ((0, -0.273, 0.202), None), 'hand_charge': ((-0.02, -0.207, 0.203), 'charge')})
    U.export('m4a1_m203')


def build_m16a4():
    U.load('US-Forces/m16_a4.glb'); flatten_posed()
    # Posed source: +Y muzzle, +Z up, 0.998 m long (real 1.006 m): kept as is. Bore z 0.077, A4 aperture z 0.141.
    U.delete(lambda o: any(s in o.name for s in ('Bullet', 'Cartridge_M', 'Fired Shell')))   # loose rounds
    ammo = next(o for o in U.meshes() if o.name.startswith('Magazine Ammo'))
    U.decimate(ammo, 0.25)                              # 11k tris of rounds at the feed lips
    mag = U.join([o for o in U.meshes() if 'Magazine' in o.name], 'mag')
    main = next(o for o in U.meshes() if o.name == 'Object_34')
    charge = U.split_groups(main, ['Charging Handle_09', 'Charging Handle Lock_010', 'Charging Handle Lock_end_023',
                                   'Bolt_015', 'Bolt_end_028'], 'charge')
    body = U.join([o for o in U.meshes() if o.name in ('Object_34', 'Object_17')], 'm16a4_body')
    grip, mag_o = (0, -0.022, -0.019), (0, 0.104, 0.055)
    finish('m16a4', body, grip,
           parts=[(mag, mag_o), (charge, (0, -0.035, 0.1))],
           nodes={'muzzle': ((0, 0.671, 0.077), None), **sight_nodes((0, -0.006, 0.1417), (0, 0.507, 0.1403)),
                  'grip_r': (grip, None), 'grip_l': ((0, 0.28, 0.05), None),
                  'eject': ((0.017, 0.06, 0.077), None), 'butt': ((0, -0.326, 0.015), None),
                  'mag_dir': (along(mag_o, (0, 0.1, -1), 0.12), None), 'hand_mag': ((-0.016, 0.105, -0.01), 'mag'),
                  'charge_back': ((0, -0.105, 0.1), None), 'hand_charge': ((-0.015, -0.04, 0.1), 'charge')})
    U.export('m16a4')


def build_m249():
    U.load('US-Forces/m249_saw_squad_automatic_weapon.glb'); U.flatten()
    # Source: +Y muzzle, +Z up but pitched 14.4 deg muzzle-up; 1.019 m after levelling -> 1.04 m (M249, fixed stock).
    U.rot('X', -14.4); U.scale_len(1.04)
    src = list(U.meshes())                              # Object_8 + Object_10 (124k tris, one material 'Main')
    box = split_in_all((-0.07, -0.047, -0.145), (0.09, 0.016, -0.016), 'box', src)
    charge = split_in_all((0.0295, -0.1, 0.0), (0.08, -0.06, 0.03), 'charge', src)
    cover = split_in_all((-0.045, -0.26, 0.042), (0.045, 0.045, 0.16), 'cover', src)
    body = U.join(src, 'm249_body')
    for o in (body, box, charge, cover):
        if o is not None and U.tris([o]) > 3000:
            U.decimate(o, 0.31)
    grip, sz = (0, -0.167, -0.103), 0.0897   # rear aperture centre (10000 px/m back view)
    hinge = HINGE_M249
    finish('m249', body, grip,
           parts=[(box, (0.012, -0.016, -0.02)), (charge, (0.04, -0.089, 0.013)), (cover, hinge)],
           nodes={'muzzle': ((0, 0.492, 0.040), None), **sight_nodes((0, -0.235, sz), (0, 0.374, 0.0917)),
                  'grip_r': (grip, None), 'grip_l': ((0, 0.13, -0.03), None),
                  'eject': ((0.015, -0.06, -0.02), None), 'butt': ((0, -0.53, -0.035), None),
                  'mag_dir': ((0.012, -0.016, -0.14), None), 'hand_mag': ((-0.05, 0.008, -0.08), 'box'),
                  'charge_back': ((0.04, -0.169, 0.013), None), 'hand_charge': ((0.06, -0.089, 0.013), 'charge'),
                  'hand_cover': (HAND_COVER_M249, 'cover')})
    U.export('m249')


def build_m24():
    U.load('US-Forces/m24_bounty_hunter_sniper_rifle.glb'); U.flatten()
    # Source: +X muzzle, +Z up (bolt handle on -Y -> +X right); 13.8 units -> 1.09 m. Bore z 0.043, scope axis z 0.0935.
    U.orient('+X', '+Z'); U.scale_len(1.09)
    by = lambda *n: [o for o in U.meshes() if o.name in n]
    bolt = U.join(by('Object_18', 'Object_25'), 'bolt')              # bolt body + handle + shroud piece
    mag = U.join(by('Object_14'), 'mag')                              # detachable box magazine
    body = U.join([o for o in U.meshes() if o not in (bolt, mag)], 'm24_body')
    grip, bore = (0, -0.262, -0.03), 0.043
    finish('m24', body, grip,
           parts=[(mag, (0, -0.105, 0.02)), (bolt, (0, -0.2, bore))],
           nodes={'muzzle': ((0, 0.567, bore), None), **sight_nodes((0, -0.261, 0.093), (0, 0.07, 0.093)),   # scope axis; front_post = objective centre
                  'grip_r': (grip, None), 'grip_l': ((0, 0.12, -0.005), None),
                  'eject': ((0.012, -0.08, 0.05), None), 'butt': ((0, -0.52, -0.035), None),
                  'mag_dir': ((0, -0.105, -0.1), None), 'hand_mag': ((-0.012, -0.11, -0.035), 'mag'),
                  'charge_back': ((0, -0.3, bore), None), 'hand_charge': ((0.047, -0.197, 0.008), 'bolt')})
    U.export('m24')


def build_m9():
    U.load('US-Forces/3d_beretta_m9.glb'); U.flatten()
    # Source: +Y muzzle, +Z up, cm-ish units x100; Cube.007 = a spare magazine lying beside the gun (dropped).
    U.delete(lambda o: o.name.startswith('Cube.007'))
    U.scale_len(0.217)
    by = lambda p: next(o for o in U.meshes() if o.name.startswith(p))
    slide, mag = by('Cube.001'), by('Cube.003')
    slide.name = slide.data.name = 'charge'; mag.name = mag.data.name = 'mag'
    body = U.join([o for o in U.meshes() if o not in (slide, mag)], 'm9_body')   # frame + barrel + hammer
    grip, mag_o = (0, -0.063, -0.02), (0, -0.053, 0.035)
    eye = (0, -0.065, 0.0712)          # rear notch at the height of the front post tip (20000 px/m back view)
    finish('m9', body, grip,
           parts=[(mag, mag_o), (slide, (0, -0.08, 0.055))],
           nodes={'muzzle': ((0, 0.111, 0.0586), None), 'eye': (eye, None), 'front_post': ((0, 0.097, 0.0712), None),
                  'grip_r': (grip, None), 'grip_l': ((-0.025, -0.055, -0.015), None),
                  'eject': ((0.01, -0.02, 0.062), None),
                  'mag_dir': (along(mag_o, (0, -0.147, -1), 0.12), None), 'hand_mag': ((-0.011, -0.07, -0.055), 'mag'),
                  'charge_back': ((0, -0.116, 0.055), None), 'hand_charge': ((0, -0.078, 0.055), 'charge')},
           tex=1024)
    U.export('m9')


def build_m136():
    U.load('US-Forces/anti-tank_grenade_launcher__at4__gameready.glb'); U.flatten()
    # Source: +Y front (venturi at -Y), +Z up, 6.67 units -> 1.02 m. Tube axis z 0. Sights on the LEFT top (x -0.0665).
    U.scale_len(1.02)
    body = U.join_all('m136_body')
    grip = (0.04, 0.07, -0.04)        # right palm on the tube's lower right, thumb on the red firing button (y 0.084)
    finish('m136', body, grip,
           nodes={'muzzle': ((0, 0.51, 0), None), 'backblast': ((0, -0.51, 0), None),
                  **sight_nodes((-0.0670, 0.1146, 0.0850), (-0.0709, 0.4717, 0.0851)),
                  'grip_r': (grip, None), 'grip_l': ((0, 0.335, -0.10), None),
                  'fire_button': ((0.037, 0.084, 0.04), None)})
    U.export('m136')


def build_m67():
    U.load('US-Forces/m67.glb'); U.flatten()
    # Source: two grenades (the '.001' copy lies on its side): keep the upright one. Already real size (0.0896 m tall,
    # body dia 0.059), +Z up, spoon on the +Y side, pull ring on the +X side (real geometry, not mirrored).
    U.delete(lambda o: '.001' in o.name)
    pin = U.join([o for o in U.meshes() if 'ring' in o.name or 'safety_pin' in o.name], 'pin')
    spoon = U.join([o for o in U.meshes() if 'spoon' in o.name], 'spoon')
    body = U.join([o for o in U.meshes() if o not in (pin, spoon)], 'm67_body')   # body + fuze + striker
    grip = (0, 0, 0.0295)             # body sphere centre (palm)
    finish('m67', body, grip, parts=[(pin, (0, 0.014, 0.079)), (spoon, (0, 0.02, 0.087))],
           nodes={'grip_r': (grip, None), 'grip_l': ((0.0175, 0.014, 0.066), None),
                  'cheek': ((-0.09, -0.38, 0.0295 + 0.17), None)},       # same hold-to-eye offset as the old m67
           tex=512)
    U.export('m67')


def build_m18():
    U.load('US-Forces/m18_smoke_grenade.glb'); U.flatten()
    # Source: three canisters; the one at the origin stands upright (+Z up). Scaled to 0.145 m tall (dia then 0.059,
    # real 0.064: kept uniform). Spoon on the +Y side, ring on +X. One mesh of many small islands, classified by bbox:
    U.delete(lambda o: '.001' in o.name or '.002' in o.name)
    U.scale_len(0.145, axis=2)
    o = U.meshes()[0]
    ring = lambda a, b: a.z >= 0.105 and (a.x >= 0.009 or (a.y >= 0.009 and b.y <= 0.0117 and (a.x >= 0.0085 or b.x <= -0.0086)))
    pin = split_pred(o, ring, 'pin')
    fuze = lambda a, b: b.y <= 0.0091 and b.z <= 0.1354                       # fuze body cylinder under the lever
    lever = lambda a, b: (a.z >= 0.1416 or a.y >= 0.019                      # lever top / striker curl, side strip
                          or (a.z >= 0.12 and max(abs(a.x), abs(b.x)) <= 0.0089 and not fuze(a, b)))
    spoon = split_pred(o, lever, 'spoon')
    o.name = o.data.name = 'm18_body'
    grip = (0, 0, 0.065)              # canister middle (palm)
    finish('m18', o, grip, parts=[(pin, (0, 0.0104, 0.136)), (spoon, (0, -0.012, 0.143))],
           nodes={'grip_r': (grip, None), 'grip_l': ((0.025, 0.012, 0.12), None),
                  'cheek': ((-0.09, -0.38, 0.065 + 0.17), None)},
           tex=512)
    U.export('m18')


def build_c4():
    U.load('US-Forces/simple_c4-_bomb.glb'); U.flatten()
    # Source: a bundle of seven charges along Y with a timer box on the +X side tilted ~58 deg up; scaled to 0.28 m
    # long and rolled about Y so the timer faces +Z. Origin at the bottom centre (placed lying on the ground).
    U.scale_len(0.28)
    U.rot('Y', -58)
    body = U.join_all('c4_body')
    lo, hi = U.bounds()
    base = ((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z)
    finish('c4', body, base, nodes={'grip_r': (((lo.x + hi.x) / 2, 0, (lo.z + hi.z) / 2), None)}, tex=1024)
    U.export('c4')


# Feed cover (pre-move bbox y -0.259..0.042, z 0.042..0.095): hinge pin at its front bottom, latch at the rear.
HINGE_M249 = (0, 0.035, 0.05)
HAND_COVER_M249 = (0, -0.24, 0.07)


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    for wid in [a for a in argv if not a.startswith('--')]:
        globals()[f'build_{wid}']()

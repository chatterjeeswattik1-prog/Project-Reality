"""Characters and animations for PROJECT REALISM.

    blender -b --factory-startup --python tools/blender/characters.py -- public/models/chars [--preview tools/blender/previews] [--only anims,us_rifleman,...]

Writes <out>/anims.glb (armature + named clips, no mesh) and <out>/<id>.glb (skinned parts part_head,
part_torso, part_arms, part_legs on the armature `Armature`, no animations). Sources: Quaternius UBC + UAL (CC0).
Characters face +Y in Blender (-Z in three.js), feet on z = 0, ~1.78 m tall.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy
import bmesh
from mathutils import Vector, Quaternion, Matrix
from mathutils.bvhtree import BVHTree
import chcommon as C
from chcommon import qe

UAL1_CLIPS = ['Idle_Loop', 'Walk_Loop', 'Jog_Fwd_Loop', 'Sprint_Loop', 'Crouch_Idle_Loop', 'Crouch_Fwd_Loop', 'Death01',
              'Hit_Chest', 'Hit_Head', 'Driving_Loop', 'Sitting_Idle_Loop', 'Fixing_Kneeling', 'Interact', 'PickUp_Table',
              'Jump_Start', 'Jump_Loop', 'Jump_Land', 'Roll', 'Pistol_Idle_Loop', 'Pistol_Aim_Neutral', 'Pistol_Reload',
              'Pistol_Shoot']
UAL2_CLIPS = ['Hit_Knockback', 'OverhandThrow', 'LayToIdle', 'ClimbUp_1m', 'Idle_FoldArms_Loop']

# ============================================================================================ authored clips
# All positions in metres in armature space (character faces +Y, ground z = 0). Arms use 2-bone IK to wrist
# targets; legs use 2-bone IK to ankle targets with absolute foot orientation.

class Body:
    """Measurements of the (scaled) rest skeleton used by the clip authoring code."""

    def __init__(self, rig):
        self.rig = rig
        self.ank = rig.head('foot_l').z           # ankle height with the foot flat
        self.ball = rig.head('ball_l') - rig.head('foot_l')   # ankle -> ball (rest)
        self.hipx = abs(rig.head('thigh_l').x)
        self.pel = rig.head('pelvis')
        self.leg = rig.seg('thigh_l', 'calf_l').length + rig.seg('calf_l', 'foot_l').length


def joint(name, off=(0, 0, 0)):
    """Callable: world position of `name` plus an offset expressed in that bone's rest-aligned frame."""
    def f(pose, n=name, o=Vector(off)):
        m = pose[n]
        return m.translation + (m.to_quaternion() @ RIG.rrot[n].inverted()) @ o
    return f


def rel_dir(name, d):
    """Callable: direction d (rest frame) carried by bone `name`'s world rotation delta."""
    def f(pose, n=name, v=Vector(d)):
        return (pose[n].to_quaternion() @ RIG.rrot[n].inverted()) @ v
    return f


def low_ready():
    """Arms holding an (invisible) rifle at low ready, relative to the chest."""
    return {
        'arm_r': (joint('spine_03', (0.16, 0.22, -0.20)), rel_dir('spine_03', (0.6, -0.4, -0.6))),
        'arm_l': (joint('spine_03', (-0.08, 0.25, -0.12)), rel_dir('spine_03', (-0.7, -0.2, -0.7))),
    }


def foot_w(yaw=0.0, pitch=0.0, roll=0.0):
    """World foot rotation: pitch (deg, + = toes up) about X, then roll about the foot axis, then yaw about Z."""
    return qe(z=yaw) @ qe(y=roll) @ qe(x=pitch)


def ankle_for(ground_pt, yaw=0.0, pitch=0.0, side=1):
    """Ankle position for a foot whose sole touches ground_pt (x, y of the ankle when flat) given pitch.
    pitch < 0 (heel up) pivots about the ball, pitch > 0 (toes up) about the heel."""
    q = foot_w(yaw, pitch)
    a = Vector((ground_pt[0], ground_pt[1], B.ank))
    if pitch < 0:
        ball = a + qe(z=yaw) @ B.ball
        return ball + q @ (-B.ball)
    heel = a + Vector((0, 0, -B.ank))
    return heel + q @ Vector((0, 0, B.ank))


def stand_spec():
    pz = B.pel.z - 0.015
    return {
        'pelvis': (Vector((0, B.pel.y, pz)), qe()),
        'E': {'spine_01': qe(x=-2), 'spine_02': qe(x=-2), 'clavicle_l': qe(y=-6), 'clavicle_r': qe(y=6)},
        'W': {'foot_l': foot_w(yaw=8), 'foot_r': foot_w(yaw=-8)},
        'ik': dict(low_ready(), **{
            'leg_l': (Vector((-B.hipx - 0.03, -0.04, B.ank)), Vector((-0.1, 1, 0))),
            'leg_r': (Vector((B.hipx + 0.03, -0.06, B.ank)), Vector((0.1, 1, 0))),
        }),
    }


# ---------------------------------------------------------------------------------------------- prone

PRONE_PZ = 0.165        # pelvis joint height when lying on the belly
PRONE_PY = 0.05


def prone_spec(breath=0.0, look=0.0):
    rot = qe(x=-90)
    hip_y = PRONE_PY + 0.02
    sp = 1 + 0.05 * breath
    return {
        'pelvis': (Vector((0, PRONE_PY, PRONE_PZ + 0.004 * breath)), rot),
        'E': {'spine_01': qe(x=6 * sp), 'spine_02': qe(x=9 * sp), 'spine_03': qe(x=9 * sp),
              'neck_01': qe(x=30, z=look * 0.4), 'Head': qe(x=34, z=look * 0.6),
              'clavicle_l': qe(z=14, y=-8), 'clavicle_r': qe(z=-14, y=8)},
        'W': {'foot_l': qe(y=55) @ qe(x=-145), 'foot_r': qe(y=-55) @ qe(x=-145)},
        'ik': {
            'leg_l': (Vector((-0.31, hip_y - 0.83, 0.075)), Vector((-0.8, 0, -0.6))),
            'leg_r': (Vector((0.31, hip_y - 0.83, 0.075)), Vector((0.8, 0, -0.6))),
            # elbows on the ground ahead of the shoulders; hands on an (invisible) rifle
            'arm_l': (Vector((-0.08, 0.86, 0.18)), Vector((-0.35, 0.2, -1))),
            'arm_r': (Vector((0.12, 0.62, 0.20)), Vector((0.5, -0.2, -1))),
        },
    }


def clip_prone_idle(t, ph):
    br = math.sin(ph * 2 * math.pi * 3)            # 3 breaths per 4 s loop
    look = 6 * math.sin(ph * 2 * math.pi)
    return prone_spec(br, look)


CRAWL_T = 1.6


def clip_prone_crawl(t, ph):
    """Low crawl: right arm + left leg reach together, then pull/push; then the other side.
    In place; designed for ~0.5 m of travel per cycle."""
    s = prone_spec()
    s['pelvis'] = (Vector((0, PRONE_PY, PRONE_PZ - 0.01)), qe(x=-90))
    def stroke(phase, back, fwd):
        """Contact point along Y: slides back during stance (0..0.55), swings forward after."""
        phase %= 1.0
        if phase < 0.55:
            u = phase / 0.55
            return fwd + (back - fwd) * u, 0.0
        u = (phase - 0.55) / 0.45
        e = C.smooth01(u)
        return back + (fwd - back) * e, math.sin(math.pi * u)
    # A side: arm_r + leg_l, B side: arm_l + leg_r (half a cycle apart)
    pa, pb = ph, ph + 0.5
    E = s['E']
    sw = math.sin(2 * math.pi * ph)
    E['spine_01'] = qe(x=3, y=-5 * sw, z=-4 * sw)
    E['spine_02'] = qe(x=4, z=-3 * sw)
    E['spine_03'] = qe(x=4, z=-3 * sw)
    E['neck_01'] = qe(x=26, z=4 * sw)
    E['Head'] = qe(x=28, z=3 * sw)
    s['pelvis'] = (Vector((0.02 * sw, PRONE_PY, PRONE_PZ - 0.005 + 0.01 * abs(sw))), qe(z=4 * sw) @ qe(y=6 * sw) @ qe(x=-90))
    ik = s['ik']
    for arm, phs, x in (('arm_r', pa, 0.22), ('arm_l', pb, -0.22)):
        y, lift = stroke(phs, 0.42, 0.78)
        side = 1 if x > 0 else -1
        E['clavicle_r' if side > 0 else 'clavicle_l'] = qe(z=-side * (8 + 16 * (y - 0.42) / 0.36), y=side * 8)
        ik[arm] = (Vector((x * 0.5, y + 0.17, 0.10 + 0.06 * lift)), Vector((side * 0.6, -0.1, -1)))
    for leg, phs, x in (('leg_l', pa, -1), ('leg_r', pb, 1)):
        y, lift = stroke(phs, -0.80, -0.38)       # ankle Y: from drawn up (-0.38) to extended (-0.80)
        draw = (y + 0.80) / 0.42                  # 0 = extended, 1 = knee drawn up to the side
        ax = x * (0.30 + 0.16 * draw)
        ik[leg] = (Vector((ax, PRONE_PY + y, 0.075 + 0.04 * lift + 0.02 * draw)),
                   Vector((x * (0.8 + 0.2 * draw), 0.2 * draw, -0.6 + 0.3 * draw)))
        s['W']['foot_' + ('l' if x < 0 else 'r')] = qe(y=-x * (55 + 15 * draw)) @ qe(x=-145 + 30 * draw)
    return s


# ---------------------------------------------------------------------------------------------- transitions

def kneel_spec(fwd=0.12, lean=18, hands=None):
    """Kneeling on both knees, toes tucked, torso leaning forward by `lean` degrees."""
    kz = 0.06
    hip_z = kz + 0.42 * math.cos(math.radians(8)) + 0.02
    s = {
        'pelvis': (Vector((0, fwd, hip_z)), qe(x=-lean * 0.5)),
        'E': {'spine_01': qe(x=-lean * 0.2), 'spine_02': qe(x=-lean * 0.2), 'spine_03': qe(x=-lean * 0.1),
              'neck_01': qe(x=lean * 0.4), 'Head': qe(x=lean * 0.3)},
        'W': {'foot_l': qe(z=6) @ qe(x=-60), 'foot_r': qe(z=-6) @ qe(x=-60)},
        'ik': dict(low_ready(), **{
            'leg_l': (Vector((-0.15, fwd - 0.45, 0.12)), Vector((-0.1, 1, 0))),
            'leg_r': (Vector((0.15, fwd - 0.45, 0.12)), Vector((0.1, 1, 0))),
        }),
    }
    if hands:
        s['ik'].update(hands)
    return s


def hands_down_spec():
    """On hands and knees, body pitched forward, hands on the ground ahead."""
    s = {
        'pelvis': (Vector((0, 0.10, 0.50)), qe(x=-62)),
        'E': {'spine_01': qe(x=-4), 'spine_02': qe(x=-2), 'spine_03': qe(x=2), 'neck_01': qe(x=22), 'Head': qe(x=22)},
        'W': {'foot_l': qe(z=6) @ qe(x=-90), 'foot_r': qe(z=-6) @ qe(x=-90)},
        'ik': {
            'leg_l': (Vector((-0.16, -0.42, 0.10)), Vector((-0.1, 1, -0.2))),
            'leg_r': (Vector((0.16, -0.42, 0.10)), Vector((0.1, 1, -0.2))),
            'arm_l': (Vector((-0.25, 0.72, 0.05)), Vector((-0.3, -1, 0))),
            'arm_r': (Vector((0.25, 0.70, 0.05)), Vector((0.3, -1, 0))),
        },
    }
    return s


def pushup_spec():
    """Prone with the chest pushed up on the hands (getting up)."""
    s = prone_spec()
    s['pelvis'] = (Vector((0, PRONE_PY, PRONE_PZ + 0.03)), qe(x=-90 + 14))
    s['E'].update({'spine_01': qe(x=10), 'spine_02': qe(x=10), 'spine_03': qe(x=6), 'neck_01': qe(x=14), 'Head': qe(x=14),
                   'clavicle_l': qe(), 'clavicle_r': qe()})
    s['ik']['arm_l'] = (Vector((-0.26, 0.62, 0.05)), Vector((-0.4, -1, 0)))
    s['ik']['arm_r'] = (Vector((0.26, 0.62, 0.05)), Vector((0.4, -1, 0)))
    return s


def kneel_one_spec():
    """Right foot planted forward, left knee on the ground: half kneeling."""
    s = {
        'pelvis': (Vector((0, -0.02, 0.52)), qe(x=-8)),
        'E': {'spine_01': qe(x=-6), 'spine_02': qe(x=-4), 'neck_01': qe(x=6), 'Head': qe(x=4)},
        'W': {'foot_l': qe(z=8) @ qe(x=-55), 'foot_r': foot_w(yaw=-6)},
        'ik': dict(low_ready(), **{
            'leg_l': (Vector((-0.14, -0.50, 0.13)), Vector((-0.1, 1, -0.3))),
            'leg_r': (Vector((0.16, 0.36, B.ank)), Vector((0.1, 1, 0.3))),
        }),
    }
    return s


def clip_stand_to_prone(t, ph):
    keys = [(0.00, STAND), (0.30, KNEEL), (0.52, HANDS), (0.72, LOWER), (0.90, PRONE0)]
    return C.keyposes(keys, t)


def clip_prone_to_stand(t, ph):
    keys = [(0.00, PRONE0), (0.30, PUSHUP), (0.55, HANDS), (0.80, KNEEL_UP), (1.02, KNEEL1), (1.35, STAND)]
    return C.keyposes(keys, t)


# ---------------------------------------------------------------------------------------------- wounded, deaths

def clip_wounded(t, ph):
    w1 = math.sin(2 * math.pi * ph)
    w2 = math.sin(4 * math.pi * ph + 0.7)
    w3 = math.sin(2 * math.pi * ph + 2.0)
    rot = qe(y=5 * w1) @ qe(x=90)              # on the back, head towards -Y, slight roll
    return {
        'pelvis': (Vector((0.01 * w1, 0.0, 0.125 + 0.006 * max(w2, 0))), rot),
        'E': {'spine_01': qe(x=-4 - 3 * max(w2, 0), y=-3 * w1), 'spine_02': qe(x=-6 - 2 * max(w2, 0), y=-3 * w1),
              'spine_03': qe(x=-6, y=-2 * w1),
              'neck_01': qe(x=-14 - 4 * max(w3, 0), z=12 * w3), 'Head': qe(x=-10 - 6 * max(w3, 0), z=14 * w3)},
        'W': {'foot_l': qe(y=-60) @ qe(x=-150), 'foot_r': qe(x=90) @ qe(z=-10)},
        'ik': {
            'leg_r': (Vector((0.20 + 0.06 * w1, 0.48, B.ank + 0.01)), Vector((0.2 + 0.4 * w1, 0, 1))),
            'leg_l': (Vector((-0.24, 0.80 + 0.03 * w3, 0.075)), Vector((-0.5, 0, 1))),
            # left hand pressed on the belly, right arm out on the ground
            'arm_l': (joint('spine_01', (-0.02 + 0.02 * w2, 0.17, 0.02)), Vector((-1, 0.3, 0.6))),
            'arm_r': (Vector((0.52 + 0.04 * w3, -0.30 + 0.05 * w1, 0.05 + 0.03 * max(w3, 0))), Vector((0.4, 0.6, 0.4))),
        },
    }


def clip_death02(t, ph):
    """Knees buckle and the body falls forward onto the chest and face."""
    keys = [(0.00, STAND), (0.22, D2_SLUMP), (0.55, D2_KNEES), (0.90, D2_HIT), (1.05, D2_BOUNCE), (1.45, D2_REST),
            (1.70, D2_REST)]
    return C.keyposes(keys, t)


def clip_death03(t, ph):
    """Legs give way, the body twists and crumples onto its left side."""
    keys = [(0.00, STAND), (0.25, D3_BUCKLE), (0.55, D3_SIT), (0.95, D3_SIDE), (1.10, D3_BOUNCE), (1.50, D3_REST),
            (1.70, D3_REST)]
    return C.keyposes(keys, t)


def build_death_keys():
    g = globals()
    s = stand_spec()
    # Death02 ---------------------------------------------------------------------------------
    g['D2_SLUMP'] = {
        'pelvis': (Vector((0, 0.04, 0.80)), qe(x=-12)),
        'E': {'spine_01': qe(x=-8), 'spine_02': qe(x=-10), 'spine_03': qe(x=-8), 'neck_01': qe(x=-18), 'Head': qe(x=-10),
              'clavicle_l': qe(y=-10), 'clavicle_r': qe(y=10)},
        'W': {'foot_l': foot_w(yaw=8, pitch=-10), 'foot_r': foot_w(yaw=-8, pitch=-6)},
        'ik': {
            'leg_l': (ankle_for((-B.hipx - 0.03, -0.04), 8, -10), Vector((-0.1, 1, 0))),
            'leg_r': (ankle_for((B.hipx + 0.03, -0.06), -8, -6), Vector((0.1, 1, 0))),
            'arm_l': (joint('spine_03', (-0.30, 0.10, -0.45)), Vector((-0.3, -1, 0))),
            'arm_r': (joint('spine_03', (0.30, 0.12, -0.45)), Vector((0.3, -1, 0))),
        },
    }
    g['D2_KNEES'] = {
        'pelvis': (Vector((0, 0.16, 0.50)), qe(x=-28)),
        'E': {'spine_01': qe(x=-10), 'spine_02': qe(x=-10), 'spine_03': qe(x=-6), 'neck_01': qe(x=-20), 'Head': qe(x=-10)},
        'W': {'foot_l': qe(z=6) @ qe(x=-70), 'foot_r': qe(z=-6) @ qe(x=-60)},
        'ik': {
            'leg_l': (Vector((-0.15, -0.28, 0.12)), Vector((-0.1, 1, 0))),
            'leg_r': (Vector((0.15, -0.26, 0.12)), Vector((0.1, 1, 0))),
            'arm_l': (joint('spine_03', (-0.28, 0.05, -0.50)), Vector((-0.3, -1, 0))),
            'arm_r': (joint('spine_03', (0.30, 0.15, -0.45)), Vector((0.3, -1, 0))),
        },
    }
    g['D2_HIT'] = {
        'pelvis': (Vector((0, 0.48, 0.15)), qe(x=-88)),
        'E': {'spine_01': qe(x=2), 'spine_02': qe(x=2), 'spine_03': qe(x=2), 'neck_01': qe(x=6, z=30), 'Head': qe(x=0, z=40, y=-10)},
        'W': {'foot_l': qe(y=40) @ qe(x=-140), 'foot_r': qe(y=-30) @ qe(x=-130)},
        'ik': {
            'leg_l': (Vector((-0.24, 0.48 - 0.80, 0.08)), Vector((-0.6, 0, -0.8))),
            'leg_r': (Vector((0.20, 0.48 - 0.74, 0.11)), Vector((0.5, 0, -0.8))),
            'arm_l': (Vector((-0.42, 0.82, 0.05)), Vector((-0.6, -0.5, 0.4))),
            'arm_r': (Vector((0.30, 0.42, 0.06)), Vector((1, 0, 0.6))),
        },
    }
    b = dict(D2_HIT)
    b['pelvis'] = (Vector((0, 0.50, 0.17)), qe(x=-86))
    g['D2_BOUNCE'] = b
    r = dict(D2_HIT)
    r['pelvis'] = (Vector((0, 0.50, 0.135)), qe(x=-90))
    r['E'] = {'spine_01': qe(x=0), 'spine_02': qe(x=0), 'spine_03': qe(x=0), 'neck_01': qe(x=8, z=34), 'Head': qe(x=0, z=44, y=-12)}
    r['ik'] = dict(D2_HIT['ik'])
    r['ik']['leg_r'] = (Vector((0.30, 0.50 - 0.62, 0.075)), Vector((0.9, 0, -0.4)))
    g['D2_REST'] = r
    # Death03 ---------------------------------------------------------------------------------
    g['D3_BUCKLE'] = {
        'pelvis': (Vector((-0.04, 0.02, 0.78)), qe(z=10) @ qe(y=-8, x=-6)),
        'E': {'spine_01': qe(x=-6, y=-6), 'spine_02': qe(x=-8, y=-6, z=6), 'spine_03': qe(x=-6, z=6),
              'neck_01': qe(x=-16, y=-10), 'Head': qe(x=-8, y=-10)},
        'W': {'foot_l': foot_w(yaw=10), 'foot_r': foot_w(yaw=-6, pitch=-15)},
        'ik': {
            'leg_l': (Vector((-B.hipx - 0.05, -0.02, B.ank)), Vector((-0.3, 1, 0))),
            'leg_r': (ankle_for((B.hipx + 0.03, -0.08), -6, -15), Vector((0.0, 1, 0))),
            'arm_l': (joint('spine_03', (-0.32, 0.05, -0.48)), Vector((-0.3, -1, 0))),
            'arm_r': (joint('spine_03', (0.28, 0.16, -0.44)), Vector((0.3, -1, 0))),
        },
    }
    g['D3_SIT'] = {
        'pelvis': (Vector((-0.12, 0.02, 0.36)), qe(z=16) @ qe(y=-28, x=-10)),
        'E': {'spine_01': qe(x=-8, y=-8), 'spine_02': qe(x=-10, y=-8, z=8), 'spine_03': qe(x=-6, z=6),
              'neck_01': qe(x=-18, y=-14), 'Head': qe(x=-10, y=-10)},
        'W': {'foot_l': qe(z=40) @ qe(y=-50), 'foot_r': foot_w(yaw=-10, pitch=-20)},
        'ik': {
            'leg_l': (Vector((-0.30, 0.25, 0.07)), Vector((-0.9, 0.4, 0.2))),
            'leg_r': (ankle_for((0.16, -0.06), -10, -20), Vector((0.2, 1, 0.3))),
            'arm_l': (Vector((-0.48, 0.10, 0.06)), Vector((-0.2, -1, 0.3))),
            'arm_r': (joint('spine_03', (0.25, 0.22, -0.40)), Vector((0.3, -1, 0))),
        },
    }
    side = qe(z=12) @ qe(y=-88)
    g['D3_SIDE'] = {
        'pelvis': (Vector((-0.20, 0.04, 0.17)), side),
        'E': {'spine_01': qe(x=-10, z=-4), 'spine_02': qe(x=-8), 'spine_03': qe(x=-6),
              'neck_01': qe(x=-10, y=-16), 'Head': qe(x=-6, y=-14)},
        'W': {'foot_l': qe(z=20) @ qe(y=-90) @ qe(x=-30), 'foot_r': qe(z=10) @ qe(y=-90) @ qe(x=-40)},
        'ik': {
            'leg_l': (Vector((0.22, 0.30, 0.06)), Vector((-0.2, 1, 0.1))),
            'leg_r': (Vector((0.30, 0.18, 0.17)), Vector((0.1, 1, 0.3))),
            'arm_l': (Vector((-0.75, 0.42, 0.05)), Vector((-0.3, -0.4, 1))),
            'arm_r': (Vector((-0.45, 0.42, 0.26)), Vector((0.2, -0.3, 1))),
        },
    }
    b = dict(D3_SIDE)
    b['pelvis'] = (Vector((-0.21, 0.04, 0.19)), qe(z=12) @ qe(y=-84))
    g['D3_BOUNCE'] = b
    r = dict(D3_SIDE)
    r['pelvis'] = (Vector((-0.21, 0.04, 0.165)), qe(z=12) @ qe(y=-96))
    r['E'] = {'spine_01': qe(x=-10, z=-4), 'spine_02': qe(x=-6, y=-4), 'spine_03': qe(x=-4, y=-4),
              'neck_01': qe(x=-6, y=-22), 'Head': qe(x=-4, y=-20)}
    r['ik'] = dict(D3_SIDE['ik'])
    r['ik']['arm_r'] = (Vector((-0.40, 0.50, 0.12)), Vector((0.3, -0.2, 1)))
    g['D3_REST'] = r


# ---------------------------------------------------------------------------------------------- locomotion

def gait(ph, move, T, stride, h0, bob=0.02, lift=0.08, width=0.12, lean=0.0, duty=0.62, pole_out=0.1, toe_out=8):
    """Walking cycle in place. move = unit (x, y) direction of travel. Left foot stance starts at ph = 0."""
    mv = Vector((move[0], move[1], 0))
    feet = {}
    for side, off in (('l', 0.0), ('r', 0.5)):
        p = (ph + off) % 1.0
        sx = -1 if side == 'l' else 1
        base = Vector((sx * width, 0.0, 0))
        yaw = -sx * toe_out
        if p < duty:
            u = p / duty
            d = stride * (0.5 - u)
            z = 0.0
            # rolling contact: heel->toe for forward, toe->heel for backward travel
            pitch = 0.0
            if u > 0.8:
                pitch = -18 * (u - 0.8) / 0.2
            elif u < 0.12:
                pitch = -10 * (1 - u / 0.12) if mv.y < 0 else 8 * (1 - u / 0.12)
        else:
            u = (p - duty) / (1 - duty)
            d = stride * (-0.5 + C.smooth01(u))
            z = lift * math.sin(math.pi * u) ** 1.2
            pitch = -18 * (1 - C.smooth01(min(u * 2.5, 1))) + (-10 if mv.y < 0 else 8) * C.smooth01(max(u * 2 - 1, 0))
        g = base + mv * d
        a = ankle_for((g.x, g.y), yaw, pitch)
        a.z += z
        feet[side] = (a, foot_w(yaw, pitch))
    # pelvis: highest at mid stance, sway over the stance foot
    mid = duty / 2
    pz = h0 + bob * math.cos(4 * math.pi * (ph - mid))
    px = -0.025 * math.cos(2 * math.pi * (ph - mid))
    roll = 3 * math.cos(2 * math.pi * (ph - mid))
    yaw = 5 * math.sin(2 * math.pi * (ph - mid)) * (1 if abs(mv.y) > 0.5 else 0.3)
    s = {
        'pelvis': (Vector((px, B.pel.y + 0.02 * mv.y, pz)), qe(z=yaw) @ qe(y=roll) @ qe(x=-lean * 0.4)),
        'E': {'spine_01': qe(x=-lean * 0.25, z=-yaw * 0.4, y=-roll * 0.5), 'spine_02': qe(x=-lean * 0.2, z=-yaw * 0.3),
              'spine_03': qe(x=-lean * 0.15, z=-yaw * 0.3), 'neck_01': qe(x=lean * 0.5), 'Head': qe(x=lean * 0.5),
              'clavicle_l': qe(y=-6), 'clavicle_r': qe(y=6)},
        'W': {'foot_l': feet['l'][1], 'foot_r': feet['r'][1]},
        'ik': dict(low_ready(), **{
            'leg_l': (feet['l'][0], Vector((-pole_out, 1, 0))),
            'leg_r': (feet['r'][0], Vector((pole_out, 1, 0))),
        }),
    }
    return s


def clip_walk_bwd(t, ph):
    return gait(ph, (0, -1), 1.1, 0.85, B.pel.z - 0.09, bob=0.015, lift=0.07)


def clip_crouch_bwd(t, ph):
    return gait(ph, (0, -1), 1.2, 0.62, 0.56, bob=0.012, lift=0.06, width=0.15, lean=34, pole_out=0.35, toe_out=14)


def strafe(ph, sgn):
    """Step-slide sideways (sgn +1 = right): lead foot steps out, trail foot closes; feet never cross."""
    S, w = 0.46, 0.20
    lead, trail = ('r', 'l') if sgn > 0 else ('l', 'r')
    def g(p, start, s0):
        u = min(max((p - s0) / 0.36, 0.0), 1.0)
        return start + S * C.smooth01(u), (math.sin(math.pi * u) if 0 < u < 1 else 0.0), u
    xl, ll, ul = g(ph, w / 2, 0.0)          # lead foot (ground x, measured along travel)
    xt, lt, ut = g(ph, -w / 2, 0.5)         # trail foot
    body = S * ph + S * 0.5 - 0.02          # body moves uniformly; centred between the feet on average
    feet = {}
    for side, x, lf, u in ((lead, xl, ll, ul), (trail, xt, lt, ut)):
        rel = (x - body) * sgn
        sx = -1 if side == 'l' else 1
        yaw = -sx * 6
        pitch = -12 * lf
        a = ankle_for((rel, 0.02 if side == 'l' else -0.02), yaw, pitch * 0.5)
        a.z += 0.07 * lf
        feet[side] = (a, foot_w(yaw, pitch * 0.5))
    spread = abs(feet['l'][0].x - feet['r'][0].x)
    pz = B.pel.z - 0.06 - 0.06 * max(spread - 0.25, 0)
    px = 0.5 * (feet['l'][0].x + feet['r'][0].x) * 0.25
    roll = 2 * math.sin(2 * math.pi * ph) * sgn
    return {
        'pelvis': (Vector((px, B.pel.y, pz)), qe(z=-8 * sgn) @ qe(y=roll)),
        'E': {'spine_01': qe(x=-3, z=3 * sgn, y=-roll * 0.5), 'spine_02': qe(x=-2, z=3 * sgn), 'spine_03': qe(z=2 * sgn),
              'clavicle_l': qe(y=-6), 'clavicle_r': qe(y=6)},
        'W': {'foot_l': feet['l'][1], 'foot_r': feet['r'][1]},
        'ik': dict(low_ready(), **{
            'leg_l': (feet['l'][0], Vector((-0.25, 1, 0))),
            'leg_r': (feet['r'][0], Vector((0.25, 1, 0))),
        }),
    }


# ---------------------------------------------------------------------------------------------- build

RIG = None
B = None


def author_keyposes():
    g = globals()
    g['STAND'] = stand_spec()
    g['PRONE0'] = prone_spec()
    g['KNEEL'] = kneel_spec(0.10, 16)
    g['KNEEL_UP'] = kneel_spec(0.0, 8)
    g['HANDS'] = hands_down_spec()
    low = prone_spec()
    low['pelvis'] = (Vector((0, PRONE_PY - 0.02, PRONE_PZ + 0.10)), qe(x=-80))
    low['ik']['leg_l'] = (Vector((-0.25, -0.62, 0.09)), Vector((-0.6, 0.3, -0.7)))
    low['ik']['leg_r'] = (Vector((0.25, -0.62, 0.09)), Vector((0.6, 0.3, -0.7)))
    low['ik']['arm_l'] = (Vector((-0.20, 0.78, 0.07)), Vector((-0.5, -0.5, -0.5)))
    low['ik']['arm_r'] = (Vector((0.22, 0.70, 0.09)), Vector((0.5, -0.5, -0.5)))
    g['LOWER'] = low
    g['PUSHUP'] = pushup_spec()
    g['KNEEL1'] = kneel_one_spec()
    build_death_keys()


AUTHORED = [
    # name, function, duration (s), loop
    ('Prone_Idle_Loop', clip_prone_idle, 4.0, True),
    ('Prone_Crawl_Loop', clip_prone_crawl, CRAWL_T, True),
    ('Stand_To_Prone', clip_stand_to_prone, 0.9, False),
    ('Prone_To_Stand', clip_prone_to_stand, 1.35, False),
    ('Wounded_Loop', clip_wounded, 4.0, True),
    ('Death02', clip_death02, 1.7, False),
    ('Death03', clip_death03, 1.7, False),
    ('Walk_Bwd_Loop', clip_walk_bwd, 1.1, True),
    ('Strafe_L_Loop', lambda t, ph: strafe(ph, -1), 0.8, True),
    ('Strafe_R_Loop', lambda t, ph: strafe(ph, 1), 0.8, True),
    ('Crouch_Bwd_Loop', clip_crouch_bwd, 1.2, True),
]


GROUND_FIX = ['Death01', 'LayToIdle', 'Roll', 'Hit_Knockback', 'Stand_To_Prone', 'Prone_To_Stand', 'Wounded_Loop',
              'Death02', 'Death03', 'Prone_Idle_Loop', 'Prone_Crawl_Loop']


def build_anims(arm, rig, only=None, body=None):
    global RIG, B
    RIG, B = rig, Body(rig)
    acts = {}
    if only is None or any(n in only for n in UAL1_CLIPS + UAL2_CLIPS):
        acts.update(C.retarget(arm, rig, C.UAL1, UAL1_CLIPS))
        acts.update(C.retarget(arm, rig, C.UAL2, UAL2_CLIPS))
    # relaxed fingers for authored clips: from the first frame of Idle_Loop
    base = {}
    idle = acts.get('Idle_Loop')
    if idle:
        C.pose_static(arm, idle, 0)
        for pb in arm.pose.bones:
            if any(k in pb.name for k in ('index', 'middle', 'ring', 'pinky', 'thumb')):
                base[pb.name] = pb.matrix_basis.copy()
        for pb in arm.pose.bones:
            pb.matrix_basis = Matrix.Identity(4)
    poser = C.Poser(rig, base)
    author_keyposes()
    for name, fn, dur, loop in AUTHORED:
        if only and name not in only:
            continue
        poser.warn = []
        acts[name] = C.bake_clip(arm, poser, name, fn, dur, cyclic=loop)
        if poser.warn:
            print('IK WARN', name, sorted(set(poser.warn))[:6])
    if body:
        for n in GROUND_FIX:
            if n in acts:
                l = C.ground_fix(arm, rig, body, acts[n])
                print('ground fix %-18s max lift %.3f' % (n, l))
    arm.animation_data_clear()
    return acts


def export_anims(path, arm):
    # the ACTIONS exporter only walks objects that have animation data; bind any action to start with
    arm.animation_data_create()
    act = bpy.data.actions.get('Idle_Loop')
    arm.animation_data.action = act
    if act.slots:
        arm.animation_data.action_slot = act.slots[0]
    bpy.ops.object.select_all(action='DESELECT')
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_yup=True,
                              export_animations=True, export_animation_mode='ACTIONS', export_force_sampling=True,
                              export_optimize_animation_size=True, export_anim_single_armature=True,
                              export_cameras=False, export_lights=False, export_skins=True,
                              export_def_bones=False, export_leaf_bone=False)


# ============================================================================================ textures (numpy)
import numpy as np
import tempfile

TMP = tempfile.mkdtemp(prefix='chars_')


def pnoise(size, scale, seed):
    """Tileable smooth noise (Gaussian-filtered white noise via FFT), normalised to 0..1."""
    rng = np.random.default_rng(seed)
    w = rng.standard_normal((size, size))
    f = np.fft.fftfreq(size)
    fx, fy = np.meshgrid(f, f)
    g = np.exp(-(fx ** 2 + fy ** 2) * (2 * math.pi * scale) ** 2 / 2)
    n = np.real(np.fft.ifft2(np.fft.fft2(w) * g))
    n -= n.min()
    return n / n.max()


def pixelate(a, b):
    s = a.shape[0]
    small = a[b // 2::b, b // 2::b]
    return np.kron(small, np.ones((b, b)))[:s, :s]


def ucp_texture(size=512, seed=7):
    """US Army Universal Camouflage Pattern: desert sand / urban grey / foliage green pixel pattern."""
    sand = np.array([0.60, 0.59, 0.53])
    grey = np.array([0.44, 0.45, 0.43])
    green = np.array([0.40, 0.43, 0.36])
    img = np.ones((size, size, 3)) * sand
    for blk, sc, th, col, sd in ((8, 14, 0.58, grey, 1), (4, 9, 0.60, green, 2), (4, 6, 0.66, grey, 3),
                                 (4, 5, 0.68, sand * 1.04, 4), (2, 3, 0.72, green, 5)):
        n = pixelate(pnoise(size, sc, seed * 10 + sd), blk)
        img[n > th] = col
    img *= (0.96 + 0.08 * pnoise(size, 1.0, seed + 99))[..., None]
    return np.clip(img, 0, 1)


def check_texture(size, base, line, seed=3, cell=16):
    """Keffiyeh/shemagh: net of lines plus small motifs, slightly irregular weave."""
    y, x = np.mgrid[0:size, 0:size]
    lw = max(3, cell // 3)
    m = ((x % cell) < lw) | ((y % cell) < lw)
    c = cell // 2
    m |= (((x + c // 2) % cell < c // 2 + 2) & ((x + c // 2) % cell > c // 2 - 2) &
          ((y + c // 2) % cell < c // 2 + 2) & ((y + c // 2) % cell > c // 2 - 2))
    m |= ((x + y) % cell == 0) & ((x // cell + y // cell) % 2 == 0)
    img = np.where(m[..., None], np.array(line), np.array(base))
    img = img * (0.92 + 0.10 * pnoise(size, 2.0, seed))[..., None]
    return np.clip(img, 0, 1)


def plain_texture(rgb, size=256, seed=1, var=0.10):
    y, x = np.mgrid[0:size, 0:size]
    weave = 0.5 + 0.5 * np.sin(x * math.pi / 2) * np.sin(y * math.pi / 2)
    n = pnoise(size, 6, seed) * 0.6 + pnoise(size, 1.5, seed + 1) * 0.4
    img = np.array(rgb) * (1 - var + var * (0.6 * n + 0.4 * weave))[..., None]
    return np.clip(img, 0, 1)


def img(name, arr):
    return C.np_image(name, arr.astype(np.float32), os.path.join(TMP, name + '.jpg'))


_skin_src = {}


def skin_material(tint, name='skin'):
    if 'col' not in _skin_src:
        _skin_src['col'] = C.load_np(os.path.join(C.UBC_TEX, 'T_Superhero_Male_Dark.png'), 1024)
    a = _skin_src['col'] * np.array(tint)
    nimg = bpy.data.images.load(os.path.join(C.UBC_DIR, 'T_Superhero_Male_Normal.png'))
    nimg.scale(512, 512)
    return C.tex_mat(name, img(name + '_col', np.clip(a, 0, 1)), rough=0.55, normal=nimg)


# ============================================================================================ characters

def mats_cache():
    return {}


def cloth(name, rgb=None, tex=None, rough=0.85, seed=1):
    if tex is None:
        tex = plain_texture(rgb, seed=seed)
    return C.tex_mat('cloth_' + name, img('tex_' + name, tex), rough=rough)


SKIN_TONES = {
    'us_rifleman': (1.0, 0.97, 0.95),
    'us_rifleman_b': (0.50, 0.40, 0.34),
    'insurgent_a': (0.68, 0.58, 0.50),
    'insurgent_b': (0.62, 0.52, 0.44),
    'insurgent_c': (0.72, 0.62, 0.54),
    'civilian_a': (0.66, 0.56, 0.47),
}


def base_zones(bd, top='top', trousers='trousers', hands_x=0.672):
    x, y, z = bd.fc.T
    ax = np.abs(x)
    zn = np.full(len(z), top, dtype=object)
    head = bd.freg == 'head'
    zn[head] = 'skin'
    zn[head & (z < 1.525)] = 'collar'
    arms = bd.freg == 'arms'
    zn[arms & (ax >= hands_x)] = 'hand'
    zn[(bd.freg == 'torso') & (z < 0.97)] = trousers
    zn[bd.freg == 'legs'] = trousers
    return zn, x, y, z, ax, head


def eye_band(x, y, z, ax, wide=False):
    lo, hi = (1.638, 1.712) if wide else (1.645, 1.703)
    return (z > lo) & (z < hi) & (y > 0.03) & (ax < (0.082 if wide else 0.076))


def spine_w(co):
    z = co.z
    def ss(a, b, t):
        u = min(max((t - a) / (b - a), 0.0), 1.0)
        return u * u * (3 - 2 * u)
    w3 = ss(1.20, 1.32, z)
    w1 = 1 - ss(1.05, 1.17, z)
    wp = 1 - ss(0.96, 1.04, z)
    w1 = max(w1 - wp, 0)
    w2 = max(1 - w3 - w1 - wp, 0)
    return {'spine_03': w3, 'spine_02': w2, 'spine_01': w1, 'pelvis': wp}


def rigid_spine(o, arm):
    c = sum((v.co for v in o.data.vertices), Vector()) / max(len(o.data.vertices), 1)
    w = spine_w(c)
    return C.rigid_bind(o, arm, max(w, key=w.get))


def semi_spine(o, arm):
    C.set_weights(o, spine_w)
    return C.bind(o, arm)


def hit(bvh, p, d):
    """Surface point along ray from p in direction d (None if no hit)."""
    h = bvh.ray_cast(Vector(p), Vector(d).normalized(), 3.0)
    return h[0]


def skirt(bd, mat, z0=1.0, z1=0.34, flare=0.07):
    zs = list(np.linspace(z0, z1, 9))
    bvh = C.body_bvh(bd, (bd.freg == 'legs') | ((bd.freg == 'torso') & (bd.fc[:, 2] < 1.05)))
    def tuck(x, y, z, th):
        # pull the top rings in so the skirt tucks under the robe's torso instead of leaving a ledge
        u = min(max((z0 - z) / 0.14, 0.0), 1.0)
        k = 1.0 - 0.10 * (1 - u) ** 2
        return (x * k, -0.02 + (y + 0.02) * k, z)
    o = C.ring_shell('skirt', zs, lambda z: (0.0, -0.02),
                     lambda z, th: (0.15 + flare * (z0 - z)) * (1.0 if abs(math.cos(math.radians(th))) < 0.7 else 0.8),
                     nseg=28, bvh=bvh, margin=0.04, smooth=4, post=tuck)
    o.data.materials.append(mat)
    C.solidify(o, 0.006)
    def w(co):
        t = min(max((z0 - 0.06 - co.z) / 0.45, 0.0), 1.0)      # 0 at the waist, 1 at the knees
        back = max(0.0, -co.y) / 0.2
        centre = 1.0 - min(abs(co.x) / 0.15, 1.0)          # front/back middle: shared by both legs, stiffer
        wp = max(1.0 - t * (0.78 - 0.30 * centre - 0.20 * min(back, 1.0)), 0.22)
        side = min(max(0.5 - co.x / 0.30, 0.0), 1.0)           # 1 = left (x < 0), wide blend: no tear
        rest = 1 - wp
        return {'pelvis': wp, 'thigh_l': rest * side, 'thigh_r': rest * (1 - side)}
    C.set_weights(o, w)
    return C.bind(o, bd.arm)


def type56(bd, arm, canvas, dark, n_pockets=3, z0=1.06, z1=1.30):
    """Chinese Type 56 style chest rig: canvas panel with big AK magazine pockets, shoulder straps, waist strap."""
    out = []
    bvh = C.body_bvh(bd, bd.freg == 'torso')
    panel = C.ring_shell('rig_panel', list(np.linspace(z0, z1, 5)), lambda z: (0.0, -0.01),
                         lambda z, th: 0.10, theta=(-58, 58), nseg=12, bvh=bvh, margin=0.012, smooth=2)
    panel.data.materials.append(canvas)
    C.solidify(panel, 0.008)
    out.append(semi_spine(panel, arm))
    pb = BVHTree.FromObject(panel, bpy.context.evaluated_depsgraph_get())
    xs = {3: (-0.078, 0.0, 0.078), 4: (-0.105, -0.035, 0.035, 0.105)}[n_pockets]
    pw = 0.072 if n_pockets == 3 else 0.064
    for i, x in enumerate(xs):
        zc = (z0 + z1) / 2 - 0.02
        f = hit(pb, (x, 0.6, zc), (0, -1, 0))
        yf = f.y if f else 0.14
        out.append(rigid_spine(C.gbox('mag%d' % i, (pw, 0.05, 0.17), Vector((x, yf + 0.024, zc)), canvas, rot=(-8, 0, 0), bevel=0.008, segs=2), arm))
        out.append(rigid_spine(C.gbox('flap%d' % i, (pw + 0.006, 0.054, 0.035), Vector((x, yf + 0.03, zc + 0.08)), canvas, rot=(-8, 0, 0), bevel=0.006), arm))
    for sx in (-1, 1):
        f = hit(pb, (sx * 0.17, 0.6, z0 + 0.06), (0, -1, 0))
        yf = f.y if f else 0.1
        out.append(rigid_spine(C.gbox('gren', (0.045, 0.04, 0.085), Vector((sx * 0.165, yf + 0.018, z0 + 0.07)), canvas, bevel=0.006), arm))
    # straps: from the panel top over the shoulders, crossing on the back down to the waist strap
    for sx in (-1, 1):
        top = hit(bvh, (sx * 0.10, -0.02, 2.0), (0, 0, -1))
        tz = (top.z if top else 1.50) + 0.012
        fr = hit(bvh, (sx * 0.085, 0.6, z1), (0, -1, 0))
        bk = hit(bvh, (sx * 0.06, -0.6, 1.30), (0, 1, 0))
        bk2 = hit(bvh, (-sx * 0.12, -0.6, z0 + 0.02), (0, 1, 0))
        pts = [(sx * 0.085, (fr.y if fr else 0.12) + 0.012, z1 - 0.01), (sx * 0.10, 0.05, tz - 0.02), (sx * 0.10, -0.03, tz),
               (sx * 0.09, -0.11, tz - 0.05), (sx * 0.05, (bk.y if bk else -0.15) - 0.012, 1.30),
               (-sx * 0.12, (bk2.y if bk2 else -0.13) - 0.012, z0 + 0.02)]
        s = C.strap('rig_strap', pts, 0.035, 0.005, lambda p: (p.x * 0.2, p.y, 0.4 if p.z > 1.4 else 0.0), dark)
        out.append(semi_spine(s, arm))
    belt = C.ring_shell('rig_belt', [z0 - 0.005, z0 + 0.03], lambda z: (0.0, -0.01), lambda z, th: 0.1,
                        theta=(55, 305), nseg=16, bvh=bvh, margin=0.012, smooth=1)
    belt.data.materials.append(dark)
    C.solidify(belt, 0.005)
    out.append(semi_spine(belt, arm))
    return out


def head_wrap_extras(bd, arm, mat):
    out = []
    knot = C.gsphere('knot', 0.032, (0.03, -0.12, 1.69), mat, scale=(1.2, 0.8, 0.9), seg=12, rings=6)
    tail = C.strap('tail', [(0.035, -0.125, 1.68), (0.045, -0.14, 1.60), (0.05, -0.15, 1.53)], 0.07, 0.012,
                   lambda p: (0, -1, 0), mat)
    for o in (knot, tail):
        C.box_uv(o, 0.25)
        out.append(C.rigid_bind(o, arm, 'Head'))
    return out


def hair_image():
    im = bpy.data.images.get('hair_rgba')
    if im:
        return im
    col = C.load_np(os.path.join(C.UBC_DIR, 'T_Hair_1_BaseColor.png'), 256)
    nimg = bpy.data.images.load(os.path.join(C.UBC_DIR, 'T_Hair_1_Normal.png'))
    nimg.scale(256, 256)
    a = np.empty(256 * 256 * 4, np.float32)
    nimg.pixels.foreach_get(a)
    bpy.data.images.remove(nimg)
    alpha = a.reshape(256, 256, 4)[::-1, :, 3]
    rgba = np.concatenate([np.clip(col * np.array([0.30, 0.22, 0.16]), 0, 1), alpha[..., None]], 2).astype(np.float32)
    im = bpy.data.images.new('hair_rgba', 256, 256, alpha=True)
    im.pixels.foreach_set(np.ascontiguousarray(rgba[::-1]).ravel())
    path = os.path.join(TMP, 'hair_rgba.png')
    im.filepath_raw = path
    im.file_format = 'PNG'
    im.save()
    im.reload()
    return im


def build_char(cid):
    C.reset()
    arm, meshes = C.load_base()
    body, eyes, brows = meshes['SuperHero_Male'], meshes['Eyes'], meshes['Eyebrows']
    for o in (body, eyes, brows):
        for a in list(o.data.color_attributes):
            o.data.color_attributes.remove(a)
        while len(o.data.uv_layers) > 1:
            o.data.uv_layers.remove(o.data.uv_layers[-1])
    for im in list(bpy.data.images):
        if im.size[0] > 512:
            im.scale(512, 512)
    # the glTF import splits vertices along UV seams: weld them so offset cloth has no cracks
    bm = bmesh.new()
    bm.from_mesh(body.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bm.to_mesh(body.data)
    bm.free()
    bd = C.BodyData(body)
    bd.arm = arm
    RIGB['ball_y'] = arm.data.bones['ball_l'].head_local.y
    RIGB['ankle_y'] = arm.data.bones['foot_l'].head_local.y
    skin = skin_material(SKIN_TONES[cid])
    gear = {'head': [], 'torso': [], 'arms': [], 'legs': []}
    kind = cid.split('_b')[0] if cid.startswith('us_') else cid
    BUILDERS[kind](bd, arm, skin, gear)
    hide = getattr(bd, 'hide', None)
    if hide is not None and hide.any():
        bm = bmesh.new()
        bm.from_mesh(body.data)
        bm.faces.ensure_lookup_table()
        bmesh.ops.delete(bm, geom=[bm.faces[i] for i in np.nonzero(hide)[0]], context='FACES')
        bm.to_mesh(body.data)
        bm.free()
    parts = C.split_parts(body, arm)
    parts['head'] = C.join([parts['head'], eyes, brows] + gear['head'], 'part_head')
    for k in ('torso', 'arms', 'legs'):
        parts[k] = C.join([parts[k]] + gear[k], 'part_' + k)
    # hair/eyebrow normal maps add MBs for nothing at game distance; then shrink every source image to
    # <= 512 px and re-save it so the exporter embeds the small copy
    for m in bpy.data.materials:
        if m.use_nodes and m.name.startswith('MI_'):
            for n in list(m.node_tree.nodes):
                if n.type == 'NORMAL_MAP' or (n.type == 'TEX_IMAGE' and n.image and 'Normal' in n.image.name):
                    m.node_tree.nodes.remove(n)
        if m.use_nodes and m.name.startswith('MI_Hair'):
            # UBC hair: colour in T_Hair_1_BaseColor (light grey, tinted by the original shader), alpha in the
            # alpha channel of T_Hair_1_Normal. Bake one small RGBA texture: dark brown hair with alpha cut-out.
            im = hair_image()
            nt = m.node_tree
            nt.nodes.clear()
            out = nt.nodes.new('ShaderNodeOutputMaterial')
            bs = nt.nodes.new('ShaderNodeBsdfPrincipled')
            t = nt.nodes.new('ShaderNodeTexImage')
            t.image = im
            nt.links.new(t.outputs['Color'], bs.inputs['Base Color'])
            nt.links.new(t.outputs['Alpha'], bs.inputs['Alpha'])
            bs.inputs['Roughness'].default_value = 0.8
            nt.links.new(bs.outputs['BSDF'], out.inputs['Surface'])
            m.blend_method = 'HASHED'
    for im in list(bpy.data.images):
        if im.users == 0 or im.filepath.startswith(TMP) or im.size[0] == 0:
            continue
        if im.size[0] > 512:
            im.scale(512, 512)
        path = os.path.join(TMP, im.name.replace('.', '_') + '.png')
        st = bpy.context.scene.render.image_settings
        st.file_format, st.color_mode, st.color_depth, st.compression = 'PNG', 'RGBA', '8', 100
        im.save_render(path)
        im.filepath = path
        im.reload()
    for o in parts.values():
        C.bind(o, arm)
        # drop unused material slots
        used = {p.material_index for p in o.data.polygons}
        for i in reversed(range(len(o.data.materials))):
            if i not in used:
                C.set_active(o)
                o.active_material_index = i
                bpy.ops.object.material_slot_remove()
    return arm, parts


# ---------------------------------------------------------------------------------------------- US rifleman

def build_us(bd, arm, skin, gear):
    ucp = img('tex_ucp', ucp_texture())
    acu = C.tex_mat('acu_ucp', ucp, rough=0.9)
    iotv = C.tex_mat('iotv_ucp', ucp, rough=0.8)
    boot = C.flat_mat('boot_tan_suede', (0.66, 0.58, 0.45), 0.95)
    sole = C.flat_mat('boot_sole', (0.26, 0.22, 0.17), 0.9)
    glove = C.flat_mat('glove_coyote', (0.50, 0.45, 0.36), 0.9)
    palm = C.flat_mat('glove_palm', (0.27, 0.24, 0.20), 0.7)
    black = C.flat_mat('black_nylon', (0.04, 0.04, 0.04), 0.6)
    lens = C.flat_mat('goggle_lens', (0.05, 0.05, 0.06), 0.15)
    tan = C.flat_mat('webbing_tan', (0.55, 0.50, 0.40), 0.9)
    zn, x, y, z, ax, head = base_zones(bd, 'top', 'trousers')
    legs = bd.freg == 'legs'
    zn[legs & (z < 0.29)] = 'blouse'
    zn[legs & (z < 0.17)] = 'skin'          # hidden under the modelled boot
    zn[(bd.freg == 'arms') & (ax >= 0.64) & (ax < 0.672)] = 'cuff'
    zn[(bd.freg == 'arms') & (ax >= 0.672) & (bd.fn[:, 2] < -0.45)] = 'palm'     # palm / finger pads (T-pose: palms down)
    spec = {'skin': ('skin', 0, 0), 'collar': ('acu', 0.016, 4), 'top': ('acu', 0.019, 10), 'trousers': ('acu', 0.015, 8),
            'blouse': ('acu', 0.030, 4), 'hand': ('glove', 0.005, 0), 'palm': ('palm', 0.005, 0), 'cuff': ('glove', 0.012, 0)}
    C.apply_zones(bd, zn, spec, {'skin': skin, 'acu': acu, 'glove': glove, 'palm': palm})
    footwear(bd, arm, gear, 'boot', boot, sole, lace=C.flat_mat('boot_laces', (0.42, 0.35, 0.25), 0.9),
             collar=C.flat_mat('boot_collar', (0.50, 0.42, 0.31), 0.9))
    torso = (bd.freg == 'torso')
    bvh = C.body_bvh(bd, torso)
    # IOTV: full wrap below the armpits, front and back panels above, collar, shoulder straps
    ctr = lambda zz: (0.0, -0.015)
    low = C.ring_shell('iotv', list(np.linspace(0.975, 1.33, 7)), ctr, lambda zz, th: 0.12, nseg=32, bvh=bvh, margin=0.028, smooth=4)
    fp = C.ring_shell('iotv_front', list(np.linspace(1.31, 1.455, 3)), ctr, lambda zz, th: 0.1, theta=(-52, 52), nseg=10, bvh=bvh, margin=0.028, smooth=2)
    bp = C.ring_shell('iotv_back', list(np.linspace(1.31, 1.47, 3)), ctr, lambda zz, th: 0.1, theta=(128, 232), nseg=10, bvh=bvh, margin=0.028, smooth=2)
    hb = C.body_bvh(bd, torso | head)
    col = C.ring_shell('iotv_collar', [1.455, 1.50, 1.535], lambda zz: (0.0, -0.035), lambda zz, th: 0.07, theta=(35, 325), nseg=16, bvh=hb, margin=0.022, smooth=2)
    for o in (low, fp, bp, col):
        o.data.materials.append(iotv)
        C.solidify(o, 0.014)
        gear['torso'].append(semi_spine(o, arm))
    vb = BVHTree.FromPolygons([v.co for v in low.data.vertices], [list(p.vertices) for p in low.data.polygons])
    fb = BVHTree.FromPolygons([v.co for v in fp.data.vertices], [list(p.vertices) for p in fp.data.polygons])
    for sx in (-1, 1):
        top = hit(bvh, (sx * 0.105, -0.02, 2.0), (0, 0, -1))
        tz = (top.z if top else 1.50) + 0.03
        f = hit(fb, (sx * 0.1, 0.6, 1.44), (0, -1, 0))
        pts = [(sx * 0.10, (f.y if f else 0.13), 1.44), (sx * 0.105, 0.04, tz - 0.012), (sx * 0.105, -0.03, tz),
               (sx * 0.10, -0.10, tz - 0.03), (sx * 0.10, -0.17, 1.45)]
        s = C.strap('iotv_strap', pts, 0.07, 0.012, lambda p: (p.x * 0.3, p.y * 0.6, 0.5), iotv)
        C.box_uv(s)
        gear['torso'].append(semi_spine(s, arm))
    # pouches on the front: three double M4 pouches, IFAK, admin; radio on the left side; grenade right
    def front(xx, zz):
        h = hit(vb, (xx, 0.6, zz), (0, -1, 0)) or hit(fb, (xx, 0.6, zz), (0, -1, 0))
        return h.y if h else 0.16
    items = []
    for i, xx in enumerate((-0.085, 0.0, 0.085)):
        yf = front(xx, 1.08)
        items.append(C.gbox('mag', (0.078, 0.048, 0.12), Vector((xx, yf + 0.024, 1.08)), iotv, bevel=0.008, segs=2))
        items.append(C.gbox('flap', (0.082, 0.052, 0.03), Vector((xx, yf + 0.027, 1.14)), iotv, bevel=0.006))
    yf = front(0.0, 1.27)
    items.append(C.gbox('admin', (0.13, 0.03, 0.10), Vector((0.0, yf + 0.015, 1.27)), iotv, bevel=0.008, segs=2))
    yf = front(0.11, 1.20)
    items.append(C.gbox('ifak', (0.08, 0.045, 0.07), Vector((0.11, yf + 0.02, 1.20)), iotv, bevel=0.01, segs=2))
    h = hit(vb, (-0.6, -0.02, 1.16), (1, 0, 0))
    sxl = h.x if h else -0.19
    items.append(C.gbox('radio', (0.05, 0.075, 0.15), Vector((sxl - 0.024, -0.03, 1.16)), iotv, bevel=0.008, segs=2))
    items.append(C.gcyl('antenna', 0.004, 0.22, Vector((sxl - 0.03, -0.05, 1.33)), black))
    h = hit(vb, (0.6, -0.02, 1.12), (-1, 0, 0))
    sxr = h.x if h else 0.19
    items.append(C.gbox('gren', (0.045, 0.06, 0.08), Vector((sxr + 0.02, 0.02, 1.12)), iotv, bevel=0.008, segs=2))
    # side plate carriers
    for sx, xx in ((-1, sxl), (1, sxr)):
        items.append(C.gbox('sideplate', (0.02, 0.15, 0.17), Vector((xx + sx * 0.004, -0.04, 1.06)), iotv, bevel=0.006))
    # CamelBak on the back
    h = hit(vb, (0, -0.6, 1.20), (0, 1, 0))
    yb = h.y if h else -0.2
    items.append(C.gbox('camelbak', (0.20, 0.06, 0.36), Vector((0, yb - 0.028, 1.24)), iotv, bevel=0.025, segs=3))
    items.append(C.gcyl('hose', 0.006, 0.30, Vector((0.12, yb + 0.10, 1.40)), black, rot=(-60, 0, -20)))
    for o in items:
        C.box_uv(o)
        gear['torso'].append(rigid_spine(o, arm))
    # rigger's belt
    belt = C.ring_shell('belt', [0.95, 0.99], ctr, lambda zz, th: 0.1, nseg=24, bvh=C.body_bvh(bd, torso | (bd.freg == 'legs')), margin=0.006, smooth=1)
    belt.data.materials.append(tan)
    gear['torso'].append(semi_spine(belt, arm))
    # ACH helmet in a UCP cover with NVG shroud and goggles
    hc = Vector((0.0, 0.004, 1.668))
    rx, ry, rz = 0.118, 0.134, 0.128
    def rim(th):
        c = math.cos(math.radians(th))
        r = 1.700 - (1.700 - 1.628) * (1 - c) / 2
        return r + 0.018 * math.sin(math.radians(th)) ** 8   # ear cut-outs
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=32, v_segments=16, radius=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * rx, v.co.y * ry, v.co.z * rz)) + hc
    kill = [v for v in bm.verts if v.co.z < rim(math.degrees(math.atan2(v.co.x, v.co.y - hc.y))) - 0.004]
    bmesh.ops.delete(bm, geom=kill, context='VERTS')
    me = bpy.data.meshes.new('helmet')
    bm.to_mesh(me)
    bm.free()
    helm = bpy.data.objects.new('helmet', me)
    bpy.context.scene.collection.objects.link(helm)
    for p in me.polygons:
        p.use_smooth = True
    me.materials.append(acu)
    C.solidify(helm, 0.012, offset=1.0)
    C.box_uv(helm, 0.3)
    hp = [helm]
    hp.append(C.gbox('nvg_mount', (0.05, 0.022, 0.045), Vector((0, hc.y + ry + 0.006, 1.712)), black, rot=(12, 0, 0), bevel=0.004))
    band = []
    for i in range(33):
        th = -180 + i * 360 / 32
        t = math.radians(th)
        zz = rim(th) + 0.045 - 0.012 * math.cos(t)
        k = max(1 - ((zz - hc.z) / rz) ** 2, 0) ** 0.5
        band.append((hc.x + (rx * k + 0.013) * math.sin(t), hc.y + (ry * k + 0.013) * math.cos(t), zz))
    hp.append(C.strap('goggle_band', band[:-1], 0.022, 0.004, lambda p: (p.x - hc.x, p.y - hc.y, 0), black, closed=True))
    gl = [p for p in band if p[1] > hc.y + 0.06]
    gl.sort(key=lambda p: p[0])
    hp.append(C.strap('goggles', [(p[0], p[1] + 0.004, p[2] + 0.006) for p in gl], 0.04, 0.012, lambda p: (p.x - hc.x, p.y - hc.y, 0.5), lens))
    for o in hp:
        gear['head'].append(C.rigid_bind(o, arm, 'Head'))
    hair = C.load_hair('Hair_Buzzed', arm)
    gear['head'].append(hair)


# ---------------------------------------------------------------------------------------------- insurgents / civilian

RIGB = {}


def _hull2d(pts):
    pts = sorted(set(pts))
    if len(pts) < 3:
        return pts
    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo, hi = [], []
    for p in pts:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0:
            lo.pop()
        lo.append(p)
    for p in reversed(pts):
        while len(hi) >= 2 and cross(hi[-2], hi[-1], p) <= 0:
            hi.pop()
        hi.append(p)
    return lo[:-1] + hi[:-1]


def _foot_bone(co):
    by = RIGB['ball_y']
    return 'ball' if co.y > by - 0.01 else 'foot'


def _bind_foot(o, arm, side):
    """100% foot_x / ball_x per vertex (by position along the foot)."""
    def w(co):
        return {('%s_%s' % (_foot_bone(co), side)): 1.0}
    C.set_weights(o, w)
    return C.bind(o, arm)


def _foot_verts(bd, side, top):
    sx = -1 if side == 'l' else 1
    m = (np.array([C.region_of(b) == 'legs' for b in bd.vdom])) & (bd.co[:, 2] < top) & (bd.co[:, 0] * sx > 0.02)
    return bd.co[m]


def _hull_obj(name, pts, inflate):
    bm = bmesh.new()
    for p in pts:
        bm.verts.new(p)
    res = bmesh.ops.convex_hull(bm, input=bm.verts, use_existing_faces=False)
    for g in res.get('geom_interior', []) + res.get('geom_unused', []):
        if isinstance(g, bmesh.types.BMVert) and g.is_valid:
            bm.verts.remove(g)
    bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=1, use_grid_fill=True)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    for it in range(3):
        bmesh.ops.smooth_vert(bm, verts=bm.verts[:], factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.normal_update()
    for v in bm.verts:
        v.co += v.normal * inflate
    return bm


def boot_mesh(name, pts, inflate, sole_h, upper, sole, shaft_top=None):
    """Footwear: convex hull of the foot (subdivided, smoothed, inflated) with a flat sole cut cleanly at sole_h
    and a slight welt; for boots a second hull forms the shaft up to shaft_top."""
    foot = [p for p in pts if p.z < 0.085]
    bm = _hull_obj(name, foot, inflate)
    for v in bm.verts:
        v.co.z = max(v.co.z, 0.0)
        if v.co.z < 0.008:
            v.co.z = 0.0
    geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
    bmesh.ops.bisect_plane(bm, geom=geom, plane_co=(0, 0, sole_h), plane_no=(0, 0, 1))
    cx = sum(v.co.x for v in bm.verts) / len(bm.verts)
    cy = sum(v.co.y for v in bm.verts) / len(bm.verts)
    for v in bm.verts:
        if v.co.z < sole_h + 1e-4:
            d = Vector((v.co.x - cx, v.co.y - cy, 0))
            if d.length > 1e-6:
                v.co += d.normalized() * 0.004
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    me.materials.append(upper)
    me.materials.append(sole)
    for p in me.polygons:
        p.use_smooth = True
        p.material_index = 1 if p.center.z < sole_h else 0
    if shaft_top:
        sh = [p for p in pts if 0.04 < p.z < shaft_top]
        bm = _hull_obj(name + '_shaft', sh, inflate)
        for v in bm.verts:
            v.co.z = max(v.co.z, sole_h + 0.01)
        me2 = bpy.data.meshes.new(name + '_shaft')
        bm.to_mesh(me2)
        bm.free()
        o2 = bpy.data.objects.new(name + '_shaft', me2)
        bpy.context.scene.collection.objects.link(o2)
        me2.materials.append(upper)
        for p in me2.polygons:
            p.use_smooth = True
        o = C.join([o, o2], name)
    return o


def footwear(bd, arm, gear, kind, upper, sole, lace=None, collar=None):
    """kind: 'boot' (combat boot to mid-calf), 'sneaker', 'sandal'."""
    for side in ('l', 'r'):
        sx = -1 if side == 'l' else 1
        if kind == 'sandal':
            pts = _foot_verts(bd, side, 0.09)
            hull = _hull2d([(round(p[0], 4), round(p[1], 4)) for p in pts])
            cx = sum(p[0] for p in hull) / len(hull)
            cy = sum(p[1] for p in hull) / len(hull)
            ring = []
            for x, y in hull:
                d = Vector((x - cx, y - cy)).normalized()
                ring.append((x + d.x * 0.006, y + d.y * 0.006))
            bm = bmesh.new()
            bot = [bm.verts.new((x, y, 0.0)) for x, y in ring]
            top = [bm.verts.new((x, y, 0.017)) for x, y in ring]
            bm.faces.new(bot[::-1])
            bm.faces.new(top)
            for i in range(len(ring)):
                j = (i + 1) % len(ring)
                bm.faces.new((bot[i], bot[j], top[j], top[i]))
            bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
            me = bpy.data.meshes.new('sandal_sole')
            bm.to_mesh(me)
            bm.free()
            o = bpy.data.objects.new('sandal_sole', me)
            bpy.context.scene.collection.objects.link(o)
            me.materials.append(sole)
            gear['legs'].append(_bind_foot(o, arm, side))
            fb = C.body_bvh(bd, bd.freg == 'legs')
            for ys in (RIGB['ball_y'] + 0.012, RIGB['ankle_y'] + 0.075):
                arch = []
                for k in range(13):
                    th = math.radians(k * 15)
                    d = Vector((math.cos(th), 0, math.sin(th)))
                    h = hit(fb, (cx, ys, 0.028), d)
                    if h:
                        arch.append(tuple(h + d * 0.003))
                if len(arch) > 3:
                    arch = [(arch[0][0], ys, 0.016)] + arch + [(arch[-1][0], ys, 0.016)]
                    st = C.strap('sandal_strap', arch, 0.02, 0.004, lambda p, c=Vector((cx, ys, 0.028)): (p - c), upper)
                    gear['legs'].append(_bind_foot(st, arm, side))
            continue
        top = 0.205 if kind == 'boot' else 0.105
        pts = [Vector(p) for p in _foot_verts(bd, side, top)]
        o = boot_mesh(kind, pts, 0.008 if kind == 'boot' else 0.006, 0.03 if kind == 'boot' else 0.022, upper, sole,
                      shaft_top=top if kind == 'boot' else None)
        bb = BVHTree.FromObject(o, bpy.context.evaluated_depsgraph_get())
        cx = sum(p.x for p in pts) / len(pts)
        cy = sum(p.y for p in pts if p.z > 0.15) / max(1, len([p for p in pts if p.z > 0.15])) if kind == 'boot' else RIGB['ankle_y']
        if lace is not None:
            lp = []
            for zz in ((0.185, 0.15, 0.11) if kind == 'boot' else (0.085,)):
                h = hit(bb, (cx, 0.5, zz), (0, -1, 0))
                if h:
                    lp.append(tuple(h + Vector((0, 0.002, 0))))
            for yy in (0.0, 0.035, 0.065):
                h = hit(bb, (cx, yy, 0.5), (0, 0, -1))
                if h:
                    lp.append(tuple(h + Vector((0, 0, 0.002))))
            if len(lp) > 2:
                ls = C.strap('laces', lp, 0.026, 0.004, lambda p: (0, 0.6, 0.8), lace)
                gear['legs'].append(_bind_foot(ls, arm, side))
        if collar is not None:
            ring = []
            for k in range(16):
                t = math.radians(k * 22.5)
                d = Vector((math.sin(t), math.cos(t), 0))
                h = hit(bb, (cx, cy, 0.19), d)
                if h:
                    ring.append(tuple(h + d * 0.002))
            if len(ring) > 8:
                cs = C.strap('boot_collar', ring, 0.025, 0.007, lambda p, c=Vector((cx, cy, 0.19)): (p - c), collar, closed=True)
                gear['legs'].append(_bind_foot(cs, arm, side))
        gear['legs'].append(_bind_foot(o, arm, side))
    # hide the bare feet under closed footwear
    if kind != 'sandal':
        hz = 0.17 if kind == 'boot' else 0.075
        bd.hide = (bd.freg == 'legs') & (bd.fc[:, 2] < hz)


def feet_sandals(zn, bd, z, y, ax):
    legs = bd.freg == 'legs'
    feet = legs & (z < 0.10)
    zn[feet] = 'skin'


def build_insurgent_a(bd, arm, skin, gear):
    robe = cloth('robe_grey', (0.62, 0.61, 0.57), seed=11)
    trs = cloth('trousers_a', (0.36, 0.34, 0.31), seed=12)
    wrap = C.tex_mat('shemagh_red', img('tex_shemagh_red', check_texture(256, (0.90, 0.88, 0.83), (0.66, 0.06, 0.07), cell=10)), rough=0.9)
    sole = C.flat_mat('sandal_sole', (0.18, 0.14, 0.10), 0.8)
    strapm = C.flat_mat('sandal_leather', (0.30, 0.20, 0.12), 0.7)
    canvas = cloth('canvas_khaki', (0.55, 0.50, 0.36), seed=13)
    dark = C.flat_mat('webbing_khaki', (0.45, 0.40, 0.29), 0.9)
    zn, x, y, z, ax, head = base_zones(bd, 'robe', 'trousers')
    zn[head] = 'wrap'
    zn[head & eye_band(x, y, z, ax)] = 'skin'
    feet_sandals(zn, bd, z, y, ax)
    spec = {'skin': ('skin', 0, 0), 'wrap': ('cloth_wrap', 0.02, 10), 'collar': ('cloth_wrap', 0.024, 6), 'robe': ('cloth_robe', 0.022, 10),
            'trousers': ('cloth_trs', 0.012, 6), 'hand': ('skin', 0, 0), 'sole': ('sole', 0.004, 0), 'strap': ('strap', 0.004, 0)}
    C.apply_zones(bd, zn, spec, {'skin': skin, 'cloth_wrap': wrap, 'cloth_robe': robe, 'cloth_trs': trs, 'sole': sole, 'strap': strapm}, tile=0.25)
    footwear(bd, arm, gear, 'sandal', strapm, sole)
    gear['legs'].append(skirt(bd, robe))
    gear['torso'] += type56(bd, arm, canvas, dark)
    gear['head'] += head_wrap_extras(bd, arm, wrap)


def build_insurgent_b(bd, arm, skin, gear):
    jacket = cloth('track_navy', (0.09, 0.10, 0.16), seed=21, rough=0.6)
    stripe = C.flat_mat('track_stripe', (0.85, 0.85, 0.85), 0.6)
    trs = cloth('trousers_b', (0.13, 0.13, 0.14), seed=22)
    wrap = C.tex_mat('shemagh_bw', img('tex_shemagh_bw', check_texture(256, (0.88, 0.88, 0.86), (0.05, 0.05, 0.06), seed=5, cell=14)), rough=0.9)
    shoe = C.flat_mat('sneaker', (0.70, 0.70, 0.68), 0.7)
    sole = C.flat_mat('sneaker_sole', (0.20, 0.20, 0.20), 0.8)
    leather = C.flat_mat('bandolier', (0.27, 0.22, 0.14), 0.7)
    zn, x, y, z, ax, head = base_zones(bd, 'jacket', 'trousers')
    zn[head] = 'wrap'
    zn[head & eye_band(x, y, z, ax, wide=True)] = 'skin'
    arms = (bd.freg == 'arms') & (ax < 0.672) & (ax > 0.24)
    zn[arms & (np.abs(y + 0.066) < 0.016) & (bd.fn[:, 2] > 0.3)] = 'stripe'   # two-stripe band along the sleeve top
    legs = bd.freg == 'legs'
    zn[legs & (z < 0.11)] = 'sock'          # below 0.075 hidden under the modelled sneakers
    spec = {'skin': ('skin', 0, 0), 'wrap': ('cloth_wrap', 0.016, 8), 'collar': ('cloth_jacket', 0.016, 4), 'jacket': ('cloth_jacket', 0.018, 8),
            'stripe': ('stripe', 0.018, 8), 'trousers': ('cloth_trs', 0.014, 8), 'hand': ('skin', 0, 0), 'sock': ('sock', 0.004, 0)}
    C.apply_zones(bd, zn, spec, {'skin': skin, 'cloth_wrap': wrap, 'cloth_jacket': jacket, 'stripe': stripe, 'cloth_trs': trs,
                                 'sock': C.flat_mat('sock_white', (0.80, 0.80, 0.78), 0.9)}, tile=0.25)
    footwear(bd, arm, gear, 'sneaker', shoe, sole, lace=C.flat_mat('sneaker_lace', (0.95, 0.95, 0.95), 0.7))
    # bandolier over the left shoulder to the right hip, with ammo pouches
    bvh = C.body_bvh(bd, bd.freg == 'torso')
    c = Vector((0.0, -0.015, 1.24))
    R = Matrix.Rotation(math.radians(-32), 3, 'Y')
    pts = []
    for i in range(24):
        t = math.radians(i * 15)
        d = R @ Vector((math.sin(t), math.cos(t), 0))
        h = hit(bvh, c, d)
        p = (h + d * 0.016) if h else c + d * 0.2
        pts.append(tuple(p))
    s = C.strap('bandolier', pts, 0.055, 0.008, lambda p: (p - c), leather, closed=True)
    gear['torso'].append(semi_spine(s, arm))
    for i in (-2, -1, 0, 1, 2):
        t = math.radians(i * 16)
        d = R @ Vector((math.sin(t), math.cos(t), 0))
        h = hit(bvh, c, d)
        p = (h + d * 0.035) if h else c + d * 0.2
        o = C.gbox('bpouch', (0.05, 0.035, 0.065), p, leather, rot=(0, 32, -i * 14), bevel=0.006)
        gear['torso'].append(rigid_spine(o, arm))
    gear['head'] += head_wrap_extras(bd, arm, wrap)


def build_insurgent_c(bd, arm, skin, gear):
    jacket = cloth('jacket_olive', (0.30, 0.31, 0.21), seed=31)
    trs = cloth('cargo_khaki', (0.47, 0.42, 0.32), seed=32)
    bala = cloth('balaclava', (0.05, 0.05, 0.05), seed=33, rough=0.95)
    boot = C.flat_mat('boot_black', (0.05, 0.05, 0.05), 0.5)
    olive = cloth('rig_olive', (0.33, 0.33, 0.22), seed=34)
    dark = C.flat_mat('webbing_olive', (0.24, 0.24, 0.16), 0.9)
    zn, x, y, z, ax, head = base_zones(bd, 'jacket', 'trousers')
    zn[head] = 'bala'
    zn[head & eye_band(x, y, z, ax)] = 'skin'
    legs = bd.freg == 'legs'
    zn[legs & (z < 0.17)] = 'skin'          # hidden under the modelled boots
    spec = {'skin': ('skin', 0, 0), 'bala': ('cloth_bala', 0.006, 3), 'collar': ('cloth_jacket', 0.02, 4), 'jacket': ('cloth_jacket', 0.021, 10),
            'trousers': ('cloth_trs', 0.017, 8), 'hand': ('skin', 0, 0)}
    C.apply_zones(bd, zn, spec, {'skin': skin, 'cloth_bala': bala, 'cloth_jacket': jacket, 'cloth_trs': trs}, tile=0.3)
    footwear(bd, arm, gear, 'boot', boot, C.flat_mat('boot_sole_black', (0.08, 0.08, 0.08), 0.9),
             lace=C.flat_mat('lace_black', (0.12, 0.12, 0.12), 0.9))
    lb = C.body_bvh(bd, legs)
    for sx, bone in ((-1, 'thigh_l'), (1, 'thigh_r')):
        h = hit(lb, (sx * 0.6, -0.03, 0.66), (-sx, 0, 0))
        xx = h.x if h else sx * 0.17
        o = C.gbox('cargo_pocket', (0.03, 0.13, 0.15), Vector((xx + sx * 0.012, -0.03, 0.66)), trs, bevel=0.008, segs=2)
        C.box_uv(o, 0.3)
        gear['legs'].append(C.rigid_bind(o, arm, bone))
    gear['torso'] += type56(bd, arm, olive, dark, n_pockets=4, z0=1.08, z1=1.30)


def build_civilian_a(bd, arm, skin, gear):
    robe = cloth('robe_white', (0.86, 0.85, 0.81), seed=41)
    ghutra = C.tex_mat('ghutra', img('tex_ghutra', check_texture(256, (0.93, 0.92, 0.89), (0.66, 0.10, 0.10), seed=7, cell=20)), rough=0.9)
    black = C.flat_mat('agal_black', (0.03, 0.03, 0.03), 0.5)
    sole = C.flat_mat('sandal_sole', (0.18, 0.14, 0.10), 0.8)
    strapm = C.flat_mat('sandal_leather', (0.25, 0.16, 0.10), 0.7)
    zn, x, y, z, ax, head = base_zones(bd, 'robe', 'trousers')
    zn[head & ((z > 1.705) | ((y < 0.0) & (z > 1.60)) | ((ax > 0.07) & (z > 1.62) & (y < 0.06)))] = 'ghutra'
    feet_sandals(zn, bd, z, y, ax)
    spec = {'skin': ('skin', 0, 0), 'ghutra': ('cloth_ghutra', 0.012, 6), 'collar': ('cloth_robe', 0.018, 4), 'robe': ('cloth_robe', 0.022, 10),
            'trousers': ('cloth_robe', 0.012, 6), 'hand': ('skin', 0, 0), 'sole': ('sole', 0.004, 0), 'strap': ('strap', 0.004, 0)}
    C.apply_zones(bd, zn, spec, {'skin': skin, 'cloth_ghutra': ghutra, 'cloth_robe': robe, 'sole': sole, 'strap': strapm}, tile=0.25)
    footwear(bd, arm, gear, 'sandal', strapm, sole)
    gear['legs'].append(skirt(bd, robe, z1=0.12, flare=0.12))
    # ghutra drape over the back and shoulders, open at the face
    hb = C.body_bvh(bd, (bd.freg == 'head') | (bd.freg == 'torso'))
    zs = list(np.linspace(1.715, 1.43, 7))
    drape = C.ring_shell('ghutra_drape', zs, lambda zz: (0.0, -0.01 - 0.04 * (1.715 - zz)),
                         lambda zz, th: 0.098 + 0.35 * (1.715 - zz) ** 1.3, theta=(62, 298), nseg=18, bvh=hb, margin=0.016, smooth=2)
    drape.data.materials.append(ghutra)
    C.solidify(drape, 0.004)
    def dw(co):
        t = min(max((1.66 - co.z) / 0.16, 0.0), 1.0)
        return {'Head': 1 - t, 'neck_01': t * 0.4, 'spine_03': t * 0.6}
    C.set_weights(drape, dw)
    gear['head'].append(C.bind(drape, arm))
    ring = []
    for i in range(24):
        t = math.radians(i * 15)
        ring.append((0.102 * math.sin(t), -0.005 + 0.118 * math.cos(t), 1.738 - 0.012 * math.cos(t)))
    for k, dz in enumerate((0.0, 0.016)):
        o = C.strap('agal', [(p[0], p[1], p[2] + dz) for p in ring], 0.014, 0.012, lambda p: (p.x, p.y + 0.005, 0), black, closed=True)
        gear['head'].append(C.rigid_bind(o, arm, 'Head'))
    gear['head'].append(C.load_hair('Hair_Beard', arm))


BUILDERS = {'us_rifleman': build_us, 'insurgent_a': build_insurgent_a, 'insurgent_b': build_insurgent_b,
            'insurgent_c': build_insurgent_c, 'civilian_a': build_civilian_a}
CHARS = ['us_rifleman', 'us_rifleman_b', 'insurgent_a', 'insurgent_b', 'insurgent_c', 'civilian_a']


def export_char(path, arm, parts):
    bpy.ops.object.select_all(action='DESELECT')
    arm.select_set(True)
    for o in parts.values():
        o.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_yup=True,
                              export_animations=False, export_skins=True, export_cameras=False, export_lights=False,
                              export_materials='EXPORT', export_image_format='AUTO', export_jpeg_quality=88,
                              export_apply=False, export_def_bones=False, export_leaf_bone=False)


# ============================================================================================ previews

def load_clips(path):
    objs, acts = C.import_gltf(path)
    for o in objs:
        bpy.data.objects.remove(o, do_unlink=True)
    out = {}
    for a in acts:
        a.use_fake_user = True
        out[a.name.split('|')[-1].split('_Armature')[0]] = a
    if 'Idle_Loop' not in out:
        print('clip names', list(out)[:5])
    return out


def frame_of(act, f):
    n = act.frame_range[1]
    return f * n if isinstance(f, float) else f


def preview_char(cid, arm, parts, clips, pdir):
    ms = list(parts.values())
    for o in [arm] + ms:
        o.hide_render = True
    shots = [('Idle_Loop', 0, -0.9, 0, 0), ('Jog_Fwd_Loop', 8, -0.3, 0, 0), ('Sprint_Loop', 5, 0.3, 0, 0), ('Idle_Loop', 30, 0.9, 0, 180)]
    made = []
    for c, f, x, y, rz in shots:
        a2, m2 = C.dup_char(arm, ms, x, y)
        a2.rotation_euler.z = math.radians(rz)
        C.pose_static(a2, clips[c], frame_of(clips[c], f))
        made += [a2] + m2
    C.render(os.path.join(pdir, 'char_%s.png' % cid), target=(0, 0, 0.85), dist=4.0, az=158, el=8)
    # close-up of the head, hands and feet of the idle figure
    C.render(os.path.join(pdir, 'char_%s_detail.png' % cid), target=(-0.9, 0, 1.25), dist=1.5, az=165, el=4)
    C.render(os.path.join(pdir, 'char_%s_feet.png' % cid), target=(-0.6, 0, 0.12), dist=1.6, az=150, el=18)
    for o in made:
        bpy.data.objects.remove(o, do_unlink=True)
    made = []
    shots = [('Prone_Idle_Loop', 0, -1.2, 0.2), ('Prone_Crawl_Loop', 0.5, -0.4, 0.2), ('Wounded_Loop', 0.3, 0.45, 0.2),
             ('Death02', 1.0, 1.1, -0.3)]
    for c, f, x, y in shots:
        a2, m2 = C.dup_char(arm, ms, x, y)
        C.pose_static(a2, clips[c], frame_of(clips[c], f))
        print('  %s %s min z %.3f' % (cid, c, C.mesh_min_z(m2)), ' '.join('%s:%.2f' % (o.name.split('.')[0][5:], C.mesh_min_z([o])) for o in m2))
        made += [a2] + m2
    C.render(os.path.join(pdir, 'char_%s_ground.png' % cid), target=(0, 0.1, 0.15), dist=4.4, az=150, el=38)


# ============================================================================================ main

def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    out = argv[0] if argv and not argv[0].startswith('--') else 'public/models/chars'
    pdir = argv[argv.index('--preview') + 1] if '--preview' in argv else None
    only = argv[argv.index('--only') + 1].split(',') if '--only' in argv else None
    os.makedirs(out, exist_ok=True)
    anims = os.path.join(out, 'anims.glb')
    if only is None or 'anims' in only:
        C.reset()
        arm, meshes = C.load_base()
        rig = C.Rig(arm)
        build_anims(arm, rig, body=list(meshes.values()))
        for o in meshes.values():
            bpy.data.objects.remove(o, do_unlink=True)
        export_anims(anims, arm)
        print('wrote', anims)
    for cid in CHARS:
        if only is not None and cid not in only:
            continue
        arm, parts = build_char(cid)
        tris = {k: C.tri_count(o) for k, o in parts.items()}
        print('%s triangles %d %s' % (cid, sum(tris.values()), tris))
        export_char(os.path.join(out, cid + '.glb'), arm, parts)
        print('wrote', cid)
        if pdir:
            os.makedirs(pdir, exist_ok=True)
            clips = load_clips(anims)
            preview_char(cid, arm, parts, clips, pdir)


if __name__ == '__main__':
    main()

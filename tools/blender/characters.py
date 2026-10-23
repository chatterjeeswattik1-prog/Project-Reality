"""Characters and animations for PROJECT REALISM.

    blender -b --factory-startup --python tools/blender/characters.py -- public/models/chars [--preview tools/blender/previews] [--only anims,us_rifleman,...]

Writes <out>/anims.glb (armature + named clips, no mesh) and <out>/<id>.glb (skinned parts part_head,
part_torso, part_arms, part_legs on the armature `Armature`, no animations). Skeleton and clips: Quaternius UBC +
UAL (CC0). Bodies, skins and base garments: MakeHuman / MPFB2 CC0 assets (see mhcommon.py), fitted onto the same
skeleton. Characters face +Y in Blender (-Z in three.js), feet on z = 0, ~1.78 m tall.
Source assets go in tools/blender/src-assets/ (see tools/blender/AGENT_CHARS.md for the download list).
Windows: E:/tools/blender-4.5.15-windows-x64/blender.exe -b --factory-startup --python tools/blender/characters.py -- public/models/chars --only us_rifleman
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


# ============================================================================================ characters
# MakeHuman (CC0) bodies fitted onto our skeleton, MakeHuman clothes re-textured, modelled gear, per-part texture
# atlases: see outfits.py / outfits_ins.py (definitions), chbuild.py (assembly, atlases), gear.py / gear_ins.py
# (plate carrier, helmet, chest rigs, head wraps, ...), mhcommon.py / mhchar.py (MakeHuman data), texbake.py.
import outfits
import outfits_ins
import chbuild

BUILDERS = {'us_rifleman': outfits.build_us, 'us_rifleman_b': outfits.build_us,
            'insurgent_a': outfits_ins.build_insurgent_a, 'insurgent_b': outfits_ins.build_insurgent_b,
            'insurgent_c': outfits_ins.build_insurgent_c, 'civilian_a': outfits_ins.build_civilian_a}
CHARS = ['us_rifleman', 'us_rifleman_b', 'insurgent_a', 'insurgent_b', 'insurgent_c', 'civilian_a']


def build_char(cid):
    kit = BUILDERS[cid](cid)
    parts = chbuild.finish(kit)
    return kit.arm, parts


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

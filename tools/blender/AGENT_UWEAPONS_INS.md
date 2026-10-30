# Agent checkpoint: insurgent weapons from user GLBs (tools/blender/uweapons_ins.py)

Run: `blender -b --factory-startup --python tools/blender/uweapons_ins.py -- <ids> [--shots <dir> --ppm 2500 --views side,top]`
(--shots writes gridded ortho renders in pre-move space with every node marked: grip red, part origins blue, empties green).

| id   | status | tris | MB | notes |
|------|--------|------|----|-------|
| akm  | done (lead) | | | reference |
| ak47 | exported | 33058 | 3.42 | source +X muzzle, scaled x1.686 to 0.874 m; jungle-clamped 2nd mag + loose rounds deleted; TUKI screws/grip decimated |
| pkm  | exported | 16822 | 2.26 | source -Y muzzle, pitched 11.5 deg on bipod -> levelled, scaled to 1.19; unwelded single mesh cut with U.split_pos (position-welded islands) |
| rpd  | exported | 20302 | 1.82 | source +X muzzle, scaled 1.037; drum+belt = box; cover = lid + rear sight (front-hinged); charge on RIGHT moved +0.15 to forward rest |
| svd  | exported | 34070 | 1.81 | source +Y, scaled 1.225; per-piece decimate (150 + 18%); mag/charge(bolt_low, right) split by name; PSO-1 kept |
| rpg7 | exported | 24044 | 2.39 | source +X; spare rocket/fins/booster deleted; k=1.4039 (tube 0.95); rocket child origin at tube muzzle seat; irons only (no PGO-7) |
| f1   | exported | 5615 | 0.59 | Z up (fuze +Z), origin body centre; spoon = lever (-X side, origin at its top hinge), pin = ring+pin; shell decimate 0.15 (0.1 tore holes); 512 tex |
| ied  | exported | 7649 | 0.78 | STANDING nose-up, long axis Z, origin bottom centre; XY scaled to 155 mm, Z to 0.6 m (x1.22 stretch, source stubby); empties grip_r (0,0,0.3), nose |

## Measured nodes (pre-move weapon space)
- ak47: grip (0,-0.158,-0.035); mag lug (0,0.004,0.02); charge = `Cerrojo` knob only, origin (0.02,0.039,0.068), right side, back 0.09;
  eye notch (0,0.043,0.108); front_post (0,0.4215,0.107); muzzle (0,0.442,0.06); butt (0,-0.43,-0.027).

- pkm (pre-move, bore x=-0.0525): grip (X,-0.214,0.11); box origin top centre (X,0.002,0.16) mag_dir straight down; box includes the belt
  rising into the feed; cover = top plate y -0.081..0.06 (vert-mode cut), hinge FRONT (X,0.055,0.25), hand_cover rear (X,-0.075,0.268);
  charge = lever on the RIGHT (-0.031,-0.06,0.19), back 0.15; eye notch (X,-0.102,0.272); muzzle (X,0.665,0.225).
- rpd: grip (0,-0.292,-0.04); box top centre (0,-0.0855,-0.008), mag_dir down; cover hinge FRONT (0,-0.0425,0.082) hand_cover (0,-0.145,0.1);
  charge home (0.02,-0.031,0.04) back (0.02,-0.181,0.04) [source pose]; eye (0,-0.147,0.104); post (0,0.44,0.106); muzzle (0,0.46,0.059).
- svd: grip (X=-0.002,-0.31,-0.05); mag lug (X,-0.047,0.01); charge (0.017,-0.034,0.022) back 0.08; scope eye (0,-0.399,0.088) cheek 0.07 behind;
  eye_irons notch (X,-0.0245,0.0628), front_post = ring-hood centre (X,0.519,0.0615) (no post modelled); irons blocked by the scope (real).
- SIGHT CORRECTION (lead): eye = notch itself, cheek on notch->post line, front_post empty. Measured on 4000-8000 px/m renders
  (scratch ushot.py = final-space ortho of the GLB with empties marked; fpost.py = front-view slice for hooded posts).
  ak47: leaf was modelled raised -> rotated 2.5 deg down about hinge (AK47_LEAF); notch (0,0.041,0.108) post (0,0.422,0.1078) -> LOS ~ parallel to bore.
  pkm: notch (X,-0.110,0.275), post tip (X,0.526,0.289): LOS rises ~1.3 deg vs bore (model proportions; tall front post / raised leaf).
  rpd: notch (0,-0.149,0.1045), post (0,0.44,0.1064).
- rpg7 (source units before k, see RPG7 dict): bore x 0.0141 z 0.1831; trigger grip (0.0141,0.072,0.09) on bore line; rear grip offset left;
  sights 0.02 m left of bore: rear notch (0,-0.0282,0.26), front (0,0.2079,0.251); extra empties grip_rear, backblast, mag_dir (+0.12 m forward).

## Status
ALL SEVEN EXPORTED. Next: nothing unless the lead asks (possible: PKM LOS vs bore mismatch, IED stretch, RPD handle move).

## Gotchas
- ak47 receiver renders rather bright/silver in glbshot (source metal-rough texture), fine in ortho.

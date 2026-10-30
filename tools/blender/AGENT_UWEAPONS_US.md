# Agent checkpoint: US weapons from user GLBs (uweapons_us.py)

Script: `tools/blender/uweapons_us.py` (build_<id>() + finish(), same pattern as uweapons_ins.py).
Sources: E:/Terraform_Automation/New/US-Forces. Scratch renders: scratchpad/uus.

| id | source | status | tris | MB | notes |
|---|---|---|---|---|---|
| m4a1_m203 | a_colt_m4a1m203.glb | DONE | 14229 | 2.97 | grip pre-move (0,-0.185,0.073); bore z .179; irons z .246; leaf eye_gl (0,.08,.271) front_gl = front post (0,.233,.246); extra muzzle_gl; top cartridge dropped |
| m16a4 | m16_a4.glb | DONE | 28109 | 3.18 | flatten_posed() (POSE mode!); grip (0,-0.022,-0.019); bore z .077; aperture z .141; mag top (0,.104,.055); charge = charging handle + bolt groups; ammo decimated 0.25 |
| m249 | m249_saw_squad_automatic_weapon.glb | DONE | 39291 | 4.68 | rot X -14.4 (source pitched), len 1.04; split_in_all (islands fully inside box); decimate 0.31; grip (0,-.167,-.103); sight z .097; cover hinge (0,.035,.05) front, hand_cover (0,-.24,.07): opening = NEGATIVE rot about local X; box mag_dir straight down |
| m24 | m24_bounty_hunter_sniper_rifle.glb | DONE | 14825 | 1.29 | orient +X fwd; len 1.09; bore z .043; scope axis z .093 (eye y -.261, front_post = objective (0,.07,.093)); bolt = Object_18+25, origin (0,-.2,.043), hand_charge knob (.047,-.197,.008); detachable mag Object_14 |
| m9 | 3d_beretta_m9.glb | DONE | 7236 | 0.71 | Cube.007 spare mag deleted; charge = slide Cube.001 (incl. sights), mag Cube.003 tilted: mag_dir along (0,-.147,-1); eye notch (0,-.065,.0712) front_post (0,.097,.0712); no cheek (pistol) |
| m136 | anti-tank_grenade_launcher__at4__gameready.glb | DONE | 8779 | 1.22 | len 1.02, tube axis z 0; grip (right palm under red fire button) (.04,.07,-.04); sights LEFT x -.0665: eye (.1146 y, .0847 z) front_post y .4717; extra backblast, fire_button empties; grip_l on folding front grip |
| m67 | m67.glb | DONE | 5046 | 0.34 | upright copy kept; origin sphere centre z .0295; pin = ring+safety pin (origin pin hole (0,.014,.079)), spoon (hinge (0,.02,.087)); spoon +Y, ring +X; grip_l at ring; cheek like old m67 |
| m18 | m18_smoke_grenade.glb | DONE | 1704 | 0.23 | height 0.145 (dia 0.059); islands classified by bbox (split_pred); origin z .065; spoon +Y, ring +X |
| c4 | simple_c4-_bomb.glb | DONE | 3594 | 0.57 | 7-stick bundle + timer; len .28, rot Y -58 so timer faces +Z; origin bottom centre; grip_r at centre; 1024 tex |

## Gotchas
- COORDINATOR: eye = exact aperture centre measured on 10000 px/m back view; add front_post (post tip) + cheek on eye->post line 0.13 behind (sight_nodes()). Applied to m4a1_m203 (eye z .252), m16a4 (.1417/.1403), m249 (.0897/.0917 - the big ring is the FRONT hood, not the aperture), m24.
- 8-bit grey PNGs make the glTF exporter fail ('Could not write image', pink mag): finish() calls rgb_images().
- crop helper: scratchpad/crop.py img out x0 y0 x1 y1 zoom (PIL). ortho px: x=(y-cy)*ppm+W/2, row=H/2-(z-cz)*ppm.

## Next step
ALL DONE. Rebuild everything: blender ... uweapons_us.py -- m4a1_m203 m16a4 m249 m24 m9 m136 m67 m18 c4 tools/blender/uexplore_part.py = uexplore with --only/--skip/--pose.

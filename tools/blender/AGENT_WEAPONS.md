# Weapon look + reload-nodes rework: checkpoint

Read this first on (re)start and continue from **Next step**. Do not redo finished weapons.

## Brief (contract being followed)
- Look quality: worn steel (neutral grey-black, sRGB ~46 base, silver edge wear, scratches, grime), orange-red AKM
  laminate / darker Type 56 birch, orange bakelite AKM mag, baked tangent-space normal map (bevels, stamps, rivets,
  checkering, grain). ≤ ~30k tris. 2048 base colour + normal for long-gun primaries (metal-rough 1024), else 1024 / 512.
- Reload nodes (spelled out in CLAUDE.md "Reload / handling nodes"): `mag` origin = removal pivot (AK-pattern: front lug;
  straight mags: top centre + `mag_dir` root empty 0.12 m along withdrawal), `hand_mag` (child of mag/box), `charge`
  mesh (origin at rest), `charge_back` (root empty), `hand_charge` (child of charge/bolt), belt-fed `hand_cover`
  (child of cover). M24 uses `bolt` (origin on bore). Real covers of PKM / M249 / M240B hinge at the FRONT
  (game must rotate so hand_cover rises: negative angle about +X in three.js).
- Do not edit `src/`. Do not commit. Export each finished weapon to public/models/weapons/.

## Tools / commands
- Blender: `E:/tools/blender-4.5.15-windows-x64/blender.exe`
- Scratch dir: `C:/Users/ADMINI~1/AppData/Local/Temp/claude/e--Terraform-Automation-Project-Reality/dfe00d10-5890-47cc-a760-eb0ace214135/scratchpad`
  - `build.sh <weapons_ins|weapons_us> <ids>`: builds into public/models/weapons, renders `weapons/final_<id>_<view>.png`
    with `fpshot.py` (sky+sun, AgX) and writes measured node positions to `weapons/nodes_<id>.txt`.
  - env `FPV="name:px,py,pz:tx,ty,tz:lens;..."` adds camera views (root space, metres); `VIEWS=` picks views.
  - Originals backed up in `scratchpad/orig/` (scripts + old GLBs).
- Insurgent bake: ~8 min per long gun at 2048 on this machine (normal pass ~5 min).

## Status
| weapon | status | exported |
|---|---|---|
| akm | v5 exported (stamps legible); v6 (shorter scratches) baking in batch | 2026-10-23 |
| ak47, rpk, svd, pkm, aks74u, makarov | node code done, no-bake test OK; batch bake running (build.sh weapons_ins akm,ak47,rpk,pkm,svd,aks74u,makarov) | |
| m4a1, m4a1_m203, m16a4, m249, m240b, m24, m9 | node code done (weapons_us.py), no-bake test OK; materials not yet reviewed | |
| launchers, grenades, vehicle guns | todo (materials only if time) | |

## Measured nodes (root space, metres, Blender Z-up +Y muzzle)
### akm (v4 export)
- mag origin (front lug) (0, +0.1781, +0.0415); hand_mag (-0.0268, +0.1929, -0.0444)
- charge origin (+0.0120, +0.1951, +0.0809); charge_back (+0.0120, +0.1051, +0.0809); hand_charge (+0.0355, +0.1951, +0.0845)

## Decisions / gotchas
- wcommon_ins: shaders have OUT_BASE/OUT_ROUGH/OUT_METAL/OUT_HEIGHT reroutes; bake = NORMAL (Bump on Bevel normal) then
  EMIT base + metal-rough. Edge wear = Bevel curvature × AO-open mask. Scratches = stretched Voronoi edges.
- skin_x sheets were one-sided -> no edge wear; now get a rim (boundary edges extruded inward, `thick`).
- N-gons must be triangulated before unwrap or glTF tangents fail.
- Stamps: `Build.stamp()` -> `add_stamps()` (object-space side projection, body pass_index 1, 5x7 font incl. Cyrillic).
- UV texel weighting by part name (`UVW` table in wcommon_ins, face attr 'uvw', `_scale_islands`).
- Bash heredocs with quotes break the Bash tool: write patch scripts with the Write tool, run with `python -X utf8`.
- US pipeline (wcommon_us) already bakes normals + decals; `Gun.e(name, p, parent)` makes child empties; decals can
  target a moving part via `obj='charge'`.

## Next step
1. Insurgent batch bake (~1 h) running: when done check final_<id>_*.png + nodes_<id>.txt for all 7, record nodes. If interrupted, rerun build.sh for the ids not yet exported (check file times in public/models/weapons).
2. (skin_x now accepts step=(sy, sz); PKM/SVD skins coarsened to keep tris near 30k.)
3. Render old US GLBs, decide material tweaks, build US weapons, record nodes.
4. Final report (per-weapon changes, nodes, deviations, preview paths).

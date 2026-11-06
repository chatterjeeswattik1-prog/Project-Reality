# PROJECT REALISM: project context

A browser tactical shooter in the style of **Project Reality** (the BF2 realism mod). The first setting is **modern insurgency**: **US Army** vs **Insurgents** on a mid-sized Middle-Eastern urban map. It starts small and grows (more factions, maps, vehicles, multiplayer). The team values realism: real dimensions, real ballistics, PR-style deviation, no crosshair.

## Stack (same as the earlier PARASHURAMA project)
- **TypeScript + Vite + Three.js** (`three@0.186.1`). No React.
- **Rapier** (`@dimforge/rapier3d-compat`): character controller, vehicles, grenades, ray casts.
- **recast-navigation** (`recast-navigation`, `@recast-navigation/three`): navmesh and crowd for the bots.
- **postprocessing + n8ao**: ambient occlusion, bloom, tone mapping.
- **Blender 4.5** headless for all models: `~/blender-4.5.13-linux-x64/blender -b --factory-startup --python tools/blender/<script>.py -- <args>` (on the Windows machine: `E:/tools/blender-4.5.15-windows-x64/blender.exe`). Shared helpers in `tools/blender/common.py`.
- CC0 assets only (Poly Haven, ambientCG, Quaternius, Freesound CC0). Every downloaded asset is listed in `public/assets/CREDITS.txt` (or a `CREDITS.txt` next to it).

## Commands
- `npm run dev`: dev server. `npm run build`: typecheck and build to `dist/`. `npm run typecheck`.
- `npm run assets`: download the CC0 textures and skies (`scripts/fetch-assets.mjs`).
- `npm run models`: rebuild every GLB with Blender (`scripts/build-models.sh`).

## Units and axes
- Metres, seconds, kilograms. Angles in radians in code, degrees in Blender scripts.
- **Blender:** Z up, **+Y forward**, +X right. The glTF exporter (`export_yup=True`) turns this into the three.js convention: **Y up, −Z forward, +X right**.
- **World (three.js):** X east, −Z north, Y up. Map origin at the map centre on the ground.

## Model contracts (Blender → `public/models/...`)
All models: real-world dimensions, origin as stated, applied transforms, PBR materials (glTF metallic-roughness), textures ≤ 1024 px (≤ 512 for small items), no cameras or lights exported. Each build script can write preview renders to `tools/blender/previews/` (Cycles CPU, low samples) for checking.

### Weapons: `public/models/weapons/<id>.glb`
- One file per weapon, root object named `<id>`. Weapon points **+Y** (muzzle forward) in Blender.
- Origin = the firing hand's grip point (where the right palm wraps the pistol grip / RPG grip).
- Empties (children of the root): `muzzle` (bore exit), `eye` (on the sight line, at the rear of the rear sight / optic eyepiece), `grip_r` (firing hand), `grip_l` (support hand), `eject` (ejection port), `butt` (centre of the butt pad; omit on pistols).
- Separate child mesh objects that the game animates: `mag` (detachable magazine), on belt-fed guns `box` (ammo box/pouch) and `cover` (feed cover, origin on its hinge; see reload nodes below), on the RPG-7 `rocket` (warhead in the tube), on grenades `pin` and `spoon`, on bolt rifles `bolt`.
- **Reload / handling nodes** (first-person reload animation; all positions in the weapon's Blender frame, +Y = muzzle):
  - `mag` origin = the pivot used to remove it. AK-pattern mags (`akm`, `ak47`, `aks74u`, `rpk`, `svd`): origin on the front locking lug (top front of the mag); a rotation about local X rocks it forward out of the well. Straight-inserted mags (`m4a1`, `m4a1_m203`, `m16a4`, `m9`, `makarov`): origin at the top centre of the mag body, plus an empty `mag_dir` (child of the root) = the mag origin moved 0.12 m along the withdrawal direction. Belt-fed guns use `box` the same way (`mag_dir` = straight down).
  - `hand_mag` (empty, child of `mag` / `box`): support-hand palm centre when gripping the mag (front-left side, mid height).
  - `charge` (child mesh): the part the hand pulls to charge the weapon, origin at its forward (rest) position. AK family / SVD: carrier piece in the port + charging handle; M4/M16: T-handle + bolt carrier; M249 / M240B / PKM: charging handle; M9 / Makarov: the slide. Bolt rifles (`m24`): named `bolt`, origin on the bore axis (rotate about local Y to unlock, then slide back).
  - `charge_back` (empty, child of the root): where the `charge` origin is at full rearward travel (AK ~0.09 m, AR 0.07 m, PKM 0.15 m, M240B 0.15 m, M249 0.08 m, pistols 0.036–0.04 m, M24 bolt 0.1 m).
  - `hand_charge` (empty, child of `charge` / `bolt`): grip point of the hand on the handle / knob / slide.
  - Belt-fed (`m249`, `m240b`, `pkm`): `cover` origin on its real hinge axis. All three real covers hinge at the **front** and lift at the rear latch, so opening = rotating about local X in the sense that raises `hand_cover`; `hand_cover` (empty, child of `cover`) is where the hand lifts it (rear latch).
- Textures: one material per weapon (base colour + metallic-roughness + tangent-space normal map, tangents exported). Long-gun primaries may use 2048 px base colour + normal (metal-rough ≤ 1024).
- Budget 2k–15k triangles each (≤ ~30k for detailed first-person primaries).
- IDs: US `m4a1`, `m4a1_m203`, `m16a4` (all iron sights), `m249`, `m240b`, `m24`, `m136` (AT4), `m9`, `m67`, `m18` (smoke), `c4`. Insurgents `akm`, `ak47`, `aks74u`, `rpk`, `rpd`, `pkm`, `svd`, `rpg7`, `makarov`, `f1`, `ied`. Vehicle guns `m2`, `dshk`.
- Sights: `eye` = rear aperture centre / notch top (AK picture: post tip level with the notch shoulders) or eyepiece axis, `front_post` = post tip, `cheek` = eye point when aiming (the game moves it onto the eye→front_post line and turns that line onto the view axis). Check with `tools/blender/sightcheck.py` (renders from the game's eye point).
- Two files per converted weapon: `<id>.glb` full detail (first person, loaded on demand for the player's own weapons) and `<id>_lod.glb` (≤ 12k tris, 512 px; bots / third person). `ucommon.HI` (env `UQ`) controls it.
- Most weapons are converted from the user's models (E:/Terraform_Automation/New) by `tools/blender/uweapons_us.py` / `uweapons_ins.py` (helpers `ucommon.py`, `uexplore.py`); `m4a1` and `aks74u` are cut from the animated packs by `fpweapons.py`. `rpk`, `m240b`, `makarov`, `m2`, `dshk` are still the procedural builds.

### First-person rigs: `public/models/fp/fp_<pack>.glb`
- Built by `node scripts/fprig.mjs` (glTF-Transform, not Blender: its importer breaks these skins) from the user's animated packs: arms + weapon bones + clips `fire` (idle = t 0), `reload`, `reload_empty`, `draw`, `holster`. The packs' own weapon meshes are removed; `src/player/fprig.ts` hangs the contract weapon on the weapon bone (`PACKS`, `PACK_OF`: M4 rig for m4a1/m4a1_m203/m16a4, AK rig for aks74u/akm/ak47/rpk/svd) using the contract frame printed by `fpweapons.py` (`FRAME`).

### Vehicles: `public/models/vehicles/<id>.glb`
- Root `<id>`, **+Y forward**, origin on the ground at the centre of the wheelbase (tyres touch z = 0).
- Wheels as separate objects `wheel_fl`, `wheel_fr`, `wheel_rl`, `wheel_rr` (origin at the wheel centre, axle along X).
- Seat empties: `seat_driver`, `seat_passenger`, `seat_rear_l`, `seat_rear_r`, `seat_gunner` (each at the occupant's eye point). Exit empties `exit_l`, `exit_r`.
- Turret: `turret` (traverse about local Z, origin on the ring centre), child `gun` (elevation about local X, origin on the trunnion), child of `gun`: `muzzle`. Gunner eye `turret_eye` (child of `turret`).
- Glass uses a material named `glass`. Wrecks are separate files `<id>_wreck.glb`.
- IDs: `m1114` (up-armoured HMMWV, M2 ring mount with gunner shield), `hilux_dshk` (technical), `sedan`, `pickup`, plus wrecks.
- Tracked armour `m1a2` (M1A2 Abrams) and `m2a3` (M2A3 Bradley): converted from the user's Sketchfab models (CC BY 4.0, credited in `public/models/vehicles/CREDITS.txt` and the menu) by `tools/blender/tanks.py` (turned to +Y, scaled to real length, decimated; Bradley recoloured to desert tan). Nodes: `body`, `track_l`/`track_r` (material `track`, UV-scrolled), `rw_l_<n>`/`rw_r_<n>` (road wheels, M1A2), `turret` > `gun` > `muzzle`, `coax`; turret children `seat_gunner`, `seat_commander`, `seat_loader`, `mg_cmdr`, `mg_loader`, `tow`; hull `seat_driver`, `seat_cargo_<n>` (M2A3), `exit_l`/`exit_r`/`exit_rear`.

### Props kit: `public/models/props.glb`
- One file, many root objects, each named by its prop id, origin at the base centre, +Y forward. The game instances them by name.
- Collision: `node scripts/propcol.mjs` fits a few boxes to every prop and vehicle model → `public/models/props_col.json` (indoor furniture and small items: one tight box; lines/masts: posts only). Used by the game and the navmesh baker; mounds, wrecks, stalls and the dome use their real mesh (`EXACT` in world/render.ts). Re-run it, then `npm run navmesh` (~30 s), after changing props.glb, vehicles or the city generator.

### Characters: `public/models/chars/<id>.glb`, animations `public/models/chars/anims.glb`
- Quaternius Universal Base Characters + Universal Animation Library (CC0). Unreal-style skeleton (`root`, `pelvis`, `spine_01..03`, `neck_01`, `Head`, `clavicle_l/r`, `upperarm_l/r`, `lowerarm_l/r`, `hand_l/r`, `thigh_l/r`, `calf_l/r`, `foot_l/r`, …). Every character and the animation file share it, so clips play on any character by bone name.
- Each character's skinned body is split into separate meshes `part_head`, `part_torso`, `part_arms`, `part_legs` so the first-person view can show the arms alone.
- IDs: `us_rifleman` (OCP/ACU uniform, IOTV vest, ACH helmet), `insurgent_a`, `insurgent_b`, `insurgent_c` (varied civilian clothing, shemagh/keffiyeh), `civilian_a`.

## Code layout (`src/`)
- `main.ts` boot and menu · `core/` loop, input, settings, rng · `world/` terrain, city generator, collision, nav · `game/` modes, factions, kits, tickets · `weapons/` data, ballistics, deviation, firing · `player/` controller, viewmodel · `ai/` bots and squads · `vehicles/` · `fx/` · `audio/` · `ui/` HUD, map, menus.
- Game data (weapons, kits, vehicles) lives in typed tables in `src/game/data/`, with sources noted. Mark approximate numbers.
- Map: the town keeps its ±650 m layout (`HALF`); the playable AO is x −700…1000, z ±700 (`AO` in world/terrain.ts) with the eastern farmland belt (fields, orchards, tamarisk hedgerows, the ridge at x≈662, the North/South Woods, FOB Hammer at x 872–982) generated after the town from its own random stream. Map sheet 17×17 squares (`MAP`). Woods block AI sight lines (`Game.foliageBlocks`). Re-bake the navmesh (`npm run navmesh`, ~25 s) after changing the generator.
- Armour (`vehicles/`): `vehicle.ts` (Rapier body, ray suspension, track traction, turret/gun, weapons, damage state, crushing), `armour.ts` (faces, penetration, compartments), `control.ts` (player seats/views/HUD), `vai.ts` (AI driver/gunner/commander), `planner.ts` (vehicle A* grid), `crews.ts` (motor pool, AI crews, respawn), `vaudio.ts` (synthesised engines); data in `game/data/vehicles.ts`, rounds (`ap`/`ce`/`tandem`/`guided`) in `game/data/weapons.ts`. Insurgent IEDs and ATGM teams: `ai/threats.ts`; combined arms and house-to-house in `ai/director.ts` / `ai/team.ts` (`Fireteam.clearBuilding`). Tests: `scripts/tanktest.mjs`, `crushtest.mjs`, `combined.mjs` (full-map round log), `eastshot.mjs`.
- Destruction (`world/destruct.ts`): every box `Sink.box` emits is a piece (`sink.ts` PieceTable: bounds, collider index, where each face sits in the chunk meshes); blasts cut holes, unsupported remnants and props fall, physics rebuilds that building's trimesh (city colliders are grouped per building, props per 32 m cell). Explosive `breach`/`light` radii are in `game/data/weapons.ts`. Test: `node scripts/breach.mjs <outPrefix>` (`FULL=1` for the full map).

## Rules
- Determinism where it is cheap: the map layout comes from a seed (`mulberry32`), never `Math.random()` in the generator.
- Realism first: real muzzle velocities, drag, gravity drop, rates of fire, magazine counts, no crosshair. Aiming is Squad-style (visible sway and recoil, mechanical dispersion); the PR settle time was removed at the user's request.
- Keep frame rate on ordinary laptops: instancing for repeated props, merged static geometry per city block, quality presets.
- Research notes in `docs/RESEARCH.md`.

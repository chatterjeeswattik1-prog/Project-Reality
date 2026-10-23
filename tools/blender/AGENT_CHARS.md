# Character rebuild: agent checkpoint

Read this first after an interruption, then continue from **Next step**.

## Contract (do not break)
- Same Unreal-style skeleton, bone names and rest pose as `public/models/chars/anims.glb` (the Quaternius UBC male
  skeleton, built by `chcommon.load_base()`; 65 bones, T-pose, faces +Y, feet on z = 0). Do not change `anims.glb`.
- Each character GLB: armature `Armature` + skinned meshes exactly `part_head`, `part_torso`, `part_arms`,
  `part_legs`. No animations. part_arms = both arms from 40% down the upper arm, incl. hands/gloves; head includes
  the helmet/headwrap.
- ids: us_rifleman, us_rifleman_b, insurgent_a, insurgent_b, insurgent_c, civilian_a.
- PBR textures at most 1024 px per set (one base/normal/MR atlas per part, plus small alpha textures for hair,
  brows and lashes). About 8-20k triangles. CC0 only (CREDITS.txt is updated).
- Do not edit `src/`. Do not commit. Coordinator note: keep the first-person sleeves fitted (`outfits.tighten()`).

## Source assets (gitignored, `tools/blender/src-assets/`). Re-download if they are missing.
- `quaternius/UBC`, `quaternius/UAL1`, `quaternius/UAL2`: Quaternius Universal Base Characters, Universal Animation
  Library 1 and 2 (Standard, CC0), from itch.io (quaternius.itch.io/universal-base-characters,
  /universal-animation-library, /universal-animation-library-2).
  - curl flow: GET the page, read `csrf_token`, POST `/download_url`, GET that url, read `data-upload_id`, then
    POST `/file/<id>?source=game_download&as_props=1` and fetch the JSON `url`.
  - Unzip, then move the contents of the "...[Standard]" folder up one level, so that
    `quaternius/UBC/Base Characters/Godot - UE/...` exists. The raw zips are in `src-assets/dl/`.
- `mpfb2/src/mpfb/data`: MPFB2 data, sparse clone:
  `git clone --depth 1 --filter=blob:none --sparse https://github.com/makehumancommunity/mpfb2.git mpfb2 && git sparse-checkout set src/mpfb/data`.
  Assets are CC0.
- `makehuman/sys`: MakeHuman system assets CC0 pack. Unzip
  http://files.makehumancommunity.org/asset_packs/makehuman_system_assets/makehuman_system_assets_cc0.zip into `makehuman/sys`.

## Pipeline (tools/blender)
- `mhcommon.py`: plain numpy. hm08 base.obj, targets, `macro_targets()`, .mhclo fitting (`Clo`), game_engine rig and
  weights, and `Mapper`, which moves the MH body onto OUR rest skeleton by per-bone LBS.
- `mhchar.py`: `Human(arm, targets)` gives `.body(hide)` and `.clo(clo)` skinned Blender meshes.
- `texbake.py`: numpy UV rasterizer, `pack_atlas` (skyline, no rotation, density by world area x importance),
  noise, height-to-normal, image I/O.
- `chbuild.py`: `Kit`, material sources (`src_cloth`, `src_proc`, `src_image`), `ocp()` camouflage, `dirt()`,
  `fabric_height()`, `weights_from`, `decimate`, `finish()` (per-object decimation via `o['decimate']`, one 1024
  atlas per part, split/join into part_*), `export()`.
- `gear.py`: soft boxes, plate carrier, helmet, `us_legs` (boot shaft, trouser tuck, knee pads, cargo pockets),
  sleeve pockets with a flag patch, `glasses`, `neck_scarf`.
- `gear_ins.py`: robe skirt, `head_wrap` (wrap / mask / ghutra), Type 56 `chest_rig`, sandals, agal.
- `outfits.py`: bodies, faces and skins tables, `skin_src` (beard from landmarks), `glove_src`, `fit`, `tighten`,
  `make_body` (body_head / body_hand / body_rest decimated separately), `build_us` (seed 1 = a, seed 2 = b).
- `outfits_ins.py`: build_insurgent_a/b/c, build_civilian_a.
- `characters.py`: anims code unchanged. The character part now calls the builders above (the old procedural code
  was removed).
- `glbshot.py`: preview renderer. Options: `--anim anims.glb --clip Idle_Loop`, `--focus x,y,z,r`,
  `--views c34,cfront,cback,top` (c* views face the character), `--exposure`, `--zoom`, `--aspect`, `--samples`.

### Commands
- Export: `E:/tools/blender-4.5.15-windows-x64/blender.exe -b --factory-startup --python tools/blender/characters.py -- public/models/chars --only us_rifleman,us_rifleman_b,insurgent_a,insurgent_b,insurgent_c,civilian_a`
  - Takes about 80 s per character.
  - Do NOT include `anims` in `--only`, or anims.glb gets rebuilt.
  - Env `CHARS_TMP=<dir>` keeps the atlases. `CHARS_DEBUG=1` prints triangles per object and texels per source.
- Preview: `blender -b --factory-startup --python tools/blender/glbshot.py -- public/models/chars/us_rifleman.glb out.png --views c34,cfront --size 420 --aspect 2.0 --focus 0,0,0.9,0.66 --samples 32 --anim public/models/chars/anims.glb`
- Scratch (session temp, may vanish), under `C:/Users/ADMINI~1/AppData/Local/Temp/claude/e--Terraform-Automation-Project-Reality/dfe00d10-5890-47cc-a760-eb0ace214135/scratchpad/`:
  - `tools/t_us.py` (build one character to a GLB), `tools/montage.py`, `tools/bones.py` (dump bones), `tools/mats.py`
  - `final/*.png` (renders)

## Status (2026-10-23 ~01:10). All six are EXPORTED and complete in public/models/chars (no WIP files).
Bone rest data was verified identical to anims.glb (and to the old us_rifleman.glb) for all six.

| id | triangles | status |
|---|---|---|
| us_rifleman | 21963 | exported 01:08, boot-shaft fix included |
| us_rifleman_b | 23637 | exported 01:09 |
| insurgent_a | 20354 | exported 01:00 |
| insurgent_b | 17732 | exported 01:01 |
| insurgent_c | 17542 | exported 01:02 |
| civilian_a | 15944 | exported 01:03 |

GLB sizes are 2.3-3.1 MB.

## Decisions and gotchas
- MakeHuman instead of Quaternius meshes: realistic proportions and faces, CC0. The UBC free pack has only the
  "Superhero" body.
- US uniform = MH male_casualsuit01 (button shirt + trousers) recoloured with procedural OCP. The original
  normal map and AO are kept. Gloves = the body's hand faces with a procedural glove texture.
- Robes = MH casualsuit02 top + a modelled skirt (gear_ins.robe_skirt). The legs under the robe are hidden.
- Bash heredocs with long Python sometimes fail in this tool ("unexpected EOF"). Use the Write/Edit tools.
- Non-bone vertex groups break part assignment (face_bones ignores them now).
- A global decimate with a protect group crushed the face. Region-split decimation fixes it.
- Ray casts around one leg must go from inside outwards (from outside they hit the other leg).
- MH .mhclo header keys may follow `verts 0`.
- Exporter warns ">4 influences" and normalises; that is fine.

## Next step (polish, optional)
1. us_rifleman_b is 23.6k triangles; lower the head (neck scarf / helmet decimation) to get under 20k.
2. Beards read as a flat painted mask. Add strand variation, or a thin alpha beard shell.
3. Head wraps (wrap/mask) hang oddly at the sides. Shape the drape. The civilian agal ring may be missing or
   floating: check it.
4. The insurgent_b track top shows a white hem line. The robe top has a hem step over the skirt.
5. Torso atlases have a low texel density (~2.2 mm). Better packing would help (island rotation, normal fix-up).
6. Render a first-person-like arms check with the Pistol_Aim_Neutral clip.

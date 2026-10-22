# Progress and handoff

Last updated 2026-10-21. Read this first when resuming; `CLAUDE.md` has the conventions, `docs/RESEARCH.md` the PR research.

## How to run
- `npm run dev`, open http://localhost:5173 (menu → faction → spawn screen → deploy).
- Test flags: `?auto=us` / `?auto=ins` (skip menus, auto-deploy, never pause), `?kit=us_ar` etc., `?q=low|medium|high`,
  `?shot=x,y,z,yawDeg,pitchDeg` (fixed camera), `?fly` (free camera), `?bots=0`.
- On this laptop, run on the AMD dGPU with `scripts/play-amd.sh` (sets `DRI_PRIME=1`). The menu shows which GPU renders.
- Screenshots: `node scripts/shot.mjs "<query>" out.png [waitMs]` (prints FPS, draw calls, triangles, per-system ms).
- CPU profile: `node scripts/profile.mjs "<query>" [seconds]` (inclusive time per `src/` function).
- Navmesh bake (needed after any city/props change): bundle and run `scripts/navmesh.ts`
  (`node_modules/.bin/esbuild scripts/navmesh.ts --bundle --platform=node --format=esm --outfile=/tmp/nav.mjs && node --max-old-space-size=6000 /tmp/nav.mjs 1337`)
  → `public/nav/zahran-1337.bin` (~1–2 min on an idle machine, ~13 MB; re-baked with props.glb on 2026-10-21). Shortcut: `npm run navmesh`.

## Done
- **Map "Al Zahran"** (`src/world/citygen.ts`, `building.ts`, `sink.ts`, `terrain.ts`): 1.3 km playable, 13×13 grid of 100 m,
  ~800 enterable buildings (dog-leg stairs to roof huts, partitions, doors/windows, parapets, battle damage), old town + souk +
  Grand Mosque, the Ruins, New Town apartments, civic district (police station, school, petrol station, hospital), industry,
  compounds, canal with bridges and palm groves, US FOB Hammer (east), insurgent base (west bank).
- **Rendering** (`render.ts`, `citymat.ts`, `core/gfx.ts`): one texture-array material for all city surfaces (Poly Haven CC0),
  per-chunk layers: interiors near only, detailed exteriors mid, LOD shells far; terrain splat shader; asphalt roads; canal;
  instanced props with distance culling; palm impostors (crossed quads rendered at load); HDRI sky; sun shadows following the
  camera; Medium/High add N8AO + bloom + AgX via `postprocessing`.
- **Physics** (`physics.ts`): Rapier; static city merged into ~80 trimesh colliders (one per 128 m chunk) — separate cuboids
  made `world.step` take 50–450 ms. Surfaces/building ids come from a 4 m spatial hash of the original boxes (trimesh hits
  carry no triangle id in this Rapier build). Heightfield terrain.
- **Weapons and ballistics** (`game/data/weapons.ts`, `projectiles.ts`, `soldier.ts`, `game.ts`): real v0, drag k, gravity,
  zeroing, PR deviation (stance/movement/settle/kick, no crosshair), fire modes, per-magazine inventory (mag count shown),
  penetration of thin materials, ricochets, supersonic cracks + suppression, rockets (boost/sustain/self-destruct), M203
  arming distance, grenades (Rapier bodies), C4/IED place-and-detonate, back-blast, explosions with LOS damage.
- **Kits** (`game/data/kits.ts`) per PR: US SL/Rifleman/Grenadier/AR/Medic/Engineer/LAT/MG/Sniper; INS Cell Leader/Insurgent/
  AT (RPG)/MG/AR/Marksman/Medic/Sapper.
- **Insurgency mode** (`game/insurgency.ts`): 6 caches, 2 active, C4 only, intel 25 to reveal (75 m circle), +30 tickets per
  cache, 5 to win, ticket loss per death, timer.
- **AI** (`ai/bot.ts`, `director.ts`, `nav.ts`): spotting meter, reaction time, aim error, deviation-limited fire, cover via
  stance under suppression, grenades, medics revive, engineers demolish caches; US squads move → search → secure; insurgent
  cells defend caches (rooms + nearby roofs) and roam toward gunfire; respawns. Bots on a navmesh path move along it (no
  character-controller sweep) — that cut AI from ~230 ms to ~1 ms per frame.
- **Player** (`player/player.ts`, `viewmodel.ts`), **HUD/map/menus** (`ui/`), **FX** (`fx/fx.ts`), **audio** (`audio/audio.ts`,
  73 CC0 sounds in `public/audio`, manifest-driven, speed-of-sound delay, near/far crossfade, occlusion).
- **Models** (Blender scripts in `tools/blender/`): all 25 weapons, 8 vehicles (m1114, hilux_dshk, sedan, pickup, wrecks,
  bus_wreck), props kit (63 props), characters (us_rifleman, us_rifleman_b, insurgent_a/b/c, civilian_a) + anims.glb (38 clips).

## Fixes after the first play test (2026-10-21, second pass)
- Stairs: each flight is now one closed solid (treads, risers, sides, sloped soffit) — no more see-through from below.
- Destroyed buildings: dicing replaced by structural damage (jagged breaches cut as stacked openings; a collapsed top-storey
  corner with stepped broken walls, missing roof section and rubble at `BuildingInfo.debris`). No floating fragments.
- Spawns: `safeSpawn()` (ai/nav.ts) snaps spawn points onto the navmesh and checks the body fits (`Physics.fits`).
- First-person weapon bobbing: sprint and weapon-switch poses are blended, sprint has stamina hysteresis (`sprintLock`),
  and touchpad wheel events are debounced (≥100 px, ≤ 1 notch / 250 ms).
- Third-person carry: blended aim / low-ready / port-arms poses anchored to the chest bone; hands IK'd to wrist targets,
  oriented exactly from the bone axes (`handAxes`, `wrapHand` in game/rig.ts) with curled fingers.
- First-person arms: the player's own character with only `part_arms` visible, same IK + hand wrap (player/viewmodel.ts).
- Debug: `?follow=N&dist=3&side=90` side camera on soldier N; `scripts/movetest.mjs` holds WASD and reports movement.
- Asset fixes handed back to the agents: boots (feet look bare), US gloves, insurgent head wraps, HESCO/minaret/dome/
  market stall/cache crate/rubble quality. Re-bake the navmesh after props.glb changes.

## Weapon flicker (fixed 2026-10-21, from the user's video)
- Cause: the viewmodel sway spring was integrated with one explicit step per frame (ω ≈ 49 rad/s). At ~20 FPS that is
  unstable — the sway overshot every frame, hit the ±5 cm clamp and flipped the weapon between two poses on alternate
  frames (looked like raising/lowering). Now sway and recoil springs run in fixed 240 Hz semi-implicit substeps and sway
  follows mouse speed. Regression check: `node scripts/vmtest.mjs` (needs `?vmlog`; viewmodel position must be steady).
- Launchers rest on the shoulder; grenades/charges are one-handed. `node scripts/slotshots.mjs <kit> <prefix>` screenshots
  every slot.

## Third play-test fixes (2026-10-21, user screenshots + video)
- Close-quarters test mode (menu "Mode", or `?mode=test`, `?area=x0,z0,x1,z1`): only the Ruins plaza (70×65 m) is built
  (generator crop: `CityOptions.area`, `Sink.clip/skip`), the rest of the town is far-LOD shells; HESCO boundary + walls;
  navmesh generated in the browser (`Nav.generate`); 3 v 3 elimination rounds (`game/skirmish.ts`, `ai/skirmish.ts`).
- Tactical AI (`ai/bot.ts` combat(), `ai/cover.ts`): team contact sharing (`Game.report/knownEnemy`), cover points from
  collision boxes (protect/peek ray tests), cover claims, hide → peek cycles with reloads in cover, suppressive fire
  while teammates move, flanking (`SkirmishDirector`), bounding overwatch (`advance()`), push on lost contact, bad-cover
  blacklist, grenade throws as a short state. Check with `node scripts/aitest.mjs <seconds>`.
- Hands: palm direction measured from the skeleton (`palmOf`), forearm twist, shoulder protraction IK (`armIK`), wrist
  targets; FP body uniform scale 1.08 (non-uniform bone scale sheared the wrist). `scripts/handprobe.mjs` dumps bone axes.
- Third-person aim: cheek weld from the Head bone (weapon `cheek` empty, else rear sight + 0.16 m).
- Hits: flinch clip, wounded fall (Death02 → Wounded_Loop), lying bodies grounded procedurally (`Rig.ground`), corpses
  persist (40) with dropped weapons, blood mist/droplets, splatter decals behind/below, spreading blood pools.
- FOV default 55° vertical (was 74°, made everything look tiny) + menu slider. Gunshots use one recording per weapon
  (`variant: 0`), the "variants" were different guns.
- Weapon realism rework running in the two weapon agents (adds `cheek` empty; FP ADS uses it when present).

## Fourth round: spawns, Six Days in Fallujah pass (2026-10-21/22)
Reference: Six Days in Fallujah (doors as the fatal funnel, dark furnished homes, room-dependent gun sound, weapon
lights). Sources: en.wikipedia.org/wiki/Six_Days_in_Fallujah, military.com (2021-04-20 article), techradar preview,
sixdays.com/news/sitrep-audio-design.
- **Spawns:** Skirmish picks a separate building per team (US westmost, INS eastmost, ~95 m apart); bots and the
  player spawn on its ground floor (`safeSpawn`).
- **Test-area boundary:** a building belongs to the area when its centre is inside; the play boundary (`city.area`)
  then grows to enclose those buildings whole and the HESCO line skips any building footprint (it used to cut
  through houses). Ground/roads/props are built 30 m wider.
- **Doors** (`src/game/doors.ts`, test mode only): hinged leaves in doorways with kinematic colliders (block movement,
  sight; wood can be shot through), start closed/ajar/open, exterior doors open inwards. Player: E toggles. Bots
  push doors open as they walk up (`openNear`). Full map: TODO (needs instancing: thousands of doorways).
- **Interiors:** rooms per floor (`BuildingInfo.rooms`: living/kitchen/bedroom/store), lime-washed interior paint
  per house, floors `checker` (two-tone terrazzo, Poly Haven floor_tiles_06) / `floor` (concrete_floor_02) / `tiles`.
  `furnish()` in citygen places the props kit furniture (props agent: 95 roots in props.glb) against walls, sized from
  the real extents, plus area-scaled fill and more junk in damaged houses.
- **Interior lighting** (`citymat.ts`): interior faces (layer 1) and furniture use a flat warm bounce ambient
  (`INTERIOR_AMBIENT`) instead of the sky IBL/hemisphere (floors used to be lit blue by the sky and mirrored it at
  grazing angles). Rooms are dim and tense; sun through windows/doors still comes in with shadows.
- **Acoustics** (`audio.ts`): two convolution reverbs with generated unit-energy IRs: a room (dense early reflections,
  ~0.7 s, bright) and a street (slapbacks at 45–800 ms off facades + 2.6 s dark tail). Each sound feeds the one for
  its *source* position (`indoorAt`: roof above + walls on ≥2 sides); wet share grows with distance. Outdoor ambience
  ducks indoors. `scripts/verbtest.mjs` measures the levels offline.
- **Weapon light** (T, US rifles/SAW/M240): shadowed SpotLight from the muzzle along the barrel; bots spot a soldier
  whose light points at them 3× faster. Always in the scene (no shader recompiles); its shadow map is rendered once at
  start (an unallocated map made the whole world vanish, only sky drew: fixed).
- **AI movement:** bots move on the navmesh (`Soldier.moveNav` → `Nav.step`, moveAlongSurface): no wall pass-through.
  Stale polygon refs re-queried (tight vertical search first); path corners advance only when reached/passed *and* the
  next corner is in a clear navmesh line (`Nav.clearLine`); bots used to wedge into doorway corners and never leave
  their building. Bot-only round: contact ~35 s, round decided at ~100 s.
- **Rounds** (user request 2026-10-22): no time limit; a round ends only when one team has nobody standing (both
  at once = draw). The HUD clock counts up. After 30 s without a shot the director sends every bot without a target
  towards the nearest standing enemy (±6 m), so quiet rounds cannot stall.
- **Weapons:** both weapon agents finished their realism passes (insurgent 2026-10-21 21:25, US 23:13).
- Perf (headless, AMD, 1280×720, test mode, player + 5 bots): Low 28 FPS, Medium 17 FPS.
- Test scripts: `doorshot`, `roomshot`, `lightshot`, `verbtest`, `fpstest`, `botprobe`, `pathprobe`, `navcheck`,
  `aitest`, `adsshots <kit> <team> <out>`.

## Performance (Intel HD 5500 / Radeon R5 M330, Low, 1280×720)
- ~19–24 FPS with 32 soldiers. Remaining cost is rendering (~40 ms): ~2.8M triangles incl. the shadow pass, ~700–1800 draw calls.
- Next steps: character LOD (hide skinned mesh / cheaper body beyond ~150 m), cheaper props in the shadow pass, fewer
  rooftop prop draw calls (merge per cell), shadow map only for near casters, maybe half-res rendering option.

## Known issues / TODO next
1. Characters verified in game (2026-10-21): US squad animates and holds rifles via IK. Still check insurgents/civilian,
   prone/wounded/death clips, and that clip names match
   `rig.ts` CLIP_SPEED/animate(): Idle_Loop, Walk_Loop, Jog_Fwd_Loop, Sprint_Loop, Crouch_*, Prone_Idle_Loop,
   Prone_Crawl_Loop, Wounded_Loop, Death01–03, Walk_Bwd_Loop, Strafe_L/R_Loop). `us_rifleman_b` exists (variant) — add to
   the US kit model list. First-person arms should switch from placeholder tubes to the character's `part_arms` + IK.
2. Props and character agents were stopped by usage limits mid-refinement (HESCO still looks like flat grey panels;
   minaret, dome, market stall, cache_crate need a look). Resume them, then re-bake the navmesh (`npm run navmesh`).
3. `npm run build` works (single 5.5 MB JS chunk; consider code-splitting later).
4. Vehicles: models exist, no driving yet (Rapier `DynamicRayCastVehicleController`, seats, M2/DShK turrets).
5. Not yet verified by playing: full squad behaviour over a whole round, cache demolition by bot engineers, insurgent
   respawn flow, M203/AT4/RPG feel, wounded/revive for the player.
6. Window frames/shutters/signage on facades for more realism; road markings beyond the boulevard; civilians.
7. AMD dGPU: card works after a fresh boot, but `radeon` runtime power management fails on resume
   (`si startup failed on resume`). Permanent fix needs root: `radeon.runpm=0` or switch to amdgpu
   (`radeon.si_support=0 amdgpu.si_support=1`). User has been told.

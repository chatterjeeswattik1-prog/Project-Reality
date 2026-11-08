// First-person rigs from the user's animated weapon packs (arms + weapon bones + clips) -> public/models/fp/<id>.glb
//   node scripts/fprig.mjs [m4] [ak] [pistol]
// Kept as glTF (not round-tripped through Blender, whose importer mangles these skins): the packs' own weapon meshes
// are dropped (the game hangs the contract weapon GLB on the weapon bones instead, see src/player/fprig.ts), clips are
// renamed and moved to start at 0, spec-gloss materials become metal-rough, textures are resized and re-encoded as WebP.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { metalRough, prune, dedup, textureCompress } from '@gltf-transform/functions';
import sharp from 'sharp';
import fs from 'node:fs';
import { extendSleeves } from './fpsleeve.mjs';

const SRC = 'E:/Terraform_Automation/New';
const PACKS = {
  m4: {
    src: `${SRC}/US-Forces/m4_-_fps_weapon_animations_pack_v.1.glb`,
    clips: { Fire: 'fire', Reload: 'reload', Reload_Empty: 'reload_empty', Draw: 'draw', Holster: 'holster' },
    drop: (n) => /_M4_D_0|^Bullet5_56x45mm_Bullet|^Icosphere/.test(n),
    sleeve: [/Hand_D/, 35, 5], // arm mesh in centimetres
  },
  ak: {
    src: `${SRC}/Insurgent/animated_aks-74u.glb`,
    clips: { 'armature|Fire_single': 'fire', 'armature|Reload_t': 'reload', 'armature|Reload_f': 'reload_empty', 'armature|Put_in': 'draw',
      'armature|Put_out': 'holster', 'armature|Fire_mode_select': 'firemode', 'armature|Fire_sprite': 'sprint' },
    drop: (n) => /^Object_1[012]$|^Icosphere/.test(n),
    sleeve: [/arms/, 0.0035, 0.06],
  },
  // "FPS pistol animations" by Cransh (CC BY 4.0): arms with a striker pistol; the game hangs the M9 / Makarov on its
  // frame (PBody), slide (Rif) and magazine (Pmag) bones. No draw clip: the game lowers the arms while switching.
  pistol: {
    src: `${SRC}/Pistol/fps_pistol_animations.glb`,
    clips: { 'Armature|FPS_Pistol_Fire': 'fire', 'Armature|FPS_Pistol_Reload_easy': 'reload', 'Armature|FPS_Pistol_Reload_full': 'reload_empty',
      'Armature|FPS_Pistol_Idle': 'idle', 'Armature|FPS_Pistol_Walk': 'walk' },
    drop: (n) => /^Object_9[135]$/.test(n),
    sleeve: null, // (extruding its shoulder rings stretched a spike across the view)
  },
};

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ sharp });
fs.mkdirSync('public/models/fp', { recursive: true });
for (const id of process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(PACKS)) {
  const P = PACKS[id];
  const doc = await io.read(P.src);
  const root = doc.getRoot();
  for (const n of root.listNodes()) if (n.getMesh() && P.drop(n.getName())) n.setMesh(null);
  // Longer sleeves: the cut ends at the shoulders stay out of view on wide screens.
  if (P.sleeve) extendSleeves(doc, P.sleeve[0], P.sleeve[1], P.sleeve[2]);
  // Clips: rename, drop unknown ones, shift every clip so it starts at t = 0.
  const shifted = new Map();
  for (const a of root.listAnimations()) {
    const name = P.clips[a.getName()];
    if (!name) { a.dispose(); continue; }
    a.setName(name);
    let t0 = Infinity;
    for (const s of a.listSamplers()) t0 = Math.min(t0, s.getInput().getMin([])[0]);
    for (const s of a.listSamplers()) {
      let inp = s.getInput();
      if (shifted.has(inp) && shifted.get(inp) !== a) { inp = inp.clone(); s.setInput(inp); }
      if (shifted.has(inp)) continue;
      shifted.set(inp, a);
      const arr = inp.getArray().slice();
      for (let i = 0; i < arr.length; i++) arr[i] -= t0;
      inp.setArray(arr);
    }
    let t1 = 0; for (const s of a.listSamplers()) t1 = Math.max(t1, s.getInput().getMax([])[0]);
    console.log(id, name, `${t1.toFixed(2)} s`);
  }
  await doc.transform(metalRough(), prune(), dedup(), textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024], quality: 92 }));
  const out = `public/models/fp/fp_${id}.glb`;
  await io.write(out, doc);
  console.log('wrote', out, (fs.statSync(out).size / 1e6).toFixed(2), 'MB');
}

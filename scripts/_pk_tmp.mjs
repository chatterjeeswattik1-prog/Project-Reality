import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(process.argv[2]); const r = doc.getRoot();
console.log('scenes', r.listScenes().length, 'nodes', r.listNodes().length, 'meshes', r.listMeshes().length, 'skins', r.listSkins().length, 'mats', r.listMaterials().map((m) => m.getName()).join(','));
for (const a of r.listAnimations()) { let t0 = 1e9, t1 = -1e9; for (const s of a.listSamplers()) { t0 = Math.min(t0, s.getInput().getMin([])[0]); t1 = Math.max(t1, s.getInput().getMax([])[0]); } console.log('anim', a.getName(), t0.toFixed(2), t1.toFixed(2), 'channels', a.listChannels().length); }
const walk = (n, d) => { const t = n.getTranslation(), s = n.getScale(); console.log(`${'  '.repeat(d)}${n.getName()}${n.getMesh() ? ` [mesh ${n.getMesh().getName()} prims ${n.getMesh().listPrimitives().length}]` : ''}${n.getSkin() ? ' [skin]' : ''} t ${t.map((x) => +x.toFixed(3))}${s.some((x) => Math.abs(x - 1) > 1e-3) ? ' s ' + s.map((x) => +x.toFixed(3)) : ''} r ${n.getRotation().map((x) => +x.toFixed(2))}`); for (const c of n.listChildren()) walk(c, d + 1); };
for (const sc of r.listScenes()) for (const n of sc.listChildren()) walk(n, 0);
for (const sk of r.listSkins()) console.log('skin joints', sk.listJoints().length, sk.listJoints().slice(0, 80).map((j) => j.getName()).join(' '));

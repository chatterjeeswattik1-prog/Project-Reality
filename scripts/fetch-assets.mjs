// Download the CC0 skies and PBR textures from Poly Haven (polyhaven.com, CC0: no attribution required) into public/assets/.
// Re-runnable: files already present are skipped. Usage: npm run assets
// The game runs without them (it falls back to flat colours).
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'assets');
const API = 'https://api.polyhaven.com';
/** Skies by time of day: [Poly Haven id, resolution]. */
const HDRIS = { day: ['kloofendal_43d_clear_puresky', '2k'], dusk: ['qwantani_dusk_2_puresky', '2k'], night: ['kloppenheim_02_puresky', '1k'] };
/** PBR textures: id → resolution. Diffuse, OpenGL normal and AO/rough/metal are fetched. */
const TEXTURES = {
  // walls
  beige_wall_001: '1k', beige_wall_002: '1k', clay_plaster: '1k', damaged_plaster: '1k', plastered_wall_03: '1k',
  concrete_wall_008: '1k', concrete_block_wall: '1k', large_sandstone_blocks: '1k', cracked_concrete_wall: '1k', concrete_brick_wall_001: '1k',
  // ground, roads, pavements
  dry_ground_01: '2k', gravelly_sand: '1k', dirt: '1k', asphalt_02: '1k', cracked_concrete: '1k', concrete_pavement: '1k', dry_mud_field_001: '1k',
  // floors and roofs
  concrete_floor_worn_001: '1k', large_grey_tiles: '1k', dirty_concrete: '1k', concrete_floor_02: '1k', worn_tile_floor: '1k', floor_tiles_06: '1k',
  // metal and wood
  corrugated_iron_02: '1k', green_metal_rust: '1k', distressed_painted_planks: '1k',
};

const exists = async (p) => { try { return (await stat(p)).size > 0; } catch { return false; } };
async function get(url, to) {
  if (await exists(to)) return 0;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  const b = Buffer.from(await r.arrayBuffer());
  await mkdir(dirname(to), { recursive: true }); await writeFile(to, b);
  return b.length;
}
const files = async (id) => { const r = await fetch(`${API}/files/${id}`); if (!r.ok) throw new Error(`${r.status} ${id}`); return r.json(); };
let bytes = 0;
const credits = [], missing = [];
for (const [name, [id, res]] of Object.entries(HDRIS)) {
  try { const f = await files(id); bytes += await get(f.hdri[res].hdr.url, join(OUT, 'hdri', `${name}.hdr`)); credits.push(`hdri/${name}.hdr  <-  ${id} (${res})`); }
  catch (e) { missing.push(`${id}: ${e.message}`); }
}
for (const [id, res] of Object.entries(TEXTURES)) {
  try {
    const f = await files(id), pick = (k) => f[k]?.[res]?.jpg?.url ?? f[k]?.['1k']?.jpg?.url;
    const maps = { diff: pick('Diffuse'), nor: pick('nor_gl'), arm: pick('arm') ?? pick('Rough') };
    for (const [k, u] of Object.entries(maps)) if (u) bytes += await get(u, join(OUT, 'tex', id, `${k}.jpg`));
    credits.push(`tex/${id}/  <-  ${id} (${res})`);
  } catch (e) { missing.push(`${id}: ${e.message}`); }
}
await writeFile(join(OUT, 'CREDITS.txt'), `Skies and textures from Poly Haven (https://polyhaven.com), licensed CC0 1.0 (public domain). No attribution is required; listed for traceability.\n\n${credits.join('\n')}\n`);
if (missing.length) console.warn(`Not found (skipped):\n  ${missing.join('\n  ')}`);
console.log(`Assets ready in ${OUT} (${(bytes / 1e6).toFixed(1)} MB downloaded this run).`);

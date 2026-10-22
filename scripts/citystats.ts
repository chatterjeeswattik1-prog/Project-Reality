import { generateCity } from '../src/world/citygen';
const t0 = performance.now();
const c = generateCity(1337);
const ms = performance.now() - t0;
const lay = [0, 0], mats: Record<string, number> = {};
for (const b of c.sink.batches.values()) { lay[b.layer] += b.n / 3; }
console.log({ ms: Math.round(ms), buildings: c.buildings.length, tris: c.sink.tris, extTris: lay[0], intTris: lay[1], batches: c.sink.batches.size, colliders: c.sink.colliders.length, props: c.props.length, cacheSpots: c.cacheSpots.length });
console.log(mats);

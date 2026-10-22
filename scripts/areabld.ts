import { generateCity } from '../src/world/citygen';
const A = { x0: -168, z0: 95, x1: -58, z1: 178 };
const c = generateCity(1337, { area: A });
for (const b of c.buildings) { const s = b.spec; console.log(b.id, 'c', ((s.x0 + s.x1) / 2).toFixed(0), ((s.z0 + s.z1) / 2).toFixed(0), 'size', (s.x1 - s.x0).toFixed(0), 'x', (s.z1 - s.z0).toFixed(0), 'fl', s.floors, 'dmg', s.damage.toFixed(2), 'spots0', b.spots.filter((p) => p[3] === 0).length); }

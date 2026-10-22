import { generateCity } from '../src/world/citygen';
const c = generateCity(1337);
const ruins = c.buildings.filter((b) => b.spec.damage > 0.6 && b.spec.floors >= 2 && b.spec.x1 - b.spec.x0 > 9).slice(0, 4);
for (const b of ruins) console.log('ruin', b.id, b.spec.orient, b.spec.floors, [b.spec.x0, b.spec.z0, b.spec.x1, b.spec.z1].map(Math.round), 'y0', b.spec.y0.toFixed(1), 'district', c.districtOf.get(b.id));
const st = c.buildings.find((b) => b.spec.floors >= 2 && b.spec.damage === 0 && b.spec.orient === 0 && b.spec.x1 - b.spec.x0 > 11 && b.spec.z1 - b.spec.z0 > 10)!;
console.log('stairs bldg', st.id, [st.spec.x0, st.spec.z0, st.spec.x1, st.spec.z1].map((v) => v.toFixed(1)), 'y0', st.spec.y0.toFixed(2), 't', st.spec.t, 'doors', st.doors.map((d) => d.map((v) => v.toFixed(1))));

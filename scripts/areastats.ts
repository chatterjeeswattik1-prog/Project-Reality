import { generateCity } from '../src/world/citygen';
const c = generateCity(1337);
const areas: Record<string, number[]> = { ruinsPlaza: [-175, 85, -55, 180], souk: [-200, -140, -80, -50], mosque: [-180, -240, -60, -130], newtown: [130, -200, 250, -100] };
for (const [n, [x0, z0, x1, z1]] of Object.entries(areas)) {
  const bs = c.buildings.filter((b) => b.spec.x1 > x0 && b.spec.x0 < x1 && b.spec.z1 > z0 && b.spec.z0 < z1);
  const props = c.props.filter((p) => p.x > x0 && p.x < x1 && p.z > z0 && p.z < z1);
  console.log(n, 'buildings', bs.length, 'floors', bs.map((b) => b.spec.floors).join(''), 'damaged', bs.filter((b) => b.spec.damage > 0).length, 'props', props.length);
}

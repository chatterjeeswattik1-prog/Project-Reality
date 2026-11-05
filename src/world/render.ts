// Turns the generated city into three.js meshes: building batches (exterior always, interiors near the camera),
// terrain with a mask-driven splat shader, asphalt roads, the canal, and instanced props.
import * as THREE from 'three';
import { gltf, pbr, tex } from '../core/assets';
import { CHUNK, MATS } from './sink';
import { cityMaterials, interiorLit } from './citymat';
import { fittedBoxes, solidBox, type PropCol } from './navgeom';
import { type City, MASK_HALF, MASK_N } from './citygen';
import { canalX, CANAL_W, groundH, HALF, OUTER, WATER_Y } from './terrain';

export interface WorldView {
  root: THREE.Group;
  /** Per-frame: show interiors only near the camera. */
  update: (cam: THREE.Vector3) => void;
  /** Register a mesh that is only drawn within `dist` (Chebyshev) of the camera. */
  cull: (mesh: THREE.Object3D, cx: number, cz: number, dist: number, far?: boolean) => void;
  stats: () => { meshes: number; tris: number };
  /** City meshes by generator batch id (destruction edits their faces), and the two city materials. */
  batchMesh: THREE.Mesh[];
  mats: { outdoor: THREE.Material; indoor: THREE.Material };
  /** Instance slots of each placed prop (index in city.props), so destruction can take one away. */
  propSlots: Map<number, [THREE.InstancedMesh, number][]>;
  /** Add a city mesh made at run time (wall remnants): culled like the generator's meshes of the same layer. */
  addCity: (mesh: THREE.Mesh, layer: number, cx: number, cz: number) => void;
}

export async function buildWorld(city: City, quality: 'low' | 'medium' | 'high'): Promise<WorldView> {
  const mats = await cityMaterials(quality);
  const root = new THREE.Group(); root.name = 'world';
  const lods: { mesh: THREE.Mesh; layer: number; cx: number; cz: number }[] = [];
  let tris = 0;
  const batchMesh: THREE.Mesh[] = [];
  for (const b of city.sink.batches.values()) {
    if (!b.n) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(b.pos.slice(0, b.n * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(b.nrm.slice(0, b.n * 3), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(b.uv.slice(0, b.n * 2), 2));
    g.setAttribute('color', new THREE.BufferAttribute(b.col.slice(0, b.n * 3), 3));
    g.setAttribute('mi', new THREE.BufferAttribute(b.mi.slice(0, b.n), 1));
    g.computeBoundingSphere(); g.computeBoundingBox();
    const mesh = new THREE.Mesh(g, b.layer === 1 ? mats.indoor : mats.outdoor);
    mesh.castShadow = b.layer !== 1; mesh.receiveShadow = true; mesh.matrixAutoUpdate = false;
    mesh.name = `city:${b.chunk}:${b.layer}`;
    mesh.userData.chunk = b.chunk; mesh.userData.layer = b.layer; batchMesh[b.id] = mesh;
    root.add(mesh); tris += b.n / 3;
    if (b.layer) { const c = g.boundingBox!.getCenter(new THREE.Vector3()); lods.push({ mesh, layer: b.layer, cx: c.x, cz: c.z }); }
  }
  // The generator's batches were copied into the meshes above (tightly sized): release them (hundreds of MB on the
  // full map).
  city.sink.batches.clear();
  root.add(terrain(city, quality));
  root.add(roads(city));
  if (!city.area || (city.area.x0 < -340 && city.area.x1 > -400)) root.add(water());
  const intDist = quality === 'low' ? 130 : quality === 'medium' ? 180 : 260, midDist = quality === 'low' ? 230 : quality === 'medium' ? 330 : 480;
  const culls: { mesh: THREE.Object3D; cx: number; cz: number; dist: number; far: boolean }[] = [];
  return {
    root,
    cull: (mesh, cx, cz, dist, far = false) => { culls.push({ mesh, cx, cz, dist, far }); },
    update: (cam) => {
      for (const c of culls) c.mesh.visible = (Math.max(Math.abs(cam.x - c.cx), Math.abs(cam.z - c.cz)) < c.dist) !== c.far;
      for (const it of lods) {
        const d = Math.max(Math.abs(cam.x - it.cx), Math.abs(cam.z - it.cz)) - CHUNK / 2;
        it.mesh.visible = it.layer === 1 ? d < intDist : it.layer === 2 ? d < midDist : d >= midDist;
      }
    },
    stats: () => ({ meshes: root.children.length, tris }),
    batchMesh, mats, propSlots: new Map(),
    addCity: (mesh, layer, cx, cz) => { root.add(mesh); if (layer) lods.push({ mesh, layer, cx, cz }); },
  };
}

// ---------- terrain ----------
function axisSamples(): number[] {
  // Dense (5 m) inside the playable area, then growing spacing out to the horizon.
  const xs: number[] = [];
  for (let x = -HALF - 80; x <= HALF + 80; x += 5) xs.push(x);
  let s = 5, x = HALF + 80;
  while (x < OUTER) { s *= 1.12; x += s; xs.push(Math.min(x, OUTER)); }
  const neg = xs.filter((v) => v > HALF + 80).map((v) => -v).reverse();
  return [...neg, ...xs];
}

function terrain(city: City, quality: string): THREE.Mesh {
  const xs = axisSamples(), n = xs.length;
  const pos = new Float32Array(n * n * 3), idx: number[] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = xs[i], z = xs[j], k = (j * n + i) * 3;
    pos[k] = x; pos[k + 1] = groundH(x, z); pos[k + 2] = z;
  }
  for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
    const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx); g.computeVertexNormals();
  const maskTex = new THREE.DataTexture(city.mask, MASK_N, MASK_N, THREE.RGBAFormat);
  maskTex.magFilter = THREE.LinearFilter; maskTex.minFilter = THREE.LinearFilter; maskTex.needsUpdate = true;
  const m = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 });
  m.map = tex('assets/tex/dry_ground_01/diff.jpg');
  m.normalMap = tex('assets/tex/dry_ground_01/nor.jpg', false);
  const tDirt = tex('assets/tex/dirt/diff.jpg'), tGravel = tex('assets/tex/gravelly_sand/diff.jpg'), tField = tex('assets/tex/dry_mud_field_001/diff.jpg');
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uMask = { value: maskTex }; sh.uniforms.uDirt = { value: tDirt }; sh.uniforms.uGravel = { value: tGravel }; sh.uniforms.uField = { value: tField };
    sh.uniforms.uMaskHalf = { value: MASK_HALF };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
varying vec3 vWPos; uniform sampler2D uMask, uDirt, uGravel, uField; uniform float uMaskHalf;
float hh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(hh(i), hh(i+vec2(1,0)), f.x), mix(hh(i+vec2(0,1)), hh(i+vec2(1,1)), f.x), f.y); }`)
      .replace('#include <map_fragment>', `
vec2 wuv = vWPos.xz;
vec4 mk = texture2D(uMask, (wuv + uMaskHalf) / (2.0 * uMaskHalf));
float n1 = vn(wuv * 0.035), n2 = vn(wuv * 0.21);
// Two scales of the base texture break up tiling; large-scale tone variation.
vec3 base = mix(texture2D(map, wuv / 7.0).rgb, texture2D(map, wuv / 23.0 + 0.37).rgb, 0.45);
base *= mix(0.86, 1.08, n1);
vec3 dirt = texture2D(uDirt, wuv / 4.0).rgb * vec3(1.02, 0.97, 0.9);
vec3 grav = texture2D(uGravel, wuv / 3.5).rgb;
vec3 field = texture2D(uField, wuv / 6.0).rgb * vec3(0.95, 0.95, 0.85);
vec3 col = base;
col = mix(col, dirt, smoothstep(0.15, 0.75, mk.r + (n2 - 0.5) * 0.35));
col = mix(col, grav, smoothstep(0.2, 0.8, mk.g + (n2 - 0.5) * 0.3));
col = mix(col, field, smoothstep(0.2, 0.8, mk.b + (n1 - 0.5) * 0.4));
col *= mix(1.0, 0.72, mk.a * smoothstep(1.0, -2.5, vWPos.y));
diffuseColor.rgb *= col;`)
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>')
      .replace('vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;', 'vec3 mapN = texture2D( normalMap, vWPos.xz / 7.0 ).xyz * 2.0 - 1.0;');
  };
  m.customProgramCacheKey = () => 'terrain-splat';
  // normalMap needs tangent-space UVs; give the geometry world-xz UVs as well.
  const uv = new Float32Array(n * n * 2);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { uv[(j * n + i) * 2] = xs[i] / 7; uv[(j * n + i) * 2 + 1] = -xs[j] / 7; }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  const mesh = new THREE.Mesh(g, m);
  mesh.receiveShadow = true; mesh.name = 'terrain'; mesh.matrixAutoUpdate = false;
  void quality;
  return mesh;
}

// ---------- roads ----------
function roads(city: City): THREE.Group {
  const grp = new THREE.Group(); grp.name = 'roads';
  const pos: number[] = [], uv: number[] = [];
  const lift = 0.06, step = 8, s = 1 / MATS.asphalt.uv;
  for (const r of city.roads) {
    if (r.kind !== 'boulevard' && r.kind !== 'avenue' && r.kind !== 'street') continue;
    const x0 = Math.max(r.x0, -OUTER), x1 = Math.min(r.x1, OUTER);
    const nx = Math.max(1, Math.ceil((x1 - x0) / step)), nz = Math.max(1, Math.ceil((r.z1 - r.z0) / step));
    const bridge = (x: number, z: number) => city.bridges.some((b) => x >= b.x0 - 0.5 && x <= b.x1 + 0.5 && z >= b.z0 - 0.5 && z <= b.z1 + 0.5);
    const yAt = (x: number, z: number) => (bridge(x, z) ? 0.06 + 0.02 : Math.max(groundH(x, z), Math.abs(x - canalX(z)) < CANAL_W ? 0 : -9) + lift);
    const A = city.area;
    for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
      if (A) { const mx = x0 + (x1 - x0) * (i + 0.5) / nx, mz = r.z0 + (r.z1 - r.z0) * (j + 0.5) / nz; if (mx < A.x0 - 400 || mx > A.x1 + 400 || mz < A.z0 - 400 || mz > A.z1 + 400) continue; }
      const ax = x0 + (x1 - x0) * i / nx, bx = x0 + (x1 - x0) * (i + 1) / nx, az = r.z0 + (r.z1 - r.z0) * j / nz, bz = r.z0 + (r.z1 - r.z0) * (j + 1) / nz;
      const q = [[ax, az], [ax, bz], [bx, bz], [ax, az], [bx, bz], [bx, az]];
      for (const [x, z] of q) { pos.push(x, yAt(x, z), z); uv.push(x * s, -z * s); }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  const m = pbr('asphalt_02', { color: 0xd8d2c8, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const mesh = new THREE.Mesh(g, m); mesh.receiveShadow = true; mesh.name = 'asphalt';
  grp.add(mesh);
  // Lane markings on the boulevard: dashed centre lines either side of the median.
  const mk: number[] = [];
  for (const zc of [-6.5, 6.5]) for (let x = -640; x < 640; x += 9) {
    if (city.bridges.some((b) => x > b.x0 && x < b.x1)) continue;
    const y = Math.max(groundH(x, zc), 0) + lift + 0.01;
    mk.push(x, y, zc - 0.07, x, y, zc + 0.07, x + 4, y, zc + 0.07, x, y, zc - 0.07, x + 4, y, zc + 0.07, x + 4, y, zc - 0.07);
  }
  const gm = new THREE.BufferGeometry(); gm.setAttribute('position', new THREE.Float32BufferAttribute(mk, 3)); gm.computeVertexNormals();
  const mm = new THREE.MeshStandardMaterial({ color: 0xbdb7a8, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  grp.add(new THREE.Mesh(gm, mm));
  return grp;
}

// ---------- canal ----------
function water(): THREE.Mesh {
  const pos: number[] = [];
  for (let z = -OUTER; z < OUTER; z += 10) {
    const w = CANAL_W / 2 + 3, a = canalX(z), b = canalX(z + 10);
    pos.push(a - w, WATER_Y, z, a - w, WATER_Y, z + 10, b + w, WATER_Y, z + 10, a - w, WATER_Y, z, b + w, WATER_Y, z + 10, a + w, WATER_Y, z);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals();
  const m = new THREE.MeshStandardMaterial({ color: 0x3c4a33, roughness: 0.08, metalness: 0.0, envMapIntensity: 1.2, transparent: true, opacity: 0.92 });
  m.normalMap = tex('assets/tex/concrete_pavement/nor.jpg', false); m.normalScale.set(0.08, 0.08);
  const mesh = new THREE.Mesh(g, m); mesh.name = 'canal'; mesh.receiveShadow = true;
  return mesh;
}

// ---------- props ----------
interface Part { geo: THREE.BufferGeometry; mat: THREE.Material | THREE.Material[]; local: THREE.Matrix4 }
const FALLBACK: Record<string, [number, number, number, number]> = {
  // w, h, d, colour — used only when props.glb is missing.
  palm_a: [0.5, 9, 0.5, 0x6b5a3e], palm_b: [0.5, 11, 0.5, 0x6b5a3e], palm_c: [0.5, 7, 0.5, 0x6b5a3e], water_tank: [1.1, 1.6, 1.1, 0x222222],
  water_tank_steel: [1.2, 1.8, 1.2, 0x8a8a88], sat_dish: [1, 1.2, 0.4, 0xdddddd], hesco_wall: [5.3, 1.37, 1.06, 0x9c8a62], t_wall: [1.5, 3.6, 0.6, 0xaaa69e],
  conex: [2.44, 2.6, 6.06, 0x8a6a40], guard_tower: [3, 6, 3, 0x7a6a50], tent_military: [5, 3, 8, 0x9c8c68], market_stall: [2.5, 2.4, 1.8, 0x8a5a3a],
  minaret: [4, 28, 4, 0xd8c8a8], dome_large: [12, 7, 12, 0x5aa0a0], rubble_a: [3, 1, 3, 0x9a9080], rubble_b: [4, 1.4, 4, 0x9a9080], rubble_c: [5, 1.8, 5, 0x9a9080],
  'veh:sedan': [1.75, 1.45, 4.5, 0xd8d4c8], 'veh:pickup': [1.75, 1.7, 4.9, 0xd8d4c8], 'veh:sedan_wreck': [1.75, 1.3, 4.5, 0x3a3028], 'veh:pickup_wreck': [1.75, 1.5, 4.9, 0x3a3028],
  'veh:m1114_wreck': [2.3, 1.9, 5, 0x2a2420], 'veh:bus_wreck': [2.3, 2.6, 7, 0x3a3028],
};
export interface PropBox { c: [number, number, number]; h: [number, number, number]; ry: number; id: string; /** Index in city.props. */ pi?: number; /** World-space triangles for props that collide with their real shape (rubble, wrecks…). */ tris?: { pos: Float32Array; idx: Uint32Array } }

/** Instance all props; returns the solid props' boxes (for colliders), measured from the models. */
export async function buildProps(city: City, world: WorldView, shadows: boolean, quality: 'low' | 'medium' | 'high', renderer: THREE.WebGLRenderer): Promise<PropBox[]> {
  const root = world.root, smallDist = quality === 'low' ? 160 : quality === 'medium' ? 240 : 360, nearDist = quality === 'low' ? 110 : quality === 'medium' ? 170 : 260;
  const impostors = new Map<string, { geo: THREE.BufferGeometry; mat: THREE.Material } | null>();
  const kit = await gltf('models/props.glb');
  const vehNames = [...new Set(city.props.filter((p) => p.id.startsWith('veh:')).map((p) => p.id.slice(4)))];
  const vehicles = new Map<string, THREE.Object3D | null>();
  await Promise.all(vehNames.map(async (v) => vehicles.set(v, (await gltf(`models/vehicles/${v}.glb`))?.scene ?? null)));
  const parts = new Map<string, Part[]>(), boxes = new Map<string, THREE.Box3>();
  const partsOf = (id: string): Part[] => {
    if (parts.has(id)) return parts.get(id)!;
    let src: THREE.Object3D | null | undefined = id.startsWith('veh:') ? vehicles.get(id.slice(4)) : kit?.scene.getObjectByName(id);
    const out: Part[] = [];
    if (src) {
      src.updateMatrixWorld(true);
      const inv = src.matrixWorld.clone().invert();
      const indoor = INTERIOR.test(id) || /^mattress_upright/.test(id);
      src.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) out.push({ geo: m.geometry, mat: indoor ? interiorLit(m.material) : m.material, local: inv.clone().multiply(m.matrixWorld) }); });
      boxes.set(id, new THREE.Box3().setFromObject(src).applyMatrix4(inv));
    }
    if (!out.length && INTERIOR.test(id)) { parts.set(id, out); return out; } // furniture not in the kit yet: skip
    if (!out.length) {
      const f = FALLBACK[id] ?? [1, 1, 1, 0x8a8070];
      const geo = new THREE.BoxGeometry(f[0], f[1], f[2]); geo.translate(0, f[1] / 2, 0);
      out.push({ geo, mat: new THREE.MeshStandardMaterial({ color: f[3], roughness: 0.9 }), local: new THREE.Matrix4() });
      boxes.set(id, new THREE.Box3(new THREE.Vector3(-f[0] / 2, 0, -f[2] / 2), new THREE.Vector3(f[0] / 2, f[1], f[2] / 2)));
    }
    parts.set(id, out);
    return out;
  };
  // Group placements by prop and 256 m cell so each InstancedMesh culls locally.
  const groups = new Map<string, number[]>();
  city.props.forEach((p, pi) => {
    const cs = IMPOSTOR.has(p.id) ? 128 : 256;
    const key = `${p.id}|${Math.floor((p.x + 2048) / cs)}|${Math.floor((p.z + 2048) / cs)}|${cs}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(pi);
  });
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), sc = new THREE.Vector3(), tr = new THREE.Vector3();
  for (const [key, idx] of groups) {
    const id = key.split('|')[0], list = idx.map((i) => city.props[i]);
    for (const part of partsOf(id)) {
      const im = new THREE.InstancedMesh(part.geo, part.mat, list.length);
      list.forEach((p, i) => {
        q.setFromAxisAngle(up, p.ry); sc.setScalar(p.s ?? 1); tr.set(p.x, p.y, p.z);
        im.setMatrixAt(i, m4.compose(tr, q, sc).multiply(part.local));
        if (!IMPOSTOR.has(id)) { const sl = world.propSlots.get(idx[i]); if (sl) sl.push([im, i]); else world.propSlots.set(idx[i], [[im, i]]); }
      });
      im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere();
      im.castShadow = shadows && !id.startsWith('grass'); im.receiveShadow = true; im.name = `prop:${id}`;
      root.add(im);
      const bb = boxes.get(id), big = bb ? Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z) > 4 : false;
      const [, gx, gz, cs] = key.split('|').map(Number), ccx = gx * cs - 2048 + cs / 2, ccz = gz * cs - 2048 + cs / 2;
      if (IMPOSTOR.has(id)) world.cull(im, ccx, ccz, nearDist + cs / 2);
      else if (!big) world.cull(im, ccx, ccz, smallDist + cs / 2);
    }
    // Far LOD: crossed-quad impostors for the heavy repeated props (palms).
    if (IMPOSTOR.has(id) && partsOf(id).length && boxes.get(id)) {
      let imp = impostors.get(id);
      if (!imp) { imp = makeImpostor(renderer, kit?.scene.getObjectByName(id) ?? null, boxes.get(id)!); impostors.set(id, imp); }
      if (imp) {
        const im = new THREE.InstancedMesh(imp.geo, imp.mat, list.length);
        list.forEach((p, i) => { q.setFromAxisAngle(up, p.ry); sc.setScalar(p.s ?? 1); tr.set(p.x, p.y, p.z); im.setMatrixAt(i, m4.compose(tr, q, sc)); });
        im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere(); im.name = `impostor:${id}`; im.castShadow = false;
        root.add(im);
        const [, gx, gz, cs] = key.split('|').map(Number);
        world.cull(im, gx * cs - 2048 + cs / 2, gz * cs - 2048 + cs / 2, nearDist + cs / 2, true);
      }
    }
  }
  // Collision: each solid prop is a few boxes fitted to its real shape (scripts/propcol.mjs), shared with the navmesh
  // baker. Not the full mesh (10 M triangles on the full map) and not its bounding box (invisible walls round open
  // shapes: tank legs, pole cross-arms, dishes).
  const col = (await fetch(`${import.meta.env.BASE_URL}models/props_col.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}))) as PropCol;
  const solid: PropBox[] = [];
  for (let pi = 0; pi < city.props.length; pi++) {
    const p = city.props[pi];
    if (!p.solid) continue;
    if (EXACT.test(p.id)) {
      // Mounds and wrecks: their real triangles (a few hundred props on the map).
      const b = boxes.get(p.id); if (!b) continue;
      const sb = solidBox(p.id, b.min.toArray(), b.max.toArray(), p);
      const pos: number[] = [], idx: number[] = [], m = new THREE.Matrix4().compose(new THREE.Vector3(p.x, p.y, p.z), new THREE.Quaternion().setFromAxisAngle(up, p.ry), new THREE.Vector3().setScalar(p.s ?? 1)), v = new THREE.Vector3();
      for (const part of partsOf(p.id)) {
        const pa = part.geo.getAttribute('position'), base = pos.length / 3, mm = m.clone().multiply(part.local);
        for (let i = 0; i < pa.count; i++) { v.fromBufferAttribute(pa, i).applyMatrix4(mm); pos.push(v.x, v.y, v.z); }
        const ix = part.geo.getIndex();
        if (ix) for (let i = 0; i < ix.count; i++) idx.push(base + ix.getX(i)); else for (let i = 0; i < pa.count; i++) idx.push(base + i);
      }
      solid.push({ pi, c: sb.c as [number, number, number], h: [sb.h[0] * 0.8, sb.h[1] * 0.7, sb.h[2] * 0.8], ry: p.ry, id: p.id, tris: { pos: new Float32Array(pos), idx: new Uint32Array(idx) } });
      continue;
    }
    const fb = col[p.id];
    if (fb?.length) { for (const b of fittedBoxes(p.id, fb, p)) solid.push({ pi, c: b.c as [number, number, number], h: b.h as [number, number, number], ry: p.ry, id: p.id }); continue; }
    const b = boxes.get(p.id); if (!b) continue;
    const sb = solidBox(p.id, b.min.toArray(), b.max.toArray(), p);
    solid.push({ pi, c: sb.c as [number, number, number], h: sb.h as [number, number, number], ry: p.ry, id: p.id });
  }
  return solid;
}

/** Props that collide with their real mesh: mounds and wrecks, whose sloped and broken surfaces boxes fit badly. */
const EXACT = /^(rubble_|debris_|veh:.*_wreck|burnt_tyre|market_stall|dome_|minaret|fountain)/;

const IMPOSTOR = new Set(['palm_a', 'palm_b', 'palm_c']);
/** Interior furniture ids (from the furniture kit); skipped entirely while the kit lacks them. */
const INTERIOR = /^(floor_cushions|sofa_old|armchair|rug_|coffee_table|tv_crt|side_table|curtain_|bed_double|mattress_|wardrobe|dresser|clothes_pile|prayer_mat|kitchen_|fridge_old|gas_stove|table_dining|water_cooler|cardboard_boxes|plastic_crates|shoes_rack|wall_shelf|ceiling_fan|bulb_hanging|picture_frame|broken_furniture|sandbag_window|bedsheet_window)/;

/** Render a model from the front and the side into one texture; return two crossed alpha-cut quads using it. */
function makeImpostor(renderer: THREE.WebGLRenderer, src: THREE.Object3D | null, box: THREE.Box3): { geo: THREE.BufferGeometry; mat: THREE.Material } | null {
  if (!src) return null;
  const size = box.getSize(new THREE.Vector3()), w = Math.max(size.x, size.z) * 1.02, h = size.y * 1.02, cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
  const S = 512, rt = new THREE.WebGLRenderTarget(S, S, { colorSpace: THREE.SRGBColorSpace });
  const sc = new THREE.Scene(), obj = src.clone();
  obj.position.set(0, 0, 0); obj.rotation.set(0, 0, 0); obj.scale.set(1, 1, 1);
  sc.add(obj, new THREE.HemisphereLight(0xdfe6f0, 0x8a7a5e, 1.2));
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.6); sun.position.set(-0.5, 0.8, 0.6); sc.add(sun);
  const cam = new THREE.OrthographicCamera(-w / 2, w / 2, box.max.y + h * 0.01, box.min.y, -100, 100);
  const prev = { vp: renderer.getViewport(new THREE.Vector4()), scis: renderer.getScissor(new THREE.Vector4()), rt: renderer.getRenderTarget(), tm: renderer.toneMapping, color: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha(), sc: renderer.getScissorTest() };
  renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 0); renderer.setScissorTest(true);
  for (let v = 0; v < 2; v++) {
    const a = v * Math.PI / 2;
    cam.position.set(cx + Math.sin(a) * 50, 0, cz + Math.cos(a) * 50); cam.lookAt(cx, 0, cz); cam.position.y = 0; cam.updateMatrixWorld();
    rt.viewport.set(v * S / 2, 0, S / 2, S); rt.scissor.set(v * S / 2, 0, S / 2, S);
    renderer.setViewport(v * S / 2, 0, S / 2, S); renderer.setScissor(v * S / 2, 0, S / 2, S);
    renderer.clear(); renderer.render(sc, cam);
  }
  renderer.setScissorTest(prev.sc); renderer.setRenderTarget(prev.rt); renderer.toneMapping = prev.tm; renderer.setClearColor(prev.color, prev.alpha);
  renderer.setViewport(prev.vp); renderer.setScissor(prev.scis);
  rt.viewport.set(0, 0, S, S);
  rt.texture.generateMipmaps = true; rt.texture.minFilter = THREE.LinearMipmapLinearFilter;
  // Two quads (front view on +z normal plane, side view on the x plane), base at box.min.y.
  const pos: number[] = [], uv: number[] = [], y0 = box.min.y, y1 = box.max.y + h * 0.01;
  const quad = (ax: number, az: number, bx: number, bz: number, u0: number, u1: number) => {
    pos.push(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y0, az, bx, y1, bz, ax, y1, az);
    uv.push(u0, 0, u1, 0, u1, 1, u0, 0, u1, 1, u0, 1);
  };
  quad(cx - w / 2, cz, cx + w / 2, cz, 0, 0.5);
  quad(cx, cz + w / 2, cx, cz - w / 2, 0.5, 1);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); geo.computeVertexNormals();
  const mat = new THREE.MeshBasicMaterial({ map: rt.texture, alphaTest: 0.45, side: THREE.DoubleSide });
  return { geo, mat };
}

// One material for every static city surface: the Poly Haven sets are packed into texture arrays (diffuse, normal,
// AO/rough/metal) and each vertex carries its layer index, so a whole chunk draws in a single call.
import * as THREE from 'three';
import { maxAniso } from '../core/assets';
import { MATS } from './sink';

const BASE = import.meta.env.BASE_URL;

async function loadPixels(url: string, size: number): Promise<Uint8ClampedArray | null> {
  try {
    const r = await fetch(url); if (!r.ok) return null;
    const bmp = await createImageBitmap(await r.blob(), { resizeWidth: size, resizeHeight: size, resizeQuality: 'high' });
    const c = new OffscreenCanvas(size, size), x = c.getContext('2d')!;
    x.drawImage(bmp, 0, 0); bmp.close();
    return x.getImageData(0, 0, size, size).data;
  } catch { return null; }
}

async function arrayTexture(kind: 'diff' | 'nor' | 'arm', size: number, fallback: [number, number, number]): Promise<THREE.DataArrayTexture> {
  const ids = Object.values(MATS).map((m) => m.tex), n = ids.length, data = new Uint8Array(size * size * 4 * n);
  const px = await Promise.all(ids.map((id) => loadPixels(`${BASE}assets/tex/${id}/${kind}.jpg`, size)));
  px.forEach((p, i) => {
    if (p) data.set(p, i * size * size * 4);
    else for (let k = 0; k < size * size; k++) data.set([...fallback, 255], (i * size * size + k) * 4);
  });
  const t = new THREE.DataArrayTexture(data, size, size, n);
  t.format = THREE.RGBAFormat; t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = true;
  t.anisotropy = maxAniso;
  if (kind === 'diff') t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * Interior faces (their own meshes) get `interior`: the sky's image-based light and the hemisphere light are replaced
 * by a flat, warm bounce level that does not depend on the facing. Otherwise floors under a roof would be lit by the
 * full blue sky dome. Sun through windows and doors still arrives as direct light, with shadows.
 */
export const INTERIOR_AMBIENT = { value: new THREE.Color(0.5, 0.46, 0.4) };

/**
 * Blast scorching on city surfaces: the last MAX_SCORCH blasts (centre, hole radius). The city shader darkens what is
 * left of the wall or floor round each one (soot, radiating cracks, fragment pocks), so the marks exist only where
 * the surface does: never a sheet hanging over a window or over the hole itself.
 */
const MAX_SCORCH = 32;
const SCORCH = { value: Array.from({ length: MAX_SCORCH }, () => new THREE.Vector4(0, -1e4, 0, 0)) };
let scorchN = 0;
export function addScorch(p: [number, number, number] | number[], r: number) {
  SCORCH.value[scorchN % MAX_SCORCH].set(p[0], p[1], p[2], r); scorchN++;
}

export async function cityMaterials(quality: 'low' | 'medium' | 'high'): Promise<{ outdoor: THREE.MeshStandardMaterial; indoor: THREE.MeshStandardMaterial }> {
  const ds = quality === 'low' ? 512 : 1024, ns = quality === 'high' ? 1024 : 512;
  const [diff, nor, arm] = await Promise.all([arrayTexture('diff', ds, [180, 170, 150]), arrayTexture('nor', ns, [128, 128, 255]), arrayTexture('arm', 256, [255, 230, 0])]);
  return { outdoor: make(diff, nor, arm, false), indoor: make(diff, nor, arm, true) };
}

function make(diff: THREE.DataArrayTexture, nor: THREE.DataArrayTexture, arm: THREE.DataArrayTexture, interior: boolean): THREE.MeshStandardMaterial {
  // Dummy 1×1 maps switch on the UV/tangent code paths of MeshStandardMaterial; the shader samples the arrays instead.
  const dummy = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); dummy.needsUpdate = true;
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, map: dummy, normalMap: dummy, roughnessMap: dummy });
  m.normalScale.set(0.9, 0.9);
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uScorch = SCORCH;
    sh.uniforms.tDiff = { value: diff }; sh.uniforms.tNor = { value: nor }; sh.uniforms.tArm = { value: arm };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float mi;\nflat varying float vMi;\nvarying vec3 vCityW;\nvarying vec3 vCityN;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvMi = mi;\nvCityW = position;\nvCityN = normal;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
flat varying float vMi;
varying vec3 vCityW;
varying vec3 vCityN;
uniform highp sampler2DArray tDiff, tNor, tArm;
uniform vec4 uScorch[${MAX_SCORCH}];
// Smooth value noise (city macro variation).
float cHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float cNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(cHash(i), cHash(i + vec2(1, 0)), f.x), mix(cHash(i + vec2(0, 1)), cHash(i + vec2(1, 1)), f.x), f.y); }`)
      // Anti-tiling: a second sample of the same texture (rotated ~37°, scaled ×0.61, shifted) blended in where a large
      // noise says so, and a gentle patchy brightness variation, so a wall does not repeat its 2–3 m tile every few metres.
      .replace('#include <map_fragment>', `{
  vec2 uv2 = mat2(0.8, -0.6, 0.6, 0.8) * vMapUv * 0.61 + vec2(0.37, 0.71);
  vec2 q = vCityW.xz * 0.11 + vCityW.y * vec2(0.07, -0.05);
  float b = smoothstep(0.35, 0.65, cNoise(q));
  vec4 t1 = texture(tDiff, vec3(vMapUv, vMi)), t2 = texture(tDiff, vec3(uv2, vMi));
  vec4 tc = mix(t1, t2, b * 0.55);
  float macro = mix(0.9, 1.07, cNoise(vCityW.xz * 0.045 + vec2(vCityW.y * 0.03, 3.1)));
  // Weathering on outside walls: dust and rain streaks running down from sills and the roof edge (narrow across the
  // wall, long vertically). Interiors get none.
  float wallF = (1.0 - abs(vCityN.y)) * ${interior ? '0.0' : '1.0'};
  float along = dot(vCityW.xz, vec2(-vCityN.z, vCityN.x));
  float st = cNoise(vec2(along * 2.1, vCityW.y * 0.09)) * cNoise(vec2(along * 0.37 + 5.3, vCityW.y * 0.05));
  macro *= 1.0 - wallF * 0.2 * smoothstep(0.22, 0.6, st);
  diffuseColor *= vec4(tc.rgb * macro, tc.a);
  // Blast scorching (see addScorch): soot fading out to ~2.6 hole radii, hairline cracks running out from the edge,
  // and fragment pocks; in the plane of the face, so both faces of a breached wall and the floor round a hole get it.
  vec3 sn = normalize(vCityN);
  vec3 s1 = normalize(abs(sn.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : cross(vec3(0.0, 1.0, 0.0), sn)), s2 = cross(sn, s1);
  // Only the distance test runs for every blast; the noise work only within reach of one. (Written as an if block:
  // an early 'continue' here was mis-compiled by the D3D back end and dropped the marks.)
  float lit = 1.0;
  for (int i = 0; i < ${MAX_SCORCH}; i++) {
    vec4 B = uScorch[i];
    vec3 dv = vCityW - B.xyz;
    float d = length(dv), R = max(B.w, 0.15), far = R * 3.2 + 0.5;
    if (d < far) {
      vec2 P = vec2(dot(dv, s1), dot(dv, s2));
      float seed = fract(B.x * 0.137 + B.z * 0.0711 + B.y * 0.213) * 50.0;
      // Soot: densest at the edge of the hole, patchy and streaky, fading out over ~3 radii.
      float fall = 1.0 - smoothstep(R * 0.8, far, d);
      float soot = smoothstep(0.05, 0.9, fall * (0.6 + 0.55 * cNoise(P * 2.2 + seed)) * (0.8 + 0.25 * cNoise(P * 9.0 - seed))) * 0.9;
      // Cracks: a few hairlines running out from the edge. Each wanders at three scales (a slow bend, a ~15 cm kink
      // and a ~5 cm jag; the small ones are sideways distances, so they do not grow with range), breaks off in
      // places, thins and stops at its own length. Not every sector has one.
      float slow = (cNoise(vec2(d * 2.2, seed)) - 0.5) * 0.9;
      float kink = ((cNoise(vec2(d * 7.0, seed + 3.7)) - 0.5) * 0.16 + (cNoise(vec2(d * 21.0, seed + 9.1)) - 0.5) * 0.06) / max(d * 0.9, 0.15);
      float a = atan(P.y, P.x) / 6.2831853 * 7.0 + slow + kink;
      float id = floor(a), h = cHash(vec2(id, seed));
      float side = abs(fract(a + h) - 0.5) * 2.0 * 0.45 * d; // sideways distance from the crack line (m)
      float reach = R * (1.15 + 0.9 * cHash(vec2(id, seed + 1.0)));
      float wdt = 0.004 + 0.006 * (1.0 - smoothstep(R, reach, d));
      float gap = smoothstep(0.25, 0.4, cNoise(vec2(d * 4.5, id * 3.1 + seed)));
      float crack = (1.0 - smoothstep(wdt * 0.5, wdt, side)) * gap * step(R * 0.85, d) * (1.0 - smoothstep(reach * 0.75, reach, d)) * 0.8;
      // Fragment pocks: scattered dark chips knocked out of the render.
      vec2 g = P * 5.0, cell = floor(g), f = fract(g) - 0.5;
      vec2 jo = vec2(cHash(cell + 3.1 + seed), cHash(cell + 7.7 + seed)) - 0.5;
      float pr = 0.06 + 0.1 * cHash(cell + 11.3 + seed);
      float pock = step(0.68, cHash(cell + seed)) * (1.0 - smoothstep(pr * 0.6, pr, length(f - jo * 0.5))) * (1.0 - smoothstep(R * 1.4, far * 1.1, d)) * 0.7;
      lit *= 1.0 - clamp(1.0 - (1.0 - soot) * (1.0 - crack) * (1.0 - pock), 0.0, 0.96);
    }
  }
  diffuseColor.rgb *= lit;
}`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * texture(tArm, vec3(vRoughnessMapUv, vMi)).g;')
      .replace('vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;', 'vec3 mapN = texture(tNor, vec3(vNormalMapUv, vMi)).xyz * 2.0 - 1.0;');
    if (interior) {
      sh.uniforms.uIntAmb = INTERIOR_AMBIENT;
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uIntAmb;')
        .replace('#include <lights_fragment_end>', 'irradiance = uIntAmb * PI; iblIrradiance = vec3(0.0); radiance = uIntAmb * 0.6;\n#include <lights_fragment_end>')
        // Interior faces carry a dark baked shade (≤ 0.5, it marks them as interior); with the bounce light alone that
        // left lime-washed walls a muddy brown. Lift them back towards their paint colour.
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= 1.45;');
    }
  };
  m.customProgramCacheKey = () => (interior ? 'city-array-int' : 'city-array');
  return m;
}

/** The same interior lighting for a furniture material (cached clone per source material). */
const intCache = new WeakMap<THREE.Material, THREE.Material>();
export function interiorLit<T extends THREE.Material | THREE.Material[]>(m: T): T {
  if (Array.isArray(m)) return m.map((x) => interiorLit(x)) as T;
  const src = m as THREE.Material;
  if (!(src as THREE.MeshStandardMaterial).isMeshStandardMaterial) return m;
  let c = intCache.get(src);
  if (!c) {
    c = src.clone();
    c.onBeforeCompile = (sh) => {
      sh.uniforms.uIntAmb = INTERIOR_AMBIENT;
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uIntAmb;')
        .replace('#include <lights_fragment_end>', 'irradiance = uIntAmb * PI; iblIrradiance = vec3(0.0); radiance = uIntAmb * 0.6;\n#include <lights_fragment_end>');
    };
    c.customProgramCacheKey = () => 'interior-lit';
    intCache.set(src, c);
  }
  return c as T;
}

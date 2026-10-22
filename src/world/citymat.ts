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
export const INTERIOR_AMBIENT = { value: new THREE.Color(0.42, 0.37, 0.31) };

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
    sh.uniforms.tDiff = { value: diff }; sh.uniforms.tNor = { value: nor }; sh.uniforms.tArm = { value: arm };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float mi;\nflat varying float vMi;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvMi = mi;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nflat varying float vMi;\nuniform highp sampler2DArray tDiff, tNor, tArm;')
      .replace('#include <map_fragment>', 'diffuseColor *= texture(tDiff, vec3(vMapUv, vMi));')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * texture(tArm, vec3(vRoughnessMapUv, vMi)).g;')
      .replace('vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;', 'vec3 mapN = texture(tNor, vec3(vNormalMapUv, vMi)).xyz * 2.0 - 1.0;');
    if (interior) {
      sh.uniforms.uIntAmb = INTERIOR_AMBIENT;
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uIntAmb;')
        .replace('#include <lights_fragment_end>', 'irradiance = uIntAmb * PI; iblIrradiance = vec3(0.0); radiance = uIntAmb * 0.6;\n#include <lights_fragment_end>');
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

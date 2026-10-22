// Asset loading with caches: glTF scenes, PBR texture sets, HDR skies. Missing files resolve to null so the game can
// fall back to plain shapes and colours.
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';

const BASE = import.meta.env.BASE_URL;
const gltfCache = new Map<string, Promise<GLTF | null>>();
const loader = new GLTFLoader();

export function gltf(path: string): Promise<GLTF | null> {
  if (!gltfCache.has(path)) gltfCache.set(path, loader.loadAsync(`${BASE}${path}`).catch((e) => { console.warn('missing model', path, e?.message ?? e); return null; }));
  return gltfCache.get(path)!;
}

const texLoader = new THREE.TextureLoader();
const texCache = new Map<string, THREE.Texture>();
export let maxAniso = 4;
export function setAniso(a: number) { maxAniso = a; }

export function tex(path: string, srgb = true): THREE.Texture {
  const key = `${path}|${srgb}`;
  let t = texCache.get(key);
  if (!t) {
    t = texLoader.load(`${BASE}${path}`, undefined, undefined, () => console.warn('missing texture', path));
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = maxAniso;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    texCache.set(key, t);
  }
  return t;
}

/** A Poly Haven PBR set (diff/nor/arm) as a MeshStandardMaterial. UVs are world-space metres / uv scale (set by the geometry). */
export function pbr(id: string, o: THREE.MeshStandardMaterialParameters = {}, normal = true): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, ...o });
  m.map = tex(`assets/tex/${id}/diff.jpg`);
  if (normal) { m.normalMap = tex(`assets/tex/${id}/nor.jpg`, false); m.normalScale.set(0.9, 0.9); }
  m.roughnessMap = tex(`assets/tex/${id}/arm.jpg`, false);
  return m;
}

export function hdr(name: string): Promise<THREE.DataTexture | null> {
  return new HDRLoader().loadAsync(`${BASE}assets/hdri/${name}.hdr`).then((t) => { t.mapping = THREE.EquirectangularReflectionMapping; return t; }).catch(() => null);
}

const audioCache = new Map<string, Promise<AudioBuffer | null>>();
export function audioBuffer(ctx: BaseAudioContext, file: string): Promise<AudioBuffer | null> {
  if (!audioCache.has(file)) audioCache.set(file, fetch(`${BASE}audio/${file}`).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(r.status))).then((b) => ctx.decodeAudioData(b)).catch(() => null));
  return audioCache.get(file)!;
}

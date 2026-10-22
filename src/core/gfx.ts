// Renderer, sky, sun and post-processing, scaled by a quality preset. Low = no post-processing, small shadow map
// (integrated GPUs such as Intel HD 5500); High = N8AO ambient occlusion, bloom, 4k shadows.
import * as THREE from 'three';
import { BloomEffect, EffectComposer, EffectPass, RenderPass, ToneMappingEffect, ToneMappingMode, SMAAEffect, VignetteEffect } from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import { hdr, setAniso } from './assets';

export type Quality = 'low' | 'medium' | 'high';
export interface Gfx {
  renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; sun: THREE.DirectionalLight;
  quality: Quality;
  render: (dt: number) => void;
  /** Keep the shadow frustum centred on the camera. */
  follow: (p: THREE.Vector3) => void;
  resize: () => void;
  setExposure: (e: number) => void;
}

export const SUN_DIR = new THREE.Vector3(-0.45, 0.78, 0.43).normalize();

export async function createGfx(host: HTMLElement, quality: Quality): Promise<Gfx> {
  const renderer = new THREE.WebGLRenderer({ antialias: quality === 'low', powerPreference: 'high-performance', stencil: false, depth: true, preserveDrawingBuffer: false });
  renderer.setPixelRatio(quality === 'low' ? Math.min(1, devicePixelRatio) : Math.min(quality === 'high' ? 2 : 1.25, devicePixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  setAniso(quality === 'low' ? 2 : Math.min(8, renderer.capabilities.getMaxAnisotropy()));
  host.appendChild(renderer.domElement);
  renderer.domElement.className = 'gl';

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 1, 0.05, quality === 'low' ? 1100 : 2600);
  const fogCol = new THREE.Color(0xc9bfa9);
  scene.fog = new THREE.FogExp2(fogCol, quality === 'low' ? 0.0016 : 0.0011);
  scene.background = fogCol;

  const sky = await hdr('day');
  if (sky) {
    const pm = new THREE.PMREMGenerator(renderer);
    scene.environment = pm.fromEquirectangular(sky).texture;
    scene.background = sky; scene.backgroundIntensity = 0.85; scene.environmentIntensity = 0.55;
    scene.backgroundBlurriness = 0.0;
    pm.dispose();
  }
  const hemi = new THREE.HemisphereLight(0xd8e4f0, 0x8a7a5e, sky ? 0.35 : 1.0);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff1dc, 3.2);
  sun.position.copy(SUN_DIR).multiplyScalar(300);
  sun.castShadow = true;
  const sm = quality === 'low' ? 2048 : 4096, ext = quality === 'low' ? 70 : 110;
  sun.shadow.mapSize.set(sm, sm);
  Object.assign(sun.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 1, far: 800 });
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.04;
  scene.add(sun, sun.target);

  let composer: EffectComposer | null = null;
  if (quality !== 'low') {
    renderer.toneMapping = THREE.NoToneMapping;
    composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType });
    const n8 = new N8AOPostPass(scene, camera, 1, 1);
    n8.configuration.aoRadius = 2.5; n8.configuration.distanceFalloff = 1.0; n8.configuration.intensity = 2.2;
    n8.configuration.halfRes = quality === 'medium'; n8.configuration.gammaCorrection = false;
    n8.setQualityMode(quality === 'high' ? 'Medium' : 'Low');
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(n8);
    const effects = [new BloomEffect({ intensity: 0.6, luminanceThreshold: 0.92, mipmapBlur: true }), new VignetteEffect({ darkness: 0.35, offset: 0.35 }), new ToneMappingEffect({ mode: ToneMappingMode.AGX })];
    if (quality === 'high') effects.push(new SMAAEffect() as never);
    composer.addPass(new EffectPass(camera, ...effects));
  } else {
    renderer.toneMapping = THREE.AgXToneMapping;
  }
  renderer.toneMappingExposure = 1.0;

  const resize = () => {
    const w = host.clientWidth, h = host.clientHeight;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    composer?.setSize(w, h);
  };
  resize();
  addEventListener('resize', resize);
  const snap = new THREE.Vector3();
  return {
    renderer, scene, camera, sun, quality, resize,
    render: (dt) => { if (composer) composer.render(dt); else renderer.render(scene, camera); },
    follow: (p) => {
      // Snap the shadow camera to texel-sized steps to avoid shimmering.
      const texel = (2 * ext) / sm;
      snap.set(Math.round(p.x / texel) * texel, Math.round(p.y / texel) * texel, Math.round(p.z / texel) * texel);
      sun.target.position.copy(snap); sun.position.copy(snap).addScaledVector(SUN_DIR, 400);
    },
    setExposure: (e) => { renderer.toneMappingExposure = e; },
  };
}

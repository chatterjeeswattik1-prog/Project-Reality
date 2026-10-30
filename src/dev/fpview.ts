// Dev-only viewer for first-person rigs: /fpview.html?src=models/fp/fp_m4.glb&clip=Reload&t=0.5&cam=FPS_Camera
// Plays `clip` frozen at time t (seconds from the clip start), places the camera on node `cam` (glTF: looks down -Z)
// or at pos/fwd params, logs node world transforms (window.__info) for measuring.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const q = new URLSearchParams(location.search);
const W = window as unknown as Record<string, unknown>;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight); document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x8a96a3);
scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 2.5); sun.position.set(2, 4, 3); scene.add(sun);
const camera = new THREE.PerspectiveCamera(Number(q.get('fov') ?? 70), innerWidth / innerHeight, 0.01, 100);
const gltf = await new GLTFLoader().loadAsync(q.get('src') ?? 'models/fp/fp_m4.glb');
const root = gltf.scene; scene.add(root);
const mixer = new THREE.AnimationMixer(root);
const info: Record<string, unknown> = { clips: gltf.animations.map((c) => {
  let t0 = Infinity, t1 = 0; for (const t of c.tracks) { t0 = Math.min(t0, t.times[0]); t1 = Math.max(t1, t.times[t.times.length - 1]); }
  return `${c.name} ${t0.toFixed(2)}..${t1.toFixed(2)}`;
}) };
const clip = gltf.animations.find((c) => c.name === q.get('clip')) ?? gltf.animations[0];
let t0 = Infinity; for (const t of clip.tracks) t0 = Math.min(t0, t.times[0]);
const act = mixer.clipAction(clip); act.play();
mixer.setTime(t0 + Number(q.get('t') ?? 0));
root.updateMatrixWorld(true);
const wp = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3()).toArray().map((v) => +v.toFixed(4));
const dir = (o: THREE.Object3D, v: THREE.Vector3) => v.applyQuaternion(o.getWorldQuaternion(new THREE.Quaternion())).toArray().map((x) => +x.toFixed(3));
for (const n of (q.get('nodes') ?? '').split(',').filter(Boolean)) {
  const o = root.getObjectByName(n); if (!o) { info[n] = 'missing'; continue; }
  info[n] = { pos: wp(o), x: dir(o, new THREE.Vector3(1, 0, 0)), y: dir(o, new THREE.Vector3(0, 1, 0)), z: dir(o, new THREE.Vector3(0, 0, 1)), scale: o.getWorldScale(new THREE.Vector3()).toArray().map((v) => +v.toFixed(4)) };
}
const box = new THREE.Box3().setFromObject(root); info.bounds = [box.min.toArray(), box.max.toArray()];
const camNode = q.get('cam') ? root.getObjectByName(q.get('cam')!) : null;
if (camNode) {
  camNode.getWorldPosition(camera.position); camera.quaternion.copy(camNode.getWorldQuaternion(new THREE.Quaternion()));
  if (q.get('rot')) camera.quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(...(q.get('rot')!.split(',').map(Number) as [number, number, number]))));
} else {
  const p = (q.get('pos') ?? '0,1.6,1').split(',').map(Number), f = (q.get('look') ?? '0,1.4,0').split(',').map(Number);
  camera.position.set(p[0], p[1], p[2]); camera.lookAt(f[0], f[1], f[2]);
}
info.camera = { pos: camera.position.toArray(), fwd: new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).toArray() };
renderer.render(scene, camera);
W.__info = info; W.__ready = true;

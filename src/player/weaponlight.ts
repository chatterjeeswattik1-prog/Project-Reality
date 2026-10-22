// Weapon-mounted light (T): the SureFire M900/M951 that US rifles and SAWs carried in Fallujah, 2004 (after "Six
// Days in Fallujah": room clearing in dark houses, where the light blinds and gives you away). A shadowed spot light,
// so it never shines through walls. Bots notice a light pointed at them (see Bot.perceive).
import * as THREE from 'three';
import type { Soldier } from '../game/soldier';
import type { Viewmodel } from './viewmodel';

/** Weapons that carry a light (US long guns; insurgent weapons had none). */
export const hasLight = (s: Soldier) => s.team === 'us' && !s.underSel && (s.weapon.kind === 'rifle' || s.weapon.kind === 'lmg' || s.weapon.kind === 'gpmg');

export class WeaponLight {
  spot: THREE.SpotLight;
  private dir = new THREE.Vector3(); private p = new THREE.Vector3();
  constructor(scene: THREE.Scene, quality: string) {
    // ~65 lm incandescent (M951, 2004): warm, a bright hot spot with a wide dim spill. Numbers tuned by eye against
    // the scene's sun (approximate).
    const sp = new THREE.SpotLight(0xffe7c4, 0, 38, 0.36, 0.75, 1.6);
    sp.castShadow = true;
    const n = quality === 'low' ? 256 : 512;
    sp.shadow.mapSize.set(n, n); sp.shadow.camera.near = 0.25; sp.shadow.camera.far = 38; sp.shadow.bias = -0.0015; sp.shadow.normalBias = 0.02;
    // Always in the scene (adding or removing a light recompiles every shader); off = zero intensity, no shadow pass.
    // Render the shadow map once now: a shadow-casting light whose map was never allocated breaks every lit
    // material (the whole world went missing, only the sky drew).
    sp.shadow.autoUpdate = false; sp.shadow.needsUpdate = true;
    scene.add(sp, sp.target);
    this.spot = sp;
  }

  update(s: Soldier, vm: Viewmodel, cam: THREE.Camera) {
    const on = s.light && s.alive && hasLight(s) && s.switchT <= 0;
    this.spot.intensity = on ? 26 : 0; this.spot.shadow.autoUpdate = on;
    if (!on) return;
    // From just behind the muzzle, along the barrel (the viewmodel's sway and recoil move the beam).
    vm.muzzleWorld(this.p);
    if (!vm.forward(this.dir)) cam.getWorldDirection(this.dir);
    this.spot.position.copy(this.p).addScaledVector(this.dir, 0.04);
    this.spot.target.position.copy(this.p).addScaledVector(this.dir, 10);
    this.spot.target.updateMatrixWorld();
  }
}

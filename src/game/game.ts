// The running game: world, physics, soldiers and their bodies, the shared weapon logic (player and bots alike),
// projectiles, damage, explosions, effects and sound.
import { groundH } from '../world/terrain';
import * as THREE from 'three';
import type { Gfx } from '../core/gfx';
import { gltf } from '../core/assets';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { City } from '../world/citygen';
import type { WorldView } from '../world/render';
import { G_WORLD, type Physics } from '../world/physics';
import { FX } from '../fx/fx';
import { Audio } from '../audio/audio';
import { Foley } from '../audio/foley';
import type { Surface } from '../world/sink';
import { Projectiles, type V3 } from './projectiles';
import { Soldier, glElevation, zeroAngle, type HitPart, type Slot } from './soldier';
import { Rig, RUN_SPEED, type CharAssets } from './rig';
import { retargetRun } from './runclip';
import { AMMO, WEAPONS, type Ammo, type WeaponDef } from './data/weapons';
import { type Faction, type Kit } from './data/kits';
import type { Player } from '../player/player';
import { PACKS } from '../player/fprig';
import type { Hud } from '../ui/hud';
import type { GameMode } from './mode';
import { mulberry } from '../core/rng';
import type { CoverIndex } from '../ai/cover';
import type { Doors } from './doors';
import { Destruction } from '../world/destruct';
import type { Vehicle } from '../vehicles/vehicle';
import { strike } from '../vehicles/armour';
import type { RayHit } from '../world/physics';

export interface GameEvents {
  onDown?: (victim: Soldier, by: Soldier | null, killed: boolean) => void;
  onExplosion?: (p: V3, ammo: Ammo, by: Soldier | null) => void;
  /** A round hit a soldier (sandbox hit readout). */
  onHit?: (victim: Soldier, part: HitPart, dmg: number, by: Soldier, p: V3) => void;
  /** A vehicle caught fire / was destroyed. */
  onVehicle?: (v: Vehicle, what: 'burning' | 'destroyed') => void;
}
/** The M203 leaf sight looks ~9° below the bore (about the 200–250 m setting), so the grenade leaves above the sight line. */
interface Charge { p: V3; owner: Soldier; ammo: Ammo; mesh: THREE.Object3D }

/** A weapon lying on the ground (a fallen soldier's, or one swapped away) that anyone can pick up, with its ammunition. */
export interface Pickup { id: number; slot: Slot; obj: THREE.Object3D }
/** A weapon slot as sent over the network (the weapon by id). */
export interface SlotMsg { w: string; mags: number[]; loaded: number; mode: string; gl?: number; glLoaded?: number }
export const slotMsg = (s: Slot): SlotMsg => ({ w: s.def.id, mags: [...s.mags], loaded: s.loaded, mode: s.mode, gl: s.gl, glLoaded: s.glLoaded });
export const slotOf = (m: SlotMsg): Slot | null => { const def = WEAPONS[m.w as keyof typeof WEAPONS]; return def ? { def, mags: [...m.mags], loaded: m.loaded, mode: m.mode as Slot['mode'], gl: m.gl, glLoaded: m.glLoaded } : null; };
const FIREARM = new Set(['rifle', 'lmg', 'gpmg', 'sniper', 'pistol', 'launcher']);

/** Ragdolls simulated at once, normally (a settled body costs nothing; see the freezing rule in update). */
const MAX_RAGDOLLS = 20;

const _pk = new THREE.Vector3();

export class Game {
  fx: FX; audio: Audio; proj: Projectiles;
  soldiers: Soldier[] = [];
  rigs = new Map<number, Rig>();
  player: Player | null = null;
  hud!: Hud;
  mode: GameMode | null = null;
  time = 0;
  events: GameEvents = {};
  charges: Charge[] = [];
  corpses: Rig[] = [];
  /** Tactical blackboard: what each team knows about enemies (shared between squadmates). */
  contacts: Record<Faction, Map<number, { p: V3; t: number }>> = { us: new Map(), ins: new Map() };
  /** Cover points claimed by bots (cover id → soldier id) so two bots do not pile into the same spot. */
  claims = new Map<number, number>();
  cover: CoverIndex | null = null;
  doors: Doors | null = null;
  /** Sandbox: free play on the whole map (any seat in any vehicle, either side). */
  sandbox = false;
  /** Breakable walls, slabs and shutters (world/destruct.ts). */
  destruct: Destruction | null = null;
  /** Armoured vehicles, and their colliders → vehicle (ray hits on a hull). */
  vehicles: Vehicle[] = [];
  /** Buildings each side has cleared room by room (house-to-house). */
  cleared: Record<Faction, Set<number>> = { us: new Set(), ins: new Set() };
  /** The US armour and its AI crews (vehicles/crews.ts). */
  crews: import('../vehicles/crews').VehicleCrews | null = null;
  /** Insurgent IEDs and ATGM teams (ai/threats.ts). */
  insAT: import('../ai/threats').InsurgentAT | null = null;
  vehicleOf = new Map<number, Vehicle>();
  /** Paved roads on a 4 m grid (vehicle top speed: road or cross-country). */
  private roadGrid: Uint8Array; private roadN = 0; private roadX0 = 0; private roadZ0 = 0;
  /** The player's fireteam brain when the mode has one (close-quarters test mode). */
  fireteam: import('../ai/team').Fireteam | null = null;
  smokes: { p: V3; t0: number }[] = [];
  private zeros = new Map<string, number>();
  rng = mulberry(4242);
  prof: Record<string, number> = {};
  /**
   * Multiplayer role: 'host' runs the match (damage, destruction, bots) and reports what happens through `netEmit`;
   * 'client' only shows effects — hits, blasts and wall cuts come from the host (net/client.ts).
   */
  netRole: 'solo' | 'host' | 'client' = 'solo';
  netEmit: ((ev: Record<string, unknown>) => void) | null = null;
  /**
   * Multiplayer client: what the player does with a vehicle (a puppet of the host's) goes to the host — getting in or
   * out, firing, choosing a round, lasing, smoke. Returns true when the action was sent there (net/client.ts).
   */
  netVehicle: ((op: 'enter' | 'exit' | 'fire' | 'ammo' | 'lase' | 'smoke', v: Vehicle, a: Record<string, number>, s?: Soldier) => boolean) | null = null;
  /** Weapons on the ground that can be picked up (F). */
  pickups: Pickup[] = [];
  private pickupN = 0;
  private dropped = new Set<number>();
  /** Footsteps, body falls, the player's breathing and heartbeat. */
  foley = new Foley(this);

  constructor(public gfx: Gfx, public P: Physics, public city: City, public world: WorldView, public assets: CharAssets, quality: string) {
    this.fx = new FX(gfx.scene);
    this.destruct = new Destruction(city, P, world, gfx.scene);
    this.destruct.g = { audio: { play: (n, p, o) => this.audio.play(n, p, o as never) } };
    this.fx.terrainAt = (x, z) => groundH(x, z);
    this.fx.floorAt = (p) => { const h = P.castRay([p[0], p[1], p[2]], [0, -1, 0], 80, G_WORLD); return h ? h.point[1] : null; };
    this.fx.sweep = (a, d, len) => { const h = P.castRay(a, d, len, G_WORLD); return h ? { dist: h.dist, normal: h.normal } : null; };
    this.fx.onCaseLand = (p) => { if (Math.random() < 0.6) this.audio.play('casing_drop', p, { range: 12, gain: 0.35, rate: 0.9 + Math.random() * 0.25 }); };
    this.audio = new Audio(quality !== 'low');
    this.audio.occluded = (a, b) => !P.clear(a, b, G_WORLD);
    // Under a roof with walls on at least two sides (an awning or a tree alone is not a room).
    this.audio.indoorAt = (p) => {
      const o = [p[0], p[1] + 0.3, p[2]];
      if (!P.castRay(o, [0, 1, 0], 14, G_WORLD)) return false;
      let walls = 0;
      for (const d of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]] as [number, number, number][]) if (P.castRay(o, d, 9, G_WORLD) && ++walls >= 2) return true;
      return false;
    };
    this.proj = new Projectiles(P, () => this.soldiers, {
      impact: (p, n, surf, a, d) => this.impactSound(p, n, surf, a, d),
      hit: (s, p, part, a, by) => this.hitSoldier(s, p, part, a, by),
      crack: (s, p, a, by) => this.crack(s, p, a, by),
      explode: (p, a, by, n) => this.explode(p, a, by, n),
      punch: (p, n, r) => this.punch(p, n, r),
      // A commander on a pintle gun is out of his hatch from the chest up: head and shoulders can be hit.
      exposed: (s) => {
        const v = s.vehicle; if (!v) return null;
        const mt = v.mountsOf(v.seatOf(s))[0], st = mt?.def.station; if (!st || st.remote) return null;
        const e = v.nodePos(st.eye);
        return [
          { a: [e[0], e[1] - 0.03, e[2]], b: [e[0], e[1] + 0.08, e[2]], r: 0.11, part: 'head' },
          { a: [e[0], e[1] - 0.48, e[2]], b: [e[0], e[1] - 0.24, e[2]], r: 0.2, part: 'chest' },
        ];
      },
      tracer: (a, b, ammo) => this.fx.tracer(a, b, ammo.id === '762x54' || ammo.id === '127x108' ? [0.4, 1.0, 0.35] : [1.0, 0.42, 0.18]),
      body: (id, kind, p, v) => this.fx.body(id, kind, p, v),
      smoke: (p) => { this.fx.smokeGrenade(p); this.smokes.push({ p, t0: this.time }); this.audio.play('grenade_pin', p, { range: 30 }); },
      armour: (wh, d, sp, a, by) => this.armourHit(wh, d, sp, a, by),
      ownVehicle: (h, by) => !!by.vehicle && this.vehicleOf.get(h) === by.vehicle,
    });
    // Road grid.
    const C = 4; this.roadX0 = -1100; this.roadZ0 = -1100; this.roadN = Math.ceil(2200 / C);
    this.roadGrid = new Uint8Array(this.roadN * this.roadN);
    for (const r of city.roads) {
      if (r.kind !== 'boulevard' && r.kind !== 'avenue' && r.kind !== 'street') continue;
      for (let x = r.x0; x <= r.x1; x += C) for (let z = r.z0; z <= r.z1; z += C) {
        const i = Math.floor((x - this.roadX0) / C), j = Math.floor((z - this.roadZ0) / C);
        if (i >= 0 && j >= 0 && i < this.roadN && j < this.roadN) this.roadGrid[j * this.roadN + i] = 1;
      }
    }
  }

  isRoad(x: number, z: number): boolean {
    const i = Math.floor((x - this.roadX0) / 4), j = Math.floor((z - this.roadZ0) / 4);
    return i >= 0 && j >= 0 && i < this.roadN && j < this.roadN && this.roadGrid[j * this.roadN + i] === 1;
  }

  // ---------------- vehicles ----------------
  /** A round hits a vehicle's hull: the armour decides; HEAT and HE burst on the plate. Feedback for the shooter. */
  private armourHit(wh: RayHit, d: V3, sp: number, a: Ammo, by: Soldier): boolean {
    const v = this.vehicleOf.get(wh.collider.handle); if (!v) return false;
    // (A multiplayer client only shows the strike: the host's armour model decides what it did.)
    const r = v.dead || this.netRole === 'client' ? null : strike(v, wh.point, d, a, sp, by);
    const big = (a.ap ?? 0) >= 100 || (a.ce ?? 0) >= 200;
    if (a.explosive) this.explode([wh.point[0] + wh.normal[0] * 0.15, wh.point[1] + wh.normal[1] * 0.15, wh.point[2] + wh.normal[2] * 0.15], a, by, wh.normal, v);
    else {
      this.fx.impact(wh.point, wh.normal, 'metal', big ? 3 : 1);
      this.audio.play(big ? 'explosion_near' : 'impact_metal', wh.point, { range: big ? 600 : 60, gain: big ? 0.8 : 0.7, rate: big ? 1.6 : 1 });
    }
    if (r?.pen && big) {
      // Behind-armour flash: a burst of sparks and smoke out of the hole.
      for (let i = 0; i < 18; i++) this.fx.glow.spawn(wh.point, [(Math.random() - 0.5) * 10, Math.random() * 8, (Math.random() - 0.5) * 10], 0.12, 0, 0.5 + Math.random() * 0.6, 1, [1, 0.75, 0.35], 0.3, 9.8);
    }
    if (r && by?.isPlayer && (a.ap ?? 0) + (a.ce ?? 0) >= 60) this.hud?.flash(r.pen ? (v.dead ? 'TARGET DESTROYED' : r.track ? 'PENETRATION — TRACK' : 'PENETRATION') : 'NO PENETRATION');
    return true;
  }

  // ---------------- soldiers ----------------
  /** `modelIdx`: which of the kit's character models (multiplayer clients match the host's choice). */
  spawn(kit: Kit, team: Faction, pos: V3, name: string, yaw = 0, modelIdx?: number): Soldier {
    const s = new Soldier(this.P, kit, team, pos, name);
    s.yaw = yaw;
    this.soldiers.push(s);
    const model = kit.model[(modelIdx ?? s.id) % kit.model.length];
    const rig = new Rig(this.assets, model, team === 'us' ? 0x8a8466 : 0x6a5a48);
    this.gfx.scene.add(rig.root);
    this.rigs.set(s.id, rig);
    rig.P = this.P;
    rig.setWeapon(s.weapon.model);
    return s;
  }
  /** Remove a soldier from play. Dead bodies stay as corpses (up to 40), with their weapon dropped beside them. */
  remove(s: Soldier) {
    if (s.vehicle) s.vehicle.exit(s, false);
    const wasDead = s.state === 'dead';
    if (!wasDead) s.die(null);
    const rig = this.rigs.get(s.id);
    this.rigs.delete(s.id);
    this.soldiers.splice(this.soldiers.indexOf(s), 1);
    if (!rig) return;
    if (!wasDead) { rig.dispose(); return; }
    rig.dropWeapon(s);
    this.corpses.push(rig);
    if (this.corpses.length > 40) this.corpses.shift()!.dispose();
  }

  // ---------------- weapons ----------------
  reload(s: Soldier): boolean {
    if (!s.startReload()) return false;
    // The player's reload sounds come from the first-person choreography (in time with the hands).
    if (!s.isPlayer || s.underSel) this.audio.play(s.weapon.belt ? 'belt_box_open_close' : 'mag_out', s.isPlayer ? null : s.eye, { range: 25, gain: 0.7 });
    return true;
  }

  private zero(def: WeaponDef) { let z = this.zeros.get(def.id); if (z === undefined) { z = zeroAngle(def); this.zeros.set(def.id, z); } return z; }

  /** Trigger input for any soldier. `held` = button down, `pressed` = went down this frame, `aim` = aiming down sights. */
  trigger(s: Soldier, held: boolean, pressed: boolean, aiming = s.aiming) {
    if (s.vehicle) return; // a crewman fires the vehicle's weapons (vehicles/control.ts)
    if (!s.alive) return;
    const slot = s.slot, def = s.underSel ? WEAPONS.m203 : slot.def;
    if (s.switchT > 0 || s.reloadT > 0 || s.bandageT > 0 || (s.support === 'bipod' && s.deployT < 1)) return;
    if (s.cool > 0) return;
    if (s.sprinting) { if (pressed) s.sprinting = false; return; }
    // Throwables.
    if (def.kind === 'grenade') {
      if (!pressed || slot.loaded <= 0) return;
      const d = s.aimDir(s.yaw, s.pitch + (aiming ? 0.05 : 0.18)), sp = aiming ? 9 : 17;
      const e = s.eye, o: V3 = [e[0] + d[0] * 0.4, e[1] + 0.1, e[2] + d[2] * 0.4];
      this.proj.throwItem(s, def.ammo === 'smoke' ? 'smoke' : 'frag', o, [d[0] * sp + s.vel[0], d[1] * sp + 2 + s.vel[1], d[2] * sp + s.vel[2]], def.fuse ?? 4);
      this.audio.play('grenade_throw', s.isPlayer ? null : e, { range: 25 });
      slot.loaded = slot.mags.length ? (slot.mags.pop(), 1) : 0;
      s.cool = 1.2; s.lastShotT = this.time;
      if (slot.loaded <= 0) s.select(0);
      return;
    }
    if (def.kind === 'charge') {
      if (!pressed) return;
      // Detonate placed charges if any; otherwise place one at the feet / on the wall ahead.
      const mine = this.charges.filter((c) => c.owner === s);
      if (mine.length && (slot.loaded <= 0 || held && aiming)) { this.detonate(s); s.cool = 0.5; return; }
      if (slot.loaded <= 0) { if (mine.length) this.detonate(s); return; }
      const e = s.eye, d = s.aimDir(), h = this.P.castRay(e, d, 2.2);
      const p: V3 = h ? [h.point[0] + h.normal[0] * 0.05, h.point[1] + h.normal[1] * 0.05, h.point[2] + h.normal[2] * 0.05] : [s.pos[0] + d[0] * 0.6, s.pos[1] + 0.05, s.pos[2] + d[2] * 0.6];
      this.placeCharge(s, p, def.ammo);
      slot.loaded = slot.mags.length ? (slot.mags.pop(), 1) : 0;
      this.audio.play('grenade_pin', s.isPlayer ? null : p, { range: 15 });
      s.cool = 1.0;
      if (s.isPlayer) this.hud?.flash(def.ammo === 'ied' ? 'IED placed — click again to detonate' : 'C4 placed — click again to detonate');
      return;
    }
    // Guns and launchers.
    if (slot.loaded <= 0 && !s.underSel) { if (pressed) this.audio.play('dry_fire', s.isPlayer ? null : s.eye, { range: 10 }); return; }
    if (s.underSel && !(slot.glLoaded ?? 0)) { if (pressed) this.audio.play('dry_fire', null, { range: 10 }); return; }
    if ((def.kind === 'launcher') && s.ads < 0.9) { if (pressed && s.isPlayer) this.hud?.flash('Aim to fire'); return; }
    const mode = s.underSel ? 'semi' : slot.mode;
    let fire = false;
    if (mode === 'auto') fire = held;
    else if (mode === 'semi') fire = pressed;
    else { if (pressed && s.burst <= 0) s.burst = 3; fire = s.burst > 0; }
    if (!held && mode === 'burst' && s.burst > 0 && s.burst < 3) fire = true;
    if (!fire) return;
    if (s.burst > 0) s.burst--;
    this.shoot(s, def);
  }

  private shoot(s: Soldier, def: WeaponDef) {
    const slot = s.slot, a = AMMO[def.ammo];
    if (s.underSel) slot.glLoaded = 0; else slot.loaded--;
    s.cool = 60 / def.rpm; s.lastShotT = this.time; s.shots++;
    // Direction: where the sights point (aim + sway + recoil) + the shot cone (uniform over the disc: mechanical
    // dispersion when aimed, the hip cone otherwise) + the sight's zero angle.
    const r = (s.dev / 1000) * Math.sqrt(Math.random()), th = Math.random() * Math.PI * 2;
    const yaw = s.yaw + s.wob[0] + s.rcY + r * Math.cos(th) / Math.max(0.2, Math.cos(s.pitch)), pitch = s.pitch + s.wob[1] + s.rcP + r * Math.sin(th) + (def.kind === 'gl' ? glElevation(s.glRange) : this.zero(def));
    const d = s.aimDir(yaw, pitch);
    const e = s.eye;
    let o: V3 = [e[0] + d[0] * 0.25, e[1] + d[1] * 0.25 - (s.ads > 0.5 ? 0 : 0.08), e[2] + d[2] * 0.25];
    // A muzzle pushed into or past a wall must not fire from the far side of it: start inside the body instead.
    const core = s.core;
    if (!this.P.clear(core, o)) o = [core[0] + d[0] * 0.05, core[1] + d[1] * 0.05, core[2] + d[2] * 0.05];
    const tracerEvery = def.tracer ?? a.tracer ?? 0, shotN = (slot.loaded % (tracerEvery || 1)) === 0;
    this.proj.fire(s, def, def.ammo, o, d, tracerEvery > 0 && shotN);
    // Recoil: the aim climbs (with a random side kick); a bipod soaks most of it, a rest some. The hip cone opens up.
    const sup = s.support === 'bipod' ? 0.3 : s.support === 'rest' ? 0.75 : s.stance === 'prone' ? 0.8 : 1;
    s.dev += def.dev.kick * (s.ads > 0.9 ? 0.25 : 1) * sup;
    const up = def.recoil[0] * sup * (0.85 + Math.random() * 0.3), side = (Math.random() - 0.45) * 2 * def.recoil[1] * sup;
    s.recoil(up, side);
    if (s.isPlayer && this.player) this.player.onShot(up, side);
    this.shotFx(s, def, o, d);
    if (def.kind === 'launcher' || def.kind === 'gl') {
      // Back-blast: a dust cloud behind and injury to anyone in the danger zone (and to the firer near a wall).
      if (def.backblast) {
        const bd: V3 = [-d[0], -d[1], -d[2]];
        for (let i = 0; i < 25; i++) this.fx.smoke.spawn([o[0] + bd[0], o[1], o[2] + bd[2]], [bd[0] * (6 + Math.random() * 8) + (Math.random() - 0.5) * 3, Math.random() * 2, bd[2] * (6 + Math.random() * 8) + (Math.random() - 0.5) * 3], 0.8, 2.2, 2.5, 0.6, [0.72, 0.66, 0.56], 2, -0.1);
        if (this.netRole !== 'client') {
          const wall = this.P.castRay(e, bd, 2.0);
          if (wall) s.damage(45, 'chest', [wall.point[0], wall.point[1], wall.point[2]], s, this.time, true);
          for (const t of this.soldiers) {
            if (t === s || !t.alive) continue;
            const dx = t.pos[0] - e[0], dz = t.pos[2] - e[2], along = dx * bd[0] + dz * bd[2], lat = Math.abs(dx * bd[2] - dz * bd[0]);
            if (along > 0 && along < def.backblast * 0.6 && lat < 2.5) t.damage(70 * (1 - along / def.backblast), 'chest', e, s, this.time, true);
          }
        }
      }
      if (def.disposable) { setTimeout(() => { const i = s.slots.indexOf(slot); if (i >= 0 && slot.loaded <= 0) { s.slots.splice(i, 1); s.cur = 0; s.switchT = 0.8; } }, 900); }
    }
    for (const t of this.soldiers) if (t !== s && t.alive && t.team !== s.team && !t.isPlayer) { const dx = t.pos[0] - e[0], dz = t.pos[2] - e[2]; if (dx * dx + dz * dz < 250 * 250) t.heard = { p: [e[0], e[1], e[2]], t: this.time }; }
  }

  /**
   * What a shot looks and sounds like where it is fired: muzzle flash, brass, the close thump and the report. Used for
   * the local soldiers' shots, and on a multiplayer client for the shots the host reports (net/client.ts).
   */
  shotFx(s: Soldier, def: WeaponDef, o: V3, d: V3) {
    const a = AMMO[def.ammo];
    const rig = this.rigs.get(s.id);
    const mz = s.isPlayer && this.player && !this.player.third ? this.player.vm.muzzleWorld(new THREE.Vector3()) : rig?.muzzle ?? new THREE.Vector3(...o);
    const big = a.pen >= 3 ? 2 : def.kind === 'launcher' ? 2.5 : def.kind === 'pistol' ? 0.6 : 1;
    this.fx.muzzle([mz.x, mz.y, mz.z], d, big, !!s.isPlayer);
    // Other soldiers' weapons throw their brass too (seen close by: the cases pile up round a firing position).
    const fp = s.isPlayer && this.player && !this.player.third;
    if (!fp && rig?.weapon && (def.kind === 'rifle' || def.kind === 'lmg' || def.kind === 'gpmg' || def.kind === 'pistol' || def.kind === 'sniper') && mz.distanceToSquared(this.gfx.camera.position) < 90 * 90) {
      const ej = rig.weapon.getObjectByName('eject');
      if (ej) {
        const ep = ej.getWorldPosition(new THREE.Vector3()), q = rig.weapon.getWorldQuaternion(new THREE.Quaternion());
        const v = new THREE.Vector3(1.7 + Math.random(), 1.1 + Math.random() * 0.8, 0.3 + Math.random() * 0.5).applyQuaternion(q);
        this.fx.casing([ep.x, ep.y, ep.z], [v.x + s.vel[0], v.y, v.z + s.vel[2]], !!def.belt);
      }
    }
    // Chest thump of a close shot (own weapon full, others by distance).
    const pk = a.pen >= 3 ? 2 : def.kind === 'launcher' ? 1.8 : a.pen >= 2 ? 1.4 : def.kind === 'pistol' ? 0.6 : 1;
    if (s.isPlayer) this.audio.punch(pk);
    else { const cp = this.gfx.camera.position, dd = Math.hypot(cp.x - mz.x, cp.y - mz.y, cp.z - mz.z); if (dd < 25) this.audio.punch(pk, (1 - dd / 25) * 0.6); }
    const snd = s.underSel ? 'm203_launch' : def.sound;
    this.audio.play(snd, s.isPlayer ? null : [mz.x, mz.y, mz.z], { range: a.pen >= 3 || def.kind === 'launcher' ? 2500 : 1600, far: def.farSound, nearDist: 90, gain: s.isPlayer ? 0.9 : 1, variant: 0 });
  }

  /**
   * A weapon on the ground: dropped by a body (`s`: whose) or left by someone picking up another (`p`, `ry`). The host
   * reports it with its id; a joiner adds the host's with that id.
   */
  addPickup(slot: Slot, obj: THREE.Object3D, where: { s?: number; p?: V3; ry?: number }, id?: number) {
    const k: Pickup = { id: id ?? ++this.pickupN, slot, obj };
    this.pickups.push(k);
    if (this.pickups.length > 60) { const x = this.pickups.shift()!; x.obj.parent?.remove(x.obj); }
    if (this.netRole === 'host') { const w = obj.getWorldPosition(new THREE.Vector3()); this.netEmit?.({ t: 'drop', id: k.id, s: where.s, p: where.p ?? [w.x, w.y, w.z], ry: where.ry ?? obj.rotation.y, slot: slotMsg(slot) }); }
    return k;
  }
  removePickup(id: number) {
    const k = this.pickups.find((x) => x.id === id); if (!k) return;
    k.obj.parent?.remove(k.obj); this.pickups.splice(this.pickups.indexOf(k), 1);
    if (this.netRole === 'host') this.netEmit?.({ t: 'take', id });
  }
  /** Multiplayer joiner: a weapon the host reports lying at p (left by someone picking up another). */
  dropAt(id: number, slot: Slot, p: V3, ry: number) {
    const src = this.assets.tpWeapons.get(slot.def.model) ?? this.assets.weapons.get(slot.def.model); if (!src) return;
    const o = src.clone(); o.position.set(p[0], p[1], p[2]); o.rotation.set(0, ry, Math.PI / 2, 'YXZ');
    o.traverse((m) => { if ((m as THREE.Mesh).isMesh) m.castShadow = true; });
    this.gfx.scene.add(o); this.addPickup(slot, o, {}, id);
  }

  /** A charge (C4, IED) placed by `s` at p (the host reports it to the players). */
  placeCharge(s: Soldier, p: V3, ammoId: string) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.07, 0.18), new THREE.MeshStandardMaterial({ color: ammoId === 'ied' ? 0x4a5030 : 0xb8b08a, roughness: 0.8 }));
    mesh.position.set(p[0], p[1], p[2]); this.gfx.scene.add(mesh);
    this.charges.push({ p, owner: s, ammo: AMMO[ammoId as keyof typeof AMMO], mesh });
    if (this.netRole === 'host') this.netEmit?.({ t: 'charge', s: s.id, p, a: ammoId });
  }
  detonate(owner: Soldier) {
    if (this.netRole === 'host' && this.charges.some((c) => c.owner === owner)) this.netEmit?.({ t: 'det', s: owner.id });
    for (let i = this.charges.length - 1; i >= 0; i--) {
      const c = this.charges[i]; if (c.owner !== owner) continue;
      this.gfx.scene.remove(c.mesh); this.charges.splice(i, 1);
      this.explode(c.p, c.ammo, owner);
    }
  }

  // ---------------- weapons on the ground ----------------
  /** The pickup a soldier is looking at within reach (≤ 2.2 m, within ~35° of the aim), if any. */
  pickupFor(s: Soldier): Pickup | null {
    const e = s.eye, d = s.aimDir(); let best: Pickup | null = null, bs = -1;
    for (const k of this.pickups) {
      if (!k.obj.visible) continue;
      const p = k.obj.getWorldPosition(_pk), dx = p.x - e[0], dy = p.y - e[1], dz = p.z - e[2], L = Math.hypot(dx, dy, dz);
      if (Math.hypot(p.x - s.pos[0], p.z - s.pos[2]) > 2.2 || L < 1e-3) continue;
      const c = (dx * d[0] + dy * d[1] + dz * d[2]) / L; if (c < 0.82) continue;
      if (c > bs) { bs = c; best = k; }
    }
    return best;
  }
  /** Swap the weapon in hand (or the first firearm) for the one on the ground; ours is left lying in its place. */
  /** `leave`: our weapon goes down in its place (a multiplayer joiner's comes from the host's report instead). */
  pickUp(s: Soldier, k: Pickup, leave = true) {
    const i = FIREARM.has(s.weapon.kind) ? s.cur : s.slots.findIndex((x) => FIREARM.has(x.def.kind));
    const at = k.obj.getWorldPosition(new THREE.Vector3());
    this.removePickup(k.id);
    if (i >= 0 && !leave) { s.slots[i] = { ...k.slot, mags: [...k.slot.mags] }; s.underSel = false; s.cur = i; s.switchT = 1.0; s.reloadT = 0; }
    else if (i >= 0) {
      const old = s.slots[i];
      // Ours goes down where the other one lay.
      const src = this.assets.tpWeapons.get(old.def.model) ?? this.assets.weapons.get(old.def.model);
      if (src) {
        const o = src.clone(); o.position.set(at.x, at.y, at.z); o.rotation.set(0, Math.random() * Math.PI * 2, Math.PI / 2, 'YXZ');
        const fl = this.P.castRay([at.x, at.y + 0.5, at.z], [0, -1, 0], 3, G_WORLD); if (fl) o.position.y = fl.point[1] + 0.035;
        o.traverse((m) => { if ((m as THREE.Mesh).isMesh) m.castShadow = true; });
        this.gfx.scene.add(o); this.addPickup(old, o, { p: [o.position.x, o.position.y, o.position.z], ry: o.rotation.y });
      }
      s.slots[i] = { ...k.slot, mags: [...k.slot.mags] };
      s.underSel = false; s.cur = i; s.switchT = 1.0; s.reloadT = 0;
    } else { s.slots.unshift({ ...k.slot, mags: [...k.slot.mags] }); s.cur = 0; s.switchT = 1.0; }
    this.audio.play('mag_in', s.isPlayer ? null : s.eye, { range: 15, gain: 0.6, rate: 0.8 });
  }

  // ---------------- damage ----------------
  hitSoldier(s: Soldier, p: V3, part: HitPart, a: Ammo, by: Soldier) {
    const wasAlive = s.state === 'alive';
    const from = by.eye;
    const client = this.netRole === 'client';
    if (!client) { s.damage(a.dmg, part, from, by, this.time); this.events.onHit?.(s, part, a.dmg, by, p); }
    const d: V3 = [p[0] - from[0], p[1] - from[1], p[2] - from[2]], L = Math.hypot(...d) || 1, dn: V3 = [d[0] / L, d[1] / L, d[2] / L];
    this.fx.blood(p, dn, a.pen >= 2 ? 1.6 : a.pen === 0 ? 0.8 : 1.2);
    // Splatter on whatever is behind the victim (exit spray), and drops on the ground below.
    const back = this.P.castRay([p[0] + dn[0] * 0.3, p[1] + dn[1] * 0.3, p[2] + dn[2] * 0.3], dn, 2.5);
    if (back) this.fx.bloodDecal(back.point, back.normal, 0.35 + Math.random() * 0.4 * (a.pen >= 2 ? 1.5 : 1));
    const below = this.P.castRay(p, [dn[0] * 0.3, -1, dn[2] * 0.3].map((v, i, arr) => v / Math.hypot(arr[0], arr[1], arr[2])) as V3, 3);
    if (below) this.fx.bloodDecal(below.point, below.normal, 0.25 + Math.random() * 0.2);
    // The hit shoves the body: a stagger away from the shot; whoever goes down collapses as a ragdoll pushed by the
    // round, and a body on the ground jerks when hit again.
    const rig = this.rigs.get(s.id), power = Math.min(1.6, a.dmg / 70) * (part === 'arm' || part === 'leg' ? 0.6 : 1);
    // Wounds on the body where the round went in, and where it came out for full-power rounds.
    const cp = this.gfx.camera.position;
    if (rig && Math.hypot(p[0] - cp.x, p[1] - cp.y, p[2] - cp.z) < 90) {
      rig.wound(p, dn, false);
      if (a.pen >= 2 || (a.pen >= 1 && Math.random() < 0.5)) rig.wound(p, dn, true);
    }
    if (s.state === 'alive') rig?.hit(part, dn, power);
    else {
      const k = (wasAlive ? 16 : 7) * power * (part === 'head' ? 1.2 : 1);
      rig?.shove(s, p, [dn[0] * k, dn[1] * k, dn[2] * k]);
    }
    this.audio.play('impact_flesh', s.isPlayer ? null : p, { range: 40, gain: 1.2 });
    // A hit knocks the victim's aim off (and the player's view jolts).
    s.rcP += (0.02 + Math.random() * 0.03) * power; s.rcY += (Math.random() - 0.5) * 0.07 * power;
    if (s.isPlayer) { this.player?.onShot(30 * power, (Math.random() - 0.5) * 20); this.player && (this.player.shake += 0.25 * power); this.hud?.hurt(from); }
    if (client) return;
    if (wasAlive && s.state !== 'alive') this.events.onDown?.(s, by, s.state === 'dead');
    else if (!wasAlive && s.state === 'dead') this.events.onDown?.(s, by, true);
  }

  /**
   * A round striking something: the dust and the smack (always heard close by, often at mid range), and on hard
   * surfaces at a glancing angle the whine of a ricochet going off somewhere.
   */
  private impactSound(p: V3, n: V3, surf: Surface, a: Ammo, d?: V3) {
    // Heavy kinetic rounds (tank and 25 mm sabot) punch holes through walls as they go.
    if ((a.ap ?? 0) >= 100 && this.netRole !== 'client' && (surf === 'masonry' || surf === 'concrete' || surf === 'metal' || surf === 'wood')) this.netBlast([p[0] - n[0] * 0.05, p[1] - n[1] * 0.05, p[2] - n[2] * 0.05], (a.ap ?? 0) >= 500 ? 0.35 : 0.14, 0.4, 0.4);
    this.fx.impact(p, n, surf, a.pen >= 3 ? 2 : 1);
    const L = this.audio.listener.p, dist = Math.hypot(p[0] - L[0], p[1] - L[1], p[2] - L[2]);
    if (dist < 18 || Math.random() < 0.55) this.audio.play(surf === 'metal' ? 'impact_metal' : surf === 'dirt' || surf === 'sandbag' ? 'impact_dirt' : 'impact_concrete', p, { range: 45, gain: dist < 18 ? 0.85 : 0.6 });
    const hard = surf === 'metal' || surf === 'concrete' || surf === 'masonry';
    const glance = d ? 1 - Math.abs(d[0] * n[0] + d[1] * n[1] + d[2] * n[2]) : 0.5;
    if (hard && dist < 70 && Math.random() < 0.08 + glance * 0.35) this.audio.play('ricochet', p, { range: 70, gain: 0.9, rate: 0.85 + Math.random() * 0.3 });
  }

  crack(s: Soldier, p: V3, a: Ammo, by: Soldier) {
    s.suppress = Math.min(1, s.suppress + (a.pen >= 2 ? 0.25 : 0.15));
    s.heard = { p: by.eye, t: this.time };
    if (s.isPlayer) {
      this.audio.play(a.v0 > 600 ? 'crack_supersonic' : 'whiz', p, { range: 15, delay: false, gain: 0.9 }); this.hud?.suppress(s.suppress);
      // A round snapping past makes you flinch: the view jolts (more for heavy rounds and when already pinned).
      if (this.player) this.player.shake += (a.pen >= 2 ? 0.012 : 0.008) * (0.6 + s.suppress);
    }
  }

  /**
   * A cannon penetrator (25 mm or 120 mm sabot) through a wall: a ragged hole of radius r where it went in (and out:
   * the cut goes through the wall's thickness), brick dust both sides, chips; no blast.
   */
  punch(p: V3, n: V3, r: number) {
    if (!this.destruct || r < 0.1 || this.netRole === 'client') return;
    // Centre the cut just inside the wall so the hole goes through it.
    const c: V3 = [p[0] - n[0] * 0.05, p[1] - n[1] * 0.05, p[2] - n[2] * 0.05];
    // (`blast` scales the breach by the material, concrete ×0.75: the punch radius is what concrete gets.)
    const br = this.netBlast(c, r / 0.75, 0, 0.35);
    for (const h of br.holes) { this.fx.dust(h.p, h.n, h.r * 0.6); this.fx.blastMark(h.p, h.n, h.r * 0.35); }
    this.fx.clearDecals(br.gone);
    if (br.holes.length) {
      this.cover?.invalidate(p[0], p[2], r * 2 + 1);
      this.audio.play('debris_fall', p, { range: 90, gain: Math.min(0.8, 0.3 + br.volume * 2) });
    }
  }

  /**
   * A wall-cutting blast (warheads, sabot and 25 mm punches): on the host it is reported to the clients with its outline
   * seed (and whether doors are torn out), so every machine cuts the identical hole.
   */
  netBlast(p: V3, breach: number, light: number, power: number, doors = false) {
    const br = this.destruct!.blast(p, breach, light, power);
    if (this.netRole === 'host' && (br.holes.length || br.fell || br.props)) this.netEmit?.({ t: 'blast', p, b: breach, l: light, w: power, s: this.destruct!.lastSeed, d: doors ? 1 : 0 });
    return br;
  }
  /** Client: the wall cut ordered by the host (same seed: same hole), with its dust and marks. */
  applyBlast(p: V3, breach: number, light: number, power: number, seed: number, doors: boolean) {
    if (!this.destruct) return;
    const br = this.destruct.blast(p, breach, light, power, seed);
    for (const h of br.holes) { this.fx.dust(h.p, h.n, h.r); this.fx.impact(h.p, h.n, h.surf, 2, false); this.fx.blastMark(h.p, h.n, h.r); }
    this.fx.clearDecals(br.gone);
    if (doors) for (const d of this.doors?.blast(p, light * 1.4) ?? []) this.destruct.debris(d.min, d.max, p, power, d.metal ? 'metal' : 'wood', 0.12);
    if (br.holes.length) {
      this.cover?.invalidate(p[0], p[2], breach * 2 + 2);
      this.audio.play('debris_fall', [p[0], p[1] + 0.5, p[2]], { range: 140, gain: Math.min(1.2, 0.5 + br.volume * 0.8 + br.fell * 0.05) });
    }
  }
  /** Client: an explosion seen and heard (sound, the local player's shock and ears, bodies thrown); no damage. */
  private explodeShown(p: V3, a: Ammo, power: number) {
    const ex = a.explosive!;
    this.audio.play(ex.dmg > 300 ? 'explosion_big' : 'explosion_near', p, { range: 3000, far: 'explosion_far', nearDist: 150, gain: 1 });
    const throwK = (q: V3) => { const dd = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]); return dd > ex.radius * 0.8 ? 0 : 4.5 * power * (1 - dd / (ex.radius * 0.8)); };
    for (const r of this.corpses) { const q: V3 = [r.root.position.x, r.root.position.y + 0.3, r.root.position.z], k = throwK(q); if (k > 0 && this.P.clear(p, q, G_WORLD)) r.blast(null, p, k); }
    const me = this.player?.s;
    if (me && !me.vehicle) {
      const c: V3 = [me.pos[0], me.pos[1] + 1, me.pos[2]], dist = Math.hypot(c[0] - p[0], c[1] - p[1], c[2] - p[2]);
      if (dist < ex.radius * 3) {
        const k = Math.max(0, 1 - dist / (ex.radius * 2.5));
        this.player!.shake += Math.max(0, 1.5 - dist / (ex.radius * 2)); this.hud?.blast(k);
        if (k > 0.25) this.audio.play('tinnitus', null, { gain: 1 + k * 4, verb: 0 });
      }
      if (dist < ex.radius * 2.5) me.suppress = Math.min(1, me.suppress + 0.5);
    }
  }

  /** `hitVeh`: the vehicle a HEAT round burst on (its armour already took the hit). */
  explode(p: V3, a: Ammo, by: Soldier | null, n?: V3, hitVeh?: Vehicle) {
    const ex = a.explosive!;
    const power = Math.min(3, Math.max(0.6, ex.dmg / 180));
    this.fx.explosion(p, power, n);
    if (this.netRole === 'client') { this.explodeShown(p, a, power); return; }
    // Blast against nearby armour: only heavy charges close by matter (an IED under the belly, C4 on the deck; a
    // grenade on a tank does nothing). The face is the side the blast comes from.
    for (const v of this.vehicles) {
      if (v === hitVeh || v.dead) continue;
      const vp = v.pos(), dist = Math.hypot(vp[0] - p[0], vp[1] + 1 - p[1], vp[2] - p[2]) - Math.max(v.def.hull[0], v.def.hull[2]) / 2.5;
      if (dist > 3 || ex.dmg < 150) continue;
      const pen = ex.dmg * 0.25 * Math.max(0, 1 - Math.max(0, dist) / 3);
      const dir: V3 = [vp[0] - p[0], vp[1] + 0.8 - p[1], vp[2] - p[2]], L = Math.hypot(...dir) || 1;
      // Hit point: the hull surface nearest the blast.
      const hp: V3 = [p[0] + dir[0] / L * Math.max(0, dist), p[1] + dir[1] / L * Math.max(0, dist), p[2] + dir[2] / L * Math.max(0, dist)];
      strike(v, hp, [dir[0] / L, dir[1] / L, dir[2] / L], null, 0, by, pen);
    }
    // Walls first: a breach lets the blast through to whoever is behind it.
    if (this.destruct) {
      const br = this.netBlast(p, ex.breach ?? 0, ex.light ?? 0, power, true);
      for (const h of br.holes) { this.fx.dust(h.p, h.n, h.r); this.fx.impact(h.p, h.n, h.surf, 2, false); this.fx.blastMark(h.p, h.n, h.r); }
      this.fx.clearDecals(br.gone);
      // Doors torn off by the blast, or left with no wall around them.
      for (const d of this.doors?.blast(p, (ex.light ?? 0) * 1.4) ?? []) this.destruct.debris(d.min, d.max, p, power, d.metal ? 'metal' : 'wood', 0.12);
      if (br.holes.length) {
        this.cover?.invalidate(p[0], p[2], (ex.breach ?? 0) * 2 + 2);
        this.audio.play('debris_fall', [p[0], p[1] + 0.5, p[2]], { range: 140, gain: Math.min(1.2, 0.5 + br.volume * 0.8 + br.fell * 0.05) });
      }
    }
    this.audio.play(ex.dmg > 300 ? 'explosion_big' : 'explosion_near', p, { range: 3000, far: 'explosion_far', nearDist: 150, gain: 1 });
    // Bodies on the ground are thrown by the blast.
    const throwK = (q: V3) => { const dd = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]); return dd > ex.radius * 0.8 ? 0 : 4.5 * power * (1 - dd / (ex.radius * 0.8)); };
    for (const r of this.corpses) { const q: V3 = [r.root.position.x, r.root.position.y + 0.3, r.root.position.z], k = throwK(q); if (k > 0 && this.P.clear(p, q, G_WORLD)) r.blast(null, p, k); }
    for (const s of this.soldiers) {
      if (s.vehicle) continue; // inside the armour: the vehicle's armour model handles the blast
      if (s.state === 'dead') { const q: V3 = [s.pos[0], s.pos[1] + 0.3, s.pos[2]], k = throwK(q); if (k > 0 && this.P.clear(p, q, G_WORLD)) this.rigs.get(s.id)?.blast(s, p, k); continue; }
      const c: V3 = [s.pos[0], s.pos[1] + (s.stance === 'prone' || s.state !== 'alive' ? 0.25 : 1.0), s.pos[2]];
      const dist = Math.hypot(c[0] - p[0], c[1] - p[1], c[2] - p[2]);
      if (s.isPlayer && dist < ex.radius * 3) {
        const k = Math.max(0, 1 - dist / (ex.radius * 2.5));
        this.player!.shake += Math.max(0, 1.5 - dist / (ex.radius * 2)); this.hud?.blast(k);
        // Ears ringing after a close blast (the world goes dull: hud.blast drives the muffle).
        if (k > 0.25) this.audio.play('tinnitus', null, { gain: 1 + k * 4, verb: 0 });
      }
      if (dist > ex.radius) { if (dist < ex.radius * 2.5) s.suppress = Math.min(1, s.suppress + 0.5); continue; }
      if (!this.P.clear(p, c, G_WORLD)) continue;
      const wasAlive = s.state === 'alive';
      const k = dist < ex.kill ? 1 : Math.pow(1 - (dist - ex.kill) / (ex.radius - ex.kill), 1.6);
      // Prone soldiers are much safer from fragments.
      const prone = s.stance === 'prone' && dist > ex.kill ? 0.45 : 1;
      s.damage(ex.dmg * k * prone, 'chest', p, by, this.time, true);
      if (s.state !== 'alive') { const tk = throwK(c); if (tk > 0) this.rigs.get(s.id)?.blast(s, p, tk); }
      if (wasAlive && s.state !== 'alive') this.events.onDown?.(s, by, (s.state as string) === 'dead');
    }
    this.insAT?.blast(p);
    this.events.onExplosion?.(p, a, by);
  }

  /**
   * Is a sight line blocked by smoke, or by more than ~30 m of eucalyptus wood (trunks and crowns: a wood hides what
   * is behind it, though a man at its edge still sees out)? For AI vision.
   */
  smokeBlocks(a: V3, b: V3): boolean { return this.foliageBlocks(a, b) || this.smokeOnly(a, b); }
  foliageBlocks(a: V3, b: V3): boolean {
    let inside = 0;
    for (const w of this.city.woods ?? []) {
      // Length of the segment inside the rectangle (slab clipping).
      let t0 = 0, t1 = 1;
      for (const [o, d, lo, hi] of [[a[0], b[0] - a[0], w.x0, w.x1], [a[2], b[2] - a[2], w.z0, w.z1]]) {
        if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) { t0 = 1; t1 = 0; } continue; }
        let u0 = (lo - o) / d, u1 = (hi - o) / d; if (u0 > u1) [u0, u1] = [u1, u0];
        t0 = Math.max(t0, u0); t1 = Math.min(t1, u1);
      }
      if (t1 > t0) inside += (t1 - t0) * Math.hypot(b[0] - a[0], b[2] - a[2]);
    }
    return inside > 30;
  }
  private smokeOnly(a: V3, b: V3): boolean {
    for (const s of this.smokes) {
      const age = this.time - s.t0; if (age < 3 || age > 55) continue;
      const r = Math.min(9, 2 + age * 0.6);
      const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L = Math.hypot(...d);
      const t = Math.max(0, Math.min(1, ((s.p[0] - a[0]) * d[0] + (s.p[1] - a[1]) * d[1] + (s.p[2] - a[2]) * d[2]) / (L * L)));
      if (Math.hypot(a[0] + d[0] * t - s.p[0], a[1] + d[1] * t - s.p[1] - 1.5, a[2] + d[2] * t - s.p[2]) < r) return true;
    }
    return false;
  }

  /** A soldier spotted an enemy: the whole team now knows roughly where it is. */
  report(team: Faction, enemy: Soldier) { this.contacts[team].set(enemy.id, { p: [...enemy.pos], t: this.time }); }
  /** Freshest known enemy position within `range` of p (seconds old ≤ maxAge). */
  knownEnemy(team: Faction, p: V3, range: number, maxAge: number): { p: V3; t: number } | null {
    let best: { p: V3; t: number } | null = null;
    for (const c of this.contacts[team].values()) if (this.time - c.t <= maxAge && Math.hypot(c.p[0] - p[0], c.p[2] - p[2]) <= range && (!best || c.t > best.t)) best = c;
    return best;
  }
  /** How many living bots of a team are on the move (for bounding overwatch). */
  movers(team: Faction) { return this.soldiers.filter((s) => s.team === team && s.alive && !s.isPlayer && s.moving > 0.8).length; }

  // ---------------- per frame ----------------
  update(dt: number) {
    this.time += dt;
    this.destruct?.update(dt);
    const cam = this.gfx.camera.position;
    for (const s of this.soldiers) {
      // Blood pool under the chest once the body has settled.
      if (s.state !== 'alive' && !s.pooled && (s.state === 'dead' ? s.deadT : s.downT) > 1.5) {
        s.pooled = true;
        const c = this.rigs.get(s.id)?.chest() ?? [s.pos[0], s.pos[1], s.pos[2]];
        this.fx.bloodPool([c[0], s.pos[1], c[2]], s.state === 'dead' ? 1.3 : 0.9);
      }
      if (s.state === 'alive') s.pooled = false;
      // A bleeding soldier drips blood as he goes (a trail to follow), more the worse he bleeds.
      if (s.alive && s.bleed > 0 && Math.random() < dt * (0.6 + s.bleed * 0.8) && Math.hypot(s.pos[0] - cam.x, s.pos[2] - cam.z) < 70) {
        const hgt = s.stance === 'prone' ? 0.25 : s.stance === 'crouch' ? 0.6 : 0.9;
        this.fx.drip([s.pos[0] + (Math.random() - 0.5) * 0.3, s.pos[1] + hgt, s.pos[2] + (Math.random() - 0.5) * 0.3]);
      }
      if (s.netRemote) continue; // posed by the host's snapshots (net/client.ts)
      const reloaded = s.tick(dt, this.time);
      if (reloaded && (!s.isPlayer || s.underSel)) this.audio.play(s.weapon.belt ? 'belt_box_open_close' : 'mag_in', s.isPlayer ? null : s.eye, { range: 25, gain: 0.7 });
    }
    this.crews?.update(dt);
    this.insAT?.update(dt);
    for (const v of this.vehicles) v.update(dt);
    let t0 = performance.now();
    this.proj.step(dt);
    this.prof.proj = performance.now() - t0; t0 = performance.now();
    this.P.world.timestep = dt;
    this.P.step();
    for (const v of this.vehicles) v.sync(dt);
    this.prof.phys = performance.now() - t0; t0 = performance.now();
    for (const s of this.soldiers) {
      const rig = this.rigs.get(s.id); if (!rig) continue;
      const dist = Math.hypot(s.pos[0] - cam.x, s.pos[2] - cam.z);
      const hide = s.isPlayer && this.player && !this.player.third;
      rig.root.visible = !hide && dist < 1200 && !s.vehicle && !s.netHidden; rig.visible = rig.root.visible;
      rig.setWeapon(s.underSel ? s.weapon.model : s.weapon.model);
      if (rig.root.visible || s.isPlayer || rig.ragged) rig.update(dt, s, dist, this.time);
      else if (rig.weapon) rig.weapon.visible = false;
    }
    // A soldier killed leaves his weapon (with what ammunition he had) to be picked up; pickups whose body has been
    // cleared away go with it.
    for (const s of this.soldiers) {
      if (s.state !== 'dead' || this.dropped.has(s.id)) continue;
      this.dropped.add(s.id);
      const rig = this.rigs.get(s.id), cur = FIREARM.has(s.weapon.kind) ? s.slot : s.slots.find((x) => FIREARM.has(x.def.kind));
      if (this.netRole === 'client') continue; // the host reports what each body leaves (net/client.ts)
      if (rig?.weapon && cur && (cur.loaded > 0 || cur.mags.length)) this.addPickup({ ...cur, mags: [...cur.mags] }, rig.weapon, { s: s.id });
    }
    // (A multiplayer joiner keeps the host's pick-ups until the host says they are gone: bodies are cleared away at
    // different times on each machine.)
    if (this.netRole === 'client') { for (const k of this.pickups) if (!k.obj.parent) this.gfx.scene.add(k.obj); }
    else if (this.pickups.length) this.pickups = this.pickups.filter((k) => k.obj.parent);
    // Corpses still falling; at most MAX_RAGDOLLS simulate at once (the oldest settle where they are).
    for (const r of this.corpses) if (r.ragActive) r.updateRag(dt);
    const active = [...this.rigs.values(), ...this.corpses].filter((r) => r.ragActive);
    // Over the limit, the oldest bodies that have had time to land (3 s) are frozen where they lie; one still falling is
    // never frozen (it would be left kneeling or hanging in the air), so a burst of deaths may briefly exceed the limit.
    if (active.length > MAX_RAGDOLLS) active.filter((r) => r.rag!.t > 3).sort((x, y) => y.rag!.t - x.rag!.t).slice(0, active.length - MAX_RAGDOLLS).forEach((r) => { r.rag!.finish(); r.rag = null; });
    this.prof.rigs = performance.now() - t0; t0 = performance.now();
    this.doors?.update(dt);
    this.fx.cam.set(cam.x, cam.y, cam.z);
    this.fx.update(dt);
    this.foley.update(dt);
    this.prof.fx = performance.now() - t0;
    if (this.player?.s.vehicle) this.player.vc.place(this.player.s);
    if (this.player) this.audio.setListener([cam.x, cam.y, cam.z], this.player.forward());
  }
}

/** A static copy of a model with one mesh per material (third-person weapons: few draw calls); empties are kept. */
export function mergeByMaterial(root: THREE.Object3D): THREE.Object3D {
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert(), byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const out = new THREE.Group(); out.name = root.name;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && !Array.isArray(m.material)) {
      const geo = m.geometry.clone().applyMatrix4(inv.clone().multiply(m.matrixWorld));
      for (const k of Object.keys(geo.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') geo.deleteAttribute(k);
      if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
      (byMat.get(m.material) ?? byMat.set(m.material, []).get(m.material)!).push(geo.index ? geo.toNonIndexed() : geo);
    } else if (o !== root && !(o as THREE.Mesh).isMesh && o.children.length === 0) {
      const e = new THREE.Object3D(); e.name = o.name; e.applyMatrix4(inv.clone().multiply(o.matrixWorld)); out.add(e);
    }
  });
  for (const [mat, geos] of byMat) { const merged = mergeGeometries(geos, false); if (merged) out.add(new THREE.Mesh(merged, mat)); }
  return out;
}

/** Load character models, the animation library and all weapon models. */
export async function loadCharAssets(): Promise<CharAssets> {
  const models = new Map<string, THREE.Object3D>(), clips = new Map<string, THREE.AnimationClip>(), weapons = new Map<string, THREE.Object3D>();
  const ids = ['us_rifleman', 'us_rifleman_b', 'insurgent_a', 'insurgent_b', 'insurgent_c', 'civilian_a'];
  const anims = await gltf('models/chars/anims.glb');
  if (anims) for (const c of anims.animations) clips.set(c.name, c);
  await Promise.all(ids.map(async (id) => { const g = await gltf(`models/chars/${id}.glb`); if (g && clips.size) models.set(id, g.scene); }));
  // Motion-captured run, retargeted onto the shared skeleton (game/runclip.ts).
  const run = await gltf('models/chars/mocap/run.glb'), ref = models.get('us_rifleman');
  if (run && ref) { const r = retargetRun(run, ref); if (r) { clips.set(r.clip.name, r.clip); RUN_SPEED.mocap = r.speed; } }
  const wids = [...new Set(Object.values(WEAPONS).map((w) => w.model))];
  const tpWeapons = new Map<string, THREE.Object3D>();
  await Promise.all(wids.map(async (id) => {
    // Light copy for bots and third person (<id>_lod.glb); the full-detail <id>.glb is loaded only for the player's
    // own weapons (Viewmodel.preload). Weapons without a LOD file use the full one.
    const g = (await gltf(`models/weapons/${id}_lod.glb`)) ?? (await gltf(`models/weapons/${id}.glb`)); if (!g) return;
    const root = g.scene.getObjectByName(id) ?? g.scene;
    weapons.set(id, root); tpWeapons.set(id, mergeByMaterial(root));
  }));
  const fpRigs: CharAssets['fpRigs'] = new Map();
  await Promise.all(Object.entries(PACKS).map(async ([id, d]) => { const g = await gltf(d.url); if (g) fpRigs.set(id, { scene: g.scene, animations: g.animations }); }));
  return { models, clips, weapons, tpWeapons, fpRigs };
}

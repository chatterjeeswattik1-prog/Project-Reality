// The running game: world, physics, soldiers and their bodies, the shared weapon logic (player and bots alike),
// projectiles, damage, explosions, effects and sound.
import * as THREE from 'three';
import type { Gfx } from '../core/gfx';
import { gltf } from '../core/assets';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { City } from '../world/citygen';
import type { WorldView } from '../world/render';
import { G_WORLD, type Physics } from '../world/physics';
import { FX } from '../fx/fx';
import { Audio } from '../audio/audio';
import { Projectiles, type V3 } from './projectiles';
import { Soldier, zeroAngle, type HitPart } from './soldier';
import { Rig, type CharAssets } from './rig';
import { AMMO, WEAPONS, type Ammo, type WeaponDef } from './data/weapons';
import { type Faction, type Kit } from './data/kits';
import type { Player } from '../player/player';
import type { Hud } from '../ui/hud';
import type { GameMode } from './mode';
import { mulberry } from '../core/rng';
import type { CoverIndex } from '../ai/cover';
import type { Doors } from './doors';

export interface GameEvents {
  onDown?: (victim: Soldier, by: Soldier | null, killed: boolean) => void;
  onExplosion?: (p: V3, ammo: Ammo, by: Soldier | null) => void;
}
/** The M203 leaf sight looks ~9° below the bore (about the 200–250 m setting), so the grenade leaves above the sight line. */
const M203_SIGHT_TILT = (9 * Math.PI) / 180;
interface Charge { p: V3; owner: Soldier; ammo: Ammo; mesh: THREE.Object3D }

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
  /** The player's fireteam brain when the mode has one (close-quarters test mode). */
  fireteam: import('../ai/team').Fireteam | null = null;
  smokes: { p: V3; t0: number }[] = [];
  private zeros = new Map<string, number>();
  rng = mulberry(4242);
  prof: Record<string, number> = {};

  constructor(public gfx: Gfx, public P: Physics, public city: City, public world: WorldView, public assets: CharAssets, quality: string) {
    this.fx = new FX(gfx.scene);
    this.fx.floorAt = (p) => { const h = P.castRay([p[0], p[1], p[2]], [0, -1, 0], 3, G_WORLD); return h ? h.point[1] : null; };
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
      impact: (p, n, surf, a) => { this.fx.impact(p, n, surf, a.pen >= 3 ? 2 : 1); if (Math.random() < 0.5) this.audio.play(surf === 'metal' ? 'impact_metal' : surf === 'dirt' || surf === 'sandbag' ? 'impact_dirt' : 'impact_concrete', p, { range: 40, gain: 0.6 }); },
      hit: (s, p, part, a, by) => this.hitSoldier(s, p, part, a, by),
      crack: (s, p, a, by) => this.crack(s, p, a, by),
      explode: (p, a, by, n) => this.explode(p, a, by, n),
      tracer: (a, b, ammo) => this.fx.tracer(a, b, ammo.id === '762x54' || ammo.id === '127x108' ? [0.4, 1.0, 0.35] : [1.0, 0.42, 0.18]),
      body: (id, kind, p, v) => this.fx.body(id, kind, p, v),
      smoke: (p) => { this.fx.smokeGrenade(p); this.smokes.push({ p, t0: this.time }); this.audio.play('grenade_pin', p, { range: 30 }); },
    });
  }

  // ---------------- soldiers ----------------
  spawn(kit: Kit, team: Faction, pos: V3, name: string, yaw = 0): Soldier {
    const s = new Soldier(this.P, kit, team, pos, name);
    s.yaw = yaw;
    this.soldiers.push(s);
    const model = kit.model[s.id % kit.model.length];
    const rig = new Rig(this.assets, model, team === 'us' ? 0x8a8466 : 0x6a5a48);
    this.gfx.scene.add(rig.root);
    this.rigs.set(s.id, rig);
    rig.setWeapon(s.weapon.model);
    return s;
  }
  /** Remove a soldier from play. Dead bodies stay as corpses (up to 40), with their weapon dropped beside them. */
  remove(s: Soldier) {
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
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.07, 0.18), new THREE.MeshStandardMaterial({ color: def.ammo === 'ied' ? 0x4a5030 : 0xb8b08a, roughness: 0.8 }));
      mesh.position.set(p[0], p[1], p[2]); this.gfx.scene.add(mesh);
      this.charges.push({ p, owner: s, ammo: AMMO[def.ammo], mesh });
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
    const yaw = s.yaw + s.wob[0] + s.rcY + r * Math.cos(th) / Math.max(0.2, Math.cos(s.pitch)), pitch = s.pitch + s.wob[1] + s.rcP + r * Math.sin(th) + this.zero(def) + (def.kind === 'gl' ? M203_SIGHT_TILT : 0);
    const d = s.aimDir(yaw, pitch);
    const e = s.eye, o: V3 = [e[0] + d[0] * 0.25, e[1] + d[1] * 0.25 - (s.ads > 0.5 ? 0 : 0.08), e[2] + d[2] * 0.25];
    const tracerEvery = def.tracer ?? a.tracer ?? 0, shotN = (slot.loaded % (tracerEvery || 1)) === 0;
    this.proj.fire(s, def, def.ammo, o, d, tracerEvery > 0 && shotN);
    // Recoil: the aim climbs (with a random side kick); a bipod soaks most of it, a rest some. The hip cone opens up.
    const sup = s.support === 'bipod' ? 0.3 : s.support === 'rest' ? 0.75 : s.stance === 'prone' ? 0.8 : 1;
    s.dev += def.dev.kick * (s.ads > 0.9 ? 0.25 : 1) * sup;
    const up = def.recoil[0] * sup * (0.85 + Math.random() * 0.3), side = (Math.random() - 0.45) * 2 * def.recoil[1] * sup;
    s.recoil(up, side);
    if (s.isPlayer && this.player) this.player.onShot(up, side);
    // Muzzle flash and sound.
    const rig = this.rigs.get(s.id);
    const mz = s.isPlayer && this.player && !this.player.third ? this.player.vm.muzzleWorld(new THREE.Vector3()) : rig?.muzzle ?? new THREE.Vector3(...o);
    const big = a.pen >= 3 ? 2 : def.kind === 'launcher' ? 2.5 : def.kind === 'pistol' ? 0.6 : 1;
    this.fx.muzzle([mz.x, mz.y, mz.z], d, big, !!s.isPlayer);
    // Chest thump of a close shot (own weapon full, others by distance).
    const pk = a.pen >= 3 ? 2 : def.kind === 'launcher' ? 1.8 : a.pen >= 2 ? 1.4 : def.kind === 'pistol' ? 0.6 : 1;
    if (s.isPlayer) this.audio.punch(pk);
    else { const cp = this.gfx.camera.position, dd = Math.hypot(cp.x - mz.x, cp.y - mz.y, cp.z - mz.z); if (dd < 25) this.audio.punch(pk, (1 - dd / 25) * 0.6); }
    const snd = s.underSel ? 'm203_launch' : def.sound;
    this.audio.play(snd, s.isPlayer ? null : [mz.x, mz.y, mz.z], { range: a.pen >= 3 || def.kind === 'launcher' ? 2500 : 1600, far: def.farSound, nearDist: 90, gain: s.isPlayer ? 0.9 : 1, variant: 0 });
    if (def.kind === 'launcher' || def.kind === 'gl') {
      // Back-blast: a dust cloud behind and injury to anyone in the danger zone (and to the firer near a wall).
      if (def.backblast) {
        const bd: V3 = [-d[0], -d[1], -d[2]];
        for (let i = 0; i < 25; i++) this.fx.smoke.spawn([o[0] + bd[0], o[1], o[2] + bd[2]], [bd[0] * (6 + Math.random() * 8) + (Math.random() - 0.5) * 3, Math.random() * 2, bd[2] * (6 + Math.random() * 8) + (Math.random() - 0.5) * 3], 0.8, 2.2, 2.5, 0.6, [0.72, 0.66, 0.56], 2, -0.1);
        const wall = this.P.castRay(e, bd, 2.0);
        if (wall) s.damage(45, 'chest', [wall.point[0], wall.point[1], wall.point[2]], s, this.time, true);
        for (const t of this.soldiers) {
          if (t === s || !t.alive) continue;
          const dx = t.pos[0] - e[0], dz = t.pos[2] - e[2], along = dx * bd[0] + dz * bd[2], lat = Math.abs(dx * bd[2] - dz * bd[0]);
          if (along > 0 && along < def.backblast * 0.6 && lat < 2.5) t.damage(70 * (1 - along / def.backblast), 'chest', e, s, this.time, true);
        }
      }
      if (def.disposable) { setTimeout(() => { const i = s.slots.indexOf(slot); if (i >= 0 && slot.loaded <= 0) { s.slots.splice(i, 1); s.cur = 0; s.switchT = 0.8; } }, 900); }
    }
    for (const t of this.soldiers) if (t !== s && t.alive && t.team !== s.team && !t.isPlayer) { const dx = t.pos[0] - e[0], dz = t.pos[2] - e[2]; if (dx * dx + dz * dz < 250 * 250) t.heard = { p: [e[0], e[1], e[2]], t: this.time }; }
  }

  detonate(owner: Soldier) {
    for (let i = this.charges.length - 1; i >= 0; i--) {
      const c = this.charges[i]; if (c.owner !== owner) continue;
      this.gfx.scene.remove(c.mesh); this.charges.splice(i, 1);
      this.explode(c.p, c.ammo, owner);
    }
  }

  // ---------------- damage ----------------
  hitSoldier(s: Soldier, p: V3, part: HitPart, a: Ammo, by: Soldier) {
    const wasAlive = s.state === 'alive';
    const from = by.eye;
    s.damage(a.dmg, part, from, by, this.time);
    const d: V3 = [p[0] - from[0], p[1] - from[1], p[2] - from[2]], L = Math.hypot(...d) || 1, dn: V3 = [d[0] / L, d[1] / L, d[2] / L];
    this.fx.blood(p, dn, a.pen >= 2 ? 1.6 : a.pen === 0 ? 0.8 : 1.2);
    // Splatter on whatever is behind the victim (exit spray), and drops on the ground below.
    const back = this.P.castRay([p[0] + dn[0] * 0.3, p[1] + dn[1] * 0.3, p[2] + dn[2] * 0.3], dn, 2.5);
    if (back) this.fx.bloodDecal(back.point, back.normal, 0.35 + Math.random() * 0.4 * (a.pen >= 2 ? 1.5 : 1));
    const below = this.P.castRay(p, [dn[0] * 0.3, -1, dn[2] * 0.3].map((v, i, arr) => v / Math.hypot(arr[0], arr[1], arr[2])) as V3, 3);
    if (below) this.fx.bloodDecal(below.point, below.normal, 0.25 + Math.random() * 0.2);
    // The hit shoves the body: a stagger away from the shot, and whoever goes down falls away from the shooter.
    const rig = this.rigs.get(s.id), power = Math.min(1.6, a.dmg / 70) * (part === 'arm' || part === 'leg' ? 0.6 : 1);
    if (s.state === 'alive') rig?.hit(part, dn, power);
    else if (wasAlive) { s.yaw = Math.atan2(dn[0], dn[2]) + (Math.random() - 0.5) * 0.6; rig?.fall(power); }
    this.audio.play('impact_flesh', s.isPlayer ? null : p, { range: 40, gain: 1.2 });
    // A hit knocks the victim's aim off (and the player's view jolts).
    s.rcP += (0.02 + Math.random() * 0.03) * power; s.rcY += (Math.random() - 0.5) * 0.07 * power;
    if (s.isPlayer) { this.player?.onShot(30 * power, (Math.random() - 0.5) * 20); this.player && (this.player.shake += 0.25 * power); this.hud?.hurt(from); }
    if (wasAlive && s.state !== 'alive') this.events.onDown?.(s, by, s.state === 'dead');
    else if (!wasAlive && s.state === 'dead') this.events.onDown?.(s, by, true);
  }

  crack(s: Soldier, p: V3, a: Ammo, by: Soldier) {
    s.suppress = Math.min(1, s.suppress + (a.pen >= 2 ? 0.25 : 0.15));
    s.heard = { p: by.eye, t: this.time };
    if (s.isPlayer) { this.audio.play(a.v0 > 600 ? 'crack_supersonic' : 'whiz', p, { range: 15, delay: false, gain: 0.9 }); this.hud?.suppress(s.suppress); }
  }

  explode(p: V3, a: Ammo, by: Soldier | null, n?: V3) {
    const ex = a.explosive!;
    const power = Math.min(3, Math.max(0.6, ex.dmg / 180));
    this.fx.explosion(p, power, n);
    this.audio.play(ex.dmg > 300 ? 'explosion_big' : 'explosion_near', p, { range: 3000, far: 'explosion_far', nearDist: 150, gain: 1 });
    for (const s of this.soldiers) {
      if (s.state === 'dead') continue;
      const c: V3 = [s.pos[0], s.pos[1] + (s.stance === 'prone' || s.state !== 'alive' ? 0.25 : 1.0), s.pos[2]];
      const dist = Math.hypot(c[0] - p[0], c[1] - p[1], c[2] - p[2]);
      if (s.isPlayer && dist < ex.radius * 3) { this.player!.shake += Math.max(0, 1.5 - dist / (ex.radius * 2)); this.hud?.blast(Math.max(0, 1 - dist / (ex.radius * 2.5))); }
      if (dist > ex.radius) { if (dist < ex.radius * 2.5) s.suppress = Math.min(1, s.suppress + 0.5); continue; }
      if (!this.P.clear(p, c, G_WORLD)) continue;
      const wasAlive = s.state === 'alive';
      const k = dist < ex.kill ? 1 : Math.pow(1 - (dist - ex.kill) / (ex.radius - ex.kill), 1.6);
      // Prone soldiers are much safer from fragments.
      const prone = s.stance === 'prone' && dist > ex.kill ? 0.45 : 1;
      s.damage(ex.dmg * k * prone, 'chest', p, by, this.time, true);
      if (wasAlive && s.state !== 'alive') this.events.onDown?.(s, by, (s.state as string) === 'dead');
    }
    this.events.onExplosion?.(p, a, by);
  }

  /** Is a straight line blocked by smoke screens (for AI vision)? */
  smokeBlocks(a: V3, b: V3): boolean {
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
    const cam = this.gfx.camera.position;
    for (const s of this.soldiers) {
      // Blood pool under the chest once the body has settled.
      if (s.state !== 'alive' && !s.pooled && (s.state === 'dead' ? s.deadT : s.downT) > 1.5) {
        s.pooled = true;
        const c = this.rigs.get(s.id)?.chest() ?? [s.pos[0], s.pos[1], s.pos[2]];
        this.fx.bloodPool([c[0], s.pos[1], c[2]], s.state === 'dead' ? 1.3 : 0.9);
      }
      if (s.state === 'alive') s.pooled = false;
      const reloaded = s.tick(dt, this.time);
      if (reloaded && (!s.isPlayer || s.underSel)) this.audio.play(s.weapon.belt ? 'belt_box_open_close' : 'mag_in', s.isPlayer ? null : s.eye, { range: 25, gain: 0.7 });
    }
    let t0 = performance.now();
    this.proj.step(dt);
    this.prof.proj = performance.now() - t0; t0 = performance.now();
    this.P.world.timestep = dt;
    this.P.step();
    this.prof.phys = performance.now() - t0; t0 = performance.now();
    for (const s of this.soldiers) {
      const rig = this.rigs.get(s.id); if (!rig) continue;
      const dist = Math.hypot(s.pos[0] - cam.x, s.pos[2] - cam.z);
      const hide = s.isPlayer && this.player && !this.player.third;
      rig.root.visible = !hide && dist < 700; rig.visible = rig.root.visible;
      rig.setWeapon(s.underSel ? s.weapon.model : s.weapon.model);
      if (rig.root.visible || s.isPlayer) rig.update(dt, s, dist, this.time);
      else if (rig.weapon) rig.weapon.visible = false;
    }
    this.prof.rigs = performance.now() - t0; t0 = performance.now();
    this.doors?.update(dt);
    this.fx.update(dt);
    this.prof.fx = performance.now() - t0;
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
  const wids = [...new Set(Object.values(WEAPONS).map((w) => w.model))];
  const tpWeapons = new Map<string, THREE.Object3D>();
  await Promise.all(wids.map(async (id) => {
    const g = await gltf(`models/weapons/${id}.glb`); if (!g) return;
    const root = g.scene.getObjectByName(id) ?? g.scene;
    weapons.set(id, root); tpWeapons.set(id, mergeByMaterial(root));
  }));
  return { models, clips, weapons, tpWeapons };
}

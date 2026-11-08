// Bullets, rockets, 40 mm grenades and thrown grenades. Bullets are integrated every physics step with drag and
// gravity; each step is a segment tested against the static world (Rapier ray cast) and the soldiers' hit capsules.
import { AMMO, type Ammo, type WeaponDef } from './data/weapons';
import type { Capsule, HitPart, Soldier } from './soldier';
import { G_VEH, G_WORLD, type Physics, type RayHit } from '../world/physics';
import type { Surface } from '../world/sink';

export type V3 = [number, number, number];
export interface ProjectileHooks {
  impact: (p: V3, n: V3, surf: Surface, ammo: Ammo, dir?: V3) => void;
  hit: (s: Soldier, p: V3, part: HitPart, ammo: Ammo, by: Soldier) => void;
  crack: (s: Soldier, p: V3, ammo: Ammo, by: Soldier) => void;
  explode: (p: V3, ammo: Ammo, by: Soldier | null, n?: V3) => void;
  tracer: (a: V3, b: V3, ammo: Ammo) => void;
  /** Rocket/grenade visuals (create/update/remove by id). */
  body: (id: number, kind: 'rocket' | 'gl' | 'grenade' | 'smoke' | 'c4', p: V3 | null, v?: V3) => void;
  /** Smoke grenade started emitting. */
  smoke: (p: V3) => void;
  /** A round hit a vehicle (its armour decides): returns true when the hook handled it (the round stops there). */
  armour?: (wh: RayHit, d: V3, speed: number, ammo: Ammo, by: Soldier) => boolean;
  /** Capsules of a mounted soldier that stick out of the vehicle (a commander head-out), or null. */
  exposed?: (s: Soldier) => Capsule[] | null;
  /** A kinetic round holes a wall (radius m). */
  punch?: (p: V3, n: V3, r: number) => void;
  /** Is this collider part of the vehicle the shooter is riding in? */
  ownVehicle?: (handle: number, by: Soldier) => boolean;
}

export interface Bullet { cracked?: Set<number>; id: number; p: V3; v: V3; ammo: Ammo; owner: Soldier; t: number; dist: number; tracer: boolean; pens: number; armed: number; boostT: number; guide?: (p: V3) => V3 | null }
/** Drawn as a body in flight: rockets/missiles, 40 mm grenades, tank shells. */
const bodyKind = (a: Ammo): 'rocket' | 'gl' | null => (a.visual === 'gl' ? 'gl' : a.visual === 'rocket' ? 'rocket' : null);
interface Thrown { id: number; body: import('@dimforge/rapier3d-compat').RigidBody; ammo: Ammo; owner: Soldier; fuse: number; kind: 'grenade' | 'smoke' | 'c4'; smoking: number }

/** Penetration class an ammunition needs to go through a surface (see Ammo.pen). */
export const THIN: Partial<Record<Surface, number>> = { glass: 0, wood: 1, metal: 2, sandbag: 9, masonry: 3, concrete: 4 };
let pid = 1;

export class Projectiles {
  bullets: Bullet[] = [];
  thrown: Thrown[] = [];
  private caps: Capsule[] = [];
  constructor(private P: Physics, private soldiers: () => Soldier[], private H: ProjectileHooks) {}

  /** `guide` (wire-guided missiles): the point the missile should fly to (on the gunner's sight line), null = wire cut. */
  fire(owner: Soldier, def: WeaponDef | null, ammoId: string, origin: V3, dir: V3, tracerShot: boolean, guide?: (p: V3) => V3 | null): Bullet {
    const a = AMMO[ammoId as keyof typeof AMMO];
    const v0 = a.v0;
    const b: Bullet = { id: pid++, p: [...origin], v: [dir[0] * v0, dir[1] * v0, dir[2] * v0], ammo: a, owner, t: 0, dist: 0, tracer: tracerShot || a.visual === 'shell', pens: 0, armed: a.id === 'hedp40' ? 18 : a.guided ? 65 : 0, boostT: a.rocket ? a.rocket.burn : 0, guide };
    this.bullets.push(b);
    const k = bodyKind(a); if (k) this.H.body(b.id, k, b.p, b.v);
    void def;
    return b;
  }

  throwItem(owner: Soldier, ammoId: 'frag' | 'smoke' | 'c4', origin: V3, vel: V3, fuse: number) {
    const R = this.P.R, w = this.P.world;
    const body = w.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(origin[0], origin[1], origin[2]).setLinvel(vel[0], vel[1], vel[2]).setAngularDamping(1.5).setLinearDamping(0.05).setCcdEnabled(true));
    w.createCollider(R.ColliderDesc.ball(0.04).setDensity(1200).setRestitution(0.25).setFriction(0.9).setCollisionGroups(((0x0008 & 0xffff) << 16) | (G_WORLD | G_VEH)), body);
    const kind = ammoId === 'frag' ? 'grenade' : ammoId;
    const t: Thrown = { id: pid++, body, ammo: AMMO[ammoId], owner, fuse, kind, smoking: 0 };
    this.thrown.push(t);
    this.H.body(t.id, kind, origin);
  }

  step(dt: number) {
    // Thrown items.
    for (let i = this.thrown.length - 1; i >= 0; i--) {
      const t = this.thrown[i], q = t.body.translation(), p: V3 = [q.x, q.y, q.z];
      this.H.body(t.id, t.kind, p);
      t.fuse -= dt;
      if (t.kind === 'smoke') {
        if (t.fuse <= 0 && t.smoking === 0) { t.smoking = 1; this.H.smoke(p); }
        if (t.fuse < -60) { this.removeThrown(i); }
        continue;
      }
      if (t.fuse <= 0) { this.H.explode([p[0], p[1] + 0.1, p[2]], t.ammo, t.owner); this.removeThrown(i); }
    }
    // Bullets and rockets.
    const sol = this.soldiers();
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i], a = b.ammo;
      const sp = Math.hypot(b.v[0], b.v[1], b.v[2]);
      let ax = -a.k * sp * b.v[0], ay = -a.k * sp * b.v[1] - 9.81, az = -a.k * sp * b.v[2];
      if (a.rocket && b.t > a.rocket.boost && b.boostT > 0) {
        // Sustainer: accelerate towards cruise speed along the velocity.
        b.boostT -= dt;
        const gain = Math.max(0, a.rocket.cruise - sp) * 3.2;
        ax += (b.v[0] / sp) * gain; ay += (b.v[1] / sp) * gain + 9.81 * 0.85; az += (b.v[2] / sp) * gain;
      }
      // Wire guidance (SACLOS): steer towards the gunner's sight line, at most ~0.5 rad/s; the motor holds altitude.
      if (a.guided && b.t > 0.35) {
        const tgt = b.guide?.(b.p) ?? null;
        if (tgt) {
          const w: V3 = [tgt[0] - b.p[0], tgt[1] - b.p[1], tgt[2] - b.p[2]], wl = Math.hypot(w[0], w[1], w[2]) || 1;
          const cur: V3 = [b.v[0] / sp, b.v[1] / sp, b.v[2] / sp], k = Math.min(1, 0.5 * dt * 6);
          const nd: V3 = [cur[0] + (w[0] / wl - cur[0]) * k, cur[1] + (w[1] / wl - cur[1]) * k, cur[2] + (w[2] / wl - cur[2]) * k];
          const nl = Math.hypot(nd[0], nd[1], nd[2]);
          b.v = [nd[0] / nl * sp, nd[1] / nl * sp, nd[2] / nl * sp];
          ay += 9.81;
        }
      }
      const nv: V3 = [b.v[0] + ax * dt, b.v[1] + ay * dt, b.v[2] + az * dt];
      const seg: V3 = [(b.v[0] + nv[0]) * 0.5 * dt, (b.v[1] + nv[1]) * 0.5 * dt, (b.v[2] + nv[2]) * 0.5 * dt];
      const L = Math.hypot(seg[0], seg[1], seg[2]), d: V3 = [seg[0] / L, seg[1] / L, seg[2] / L];
      b.t += dt;
      // World hit (a round fired from inside a vehicle — coax, hull MG — passes through that vehicle's own hull).
      const own = b.owner.vehicle && this.H.ownVehicle ? (c: { handle: number }) => !this.H.ownVehicle!(c.handle, b.owner) : undefined;
      const wh = this.P.castRay(b.p, d, L, G_WORLD | G_VEH, undefined, own);
      let hitDist = wh ? wh.dist : L;
      // Soldier hit (closest capsule along the segment).
      let best = null as { s: Soldier; t: number; part: HitPart } | null;
      for (const s of sol) {
        if (s === b.owner && b.t < 0.2) continue;
        if (s.state === 'dead') continue;
        // Crew inside armour cannot be hit; a commander fighting head-out of his hatch can (his exposed capsules).
        const exp = s.vehicle ? this.H.exposed?.(s) : null;
        if (s.vehicle) {
          if (!exp?.length || s.vehicle === b.owner.vehicle) continue;
          for (const c of exp) { const tt = segCapsule(b.p, d, hitDist, c); if (tt !== null && (!best || tt < best.t)) best = { s, t: tt, part: c.part }; }
          continue;
        }
        const cx = s.pos[0] - b.p[0], cz = s.pos[2] - b.p[2];
        // Broad phase: distance from the segment's line to the soldier.
        const along = cx * d[0] + cz * d[2];
        if (along < -2 || along > hitDist + 2) continue;
        const px = cx - d[0] * along, pz = cz - d[2] * along;
        if (px * px + pz * pz > 4) {
          // Near-miss crack for supersonic rounds passing within ~6 m.
          if (a.crack && sp > 360 && px * px + pz * pz < 40 && s !== b.owner && s.team !== b.owner.team && !(b.cracked ??= new Set()).has(s.id) && b.cracked.add(s.id)) this.H.crack(s, [b.p[0] + d[0] * along, b.p[1], b.p[2] + d[2] * along], a, b.owner);
          continue;
        }
        for (const c of s.hitboxes(this.caps)) {
          const tt = segCapsule(b.p, d, hitDist, c);
          if (tt !== null && (!best || tt < best.t)) best = { s, t: tt, part: c.part };
        }
        if (!best || best.s !== s) {
          if (a.crack && sp > 360 && s !== b.owner && s.team !== b.owner.team && !(b.cracked ??= new Set()).has(s.id) && b.cracked.add(s.id)) this.H.crack(s, [b.p[0] + d[0] * along, b.p[1] + d[1] * along, b.p[2] + d[2] * along], a, b.owner);
        }
      }
      const prev: V3 = [...b.p];
      if (best && best.t < hitDist) {
        const hp: V3 = [b.p[0] + d[0] * best.t, b.p[1] + d[1] * best.t, b.p[2] + d[2] * best.t];
        if (b.tracer) this.H.tracer(prev, hp, a);
        if (a.explosive && b.dist + best.t >= b.armed) { this.H.explode(hp, a, b.owner, [-d[0], -d[1], -d[2]]); this.removeBullet(i); continue; }
        const vr = sp / a.v0, scale = Math.max(0.35, Math.min(1, Math.pow(vr, 1.4)));
        this.H.hit(best.s, hp, best.part, { ...a, dmg: a.dmg * scale }, b.owner);
        // Heavy rounds keep going through a body.
        if (a.pen >= 3 && !a.explosive) { b.p = [hp[0] + d[0] * 0.5, hp[1] + d[1] * 0.5, hp[2] + d[2] * 0.5]; b.v = [nv[0] * 0.7, nv[1] * 0.7, nv[2] * 0.7]; continue; }
        this.removeBullet(i); continue;
      }
      if (wh) {
        if (b.tracer) this.H.tracer(prev, wh.point, a);
        // Armoured vehicles: the armour model decides (and explodes HEAT on the plate).
        if (this.H.armour && (b.dist + wh.dist >= b.armed || !a.explosive) && this.H.armour(wh, d, sp, a, b.owner)) { this.removeBullet(i); continue; }
        if (a.explosive) {
          // Burst just off the surface: a big warhead's stand-off; a small-calibre shell bursts on the wall itself (at
          // 0.2 m the 25 mm's breach never reached the masonry and it left only a scorch).
          const so = Math.min(0.2, (a.explosive.breach ?? 0) * 0.25);
          if (b.dist + wh.dist >= b.armed) this.H.explode([wh.point[0] + wh.normal[0] * so, wh.point[1] + wh.normal[1] * so, wh.point[2] + wh.normal[2] * so], a, b.owner, wh.normal);
          else this.H.impact(wh.point, wh.normal, wh.surf, a); // dud: armed too close
          this.removeBullet(i); continue;
        }
        this.H.impact(wh.point, wh.normal, wh.surf, a, d);
        // A cannon penetrator punches a hole through brick / block / concrete (and flies on through it).
        if (a.punch && (wh.surf === 'masonry' || wh.surf === 'concrete') && b.pens < 2) this.H.punch?.(wh.point, wh.normal, a.punch * Math.min(1, sp / a.v0));
        const cos = -(d[0] * wh.normal[0] + d[1] * wh.normal[1] + d[2] * wh.normal[2]);
        // Ricochet off hard surfaces at grazing angles.
        if (cos < 0.25 && (wh.surf === 'concrete' || wh.surf === 'metal' || wh.surf === 'masonry') && b.pens < 2 && Math.random() < 0.6) {
          const k = 2 * (d[0] * wh.normal[0] + d[1] * wh.normal[1] + d[2] * wh.normal[2]);
          const r: V3 = [d[0] - k * wh.normal[0], d[1] - k * wh.normal[1], d[2] - k * wh.normal[2]];
          const s2 = sp * 0.45;
          b.v = [r[0] * s2 + (Math.random() - 0.5) * 40, r[1] * s2 + Math.random() * 20, r[2] * s2 + (Math.random() - 0.5) * 40];
          b.p = [wh.point[0] + wh.normal[0] * 0.02, wh.point[1] + wh.normal[1] * 0.02, wh.point[2] + wh.normal[2] * 0.02];
          b.pens++; b.dist += wh.dist; continue;
        }
        // Penetration: thin materials for rifle rounds; masonry walls only for heavy MGs. Check the exit within 0.45 m.
        const need = THIN[wh.surf] ?? 9;
        if (a.pen >= need && b.pens < 3) {
          const thick = need <= 1 ? 0.08 : need === 2 ? 0.12 : 0.45;
          const ex: V3 = [wh.point[0] + d[0] * thick, wh.point[1] + d[1] * thick, wh.point[2] + d[2] * thick];
          const back = this.P.castRay(ex, [-d[0], -d[1], -d[2]], thick, G_WORLD | G_VEH);
          if (back) {
            const loss = need <= 1 ? 0.75 : need === 2 ? 0.55 : 0.4;
            b.p = [ex[0], ex[1], ex[2]]; b.v = [nv[0] * loss, nv[1] * loss, nv[2] * loss]; b.pens++; b.dist += wh.dist + thick;
            this.H.impact(back.point, back.normal, wh.surf, a);
            continue;
          }
        }
        this.removeBullet(i); continue;
      }
      if (b.tracer) this.H.tracer(prev, [b.p[0] + seg[0], b.p[1] + seg[1], b.p[2] + seg[2]], a);
      b.p = [b.p[0] + seg[0], b.p[1] + seg[1], b.p[2] + seg[2]]; b.v = nv; b.dist += L;
      const bk = bodyKind(a); if (bk) this.H.body(b.id, bk, b.p, b.v);
      const selfD = a.rocket?.selfDestruct;
      if (selfD && b.dist > selfD) { this.H.explode(b.p, a, b.owner); this.removeBullet(i); continue; }
      if ((b.t > 6 && !a.guided) || b.t > 25 || (sp < 60 && !a.explosive) || b.p[1] < -50) this.removeBullet(i);
    }
  }

  private removeBullet(i: number) { const b = this.bullets[i]; if (bodyKind(b.ammo)) this.H.body(b.id, 'rocket', null); this.bullets.splice(i, 1); }
  private removeThrown(i: number) { const t = this.thrown[i]; this.H.body(t.id, t.kind, null); this.P.world.removeRigidBody(t.body); this.thrown.splice(i, 1); }
}

/** Distance along a ray (origin o, unit dir d, max L) to a capsule, or null (closest points of two segments, Ericson). */
export function segCapsule(o: V3, d: V3, L: number, c: Capsule): number | null {
  const d1: V3 = [d[0] * L, d[1] * L, d[2] * L], d2: V3 = [c.b[0] - c.a[0], c.b[1] - c.a[1], c.b[2] - c.a[2]];
  const r: V3 = [o[0] - c.a[0], o[1] - c.a[1], o[2] - c.a[2]];
  const dot = (p: V3, q: V3) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2], cl = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s = 0, t = 0;
  if (e <= 1e-9) { s = cl(-dot(d1, r) / a); t = 0; }
  else {
    const cc = dot(d1, r), b = dot(d1, d2), den = a * e - b * b;
    s = den > 1e-9 ? cl((b * f - cc * e) / den) : 0;
    t = (b * s + f) / e;
    if (t < 0) { t = 0; s = cl(-cc / a); } else if (t > 1) { t = 1; s = cl((b - cc) / a); }
  }
  const px = r[0] + d1[0] * s - d2[0] * t, py = r[1] + d1[1] * s - d2[1] * t, pz = r[2] + d1[2] * s - d2[2] * t;
  const dist2 = px * px + py * py + pz * pz;
  if (dist2 > c.r * c.r) return null;
  // Step back from the closest point to the surface entry (approximate).
  return Math.max(0, s * L - Math.sqrt(c.r * c.r - dist2));
}

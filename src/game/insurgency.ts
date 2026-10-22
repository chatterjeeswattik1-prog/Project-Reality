// Project Reality "Insurgency" rules (docs/RESEARCH.md §1), scaled for one player plus bots:
// - Insurgent weapon caches are hidden in buildings; at most 2 are active at a time; only C4 destroys a cache.
// - BLUFOR earns intel (+1 per insurgent killed, −10 per civilian); INTEL_REVEAL points reveal the next active cache
//   on the map as a search circle up to 75 m off its true position. Each destroyed cache gives BLUFOR +30 tickets.
// - BLUFOR loses a ticket per soldier killed (not when revived) and loses at 0 tickets or when time runs out;
//   BLUFOR wins by destroying CACHES_TO_WIN caches. Insurgents respawn without limit at undiscovered caches and hideouts.
import * as THREE from 'three';
import type { City, Spot } from '../world/citygen';
import type { Game } from './game';
import type { Soldier } from './soldier';
import type { V3 } from './projectiles';
import { mulberry } from '../core/rng';
import { gridRef } from '../world/terrain';
import type { GameMode } from './mode';

export const CACHES_TOTAL = 6, CACHES_TO_WIN = 5, MAX_ACTIVE = 2, INTEL_REVEAL = 25, CACHE_TICKETS = 30, REVEAL_OFFSET = 75;

export interface Cache {
  id: number; spot: Spot; pos: V3;
  state: 'hidden' | 'active' | 'destroyed';
  /** Revealed to BLUFOR on the map (approximate circle). */ revealed: boolean;
  /** Exact position confirmed (seen by a BLUFOR soldier). */ found: boolean;
  marker: [number, number];
  mesh: THREE.Object3D | null;
}

export class Insurgency implements GameMode {
  kind = 'insurgency' as const;
  caches: Cache[] = [];
  tickets = 200;
  intel = 0;
  destroyed = 0;
  timeLeft = 60 * 60;
  over: null | 'us' | 'ins' = null;
  log: { t: number; text: string; team?: 'us' | 'ins' }[] = [];

  constructor(private g: Game, city: City, seed: number, private cacheModel: THREE.Object3D | null) {
    const rng = mulberry(seed * 7 + 3);
    // Spread caches across the town: candidate ground-floor rooms in the old town, ruins, outskirts and industry,
    // at least 160 m apart, none too close to the FOB.
    const cands = city.cacheSpots.filter((s) => s.floor === 0 && s.x < 470 && ['old', 'ruins', 'industrial', 'outskirts', 'civic', 'new'].includes(s.district));
    const picked: Spot[] = [];
    for (let tries = 0; tries < 4000 && picked.length < CACHES_TOTAL; tries++) {
      const s = cands[Math.floor(rng() * cands.length)];
      if (picked.some((p) => Math.hypot(p.x - s.x, p.z - s.z) < 160)) continue;
      picked.push(s);
    }
    picked.forEach((s, i) => {
      const a = rng() * Math.PI * 2, r = rng() * REVEAL_OFFSET;
      this.caches.push({ id: i, spot: s, pos: [s.x, s.y, s.z], state: 'hidden', revealed: false, found: false, marker: [s.x + Math.cos(a) * r, s.z + Math.sin(a) * r], mesh: null });
    });
    for (let i = 0; i < MAX_ACTIVE; i++) this.activateNext();
    // The first active cache starts revealed so the US has a first objective.
    const first = this.caches.find((c) => c.state === 'active');
    if (first) this.reveal(first);
  }

  get active() { return this.caches.filter((c) => c.state === 'active'); }

  private activateNext() {
    const c = this.caches.find((k) => k.state === 'hidden');
    if (!c) return;
    c.state = 'active';
    const m = this.cacheModel ? this.cacheModel.clone() : (() => { const b = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.1, 1.0), new THREE.MeshStandardMaterial({ color: 0x4f5536, roughness: 0.9 })); b.position.y = 0.55; const gr = new THREE.Group(); gr.add(b); return gr; })();
    m.position.set(c.pos[0], c.pos[1], c.pos[2]);
    m.rotation.y = (c.id * 1.7) % (Math.PI * 2);
    m.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.g.gfx.scene.add(m); c.mesh = m;
  }

  reveal(c: Cache) { if (c.revealed) return; c.revealed = true; this.say(`Intel: weapons cache located near ${gridOf(c.marker)}`, 'us'); }

  say(text: string, team?: 'us' | 'ins') { this.log.push({ t: this.g.time, text, team }); if (this.log.length > 30) this.log.shift(); }

  /** A soldier went down (wounded) or died. */
  onDown(v: Soldier, by: Soldier | null, killed: boolean) {
    if (killed) { if (v.deathCounted) return; v.deathCounted = true; }
    if (killed && v.team === 'us') this.tickets = Math.max(0, this.tickets - 1);
    if (by && by.team === 'us' && v.team === 'ins' && (killed || v.state !== 'alive')) {
      if (!v.intelGiven) {
        v.intelGiven = true;
        this.intel += 1; by.score += 2;
        if (this.intel >= INTEL_REVEAL) {
          const next = this.active.find((c) => !c.revealed);
          if (next) { this.intel -= INTEL_REVEAL; this.reveal(next); }
          else this.intel = INTEL_REVEAL;
        }
      }
    }
    if (by && by !== v && by.team !== v.team && killed) by.kills++;
  }

  /** An explosion went off: C4 within 3.5 m of an active cache destroys it. */
  onExplosion(p: V3, ammoId: string, by: Soldier | null) {
    if (ammoId !== 'c4') return;
    for (const c of this.active) {
      if (Math.hypot(p[0] - c.pos[0], p[1] - (c.pos[1] + 0.5), p[2] - c.pos[2]) > 3.5) continue;
      c.state = 'destroyed'; this.destroyed++; this.tickets += CACHE_TICKETS;
      if (c.mesh) { this.g.gfx.scene.remove(c.mesh); c.mesh = null; }
      // Secondary explosions from the ammunition.
      for (let i = 1; i <= 3; i++) setTimeout(() => this.g.fx.explosion([c.pos[0] + (Math.random() - 0.5) * 2, c.pos[1] + 0.8, c.pos[2] + (Math.random() - 0.5) * 2], 1.2), i * 450);
      if (by) by.score += 50;
      this.say(`Weapons cache destroyed at ${gridOf([c.pos[0], c.pos[2]])} (${this.destroyed}/${CACHES_TO_WIN})`);
      this.activateNext();
      if (this.destroyed >= CACHES_TO_WIN) this.end('us');
    }
  }

  /** BLUFOR soldiers who see a cache up close confirm its exact position. */
  spot(s: Soldier) {
    for (const c of this.active) {
      if (c.found) continue;
      const d = Math.hypot(s.pos[0] - c.pos[0], s.pos[2] - c.pos[2]);
      if (d < 18 && Math.abs(s.pos[1] - c.pos[1]) < 2.5 && this.g.P.clear(s.eye, [c.pos[0], c.pos[1] + 0.7, c.pos[2]])) {
        c.found = true; c.revealed = true; c.marker = [c.pos[0], c.pos[2]];
        this.say(`${s.name}: cache found at ${gridOf(c.marker)}!`, 'us');
      }
    }
  }

  update(dt: number) {
    if (this.over) return;
    this.timeLeft -= dt;
    if (this.tickets <= 0) this.end('ins');
    else if (this.timeLeft <= 0) this.end('ins');
  }
  end(w: 'us' | 'ins') { if (this.over) return; this.over = w; this.say(w === 'us' ? 'US Army wins: the insurgents have lost their weapons caches.' : 'Insurgents win: US forces have withdrawn.'); }

  hudTop() {
    const mm = Math.max(0, Math.floor(this.timeLeft / 60)), ss = Math.max(0, Math.floor(this.timeLeft % 60)).toString().padStart(2, '0');
    return `<span>US TICKETS <b>${this.tickets}</b></span><span>CACHES <b>${this.destroyed}/${CACHES_TO_WIN}</b></span><span>INTEL <b>${this.intel}</b></span><span>${mm}:${ss}</span>`;
  }

  /** Insurgent spawn points: undiscovered active caches (in the building) and the main base. */
  insSpawns(): V3[] {
    const out: V3[] = [];
    for (const c of this.active) if (!c.found) out.push([c.pos[0] + 1.5, c.pos[1], c.pos[2] + 1.5]);
    return out;
  }
}

export const gridOf = (p: [number, number]) => gridRef(p[0], p[1]);

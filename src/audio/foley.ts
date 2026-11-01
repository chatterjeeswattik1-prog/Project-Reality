// Body sounds: footsteps by surface (yours, and every soldier's near you, so you hear someone coming round a corner),
// landing, dropping prone, bodies hitting the ground; and the player's own breathing when blown, heartbeat when badly
// hurt, and the scrape of crawling.
import type { Game } from '../game/game';
import type { Soldier } from '../game/soldier';
import { G_WORLD } from '../world/physics';
import type { LoopVoice } from './audio';

type V3 = [number, number, number];
interface Track { p: V3; acc: number; air: number; stance: string; alive: boolean; downT: number }

/** Metres per step: walking, running, sprinting, crouched. */
const STRIDE = { walk: 0.75, run: 1.05, sprint: 1.45, crouch: 0.6 };

export class Foley {
  private tr = new Map<number, Track>();
  private falls: { p: V3; t: number }[] = [];
  private breath: LoopVoice | null = null; private heart: LoopVoice | null = null; private crawl: LoopVoice | null = null;
  private loopsOn = false;

  constructor(private g: Game) {}

  update(dt: number) {
    const g = this.g, A = g.audio, L = A.listener.p;
    for (const s of g.soldiers) {
      let t = this.tr.get(s.id);
      if (!t) { t = { p: [...s.pos] as V3, acc: 0, air: 0, stance: s.stance, alive: s.alive, downT: 0 }; this.tr.set(s.id, t); }
      const d = Math.hypot(s.pos[0] - t.p[0], s.pos[2] - t.p[2]);
      t.p[0] = s.pos[0]; t.p[1] = s.pos[1]; t.p[2] = s.pos[2];
      // Going down: the body hits the ground a moment later.
      if (t.alive && !s.alive) this.falls.push({ p: [s.pos[0], s.pos[1] + 0.2, s.pos[2]], t: 0.42 + Math.random() * 0.15 });
      t.alive = s.alive;
      if (!s.alive) continue;
      const me = s.isPlayer, far = Math.hypot(s.pos[0] - L[0], s.pos[2] - L[2]), audible = me || far <= 45;
      const pos: V3 | null = me ? null : [s.pos[0], s.pos[1] + 0.05, s.pos[2]];
      // Landing after a drop or a jump.
      if (!s.onGround) t.air += dt;
      else { if (t.air > 0.35 && audible) A.play('land_jump', pos, { range: 35, gain: me ? 0.45 : 0.8 }); t.air = 0; }
      if (s.stance === 'prone' && t.stance !== 'prone' && audible) A.play('prone_down', pos, { range: 25, gain: me ? 0.5 : 0.8 });
      t.stance = s.stance;
      if (!s.onGround || s.stance === 'prone' || d > 2) { t.acc = 0; continue; }
      t.acc += d;
      const sp = Math.hypot(s.vel[0], s.vel[2]);
      const stride = s.stance === 'crouch' ? STRIDE.crouch : s.sprinting ? STRIDE.sprint : sp > 2.4 ? STRIDE.run : STRIDE.walk;
      if (t.acc < stride) continue;
      t.acc -= stride;
      const loud = s.sprinting ? 1.25 : s.stance === 'crouch' ? 0.45 : sp > 2.4 ? 1 : 0.7;
      this.overheard(s, loud);
      if (!audible) continue;
      const h = g.P.castRay([s.pos[0], s.pos[1] + 0.3, s.pos[2]], [0, -1, 0], 1.2, G_WORLD);
      const surf = h?.surf ?? 'dirt';
      const name = surf === 'dirt' || surf === 'sandbag' ? (Math.random() < 0.3 ? 'step_gravel' : 'step_dirt') : 'step_concrete';
      A.play(name, pos, { range: 12 + 30 * loud, gain: (me ? 0.38 : 1) * loud, rate: (surf === 'wood' ? 0.85 : surf === 'metal' ? 1.15 : 1) * (0.92 + Math.random() * 0.16), verb: 0.15 });
    }
    for (let i = this.falls.length - 1; i >= 0; i--) {
      const f = this.falls[i]; if ((f.t -= dt) > 0) continue;
      this.falls.splice(i, 1);
      A.play('body_fall', f.p, { range: 40, gain: 1 });
    }
    if (this.tr.size > g.soldiers.length + 40) { const ids = new Set(g.soldiers.map((s) => s.id)); for (const k of this.tr.keys()) if (!ids.has(k)) this.tr.delete(k); }
    this.playerLoops(g.player?.s ?? null);
  }

  /**
   * Enemies close by hear the footstep (sprinting ~22 m, running ~15 m, walking ~10 m, crouched ~4 m; half that
   * through a wall) and turn towards it: in a house fight, creeping matters.
   */
  private overheard(s: Soldier, loud: number) {
    const g = this.g, R = loud >= 1.2 ? 22 : loud >= 1 ? 15 : loud >= 0.6 ? 10 : 4;
    const p: V3 = [s.pos[0], s.pos[1] + 1.2, s.pos[2]];
    for (const o of g.soldiers) {
      if (o.team === s.team || !o.alive || o.isPlayer) continue;
      const d = Math.hypot(o.pos[0] - p[0], o.pos[1] + 1.2 - p[1], o.pos[2] - p[2]);
      if (d > R || (o.heard && g.time - o.heard.t < 0.8)) continue;
      if (d > R * 0.5 && !g.P.clear(o.eye, p)) continue;
      o.heard = { p, t: g.time };
    }
  }

  /** Breathing when blown, heartbeat when badly hurt or bleeding, cloth scraping while crawling. */
  private playerLoops(s: Soldier | null) {
    const A = this.g.audio;
    if (!this.loopsOn) {
      if (!s || A.ctx.state !== 'running') return;
      this.breath = A.loopVoice('breath_heavy_loop'); this.heart = A.loopVoice('heartbeat_loop'); this.crawl = A.loopVoice('crawl_cloth_loop');
      this.loopsOn = true;
    }
    const alive = !!s && s.alive;
    const blown = alive ? Math.max(0, (45 - s!.stamina) / 45) : 0;
    const hurt = s && s.state !== 'dead' ? Math.max(s.state === 'wounded' ? 1 : 0, Math.max(0, (50 - s.health) / 50), Math.min(1, s.bleed / 3)) : 0;
    const crawling = alive && s!.stance === 'prone' && s!.moving > 0.15 ? 1 : 0;
    this.breath?.set(blown * 0.9);
    this.heart?.set(hurt * 0.8);
    this.crawl?.set(crawling * 0.6);
  }
}

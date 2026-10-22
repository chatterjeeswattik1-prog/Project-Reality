// What the HUD, bots and main loop need from a game mode (Insurgency on the full map, Skirmish in test areas).
import type { Soldier } from './soldier';
import type { V3 } from './projectiles';

export interface GameMode {
  kind: 'insurgency' | 'skirmish';
  log: { t: number; text: string; team?: 'us' | 'ins' }[];
  over: null | 'us' | 'ins';
  timeLeft: number;
  say(text: string, team?: 'us' | 'ins'): void;
  onDown(v: Soldier, by: Soldier | null, killed: boolean): void;
  onExplosion(p: V3, ammoId: string, by: Soldier | null): void;
  /** A BLUFOR soldier may confirm a cache (Insurgency); no-op elsewhere. */
  spot(s: Soldier): void;
  update(dt: number): void;
  /** HTML for the HUD's top-right status. */
  hudTop(): string;
}

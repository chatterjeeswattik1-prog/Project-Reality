// The one match (Vercel Function). Only one match runs at a time, hosted in a player's browser, for up to 30 players.
//   GET  /api/lobby                         → { lobby: Lobby | null, ice: RTCIceServer[], shared: boolean }
//   POST /api/lobby { action: 'host', id, name, seed, players, key? }   start hosting / heartbeat (every ~5 s); `key` =
//        DEDICATED_KEY marks the always-on server (scripts/dedicated.mjs), which takes the match over
//   POST /api/lobby { action: 'close', id }                        the host ends the match
// A host that stops sending heartbeats for 15 s is gone: the slot is free for someone else to host.
import { env, getStore, hasSharedStore, json } from './_store';

export const CAP = 30;
const KEY = 'pr:lobby', TTL = 15;

export interface Lobby { hostId: string; hostName: string; seed: number; players: number; cap: number; startedAt: number; updated: number; /** Run by the always-on server (scripts/dedicated.mjs). */ dedicated?: boolean }

/** STUN always; a TURN relay (for players behind strict NATs) when configured: TURN_URLS (comma-separated),
 *  TURN_USERNAME, TURN_CREDENTIAL. */
function iceServers(): RTCIceServer[] {
  const out: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (env.TURN_URLS) out.push({ urls: env.TURN_URLS.split(',').map((s) => s.trim()), username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL });
  return out;
}

async function current(): Promise<Lobby | null> {
  const s = await getStore().get(KEY);
  if (!s) return null;
  const l = JSON.parse(s) as Lobby;
  return Date.now() - l.updated < TTL * 1000 ? l : null;
}

export async function GET(): Promise<Response> {
  return json({ lobby: await current(), ice: iceServers(), shared: hasSharedStore() });
}

export async function POST(req: Request): Promise<Response> {
  let b: { action?: string; id?: string; name?: string; seed?: number; players?: number; key?: string };
  try { b = await req.json(); } catch { return json({ error: 'bad request' }, 400); }
  const id = String(b.id ?? '').slice(0, 40);
  if (!id) return json({ error: 'id required' }, 400);
  const cur = await current();
  if (b.action === 'host') {
    // The always-on server (it proves itself with DEDICATED_KEY) takes the match over, even from a player host or from its
    // own previous run after a restart; a player never takes it from the server.
    const dedicated = !!(b.key && env.DEDICATED_KEY && b.key === env.DEDICATED_KEY);
    if (cur && cur.hostId !== id && !dedicated) return json({ error: 'A match is already running', lobby: cur }, 409);
    const l: Lobby = { hostId: id, hostName: String(b.name ?? 'Host').slice(0, 24), seed: Number(b.seed ?? 1337) | 0, players: Math.max(0, Math.min(CAP, Number(b.players ?? 1) | 0)), cap: CAP, startedAt: cur?.hostId === id ? cur.startedAt : Date.now(), updated: Date.now(), dedicated };
    await getStore().set(KEY, JSON.stringify(l), TTL);
    return json({ lobby: l });
  }
  if (b.action === 'close') {
    if (cur && cur.hostId === id) await getStore().set(KEY, JSON.stringify({ ...cur, updated: 0 }), 1);
    return json({ ok: true });
  }
  return json({ error: 'unknown action' }, 400);
}

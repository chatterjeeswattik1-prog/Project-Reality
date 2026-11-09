// The one match (Vercel Function). Only one match runs at a time, hosted in a player's browser, for up to 20 players.
//   GET  /api/lobby                         → { lobby: Lobby | null, ice: RTCIceServer[], shared: boolean }
//   POST /api/lobby { action: 'host', id, name, seed, players, startedAt?, key? }
//        start hosting / heartbeat (every ~25 s) → { lobby, msgs }; `msgs` = whatever waited in the host's signalling
//        mailbox (join knocks and offers), so an idle host needs no other request. `key` = DEDICATED_KEY marks the
//        always-on server (scripts/dedicated.mjs), which takes the match over
//   POST /api/lobby { action: 'close', id }                        the host ends the match
// A host that stops sending heartbeats for 75 s is gone: the slot is free for someone else to host.
// Budget (an always-on server, 24/7): a beat is 2 store commands (SET + LPOP; the server skips the GET) and one
// function call, ~210k commands and ~105k calls a month, well inside the free tiers (Upstash 500k, Vercel 1M).
import { env, getStore, hasSharedStore, json } from './_store';

export const CAP = 20;
const KEY = 'pr:lobby', TTL = 75;

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
  let b: { action?: string; id?: string; name?: string; seed?: number; players?: number; startedAt?: number; key?: string };
  try { b = await req.json(); } catch { return json({ error: 'bad request' }, 400); }
  const id = String(b.id ?? '').slice(0, 40);
  if (!id) return json({ error: 'id required' }, 400);
  if (b.action === 'host') {
    // The always-on server (it proves itself with DEDICATED_KEY) takes the match over, even from a player host or from its
    // own previous run after a restart; a player never takes it from the server. The server needs no look at the
    // current holder, so its beat skips that read.
    const dedicated = !!(b.key && env.DEDICATED_KEY && b.key === env.DEDICATED_KEY);
    const cur = dedicated ? null : await current();
    if (cur && cur.hostId !== id) return json({ error: 'A match is already running', lobby: cur }, 409);
    const startedAt = cur?.hostId === id ? cur.startedAt : Number(b.startedAt) > 0 ? Number(b.startedAt) : Date.now();
    const l: Lobby = { hostId: id, hostName: String(b.name ?? 'Host').slice(0, 24), seed: Number(b.seed ?? 1337) | 0, players: Math.max(0, Math.min(CAP, Number(b.players ?? 1) | 0)), cap: CAP, startedAt, updated: Date.now(), dedicated };
    await getStore().set(KEY, JSON.stringify(l), TTL);
    const msgs = (await getStore().drain(`pr:mb:${id}`)).map((x) => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);
    return json({ lobby: l, msgs });
  }
  const cur = await current();
  if (b.action === 'close') {
    if (cur && cur.hostId === id) await getStore().set(KEY, JSON.stringify({ ...cur, updated: 0 }), 1);
    return json({ ok: true });
  }
  return json({ error: 'unknown action' }, 400);
}

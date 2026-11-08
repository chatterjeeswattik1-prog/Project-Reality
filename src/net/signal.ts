// Lobby and connection handshake through the Vercel Functions in api/ (lobby.ts, signal.ts). Only used to find the one
// match and to exchange WebRTC offers / answers; the game traffic then flows browser to browser (net/peer.ts).

export interface Lobby { hostId: string; hostName: string; seed: number; players: number; cap: number; startedAt: number; updated: number; dedicated?: boolean }
export interface LobbyInfo { lobby: Lobby | null; ice: RTCIceServer[]; shared: boolean }

const BASE = `${import.meta.env.BASE_URL}api`;

export const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 16);

export async function getLobby(): Promise<LobbyInfo> {
  const r = await fetch(`${BASE}/lobby`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`lobby ${r.status}`);
  return r.json();
}
/** Start hosting / heartbeat. Throws when another player already hosts the match. */
export async function hostBeat(id: string, name: string, seed: number, players: number, key?: string): Promise<Lobby> {
  const r = await fetch(`${BASE}/lobby`, { method: 'POST', body: JSON.stringify({ action: 'host', id, name, seed, players, key }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? `lobby ${r.status}`);
  return j.lobby;
}
export async function closeLobby(id: string) { try { await fetch(`${BASE}/lobby`, { method: 'POST', body: JSON.stringify({ action: 'close', id }), keepalive: true }); } catch { /* leaving anyway */ } }

export async function sendSignal(from: string, to: string, msg: unknown) {
  const r = await fetch(`${BASE}/signal`, { method: 'POST', body: JSON.stringify({ from, to, msg }) });
  if (!r.ok) throw new Error(`signal ${r.status}`);
}
export async function pollSignal(id: string): Promise<{ from: string; msg: unknown }[]> {
  const r = await fetch(`${BASE}/signal?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
  if (!r.ok) return [];
  return (await r.json()).msgs ?? [];
}

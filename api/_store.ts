// Storage for the lobby and the connection handshake (Vercel Functions are stateless and may run on several instances,
// so anything shared lives here). Production: Upstash Redis over its REST API — the Vercel Marketplace integration sets
// KV_REST_API_URL / KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN). Development (the Vite dev
// server, see vite.config.ts): an in-memory map.
//
// Only short-lived, low-rate data goes through here: one lobby record and per-player mailboxes for the WebRTC offer /
// answer. The game traffic itself flows browser to browser and never touches Vercel.

type Env = Record<string, string | undefined>;
const env: Env = (globalThis as unknown as { process?: { env: Env } }).process?.env ?? {};

export interface Store {
  get(key: string): Promise<string | null>;
  /** Set with expiry (s). */ set(key: string, value: string, ttl: number): Promise<void>;
  /** Append to a list (expiry s); `drain` returns and clears it (up to 64 entries, one command). */ push(key: string, value: string, ttl: number): Promise<void>;
  drain(key: string): Promise<string[]>;
}

class MemoryStore implements Store {
  private m = new Map<string, { v: string | string[]; exp: number }>();
  private live(k: string) { const e = this.m.get(k); if (e && e.exp < Date.now()) { this.m.delete(k); return undefined; } return e; }
  async get(k: string) { const e = this.live(k); return e && typeof e.v === 'string' ? e.v : null; }
  async set(k: string, v: string, ttl: number) { this.m.set(k, { v, exp: Date.now() + ttl * 1000 }); }
  async push(k: string, v: string, ttl: number) { const e = this.live(k); const l = e && Array.isArray(e.v) ? e.v : []; l.push(v); this.m.set(k, { v: l, exp: Date.now() + ttl * 1000 }); }
  async drain(k: string) { const e = this.live(k); if (!e || !Array.isArray(e.v)) return []; const out = e.v.splice(0, 64); if (!e.v.length) this.m.delete(k); return out; }
}

class UpstashStore implements Store {
  constructor(private url: string, private token: string) {}
  private async cmd(...args: (string | number)[]): Promise<unknown> {
    const r = await fetch(this.url, { method: 'POST', headers: { Authorization: `Bearer ${this.token}` }, body: JSON.stringify(args) });
    if (!r.ok) throw new Error(`redis ${r.status}`);
    return ((await r.json()) as { result: unknown }).result;
  }
  private async pipe(cmds: (string | number)[][]): Promise<unknown[]> {
    const r = await fetch(`${this.url}/pipeline`, { method: 'POST', headers: { Authorization: `Bearer ${this.token}` }, body: JSON.stringify(cmds) });
    if (!r.ok) throw new Error(`redis ${r.status}`);
    return ((await r.json()) as { result: unknown }[]).map((x) => x.result);
  }
  async get(k: string) { return (await this.cmd('GET', k)) as string | null; }
  async set(k: string, v: string, ttl: number) { await this.cmd('SET', k, v, 'EX', ttl); }
  async push(k: string, v: string, ttl: number) { await this.pipe([['RPUSH', k, v], ['EXPIRE', k, ttl]]); }
  // LPOP with a count takes and removes in one command (the free tier counts commands; empty → null).
  // (Falls back to LRANGE + DEL should a store ever reject the count form.)
  private lpopCount = true;
  async drain(k: string) {
    if (this.lpopCount) {
      try { return ((await this.cmd('LPOP', k, 64)) as string[] | null) ?? []; } catch { this.lpopCount = false; }
    }
    const [l] = await this.pipe([['LRANGE', k, 0, -1], ['DEL', k]]); return (l as string[]) ?? [];
  }
}

let store: Store | null = null;
export function getStore(): Store {
  if (store) return store;
  const url = env.KV_REST_API_URL ?? env.UPSTASH_REDIS_REST_URL, token = env.KV_REST_API_TOKEN ?? env.UPSTASH_REDIS_REST_TOKEN;
  store = url && token ? new UpstashStore(url, token) : new MemoryStore();
  return store;
}
export const hasSharedStore = () => !!((env.KV_REST_API_URL ?? env.UPSTASH_REDIS_REST_URL) && (env.KV_REST_API_TOKEN ?? env.UPSTASH_REDIS_REST_TOKEN));
export { env };

export const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

// Connection handshake mailboxes (Vercel Function): a joining player posts his WebRTC offer to the host's mailbox, the
// host posts the answer back. A player who chooses Multiplayer first posts a `knock`; the host collects its mailbox
// with every lobby heartbeat (~25 s) and polls it every 2 s only for a few minutes after mail arrives, so an idle host
// costs nothing here. The joiner polls his own mailbox only while waiting for the answer. Messages expire after 2 min.
//   POST /api/signal { from, to, msg }   → { ok }
//   GET  /api/signal?id=<me>             → { msgs: { from, msg }[] }
import { getStore, json } from './_store';

const TTL = 120, MAX = 64 * 1024;

export async function GET(req: Request): Promise<Response> {
  const id = new URL(req.url).searchParams.get('id')?.slice(0, 40);
  if (!id) return json({ error: 'id required' }, 400);
  const raw = await getStore().drain(`pr:mb:${id}`);
  return json({ msgs: raw.map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean) });
}

export async function POST(req: Request): Promise<Response> {
  const text = await req.text();
  if (text.length > MAX) return json({ error: 'too large' }, 413);
  let b: { from?: string; to?: string; msg?: unknown };
  try { b = JSON.parse(text); } catch { return json({ error: 'bad request' }, 400); }
  const from = String(b.from ?? '').slice(0, 40), to = String(b.to ?? '').slice(0, 40);
  if (!from || !to || b.msg === undefined) return json({ error: 'from, to and msg required' }, 400);
  await getStore().push(`pr:mb:${to}`, JSON.stringify({ from, msg: b.msg }), TTL);
  return json({ ok: true });
}

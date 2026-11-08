// Connection handshake mailboxes (Vercel Function): a joining player posts his WebRTC offer to the host's mailbox, the
// host posts the answer back. Each side polls its own mailbox only while connecting (the host about every 2 s while
// hosting, to admit new players). Messages expire after a minute.
//   POST /api/signal { from, to, msg }   → { ok }
//   GET  /api/signal?id=<me>             → { msgs: { from, msg }[] }
import { getStore, json } from './_store';

const TTL = 60, MAX = 64 * 1024;

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

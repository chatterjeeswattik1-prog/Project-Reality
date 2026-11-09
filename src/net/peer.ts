// WebRTC links between the host player's browser and each other player's (a star: the host holds up to 29 links).
// Every link has two data channels: 'r' reliable and ordered (events: shots, deaths, joins, chat, wall cuts) and 'u'
// unreliable and unordered (snapshots and movement: a late one is useless, the next is coming).
// The handshake (offer / answer, with all ICE candidates gathered first, so one message each way) goes through the
// Vercel signalling mailbox (net/signal.ts).
import { pollSignal, sendSignal, type Mail } from './signal';

export interface Link {
  id: string; pc: RTCPeerConnection; r: RTCDataChannel | null; u: RTCDataChannel | null; open: boolean;
  /** Round-trip time (ms), measured with pings. */ rtt: number;
}

/** Wait for ICE gathering to finish (or 4 s), so the description carries every candidate. */
function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((ok) => {
    const t = setTimeout(ok, 4000);
    pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); ok(); } });
  });
}

type Handlers = { onOpen: (l: Link) => void; onClose: (l: Link) => void; onR: (l: Link, msg: unknown) => void; onU: (l: Link, data: ArrayBuffer) => void };

function wire(l: Link, ch: RTCDataChannel, H: Handlers) {
  ch.binaryType = 'arraybuffer';
  if (ch.label === 'r') { l.r = ch; ch.onmessage = (e) => { try { const m = JSON.parse(e.data as string); if (m && m.t === 'ping') send(l, { t: 'pong', s: m.s }); else if (m && m.t === 'pong') l.rtt = performance.now() - m.s; else H.onR(l, m); } catch { /* ignore */ } }; }
  else { l.u = ch; ch.onmessage = (e) => { if (e.data instanceof ArrayBuffer) H.onU(l, e.data); }; }
  ch.onopen = () => { if (l.r?.readyState === 'open' && l.u?.readyState === 'open' && !l.open) { l.open = true; H.onOpen(l); } };
  ch.onclose = () => { if (l.open) { l.open = false; H.onClose(l); } };
}

export function send(l: Link, msg: unknown) { if (l.r?.readyState === 'open') l.r.send(JSON.stringify(msg)); }
/** Unreliable send; dropped when the channel is backed up (a snapshot later replaces it anyway). */
export function sendU(l: Link, data: ArrayBuffer) { if (l.u?.readyState === 'open' && l.u.bufferedAmount < 256 * 1024) l.u.send(data); }

/** Fast mailbox polling lasts this long after the last mail (a joiner's game is loading meanwhile). */
const WATCH_MS = 240_000, POLL_MS = 2000;

/**
 * Host side: admit players whose offers arrive in the host's mailbox; `admit` may refuse (match full). The mailbox is
 * collected with every lobby heartbeat (`deliver`); only after mail arrives (a join knock or an offer) does the host
 * poll it every 2 s, for a few minutes. An idle host makes no signalling requests (free-tier request budgets).
 */
export class HostLinks {
  links = new Map<string, Link>();
  private stop = false; private watchUntil = 0; private polling = false;
  constructor(private myId: string, private ice: RTCIceServer[], private H: Handlers & { admit: (id: string, hello: Record<string, unknown>) => string | null }) {
    setInterval(() => { for (const l of this.links.values()) send(l, { t: 'ping', s: performance.now() }); }, 2000);
  }
  /** Mail from the mailbox (heartbeat or poll): admit offers; any mail starts / extends the fast polling. */
  deliver(msgs: Mail[]) {
    if (!msgs.length || this.stop) return;
    this.watchUntil = Date.now() + WATCH_MS;
    for (const { from, msg } of msgs) {
      const m = msg as { type?: string; sdp?: string; hello?: Record<string, unknown> };
      if (m.type !== 'offer' || !m.sdp) continue; // knocks only wake the polling
      const refuse = this.H.admit(from, m.hello ?? {});
      if (refuse) { void sendSignal(this.myId, from, { type: 'refused', reason: refuse }).catch(() => undefined); continue; }
      void this.accept(from, m.sdp);
    }
    if (!this.polling) void this.poll();
  }
  private async poll() {
    this.polling = true;
    while (!this.stop && Date.now() < this.watchUntil) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      try { this.deliver(await pollSignal(this.myId)); } catch { /* lobby service hiccup: try again */ }
    }
    this.polling = false;
  }
  private async accept(id: string, sdp: string) {
    this.links.get(id)?.pc.close();
    const pc = new RTCPeerConnection({ iceServers: this.ice });
    const l: Link = { id, pc, r: null, u: null, open: false, rtt: 0 };
    this.links.set(id, l);
    pc.ondatachannel = (e) => wire(l, e.channel, this.H);
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' || pc.connectionState === 'closed') { this.links.delete(id); if (l.open) { l.open = false; this.H.onClose(l); } } };
    await pc.setRemoteDescription({ type: 'offer', sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered(pc);
    await sendSignal(this.myId, id, { type: 'answer', sdp: pc.localDescription!.sdp });
  }
  close() { this.stop = true; for (const l of this.links.values()) l.pc.close(); this.links.clear(); }
}

/** Player side: connect to the host. Resolves with the open link, or rejects (refused, timed out). */
export async function connectToHost(myId: string, hostId: string, ice: RTCIceServer[], hello: Record<string, unknown>, H: Handlers): Promise<Link> {
  const pc = new RTCPeerConnection({ iceServers: ice });
  const l: Link = { id: hostId, pc, r: null, u: null, open: false, rtt: 0 };
  let opened: (l: Link) => void = () => undefined;
  const ready = new Promise<Link>((ok) => { opened = ok; });
  const Hw: Handlers = { ...H, onOpen: (x) => { H.onOpen(x); opened(x); } };
  wire(l, pc.createDataChannel('r', { ordered: true }), Hw);
  wire(l, pc.createDataChannel('u', { ordered: false, maxRetransmits: 0 }), Hw);
  setInterval(() => send(l, { t: 'ping', s: performance.now() }), 2000);
  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc);
  await sendSignal(myId, hostId, { type: 'offer', sdp: pc.localDescription!.sdp, hello });
  // Wait for the answer (or a refusal) in our mailbox. An idle host only sees the offer with its next heartbeat (≤25 s),
  // normally it is already watching thanks to the knock sent when this player chose Multiplayer.
  const t0 = Date.now();
  while (Date.now() - t0 < 45000) {
    for (const { msg } of await pollSignal(myId)) {
      const m = msg as { type?: string; sdp?: string; reason?: string };
      if (m.type === 'refused') { pc.close(); throw new Error(m.reason ?? 'refused'); }
      if (m.type === 'answer' && m.sdp) {
        await pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
        // The direct link may still fail (strict NATs need a TURN relay: TURN_URLS on the server): give up after 20 s.
        let t = 0;
        const timeout = new Promise<never>((_, no) => { t = window.setTimeout(() => { pc.close(); no(new Error('Could not connect to the host directly (a relay server may be needed)')); }, 20000); });
        const link = await Promise.race([ready, timeout]); clearTimeout(t);
        return link;
      }
    }
    await new Promise((r) => setTimeout(r, Date.now() - t0 < 6000 ? 700 : 1500));
  }
  pc.close();
  throw new Error('The host did not answer');
}

// Download progress for the loading screen. Every asset (glTF models, textures, sounds, the navmesh) is fetched with
// fetch(), including three.js's loaders, so wrapping fetch once counts all of them: bytes received so far, the total
// of the responses whose size is known, and the transfer rate. Images loaded through <img> (TextureLoader) are not
// counted; they are small next to the models.
const st = { got: 0, total: 0, files: 0, done: 0, t0: 0, last: 0, expect: 0 };
/**
 * Bytes a first visit is expected to download (measured with scripts/loadtest.mjs: full map ~133 MB with the armour, test area
 * ~103 MB; approximate). Requests start one after another, so the sum of known sizes alone would make the bar jump and
 * the time left read "1 s" all along; the larger of the two is used.
 */
export function expectDownload(bytes: number) { st.expect = bytes; }
let installed = false;

export function trackDownloads() {
  if (installed) return; installed = true;
  const orig = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const r = await orig(input, init);
    if (!r.ok || !r.body) return r;
    const len = Number(r.headers.get('content-length') ?? 0);
    // A compressed transfer reports the compressed length while the body arrives decompressed: count it but do not
    // add it to the total (the bar would overrun).
    const enc = r.headers.get('content-encoding');
    const sized = len > 0 && (!enc || enc === 'identity');
    if (!st.t0) st.t0 = performance.now();
    st.files++; if (sized) st.total += len;
    let seen = 0;
    const reader = r.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        const { done, value } = await reader.read();
        if (done) { st.done++; if (sized && seen < len) st.got += len - seen; c.close(); return; }
        seen += value.byteLength; st.got += sized ? Math.min(value.byteLength, Math.max(0, len - (seen - value.byteLength))) : 0;
        st.last = performance.now();
        c.enqueue(value);
      },
      cancel(e) { void reader.cancel(e); },
    });
    return new Response(body, { status: r.status, statusText: r.statusText, headers: r.headers });
  };
}

/** Bytes received / expected, rate (bytes/s) and an estimate of the seconds left (null when unknown). */
export function downloads() {
  const sec = st.t0 ? Math.max(0.5, (performance.now() - st.t0) / 1000) : 0;
  const rate = sec ? st.got / sec : 0, total = Math.max(st.total, st.expect);
  const left = rate > 1e4 && total > st.got ? (total - st.got) / rate : null;
  return { got: st.got, total, rate, left, files: st.files, done: st.done };
}

export const mb = (b: number) => (b / 1048576).toFixed(b < 10 * 1048576 ? 1 : 0);

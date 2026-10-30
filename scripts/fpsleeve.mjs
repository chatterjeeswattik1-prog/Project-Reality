// Sleeve extension for the first-person arm meshes (used by scripts/fprig.mjs). The packs' arms end in an open ring at
// the shoulder; on wide screens that cut end comes into view. Each shoulder ring (the innermost large open loop on each
// side) is extruded `len` further along the sleeve (away from the rest of the sleeve), with the ring's own
// skin weights (so it follows the upper arm rigidly), slightly tapered, and capped.
export function extendSleeves(doc, meshName, len, minR) {
  for (const m of doc.getRoot().listMeshes()) {
    if (!meshName.test(m.getName())) continue;
    for (const p of m.listPrimitives()) extendPrim(doc, p, len, minR);
  }
}

function extendPrim(doc, p, len, minR) {
  const idxA = p.getIndices(); if (!idxA) return;
  const pos = p.getAttribute('POSITION'), N = pos.getCount(), P = pos.getArray(), I = Array.from(idxA.getArray());
  // Weld by position to find open edges (UV seams split vertices).
  const key = (i) => `${P[i * 3].toFixed(5)},${P[i * 3 + 1].toFixed(5)},${P[i * 3 + 2].toFixed(5)}`;
  const first = new Map(), w = new Int32Array(N);
  for (let i = 0; i < N; i++) { const k = key(i); if (!first.has(k)) first.set(k, i); w[i] = first.get(k); }
  const ec = new Map();
  for (let t = 0; t < I.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = w[I[t + e]], b = w[I[t + (e + 1) % 3]], k = a < b ? `${a}_${b}` : `${b}_${a}`;
    ec.set(k, (ec.get(k) || 0) + 1);
  }
  const adj = new Map();
  for (const [k, c] of ec) { if (c !== 1) continue; const [a, b] = k.split('_').map(Number); (adj.get(a) ?? adj.set(a, []).get(a)).push(b); (adj.get(b) ?? adj.set(b, []).get(b)).push(a); }
  const seen = new Set(), loops = [];
  for (const v of adj.keys()) {
    if (seen.has(v)) continue;
    const L = [], st = [v];
    while (st.length) { const x = st.pop(); if (seen.has(x)) continue; seen.add(x); L.push(x); for (const y of adj.get(x)) st.push(y); }
    const c = [0, 1, 2].map((k) => L.reduce((a, i) => a + P[i * 3 + k], 0) / L.length);
    const r = Math.max(...L.map((i) => Math.hypot(P[i * 3] - c[0], P[i * 3 + 1] - c[1], P[i * 3 + 2] - c[2])));
    loops.push({ L, c, r });
  }
  if (!loops.length) return;
  const rmax = Math.max(...loops.map((l) => l.r));
  const big = loops.filter((l) => l.r > rmax * 0.6 && l.r >= minR);
  const pickSide = (sg) => big.filter((l) => Math.sign(l.c[0]) === sg).sort((a, b) => Math.abs(a.c[0]) - Math.abs(b.c[0]))[0];
  const rings = [pickSide(1), pickSide(-1)].filter(Boolean);
  if (!rings.length) return;
  // Attribute arrays to grow.
  const sem = p.listSemantics(), arrs = {}, sizes = {};
  for (const s of sem) { const a = p.getAttribute(s); arrs[s] = Array.from(a.getArray()); sizes[s] = a.getElementSize(); }
  let n = N;
  const addVert = (src, xyz, nrm) => {
    for (const s of sem) {
      const k = sizes[s];
      if (s === 'POSITION') arrs[s].push(...xyz);
      else if (s === 'NORMAL') arrs[s].push(...nrm);
      else if (s === 'JOINTS_0' || s === 'WEIGHTS_0') {
        // Rigid on the ring vertex's dominant bone: blending several bones far from the skinned surface stretches it.
        const W = arrs.WEIGHTS_0, J = arrs.JOINTS_0; let best = 0;
        for (let j = 1; j < 4; j++) if (W[src * 4 + j] > W[src * 4 + best]) best = j;
        if (s === 'JOINTS_0') arrs[s].push(J[src * 4 + best], 0, 0, 0); else arrs[s].push(1, 0, 0, 0);
      } else for (let j = 0; j < k; j++) arrs[s].push(arrs[s][src * k + j]);
    }
    return n++;
  };
  for (const ring of rings) {
    // Out of the opening along the sleeve: from the centroid of the nearby sleeve (it only lies on one side) through the
    // ring centre.
    const m = [0, 0, 0]; let cnt = 0;
    for (let i = 0; i < N; i++) {
      if (w[i] !== i) continue;
      const d = Math.hypot(P[i * 3] - ring.c[0], P[i * 3 + 1] - ring.c[1], P[i * 3 + 2] - ring.c[2]);
      if (d > ring.r * 1.05 && d < ring.r * 2.5) { m[0] += P[i * 3]; m[1] += P[i * 3 + 1]; m[2] += P[i * 3 + 2]; cnt++; }
    }
    if (!cnt) continue;
    const dl = Math.hypot(ring.c[0] - m[0] / cnt, ring.c[1] - m[1] / cnt, ring.c[2] - m[2] / cnt) || 1;
    const dir = [(ring.c[0] - m[0] / cnt) / dl, (ring.c[1] - m[1] / cnt) / dl, (ring.c[2] - m[2] / cnt) / dl];
    // Basis round the sleeve axis to order the ring by angle.
    const up = Math.abs(dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const ux = [dir[1] * up[2] - dir[2] * up[1], dir[2] * up[0] - dir[0] * up[2], dir[0] * up[1] - dir[1] * up[0]], ul = Math.hypot(...ux);
    const e1 = ux.map((v) => v / ul), e2 = [dir[1] * e1[2] - dir[2] * e1[1], dir[2] * e1[0] - dir[0] * e1[2], dir[0] * e1[1] - dir[1] * e1[0]];
    const ang = (i) => { const o = [P[i * 3] - ring.c[0], P[i * 3 + 1] - ring.c[1], P[i * 3 + 2] - ring.c[2]]; return Math.atan2(o[0] * e2[0] + o[1] * e2[1] + o[2] * e2[2], o[0] * e1[0] + o[1] * e1[1] + o[2] * e1[2]); };
    // Order the ring by angle round the arm axis (in the Y-Z plane).
    const ordered = [...ring.L].sort((a, b) => ang(a) - ang(b));
    // Winding: match the existing faces at the ring (outward normals) — test one edge's orientation in the mesh.
    let prev = ordered, steps = 3;
    for (let s = 1; s <= steps; s++) {
      const f = s / steps, taper = 1 - 0.15 * f;
      const cur = prev.map((v, i) => {
        const src = ordered[i], ox = P[src * 3] - ring.c[0], oy = P[src * 3 + 1] - ring.c[1], oz = P[src * 3 + 2] - ring.c[2];
        const xyz = [ring.c[0] + dir[0] * len * f + ox * taper, ring.c[1] + dir[1] * len * f + oy * taper, ring.c[2] + dir[2] * len * f + oz * taper];
        const along = ox * dir[0] + oy * dir[1] + oz * dir[2], rx = ox - dir[0] * along, ry = oy - dir[1] * along, rz = oz - dir[2] * along, nl = Math.hypot(rx, ry, rz) || 1;
        return addVert(src, xyz, [rx / nl, ry / nl, rz / nl]);
      });
      for (let i = 0; i < prev.length; i++) {
        const a = prev[i], b = prev[(i + 1) % prev.length], c = cur[(i + 1) % prev.length], d = cur[i];
        // Both windings: the sleeve is seen from outside and its inside may show at the cap edge.
        I.push(a, b, c, a, c, d, a, c, b, a, d, c);
      }
      prev = cur;
    }
    // Cap.
    const tip = [ring.c[0] + dir[0] * len, ring.c[1] + dir[1] * len, ring.c[2] + dir[2] * len];
    const ci = addVert(ordered[0], tip, dir);
    for (let i = 0; i < prev.length; i++) { const a = prev[i], b = prev[(i + 1) % prev.length]; I.push(a, b, ci, a, ci, b); }
  }
  for (const s of sem) {
    const a = p.getAttribute(s), T = a.getArray().constructor;
    a.setArray(new T(arrs[s]));
  }
  idxA.setArray(n > 65535 ? new Uint32Array(I) : new Uint16Array(I));
  console.log(`  sleeves: ${rings.length} rings extended by ${len}, ${n - N} vertices added`);
}

// Gaps in walls: from points inside each room (test area or a full-map rect), cast rays horizontally at several
// heights against the DRAWN city meshes. A ray that leaves the room's footprint without hitting anything drawn, and
// not through a known doorway or window, went through a hole. Reports clustered spots with building/room.
//   node scripts/wallholes.mjs [x0,z0,x1,z1]
import { launch } from './browser.mjs';
const rect = process.argv[2] ?? '';
const b = await launch();
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.goto(rect ? 'http://localhost:5173/?q=low&bots=0&shot=0,40,0,0,-89' : 'http://localhost:5173/?mode=test&q=low&bots=0&shot=0,40,0,0,-89');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 400000 });
const r = await p.evaluate((RECT) => {
  const T = window.__THREE, g = window.__game, city = window.__city, world = window.__world;
  const A = RECT ? { x0: RECT[0], z0: RECT[1], x1: RECT[2], z1: RECT[3] } : city.area;
  const meshes = [];
  world.root.traverse((o) => { if (o.isMesh && /^city:\d+:[012]$/.test(o.name)) { o.visible = true; meshes.push(o); } });
  g.gfx.scene.traverse((o) => { if (o.isMesh && /^door$/.test(o.name)) meshes.push(o); });
  for (const m of meshes) { const mats = Array.isArray(m.material) ? m.material : [m.material]; for (const x of mats) x.side = T.DoubleSide; m.updateMatrixWorld(true); }
  const rc = new T.Raycaster(); rc.firstHitOnly = true;
  const holes = new Map(); let rays = 0, rooms = 0;
  for (const B of city.buildings) {
    for (const rm of B.rooms) {
      const cx = (rm.x0 + rm.x1) / 2, cz = (rm.z0 + rm.z1) / 2;
      if (cx < A.x0 || cx > A.x1 || cz < A.z0 || cz > A.z1) continue;
      rooms++;
      const near = [...B.doorways, ...B.windows.map((w) => ({ x: w.x, z: w.z, y: w.y, w: 1.4, h: 1.6, win: true }))];
      for (const h of [0.3, 1.0, 1.7, 2.4]) for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2, d = new T.Vector3(Math.cos(a), 0, Math.sin(a));
        const o = new T.Vector3(cx + (Math.random() - 0.5) * (rm.x1 - rm.x0) * 0.5, rm.y + h, cz + (Math.random() - 0.5) * (rm.z1 - rm.z0) * 0.5);
        rc.set(o, d); rc.far = 40; rays++;
        const hit = rc.intersectObjects(meshes, false)[0];
        // distance to leave the room box along d
        const tx = d.x > 0 ? (rm.x1 - o.x) / d.x : d.x < 0 ? (rm.x0 - o.x) / d.x : 1e9, tz = d.z > 0 ? (rm.z1 - o.z) / d.z : d.z < 0 ? (rm.z0 - o.z) / d.z : 1e9;
        const tOut = Math.min(tx, tz);
        if (hit && hit.distance < tOut + 0.8) continue;
        const ex = o.clone().addScaledVector(d, tOut);
        const opening = near.some((q) => Math.hypot(q.x - ex.x, q.z - ex.z) < (q.w ?? 1) / 2 + 0.4 && ex.y >= q.y - 0.1 && ex.y <= q.y + (q.h ?? 2.2) + 0.3);
        if (opening) continue;
        const key = `${Math.round(ex.x)},${Math.round(ex.y)},${Math.round(ex.z)}`;
        const e = holes.get(key) ?? holes.set(key, { n: 0, at: [+ex.x.toFixed(1), +ex.y.toFixed(1), +ex.z.toFixed(1)], b: B.id, kind: rm.kind, floor: rm.floor, from: [+o.x.toFixed(1), +o.y.toFixed(1), +o.z.toFixed(1)], hit: hit ? +hit.distance.toFixed(1) : null }).get(key);
        e.n++;
      }
    }
  }
  return { rooms, rays, holes: [...holes.values()].sort((x, y) => y.n - x.n) };
}, rect ? rect.split(',').map(Number) : null);
console.log(`rooms ${r.rooms} rays ${r.rays} hole spots ${r.holes.length}`);
for (const h of r.holes.slice(0, 30)) console.log(JSON.stringify(h));
await b.close();

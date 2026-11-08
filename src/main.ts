// Boot: main menu → load the map → spawn screen → play. URL flags: ?q=low|medium|high, ?seed=N, ?fly (free camera),
// ?shot=x,y,z,yawDeg,pitchDeg (fixed camera for screenshots), ?auto=us|ins (skip the menus), ?bots=0.
import * as THREE from 'three';
import { createGfx, type Quality } from './core/gfx';
import { Input, BIND } from './core/input';
import { VehicleCrews } from './vehicles/crews';
import { SandboxMode, SandboxTools } from './game/sandbox';
import { VEHICLES } from './game/data/vehicles';
import { generateCity } from './world/citygen';
import { buildProps, buildWorld } from './world/render';
import { Physics } from './world/physics';
import { gltf } from './core/assets';
import { Game, loadCharAssets } from './game/game';
import { Insurgency } from './game/insurgency';
import { Player, setBaseFov, BASE_FOV } from './player/player';
import { Hud } from './ui/hud';
import { MapView, renderBaseMap } from './ui/map';
import { endScreen, mainMenu, scoreboard, SpawnScreen, type SpawnPoint } from './ui/menus';
import { Director } from './ai/director';
import { SkirmishDirector } from './ai/skirmish';
import { Skirmish } from './game/skirmish';
import type { GameMode } from './game/mode';
import { CoverIndex } from './ai/cover';
import { Doors } from './game/doors';
import type { Rect } from './world/citygen';
import { Nav, safeSpawn } from './ai/nav';
import { kitById, type Faction } from './game/data/kits';
import { AMMO, WEAPONS } from './game/data/weapons';
import type { Soldier } from './game/soldier';
import { groundH } from './world/terrain';
import { downloads, expectDownload, mb, trackDownloads } from './core/netprogress';
import { getLobby, newId, type LobbyInfo } from './net/signal';
import { HostSync, MAX_PLAYERS } from './net/host';
import { ClientMode, ClientSync } from './net/client';

// Count every byte the game downloads (the loading screen shows it), and start the big shared downloads at once, while
// the player is still in the main menu: characters, animations, weapons, the props kit and the navmesh.
trackDownloads();
expectDownload((new URLSearchParams(location.search).get('mode') === 'test' ? 103 : 133) * 1048576);
const early = {
  chars: loadCharAssets(),
  props: gltf('models/props.glb'),
  nav: (new URLSearchParams(location.search).get('mode') === 'test') ? null : fetch(`${import.meta.env.BASE_URL}nav/zahran-${Number(new URLSearchParams(location.search).get('seed') ?? 1337)}.bin`).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null),
};
void early;

const params = new URLSearchParams(location.search);
/** The default close-quarters test area: the Ruins plaza with the buildings around it (110 × 83 m). */
const TEST_AREA: Rect = { x0: -168, z0: 95, x1: -58, z1: 178 };
const host = document.getElementById('app')!;
const W = window as unknown as Record<string, unknown>;

/**
 * Loading screen: the stage, and the download itself (MB received of MB requested, speed, time left), refreshed four
 * times a second so a slow connection never looks frozen. The bar follows whichever is further on: the stages or the
 * bytes. A first visit downloads ~190 MB; the browser caches it for the next time.
 */
function loadingScreen() {
  document.getElementById('boot')?.remove();
  const el = document.createElement('div'); el.className = 'loading';
  el.innerHTML = `<div class="box"><h1>PROJECT REALISM</h1><div class="sub">INSURGENCY · AL ZAHRAN</div><div class="bar"><i></i></div><div class="msg"></div><div class="net"></div><div class="tip"></div></div>`;
  host.appendChild(el);
  const bar = el.querySelector('.bar > i') as HTMLElement, msg = el.querySelector('.msg')!, net = el.querySelector('.net')!, tip = el.querySelector('.tip')!;
  const TIPS = ['No crosshair: shoulder the weapon (right mouse) and use the sights.', 'Hold Shift while aiming to hold your breath.', 'Wounded? Press F to apply a field dressing before you bleed out.', 'F on a fallen soldier\'s weapon picks it up with his ammunition.', 'Rounds snapping past pin you down: get into cover before returning fire.', 'Crouch-walk to move quietly: enemies hear running footsteps.', 'M203: PgUp / PgDn set the quadrant sight range.', 'G deploys a bipod on the ground, a sill or a wall top.'];
  let stage = 0, ti = Math.floor(Math.random() * TIPS.length), tt = 0;
  tip.textContent = TIPS[ti];
  const tick = () => {
    const d = downloads();
    const f = Math.max(stage, d.total > 0 ? Math.min(0.97, d.got / d.total) * 0.9 : 0);
    bar.style.width = `${Math.round(f * 100)}%`;
    if (d.total > 0 && d.got < d.total - 1024) {
      const left = d.left !== null ? (d.left > 90 ? ` · about ${Math.ceil(d.left / 60)} min left` : ` · about ${Math.max(1, Math.round(d.left))} s left`) : '';
      net.textContent = `Downloading ${mb(d.got)} / ${mb(d.total)} MB · ${mb(d.rate)} MB/s${left}`;
    } else net.textContent = d.got > 0 ? `${mb(d.got)} MB loaded` : '';
    if ((tt += 0.25) > 7) { tt = 0; ti = (ti + 1) % TIPS.length; tip.textContent = TIPS[ti]; }
  };
  const iv = setInterval(tick, 250); tick();
  return { set: (f: number, m: string) => { stage = f; msg.textContent = m; tick(); }, done: () => { clearInterval(iv); el.remove(); } };
}
const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

function detectGpu(): string {
  try {
    const gl = document.createElement('canvas').getContext('webgl2'), dbg = gl?.getExtension('WEBGL_debug_renderer_info');
    const s = dbg ? String(gl!.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'unknown GPU';
    return s.replace(/^ANGLE \((.*)\)$/, '$1');
  } catch { return 'unknown GPU'; }
}

async function boot() {
  // The script is here: the static boot screen gives way to the menu, with the background download shown in a corner.
  document.getElementById('boot')?.remove();
  const bg = document.createElement('div'); bg.className = 'bgdl'; host.appendChild(bg);
  const bgIv = setInterval(() => { const d = downloads(); bg.textContent = d.total > 0 && d.got < d.total - 1024 ? `Downloading game data ${mb(d.got)} / ${mb(d.total)} MB` : ''; if (!bg.isConnected) clearInterval(bgIv); }, 300);
  const gpu = detectGpu();
  console.info('GPU:', gpu);
  const auto = params.get('auto') as Faction | null;
  const choice = auto || params.has('shot') || params.has('fly') ? { faction: (auto ?? 'us') as Faction, quality: (params.get('q') as Quality) ?? 'low', sens: 1, fov: Number(params.get('fov') ?? 55), mode: (params.has('mp') ? 'multiplayer' : params.get('mode') === 'test' ? 'test' : params.get('mode') === 'sandbox' ? 'sandbox' : 'insurgency') as 'test' | 'insurgency' | 'sandbox' | 'multiplayer', name: params.get('name') ?? 'Soldier' } : await mainMenu(host, gpu);
  // Multiplayer: the one online match. Join it if it is running and has room, otherwise host it (in this browser).
  const mp = choice.mode === 'multiplayer';
  /** Always-on server (scripts/dedicated.mjs): hosts the match with no player of its own and draws nothing. */
  const dedicated = params.get('mp') === 'dedicated';
  let mpRole: 'host' | 'client' | null = null, lobby: LobbyInfo | null = null;
  const myId = newId(), myName = (choice.name ?? 'Soldier').slice(0, 20);
  if (mp) {
    try { lobby = await getLobby(); } catch (e) { alert(`The multiplayer service is not reachable (${(e as Error).message}).`); location.reload(); return; }
    const want = params.get('mp');
    if (lobby.lobby && want !== 'host' && !dedicated) {
      if (lobby.lobby.players >= MAX_PLAYERS) { alert(`The match is full (${lobby.lobby.players} / ${MAX_PLAYERS} players). Try again later.`); location.reload(); return; }
      mpRole = 'client';
    } else if (want === 'join') { alert('No match is running yet: choose Multiplayer again to host one.'); location.reload(); return; }
    else mpRole = 'host';
  }
  const quality = choice.quality, seed = mpRole === 'client' && lobby?.lobby ? lobby.lobby.seed : Number(params.get('seed') ?? 1337);
  // Close-quarters test: only a small part of the map is built (default: the Ruins plaza), 3 v 3.
  const test = choice.mode === 'test';
  /** Sandbox: the whole map, no AI forces, targets and vehicles on demand (game/sandbox.ts). */
  const sandbox = choice.mode === 'sandbox';
  const areaArg = params.get('area')?.split(',').map(Number);
  const area: Rect | undefined = test ? (areaArg?.length === 4 ? { x0: areaArg[0], z0: areaArg[1], x1: areaArg[2], z1: areaArg[3] } : TEST_AREA) : undefined;
  bg.remove();
  expectDownload((test ? 103 : 133) * 1048576);
  const L0 = loadingScreen();
  // Heap at each loading stage (window.__mem, for profiling memory on the full map).
  const memLog: [string, number][] = []; (window as unknown as Record<string, unknown>).__mem = memLog;
  const L = { ...L0, set: (k: number, t: string) => { memLog.push([t, Math.round(((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1e6)]); L0.set(k, t); } };
  L.set(0.03, test ? 'Building the test area…' : 'Generating Al Zahran…'); await frame();
  const city = generateCity(seed, { area });
  L.set(0.3, `Building the world… (${gpu})`); await frame();
  const G = await createGfx(host, quality);
  const world = await buildWorld(city, quality);
  G.scene.add(world.root);
  L.set(0.5, 'Placing props…'); await frame();
  const propBoxes = await buildProps(city, world, quality !== 'low', quality, G.renderer);
  L.set(0.62, 'Physics…'); await frame();
  const P = await Physics.create();
  P.buildStatic(city, propBoxes);
  P.checkTerrain();
  L.set(0.72, 'Navigation, soldiers and weapons…'); await frame();
  const [nav, assets, cacheGltf] = await Promise.all([test ? Nav.generate(city, propBoxes) : Nav.load(seed, seed === 1337 ? early.nav : null), early.chars, early.props]);
  // Static colliders now live in the physics world (and the navmesh is built): drop the generator's copy.
  city.sink.colliders.length = 0;
  const game = new Game(G, P, city, world, assets, quality);
  game.cover = new CoverIndex(P, nav);
  // Doors in every house (instanced, grid-indexed: see game/doors.ts).
  game.doors = new Doors(P, G.scene, city, area);
  G.scene.add(G.camera);
  L.set(0.85, 'Sound…'); await frame();
  await game.audio.load();
  const input = new Input(G.renderer.domElement);
  input.sens = 0.0021 * choice.sens;
  setBaseFov(choice.fov);
  if (auto) input.locked = true; // test mode: no pointer lock in headless browsers
  const hud = new Hud(host); game.hud = hud;
  const baseMap = renderBaseMap(city);
  const mapView = new MapView(host, baseMap);
  const score = scoreboard(host);
  const clientMode = mpRole === 'client' ? new ClientMode(game) : null;
  const mode: GameMode = clientMode ?? (test ? new Skirmish(game, area!) : sandbox ? new SandboxMode(game, nav) : new Insurgency(game, city, seed, cacheGltf?.scene.getObjectByName('cache_crate') ?? null));
  game.mode = mode;
  // Armour: the FOB's motor pool (full map), or one vehicle beside the start zone for tests (?veh=m1a2 / m2a3).
  {
    const crews = new VehicleCrews(game, 'us');
    crews.sandbox = sandbox;
    const vq = params.get('veh');
    const list = test ? (vq ? vq.split(',').map((id, i) => { const z = (mode as Skirmish).zone('us'); return { id, x: z[0] + 14, z: z[2] + i * 9 - 4, ry: -Math.PI / 2 }; }) : []) : city.fob.vehicles.filter((v) => VEHICLES[v.id]);
    if (list.length) { L.set(0.84, 'Armour…'); await crews.load(list.map((v) => v.id)); for (const v of list) { if (mpRole === 'client') crews.addRemote(v.id, v.x, v.z, v.ry); else crews.add(v.id, v.x, v.z, v.ry); } }
    // (A multiplayer client's vehicles are the host's, posed by his snapshots: no crews or AI here.)
    if (mpRole !== 'client') game.crews = crews;
  }
  game.events.onDown = (v, by, killed) => {
    mode.onDown(v, by, killed);
    if (by?.isPlayer && v.team !== by.team) hud.flash(killed ? 'Enemy killed' : 'Enemy down');
    if (v.isPlayer && killed) mode.say(`You were killed${by && by !== v ? ` by ${by.name}` : ''}`);
  };
  game.events.onExplosion = (p, a, by) => mode.onExplosion(p, a.id, by);
  const full = test || sandbox || mpRole === 'client' ? null : new Director(game, city, mode as Insurgency, nav);
  const skirm = test ? new SkirmishDirector(game, mode as Skirmish, nav, params.has('shot') || params.has('fly') ? null : choice.faction) : null;
  const director = { update: (dt: number) => { if (full || skirm) (full ?? skirm)!.update(dt); }, setup: () => { if (full) full.setup(null); else if (skirm) skirm.startRound(); } };
  if (test) (mode as Skirmish).onRound = () => skirm!.startRound(); // the game section adds the player's respawn
  W.__game = game; W.__skirm = skirm; W.__G = G; W.__input = input; W.__WEAPONS = WEAPONS; W.__AMMO = AMMO; W.__nav = nav; W.__city = city; W.__world = world; W.__THREE = THREE; W.__fullDirector = full;
  L.done();

  // ---------- free camera / screenshot mode ----------
  if (params.has('shot') || params.has('fly')) {
    if (params.get('bots') !== '0') director.setup();
    const cam = G.camera, shot = params.get('shot')?.split(',').map(Number);
    let yaw = 0, pitch = 0;
    if (shot) { cam.position.set(shot[0], shot[1], shot[2]); yaw = shot[3] * Math.PI / 180; pitch = shot[4] * Math.PI / 180; } else cam.position.set(560, groundH(560, 0) + 1.7, 0);
    G.renderer.domElement.addEventListener('click', () => input.lock());
    let last = performance.now(), frames = 0, fpsT = last;
    const loop = () => {
      const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000); last = now; // real time down to 10 FPS
      if (++frames, now - fpsT > 2000) { W.__fps = `${Math.round(frames * 1000 / (now - fpsT))} calls=${G.renderer.info.render.calls} tris=${G.renderer.info.render.triangles}`; frames = 0; fpsT = now; }
      yaw -= input.mouse.dx * 0.002; pitch = Math.max(-1.5, Math.min(1.5, pitch - input.mouse.dy * 0.002));
      const sp = input.is('ShiftLeft') ? 60 : 12, f = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)), r = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
      if (input.is('KeyW')) cam.position.addScaledVector(f, sp * dt); if (input.is('KeyS')) cam.position.addScaledVector(f, -sp * dt);
      if (input.is('KeyD')) cam.position.addScaledVector(r, sp * dt); if (input.is('KeyA')) cam.position.addScaledVector(r, -sp * dt);
      if (input.is('KeyE')) cam.position.y += sp * dt; if (input.is('KeyQ')) cam.position.y -= sp * dt;
      if (!W.__hold) cam.rotation.set(pitch, yaw, 0, 'YXZ'); // __hold: a test script placed the camera
      if (params.get('bots') !== '0') director.update(dt);
      game.update(dt);
      mode.update(dt);
      // Debug: ?boom — an RPG warhead goes off 25 m in front of the camera after 3 s.
      if (params.has('boom') && game.time > 3 && !(W.__boomed as boolean)) {
        W.__boomed = true;
        const f = new THREE.Vector3(0, 0, -25).applyQuaternion(cam.quaternion); f.y = 0;
        const bx = cam.position.x + f.x, bz = cam.position.z + f.z;
        game.explode([bx, groundH(bx, bz) + 0.1, bz], AMMO.pg7vl, null, [0, 1, 0]);
      }
      const fi = params.get('follow');
      if (fi !== null) {
        // Debug: side view of soldier N (animation checks).
        const t = game.soldiers[Number(fi)];
        if (t && params.has('forceaim')) { t.lastShotT = game.time; t.ads = 1; }
        // Debug: wound (?hurt) or kill (?kill) the followed soldier after 4 s.
        if (t && game.time > 4 && t.state === 'alive' && (params.has('hurt') || params.has('kill'))) game.hitSoldier(t, t.eye, params.has('kill') ? 'head' : 'chest', { ...AMMO['762x39'], dmg: params.has('kill') ? 200 : 140 }, game.soldiers.find((o) => o.team !== t.team)!);
        if (t) { const side = Number(params.get('side') ?? 90) * Math.PI / 180, d = Number(params.get('dist') ?? 3.5); cam.position.set(t.pos[0] + Math.sin(t.yaw + side) * d, t.pos[1] + 1.3, t.pos[2] + Math.cos(t.yaw + side) * d); cam.lookAt(t.pos[0], t.pos[1] + 1.0, t.pos[2]); }
      }
      // Zoomed optics (tank sights, scopes) see far: detail distances scale with the magnification.
      world.update(cam.position, Math.max(1, BASE_FOV / cam.fov)); G.follow(cam.position); G.render(dt);
      input.endFrame();
      requestAnimationFrame(loop);
    };
    W.__ready = true;
    loop();
    return;
  }

  // ---------- the game ----------
  let faction = choice.faction;
  const noBots = params.has('nobots'); // screenshot tests: an empty test area
  if (!noBots) director.setup();
  const alpha = full?.squads[0];
  // Alpha keeps a free slot for the player: drop its rifleman bot.
  if (full && alpha && faction === 'us' && !dedicated) { const rb = alpha.members.find((m) => m.kit.id === 'us_rifle'); if (rb) { full.bots.delete(rb.id); alpha.members.splice(alpha.members.indexOf(rb), 1); game.remove(rb); } }
  const spawnPoints = (side: Faction = faction): SpawnPoint[] => {
    if (clientMode) {
      const pts = clientMode.spawns[side];
      if (pts?.length) return pts;
      const b = side === 'us' ? city.fob.spawns[0] : city.insBase.spawns[0];
      return [{ id: side === 'us' ? 'fob' : 'base', label: side === 'us' ? 'FOB Hammer' : 'Insurgent base', x: b[0], z: b[2], pos: b }];
    }
    if (sandbox) {
      // Named points (either side may use any); a click anywhere on the map spawns there too.
      const P0 = (id: string, label: string, x: number, z: number): SpawnPoint => ({ id, label, x, z, pos: [x, groundH(x, z) + 0.3, z] });
      return [{ id: 'fob', label: 'FOB Hammer (vehicles)', x: city.fob.spawns[0][0], z: city.fob.spawns[0][2], pos: city.fob.spawns[0] },
        { id: 'base', label: 'Insurgent base', x: city.insBase.spawns[0][0], z: city.insBase.spawns[0][2], pos: city.insBase.spawns[0] },
        P0('ridge', 'Ridge', 668, -40), P0('town', 'Town centre (boulevard)', 20, 20), P0('farms', 'Farms', 600, 300)];
    }
    if (test) { const z = (mode as Skirmish).zone(side); return [{ id: 'zone', label: 'Start zone', x: z[0], z: z[2], pos: z }]; }
    const ins = mode as Insurgency;
    if (side === 'us') {
      const pts: SpawnPoint[] = [{ id: 'fob', label: 'FOB Hammer', x: city.fob.spawns[0][0], z: city.fob.spawns[0][2], pos: city.fob.spawns[0] }];
      const sl = alpha?.leader;
      if (sl && sl.alive && !sl.isPlayer && !game.soldiers.some((s) => s.team === 'ins' && s.alive && Math.hypot(s.pos[0] - sl.pos[0], s.pos[2] - sl.pos[2]) < 50))
        pts.push({ id: 'rally', label: 'Rally point (SL)', x: sl.pos[0], z: sl.pos[2], pos: [sl.pos[0] - 1.5, sl.pos[1] + 0.2, sl.pos[2] + 1.5] });
      return pts;
    }
    const pts: SpawnPoint[] = ins.active.filter((c) => !c.found && !game.soldiers.some((s) => s.team === 'us' && s.alive && Math.hypot(s.pos[0] - c.pos[0], s.pos[2] - c.pos[2]) < 50)).map((c) => ({ id: `cache${c.id}`, label: 'Hideout', x: c.pos[0], z: c.pos[2], pos: [c.pos[0] + 1.5, c.pos[1] + 0.2, c.pos[2] + 1.5] }));
    pts.push({ id: 'base', label: 'Insurgent base', x: city.insBase.spawns[0][0], z: city.insBase.spawns[0][2], pos: city.insBase.spawns[0] });
    return pts;
  };
  const spawnScreen = new SpawnScreen(host, game, baseMap, faction, () => spawnPoints(), sandbox ? { both: true, anywhere: true, ground: (x, z) => { const h = P.castRay([x, 300, z], [0, -1, 0], 600); return h ? h.point[1] : groundH(x, z); } } : {});
  let player: Player | null = null, me: Soldier | null = null, deadT = 0, lastState = 'alive', lastKit = '';
  // Test mode: everybody (the player too) respawns together when a new round starts.
  if (test) (mode as Skirmish).onRound = () => {
    skirm!.startRound();
    // (A dead player choosing a kit on the spawn screen deploys from there.)
    if (me && lastKit && !spawnScreen.visible) {
      if (me.state !== 'dead') me.die(null);
      game.remove(me);
      me = game.spawn(kitById(lastKit), faction, safeSpawn(P, nav, (mode as Skirmish).spawnAt(faction, 0), 1.5), 'You', faction === 'us' ? -Math.PI / 2 : Math.PI / 2);
      me.isPlayer = true; player?.setSoldier(me); lastState = 'alive'; deadT = 0;
    }
  };

  // ---------- multiplayer ----------
  const status = document.createElement('div'); status.className = 'mpstatus'; if (mp) host.appendChild(status);
  let hostSync: HostSync | null = null, clientSync: ClientSync | null = null;
  if (mpRole === 'host') {
    const takeBot = (side: Faction): boolean => {
      if (!full) return false;
      const groups = (side === 'us' ? full.squads : full.cells) as { members: Soldier[]; leader?: Soldier | null }[];
      for (const grp of groups) {
        const m = grp.members.find((x) => !x.isPlayer && !x.netProxy && x.alive && x !== grp.leader);
        if (m) { full.bots.delete(m.id); grp.members.splice(grp.members.indexOf(m), 1); game.remove(m); return true; }
      }
      return false;
    };
    hostSync = new HostSync({ game, mode, seed, myId, myName: dedicated ? (params.get('name') ?? 'Server') : myName, ice: lobby?.ice ?? [], spawnPoints: (side) => spawnPoints(side), takeBot, dedicated, key: params.get('key') ?? undefined });
  } else if (mpRole === 'client' && lobby?.lobby) {
    // Losing the host (a round restart on the server, his tab closed): rejoin the match by itself, same name, side and kit.
    const rejoin = () => { const q = new URLSearchParams({ mp: 'join', auto: faction, kit: lastKit || (faction === 'us' ? 'us_rifle' : 'ins_rifle'), name: myName, q: quality, fov: String(choice.fov) }); location.href = `${location.pathname}?${q}`; };
    clientSync = new ClientSync({ game, mode: clientMode!, myId, myName, side: faction, hostId: lobby.lobby.hostId, ice: lobby.ice, me: () => me, onLost: (why) => { mode.say(why); status.textContent = `OFFLINE — ${why} · rejoining…`; setTimeout(rejoin, 8000); } });
    const wait = document.createElement('div'); wait.className = 'loading'; wait.innerHTML = `<div class="box"><h1>PROJECT REALISM</h1><div class="sub">Connecting to ${lobby.lobby.hostName}'s match…</div></div>`; host.appendChild(wait);
    try { await clientSync.connect(); } catch (e) { wait.remove(); alert(`Could not join the match: ${(e as Error).message}`); location.reload(); return; }
    wait.remove();
  }
  W.__net = { role: mpRole, host: () => hostSync, client: () => clientSync, id: myId, dedicated };
  if (dedicated && hostSync) {
    // ---------- dedicated server: run the match on a fixed clock, draw nothing ----------
    const hs = hostSync;
    hud.el.style.display = 'none'; spawnScreen.hide?.();
    let last = performance.now(), frames = 0, fpsT = last, overT = 0;
    const tick = () => {
      const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000); last = now;
      if (++frames, now - fpsT > 2000) { W.__fps = String(Math.round(frames * 1000 / (now - fpsT))); frames = 0; fpsT = now; }
      director.update(dt); game.update(dt); mode.update(dt); hs.update(dt);
      // Round over: everyone sees the result; 30 s later a new round (the page reloads; players rejoin by themselves).
      if (mode.over && (overT += dt) > 30) location.reload();
    };
    setInterval(tick, 1000 / 60);
    W.__status = () => ({ players: hs.players, holding: hs.holding, fps: Number(W.__fps ?? 0), upKBs: Math.round(hs.rate / 1024), peers: hs.peerList(), over: mode.over, top: mode.hudTop().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), soldiers: game.soldiers.length });
    W.__ready = true;
    status.textContent = 'DEDICATED SERVER';
    return;
  }

  const tools = sandbox ? new SandboxTools(host, game, mode as SandboxMode, input, () => me, () => { input.unlock(); void deploy(0); }) : null;
  W.__tools = tools;
  let autoDeploy = !!auto;
  const deploy = async (wait: number) => {
    const { kit, spawn, faction: side } = autoDeploy ? { kit: kitById(params.get('kit') ?? (faction === 'us' ? 'us_rifle' : 'ins_rifle')), spawn: spawnPoints()[0], faction } : await spawnScreen.show(wait);
    faction = side; // the sandbox lets the side change at every spawn
    autoDeploy = false;
    if (me) { if (me.state !== 'dead') me.die(null); game.remove(me); }
    // Face the enemy: on the full map the US starts in the east (face west); in the test area US starts in the west.
    const facing = test ? (faction === 'us' ? -Math.PI / 2 : Math.PI / 2) : faction === 'us' ? Math.PI / 2 : -Math.PI / 2;
    me = game.spawn(kitById(kit.id), faction, safeSpawn(P, nav, spawn.pos, test ? 1.5 : 4), mp ? myName : faction === 'us' ? 'You (Alpha)' : 'You', facing);
    me.isPlayer = true;
    if (full && alpha && faction === 'us') { me.squad = 1; alpha.members.push(me); if (me.kit.leader) alpha.leader = me; }
    else if (full && faction === 'ins' && full.cells[0]) { const c = full.cells[0]; c.members.push(me); me.squad = 100; }
    lastKit = kit.id;
    if (clientSync) clientSync.spawned(me, kit.id, faction);
    if (!player) { player = new Player(game, me, input); game.player = player; } else player.setSoldier(me);
    lastState = 'alive'; deadT = 0;
    if (params.has('yaw')) me.yaw = Number(params.get('yaw')) * Math.PI / 180;
    input.lock(); game.audio.resume();
  };
  G.renderer.domElement.addEventListener('click', () => { if (!spawnScreen.visible && !mode.over && !tools?.open) { input.lock(); game.audio.resume(); } });
  const pause = document.createElement('div'); pause.className = 'pause'; pause.innerHTML = '<div><h2>PAUSED</h2><p>Click to resume</p></div>'; host.appendChild(pause);
  pause.addEventListener('click', () => { input.lock(); game.audio.resume(); });
  if (faction === 'us') game.audio.ambience('amb_city_wind', 0.35); else game.audio.ambience('amb_city_wind', 0.35);
  game.audio.ambience('amb_distant_battle', 0.15);
  void deploy(0);

  let last = performance.now(), frames = 0, fpsT = last, ended = false;
  const prof: Record<string, number> = {};
  const loop = () => {
    const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000); last = now; // real time down to 10 FPS
    if (++frames, now - fpsT > 2000) { W.__fps = `${Math.round(frames * 1000 / (now - fpsT))} calls=${G.renderer.info.render.calls} tris=${G.renderer.info.render.triangles}`; frames = 0; fpsT = now; }
    // Dead, the game runs on (the mouse is free and the spawn screen comes up), it is never "paused".
    const paused = (!auto && !input.locked && !spawnScreen.visible && !mode.over && !!me && me.state !== 'dead') || !!tools?.open;
    pause.style.display = paused && !mapView.open && !tools?.open ? 'grid' : 'none';
    const T: Record<string, number> = {}; let t0 = performance.now();
    const lap = (k: string) => { const t = performance.now(); T[k] = (T[k] ?? 0) + t - t0; t0 = t; };
    if (!paused || mapView.open) {
      if (player && me) {
        player.update(dt);
        if (params.has('vmlog')) {
          // Debug: per-frame viewmodel / aim state (looking for single-frame flips).
          const log = (W.__vmlog ??= []) as unknown[];
          const rig = game.rigs.get(me.id), vmPos = player.vm.group.children.find((c) => c.name !== '')?.position;
          log.push([+me.ads.toFixed(2), me.aiming, me.sprinting, +me.switchT.toFixed(2), +player.zoom.toFixed(2), player.vm.group.visible, rig?.root.visible, rig?.weapon?.visible, me.cur, vmPos ? vmPos.toArray().map((v) => +v.toFixed(2)).join(',') : '', game.soldiers.filter((o) => o.isPlayer).length]);
          if (log.length > 600) log.shift();
        }
        if (me.state === 'wounded' && input.hit(BIND.giveUp)) me.die(me.killedBy);
        if (me.state === 'dead' && lastState !== 'dead') { mode.onDown(me, me.killedBy, true); deadT = 0; }
        lastState = me.state;
        // Killed: after a few seconds the spawn screen opens (kit and spawn point), with the respawn delay counting down.
        if (me.state === 'dead') { deadT += dt; if (deadT > (sandbox ? 2 : 4) && !spawnScreen.visible) { input.unlock(); void deploy(sandbox ? 0 : test ? 4 : 12); } }
        if (input.hit(BIND.map)) mapView.toggle();
        score.show(game, input.is(BIND.score));
      }
      lap('player');
      if (!noBots) director.update(dt);
      lap('ai');
      clientSync?.update(dt);
      game.update(dt); lap('game');
      mode.update(dt);
      hostSync?.update(dt); lap('net');
    }
    const cp = G.camera.position;
    if (spawnScreen.visible) {
      // Overview camera behind the spawn screen.
      if (area) { cp.set(area.x0 - 25, 45, (area.z0 + area.z1) / 2 + 40); G.camera.lookAt((area.x0 + area.x1) / 2, 0, (area.z0 + area.z1) / 2); }
      else { cp.set(200, 180, 420); G.camera.lookAt(-80, 0, -60); }
      G.camera.fov = 60; G.camera.updateProjectionMatrix();
    }
    world.update(cp, Math.max(1, BASE_FOV / G.camera.fov)); G.follow(cp); // zoomed optics: detail distances scale
    if (player && me && !spawnScreen.visible) hud.update(dt, game, player);
    hud.el.style.display = spawnScreen.visible ? 'none' : 'block';
    mapView.update(game, me!);
    spawnScreen.update(me);
    lap('ui');
    G.render(dt); lap('render');
    for (const k in T) prof[k] = (prof[k] ?? 0) * 0.95 + T[k] * 0.05;
    W.__prof = Object.entries(prof).map(([k, v]) => `${k}=${v.toFixed(1)}`).join(' ');
    if (mp && frames === 0) {
      // Multiplayer status: players and the host's upload (the limit for a 30-player match); a joiner's ping.
      if (hostSync) { const up = hostSync.rate / 1024, fps = String(W.__fps ?? '').split(' ')[0]; status.textContent = `HOSTING · ${hostSync.players} / ${MAX_PLAYERS} players · upload ${up.toFixed(0)} KB/s · ${fps} FPS${Number(fps) && Number(fps) < 30 ? ' · YOUR PC IS STRUGGLING' : ''}`; }
      else if (clientSync) status.textContent = clientSync.connected ? `ONLINE · ping ${Math.round(clientSync.rtt)} ms` : status.textContent;
    }
    input.endFrame();
    if (mode.over && !ended) { ended = true; input.unlock(); setTimeout(() => endScreen(host, mode.over!, faction), 2500); }
    requestAnimationFrame(loop);
  };
  W.__ready = true;
  loop();
}
boot();

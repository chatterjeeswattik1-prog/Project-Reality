// Boot: main menu → load the map → spawn screen → play. URL flags: ?q=low|medium|high, ?seed=N, ?fly (free camera),
// ?shot=x,y,z,yawDeg,pitchDeg (fixed camera for screenshots), ?auto=us|ins (skip the menus), ?bots=0.
import * as THREE from 'three';
import { createGfx, type Quality } from './core/gfx';
import { Input, BIND } from './core/input';
import { generateCity } from './world/citygen';
import { buildProps, buildWorld } from './world/render';
import { Physics } from './world/physics';
import { gltf } from './core/assets';
import { Game, loadCharAssets } from './game/game';
import { Insurgency } from './game/insurgency';
import { Player, setBaseFov } from './player/player';
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
import { AMMO } from './game/data/weapons';
import type { Soldier } from './game/soldier';
import { groundH } from './world/terrain';

const params = new URLSearchParams(location.search);
/** The default close-quarters test area: the Ruins plaza with the buildings around it (110 × 83 m). */
const TEST_AREA: Rect = { x0: -168, z0: 95, x1: -58, z1: 178 };
const host = document.getElementById('app')!;
const W = window as unknown as Record<string, unknown>;

function loadingScreen() {
  const el = document.createElement('div'); el.className = 'loading';
  el.innerHTML = `<div class="box"><h1>PROJECT REALISM</h1><div class="sub">INSURGENCY · AL ZAHRAN</div><div class="bar"><i></i></div><div class="msg"></div></div>`;
  host.appendChild(el);
  return { set: (f: number, msg: string) => { (el.querySelector('.bar > i') as HTMLElement).style.width = `${Math.round(f * 100)}%`; el.querySelector('.msg')!.textContent = msg; }, done: () => el.remove() };
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
  const gpu = detectGpu();
  console.info('GPU:', gpu);
  const auto = params.get('auto') as Faction | null;
  const choice = auto || params.has('shot') || params.has('fly') ? { faction: (auto ?? 'us') as Faction, quality: (params.get('q') as Quality) ?? 'low', sens: 1, fov: Number(params.get('fov') ?? 55), mode: (params.get('mode') === 'test' ? 'test' : 'insurgency') as 'test' | 'insurgency' } : await mainMenu(host, gpu);
  const quality = choice.quality, seed = Number(params.get('seed') ?? 1337);
  // Close-quarters test: only a small part of the map is built (default: the Ruins plaza), 3 v 3.
  const test = choice.mode === 'test';
  const areaArg = params.get('area')?.split(',').map(Number);
  const area: Rect | undefined = test ? (areaArg?.length === 4 ? { x0: areaArg[0], z0: areaArg[1], x1: areaArg[2], z1: areaArg[3] } : TEST_AREA) : undefined;
  const L = loadingScreen();
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
  const [nav, assets, cacheGltf] = await Promise.all([test ? Nav.generate(city, propBoxes) : Nav.load(seed), loadCharAssets(), gltf('models/props.glb')]);
  const game = new Game(G, P, city, world, assets, quality);
  game.cover = new CoverIndex(P, nav);
  // Doors (test area for now: thousands on the full map would need streaming).
  if (test) game.doors = new Doors(P, G.scene, city, area);
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
  const mode: GameMode = test ? new Skirmish(game, area!) : new Insurgency(game, city, seed, cacheGltf?.scene.getObjectByName('cache_crate') ?? null);
  game.mode = mode;
  game.events.onDown = (v, by, killed) => {
    mode.onDown(v, by, killed);
    if (by?.isPlayer && v.team !== by.team) hud.flash(killed ? 'Enemy killed' : 'Enemy down');
    if (v.isPlayer && killed) mode.say(`You were killed${by && by !== v ? ` by ${by.name}` : ''}`);
  };
  game.events.onExplosion = (p, a, by) => mode.onExplosion(p, a.id, by);
  const full = test ? null : new Director(game, city, mode as Insurgency, nav);
  const skirm = test ? new SkirmishDirector(game, mode as Skirmish, nav, params.has('shot') || params.has('fly') ? null : choice.faction) : null;
  const director = { update: (dt: number) => (full ?? skirm)!.update(dt), setup: () => (full ? full.setup(null) : skirm!.startRound()) };
  if (test) (mode as Skirmish).onRound = () => skirm!.startRound(); // the game section adds the player's respawn
  W.__game = game; W.__skirm = skirm; W.__G = G; W.__input = input;
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
      world.update(cam.position); G.follow(cam.position); G.render(dt);
      input.endFrame();
      requestAnimationFrame(loop);
    };
    W.__ready = true;
    loop();
    return;
  }

  // ---------- the game ----------
  const faction = choice.faction;
  const noBots = params.has('nobots'); // screenshot tests: an empty test area
  if (!noBots) director.setup();
  const alpha = full?.squads[0];
  // Alpha keeps a free slot for the player: drop its rifleman bot.
  if (full && alpha && faction === 'us') { const rb = alpha.members.find((m) => m.kit.id === 'us_rifle'); if (rb) { full.bots.delete(rb.id); alpha.members.splice(alpha.members.indexOf(rb), 1); game.remove(rb); } }
  const spawnPoints = (): SpawnPoint[] => {
    if (test) { const z = (mode as Skirmish).zone(faction); return [{ id: 'zone', label: 'Start zone', x: z[0], z: z[2], pos: z }]; }
    const ins = mode as Insurgency;
    if (faction === 'us') {
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
  const spawnScreen = new SpawnScreen(host, game, baseMap, faction, spawnPoints);
  let player: Player | null = null, me: Soldier | null = null, deadT = 0, lastState = 'alive', lastKit = '';
  // Test mode: everybody (the player too) respawns together when a new round starts.
  if (test) (mode as Skirmish).onRound = () => {
    skirm!.startRound();
    if (me && lastKit) {
      if (me.state !== 'dead') me.die(null);
      game.remove(me);
      me = game.spawn(kitById(lastKit), faction, safeSpawn(P, nav, (mode as Skirmish).spawnAt(faction, 0), 1.5), 'You', faction === 'us' ? -Math.PI / 2 : Math.PI / 2);
      me.isPlayer = true; player?.setSoldier(me); lastState = 'alive'; deadT = 0;
    }
  };

  let autoDeploy = !!auto;
  const deploy = async (wait: number) => {
    const { kit, spawn } = autoDeploy ? { kit: kitById(params.get('kit') ?? (faction === 'us' ? 'us_rifle' : 'ins_rifle')), spawn: spawnPoints()[0] } : await spawnScreen.show(wait);
    autoDeploy = false;
    if (me) { if (me.state !== 'dead') me.die(null); game.remove(me); }
    // Face the enemy: on the full map the US starts in the east (face west); in the test area US starts in the west.
    const facing = test ? (faction === 'us' ? -Math.PI / 2 : Math.PI / 2) : faction === 'us' ? Math.PI / 2 : -Math.PI / 2;
    me = game.spawn(kitById(kit.id), faction, safeSpawn(P, nav, spawn.pos, test ? 1.5 : 4), faction === 'us' ? 'You (Alpha)' : 'You', facing);
    me.isPlayer = true;
    if (full && alpha && faction === 'us') { me.squad = 1; alpha.members.push(me); if (me.kit.leader) alpha.leader = me; }
    else if (full) { const c = full.cells[0]; c.members.push(me); me.squad = 100; }
    lastKit = kit.id;
    if (!player) { player = new Player(game, me, input); game.player = player; } else player.setSoldier(me);
    lastState = 'alive'; deadT = 0;
    if (params.has('yaw')) me.yaw = Number(params.get('yaw')) * Math.PI / 180;
    input.lock(); game.audio.resume();
  };
  G.renderer.domElement.addEventListener('click', () => { if (!spawnScreen.visible && !mode.over) { input.lock(); game.audio.resume(); } });
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
    const paused = !auto && !input.locked && !spawnScreen.visible && !mode.over && !!me;
    pause.style.display = paused && !mapView.open ? 'grid' : 'none';
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
        if (me.state === 'dead' && !test) { deadT += dt; if (deadT > 4 && !spawnScreen.visible) { input.unlock(); void deploy(12); } }
        if (input.hit(BIND.map)) mapView.toggle();
        score.show(game, input.is(BIND.score));
      }
      lap('player');
      if (!noBots) director.update(dt);
      lap('ai');
      game.update(dt); lap('game');
      mode.update(dt);
    }
    const cp = G.camera.position;
    if (spawnScreen.visible) {
      // Overview camera behind the spawn screen.
      if (area) { cp.set(area.x0 - 25, 45, (area.z0 + area.z1) / 2 + 40); G.camera.lookAt((area.x0 + area.x1) / 2, 0, (area.z0 + area.z1) / 2); }
      else { cp.set(200, 180, 420); G.camera.lookAt(-80, 0, -60); }
      G.camera.fov = 60; G.camera.updateProjectionMatrix();
    }
    world.update(cp); G.follow(cp);
    if (player && me && !spawnScreen.visible) hud.update(dt, game, player);
    hud.el.style.display = spawnScreen.visible ? 'none' : 'block';
    mapView.update(game, me!);
    spawnScreen.update(me);
    lap('ui');
    G.render(dt); lap('render');
    for (const k in T) prof[k] = (prof[k] ?? 0) * 0.95 + T[k] * 0.05;
    W.__prof = Object.entries(prof).map(([k, v]) => `${k}=${v.toFixed(1)}`).join(' ');
    input.endFrame();
    if (mode.over && !ended) { ended = true; input.unlock(); setTimeout(() => endScreen(host, mode.over!, faction), 2500); }
    requestAnimationFrame(loop);
  };
  W.__ready = true;
  loop();
}
boot();

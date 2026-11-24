// main.js — bootstrap, game loop, input and screen state machine for CAYO VERDE.
//
// Heading convention: forward = (sin(heading), 0, cos(heading)); heading 0
// faces +Z. All gameplay modules share the state object G (window.__game).
// Modules are imported statically; each update call is guarded so a module
// that has no update (or no init) simply does nothing.

import { CFG } from './config.js';
import * as city from './city.js';
import * as player from './player.js';
import * as vehicles from './vehicles.js';
import * as pedestrians from './pedestrians.js';
import * as police from './police.js';
import * as combat from './combat.js';
import * as missions from './missions.js';
import * as hud from './hud.js';
import * as audio from './audio.js';
import * as save from './save.js';
import * as shots from './shots.js';

const params = new URLSearchParams(window.location.search);

// ?seed= overrides the world seed before the city is built.
const seedParam = Number.parseInt(params.get('seed') ?? '', 10);
if (Number.isInteger(seedParam)) CFG.SEED = seedParam;
const shotName = params.get('shot');

// ---------- renderer / scene / camera ----------
const container = document.getElementById('game-container');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
scene.fog = new THREE.Fog(0x87ceeb, 220, 750);

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  1200
);
camera.position.set(0, 10, -14);
camera.lookAt(0, 1, 0);

// Warm tropical sun + sky bounce.
const sun = new THREE.DirectionalLight(0xffe8c0, 1.25);
sun.position.set(120, 180, 60);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -280;
sun.shadow.camera.right = 280;
sun.shadow.camera.top = 280;
sun.shadow.camera.bottom = -280;
sun.shadow.camera.near = 10;
sun.shadow.camera.far = 600;
sun.shadow.bias = -0.0005;
scene.add(sun);
scene.add(new THREE.HemisphereLight(0xbfd9ff, 0x8a7a5a, 0.75));

// ---------- shared state ----------
const G = {
  scene,
  camera,
  renderer,
  input: { keys: new Set(), mouseDX: 0, mouseDY: 0, mouseDown: false },
  player: {
    mesh: null,
    pos: new THREE.Vector3(0, 0, 0),
    heading: 0,
    speed: 0,
    onFoot: true,
    car: null,
    health: 100,
    alive: true,
  },
  wanted: 0,
  money: 250,
  time: 0,
  state: 'title', // 'title' | 'play' | 'over'
  paused: false,
  city: null,
  vehicles: { list: [] },
  peds: { list: [] },
  police: { cops: [] },
  missions: { current: -1, list: [], objective: '' },
  hud: null,
  audio: null,
  save: null,
};
G.hud = hud;
G.audio = audio;
G.save = save;
window.__game = G;

// ---------- module init (city first: others query its collision) ----------
city.init(G);
player.init?.(G);
vehicles.init?.(G);
pedestrians.init?.(G);
police.init?.(G);
combat.init?.(G);
missions.init?.(G);
hud.init?.(G);
save.init?.(G);
// audio.init is deferred to the first user gesture (Start / Continue click).

// ---------- screens ----------
const $ = (id) => document.getElementById(id);
const screens = {
  hud: $('hud'),
  start: $('start-screen'),
  pause: $('pause-screen'),
  over: $('gameover-screen'),
  mission: $('mission-card'),
};

function show(el) {
  if (el) el.classList.remove('hidden');
}
function hide(el) {
  if (el) el.classList.add('hidden');
}

let audioStarted = false;
function ensureAudio() {
  if (!audioStarted) {
    audioStarted = true;
    audio.init?.(G);
  }
  // unlock() creates/resumes the AudioContext; it is idempotent and must
  // run inside a user gesture, so it is called on every gesture entry point.
  audio.unlock?.();
}

function lockPointer() {
  const el = renderer.domElement;
  if (document.pointerLockElement !== el && el.requestPointerLock) {
    try {
      const p = el.requestPointerLock();
      if (p && p.catch) p.catch(() => {});
    } catch {
      // Pointer lock is best-effort (e.g. iframes); the game still plays.
    }
  }
}

function startGame(useSave) {
  if (useSave) {
    try {
      // save.load() returns the snapshot (or null); apply it here.
      const data = save.load?.();
      if (data) {
        if (typeof data.money === 'number') G.money = data.money;
        if (typeof data.wanted === 'number') G.wanted = data.wanted;
        if (typeof data.time === 'number') G.time = data.time;
        if (data.playerPos && typeof data.playerPos.x === 'number') {
          G.player.pos.set(data.playerPos.x, 0, data.playerPos.z || 0);
          if (G.player.mesh) G.player.mesh.position.copy(G.player.pos);
        }
        // Completed missions are restored by missions.init at boot.
      }
    } catch (e) {
      console.warn('Save load failed, starting fresh:', e);
    }
  }
  if (!useSave) {
    // Fresh run: drop any mission progress restored from the save at boot.
    missions.reset?.(G);
  }
  ensureAudio();
  G.state = 'play';
  G.paused = false;
  hide(screens.start);
  hide(screens.pause);
  hide(screens.over);
  show(screens.hud);
  lockPointer();
}

function pauseGame() {
  if (G.state !== 'play' || G.paused) return;
  G.paused = true;
  show(screens.pause);
  if (document.exitPointerLock) document.exitPointerLock();
}

function resumeGame() {
  if (!G.paused) return;
  G.paused = false;
  hide(screens.pause);
  ensureAudio();
  lockPointer();
}

function gameOver() {
  G.state = 'over';
  G.paused = false;
  hide(screens.hud);
  hide(screens.pause);
  show(screens.over);
  if (document.exitPointerLock) document.exitPointerLock();
  try {
    save.clear?.(G);
  } catch {
    // Non-fatal: a failed save clear must not break the game-over screen.
  }
}

function retryGame() {
  const spawn = (G.city && G.city.spawn) || { x: 0, z: 0 };
  G.player.health = 100;
  G.player.alive = true;
  G.player.pos.set(spawn.x, 0, spawn.z);
  G.player.heading = 0;
  G.player.speed = 0;
  G.player.onFoot = true;
  G.player.car = null;
  if (G.player.mesh) {
    G.player.mesh.position.copy(G.player.pos);
    G.player.mesh.rotation.y = 0;
  }
  G.wanted = 0;
  missions.reset?.(G);
  police.reset?.(G);
  ensureAudio();
  G.state = 'play';
  G.paused = false;
  hide(screens.over);
  show(screens.hud);
  lockPointer();
}

// ---------- input ----------
window.addEventListener('keydown', (e) => {
  G.input.keys.add(e.code);
  if (e.code === 'Escape' || e.code === 'KeyP') {
    if (G.state === 'play') {
      if (G.paused) resumeGame();
      else pauseGame();
    }
  }
});
window.addEventListener('keyup', (e) => {
  G.input.keys.delete(e.code);
});
window.addEventListener('blur', () => {
  G.input.keys.clear();
  G.input.mouseDown = false;
});
document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === renderer.domElement) {
    G.input.mouseDX += e.movementX || 0;
    G.input.mouseDY += e.movementY || 0;
  }
});
document.addEventListener('mousedown', (e) => {
  if (e.button === 0) G.input.mouseDown = true;
});
document.addEventListener('mouseup', (e) => {
  if (e.button === 0) G.input.mouseDown = false;
});
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
renderer.domElement.addEventListener('click', () => {
  if (G.state === 'play' && !G.paused) lockPointer();
});
// Esc exits pointer lock without a keydown reaching us: treat losing the
// lock mid-game as a pause.
document.addEventListener('pointerlockchange', () => {
  if (
    document.pointerLockElement !== renderer.domElement &&
    G.state === 'play' &&
    !G.paused
  ) {
    pauseGame();
  }
});

// ---------- buttons ----------
$('btn-start')?.addEventListener('click', () => startGame(false));
$('btn-continue')?.addEventListener('click', () => startGame(true));
$('btn-resume')?.addEventListener('click', resumeGame);
$('btn-restart')?.addEventListener('click', () => window.location.reload());
$('btn-retry')?.addEventListener('click', retryGame);
let muted = false;
$('btn-mute')?.addEventListener('click', (e) => {
  muted = !muted;
  if (typeof audio.setMuted === 'function') audio.setMuted(muted);
  else if (typeof audio.toggleMute === 'function') audio.toggleMute();
  e.currentTarget.textContent = muted ? 'UNMUTE' : 'MUTE';
});

// Continue only makes sense when a save exists; hide it otherwise.
try {
  if (typeof save.hasSave === 'function' && !save.hasSave()) {
    hide($('btn-continue'));
  }
} catch {
  // If the check fails, leave the button visible.
}

// ---------- resize ----------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- shot mode: skip the title, stage the scene, play ----------
// (No pointer lock: shots are driven headlessly.)
if (shotName) {
  hide(screens.start);
  show(screens.hud);
  try {
    shots.stageShot?.(shotName, G);
  } catch (e) {
    console.warn('stageShot failed:', e);
  }
  G.state = 'play';
}

// ---------- main loop ----------
const clock = new THREE.Clock();

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);

  if (G.state === 'play' && !G.paused) {
    G.time += dt;
    city.update?.(G, dt);
    player.update?.(G, dt);
    vehicles.update?.(G, dt);
    pedestrians.update?.(G, dt);
    police.update?.(G, dt);
    combat.update?.(G, dt);
    missions.update?.(G, dt);
    hud.update?.(G, dt);
    audio.update?.(G, dt);

    if (G.player.health <= 0 && G.player.alive) {
      G.player.alive = false;
      gameOver();
    }
  }

  // Mouse deltas are consumed once per frame by whoever reads them.
  G.input.mouseDX = 0;
  G.input.mouseDY = 0;

  renderer.render(scene, camera);
}

requestAnimationFrame(frame);

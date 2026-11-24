// CAYO VERDE — player.js
// On-foot controller, third-person camera, character mesh and enter/exit car
// for the gta6-01 v2 entry. All geometry is procedural; no network, no assets.
//
// Shared contract: three.js is the global THREE (UMD build, loaded before
// this module). G carries scene, camera, input, player, city, vehicles,
// police, hud and audio. Heading convention: forward = (sin(h), 0, cos(h)).
// Ground is y=0; G.player.pos is the feet position.

import { clamp } from './utils.js';
import { nearestCar } from './vehicles.js';

const WALK_SPEED = 5;
const SPRINT_SPEED = 9;
const JUMP_VY = 8;
const GRAVITY = 22;
const PLAYER_RADIUS = 0.6;
const BOUND_X = 300;
const BOUND_Z = 250;
const MOUSE_SENS = 0.0025;
const ENTER_DIST = 4;

let prevE = false; // edge detection for KeyE (keys is a held-set, not events)
let walkPhase = 0;
let limbs = null; // { legL, legR, armL, armR } pivots for the walk cycle
let camInit = false;

function angleDiff(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
function lerpAngle(a, b, t) { return a + angleDiff(a, b) * t; }

function hitsWall(G, x, z) {
  return !!(G.city && G.city.collideCircle && G.city.collideCircle(x, z, PLAYER_RADIUS));
}

// Stylised person: bright coral shirt, teal cap, dark trousers. Limb pivots
// sit at the shoulder/hip so the walk cycle can swing them.
function buildCharacterMesh() {
  const group = new THREE.Group();
  const shirt = new THREE.MeshStandardMaterial({ color: 0xff6b4a, roughness: 0.7 });
  const pants = new THREE.MeshStandardMaterial({ color: 0x2b3a55, roughness: 0.8 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xe8b98a, roughness: 0.6 });
  const capMat = new THREE.MeshStandardMaterial({ color: 0x14b8a6, roughness: 0.6 });
  const shoe = new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.9 });

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.72, 0.34), shirt);
  torso.position.y = 1.12;
  group.add(torso);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.27, 16, 12), skin);
  head.position.y = 1.78;
  group.add(head);
  const cap = new THREE.Mesh(
    new THREE.SphereGeometry(0.29, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2),
    capMat,
  );
  cap.position.y = 1.82;
  group.add(cap);
  const brim = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.04, 0.24), capMat);
  brim.position.set(0, 1.86, 0.26);
  group.add(brim);

  function limb(w, h, d, mat, x, y) {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, 0);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.y = -h / 2;
    pivot.add(mesh);
    group.add(pivot);
    return pivot;
  }
  const legL = limb(0.22, 0.78, 0.26, pants, -0.15, 0.78);
  const legR = limb(0.22, 0.78, 0.26, pants, 0.15, 0.78);
  const armL = limb(0.18, 0.66, 0.22, shirt, -0.42, 1.44);
  const armR = limb(0.18, 0.66, 0.22, shirt, 0.42, 1.44);
  for (const leg of [legL, legR]) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.1, 0.4), shoe);
    s.position.set(0, -0.78, 0.06);
    leg.add(s);
  }

  return { group, limbs: { legL, legR, armL, armR } };
}

// ---------------------------------------------------------------------------
// Enter / exit car
// ---------------------------------------------------------------------------

export function enterCar(G, car) {
  const p = G.player;
  if (!p || !car || car.health <= 0) return false;
  p.car = car;
  car.player = true;
  p.onFoot = false;
  if (p.mesh) p.mesh.visible = false;
  p.pos.copy(car.pos);
  p.pos.y = 0;
  // Stealing a car that is not the player's own draws the police.
  if (!car.owned) {
    if (G.police) G.police.addWanted(1);
    if (G.hud) G.hud.message('Car stolen!');
  }
  if (G.audio) G.audio.ui();
  return true;
}

export function exitCar(G) {
  const p = G.player;
  const car = p && p.car;
  if (!car) return false;
  // Step out to the side; fall back to the other side, then behind the car,
  // if a wall blocks the spot.
  const sx = Math.cos(car.heading);
  const sz = -Math.sin(car.heading);
  const fx = Math.sin(car.heading);
  const fz = Math.cos(car.heading);
  const spots = [
    [car.pos.x + sx * 2.8, car.pos.z + sz * 2.8],
    [car.pos.x - sx * 2.8, car.pos.z - sz * 2.8],
    [car.pos.x - fx * 4, car.pos.z - fz * 4],
  ];
  let placed = spots[0];
  for (const s of spots) {
    if (!hitsWall(G, s[0], s[1])) { placed = s; break; }
  }
  p.pos.set(clamp(placed[0], -BOUND_X, BOUND_X), 0, clamp(placed[1], -BOUND_Z, BOUND_Z));
  p.heading = car.heading;
  p.camYaw = car.heading;
  p.vy = 0;
  p.grounded = true;
  car.player = false;
  p.car = null;
  p.onFoot = true;
  if (p.mesh) {
    p.mesh.visible = true;
    p.mesh.position.copy(p.pos);
    p.mesh.rotation.y = p.heading;
  }
  if (G.audio) G.audio.ui();
  return true;
}

// ---------------------------------------------------------------------------
// Cameras
// ---------------------------------------------------------------------------

function updateFootCamera(G, dt) {
  const p = G.player;
  const cam = G.camera;
  if (!cam) return;
  const cp = p.camPitch;
  const dist = 7 * Math.cos(cp);
  const height = 3 + Math.sin(cp) * 4;
  const tx = p.pos.x - Math.sin(p.camYaw) * dist;
  const ty = Math.max(p.pos.y + height, 0.6);
  const tz = p.pos.z - Math.cos(p.camYaw) * dist;
  if (!camInit) {
    // First frame: snap instead of swooping in from the origin.
    cam.position.set(tx, ty, tz);
    camInit = true;
  } else {
    const k = 1 - Math.exp(-10 * dt);
    cam.position.x += (tx - cam.position.x) * k;
    cam.position.y += (ty - cam.position.y) * k;
    cam.position.z += (tz - cam.position.z) * k;
  }
  cam.lookAt(p.pos.x, p.pos.y + 1.6, p.pos.z);
}

function updateDriveCamera(G, dt) {
  const p = G.player;
  const cam = G.camera;
  const car = p.car;
  if (!cam || !car) return;
  const fx = Math.sin(car.heading);
  const fz = Math.cos(car.heading);
  const tx = car.pos.x - fx * 11;
  const ty = 5;
  const tz = car.pos.z - fz * 11;
  const k = 1 - Math.exp(-6 * dt);
  cam.position.x += (tx - cam.position.x) * k;
  cam.position.y += (ty - cam.position.y) * k;
  cam.position.z += (tz - cam.position.z) * k;
  cam.lookAt(car.pos.x, car.pos.y + 1.5, car.pos.z);
}

// ---------------------------------------------------------------------------
// init / update
// ---------------------------------------------------------------------------

export function init(G) {
  const p = G.player;
  if (!p.pos) p.pos = new THREE.Vector3(0, 0, 0);
  if (typeof p.heading !== 'number') p.heading = 0;
  if (typeof p.camYaw !== 'number') p.camYaw = p.heading;
  if (typeof p.camPitch !== 'number') p.camPitch = 0.35;
  p.vy = 0;
  p.grounded = true;
  if (typeof p.onFoot !== 'boolean') p.onFoot = true;
  const built = buildCharacterMesh();
  limbs = built.limbs;
  p.mesh = built.group;
  p.mesh.position.copy(p.pos);
  p.mesh.rotation.y = p.heading;
  if (G.scene) G.scene.add(p.mesh);
  camInit = false;
  prevE = false;
  walkPhase = 0;
}

export function update(G, dt) {
  if (!G || G.state !== 'play') return;
  const p = G.player;
  if (!p || !p.mesh) return;
  const input = G.input || {};
  const keys = input.keys || new Set();

  // Mouse look: yaw follows mouseDX, pitch follows mouseDY (clamped).
  p.camYaw -= (input.mouseDX || 0) * MOUSE_SENS;
  p.camPitch = clamp(p.camPitch - (input.mouseDY || 0) * MOUSE_SENS, -0.1, 0.9);

  // Enter / exit car (edge-triggered on E).
  const eDown = keys.has('KeyE');
  if (eDown && !prevE) {
    if (p.car) exitCar(G);
    else {
      const car = nearestCar(G, p.pos.x, p.pos.z, ENTER_DIST);
      if (car) enterCar(G, car);
    }
  }
  prevE = eDown;

  if (p.car) {
    // Driving: the car owns the motion; the player rides along.
    p.pos.copy(p.car.pos);
    p.pos.y = 0;
    p.heading = p.car.heading;
    updateDriveCamera(G, dt);
    return;
  }

  if (p.alive === false) return;

  // --- On-foot movement, relative to the camera yaw. ---
  const fwdX = Math.sin(p.camYaw);
  const fwdZ = Math.cos(p.camYaw);
  const rightX = Math.cos(p.camYaw);
  const rightZ = -Math.sin(p.camYaw);
  let mx = 0;
  let mz = 0;
  if (keys.has('KeyW')) { mx += fwdX; mz += fwdZ; }
  if (keys.has('KeyS')) { mx -= fwdX; mz -= fwdZ; }
  if (keys.has('KeyD')) { mx += rightX; mz += rightZ; }
  if (keys.has('KeyA')) { mx -= rightX; mz -= rightZ; }
  const moving = mx !== 0 || mz !== 0;
  if (moving) {
    const len = Math.hypot(mx, mz);
    mx /= len;
    mz /= len;
  }
  const sprint = keys.has('ShiftLeft') || keys.has('ShiftRight');
  const speed = sprint ? SPRINT_SPEED : WALK_SPEED;

  if (moving) {
    p.heading = lerpAngle(p.heading, Math.atan2(mx, mz), Math.min(1, 12 * dt));
    const step = speed * dt;
    const nx = clamp(p.pos.x + mx * step, -BOUND_X, BOUND_X);
    const nz = clamp(p.pos.z + mz * step, -BOUND_Z, BOUND_Z);
    // Slide along walls: try each axis separately.
    if (!hitsWall(G, nx, p.pos.z)) p.pos.x = nx;
    if (!hitsWall(G, p.pos.x, nz)) p.pos.z = nz;
  }

  // Jump + gravity; land back at y=0.
  if (keys.has('Space') && p.grounded) {
    p.vy = JUMP_VY;
    p.grounded = false;
  }
  if (!p.grounded) {
    p.vy -= GRAVITY * dt;
    p.pos.y += p.vy * dt;
    if (p.pos.y <= 0) {
      p.pos.y = 0;
      p.vy = 0;
      p.grounded = true;
    }
  }

  // Walk cycle (limbs swing, then ease back to neutral when idle).
  if (moving && p.grounded) {
    walkPhase += dt * speed * 1.7;
    const swing = Math.sin(walkPhase) * 0.65;
    limbs.legL.rotation.x = swing;
    limbs.legR.rotation.x = -swing;
    limbs.armL.rotation.x = -swing * 0.8;
    limbs.armR.rotation.x = swing * 0.8;
  } else {
    limbs.legL.rotation.x *= 0.8;
    limbs.legR.rotation.x *= 0.8;
    limbs.armL.rotation.x *= 0.8;
    limbs.armR.rotation.x *= 0.8;
  }

  p.mesh.position.copy(p.pos);
  p.mesh.rotation.y = p.heading;
  updateFootCamera(G, dt);
}

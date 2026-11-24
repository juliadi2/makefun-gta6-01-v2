// CAYO VERDE — vehicles.js
// Car factory, arcade driving physics and road-grid traffic AI for the
// gta6-01 v2 entry. All geometry is procedural; no network, no assets.
//
// Shared contract: three.js is the global THREE (UMD build, loaded before
// this module). G carries scene, input, player, city, vehicles, police,
// hud and audio. Heading convention: forward = (sin(h), 0, cos(h)).

import { CFG } from './config.js';
import { clamp, mulberry32 } from './utils.js';

// Road centrelines (city grid: 40-unit blocks + 12-unit roads, pitch 52).
const ROADS = [-208, -156, -104, -52, 0, 52, 104, 156, 208];
const BOUND_X = 300;
const BOUND_Z = 250;
const TRAFFIC_TARGET = 10;
const PARKED_COUNT = 6;
const CAR_RADIUS = 2.4;
const SEED = (CFG && typeof CFG.SEED === 'number') ? CFG.SEED : 1337;

const BODY_COLORS = [
  0xe74c3c, 0x3498db, 0xf1c40f, 0x2ecc71, 0x9b59b6, 0x1abc9c, 0xe67e22,
  0xecf0f1, 0x95a5a6, 0xff7f9c, 0x7fb3ff, 0xffe066, 0xff6b4a, 0x2f3542,
];
const STYLES = ['sedan', 'sedan', 'sedan', 'sport', 'sport', 'truck', 'taxi'];

let rng = null; // seeded in init()
let smokeTexture = null;
let smokeTextureTried = false;

function rand() { return rng ? rng() : Math.random(); }
function pick(arr) { return arr[Math.floor(rand() * arr.length) % arr.length]; }
function randRange(a, b) { return a + rand() * (b - a); }

function angleDiff(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
function lerpAngle(a, b, t) { return a + angleDiff(a, b) * t; }
function approach(v, target, step) {
  if (v < target) return Math.min(target, v + step);
  return Math.max(target, v - step);
}

function nearestRoad(v) {
  let best = ROADS[0];
  let bd = Infinity;
  for (const r of ROADS) {
    const d = Math.abs(r - v);
    if (d < bd) { bd = d; best = r; }
  }
  return best;
}

// Soft round puff, drawn once on a canvas (procedural, no asset file).
function getSmokeTexture() {
  if (smokeTextureTried) return smokeTexture;
  smokeTextureTried = true;
  try {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
    g.addColorStop(0, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.35)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    smokeTexture = new THREE.CanvasTexture(c);
  } catch (e) {
    smokeTexture = null; // no canvas (headless): sprites still render, just square
  }
  return smokeTexture;
}

// ---------------------------------------------------------------------------
// Mesh building
// ---------------------------------------------------------------------------

function buildCarMesh(style, color) {
  const group = new THREE.Group();
  const body = new THREE.Group(); // tilts with accel/steer; wheels stay level
  group.add(body);

  const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.55 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x0e151c, roughness: 0.12, metalness: 0.9 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1a1d21, roughness: 0.8, metalness: 0.2 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xdfe6ea, roughness: 0.25, metalness: 0.9 });

  const dims = style === 'sport'
    ? { w: 2.2, h: 0.55, l: 4.4, y: 0.5 }
    : style === 'truck'
      ? { w: 2.2, h: 0.8, l: 5.4, y: 0.62 }
      : { w: 2.0, h: 0.65, l: 4.3, y: 0.55 };

  // Hull: main body box.
  const hull = new THREE.Mesh(new THREE.BoxGeometry(dims.w, dims.h, dims.l), paint);
  hull.position.y = dims.y;
  body.add(hull);

  // Cabin: dark glasshouse box + painted roof — the stacked boxes give the
  // rounded two-volume silhouette.
  const cabinZ = style === 'truck' ? dims.l * 0.22 : -dims.l * 0.06;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(dims.w * 0.82, 0.55, dims.l * 0.45), glass);
  cabin.position.set(0, dims.y + dims.h / 2 + 0.24, cabinZ);
  body.add(cabin);
  const roofMat = style === 'police'
    ? new THREE.MeshStandardMaterial({ color: 0xf2f4f6, roughness: 0.4, metalness: 0.3 })
    : paint;
  const roof = new THREE.Mesh(new THREE.BoxGeometry(dims.w * 0.84, 0.08, dims.l * 0.46), roofMat);
  roof.position.set(0, cabin.position.y + 0.3, cabinZ);
  body.add(roof);

  if (style === 'sport') {
    const spoiler = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.08, 0.4), dark);
    spoiler.position.set(0, 1.05, -dims.l / 2 + 0.15);
    body.add(spoiler);
    const lip = new THREE.Mesh(new THREE.BoxGeometry(dims.w + 0.04, 0.1, 0.3), dark);
    lip.position.set(0, 0.22, dims.l / 2);
    body.add(lip);
  }
  if (style === 'truck') {
    const bed = new THREE.Mesh(new THREE.BoxGeometry(dims.w * 0.9, 0.35, dims.l * 0.4), dark);
    bed.position.set(0, dims.y + dims.h / 2 + 0.1, -dims.l * 0.28);
    body.add(bed);
  }

  // Taxi roof sign.
  if (style === 'taxi') {
    const sign = new THREE.Mesh(
      new THREE.BoxGeometry(0.7, 0.22, 0.3),
      new THREE.MeshStandardMaterial({ color: 0xfff6bf, emissive: 0xffe27a, emissiveIntensity: 0.7 }),
    );
    sign.position.set(0, cabin.position.y + 0.45, cabinZ);
    body.add(sign);
  }

  // Police light bar: red / blue emissive boxes, flashed in update.
  let siren = null;
  if (style === 'police') {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.18, 0.35), dark);
    bar.position.set(0, cabin.position.y + 0.42, cabinZ);
    body.add(bar);
    const redMat = new THREE.MeshStandardMaterial({ color: 0x330000, emissive: 0xff2222, emissiveIntensity: 2 });
    const blueMat = new THREE.MeshStandardMaterial({ color: 0x000033, emissive: 0x2244ff, emissiveIntensity: 2 });
    const red = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.16, 0.3), redMat);
    red.position.set(-0.33, cabin.position.y + 0.44, cabinZ);
    const blue = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.16, 0.3), blueMat);
    blue.position.set(0.33, cabin.position.y + 0.44, cabinZ);
    body.add(red, blue);
    siren = { red: redMat, blue: blueMat };
  }

  // Headlights (emissive) and taillights.
  const headMat = new THREE.MeshStandardMaterial({ color: 0xfff8d6, emissive: 0xfff2b0, emissiveIntensity: 1.4 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff2222, emissiveIntensity: 1.0 });
  for (const s of [-1, 1]) {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.14, 0.08), headMat);
    hl.position.set(s * (dims.w / 2 - 0.3), dims.y + 0.05, dims.l / 2 + 0.01);
    body.add(hl);
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.14, 0.08), tailMat);
    tl.position.set(s * (dims.w / 2 - 0.3), dims.y + 0.05, -dims.l / 2 - 0.01);
    body.add(tl);
  }

  // Bumpers.
  const bumpF = new THREE.Mesh(new THREE.BoxGeometry(dims.w + 0.06, 0.18, 0.18), dark);
  bumpF.position.set(0, 0.3, dims.l / 2 + 0.05);
  const bumpR = bumpF.clone();
  bumpR.position.z = -dims.l / 2 - 0.05;
  body.add(bumpF, bumpR);

  // Wheels: cylinders with the axle along X; fronts sit in steer pivots.
  const wheelGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.3, 14);
  wheelGeo.rotateZ(Math.PI / 2);
  const hubGeo = new THREE.CylinderGeometry(0.18, 0.18, 0.32, 10);
  hubGeo.rotateZ(Math.PI / 2);
  const tyre = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.9 });
  const wheels = [];
  const frontPivots = [];
  const wz = dims.l / 2 - 0.85;
  for (const [sx, sz, front] of [[-1, 1, true], [1, 1, true], [-1, -1, false], [1, -1, false]]) {
    const pivot = new THREE.Group();
    pivot.position.set(sx * (dims.w / 2 - 0.05), 0.36, sz * wz);
    const wheel = new THREE.Mesh(wheelGeo, tyre);
    const cap = new THREE.Mesh(hubGeo, chrome);
    wheel.add(cap);
    pivot.add(wheel);
    group.add(pivot);
    wheels.push(wheel);
    if (front) frontPivots.push(pivot);
  }

  return { group, body, wheels, frontPivots, siren, length: dims.l };
}

// ---------------------------------------------------------------------------
// Car factory
// ---------------------------------------------------------------------------

function aiHeading(ai) {
  if (ai.axis === 'x') return ai.dir > 0 ? Math.PI / 2 : -Math.PI / 2;
  return ai.dir > 0 ? 0 : Math.PI;
}

// Traffic brain: drive along the road the car is already on.
function makeTrafficAi(x, z) {
  const axis = rand() < 0.5 ? 'x' : 'z';
  return {
    axis,
    dir: rand() < 0.5 ? 1 : -1,
    lane: axis === 'x' ? nearestRoad(z) : nearestRoad(x),
    cruise: randRange(8, 14),
    turnCd: randRange(1, 4),
  };
}

/**
 * Build a car at (x, z). opts: style ('sedan'|'sport'|'truck'|'taxi'|'police'),
 * color (hex), heading, parked (no AI), owned (the player's own car — entering
 * it is not theft), ai (explicit traffic brain). The car is added to the scene
 * and to G.vehicles.list and returned.
 */
export function spawnCar(G, x, z, opts = {}) {
  const style = opts.style || pick(STYLES);
  let color = opts.color;
  if (color === undefined) {
    if (style === 'taxi') color = 0xf7c948;
    else if (style === 'police') color = 0x14181d;
    else color = pick(BODY_COLORS);
  }
  const parts = buildCarMesh(style, color);
  const mesh = parts.group;
  mesh.position.set(x, 0, z);

  const maxSpeed = style === 'sport' ? 38 : style === 'truck' ? 24 : 28;
  const car = {
    mesh,
    pos: mesh.position, // same object: pos and mesh stay in sync
    heading: opts.heading !== undefined ? opts.heading : randRange(0, Math.PI * 2),
    speed: 0,
    color,
    style,
    police: style === 'police',
    player: false,
    owned: !!opts.owned,
    parked: !!opts.parked,
    health: 100,
    maxSpeed,
    steer: 0,
    tilt: 0,
    damageCd: 0,
    wreckTimer: 0,
    smoke: [],
    smokeTimer: 0,
    ai: null,
    _body: parts.body,
    _wheels: parts.wheels,
    _frontPivots: parts.frontPivots,
    _siren: parts.siren,
    _length: parts.length,
    _scene: G ? G.scene : null,
    _prevSpeed: 0,
    _accelSm: 0,
  };

  if (!car.parked) {
    car.ai = opts.ai || makeTrafficAi(x, z);
    // Sit in the right-hand lane of the road the AI follows.
    if (car.ai.axis === 'x') car.pos.z = car.ai.lane + car.ai.dir * 2.5;
    else car.pos.x = car.ai.lane + car.ai.dir * 2.5;
    if (opts.heading === undefined) car.heading = aiHeading(car.ai);
  }
  mesh.rotation.y = car.heading;

  car.update = (dt, gg) => updateCar(gg, car, dt);

  if (G && G.scene) G.scene.add(mesh);
  if (G && G.vehicles && Array.isArray(G.vehicles.list)) G.vehicles.list.push(car);
  return car;
}

// Nearest drivable car to (x, z) within maxDist, or null.
export function nearestCar(G, x, z, maxDist) {
  const list = (G && G.vehicles && G.vehicles.list) || [];
  let best = null;
  let bestD = maxDist;
  for (const car of list) {
    if (car.health <= 0) continue; // wrecked cars can't be driven
    const d = Math.hypot(car.pos.x - x, car.pos.z - z);
    if (d < bestD) { bestD = d; best = car; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Movement, driving, traffic AI
// ---------------------------------------------------------------------------

// Move along the heading; bounce off buildings. Returns true on a building hit.
function moveCar(G, car, dt, canDamage) {
  const nx = car.pos.x + Math.sin(car.heading) * car.speed * dt;
  const nz = car.pos.z + Math.cos(car.heading) * car.speed * dt;
  const hitBuilding = G.city && G.city.collideCircle
    ? G.city.collideCircle(nx, nz, CAR_RADIUS - 0.4)
    : false;
  if (hitBuilding) {
    const impact = Math.abs(car.speed);
    car.speed *= -0.3;
    // Only real impacts damage, with a cooldown, so grinding along a wall
    // while holding W does not drain health every frame.
    if (canDamage && impact > 5 && car.damageCd <= 0) {
      car.health -= 5;
      car.damageCd = 0.5;
      if (car.player && G.hud) G.hud.message('Crash! Car damaged');
    }
    return true;
  }
  car.pos.x = clamp(nx, -BOUND_X, BOUND_X);
  car.pos.z = clamp(nz, -BOUND_Z, BOUND_Z);
  car.mesh.rotation.y = car.heading;
  return false;
}

function drivePlayerCar(G, car, dt) {
  const keys = (G.input && G.input.keys) || new Set();
  const handbrake = keys.has('Space');
  const maxSpeed = car.maxSpeed;

  if (keys.has('KeyW')) {
    car.speed = Math.min(maxSpeed, car.speed + 14 * dt);
  } else if (keys.has('KeyS')) {
    if (car.speed > 0.5) car.speed -= 30 * dt; // brake
    else car.speed = Math.max(-maxSpeed * 0.35, car.speed - 10 * dt); // reverse
  } else {
    car.speed -= car.speed * 0.6 * dt; // coast drag
    if (Math.abs(car.speed) < 0.05) car.speed = 0;
  }
  if (handbrake) {
    car.speed -= car.speed * 2.2 * dt;
    if (Math.abs(car.speed) < 0.3) car.speed = 0;
  }

  // Steering: full lock at low speed, easing off as speed rises; the
  // handbrake sharpens it for slides.
  const steerInput = (keys.has('KeyA') ? -1 : 0) + (keys.has('KeyD') ? 1 : 0);
  const speedFactor = 1 - Math.min(Math.abs(car.speed) / maxSpeed, 1) * 0.6;
  const steerTarget = steerInput * 0.55 * speedFactor * (handbrake ? 1.5 : 1);
  car.steer += (steerTarget - car.steer) * Math.min(1, 10 * dt);
  car.heading += car.steer * clamp(car.speed / 6, -1, 1) * 1.7 * dt;

  moveCar(G, car, dt, true);
}

// Is there a car (or the on-foot player) ahead within `dist` units?
function obstacleAhead(G, car, dist) {
  const fx = Math.sin(car.heading);
  const fz = Math.cos(car.heading);
  const list = (G.vehicles && G.vehicles.list) || [];
  for (const other of list) {
    if (other === car) continue;
    const dx = other.pos.x - car.pos.x;
    const dz = other.pos.z - car.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < dist + CAR_RADIUS && d > 0.01 && (dx * fx + dz * fz) / d > 0.5) return true;
  }
  if (G.player && G.player.onFoot && G.player.pos) {
    const dx = G.player.pos.x - car.pos.x;
    const dz = G.player.pos.z - car.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < dist && d > 0.01 && (dx * fx + dz * fz) / d > 0.5) return true;
  }
  return false;
}

function driveTrafficCar(G, car, dt) {
  const ai = car.ai;
  ai.turnCd -= dt;
  const desired = aiHeading(ai);
  car.heading = lerpAngle(car.heading, desired, Math.min(1, 4 * dt));

  const target = obstacleAhead(G, car, 8) ? 0 : ai.cruise;
  if (car.speed < target) car.speed = Math.min(target, car.speed + 6 * dt);
  else car.speed = Math.max(target, car.speed - 14 * dt);

  const hit = moveCar(G, car, dt, false);
  if (hit) {
    // Should not happen on the road grid; turn around and carry on.
    ai.dir *= -1;
    ai.turnCd = 2;
  }

  // Lane keeping: ease the cross-axis coordinate onto the lane when aligned.
  if (Math.abs(angleDiff(car.heading, desired)) < 0.15) {
    if (ai.axis === 'x') {
      const targetZ = ai.lane + ai.dir * 2.5;
      car.pos.z += (targetZ - car.pos.z) * Math.min(1, 2 * dt);
    } else {
      const targetX = ai.lane + ai.dir * 2.5;
      car.pos.x += (targetX - car.pos.x) * Math.min(1, 2 * dt);
    }
  }

  // Random turns at intersections.
  if (ai.turnCd <= 0) {
    const along = ai.axis === 'x' ? car.pos.x : car.pos.z;
    for (const r of ROADS) {
      if (Math.abs(along - r) < 3) {
        if (rand() < 0.3) {
          ai.axis = ai.axis === 'x' ? 'z' : 'x';
          ai.lane = r;
          ai.dir = rand() < 0.5 ? 1 : -1;
        }
        ai.turnCd = 3;
        break;
      }
    }
  }

  // Near the map edge: turn back instead of driving out.
  if (ai.axis === 'x' && Math.abs(car.pos.x) > 235) {
    ai.dir = car.pos.x > 0 ? -1 : 1;
    ai.turnCd = 2;
  }
  if (ai.axis === 'z' && Math.abs(car.pos.z) > 220) {
    ai.dir = car.pos.z > 0 ? -1 : 1;
    ai.turnCd = 2;
  }
}

// Simple circle push + speed exchange between every pair of cars.
function collideCars(G) {
  const list = (G.vehicles && G.vehicles.list) || [];
  const min = CAR_RADIUS * 2 - 0.6;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      const dx = b.pos.x - a.pos.x;
      const dz = b.pos.z - a.pos.z;
      const d = Math.hypot(dx, dz);
      if (d >= min || d < 0.001) continue;
      const nx = dx / d;
      const nz = dz / d;
      const overlap = min - d;
      // Parked/wrecked cars barely budge; moving cars split the push.
      const aMove = a.parked || a.health <= 0 ? 0.15 : 0.5;
      const bMove = b.parked || b.health <= 0 ? 0.15 : 0.5;
      const total = aMove + bMove;
      a.pos.x -= nx * overlap * (aMove / total);
      a.pos.z -= nz * overlap * (aMove / total);
      b.pos.x += nx * overlap * (bMove / total);
      b.pos.z += nz * overlap * (bMove / total);
      const rel = Math.abs(a.speed - b.speed);
      if (!a.parked && !b.parked && a.health > 0 && b.health > 0) {
        const tmp = a.speed;
        a.speed = b.speed * 0.7;
        b.speed = tmp * 0.7;
      } else {
        // One side is parked/wrecked: the moving car bounces back.
        if (!a.parked && a.health > 0) a.speed *= -0.4;
        if (!b.parked && b.health > 0) b.speed *= -0.4;
      }
      // Hard impacts damage both cars.
      if (rel > 12) {
        if (a.damageCd <= 0) { a.health -= 4; a.damageCd = 0.5; }
        if (b.damageCd <= 0) { b.health -= 4; b.damageCd = 0.5; }
        if ((a.player || b.player) && G.hud) G.hud.message('Crash! Car damaged');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Visuals: wheels, body tilt, siren, wreck smoke
// ---------------------------------------------------------------------------

function spinWheels(car, dt) {
  const spin = (car.speed / 0.36) * dt;
  for (const w of car._wheels) w.rotation.x += spin;
}

function updateSmoke(car, dt) {
  car.smokeTimer -= dt;
  if (car.smokeTimer <= 0 && car.smoke.length < 14 && car._scene) {
    car.smokeTimer = 0.12;
    const mat = new THREE.SpriteMaterial({
      map: getSmokeTexture(),
      color: 0x2a2a2a,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    const s = new THREE.Sprite(mat);
    const fx = Math.sin(car.heading);
    const fz = Math.cos(car.heading);
    s.position.set(car.pos.x + fx * 1.4, 1.1, car.pos.z + fz * 1.4);
    s.scale.set(1, 1, 1);
    s.userData.life = 0;
    car._scene.add(s);
    car.smoke.push(s);
  }
  for (let i = car.smoke.length - 1; i >= 0; i--) {
    const s = car.smoke[i];
    s.userData.life += dt;
    s.position.y += 1.6 * dt;
    const k = s.userData.life / 1.4;
    s.scale.set(1 + k * 2.2, 1 + k * 2.2, 1);
    s.material.opacity = 0.55 * (1 - k);
    if (k >= 1) {
      if (car._scene) car._scene.remove(s);
      s.material.dispose();
      car.smoke.splice(i, 1);
    }
  }
}

function syncCarVisuals(G, car, dt) {
  car.mesh.rotation.y = car.heading;
  spinWheels(car, dt);
  for (const p of car._frontPivots) p.rotation.y = car.steer * 0.6;
  // Body tilt: lean into steering, squat/dive with acceleration.
  const speedN = clamp(car.speed / car.maxSpeed, -1, 1);
  const targetTiltZ = -car.steer * Math.abs(speedN) * 0.5;
  car.tilt += (targetTiltZ - car.tilt) * Math.min(1, 6 * dt);
  car._body.rotation.z = car.tilt * 0.12;
  const accel = (car.speed - car._prevSpeed) / Math.max(dt, 0.001);
  car._prevSpeed = car.speed;
  car._accelSm += (clamp(accel, -20, 20) - car._accelSm) * Math.min(1, 5 * dt);
  car._body.rotation.x = -car._accelSm * 0.002;
  // Police light bar flash.
  if (car._siren) {
    const t = (G && typeof G.time === 'number') ? G.time : performance.now() / 1000;
    const phase = Math.floor(t * 4) % 2 === 0;
    car._siren.red.emissiveIntensity = phase ? 2.5 : 0.2;
    car._siren.blue.emissiveIntensity = phase ? 0.2 : 2.5;
  }
  if (car.health <= 0) updateSmoke(car, dt);
}

function updateCar(G, car, dt) {
  car.damageCd = Math.max(0, car.damageCd - dt);
  if (car.health <= 0) {
    // Wrecked: coast to a stop and smoke.
    car.speed = approach(car.speed, 0, 20 * dt);
    moveCar(G, car, dt, false);
    updateSmoke(car, dt);
    spinWheels(car, dt);
    return;
  }
  if (car.player) drivePlayerCar(G, car, dt);
  else if (car.ai) driveTrafficCar(G, car, dt);
  // Parked cars do not move.
  syncCarVisuals(G, car, dt);
}

// ---------------------------------------------------------------------------
// Spawning helpers, init, update
// ---------------------------------------------------------------------------

function parkedSpot() {
  const axis = rand() < 0.5 ? 'x' : 'z';
  const lane = pick(ROADS);
  const along = randRange(-230, 230);
  const off = (rand() < 0.5 ? -1 : 1) * randRange(7.5, 9);
  if (axis === 'x') {
    return { x: along, z: lane + off, heading: rand() < 0.5 ? Math.PI / 2 : -Math.PI / 2 };
  }
  return { x: lane + off, z: along, heading: rand() < 0.5 ? 0 : Math.PI };
}

// A random point on the road grid, minD..maxD units from the player.
function roadSpotNear(G, minD, maxD) {
  const px = (G.player && G.player.pos) ? G.player.pos.x : 0;
  const pz = (G.player && G.player.pos) ? G.player.pos.z : 0;
  for (let tries = 0; tries < 20; tries++) {
    const axis = rand() < 0.5 ? 'x' : 'z';
    const lane = pick(ROADS);
    const along = randRange(-230, 230);
    const x = axis === 'x' ? along : lane;
    const z = axis === 'x' ? lane : along;
    const d = Math.hypot(x - px, z - pz);
    if (d >= minD && d <= maxD) return { x, z };
  }
  return { x: pick(ROADS), z: randRange(-200, 200) };
}

function removeCar(car) {
  for (const s of car.smoke) {
    if (car._scene) car._scene.remove(s);
    s.material.dispose();
  }
  car.smoke.length = 0;
  if (car._scene) car._scene.remove(car.mesh);
}

function respawnTraffic(G, car) {
  const p = roadSpotNear(G, 60, 120);
  car.pos.set(p.x, 0, p.z);
  car.ai = makeTrafficAi(p.x, p.z);
  if (car.ai.axis === 'x') car.pos.z = car.ai.lane + car.ai.dir * 2.5;
  else car.pos.x = car.ai.lane + car.ai.dir * 2.5;
  car.heading = aiHeading(car.ai);
  car.mesh.rotation.y = car.heading;
  car.speed = car.ai.cruise * 0.5;
}

export function init(G) {
  rng = mulberry32(SEED + 3);
  if (!G.vehicles) G.vehicles = {};
  if (!Array.isArray(G.vehicles.list)) G.vehicles.list = [];
  // Contract surface: police.js and shots.js spawn cars through here.
  G.vehicles.spawnCar = spawnCar;

  // The player's own car, parked near the spawn: entering it is not theft.
  spawnCar(G, 7.5, 6, { style: 'sport', color: 0xff6b4a, parked: true, owned: true, heading: 0 });
  // Remaining parked cars (6 total including the owned one).
  for (let i = 0; i < PARKED_COUNT - 1; i++) {
    const p = parkedSpot();
    spawnCar(G, p.x, p.z, { parked: true, heading: p.heading });
  }
  // Traffic on the road grid, kept clear of the spawn.
  for (let i = 0; i < TRAFFIC_TARGET; i++) {
    const p = roadSpotNear(G, 15, 200);
    spawnCar(G, p.x, p.z, {});
  }
}

export function update(G, dt) {
  if (!G || G.state !== 'play') return;
  const list = (G.vehicles && G.vehicles.list) || [];
  let playerCar = null;
  for (let i = list.length - 1; i >= 0; i--) {
    const car = list[i];
    car.update(dt, G);
    if (car.player) playerCar = car;
    if (car.ai && car.health <= 0) {
      // Wrecked traffic is cleared after a few seconds so roads don't clog.
      car.wreckTimer += dt;
      if (car.wreckTimer > 8) {
        removeCar(car);
        list.splice(i, 1);
      }
    } else if (car.ai && !car.player) {
      // Despawn/respawn traffic that has wandered far from the player.
      const px = G.player && G.player.pos ? G.player.pos.x : 0;
      const pz = G.player && G.player.pos ? G.player.pos.z : 0;
      if (Math.hypot(car.pos.x - px, car.pos.z - pz) > 150) respawnTraffic(G, car);
    }
  }
  collideCars(G);
  // Keep traffic around the target count.
  let traffic = 0;
  for (const car of list) if (car.ai && !car.player) traffic++;
  while (traffic < TRAFFIC_TARGET) {
    const p = roadSpotNear(G, 60, 120);
    spawnCar(G, p.x, p.z, {});
    traffic++;
  }
  // Engine sound for the player car only (silent when on foot).
  if (G.audio && G.audio.engine) {
    G.audio.engine(playerCar
      ? clamp(Math.abs(playerCar.speed) / playerCar.maxSpeed, 0, 1)
      : 0);
  }
}

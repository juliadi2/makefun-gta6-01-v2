// Wanted system + police AI (patrol cars and foot cops).
//
// Wanted 0-5 stars. Cops spawn to match the wanted level, chase the player,
// and bust them on foot; staying unseen cools the heat down one star at a time.
//
// Contract: ES module, THREE is the global UMD build. Exports init(G),
// update(G, dt), addWanted(G, n) and clearWanted(G). Police cars are spawned
// through G.vehicles.spawnCar and driven by setting their heading/speed —
// vehicles.js owns the integration. Guards every cross-module call.

import * as utils from './utils.js';

const clamp = typeof utils.clamp === 'function'
  ? utils.clamp
  : (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const ROAD_LINES = [-208, -156, -104, -52, 0, 52, 104, 156, 208];
const BOUND_X = 300;
const BOUND_Z = 250;
const COOL_TIME = 20; // seconds unseen before one star drops
const SIGHT_RANGE = 40;
const BUST_RANGE = 2;
const BUST_TIME = 2;
const BUST_FINE = 100;

// Desired force per wanted level: [cars, foot cops].
const FORCE = {
  0: [0, 0],
  1: [0, 1],
  2: [1, 0],
  3: [2, 0],
  4: [2, 2],
  5: [3, 3],
};

function nearestRoadLine(v) {
  let best = ROAD_LINES[0];
  let bestD = Math.abs(v - best);
  for (const line of ROAD_LINES) {
    const d = Math.abs(v - line);
    if (d < bestD) { bestD = d; best = line; }
  }
  return best;
}

// A road spot 40-60 units from (cx, cz), snapped onto a road centreline.
function roadSpotNear(cx, cz) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = 40 + Math.random() * 20;
    let x = clamp(cx + Math.sin(angle) * dist, -BOUND_X + 10, BOUND_X - 10);
    let z = clamp(cz + Math.cos(angle) * dist, -BOUND_Z + 10, BOUND_Z - 10);
    if (Math.random() < 0.5) x = nearestRoadLine(x);
    else z = nearestRoadLine(z);
    return { x, z };
  }
  return { x: clamp(cx + 50, -BOUND_X + 10, BOUND_X - 10), z: clamp(cz, -BOUND_Z + 10, BOUND_Z - 10) };
}

function starText(n) {
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}

export function addWanted(G, n) {
  if (!G) return;
  const before = G.wanted || 0;
  G.wanted = clamp(before + (n || 0), 0, 5);
  if (G.police) G.police.coolTimer = 0;
  if (G.wanted > before && G.hud) {
    G.hud.message('Wanted level up! ' + starText(G.wanted));
  }
}

export function clearWanted(G) {
  if (!G) return;
  G.wanted = 0;
  if (G.police) G.police.coolTimer = 0;
}

// --- Foot cop mesh: dark blue uniform, cap, same proportions as a ped. -----
function buildCopMesh() {
  const group = new THREE.Group();
  const matUniform = new THREE.MeshLambertMaterial({ color: 0x1a237e });
  const matDark = new THREE.MeshLambertMaterial({ color: 0x101530 });
  const matSkin = new THREE.MeshLambertMaterial({ color: 0xe0ac69 });

  const legGeo = new THREE.BoxGeometry(0.17, 0.8, 0.22);
  legGeo.translate(0, -0.4, 0);
  const legL = new THREE.Mesh(legGeo, matDark);
  legL.position.set(-0.11, 0.8, 0);
  const legR = new THREE.Mesh(legGeo, matDark);
  legR.position.set(0.11, 0.8, 0);
  group.add(legL, legR);

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.68, 0.3), matUniform);
  torso.position.y = 1.14;
  group.add(torso);

  const badge = new THREE.Mesh(
    new THREE.BoxGeometry(0.1, 0.12, 0.02),
    new THREE.MeshLambertMaterial({ color: 0xffd700 }),
  );
  badge.position.set(-0.15, 1.3, 0.16);
  group.add(badge);

  const armGeo = new THREE.BoxGeometry(0.14, 0.62, 0.16);
  armGeo.translate(0, -0.31, 0);
  const armL = new THREE.Mesh(armGeo, matUniform);
  armL.position.set(-0.36, 1.44, 0);
  const armR = new THREE.Mesh(armGeo, matUniform);
  armR.position.set(0.36, 1.44, 0);
  group.add(armL, armR);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), matSkin);
  head.position.y = 1.7;
  group.add(head);

  const cap = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.1, 0.46), matDark);
  cap.position.y = 1.9;
  group.add(cap);

  group.userData.legL = legL;
  group.userData.legR = legR;
  group.userData.armL = armL;
  group.userData.armR = armR;
  return group;
}

// Red/blue light bar stuck on top of a police car, so the flash does not
// depend on how vehicles.js builds its meshes.
function attachLightBar(car) {
  if (!car || !car.mesh) return null;
  const bar = new THREE.Group();
  const redMat = new THREE.MeshBasicMaterial({ color: 0xff2222 });
  const blueMat = new THREE.MeshBasicMaterial({ color: 0x2244ff });
  const red = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.16, 0.3), redMat);
  red.position.x = -0.28;
  const blue = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.16, 0.3), blueMat);
  blue.position.x = 0.28;
  bar.add(red, blue);
  bar.position.set(0, 0.85, 0);
  car.mesh.add(bar);
  return { redMat, blueMat };
}

function removeCarFromWorld(G, car) {
  if (!car) return;
  if (G.vehicles && typeof G.vehicles.removeCar === 'function') {
    G.vehicles.removeCar(G, car);
    return;
  }
  if (car.mesh && G.scene) G.scene.remove(car.mesh);
  if (G.vehicles && Array.isArray(G.vehicles.list)) {
    const idx = G.vehicles.list.indexOf(car);
    if (idx >= 0) G.vehicles.list.splice(idx, 1);
  }
}

function spawnFootCop(G, x, z) {
  if (!G || !G.scene || !G.police) return null;
  const mesh = buildCopMesh();
  mesh.position.set(x, 0, z);
  G.scene.add(mesh);
  const cop = {
    kind: 'foot',
    mesh,
    pos: new THREE.Vector3(x, 0, z),
    heading: 0,
    bustTimer: 0,
    leaving: false,
    leaveTimer: 0,
    runPhase: Math.random() * Math.PI * 2,
  };
  mesh.userData.cop = cop;
  G.police.cops.push(cop);
  return cop;
}

function spawnPoliceCar(G) {
  if (!G || !G.vehicles || typeof G.vehicles.spawnCar !== 'function') return null;
  const playerPos = G.player ? G.player.pos : { x: 0, z: 0 };
  const spot = roadSpotNear(playerPos.x, playerPos.z);
  const car = G.vehicles.spawnCar(G, spot.x, spot.z, { style: 'police', police: true });
  if (!car) return null;
  car.police = true;
  const cop = {
    kind: 'car',
    car,
    lights: attachLightBar(car),
    crewOut: false,
    leaving: false,
    leaveTimer: 0,
  };
  G.police.cops.push(cop);
  return cop;
}

function bustPlayer(G) {
  const fine = Math.min(BUST_FINE, G.money || 0);
  G.money = Math.max(0, (G.money || 0) - BUST_FINE);
  clearWanted(G);
  // Drop the player at the police station (0, 0), on foot.
  if (G.player) {
    if (G.player.car) G.player.car.player = false;
    G.player.car = null;
    G.player.onFoot = true;
    if (G.player.pos) G.player.pos.set(0, 0, 0);
    if (G.player.mesh) {
      G.player.mesh.position.set(0, 0, 0);
      G.player.mesh.visible = true; // the mesh is hidden while driving
    }
    G.player.heading = 0;
    G.player.speed = 0;
  }
  if (G.hud) G.hud.message('Busted! Fine -$' + fine + '. Released at the station.');
  // Every cop stands down.
  for (const cop of G.police.cops) {
    cop.leaving = true;
    cop.leaveTimer = 0;
  }
  if (G.audio) G.audio.siren(false);
}

function init(G) {
  G.police = {
    cops: [],
    coolTimer: 0,
    sirenOn: false,
    spawnTimer: 0,
    // Contract surface: other modules raise the heat through here.
    addWanted: (n) => addWanted(G, n),
    clearWanted: () => clearWanted(G),
  };
  if (typeof G.wanted !== 'number') G.wanted = 0;
}

function update(G, dt) {
  if (!G || !G.police) return;
  const police = G.police;
  const wanted = clamp(G.wanted || 0, 0, 5);
  const playerPos = G.player ? G.player.pos : null;
  const playerAlive = !G.player || G.player.alive !== false;
  const time = G.time || 0;

  // --- Siren follows the wanted level ------------------------------------
  const sirenShouldBeOn = wanted > 0 && playerAlive;
  if (sirenShouldBeOn !== police.sirenOn) {
    police.sirenOn = sirenShouldBeOn;
    if (G.audio) G.audio.siren(sirenShouldBeOn);
  }

  // --- Cooling off: unseen for 20 s drops one star ------------------------
  if (wanted > 0 && playerPos) {
    let seen = false;
    for (const cop of police.cops) {
      if (cop.leaving) continue;
      const p = cop.kind === 'car' ? (cop.car && cop.car.pos) : cop.pos;
      if (p && Math.hypot(p.x - playerPos.x, p.z - playerPos.z) < SIGHT_RANGE) {
        seen = true;
        break;
      }
    }
    if (seen) {
      police.coolTimer = 0;
    } else {
      police.coolTimer += dt;
      if (police.coolTimer >= COOL_TIME) {
        police.coolTimer = 0;
        G.wanted = wanted - 1;
        if (G.hud) G.hud.message('Cooling off... ' + starText(G.wanted));
      }
    }
  }

  // --- Match the force to the wanted level --------------------------------
  const [wantCars, wantFoot] = FORCE[wanted] || [0, 0];
  let cars = 0;
  let foot = 0;
  for (const cop of police.cops) {
    if (cop.leaving) continue;
    if (cop.kind === 'car') cars++;
    else foot++;
  }
  // Too many: the extras leave.
  if (wanted === 0 || cars > wantCars || foot > wantFoot) {
    let spareCars = Math.max(0, cars - wantCars);
    let spareFoot = Math.max(0, foot - wantFoot);
    for (const cop of police.cops) {
      if (cop.leaving) continue;
      if (cop.kind === 'car' && spareCars > 0) { cop.leaving = true; cop.leaveTimer = 0; spareCars--; }
      else if (cop.kind === 'foot' && spareFoot > 0) { cop.leaving = true; cop.leaveTimer = 0; spareFoot--; }
    }
  }
  // Too few: drip-feed replacements, at most one every 0.4 s.
  police.spawnTimer -= dt;
  if (playerAlive && police.spawnTimer <= 0 && (cars < wantCars || foot < wantFoot)) {
    if (cars < wantCars) spawnPoliceCar(G);
    else spawnFootCop(G, playerPos ? playerPos.x + 45 : 45, playerPos ? playerPos.z : 0);
    police.spawnTimer = 0.4;
  }

  if (!playerPos) return;
  const playerOnFoot = !G.player || G.player.onFoot !== false;
  const playerCar = G.player ? G.player.car : null;

  for (let i = police.cops.length - 1; i >= 0; i--) {
    const cop = police.cops[i];

    if (cop.kind === 'car') {
      const car = cop.car;
      if (!car || !car.pos || (typeof car.health === 'number' && car.health <= 0)) {
        // Wrecked or gone: drop the record (vehicles.js owns the husk).
        police.cops.splice(i, 1);
        continue;
      }

      // Flash the light bar: red and blue alternate twice a second.
      if (cop.lights) {
        const phase = Math.floor(time * 4) % 2 === 0;
        cop.lights.redMat.color.setHex(phase ? 0xff2222 : 0x550000);
        cop.lights.blueMat.color.setHex(phase ? 0x000055 : 0x2244ff);
      }

      if (cop.leaving) {
        // Drive away from the player, then despawn after 10 s.
        cop.leaveTimer += dt;
        const away = Math.atan2(car.pos.x - playerPos.x, car.pos.z - playerPos.z);
        car.heading = away;
        car.speed = 16;
        if (cop.leaveTimer >= 10) {
          removeCarFromWorld(G, car);
          police.cops.splice(i, 1);
        }
        continue;
      }

      const dx = playerPos.x - car.pos.x;
      const dz = playerPos.z - car.pos.z;
      const dist = Math.hypot(dx, dz);

      // Player on foot and close: stop and send a foot cop out.
      if (playerOnFoot && dist < 9 && !cop.crewOut) {
        car.speed = 0;
        cop.crewOut = true;
        spawnFootCop(G, car.pos.x + 2, car.pos.z + 2);
        continue;
      }
      // Parked with the crew out: stay put until the player drives off.
      if (cop.crewOut && playerOnFoot && dist < 25) {
        car.speed = 0;
        continue;
      }
      if (cop.crewOut && !playerOnFoot) cop.crewOut = false;

      // Pursuit: steer toward the player, fastest way round.
      const wantHeading = Math.atan2(dx, dz);
      let diff = wantHeading - (car.heading || 0);
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      car.heading = (car.heading || 0) + clamp(diff, -2.5 * dt, 2.5 * dt);
      const targetSpeed = dist > 6 ? (wanted >= 4 ? 26 : 22) : 10;
      car.speed = car.speed || 0;
      car.speed += clamp(targetSpeed - car.speed, -30 * dt, 14 * dt);

      // Ram: on contact, shove the player's car and damage it.
      if (playerCar && playerCar.pos && dist < 3.4) {
        const push = 6;
        const len = Math.max(0.001, dist);
        playerCar.pos.x += (dx / len) * -push * dt * 4;
        playerCar.pos.z += (dz / len) * -push * dt * 4;
        if (typeof playerCar.health === 'number') {
          playerCar.health = Math.max(0, playerCar.health - 25 * dt);
        }
        car.speed = Math.max(4, car.speed - 8 * dt);
      }
      continue;
    }

    // --- Foot cop ----------------------------------------------------------
    const dx = playerPos.x - cop.pos.x;
    const dz = playerPos.z - cop.pos.z;
    const dist = Math.hypot(dx, dz);

    if (cop.leaving) {
      cop.leaveTimer += dt;
      // Walk away from the player, then despawn after 10 s.
      const away = Math.atan2(cop.pos.x - playerPos.x, cop.pos.z - playerPos.z);
      cop.heading = away;
      cop.pos.x += Math.sin(away) * 3 * dt;
      cop.pos.z += Math.cos(away) * 3 * dt;
      cop.mesh.position.copy(cop.pos);
      cop.mesh.rotation.y = away;
      if (cop.leaveTimer >= 10) {
        if (G.scene) G.scene.remove(cop.mesh);
        police.cops.splice(i, 1);
      }
      continue;
    }

    // Run at the player.
    const wantHeading = Math.atan2(dx, dz);
    let diff = wantHeading - cop.heading;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    cop.heading += clamp(diff, -8 * dt, 8 * dt);
    cop.pos.x += Math.sin(cop.heading) * 7 * dt;
    cop.pos.z += Math.cos(cop.heading) * 7 * dt;
    cop.mesh.position.copy(cop.pos);
    cop.mesh.rotation.y = cop.heading;
    cop.runPhase += dt * 7 * 4.2;
    const swing = Math.sin(cop.runPhase) * 0.85;
    cop.mesh.userData.legL.rotation.x = swing;
    cop.mesh.userData.legR.rotation.x = -swing;
    cop.mesh.userData.armL.rotation.x = -swing * 0.7;
    cop.mesh.userData.armR.rotation.x = swing * 0.7;

    // Busted: on the player's heels, on foot, for 2 s straight.
    if (playerOnFoot && playerAlive && dist < BUST_RANGE) {
      cop.bustTimer += dt;
      if (cop.bustTimer >= BUST_TIME) {
        bustPlayer(G);
        return;
      }
    } else {
      cop.bustTimer = 0;
    }
  }
}

export { init, update };

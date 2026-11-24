// Pedestrians: simple procedural people who stroll along the sidewalks, flee from
// gunfire and speeding cars, and can be run over. Keeps ~24 alive near the player.
//
// Contract: ES module, THREE is the global UMD build. Exports init(G), update(G, dt)
// and spawnPed(G, x, z). Guards every cross-module call so partial integration runs.

import * as config from './config.js';
import * as utils from './utils.js';

const CFG = config.CFG || {};
const SEED = Number.isInteger(CFG.SEED) ? CFG.SEED : 1337;

function localMulberry32(seed) {
  let a = seed | 0;
  return function random() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const mulberry32 = typeof utils.mulberry32 === 'function' ? utils.mulberry32 : localMulberry32;
const clamp = typeof utils.clamp === 'function'
  ? utils.clamp
  : (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const ROAD_LINES = [-208, -156, -104, -52, 0, 52, 104, 156, 208];
const TARGET_COUNT = 24;
const BOUND_X = 300;
const BOUND_Z = 250;

const SHIRTS = [0xe74c3c, 0x3498db, 0x2ecc71, 0xf1c40f, 0x9b59b6, 0xe67e22, 0x1abc9c, 0xecf0f1, 0xfd79a8, 0x00cec9, 0xff7675, 0x74b9ff];
const PANTS = [0x2c3e50, 0x34495e, 0x7f8c8d, 0x2d3436, 0x6c5ce7, 0x636e72, 0x4a2c2a];
const SKINS = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac];

// ---------------------------------------------------------------------------
// Person mesh: torso box, head sphere, swinging legs/arms. ~1.9 units tall.
// ---------------------------------------------------------------------------
function buildPersonMesh(rng, shirtColor, pantsColor) {
  const group = new THREE.Group();
  const shirt = shirtColor !== undefined ? shirtColor : SHIRTS[Math.floor(rng() * SHIRTS.length)];
  const pants = pantsColor !== undefined ? pantsColor : PANTS[Math.floor(rng() * PANTS.length)];
  const skin = SKINS[Math.floor(rng() * SKINS.length)];

  const matShirt = new THREE.MeshLambertMaterial({ color: shirt });
  const matPants = new THREE.MeshLambertMaterial({ color: pants });
  const matSkin = new THREE.MeshLambertMaterial({ color: skin });

  // Legs pivot at the hip: geometry translated so the mesh origin is the top.
  const legGeo = new THREE.BoxGeometry(0.17, 0.8, 0.22);
  legGeo.translate(0, -0.4, 0);
  const legL = new THREE.Mesh(legGeo, matPants);
  legL.position.set(-0.11, 0.8, 0);
  const legR = new THREE.Mesh(legGeo, matPants);
  legR.position.set(0.11, 0.8, 0);
  group.add(legL, legR);

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.68, 0.3), matShirt);
  torso.position.y = 1.14;
  group.add(torso);

  const armGeo = new THREE.BoxGeometry(0.14, 0.62, 0.16);
  armGeo.translate(0, -0.31, 0);
  const armL = new THREE.Mesh(armGeo, matShirt);
  armL.position.set(-0.36, 1.44, 0);
  const armR = new THREE.Mesh(armGeo, matShirt);
  armR.position.set(0.36, 1.44, 0);
  group.add(armL, armR);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), matSkin);
  head.position.y = 1.7;
  group.add(head);

  group.userData.legL = legL;
  group.userData.legR = legR;
  group.userData.armL = armL;
  group.userData.armR = armR;
  return group;
}

function nearestRoadLine(v) {
  let best = ROAD_LINES[0];
  let bestD = Math.abs(v - best);
  for (const line of ROAD_LINES) {
    const d = Math.abs(v - line);
    if (d < bestD) { bestD = d; best = line; }
  }
  return best;
}

// A sidewalk spot: just off a road centreline (roads are 12 wide, so the kerb
// is at +/-6; sidewalks sit at roughly +/-7.5).
function randomSidewalkPos(rng) {
  const line = ROAD_LINES[Math.floor(rng() * ROAD_LINES.length)];
  const along = (rng() * 2 - 1) * 240;
  const side = (rng() < 0.5 ? -1 : 1) * 7.5;
  if (rng() < 0.5) return { x: line + side, z: along };
  return { x: along, z: line + side };
}

// A sidewalk spot at distance [minD, maxD] from (cx, cz), snapped to the
// nearest road so the ped lands on a kerb, not inside a building.
function sidewalkPosNear(rng, cx, cz, minD, maxD) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const angle = rng() * Math.PI * 2;
    const dist = minD + rng() * (maxD - minD);
    let x = clamp(cx + Math.sin(angle) * dist, -BOUND_X + 8, BOUND_X - 8);
    let z = clamp(cz + Math.cos(angle) * dist, -BOUND_Z + 8, BOUND_Z - 8);
    if (rng() < 0.5) {
      x = nearestRoadLine(x) + (rng() < 0.5 ? -7.5 : 7.5);
    } else {
      z = nearestRoadLine(z) + (rng() < 0.5 ? -7.5 : 7.5);
    }
    x = clamp(x, -BOUND_X + 8, BOUND_X - 8);
    z = clamp(z, -BOUND_Z + 8, BOUND_Z - 8);
    return { x, z };
  }
  return { x: clamp(cx + minD, -BOUND_X + 8, BOUND_X - 8), z: clamp(cz, -BOUND_Z + 8, BOUND_Z - 8) };
}

export function spawnPed(G, x, z) {
  if (!G || !G.scene) return null;
  if (!G.peds) G.peds = { list: [] };
  const rng = G.peds._rng || Math.random;
  const mesh = buildPersonMesh(rng);
  mesh.position.set(x, 0, z);
  mesh.userData.ped = null; // filled below, after the ped object exists
  G.scene.add(mesh);
  // Start walking along a road: one of the four cardinal headings.
  const heading = (Math.PI / 2) * Math.floor(rng() * 4);
  const ped = {
    mesh,
    pos: new THREE.Vector3(x, 0, z),
    heading,
    speed: 1.2 + rng() * 0.8,
    state: 'walk', // 'walk' | 'flee' | 'dead'
    fleeTimer: 0,
    fleeX: 0,
    fleeZ: 0,
    deadTimer: 0,
    fadeTimer: 0,
    walkPhase: rng() * Math.PI * 2,
    turnCooldown: 0,
  };
  mesh.userData.ped = ped;
  mesh.rotation.y = heading;
  G.peds.list.push(ped);
  return ped;
}

function killPed(G, ped) {
  if (ped.state === 'dead') return;
  ped.state = 'dead';
  ped.deadTimer = 0;
  ped.fadeTimer = 0;
  // Stop the walk swing; the fall is animated in update().
  ped.mesh.userData.legL.rotation.x = 0;
  ped.mesh.userData.legR.rotation.x = 0;
  ped.mesh.userData.armL.rotation.x = 0;
  ped.mesh.userData.armR.rotation.x = 0;
}

function fadeOutAndRemove(G, ped) {
  ped.mesh.traverse((child) => {
    if (child.isMesh && child.material) {
      child.material.transparent = true;
      child.material.opacity = Math.max(0, 1 - ped.fadeTimer);
    }
  });
  if (ped.fadeTimer >= 1) {
    G.scene.remove(ped.mesh);
    const idx = G.peds.list.indexOf(ped);
    if (idx >= 0) G.peds.list.splice(idx, 1);
  }
}

function init(G) {
  G.peds = { list: [], _rng: mulberry32(SEED + 5) };
  const rng = G.peds._rng;
  for (let i = 0; i < TARGET_COUNT; i++) {
    const spot = randomSidewalkPos(rng);
    spawnPed(G, spot.x, spot.z);
  }
}

function update(G, dt) {
  if (!G || !G.peds || !G.peds.list) return;
  const list = G.peds.list;
  const playerPos = G.player ? G.player.pos : null;
  const shotRecently = !!(G.combat && G.time !== undefined && (G.time - G.combat.lastShotAt) < 3);
  const cars = (G.vehicles && G.vehicles.list) || [];
  const collide = (G.city && G.city.collideCircle)
    ? (x, z, r) => G.city.collideCircle(x, z, r)
    : () => false;

  for (let i = list.length - 1; i >= 0; i--) {
    const ped = list[i];

    if (ped.state === 'dead') {
      ped.deadTimer += dt;
      // Fall over backwards over ~0.35 s, then lie flat.
      const fall = Math.min(1, ped.deadTimer / 0.35);
      ped.mesh.rotation.x = -Math.PI / 2 * fall;
      if (ped.deadTimer > 10) {
        ped.fadeTimer += dt;
        fadeOutAndRemove(G, ped);
      }
      continue;
    }

    // --- Threat detection -------------------------------------------------
    if (ped.state === 'walk') {
      if (shotRecently && playerPos) {
        ped.state = 'flee';
        ped.fleeTimer = 4;
        ped.fleeX = ped.pos.x - playerPos.x;
        ped.fleeZ = ped.pos.z - playerPos.z;
      } else {
        for (const car of cars) {
          if (!car || !car.pos || Math.abs(car.speed || 0) < 8) continue;
          const dx = ped.pos.x - car.pos.x;
          const dz = ped.pos.z - car.pos.z;
          const dist = Math.hypot(dx, dz);
          if (dist > 14 || dist < 0.001) continue;
          // Is the car heading toward the ped?
          const fx = Math.sin(car.heading || 0);
          const fz = Math.cos(car.heading || 0);
          if ((dx / dist) * fx + (dz / dist) * fz > 0.6) {
            ped.state = 'flee';
            ped.fleeTimer = 4;
            ped.fleeX = dx;
            ped.fleeZ = dz;
            break;
          }
        }
      }
    }

    // --- Movement ---------------------------------------------------------
    let moveSpeed = ped.speed;
    if (ped.state === 'flee') {
      ped.fleeTimer -= dt;
      moveSpeed = 5;
      const len = Math.hypot(ped.fleeX, ped.fleeZ) || 1;
      const wantHeading = Math.atan2(ped.fleeX / len, ped.fleeZ / len);
      // Turn toward the flee direction, fastest way round.
      let diff = wantHeading - ped.heading;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      ped.heading += clamp(diff, -6 * dt, 6 * dt);
      if (ped.fleeTimer <= 0) ped.state = 'walk';
    } else {
      // Stroll: keep walking; at an intersection sometimes turn 90 degrees.
      ped.turnCooldown -= dt;
      if (ped.turnCooldown <= 0) {
        const nearX = Math.abs(ped.pos.x - nearestRoadLine(ped.pos.x)) < 4;
        const nearZ = Math.abs(ped.pos.z - nearestRoadLine(ped.pos.z)) < 4;
        if (nearX && nearZ && Math.random() < 0.6) {
          ped.heading += (Math.random() < 0.5 ? -1 : 1) * Math.PI / 2;
          ped.turnCooldown = 2 + Math.random() * 3;
        }
      }
    }

    const stepX = Math.sin(ped.heading) * moveSpeed * dt;
    const stepZ = Math.cos(ped.heading) * moveSpeed * dt;
    const nextX = ped.pos.x + stepX;
    const nextZ = ped.pos.z + stepZ;
    // Blocked by a building, or leaving the playable area: turn around.
    if (collide(nextX, nextZ, 0.6) ||
        Math.abs(nextX) > BOUND_X - 4 || Math.abs(nextZ) > BOUND_Z - 4) {
      ped.heading += Math.PI / 2 * (Math.random() < 0.5 ? 1 : -1);
      if (ped.state === 'flee') ped.fleeTimer = Math.min(ped.fleeTimer, 1);
    } else {
      ped.pos.x = nextX;
      ped.pos.z = nextZ;
    }

    // Walk-cycle swing, faster when fleeing.
    ped.walkPhase += dt * moveSpeed * 4.2;
    const swing = Math.sin(ped.walkPhase) * (ped.state === 'flee' ? 0.85 : 0.5);
    ped.mesh.userData.legL.rotation.x = swing;
    ped.mesh.userData.legR.rotation.x = -swing;
    ped.mesh.userData.armL.rotation.x = -swing * 0.7;
    ped.mesh.userData.armR.rotation.x = swing * 0.7;
    ped.mesh.position.copy(ped.pos);
    ped.mesh.position.y = Math.abs(Math.sin(ped.walkPhase)) * 0.04;
    ped.mesh.rotation.y = ped.heading;

    // --- Run over by a car? ----------------------------------------------
    for (const car of cars) {
      if (!car || !car.pos) continue;
      const dx = ped.pos.x - car.pos.x;
      const dz = ped.pos.z - car.pos.z;
      if (Math.hypot(dx, dz) < 2.2 && Math.abs(car.speed || 0) > 6) {
        killPed(G, ped);
        if (car.player) {
          if (G.police && typeof G.police.addWanted === 'function') G.police.addWanted(1);
          if (G.hud) G.hud.message('Pedestrian down!');
        }
        break;
      }
    }
  }

  // --- Keep the crowd topped up near the player ---------------------------
  let alive = 0;
  for (const ped of list) if (ped.state !== 'dead') alive++;
  if (alive < TARGET_COUNT && playerPos) {
    const rng = G.peds._rng || Math.random;
    const spot = sidewalkPosNear(rng, playerPos.x, playerPos.z, 60, 120);
    if (!collide(spot.x, spot.z, 1)) spawnPed(G, spot.x, spot.z);
  }
}

export { init, update };

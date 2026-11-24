// CAYO VERDE — deterministic screenshot scenes behind ?shot=<name>.
// Each scene places the player, cars, cops and enemies at fixed positions
// (no RNG anywhere), then runs the real sim forward ~2 s in fixed 0.05 s
// steps so traffic and pedestrians settle into natural poses. Any unknown
// name falls back to 'city'. Returns { ready: true }.
//
// Scenes: chase | city | mission | combat
import { start as startMission, update as updateMissions } from './missions.js';
import { update as updateCity } from './city.js';
import { update as updatePlayer } from './player.js';
import { update as updateVehicles } from './vehicles.js';
import { update as updatePedestrians, spawnPed } from './pedestrians.js';
import { update as updatePolice } from './police.js';
import { update as updateCombat, spawnEnemy } from './combat.js';
import { update as updateHud } from './hud.js';

const SETTLE_SECONDS = 2;
const SETTLE_DT = 0.05;

function forwardOf(heading) {
  return { x: Math.sin(heading), z: Math.cos(heading) };
}

function placePlayer(G, x, z, heading) {
  if (!G.player || !G.player.pos) return;
  G.player.pos.set(x, 0, z);
  G.player.heading = heading;
  if (G.player.mesh) {
    G.player.mesh.position.set(x, 0, z);
    G.player.mesh.rotation.y = heading;
  }
}

function spawnCarSafe(G, x, z, opts) {
  try {
    if (G.vehicles && typeof G.vehicles.spawnCar === 'function') {
      return G.vehicles.spawnCar(G, x, z, opts || {}) || null;
    }
  } catch {
    // A failed spawn must not break the shot.
  }
  return null;
}

function putPlayerInCar(G, car, speed) {
  if (!car || !G.player) return;
  G.player.car = car;
  G.player.onFoot = false;
  // The staged car is driven by its traffic AI, not by drivePlayerCar
  // (which would coast to a stop with no keys held), so leave car.player
  // false — player.update's driving branch only needs G.player.car set.
  car.player = false;
  if (typeof speed === 'number') {
    G.player.speed = speed;
    try { car.speed = speed; } catch { /* read-only speed: ignore */ }
  }
  const pos = car.pos || (car.mesh && car.mesh.position);
  if (pos && G.player.pos) G.player.pos.set(pos.x, 0, pos.z);
  if (typeof car.heading === 'number') G.player.heading = car.heading;
  if (G.player.mesh) G.player.mesh.visible = false;
}

// Remove every car matching `test` from the scene and the vehicles list —
// staging cleanup so a staged drive has a clear road ahead. Staged cars
// sit outside the cleared stretch, so they are never matched.
function clearCars(G, test) {
  if (!G.vehicles || !Array.isArray(G.vehicles.list)) return;
  const list = G.vehicles.list;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const car = list[i];
    let match = false;
    try { match = !!test(car); } catch { match = false; }
    if (!match) continue;
    try {
      if (car.mesh && G.scene) G.scene.remove(car.mesh);
    } catch { /* ignore */ }
    list.splice(i, 1);
  }
}

function spawnPedSafe(G, x, z) {
  try {
    spawnPed(G, x, z);
  } catch {
    // Pedestrians are dressing; a failed spawn must not break the shot.
  }
}

function setObjective(G, text) {
  if (G.hud && typeof G.hud.setObjective === 'function') G.hud.setObjective(text);
  else if (G.missions) G.missions.objective = text;
}

/** Run every module's update in fixed steps so the scene settles (same order as the main loop). */
function stepSim(G, seconds) {
  const steps = Math.round(seconds / SETTLE_DT);
  const updaters = [updateCity, updatePlayer, updateVehicles, updatePedestrians, updatePolice, updateCombat, updateMissions, updateHud];
  for (let i = 0; i < steps; i += 1) {
    G.time = (G.time || 0) + SETTLE_DT;
    for (const update of updaters) {
      try {
        update(G, SETTLE_DT);
      } catch {
        // One module struggling mid-staging must not kill the shot.
      }
    }
  }
}

/** Park the camera behind the player, looking ahead down their heading. */
function placeCameraBehind(G, distance, height) {
  if (!G.camera || !G.player || !G.player.pos) return;
  const heading = typeof G.player.heading === 'number' ? G.player.heading : 0;
  const fwd = forwardOf(heading);
  const px = G.player.pos.x;
  const pz = G.player.pos.z;
  G.camera.position.set(px - fwd.x * distance, height, pz - fwd.z * distance);
  G.camera.lookAt(px + fwd.x * 8, 1.5, pz + fwd.z * 8);
}

function hideMenus() {
  // Screens hide with the .hidden class (display:none !important), the
  // same convention main.js uses — inline styles alone cannot override it.
  try {
    for (const id of ['start-screen', 'pause-screen', 'gameover-screen']) {
      const el = document.getElementById(id);
      if (el && el.classList) el.classList.add('hidden');
    }
    const hud = document.getElementById('hud');
    if (hud && hud.classList) hud.classList.remove('hidden');
  } catch {
    // No DOM (headless check): nothing to hide.
  }
}

function baseState(G) {
  G.state = 'play';
  G.time = 0;
  G.money = 1250;
  if (G.player) {
    G.player.health = 100;
    G.player.alive = true;
    G.player.speed = 0;
    G.player.onFoot = true;
    G.player.car = null;
  }
  if (G.audio && typeof G.audio.siren === 'function') {
    try { G.audio.siren(false); } catch { /* ignore */ }
  }
  // No police reinforcements during a shot: the staged scenes place their
  // own cars, and the force spawner would send cars that ram the frame
  // (or, on foot, bust the player before the capture).
  if (G.police) G.police.spawnTimer = 9999;
  hideMenus();
}

function sceneChase(G) {
  // Red sportscar fleeing down road x=0 at 24 m/s, two cop cars flanking
  // it in formation — all three on explicit traffic AI (same road, same
  // speed, no turns) so they hold station instead of wandering. The cops
  // are plain police-style traffic cars, NOT registered with
  // police.update: its pursuit steering would slow them to 10 m/s and
  // drop them out of frame. The force spawner is suppressed in baseState,
  // so no extra cars join the chase. The run starts at z=-104 so the car
  // cannot reach the first mission's start beacon (0, 52) before capture.
  baseState(G);
  G.wanted = 3;
  const car = spawnCarSafe(G, 0, -104, {
    color: 0xd21f2b, sport: true, heading: 0,
    ai: { axis: 'z', dir: 1, lane: -2.5, cruise: 24, turnCd: 999 },
  });
  if (car) {
    putPlayerInCar(G, car, 24);
  } else {
    placePlayer(G, 0, -104, 0);
    G.player.speed = 0;
  }
  // Flanking cops, one lane each side of the player car (4.5 units clear,
  // so the collision push never fires), already at pace — the AI only
  // accelerates at 6 m/s^2, so a standing start would drop them behind.
  const copA = spawnCarSafe(G, -4.5, -104, {
    style: 'police', police: true, heading: 0,
    ai: { axis: 'z', dir: 1, lane: -7, cruise: 24, turnCd: 999 },
  });
  const copB = spawnCarSafe(G, 4.5, -104, {
    style: 'police', police: true, heading: 0,
    ai: { axis: 'z', dir: 1, lane: 2, cruise: 24, turnCd: 999 },
  });
  for (const cop of [copA, copB]) {
    if (cop) { try { cop.speed = 24; } catch { /* ignore */ } }
  }
  // Clear the road ahead so nothing makes the chase brake mid-shot.
  clearCars(G, (c) => Math.abs(c.pos.x) < 14 && c.pos.z > -102 && c.pos.z < 150);
  setObjective(G, 'Lose the cops!');
  if (G.missions) G.missions.markerPos = null;
  stepSim(G, SETTLE_SECONDS);
  placeCameraBehind(G, 11, 4.5);
}

function sceneCity(G) {
  // Leo on foot at the 0,0 intersection at dusk, traffic and peds around.
  baseState(G);
  G.wanted = 0;
  placePlayer(G, 0, 0, 0);
  spawnCarSafe(G, 0, -52, { color: 0x2e6fd8, heading: 0 });
  spawnCarSafe(G, 0, 104, { color: 0xd8d8d8, heading: Math.PI });
  spawnCarSafe(G, -104, 0, { color: 0xd8a02e, heading: Math.PI / 2 });
  spawnCarSafe(G, 52, -104, { color: 0x3aa655, heading: -Math.PI / 2 });
  spawnPedSafe(G, 6, 10);
  spawnPedSafe(G, -8, -14);
  spawnPedSafe(G, 12, -6);
  spawnPedSafe(G, -5, 20);
  setObjective(G, 'Free roam');
  stepSim(G, SETTLE_SECONDS);
  placeCameraBehind(G, 9, 4);
}

function sceneMission(G) {
  // Mission 2 (The Drop) active: Leo driving toward the port, beacon ahead.
  // The car starts at x=52 so it cannot reach the port (208, -104) and
  // complete the mission before the capture.
  baseState(G);
  G.wanted = 0;
  try {
    startMission(1);
  } catch {
    // If the mission cannot start, the shot still stages as a drive.
  }
  const car = spawnCarSafe(G, 52, -104, {
    color: 0xd21f2b, sport: true, heading: Math.PI / 2,
    ai: { axis: 'x', dir: 1, lane: -104, cruise: 20, turnCd: 999 },
  });
  if (car) {
    putPlayerInCar(G, car, 20);
  } else {
    placePlayer(G, 52, -104, Math.PI / 2);
    G.player.speed = 0;
  }
  // Clear the port road ahead so the drive holds its speed.
  clearCars(G, (c) => c !== car && Math.abs(c.pos.z + 104) < 14 && c.pos.x > 54 && c.pos.x < 260);
  setObjective(G, 'Deliver the package to the port');
  stepSim(G, SETTLE_SECONDS);
  placeCameraBehind(G, 11, 4.5);
}

function sceneCombat(G) {
  // Leo on foot, three rivals ahead, one tracer mid-flight, wanted 2.
  baseState(G);
  G.wanted = 2;
  placePlayer(G, 0, 0, 0);
  const enemySpots = [[6, 18], [-8, 22], [2, 25]];
  for (const [x, z] of enemySpots) {
    try {
      spawnEnemy(G, x, z);
    } catch {
      // A failed spawn must not break the shot.
    }
  }
  if (G.combat) G.combat.lastShotAt = G.time || 0;
  // One mid-shot tracer: a short bright line from Leo toward the first rival.
  try {
    if (globalThis.THREE && G.scene && G.player && G.player.pos) {
      const material = new globalThis.THREE.LineBasicMaterial({ color: 0xffe600 });
      const geometry = new globalThis.THREE.BufferGeometry().setFromPoints([
        new globalThis.THREE.Vector3(G.player.pos.x, 1.4, G.player.pos.z + 2),
        new globalThis.THREE.Vector3(6, 1.4, 18),
      ]);
      const tracer = new globalThis.THREE.Line(geometry, material);
      G.scene.add(tracer);
    }
  } catch {
    // Dressing only.
  }
  setObjective(G, 'Take down the rivals');
  stepSim(G, SETTLE_SECONDS);
  placeCameraBehind(G, 6, 3);
}

/**
 * Stage the named scene (chase | city | mission | combat; anything else is
 * 'city') and return { ready: true }.
 */
export function stageShot(name, G) {
  if (!G || !G.player || !G.scene) return { ready: true };
  if (name === 'chase') sceneChase(G);
  else if (name === 'mission') sceneMission(G);
  else if (name === 'combat') sceneCombat(G);
  else sceneCity(G);
  return { ready: true };
}

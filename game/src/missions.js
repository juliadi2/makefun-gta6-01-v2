// CAYO VERDE — story missions. Leo Marin, a wheelman new in Cayo Verde,
// works his way up through four jobs from Mama Rosa, Vic Delgado and Sana.
// Missions unlock in order; between jobs the player free-roams. A yellow
// 3D beacon (cylinder of light + floating diamond) marks the next job's
// start — walking or driving into it starts the mission. The active step's
// target gets a cyan beacon, and G.missions.markerPos feeds the minimap.
//
// Step kinds:
//   enterCar    — complete when the player is driving any car
//   reach       — complete within radius of (x, z); may setWanted on arrival
//   clearWanted — complete when the wanted level drops back to 0

export const FREE_ROAM_TEXT = 'Free roam \u2014 head to the yellow marker';

const START_RADIUS = 8;
const CARD_SECONDS = 6;

export const MISSIONS = [
  {
    id: 'first-wheels',
    title: 'First Wheels',
    giver: 'Mama Rosa',
    brief: 'Leo needs wheels before anyone in Cayo Verde takes him seriously. Borrow a car — any car — and bring it round to my diner.',
    reward: 200,
    start: { x: 0, z: 52 },
    steps: [
      { kind: 'enterCar', text: 'Steal a car' },
      { kind: 'reach', x: 104, z: 52, radius: 10, text: "Drive to Rosa's Diner" },
    ],
  },
  {
    id: 'the-drop',
    title: 'The Drop',
    giver: 'Vic Delgado',
    brief: 'A package needs to reach the port, and it needs to get there fast. Two and a half minutes, Leo. Don\'t keep the buyer waiting.',
    reward: 400,
    start: { x: 104, z: 52 },
    timeLimit: 150,
    steps: [
      { kind: 'reach', x: 208, z: -104, radius: 10, text: 'Deliver the package to the port' },
    ],
  },
  {
    id: 'heat-wave',
    title: 'Heat Wave',
    giver: 'Sana',
    brief: 'The cops are crawling all over my grid tonight. Draw them off, stay loose, and don\'t get caught until the heat dies down.',
    reward: 500,
    start: { x: 0, z: -104 },
    setWantedAtStart: 3,
    steps: [
      { kind: 'clearWanted', text: 'Survive the heat until your wanted level clears' },
    ],
  },
  {
    id: 'the-getaway',
    title: 'The Getaway',
    giver: 'Vic Delgado',
    brief: 'Vic is pinned down and needs a wheelman, now. Pick him up, lose whoever follows, and get him to the safehouse in one piece.',
    reward: 800,
    start: { x: -104, z: 104 },
    steps: [
      { kind: 'reach', x: -104, z: -52, radius: 10, text: 'Pick up Vic', setWanted: 2 },
      { kind: 'reach', x: -208, z: 156, radius: 10, text: 'Escape to the safehouse' },
    ],
  },
];

let Gref = null;
let beaconGroup = null;
let startBeacon = null;
let objectiveBeacon = null;
let cardEl = null;
let cardTitleEl = null;
let cardBriefEl = null;

let doneIds = [];
let current = null;
let stepIndex = 0;
let timeLeft = Infinity;
let cardTimer = 0;
let triedLoad = false;
let retriedLoad = false;
// Fallback for partial integration: with no police module the wanted level
// would never clear on its own, so Heat Wave cools off after 30 s.
let clearWantedFallback = 0;

function showMessage(G, text) {
  if (G && G.hud && typeof G.hud.message === 'function') G.hud.message(text);
}

function chime(G) {
  if (G && G.audio && typeof G.audio.pickup === 'function') G.audio.pickup();
}

function setWanted(G, level) {
  if (!G) return;
  if (G.police && typeof G.police.addWanted === 'function' && (G.wanted || 0) < level) {
    G.police.addWanted(level - (G.wanted || 0));
  } else {
    G.wanted = Math.max(G.wanted || 0, level);
  }
}

function nextMission() {
  for (const m of MISSIONS) {
    if (!doneIds.includes(m.id)) return m;
  }
  return null;
}

function currentStep() {
  if (!current) return null;
  return current.steps[stepIndex] || null;
}

function stepTarget(step) {
  if (!step) return null;
  if (step.kind === 'reach' && typeof step.x === 'number') return { x: step.x, z: step.z };
  return null;
}

function formatTimeLeft(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function refreshObjective(G) {
  if (!G || !G.missions) return;
  const step = currentStep();
  if (current && step) {
    let text = step.text;
    if (current.timeLimit) text += ' \u2014 ' + formatTimeLeft(timeLeft);
    G.missions.objective = text;
  } else if (!current) {
    G.missions.objective = nextMission() ? FREE_ROAM_TEXT : 'All missions complete \u2014 free roam!';
  }
}

function refreshMarkers(G) {
  if (!G || !G.missions) return;
  const step = currentStep();
  const target = stepTarget(step);
  if (current && target) {
    G.missions.markerPos = { x: target.x, z: target.z };
  } else if (!current) {
    const next = nextMission();
    G.missions.markerPos = next ? { x: next.start.x, z: next.start.z } : null;
  } else {
    G.missions.markerPos = null;
  }
  if (startBeacon) {
    const next = nextMission();
    const show = !current && !!next;
    startBeacon.group.visible = show;
    if (show) startBeacon.group.position.set(next.start.x, 0, next.start.z);
  }
  if (objectiveBeacon) {
    const show = !!(current && target);
    objectiveBeacon.group.visible = show;
    if (show) objectiveBeacon.group.position.set(target.x, 0, target.z);
  }
}

function makeBeacon(color) {
  const THREE = globalThis.THREE;
  const group = new THREE.Group();
  const beamMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.22,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.8, 34, 16, 1, true), beamMat);
  beam.position.y = 17;
  group.add(beam);
  const diamond = new THREE.Mesh(
    new THREE.OctahedronGeometry(1.3),
    new THREE.MeshBasicMaterial({ color })
  );
  diamond.position.y = 6;
  group.add(diamond);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(2.4, 3.1, 32),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.15;
  group.add(ring);
  return { group, diamond, beamMat };
}

function showEl(element) {
  if (!element) return;
  if (element.classList) element.classList.remove('hidden');
  element.style.display = 'block';
}

function hideEl(element) {
  if (!element) return;
  if (element.classList) element.classList.add('hidden');
  element.style.display = 'none';
}

function showCard(mission) {
  if (!cardEl) return;
  if (cardTitleEl) cardTitleEl.textContent = mission.title + ' \u2014 ' + mission.giver;
  if (cardBriefEl) cardBriefEl.textContent = mission.brief;
  showEl(cardEl);
  cardTimer = CARD_SECONDS;
}

function hideCard() {
  hideEl(cardEl);
  cardTimer = 0;
}

/** Start mission i (index into MISSIONS, or an id string). Returns false if it cannot start. */
export function start(i) {
  const G = Gref;
  if (!G || current) return false;
  const mission = typeof i === 'string'
    ? MISSIONS.find((m) => m.id === i)
    : MISSIONS[i];
  if (!mission || doneIds.includes(mission.id)) return false;
  if (G.player && G.player.alive === false) return false;

  current = mission;
  stepIndex = 0;
  timeLeft = mission.timeLimit || Infinity;
  clearWantedFallback = 0;
  if (mission.setWantedAtStart) setWanted(G, mission.setWantedAtStart);

  if (G.missions) G.missions.current = mission;
  showCard(mission);
  showMessage(G, 'Mission started: ' + mission.title);
  chime(G);
  refreshObjective(G);
  refreshMarkers(G);
  return true;
}

function completeMission(G) {
  const mission = current;
  current = null;
  if (G.missions) G.missions.current = null;
  doneIds.push(mission.id);
  if (G.missions) G.missions.doneIds = [...doneIds];
  G.money = (typeof G.money === 'number' ? G.money : 0) + mission.reward;
  showMessage(G, 'Mission complete: ' + mission.title + ' \u2014 $' + mission.reward);
  chime(G);
  if (G.save && typeof G.save.save === 'function') G.save.save(G);
  refreshObjective(G);
  refreshMarkers(G);
}

function failMission(G, reason) {
  const mission = current;
  current = null;
  if (G.missions) G.missions.current = null;
  showMessage(G, 'Mission failed: ' + mission.title + ' \u2014 ' + reason + ' Return to the yellow marker to retry.');
  refreshObjective(G);
  refreshMarkers(G);
}

/**
 * Full reset for a fresh run (retry after game over, when the save has
 * been cleared): no active mission, no completed missions, card hidden.
 */
export function reset(G) {
  current = null;
  stepIndex = 0;
  timeLeft = Infinity;
  clearWantedFallback = 0;
  doneIds = [];
  hideCard();
  const target = G || Gref;
  if (target && target.missions) {
    target.missions.current = null;
    target.missions.doneIds = [];
  }
  if (target) {
    refreshObjective(target);
    refreshMarkers(target);
  }
}

function advanceStep(G) {
  const mission = current;
  stepIndex += 1;
  if (stepIndex >= mission.steps.length) {
    completeMission(G);
    return;
  }
  showMessage(G, 'Objective complete.');
  chime(G);
  refreshObjective(G);
  refreshMarkers(G);
}

function distToPlayer(G, x, z) {
  if (!G.player || !G.player.pos) return Infinity;
  const dx = G.player.pos.x - x;
  const dz = G.player.pos.z - z;
  return Math.sqrt(dx * dx + dz * dz);
}

export function init(G) {
  Gref = G;
  if (!G) return;

  // Mission card elements (guarded: the card is optional chrome).
  try {
    cardEl = document.getElementById('mission-card');
    cardTitleEl = document.getElementById('mission-title');
    cardBriefEl = document.getElementById('mission-brief');
  } catch {
    cardEl = null;
    cardTitleEl = null;
    cardBriefEl = null;
  }

  // Restore completed missions from a save, when one is there.
  if (!triedLoad) {
    triedLoad = true;
    try {
      if (G.save && typeof G.save.load === 'function') {
        const data = G.save.load();
        if (data && Array.isArray(data.missionsDone)) {
          doneIds = data.missionsDone.filter((id) => MISSIONS.some((m) => m.id === id));
        }
      }
    } catch {
      // Corrupt save: start fresh.
    }
  }

  G.missions = {
    list: MISSIONS,
    current: null,
    objective: FREE_ROAM_TEXT,
    markerPos: null,
    doneIds: [...doneIds],
    start,
  };

  // Beacons: one group holding the start beacon (yellow) and the active
  // objective beacon (cyan). Built only when THREE is present.
  try {
    if (globalThis.THREE && G.scene) {
      beaconGroup = new globalThis.THREE.Group();
      startBeacon = makeBeacon(0xffe600);
      objectiveBeacon = makeBeacon(0x35e0ff);
      beaconGroup.add(startBeacon.group);
      beaconGroup.add(objectiveBeacon.group);
      G.scene.add(beaconGroup);
    }
  } catch {
    beaconGroup = null;
    startBeacon = null;
    objectiveBeacon = null;
  }

  refreshObjective(G);
  refreshMarkers(G);
}

export function update(G, dt) {
  if (!G) return;
  Gref = G;
  const step = dt || 0;

  // If no save was readable at init (save module not wired yet), retry once
  // the save is available — but only before any mission has been completed.
  if (!retriedLoad && !current) {
    retriedLoad = true;
    try {
      if (G.save && typeof G.save.load === 'function') {
        const data = G.save.load();
        if (data && Array.isArray(data.missionsDone) && data.missionsDone.length > 0) {
          doneIds = data.missionsDone.filter((id) => MISSIONS.some((m) => m.id === id));
          if (G.missions) G.missions.doneIds = [...doneIds];
          refreshObjective(G);
          refreshMarkers(G);
        }
      }
    } catch {
      // Leave progress empty; a later retry is harmless.
    }
  }

  // Mission card auto-hide.
  if (cardTimer > 0) {
    cardTimer -= step;
    if (cardTimer <= 0) hideCard();
  }

  // Beacon life: spinning, bobbing diamonds; gently pulsing beams.
  const t = G.time || 0;
  for (const beacon of [startBeacon, objectiveBeacon]) {
    if (!beacon || !beacon.group.visible) continue;
    beacon.diamond.rotation.y += step * 1.5;
    beacon.diamond.position.y = 6 + Math.sin(t * 2) * 0.6;
    beacon.beamMat.opacity = 0.18 + 0.08 * Math.sin(t * 3);
  }

  if (!G.player || !G.player.pos) return;

  // No active mission: walking/driving into the next start beacon begins it.
  if (!current) {
    const next = nextMission();
    if (next && G.player.alive !== false && distToPlayer(G, next.start.x, next.start.z) <= START_RADIUS) {
      start(MISSIONS.indexOf(next));
    }
    return;
  }

  // Death fails the mission (the game-over screen is main.js's job).
  if (G.player.alive === false || (typeof G.player.health === 'number' && G.player.health <= 0)) {
    failMission(G, 'Leo went down.');
    return;
  }

  // Countdown missions fail when the clock runs out.
  if (current.timeLimit) {
    timeLeft -= step;
    if (timeLeft <= 0) {
      failMission(G, 'Out of time.');
      return;
    }
    refreshObjective(G);
  }

  const missionStep = currentStep();
  if (!missionStep) return;

  if (missionStep.kind === 'enterCar') {
    if (!G.player.onFoot) advanceStep(G);
    return;
  }

  if (missionStep.kind === 'reach') {
    if (distToPlayer(G, missionStep.x, missionStep.z) <= (missionStep.radius || 10)) {
      if (missionStep.setWanted) setWanted(G, missionStep.setWanted);
      advanceStep(G);
    }
    return;
  }

  if (missionStep.kind === 'clearWanted') {
    if ((G.wanted || 0) <= 0) {
      advanceStep(G);
      return;
    }
    // No police module to cool the heat: let it die down on its own.
    if (!G.police) {
      clearWantedFallback += step;
      if (clearWantedFallback >= 30) G.wanted = 0;
    }
  }
}

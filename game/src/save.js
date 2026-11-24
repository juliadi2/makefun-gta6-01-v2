// CAYO VERDE — save / load. One localStorage slot, written on mission
// completion (via saveNow) and autosaved every 30 s of play. Everything is
// guarded: when storage is unavailable the game just plays session-only.

export const SAVE_KEY = 'cayo-verde-save-v1';

const AUTOSAVE_EVERY = 30;

let autosaveTimer = 0;
let autosaveInterval = null;

function isPlaying(G) {
  return !G.state || G.state === 'play';
}

function readStorage() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage.getItem(SAVE_KEY);
  } catch {
    return null;
  }
}

function writeStorage(text) {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return false;
    window.localStorage.setItem(SAVE_KEY, text);
    return true;
  } catch {
    return false;
  }
}

/** Snapshot the run's progress and store it. Returns true when it stuck. */
export function save(G) {
  if (!G) return false;
  const doneIds = [];
  if (G.missions) {
    if (Array.isArray(G.missions.doneIds)) doneIds.push(...G.missions.doneIds);
    else if (Array.isArray(G.missions.list)) {
      for (const m of G.missions.list) if (m.done) doneIds.push(m.id);
    }
  }
  const data = {
    money: typeof G.money === 'number' ? Math.floor(G.money) : 0,
    missionsDone: doneIds,
    playerPos: G.player && G.player.pos
      ? { x: G.player.pos.x, z: G.player.pos.z }
      : { x: 0, z: 0 },
    wanted: typeof G.wanted === 'number' ? G.wanted : 0,
    time: typeof G.time === 'number' ? G.time : 0,
    savedAt: Date.now(),
  };
  try {
    return writeStorage(JSON.stringify(data));
  } catch {
    return false;
  }
}

/**
 * The saved snapshot, or null when there is none / it is unreadable.
 * When passed the live game object, the snapshot is also applied to it
 * (money, position, wanted level, clock, completed missions) — this is
 * how main.js's Continue path (save.load(G)) restores a run. Missions
 * also reads the snapshot directly at init, so applying twice is
 * consistent.
 */
export function load(G) {
  const raw = readStorage();
  if (!raw) return null;
  let data = null;
  try {
    data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
  } catch {
    return null;
  }
  if (G) {
    if (typeof data.money === 'number') G.money = data.money;
    if (typeof data.wanted === 'number') G.wanted = data.wanted;
    if (typeof data.time === 'number') G.time = data.time;
    if (data.playerPos && G.player && G.player.pos) {
      G.player.pos.set(data.playerPos.x || 0, 0, data.playerPos.z || 0);
      if (G.player.mesh) G.player.mesh.position.copy(G.player.pos);
    }
    if (Array.isArray(data.missionsDone) && G.missions) {
      G.missions.doneIds = [...data.missionsDone];
    }
  }
  return data;
}

/** Remove the saved game (game over: the next run starts fresh). */
export function clear() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return false;
    window.localStorage.removeItem(SAVE_KEY);
    return true;
  } catch {
    return false;
  }
}

/** True when a readable save exists. */
export function hasSave() {
  return load() !== null;
}

/** Immediate save (mission completion, quitting to menu). Same as save(G). */
export function saveNow(G) {
  return save(G);
}

export function init(G) {
  if (!G) return;
  G.save = { save, load, hasSave, saveNow, clear };
  autosaveTimer = 0;
  // The main loop does not call save.update, so autosave also runs on a
  // plain interval (created once): every 30 s while actually playing.
  // update() below keeps the same behaviour for loops that do call it;
  // saving twice is harmless — the snapshot is idempotent.
  if (autosaveInterval === null) {
    try {
      autosaveInterval = setInterval(() => {
        if (isPlaying(G)) save(G);
      }, AUTOSAVE_EVERY * 1000);
    } catch {
      autosaveInterval = null;
    }
  }
}

export function update(G, dt) {
  if (!G) return;
  // Only autosave while actually playing, not on menus / game over.
  if (!isPlaying(G)) return;
  autosaveTimer += dt || 0;
  if (autosaveTimer >= AUTOSAVE_EVERY) {
    autosaveTimer = 0;
    save(G);
  }
}

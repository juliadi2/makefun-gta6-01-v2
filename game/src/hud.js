// CAYO VERDE — HUD: health bar, money, wanted stars, speed, in-game clock,
// objective line, message feed, crosshair, and the live minimap canvas.
// All DOM lookups are guarded: a missing element just means that readout
// is skipped, never a crash.

const FREE_ROAM_TEXT = 'Free roam \u2014 head to the yellow marker';

// In-game clock: the day starts at 17:30 and 1 real second = 1 game minute.
const CLOCK_START_MINUTES = 17 * 60 + 30;

// Minimap: the whole playable city (|x| <= 300, |z| <= 250) on a 180x180
// canvas, north (-Z) up. 600 world units across -> 0.3 px per unit; the
// 500-unit height leaves 15 px of margin top and bottom.
const MAP_SCALE = 0.3;
const MAP_Y_OFF = 15;
const ROAD_LINES = [-208, -156, -104, -52, 0, 52, 104, 156, 208];

let Gref = null;
let el = {};
let mapCtx = null;

function $(id) {
  try {
    return document.getElementById(id);
  } catch {
    return null;
  }
}

function mapX(x) {
  return (x + 300) * MAP_SCALE;
}

function mapY(z) {
  return (z + 250) * MAP_SCALE + MAP_Y_OFF;
}

function posOf(entity) {
  if (!entity) return null;
  if (entity.pos) return entity.pos;
  // Car cops carry their position on the nested car object.
  if (entity.car) return posOf(entity.car);
  if (entity.mesh && entity.mesh.position) return entity.mesh.position;
  if (typeof entity.x === 'number' && typeof entity.z === 'number') return entity;
  return null;
}

/** Append a line to the message feed (max 5, each fades after 5 s). */
export function message(text) {
  const feed = el.messages;
  if (!feed) return;
  const line = document.createElement('div');
  line.className = 'msg';
  line.textContent = String(text);
  feed.appendChild(line);
  while (feed.children.length > 5) feed.removeChild(feed.firstChild);
  setTimeout(() => {
    line.style.transition = 'opacity 0.6s';
    line.style.opacity = '0';
    setTimeout(() => {
      if (line.parentNode === feed) feed.removeChild(line);
    }, 700);
  }, 5000);
}

/** Set the objective line, in state and on screen. */
export function setObjective(text) {
  if (Gref && Gref.missions) Gref.missions.objective = text;
  if (el.objective) el.objective.textContent = text;
}

function drawMinimap(G) {
  if (!mapCtx) return;
  const c = mapCtx;
  const W = 180;
  const H = 180;

  // Sand base.
  c.fillStyle = '#b39a68';
  c.fillRect(0, 0, W, H);

  // Water to the east (+X), with a beach strip in front of it.
  c.fillStyle = '#e8d9a8';
  c.fillRect(mapX(238), 0, W - mapX(238), H);
  c.fillStyle = '#14425e';
  c.fillRect(mapX(262), 0, W - mapX(262), H);

  // City blocks: muted slabs between the roads.
  c.fillStyle = '#7d7a68';
  for (let i = 0; i < ROAD_LINES.length - 1; i += 1) {
    for (let j = 0; j < ROAD_LINES.length - 1; j += 1) {
      const x0 = mapX(ROAD_LINES[i] + 6);
      const z0 = mapY(ROAD_LINES[j] + 6);
      const x1 = mapX(ROAD_LINES[i + 1] - 6);
      const z1 = mapY(ROAD_LINES[j + 1] - 6);
      c.fillRect(x0, z0, x1 - x0, z1 - z0);
    }
  }

  // Roads: dark lines on the grid.
  c.strokeStyle = '#33373f';
  c.lineWidth = 4;
  for (const line of ROAD_LINES) {
    c.beginPath();
    c.moveTo(mapX(line), 0);
    c.lineTo(mapX(line), H);
    c.stroke();
    c.beginPath();
    c.moveTo(0, mapY(line));
    c.lineTo(W, mapY(line));
    c.stroke();
  }

  // Nearby cars: small white dots.
  if (G.vehicles && Array.isArray(G.vehicles.list)) {
    c.fillStyle = '#ffffff';
    let drawn = 0;
    for (const car of G.vehicles.list) {
      if (drawn >= 40) break;
      const p = posOf(car);
      if (!p) continue;
      c.fillRect(mapX(p.x) - 1, mapY(p.z) - 1, 2, 2);
      drawn += 1;
    }
  }

  // Mission marker: yellow diamond.
  if (G.missions && G.missions.markerPos) {
    const m = G.missions.markerPos;
    const mx = mapX(m.x);
    const my = mapY(m.z);
    c.fillStyle = '#ffe600';
    c.beginPath();
    c.moveTo(mx, my - 5);
    c.lineTo(mx + 4, my);
    c.lineTo(mx, my + 5);
    c.lineTo(mx - 4, my);
    c.closePath();
    c.fill();
    c.strokeStyle = '#000000';
    c.lineWidth = 1;
    c.stroke();
  }

  // Police: flashing blue/red dots.
  if (G.police && Array.isArray(G.police.cops)) {
    const flashBlue = Math.floor((G.time || 0) * 2) % 2 === 0;
    c.fillStyle = flashBlue ? '#3a86ff' : '#ff3b30';
    for (const cop of G.police.cops) {
      const p = posOf(cop);
      if (!p) continue;
      c.beginPath();
      c.arc(mapX(p.x), mapY(p.z), 3, 0, Math.PI * 2);
      c.fill();
    }
  }

  // Player: white triangle rotated by heading (red while wanted).
  if (G.player && G.player.pos) {
    const px = mapX(G.player.pos.x);
    const py = mapY(G.player.pos.z);
    const heading = typeof G.player.heading === 'number' ? G.player.heading : 0;
    c.save();
    c.translate(px, py);
    // The triangle is drawn pointing up (north, -Z); heading 0 faces +Z
    // (south), so rotate by PI - heading.
    c.rotate(Math.PI - heading);
    c.fillStyle = (G.wanted || 0) > 0 ? '#ff3b30' : '#ffffff';
    c.beginPath();
    c.moveTo(0, -6);
    c.lineTo(4.5, 5);
    c.lineTo(-4.5, 5);
    c.closePath();
    c.fill();
    c.strokeStyle = '#000000';
    c.lineWidth = 1;
    c.stroke();
    c.restore();
  }
}

export function init(G) {
  Gref = G;
  el = {
    hud: $('hud'),
    healthFill: $('health-fill'),
    money: $('money'),
    stars: $('stars'),
    speed: $('speed'),
    clock: $('clock'),
    objective: $('objective'),
    messages: $('messages'),
    minimap: $('minimap'),
    crosshair: $('crosshair'),
  };
  el.starSpans = [];
  if (el.stars) {
    try {
      el.starSpans = Array.from(el.stars.querySelectorAll('.star'));
    } catch {
      el.starSpans = [];
    }
  }
  mapCtx = null;
  if (el.minimap) {
    try {
      mapCtx = el.minimap.getContext('2d');
    } catch {
      mapCtx = null;
    }
  }
  if (G) G.hud = { message, setObjective };
}

export function update(G, dt) {
  if (!G) return;
  Gref = G;

  // Health bar.
  if (el.healthFill && G.player) {
    const hp = Math.max(0, Math.min(100, typeof G.player.health === 'number' ? G.player.health : 100));
    el.healthFill.style.width = hp + '%';
    el.healthFill.style.background = hp > 50 ? '#4caf50' : hp > 25 ? '#ff9800' : '#f44336';
  }

  // Money: $1,234.
  if (el.money) {
    const amount = Math.floor(typeof G.money === 'number' ? G.money : 0);
    el.money.textContent = '$' + amount.toLocaleString('en-US');
  }

  // Wanted stars: light the first N of the five .star spans (the markup
  // already renders the glyphs; .lit makes them full red). Fall back to
  // plain text when the spans are absent.
  if (el.stars) {
    const wanted = Math.max(0, Math.min(5, G.wanted || 0));
    if (el.starSpans && el.starSpans.length > 0) {
      el.starSpans.forEach((span, i) => {
        if (span.classList) span.classList.toggle('lit', i < wanted);
      });
    } else {
      el.stars.textContent = wanted > 0 ? '\u2605'.repeat(wanted) + '  WANTED' : '';
      el.stars.style.color = wanted > 0 ? '#ff3b30' : '';
    }
  }

  // Speed in km/h (1 world unit = 1 m).
  if (el.speed && G.player) {
    let speed = 0;
    if (G.player.car && typeof G.player.car.speed === 'number') speed = G.player.car.speed;
    else if (typeof G.player.speed === 'number') speed = G.player.speed;
    el.speed.textContent = Math.round(Math.abs(speed) * 3.6) + ' km/h';
  }

  // In-game clock: 1 real second = 1 game minute from 17:30.
  if (el.clock) {
    const minutes = CLOCK_START_MINUTES + Math.floor(G.time || 0);
    const hh = Math.floor(minutes / 60) % 24;
    const mm = minutes % 60;
    el.clock.textContent = String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
  }

  // Objective line.
  if (el.objective) {
    const text = (G.missions && G.missions.objective) || FREE_ROAM_TEXT;
    if (el.objective.textContent !== text) el.objective.textContent = text;
  }

  // Crosshair: only on foot while playing. The markup hides it with the
  // .hidden class (display:none !important), so toggle the class, not
  // just the inline style.
  if (el.crosshair) {
    const playing = !G.state || G.state === 'play';
    const show = !!(playing && G.player && G.player.onFoot);
    if (el.crosshair.classList) el.crosshair.classList.toggle('hidden', !show);
    el.crosshair.style.display = show ? 'block' : 'none';
  }

  drawMinimap(G);
}

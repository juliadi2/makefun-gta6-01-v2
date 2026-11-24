// city.js — builds the procedural coastal city of Cayo Verde.
// All placement comes from a seeded RNG, so the city is identical every run
// for a given seed. Exports init(G) and update(G, dt).
//
// Layout: 9 road centrelines per axis at -208..208 (step 52). Buildings fill
// the 8x8 blocks between the roads; the beach runs east of x = 234 and open
// water east of x = 300.

import { mulberry32, randRange, pick } from './utils.js';
import { CFG } from './config.js';

const ROAD_LINES = [-208, -156, -104, -52, 0, 52, 104, 156, 208];
// Block centres sit halfway between adjacent road centrelines.
const BLOCK_CENTRES = [-182, -130, -78, -26, 26, 78, 130, 182];

// Hex string for a numeric colour, for canvas 2D fills.
function cssHex(n) {
  return '#' + n.toString(16).padStart(6, '0');
}

// A window texture for one facade colour: a grid of windows, some lit.
// repeatY stretches the grid over tall buildings instead of stretching windows.
function makeWindowTexture(rng, baseColor, repeatY) {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 256;
  const ctx = c.getContext('2d');
  ctx.fillStyle = cssHex(baseColor);
  ctx.fillRect(0, 0, 128, 256);
  for (let y = 10; y < 246; y += 26) {
    for (let x = 10; x < 118; x += 22) {
      const lit = rng() < 0.32;
      ctx.fillStyle = lit ? '#ffd76a' : '#26374a';
      ctx.fillRect(x, y, 13, 17);
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.fillRect(x, y + 17, 13, 2);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, repeatY);
  return tex;
}

function circleHitsRect(x, z, r, b) {
  const cx = Math.max(b.x - b.hw, Math.min(x, b.x + b.hw));
  const cz = Math.max(b.z - b.hd, Math.min(z, b.z + b.hd));
  const dx = x - cx;
  const dz = z - cz;
  return dx * dx + dz * dz < r * r;
}

export function init(G) {
  const rng = mulberry32(CFG.SEED);
  const scene = G.scene;
  const buildings = [];
  const group = new THREE.Group();
  group.name = 'city';
  scene.add(group);

  // ---- ground: a huge base plane, then the city ground slab ----
  const base = new THREE.Mesh(
    new THREE.PlaneGeometry(2400, 2400),
    new THREE.MeshLambertMaterial({ color: 0xa8905e })
  );
  base.rotation.x = -Math.PI / 2;
  base.position.y = -0.25;
  base.receiveShadow = true;
  group.add(base);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(580, 540),
    new THREE.MeshLambertMaterial({ color: CFG.colors.ground })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(20, 0, 0);
  ground.receiveShadow = true;
  group.add(ground);

  // ---- beach strip and water, east of the city ----
  const beach = new THREE.Mesh(
    new THREE.PlaneGeometry(CFG.WATER_X - CFG.BEACH_X, 540),
    new THREE.MeshLambertMaterial({ color: CFG.colors.sand })
  );
  beach.rotation.x = -Math.PI / 2;
  beach.position.set((CFG.BEACH_X + CFG.WATER_X) / 2, 0.01, 0);
  beach.receiveShadow = true;
  group.add(beach);

  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(340, 1100),
    new THREE.MeshLambertMaterial({
      color: CFG.colors.water,
      transparent: true,
      opacity: 0.92,
    })
  );
  water.rotation.x = -Math.PI / 2;
  water.position.set(CFG.WATER_X + 170, -0.05, 0);
  group.add(water);

  // ---- roads: dark strips along every centreline ----
  const roadMat = new THREE.MeshLambertMaterial({ color: CFG.colors.road });
  const roadLen = CFG.HALF * 2;
  const roadGeoV = new THREE.PlaneGeometry(CFG.ROAD, roadLen);
  const roadGeoH = new THREE.PlaneGeometry(roadLen, CFG.ROAD);
  for (const c of ROAD_LINES) {
    const v = new THREE.Mesh(roadGeoV, roadMat);
    v.rotation.x = -Math.PI / 2;
    v.position.set(c, 0.02, 0);
    v.receiveShadow = true;
    group.add(v);
    const h = new THREE.Mesh(roadGeoH, roadMat);
    h.rotation.x = -Math.PI / 2;
    h.position.set(0, 0.02, c);
    h.receiveShadow = true;
    group.add(h);
  }

  // ---- dashed centre lines (one InstancedMesh for the whole city) ----
  const dashPositions = [];
  for (const c of ROAD_LINES) {
    for (let p = -CFG.HALF + 6; p < CFG.HALF - 6; p += 7) {
      // Skip dashes inside intersections so crossings stay clean.
      const nearCrossing = ROAD_LINES.some((l) => Math.abs(p - l) < 10);
      if (nearCrossing) continue;
      dashPositions.push({ x: c, z: p, rotY: 0 });
      dashPositions.push({ x: p, z: c, rotY: Math.PI / 2 });
    }
  }
  const dashGeo = new THREE.BoxGeometry(0.35, 0.02, 3.2);
  const dashMat = new THREE.MeshBasicMaterial({ color: 0xf5f0dc });
  const dashes = new THREE.InstancedMesh(dashGeo, dashMat, dashPositions.length);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const one = new THREE.Vector3(1, 1, 1);
  dashPositions.forEach((d, i) => {
    q.setFromAxisAngle(up, d.rotY);
    m4.compose(new THREE.Vector3(d.x, 0.04, d.z), q, one);
    dashes.setMatrixAt(i, m4);
  });
  dashes.instanceMatrix.needsUpdate = true;
  group.add(dashes);

  // ---- sidewalks: one light slab per block (InstancedMesh) ----
  const walkGeo = new THREE.BoxGeometry(CFG.BLOCK + 2, 0.12, CFG.BLOCK + 2);
  const walkMat = new THREE.MeshLambertMaterial({ color: CFG.colors.sidewalk });
  const walks = new THREE.InstancedMesh(
    walkGeo,
    walkMat,
    BLOCK_CENTRES.length * BLOCK_CENTRES.length
  );
  let wi = 0;
  for (const bx of BLOCK_CENTRES) {
    for (const bz of BLOCK_CENTRES) {
      q.identity();
      m4.compose(new THREE.Vector3(bx, 0.06, bz), q, one);
      walks.setMatrixAt(wi++, m4);
    }
  }
  walks.instanceMatrix.needsUpdate = true;
  walks.receiveShadow = true;
  group.add(walks);

  // ---- buildings: 1-4 per block, pastel facades with window grids ----
  // Three height bands keep the window grid from stretching on tall towers.
  const facadeMats = CFG.colors.building.map((col) => [
    new THREE.MeshLambertMaterial({ map: makeWindowTexture(rng, col, 1) }),
    new THREE.MeshLambertMaterial({ map: makeWindowTexture(rng, col, 2) }),
    new THREE.MeshLambertMaterial({ map: makeWindowTexture(rng, col, 3) }),
  ]);
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  const roofMat = new THREE.MeshLambertMaterial({ color: 0x6b655c });
  const roofGeo = new THREE.BoxGeometry(1, 0.4, 1);

  for (const bx of BLOCK_CENTRES) {
    for (const bz of BLOCK_CENTRES) {
      // Split the block into 2x2 cells; occupy 1-4 of them.
      const cells = [
        [-10, -10],
        [10, -10],
        [-10, 10],
        [10, 10],
      ];
      // Shuffle the cells with the seeded RNG.
      for (let i = cells.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const t = cells[i];
        cells[i] = cells[j];
        cells[j] = t;
      }
      const count = 1 + Math.floor(rng() * 4);
      for (let k = 0; k < count; k++) {
        const [ox, oz] = cells[k];
        const w = randRange(rng, 10, 17);
        const d = randRange(rng, 10, 17);
        const h = 8 + rng() * rng() * 32; // biased toward low-rise
        const x = bx + ox + randRange(rng, -1.5, 1.5);
        const z = bz + oz + randRange(rng, -1.5, 1.5);
        const colourIdx = Math.floor(rng() * facadeMats.length);
        const band = h <= 14 ? 0 : h <= 26 ? 1 : 2;
        const mesh = new THREE.Mesh(boxGeo, facadeMats[colourIdx][band]);
        mesh.scale.set(w, h, d);
        mesh.position.set(x, h / 2 + 0.12, z);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
        const roof = new THREE.Mesh(roofGeo, roofMat);
        roof.scale.set(w + 0.4, 1, d + 0.4);
        roof.position.set(x, h + 0.3, z);
        roof.castShadow = true;
        group.add(roof);
        buildings.push({ x, z, hw: w / 2, hd: d / 2 });
      }
    }
  }

  // ---- palms: instanced trunks + canopies, along roads and the beach ----
  const palmSpots = [];
  for (const c of ROAD_LINES) {
    for (let p = -182; p <= 182; p += 52) {
      if (rng() < 0.7) palmSpots.push({ x: c + (rng() < 0.5 ? -8.5 : 8.5), z: p });
      if (rng() < 0.7) palmSpots.push({ x: p, z: c + (rng() < 0.5 ? -8.5 : 8.5) });
    }
  }
  for (let z = -240; z <= 240; z += 14) {
    if (rng() < 0.75) palmSpots.push({ x: randRange(rng, 240, 292), z: z + randRange(rng, -4, 4) });
  }
  const trunkGeo = new THREE.CylinderGeometry(0.22, 0.34, 5.5, 6);
  const trunkMat = new THREE.MeshLambertMaterial({ color: 0x7a5230 });
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, palmSpots.length);
  const crownGeo = new THREE.SphereGeometry(2.4, 7, 5);
  const crownMat = new THREE.MeshLambertMaterial({ color: CFG.colors.leaf });
  const crowns = new THREE.InstancedMesh(crownGeo, crownMat, palmSpots.length);
  const crownScale = new THREE.Vector3(1, 0.55, 1);
  palmSpots.forEach((p, i) => {
    const s = randRange(rng, 0.8, 1.3);
    const lean = randRange(rng, -0.12, 0.12);
    q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), lean);
    m4.compose(
      new THREE.Vector3(p.x, (5.5 * s) / 2, p.z),
      q,
      new THREE.Vector3(s, s, s)
    );
    trunks.setMatrixAt(i, m4);
    q.identity();
    m4.compose(
      new THREE.Vector3(p.x + lean * 4, 5.5 * s + 0.6, p.z),
      q,
      new THREE.Vector3(crownScale.x * s, crownScale.y * s, crownScale.z * s)
    );
    crowns.setMatrixAt(i, m4);
  });
  trunks.instanceMatrix.needsUpdate = true;
  crowns.instanceMatrix.needsUpdate = true;
  trunks.castShadow = true;
  crowns.castShadow = true;
  group.add(trunks);
  group.add(crowns);

  // ---- streetlights at a spread of intersections ----
  const lampLines = [-156, -52, 52, 156];
  const lampSpots = [];
  for (const a of lampLines) {
    for (const b of lampLines) {
      lampSpots.push({ x: a + 7.5, z: b + 7.5 });
    }
  }
  const poleGeo = new THREE.CylinderGeometry(0.12, 0.16, 6, 5);
  const poleMat = new THREE.MeshLambertMaterial({ color: 0x2f3542 });
  const poles = new THREE.InstancedMesh(poleGeo, poleMat, lampSpots.length);
  const bulbGeo = new THREE.SphereGeometry(0.45, 8, 6);
  const bulbMat = new THREE.MeshBasicMaterial({ color: 0xfff2b0 });
  const bulbs = new THREE.InstancedMesh(bulbGeo, bulbMat, lampSpots.length);
  lampSpots.forEach((p, i) => {
    q.identity();
    m4.compose(new THREE.Vector3(p.x, 3, p.z), q, one);
    poles.setMatrixAt(i, m4);
    m4.compose(new THREE.Vector3(p.x, 6.2, p.z), q, one);
    bulbs.setMatrixAt(i, m4);
  });
  poles.instanceMatrix.needsUpdate = true;
  bulbs.instanceMatrix.needsUpdate = true;
  group.add(poles);
  group.add(bulbs);

  // ---- props: crates and barriers, kept clear of the spawn intersection ----
  const crateGeo = new THREE.BoxGeometry(1.6, 1.6, 1.6);
  const crateMat = new THREE.MeshLambertMaterial({ color: 0x9c6b3c });
  for (let i = 0; i < 26; i++) {
    const bx = pick(rng, BLOCK_CENTRES) + randRange(rng, -19, 19);
    const bz = pick(rng, BLOCK_CENTRES) + randRange(rng, -19, 19);
    if (Math.abs(bx) < 12 && Math.abs(bz) < 12) continue;
    if (buildings.some((b) => circleHitsRect(bx, bz, 1.4, b))) continue;
    const crate = new THREE.Mesh(crateGeo, crateMat);
    crate.position.set(bx, 0.92, bz);
    crate.rotation.y = rng() * Math.PI;
    crate.castShadow = true;
    group.add(crate);
  }
  const barrierGeo = new THREE.BoxGeometry(3, 1, 0.4);
  const barrierMat = new THREE.MeshLambertMaterial({ color: 0xe8641f });
  for (let i = 0; i < 14; i++) {
    const c = pick(rng, ROAD_LINES);
    const along = randRange(rng, -208, 208);
    const horizontal = rng() < 0.5;
    const x = horizontal ? along : c + 7.5;
    const z = horizontal ? c + 7.5 : along;
    if (Math.abs(x) < 12 && Math.abs(z) < 12) continue;
    const barrier = new THREE.Mesh(barrierGeo, barrierMat);
    barrier.position.set(x, 0.6, z);
    barrier.rotation.y = horizontal ? 0 : Math.PI / 2;
    barrier.castShadow = true;
    group.add(barrier);
  }

  // ---- collision + road queries (shared with player / vehicles / peds) ----
  function collideCircle(x, z, r) {
    if (Math.abs(x) > 300 || Math.abs(z) > 250) return true;
    for (let i = 0; i < buildings.length; i++) {
      if (circleHitsRect(x, z, r, buildings[i])) return true;
    }
    return false;
  }

  function isRoad(x, z) {
    const half = CFG.ROAD / 2;
    for (let i = 0; i < ROAD_LINES.length; i++) {
      if (Math.abs(x - ROAD_LINES[i]) <= half) return true;
      if (Math.abs(z - ROAD_LINES[i]) <= half) return true;
    }
    return false;
  }

  G.city = {
    BLOCK: CFG.BLOCK,
    ROAD: CFG.ROAD,
    PITCH: CFG.PITCH,
    GRID: CFG.GRID,
    HALF: CFG.HALF,
    buildings,
    collideCircle,
    isRoad,
    spawn: { x: 0, z: 0 },
    water,
  };
}

// Gentle water bob; the city itself is static.
export function update(G, dt) {
  if (G.city && G.city.water) {
    G.city.water.position.y = -0.05 + Math.sin(G.time * 0.8) * 0.05;
  }
}

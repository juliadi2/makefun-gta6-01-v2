// Shooting, punching, player health and enemy NPCs.
//
// The player shoots from the hip with the mouse while on foot (raycast from
// the camera through the screen centre), punches with F, and takes fire from
// enemy NPCs. Health regenerates after 5 s without damage.
//
// Contract: ES module, THREE is the global UMD build. Exports init(G),
// update(G, dt) and spawnEnemy(G, x, z). G.combat.enemies is the shared list
// missions.js spawns into and clears. Guards every cross-module call.

import * as utils from './utils.js';

const clamp = typeof utils.clamp === 'function'
  ? utils.clamp
  : (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const SHOT_RANGE = 60;
const SHOT_INTERVAL = 1 / 8; // 8 shots per second
const ENEMY_HIT_DAMAGE = 34; // 3 hits kill a 100-hp enemy
const CAR_HIT_DAMAGE = 10;
const PUNCH_RANGE = 2.5;
const PUNCH_DAMAGE = 20;
const PUNCH_INTERVAL = 0.45;
const ENEMY_SHOT_DAMAGE = 8;
const ENEMY_RANGE = 40;
const KILL_REWARD = 50;
const REGEN_DELAY = 5;
const REGEN_RATE = 2;
const MAX_HEALTH = 100;

function gunPos(G, out) {
  const p = G.player.pos;
  const h = G.player.heading || 0;
  out.set(p.x + Math.sin(h) * 0.6, 1.35, p.z + Math.cos(h) * 0.6);
  return out;
}

// Walk up from a hit mesh to the tagged owner (ped / enemy / car).
function findOwner(obj) {
  let cur = obj;
  while (cur) {
    if (cur.userData) {
      if (cur.userData.ped) return { kind: 'ped', ref: cur.userData.ped };
      if (cur.userData.enemy) return { kind: 'enemy', ref: cur.userData.enemy };
      if (cur.userData.car) return { kind: 'car', ref: cur.userData.car };
    }
    cur = cur.parent;
  }
  return null;
}

function buildEnemyMesh() {
  const group = new THREE.Group();
  const matRed = new THREE.MeshLambertMaterial({ color: 0xc0392b });
  const matBlack = new THREE.MeshLambertMaterial({ color: 0x1a1a1a });
  const matSkin = new THREE.MeshLambertMaterial({ color: 0xc68642 });

  const legGeo = new THREE.BoxGeometry(0.17, 0.8, 0.22);
  legGeo.translate(0, -0.4, 0);
  const legL = new THREE.Mesh(legGeo, matBlack);
  legL.position.set(-0.11, 0.8, 0);
  const legR = new THREE.Mesh(legGeo, matBlack);
  legR.position.set(0.11, 0.8, 0);
  group.add(legL, legR);

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.68, 0.3), matRed);
  torso.position.y = 1.14;
  group.add(torso);

  const armGeo = new THREE.BoxGeometry(0.14, 0.62, 0.16);
  armGeo.translate(0, -0.31, 0);
  const armL = new THREE.Mesh(armGeo, matRed);
  armL.position.set(-0.36, 1.44, 0);
  const armR = new THREE.Mesh(armGeo, matRed);
  armR.position.set(0.36, 1.44, 0);
  // Right arm raised, holding the gun forward.
  armR.rotation.x = -Math.PI / 2;
  group.add(armL, armR);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), matSkin);
  head.position.y = 1.7;
  group.add(head);

  // Red bandana.
  const bandana = new THREE.Mesh(
    new THREE.BoxGeometry(0.44, 0.12, 0.44),
    new THREE.MeshLambertMaterial({ color: 0xe74c3c }),
  );
  bandana.position.y = 1.84;
  group.add(bandana);

  return group;
}

export function spawnEnemy(G, x, z) {
  if (!G || !G.scene) return null;
  if (!G.combat) init(G);
  const mesh = buildEnemyMesh();
  mesh.position.set(x, 0, z);
  G.scene.add(mesh);
  const enemy = {
    mesh,
    pos: new THREE.Vector3(x, 0, z),
    heading: 0,
    health: 100,
    state: 'alive', // 'alive' | 'dead'
    fireTimer: 1 + Math.random() * 1.5,
    deadTimer: 0,
    fadeTimer: 0,
  };
  mesh.userData.enemy = enemy;
  G.combat.enemies.push(enemy);
  return enemy;
}

function killEnemy(G, enemy) {
  if (enemy.state === 'dead') return;
  enemy.state = 'dead';
  enemy.deadTimer = 0;
  enemy.fadeTimer = 0;
  G.money = (G.money || 0) + KILL_REWARD;
  if (G.hud) G.hud.message('Gang member down! +$' + KILL_REWARD);
}

function addWanted(G, n) {
  if (G.police && typeof G.police.addWanted === 'function') G.police.addWanted(n);
}

function init(G) {
  G.combat = {
    lastShotAt: -99,
    ammo: Infinity,
    enemies: [],
    lastDamageAt: -99,
    _shotTimer: 0,
    _punchTimer: 0,
    _raycaster: new THREE.Raycaster(),
    _center: new THREE.Vector2(0, 0),
    _tracers: [], // {line, timer}
    _sparks: [], // {mesh, vel, life}
    _flash: null, // muzzle flash mesh
    _flashLight: null,
    _flashTimer: 0,
  };

  // Muzzle flash: one small emissive sphere + point light, reused per shot.
  const flash = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xffdd55 }),
  );
  flash.visible = false;
  G.scene.add(flash);
  const flashLight = new THREE.PointLight(0xffcc44, 0, 9);
  G.scene.add(flashLight);
  G.combat._flash = flash;
  G.combat._flashLight = flashLight;
}

function showMuzzleFlash(G, at) {
  const c = G.combat;
  c._flash.position.copy(at);
  c._flash.visible = true;
  c._flash.scale.setScalar(0.8 + Math.random() * 0.5);
  c._flashLight.position.copy(at);
  c._flashLight.intensity = 2.5;
  c._flashTimer = 0.06;
}

function addTracer(G, from, to, color) {
  const geo = new THREE.BufferGeometry().setFromPoints([from.clone(), to.clone()]);
  const mat = new THREE.LineBasicMaterial({
    color: color || 0xffff88,
    transparent: true,
    opacity: 0.95,
  });
  const line = new THREE.Line(geo, mat);
  G.scene.add(line);
  G.combat._tracers.push({ line, timer: 0.08 });
}

function addSparks(G, at) {
  for (let i = 0; i < 8; i++) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.07, 0.07, 0.07),
      new THREE.MeshBasicMaterial({ color: 0xffaa22 }),
    );
    mesh.position.copy(at);
    G.scene.add(mesh);
    G.combat._sparks.push({
      mesh,
      vel: new THREE.Vector3(
        (Math.random() - 0.5) * 6,
        Math.random() * 5 + 1,
        (Math.random() - 0.5) * 6,
      ),
      life: 0.4,
    });
  }
}

function shoot(G) {
  const c = G.combat;
  const from = gunPos(G, new THREE.Vector3());
  c._raycaster.setFromCamera(c._center, G.camera);
  c._raycaster.far = SHOT_RANGE;

  // Collect shootable meshes; tag car meshes so findOwner can see them even
  // if vehicles.js never set userData itself.
  const targets = [];
  if (G.peds && Array.isArray(G.peds.list)) {
    for (const ped of G.peds.list) {
      if (ped.state !== 'dead' && ped.mesh) targets.push(ped.mesh);
    }
  }
  for (const enemy of c.enemies) {
    if (enemy.state === 'alive' && enemy.mesh) targets.push(enemy.mesh);
  }
  if (G.vehicles && Array.isArray(G.vehicles.list)) {
    for (const car of G.vehicles.list) {
      if (car.mesh) {
        car.mesh.userData.car = car;
        targets.push(car.mesh);
      }
    }
  }

  const hits = c._raycaster.intersectObjects(targets, true);
  let end;
  if (hits.length > 0) {
    const hit = hits[0];
    end = hit.point.clone();
    const owner = findOwner(hit.object);
    if (owner) {
      if (owner.kind === 'ped') {
        // Shooting a ped kills them; pedestrians.js animates the fall.
        owner.ref.state = 'dead';
        owner.ref.deadTimer = 0;
        owner.ref.fadeTimer = 0;
        owner.ref.mesh.userData.legL.rotation.x = 0;
        owner.ref.mesh.userData.legR.rotation.x = 0;
        addWanted(G, 1);
        if (G.hud) G.hud.message('Pedestrian down!');
      } else if (owner.kind === 'enemy') {
        owner.ref.health -= ENEMY_HIT_DAMAGE;
        addSparks(G, hit.point);
        if (owner.ref.health <= 0) killEnemy(G, owner.ref);
      } else if (owner.kind === 'car') {
        const car = owner.ref;
        if (typeof car.health === 'number') car.health = Math.max(0, car.health - CAR_HIT_DAMAGE);
        addSparks(G, hit.point);
        if (car.police) addWanted(G, 1);
      }
    }
  } else {
    end = from.clone().add(
      new THREE.Vector3(0, 0, -1).applyQuaternion(G.camera.quaternion).multiplyScalar(SHOT_RANGE),
    );
  }

  showMuzzleFlash(G, from);
  addTracer(G, from, end, 0xffff88);
  if (G.audio) G.audio.shot();
  c.lastShotAt = G.time;
  c._shotTimer = SHOT_INTERVAL;
}

function punch(G) {
  const c = G.combat;
  const p = G.player.pos;
  const h = G.player.heading || 0;
  const fx = Math.sin(h);
  const fz = Math.cos(h);
  let best = null;
  let bestDist = PUNCH_RANGE;

  const consider = (obj, kind) => {
    if (!obj || !obj.pos) return;
    if (kind === 'enemy' && obj.state !== 'alive') return;
    if (kind === 'ped' && obj.state === 'dead') return;
    const dx = obj.pos.x - p.x;
    const dz = obj.pos.z - p.z;
    const dist = Math.hypot(dx, dz);
    if (dist < bestDist && dist > 0.001) {
      // Must be roughly in front of the player.
      if ((dx / dist) * fx + (dz / dist) * fz > 0.3) {
        best = { obj, kind, dx, dz, dist };
        bestDist = dist;
      }
    }
  };

  if (G.peds && Array.isArray(G.peds.list)) {
    for (const ped of G.peds.list) consider(ped, 'ped');
  }
  for (const enemy of c.enemies) consider(enemy, 'enemy');

  c._punchTimer = PUNCH_INTERVAL;
  if (!best) return;

  // Knockback away from the player.
  const nx = best.dx / best.dist;
  const nz = best.dz / best.dist;
  best.obj.pos.x += nx * 2;
  best.obj.pos.z += nz * 2;
  best.obj.mesh.position.copy(best.obj.pos);

  if (best.kind === 'enemy') {
    best.obj.health -= PUNCH_DAMAGE;
    if (best.obj.health <= 0) killEnemy(G, best.obj);
  } else {
    best.obj.state = 'dead';
    best.obj.deadTimer = 0;
    best.obj.fadeTimer = 0;
    addWanted(G, 1);
    if (G.hud) G.hud.message('Pedestrian down!');
  }
}

function damagePlayer(G, amount) {
  if (!G.player || G.player.alive === false) return;
  G.player.health = Math.max(0, (G.player.health ?? MAX_HEALTH) - amount);
  G.combat.lastDamageAt = G.time;
  if (G.player.health <= 0) {
    G.player.alive = false; // main.js shows the game-over screen
  }
}

function update(G, dt) {
  if (!G || !G.combat) return;
  const c = G.combat;
  const player = G.player;
  const playing = G.state === 'play';
  const alive = !player || player.alive !== false;
  const onFoot = !player || player.onFoot !== false;

  c._shotTimer -= dt;
  c._punchTimer -= dt;

  // --- Player shooting ----------------------------------------------------
  if (playing && alive && onFoot && G.input && G.input.mouseDown && c._shotTimer <= 0 && G.camera) {
    shoot(G);
  }

  // --- Punch --------------------------------------------------------------
  if (playing && alive && onFoot && G.input && G.input.keys &&
      G.input.keys.has('KeyF') && c._punchTimer <= 0) {
    punch(G);
  }

  // --- Enemy AI: stand, face the player, shoot back ------------------------
  if (player && player.pos) {
    for (let i = c.enemies.length - 1; i >= 0; i--) {
      const enemy = c.enemies[i];
      if (enemy.state === 'dead') {
        enemy.deadTimer += dt;
        const fall = Math.min(1, enemy.deadTimer / 0.35);
        enemy.mesh.rotation.x = -Math.PI / 2 * fall;
        if (enemy.deadTimer > 10) {
          enemy.fadeTimer += dt;
          enemy.mesh.traverse((child) => {
            if (child.isMesh && child.material) {
              child.material.transparent = true;
              child.material.opacity = Math.max(0, 1 - enemy.fadeTimer);
            }
          });
          if (enemy.fadeTimer >= 1) {
            G.scene.remove(enemy.mesh);
            c.enemies.splice(i, 1);
          }
        }
        continue;
      }

      const dx = player.pos.x - enemy.pos.x;
      const dz = player.pos.z - enemy.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 0.001) {
        enemy.heading = Math.atan2(dx, dz);
        enemy.mesh.rotation.y = enemy.heading;
      }
      if (!playing || !alive || dist > ENEMY_RANGE) continue;

      enemy.fireTimer -= dt;
      if (enemy.fireTimer <= 0) {
        enemy.fireTimer = 1.5 + Math.random() * 1.0;
        const from = enemy.pos.clone();
        from.y = 1.4;
        const to = player.pos.clone();
        to.y = 1.2;
        addTracer(G, from, to, 0xff6644);
        damagePlayer(G, ENEMY_SHOT_DAMAGE);
      }
    }
  }

  // --- Player health regen -------------------------------------------------
  if (player && alive && typeof player.health === 'number' && player.health < MAX_HEALTH &&
      G.time !== undefined && (G.time - c.lastDamageAt) > REGEN_DELAY) {
    player.health = Math.min(MAX_HEALTH, player.health + REGEN_RATE * dt);
  }

  // --- Muzzle flash fade (60 ms) -------------------------------------------
  if (c._flashTimer > 0) {
    c._flashTimer -= dt;
    if (c._flashTimer <= 0) {
      c._flash.visible = false;
      c._flashLight.intensity = 0;
    }
  }

  // --- Tracer fade (80 ms) --------------------------------------------------
  for (let i = c._tracers.length - 1; i >= 0; i--) {
    const t = c._tracers[i];
    t.timer -= dt;
    t.line.material.opacity = Math.max(0, t.timer / 0.08) * 0.95;
    if (t.timer <= 0) {
      G.scene.remove(t.line);
      t.line.geometry.dispose();
      t.line.material.dispose();
      c._tracers.splice(i, 1);
    }
  }

  // --- Sparks ----------------------------------------------------------------
  for (let i = c._sparks.length - 1; i >= 0; i--) {
    const s = c._sparks[i];
    s.life -= dt;
    s.vel.y -= 12 * dt;
    s.mesh.position.addScaledVector(s.vel, dt);
    if (s.life <= 0 || s.mesh.position.y < 0) {
      G.scene.remove(s.mesh);
      s.mesh.geometry.dispose();
      s.mesh.material.dispose();
      c._sparks.splice(i, 1);
    }
  }
}

export { init, update };

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Ground shadows
// ---------------------------------------------------------------------------
/** Shared soft-shadow material; the texture is generated once. */
let enemyShadowMaterial = null;

/**
 * Returns a soft, round shadow material.
 *
 * A flat black circle has a hard edge that reads as a decal. A radial alpha
 * gradient fades out and makes the insect look like it is hovering above the
 * grass instead of hovering above a sticker.
 *
 * @returns {THREE.MeshBasicMaterial}
 */
function getEnemyShadowMaterial() {
  if (enemyShadowMaterial) return enemyShadowMaterial;

  let map = null;
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const gradient = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
      gradient.addColorStop(0, 'rgba(0,0,0,0.55)');
      gradient.addColorStop(0.55, 'rgba(0,0,0,0.22)');
      gradient.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 128, 128);

      map = new THREE.CanvasTexture(canvas);
      map.colorSpace = THREE.SRGBColorSpace;
    }
  }

  enemyShadowMaterial = new THREE.MeshBasicMaterial({
    color: 0x000000,
    map,
    transparent: true,
    opacity: map ? 0.62 : 0.16,
    depthWrite: false,
  });
  return enemyShadowMaterial;
}

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------
/** Base delay between enemy spawns, in seconds. */
export const ENEMY_SPAWN_DELAY = 2.5;
/** Base enemy movement speed (world units per second). */
export const ENEMY_SPEED = 45;
/** Height the insects hover at, in world units. */
export const ENEMY_HOVER = 38;
/** Chance a spawned insect is an elite (gold-edged, guaranteed gene drop). */
export const ELITE_CHANCE = 0.1;

// --- Bosses ---------------------------------------------------------------
/**
 * Body scale for a boss, relative to its species.
 *
 * A giant has to read as *big* from across the board, and at 4.5x it still
 * looked like a slightly overweight beetle. 7x puts the smallest giant
 * (centipede, radius 26) at 182 world units across — roughly two and a half
 * times the hero — which is unmistakable at a glance.
 */
export const BOSS_SCALE = 7;
/** Health multiplier applied to the species base HP. */
export const BOSS_HP_MULT = 18;
/** Extra flat armor for bosses, added on top of the species value. */
export const BOSS_ARMOR_BONUS = 0.15;
/** Contact-damage multiplier for bosses. */
export const BOSS_DAMAGE_MULT = 1.8;
/** Score multiplier for killing a boss. */
export const BOSS_POINT_MULT = 12;
/** Speed multiplier while a boss is chasing. */
export const BOSS_SPEED_SCALE = 0.85;
/** Seconds between summon waves from a boss. */
export const BOSS_SUMMON_INTERVAL = 7;
/** How many insects a boss calls in per wave. */
export const BOSS_SUMMON_COUNT = 2;
/** Below this fraction of max HP a boss becomes enraged (faster, harder hits). */
export const BOSS_ENRAGE_THRESHOLD = 0.4;
/** Speed multiplier once enraged. */
export const BOSS_ENRAGE_SPEED = 1.35;
/**
 * How many hits every boss must absorb.
 *
 * Attack power grows without a ceiling (centipede genes, levels, boss
 * bonuses), so a fixed health pool meant later bosses died to a single
 * blast and the summon/enrage phases never happened. Each boss's pool is
 * scaled to survive at least this many hits at the hero's current attack
 * power, no matter how far the build has run away.
 */
export const BOSS_MIN_HITS = 50;
/**
 * Extra hits demanded per boss already spawned. The first giant asks for
 * the `BOSS_MIN_HITS` baseline; every boss after it asks for more, so the
 * difficulty curve never flattens out even once the hero's attack power has
 * outgrown the flat multiplier.
 */
export const BOSS_MIN_HITS_GROWTH = 18;
/**
 * Extra hit requirement per boss squared. A flat +18 turns every giant into
 * the same-length fight once the hero's damage catches up; this term makes
 * boss #4 and #5 feel materially tougher instead of merely longer.
 */
export const BOSS_MIN_HITS_ACCEL = 4;
/** Hard ceiling on the hit requirement, so a long run cannot stall forever. */
export const BOSS_MIN_HITS_MAX = 220;
/** Extra health multiplier added for each boss already spawned this run. */
export const BOSS_HP_GROWTH_PER_BOSS = 0.8;
/** Extra armour added per boss already spawned, on top of the flat bonus. */
export const BOSS_ARMOR_GROWTH_PER_BOSS = 0.04;
/** Armour can never make a boss untouchable. */
export const BOSS_ARMOR_MAX = 0.8;
/** Contact-damage growth per boss already spawned. */
export const BOSS_DAMAGE_GROWTH_PER_BOSS = 0.22;
/** Enrage threshold climbs, so late bosses spend longer in that phase. */
export const BOSS_ENRAGE_GROWTH_PER_BOSS = 0.06;
/** Enrage threshold ceiling. */
export const BOSS_ENRAGE_MAX = 0.7;

/** Species a boss can take the form of. */
export const BOSS_SPECIES = ['beetle', 'centipede', 'mole'];

// --- Boss signature abilities ---------------------------------------------
/**
 * Each giant owns a move set no ordinary insect has. Abilities are keyed by
 * species so the three bosses play differently instead of being the same
 * health bar in three costumes.
 *
 * Cooldowns are in seconds and shrink slightly with the boss number (see
 * `bossAbilityCooldown`), so later giants fire more often.
 */
export const BOSS_ABILITIES = {
  beetle: {
    key: 'charge',
    label: 'Horn Charge',
    /** Telegraphed wind-up before the dash, in seconds. */
    windup: 0.8,
    /** Seconds the dash itself lasts. */
    duration: 0.55,
    /** Multiplier on the boss's own speed during the dash. */
    speedMult: 5.5,
    /** Total ground distance of one dash, in world units. */
    distance: 620,
    /** Frames the dash is spread over, so the reach is frame-rate independent. */
    dashFrames: 22,
    /** Contact damage multiplier for a body-check during the dash. */
    damageMult: 2.2,
    cooldown: 7,
    color: '#ffb03d',
  },
  centipede: {
    key: 'venom',
    label: 'Venom Spray',
    /** How many venom pools one cast scatters. */
    pools: 3,
    /** Radius of each pool on the ground plane. */
    poolRadius: 55,
    /** Damage per tick while the hero stands in a pool. */
    tickDamage: 7,
    /** Seconds between damage ticks. */
    tickInterval: 0.6,
    /** Seconds a pool lingers. */
    life: 6,
    /** Seconds of poison left after leaving a pool. */
    poisonDuration: 3,
    /** Damage per poison tick on the hero. */
    poisonDamage: 4,
    /** Seconds between poison ticks. */
    poisonInterval: 1,
    cooldown: 8,
    color: '#7ce86b',
  },
  mole: {
    key: 'burrow',
    label: 'Burrow Ambush',
    /** Seconds spent underground, untargetable. */
    duration: 1.6,
    /** Ground radius the hero must clear before the boss surfaces. */
    dangerRadius: 90,
    /** Contact damage when the boss surfaces on top of the hero. */
    burstDamage: 34,
    cooldown: 9,
    color: '#c98cff',
  },
};

/**
 * Ability cooldown after the boss-number ramp.
 *
 * @param {string} speciesKey Which giant is casting.
 * @param {number} bossIndex Zero-based boss number.
 * @returns {number} Seconds between casts.
 */
export function bossAbilityCooldown(speciesKey, bossIndex = 0) {
  const ability = BOSS_ABILITIES[speciesKey];
  if (!ability) return Infinity;
  // Each later boss shaves a little off, floored so it never spams.
  return Math.max(ability.cooldown * 0.55, ability.cooldown - bossIndex * 0.6);
}


/**
 * Derives every boss stat from a species and a boss number.
 *
 * Kept as a pure function so the constructor and the tests share one source
 * of truth: the whole point of the ramp is that boss #5 is harder than boss
 * #1 on *every* axis, and that claim has to be checkable without spawning
 * five giants.
 *
 * @param {{hp: number, armor?: number, contactDamage?: number}} type Species blueprint.
 * @param {number} bossIndex Zero-based boss number within the run.
 * @param {number} [heroAttack] The hero's attack power when the boss spawns.
 * @returns {{
 *   armor: number,
 *   contactDamage: number,
 *   maxHp: number,
 *   hitFloor: number,
 *   enrageThreshold: number,
 * }}
 */
export function bossProfile(type, bossIndex = 0, heroAttack = 1) {
  const armor = Math.min(
    0.95,
    (type.armor || 0) +
      Math.min(BOSS_ARMOR_MAX, BOSS_ARMOR_BONUS + bossIndex * BOSS_ARMOR_GROWTH_PER_BOSS)
  );

  const contactDamage =
    (type.contactDamage || 20) * BOSS_DAMAGE_MULT * (1 + bossIndex * BOSS_DAMAGE_GROWTH_PER_BOSS);

  // Boss #1 asks for the baseline; every later boss demands more hits, and
  // the quadratic term makes the jump from #3 to #4 larger than #1 to #2.
  const hitFloor = Math.min(
    BOSS_MIN_HITS_MAX,
    BOSS_MIN_HITS +
      bossIndex * BOSS_MIN_HITS_GROWTH +
      bossIndex * bossIndex * BOSS_MIN_HITS_ACCEL
  );
  // Armour already shaves every hit, so the floor is expressed in hits that
  // land rather than raw swings.
  const perHit = Math.max(0.5, heroAttack * (1 - armor));
  const base = type.hp * BOSS_HP_MULT;
  const growth = 1 + bossIndex * BOSS_HP_GROWTH_PER_BOSS;
  const maxHp = Math.round(Math.max(base * growth, hitFloor * perHit));

  const enrageThreshold = Math.min(
    BOSS_ENRAGE_MAX,
    BOSS_ENRAGE_THRESHOLD + bossIndex * BOSS_ENRAGE_GROWTH_PER_BOSS
  );

  return { armor, contactDamage, maxHp, hitFloor, enrageThreshold };
}

// Spawn positions are chosen by main.js: on a board this large, insects have
// to appear relative to the hero rather than at fixed map corners.

// ---------------------------------------------------------------------------
// Procedural textures
// ---------------------------------------------------------------------------
/**
 * Paints a repeating two-colour band texture on a canvas. Used for the bee's
 * abdomen so we get stripes without shipping any image files.
 *
 * @param {string} base Fill colour for the body.
 * @param {string} band Colour of the stripes.
 * @param {number} bands How many stripes to draw.
 * @returns {THREE.CanvasTexture}
 */
function bandTexture(base, band, bands) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = base;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const bandWidth = canvas.width / (bands * 2);
  ctx.fillStyle = band;
  for (let i = 0; i < bands; i++) {
    ctx.fillRect(i * bandWidth * 2 + bandWidth, 0, bandWidth, canvas.height);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// ---------------------------------------------------------------------------
// Shared materials
// ---------------------------------------------------------------------------
const wingMaterial = new THREE.MeshStandardMaterial({
  color: 0xdce8f5,
  transparent: true,
  opacity: 0.5,
  side: THREE.DoubleSide,
  depthWrite: false,
});

const flyEyeMaterial = new THREE.MeshStandardMaterial({
  color: 0xd93b2b,
  roughness: 0.25,
});

/**
 * Builds one wing mesh, tagged so the animation loop can find it later.
 *
 * @param {THREE.BufferGeometry} geometry Wing shape.
 * @param {number} side -1 for left, +1 for right.
 * @param {number} scale Relative wing size.
 * @returns {THREE.Mesh}
 */
function makeWing(geometry, side, scale = 1) {
  const wing = new THREE.Mesh(geometry, wingMaterial);
  wing.name = 'wing';
  wing.userData.side = side;
  wing.scale.setScalar(scale);
  return wing;
}

// ---------------------------------------------------------------------------
// Enemy blueprints
// ---------------------------------------------------------------------------
// Each blueprint returns a fresh Group whose origin sits at the insect's
// centre of mass. Meshes named "wing" are collected by the Enemy class and
// flapped every frame.

/** Common house fly: the baseline enemy. */
function buildFly(cfg) {
  const group = new THREE.Group();

  const body = new THREE.Mesh(
    new THREE.SphereGeometry(cfg.radius * 0.72, 16, 12),
    new THREE.MeshStandardMaterial({ color: 0x2f3038, roughness: 0.35, metalness: 0.4 })
  );
  body.scale.set(1.35, 1, 0.95);
  group.add(body);

  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(cfg.radius * 0.3, 12, 10), flyEyeMaterial);
    eye.position.set(cfg.radius * 0.6, side * cfg.radius * 0.32, cfg.radius * 0.2);
    group.add(eye);
  }

  const wingGeo = new THREE.CircleGeometry(cfg.radius * 0.95, 16);
  for (const side of [-1, 1]) {
    const wing = makeWing(wingGeo, side);
    wing.position.set(-cfg.radius * 0.1, side * cfg.radius * 0.85, cfg.radius * 0.35);
    wing.rotation.x = side * 0.25;
    group.add(wing);
  }

  return group;
}

/** Mosquito: smaller, slimmer and noticeably faster. */
function buildMosquito(cfg) {
  const group = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: 0x1c1a18, roughness: 0.6 });

  const body = new THREE.Mesh(
    new THREE.SphereGeometry(cfg.radius * 0.6, 14, 10),
    new THREE.MeshStandardMaterial({ color: 0x4a4038, roughness: 0.5, metalness: 0.2 })
  );
  body.scale.set(2.4, 0.85, 0.85);
  group.add(body);

  // Long needle-like proboscis.
  const proboscis = new THREE.Mesh(
    new THREE.CylinderGeometry(cfg.radius * 0.05, cfg.radius * 0.02, cfg.radius * 1.6, 6),
    dark
  );
  proboscis.rotation.z = -Math.PI / 2;
  proboscis.position.set(cfg.radius * 1.15, 0, 0);
  group.add(proboscis);

  // Two swept-back antennae.
  for (const side of [-1, 1]) {
    const antenna = new THREE.Mesh(
      new THREE.CylinderGeometry(cfg.radius * 0.035, cfg.radius * 0.02, cfg.radius * 1.1, 5),
      dark
    );
    antenna.rotation.z = -Math.PI / 2;
    antenna.rotation.x = side * 0.5;
    antenna.position.set(cfg.radius * 0.75, side * cfg.radius * 0.3, cfg.radius * 0.15);
    group.add(antenna);
  }

  // Dark eyes.
  const eyeMaterial = new THREE.MeshStandardMaterial({ color: 0x14110f, roughness: 0.3 });
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(cfg.radius * 0.22, 10, 8), eyeMaterial);
    eye.position.set(cfg.radius * 0.5, side * cfg.radius * 0.25, cfg.radius * 0.18);
    group.add(eye);
  }

  const wingGeo = new THREE.CircleGeometry(cfg.radius * 0.8, 14);
  for (const side of [-1, 1]) {
    const wing = makeWing(wingGeo, side);
    wing.position.set(-cfg.radius * 0.15, side * cfg.radius * 0.7, cfg.radius * 0.3);
    wing.rotation.x = side * 0.3;
    group.add(wing);
  }

  return group;
}

/** Bee: sturdy, banded, with two pairs of wings and a stinger. */
function buildBee(cfg) {
  const group = new THREE.Group();

  const stripedMaterial = new THREE.MeshStandardMaterial({
    map: bandTexture('#f2c14e', '#2b2118', 3),
    roughness: 0.45,
    metalness: 0.15,
  });

  const body = new THREE.Mesh(new THREE.SphereGeometry(cfg.radius * 0.85, 18, 14), stripedMaterial);
  body.scale.set(1.35, 1, 1);
  group.add(body);

  // Dark head at the front.
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(cfg.radius * 0.45, 14, 10),
    new THREE.MeshStandardMaterial({ color: 0x2b2118, roughness: 0.5 })
  );
  head.position.x = cfg.radius * 0.95;
  group.add(head);

  // Stinger at the back.
  const stinger = new THREE.Mesh(
    new THREE.ConeGeometry(cfg.radius * 0.16, cfg.radius * 0.6, 8),
    new THREE.MeshStandardMaterial({ color: 0x1c1a18, roughness: 0.4 })
  );
  stinger.rotation.z = Math.PI / 2;
  stinger.position.x = -cfg.radius * 1.05;
  group.add(stinger);

  const wingGeo = new THREE.CircleGeometry(cfg.radius * 0.62, 14);
  for (const side of [-1, 1]) {
    // Two wings per side; the front pair is slightly larger.
    const front = makeWing(wingGeo, side, 1);
    front.position.set(cfg.radius * 0.2, side * cfg.radius * 0.8, cfg.radius * 0.45);
    front.rotation.x = side * 0.22;
    group.add(front);

    const rear = makeWing(wingGeo, side, 0.78);
    rear.position.set(-cfg.radius * 0.4, side * cfg.radius * 0.75, cfg.radius * 0.4);
    rear.rotation.x = side * 0.34;
    group.add(rear);
  }

  return group;
}

/** Beetle: slow, armoured, takes two hits to bring down. */
function buildBeetle(cfg) {
  const group = new THREE.Group();

  const shellMaterial = new THREE.MeshStandardMaterial({
    color: 0x2d4a2a,
    roughness: 0.25,
    metalness: 0.75,
  });

  const body = new THREE.Mesh(new THREE.SphereGeometry(cfg.radius * 0.8, 18, 14), shellMaterial);
  body.scale.set(1.2, 1.1, 0.8);
  group.add(body);

  // Raised elytra (wing case) sitting on top of the abdomen.
  const elytra = new THREE.Mesh(
    new THREE.SphereGeometry(cfg.radius * 0.82, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2),
    shellMaterial
  );
  elytra.scale.set(1.15, 1, 0.55);
  elytra.position.set(-cfg.radius * 0.15, 0, cfg.radius * 0.12);
  group.add(elytra);

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(cfg.radius * 0.42, 14, 10),
    new THREE.MeshStandardMaterial({ color: 0x1d2f1c, roughness: 0.35, metalness: 0.7 })
  );
  head.position.x = cfg.radius * 0.9;
  group.add(head);

  // Rhino-beetle style horn.
  const horn = new THREE.Mesh(
    new THREE.ConeGeometry(cfg.radius * 0.16, cfg.radius * 0.85, 8),
    new THREE.MeshStandardMaterial({ color: 0x1d2f1c, roughness: 0.3, metalness: 0.7 })
  );
  horn.rotation.z = -Math.PI / 2;
  horn.position.set(cfg.radius * 1.25, 0, cfg.radius * 0.18);
  group.add(horn);

  const eyeMaterial = new THREE.MeshStandardMaterial({ color: 0xe8d44d, roughness: 0.3 });
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(cfg.radius * 0.14, 10, 8), eyeMaterial);
    eye.position.set(cfg.radius * 1.0, side * cfg.radius * 0.26, cfg.radius * 0.2);
    group.add(eye);
  }

  // Beetles are armoured fliers: small wings tucked under the shell.
  const wingGeo = new THREE.CircleGeometry(cfg.radius * 0.5, 12);
  for (const side of [-1, 1]) {
    const wing = makeWing(wingGeo, side, 0.9);
    wing.position.set(-cfg.radius * 0.2, side * cfg.radius * 0.72, cfg.radius * 0.32);
    wing.rotation.x = side * 0.3;
    group.add(wing);
  }

  return group;
}

/** Centipede: a chain of armoured segments with many legs — bites hard. */
function buildCentipede(cfg) {
  const group = new THREE.Group();
  const shell = new THREE.MeshStandardMaterial({ color: 0x8a3b1f, roughness: 0.55, metalness: 0.2 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x5c2412, roughness: 0.7 });
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0xffd23f, roughness: 0.3 });

  const segments = 6;
  for (let i = 0; i < segments; i++) {
    const t = i / (segments - 1);
    const r = cfg.radius * (0.62 - t * 0.32);
    const seg = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 10), shell);
    seg.scale.set(1.15, 1, 0.9);
    seg.position.x = cfg.radius * (0.75 - t * 1.6);
    group.add(seg);

    // A pair of legs per segment, splayed sideways.
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(
        new THREE.CylinderGeometry(r * 0.09, r * 0.06, r * 0.9, 5),
        dark
      );
      leg.rotation.z = side * 0.9;
      leg.position.set(seg.position.x, side * r * 0.75, -r * 0.2);
      group.add(leg);
    }
  }

  // Head with antennae and bright eyes.
  const head = new THREE.Mesh(new THREE.SphereGeometry(cfg.radius * 0.5, 12, 10), dark);
  head.position.x = cfg.radius * 0.85;
  group.add(head);

  for (const side of [-1, 1]) {
    const antenna = new THREE.Mesh(
      new THREE.CylinderGeometry(cfg.radius * 0.05, cfg.radius * 0.03, cfg.radius * 0.8, 5),
      dark
    );
    antenna.rotation.z = -Math.PI / 2;
    antenna.rotation.x = side * 0.4;
    antenna.position.set(cfg.radius * 1.1, side * cfg.radius * 0.2, cfg.radius * 0.1);
    group.add(antenna);

    const eye = new THREE.Mesh(new THREE.SphereGeometry(cfg.radius * 0.12, 8, 6), eyeMat);
    eye.position.set(cfg.radius * 0.95, side * cfg.radius * 0.18, cfg.radius * 0.15);
    group.add(eye);
  }

  return group;
}

/** Mole: a heavy, armoured burrower with oversized claws — slow but tough. */
function buildMole(cfg) {
  const group = new THREE.Group();
  const fur = new THREE.MeshStandardMaterial({ color: 0x6b4a33, roughness: 0.85 });
  const darkFur = new THREE.MeshStandardMaterial({ color: 0x4a3020, roughness: 0.9 });
  const clawMat = new THREE.MeshStandardMaterial({ color: 0xd9cbb5, roughness: 0.5 });
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x14110f, roughness: 0.3 });

  // Big rounded body.
  const body = new THREE.Mesh(new THREE.SphereGeometry(cfg.radius * 0.85, 16, 14), fur);
  body.scale.set(1.25, 1, 0.85);
  group.add(body);

  // Snout and nose at the front.
  const snout = new THREE.Mesh(new THREE.SphereGeometry(cfg.radius * 0.42, 14, 10), darkFur);
  snout.scale.set(1.4, 1, 0.9);
  snout.position.set(cfg.radius * 0.9, 0, -cfg.radius * 0.05);
  group.add(snout);

  const nose = new THREE.Mesh(new THREE.SphereGeometry(cfg.radius * 0.14, 8, 6), clawMat);
  nose.position.set(cfg.radius * 1.3, 0, cfg.radius * 0.05);
  group.add(nose);

  // Oversized claw arms.
  for (const side of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.SphereGeometry(cfg.radius * 0.32, 10, 8), darkFur);
    arm.scale.set(1.3, 0.8, 0.8);
    arm.position.set(cfg.radius * 0.5, side * cfg.radius * 0.8, -cfg.radius * 0.1);
    group.add(arm);

    for (let c = 0; c < 3; c++) {
      const claw = new THREE.Mesh(
        new THREE.ConeGeometry(cfg.radius * 0.07, cfg.radius * 0.35, 5),
        clawMat
      );
      claw.rotation.z = -Math.PI / 2;
      claw.position.set(
        cfg.radius * 0.85,
        side * (cfg.radius * 0.8 + (c - 1) * cfg.radius * 0.13),
        -cfg.radius * 0.1
      );
      group.add(claw);
    }
  }

  // Tiny eyes.
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(cfg.radius * 0.08, 8, 6), eyeMat);
    eye.position.set(cfg.radius * 0.85, side * cfg.radius * 0.22, cfg.radius * 0.22);
    group.add(eye);
  }

  return group;
}

// ---------------------------------------------------------------------------
// Type table
// ---------------------------------------------------------------------------
/**
 * Every enemy archetype. `speedScale` multiplies the difficulty-driven base
 * speed; `hp` is how many attacks it survives; `points` is the kill reward.
 */
export const ENEMY_TYPES = {
  fly: { key: 'fly', label: 'Fly', radius: 22, hp: 1, points: 10, speedScale: 1.0, contactDamage: 20, armor: 0, build: buildFly },
  mosquito: { key: 'mosquito', label: 'Mosquito', radius: 15, hp: 1, points: 15, speedScale: 1.65, contactDamage: 20, armor: 0, build: buildMosquito },
  bee: { key: 'bee', label: 'Bee', radius: 20, hp: 1, points: 25, speedScale: 1.15, contactDamage: 20, armor: 0, build: buildBee },
  beetle: { key: 'beetle', label: 'Beetle', radius: 30, hp: 2, points: 40, speedScale: 0.7, contactDamage: 20, armor: 0, build: buildBeetle },
  centipede: { key: 'centipede', label: 'Centipede', radius: 26, hp: 2, points: 35, speedScale: 0.85, contactDamage: 30, armor: 0, build: buildCentipede },
  mole: { key: 'mole', label: 'Mole', radius: 32, hp: 4, points: 45, speedScale: 0.6, contactDamage: 20, armor: 0.5, build: buildMole },
};

/**
 * Chooses which insect to spawn, weighting the mix towards tougher species as
 * the score climbs. Early game stays gentle so new players can find their feet.
 *
 * @param {number} score The player's current score.
 * @returns {string} A key into ENEMY_TYPES.
 */
export function pickEnemyType(score) {
  const pool = ['fly', 'fly', 'fly'];

  if (score >= 15) pool.push('mosquito', 'fly');
  if (score >= 35) pool.push('mosquito', 'bee');
  if (score >= 60) pool.push('bee', 'beetle');
  if (score >= 100) pool.push('beetle', 'mosquito');
  if (score >= 150) pool.push('centipede', 'mole');
  if (score >= 250) pool.push('centipede', 'mole', 'beetle');

  return pool[Math.floor(Math.random() * pool.length)];
}

// Blueprints are built once and cloned per spawn — geometry and materials are
// shared, so a swarm of twenty insects costs almost nothing extra.
const blueprintCache = new Map();

function getBlueprint(typeKey) {
  if (!blueprintCache.has(typeKey)) {
    const cfg = ENEMY_TYPES[typeKey];
    blueprintCache.set(typeKey, cfg.build(cfg));
  }
  return blueprintCache.get(typeKey);
}

// ---------------------------------------------------------------------------
// Enemy
// ---------------------------------------------------------------------------
/**
 * A single flying insect that hunts the hero. Archetypes differ in speed,
 * size, durability and kill value — see ENEMY_TYPES.
 *
 * Each insect runs a tiny state machine: it is either `chasing` the hero or
 * `disengaged` after something scared it off. A disengaged insect drifts away
 * from the player for a few seconds, then asks the caller to remove it.
 */
export class Enemy {
  /**
   * @param {THREE.Scene} scene The scene the enemy should be added to.
   * @param {THREE.Vector2} spawnPoint Starting position on the ground plane.
   * @param {string} [typeKey] Which archetype to spawn.
   * @param {boolean} [elite] Force elite on/off; defaults to a random roll.
   */
  constructor(scene, spawnPoint, typeKey = 'fly', elite = Math.random() < ELITE_CHANCE, options = {}) {
    this.scene = scene;

    /** Archetype definition. */
    this.type = ENEMY_TYPES[typeKey] || ENEMY_TYPES.fly;
    /** Archetype key, handy for debugging. */
    this.typeKey = this.type.key;

    /** Bosses are the same species scaled up and made far tougher. */
    this.boss = options.boss === true;
    /** Which boss of the run this is (0 for the first). Drives every ramp. */
    this.bossIndex = this.boss ? options.bossIndex || 0 : 0;
    /** Visual scale applied to the whole body. */
    this.scale = this.boss ? BOSS_SCALE : 1;

    /** How much of the difficulty-driven base speed this species uses. */
    this.speedScale = this.type.speedScale;
    /** Current speed in world units per second. */
    this.speed = ENEMY_SPEED * this.speedScale * (this.boss ? BOSS_SPEED_SCALE : 1);

    /**
     * Every boss stat that ramps with the boss number comes from one place,
     * so health, armour, contact damage and the enrage point can never drift
     * apart from each other.
     */
    const profile = this.boss
      ? bossProfile(this.type, this.bossIndex, options.heroAttack || 1)
      : null;

    /**
     * Fraction of incoming damage ignored (0–1).
     *
     * Bosses get the flat bonus plus a small per-boss increment, so a fifth
     * giant shrugs off noticeably more than the first. Capped well below 1
     * so a late boss can never become literally untouchable.
     */
    this.armor = profile ? profile.armor : this.type.armor || 0;
    /** Damage this species deals on contact. */
    this.contactDamage = profile ? profile.contactDamage : this.type.contactDamage || 20;
    /** Points awarded on death. */
    this.points = this.type.points * (this.boss ? BOSS_POINT_MULT : 1);
    /** Remaining hit points. */
    this.baseMaxHp = this.type.hp;
    this.maxHp = profile ? profile.maxHp : this.type.hp;
    this.hp = this.maxHp;

    /**
     * Fraction of max HP below which the boss enrages. Later bosses enrage
     * earlier, so the frantic phase lasts longer each time.
     */
    this.enrageThreshold = profile ? profile.enrageThreshold : BOSS_ENRAGE_THRESHOLD;

    /** Seconds until the boss may summon another wave (bosses only). */
    this.summonTimer = this.boss ? BOSS_SUMMON_INTERVAL : 0;
    /** Set once the boss has entered its enraged phase. */
    this.enraged = false;

    /**
     * Signature ability state (bosses only).
     *
     * `abilityKey` is the identifier the main loop switches on. `abilityTimer`
     * counts down to the next cast; the first cast is deliberately late so
     * the player gets a few seconds to read the giant before it closes.
     */
    this.ability = this.boss ? BOSS_ABILITIES[this.typeKey] || null : null;
    this.abilityKey = this.ability ? this.ability.key : null;
    this.abilityCooldown = this.ability
      ? bossAbilityCooldown(this.typeKey, this.bossIndex)
      : Infinity;
    this.abilityTimer = this.abilityCooldown * 0.75;
    /** True while the ability is telegraphing or resolving. */
    this.abilityActive = false;
    /** Seconds left in the current ability phase. */
    this.abilityPhaseTimer = 0;
    /** @type {'idle' | 'windup' | 'dash' | 'underground'} */
    this.abilityPhase = 'idle';

    // World-space holder on the ground plane; the body is lifted to hover.
    this.group = new THREE.Group();
    this.group.position.set(spawnPoint.x, spawnPoint.y, 0);
    scene.add(this.group);

    // Fresh copy of the blueprint, lifted so the insect flies above the board.
    this.visual = getBlueprint(this.typeKey).clone(true);
    this.visual.position.z = ENEMY_HOVER;
    if (this.scale !== 1) this.visual.scale.setScalar(this.scale);
    this.group.add(this.visual);

    // A soft ground shadow anchors the hovering body to the board. It lives on
    // the ground group, not the lifted visual, so it stays put while the body
    // hovers and cannot inherit the body's wing/tilt animation.
    this.shadow = new THREE.Mesh(
      new THREE.CircleGeometry(1, 24),
      getEnemyShadowMaterial()
    );
    this.shadow.scale.setScalar(this.radius);
    this.shadow.position.z = 0.75;
    this.shadow.renderOrder = 1;
    this.group.add(this.shadow);

    // Elites wear a gold ring and always drop a gene.
    this.elite = elite;
    if (elite) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(this.type.radius * 1.15, 2.4, 6, 24),
        new THREE.MeshStandardMaterial({
          color: 0xffc83d,
          emissive: 0xffa500,
          emissiveIntensity: 0.7,
          roughness: 0.4,
        })
      );
      ring.position.z = ENEMY_HOVER;
      this.group.add(ring);
      this.eliteRing = ring;
    }

    // Collect the wings so they can be flapped.
    this.wings = [];
    this.visual.traverse((node) => {
      if (node.name === 'wing') this.wings.push(node);
    });

    // Wing-flap phase, randomised so a swarm doesn't beat in lockstep.
    this.flapPhase = Math.random() * Math.PI * 2;

    // Bosses get a ground aura so they read as a threat at a glance.
    //
    // The old aura was a torus tilted flat. A torus is a *tube*, so at boss
    // scale its outer and inner walls cut through the body and the wings,
    // which is what made the giant look mangled. It was also parented to the
    // body group, so it tilted with every heading change.
    //
    // The replacement is a flat translucent disc that only touches one pixel
    // row at the silhouette, plus a paper-thin inner ring for definition.
    // Both sit at ground level on their own object, so nothing intersects.
    if (this.boss) {
      const radius = this.radius;
      const aura = new THREE.Mesh(
        new THREE.RingGeometry(radius * 0.72, radius * 1.02, 64),
        new THREE.MeshBasicMaterial({
          color: 0xff3d6e,
          transparent: true,
          opacity: 0.26,
          side: THREE.DoubleSide,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        })
      );
      // Z-up world: a ring is authored in XY, so no rotation is needed.
      aura.position.z = 1.5;
      this.group.add(aura);
      this.halo = aura;

      // A crisp edge line: a thin ring is far more legible than a thick disc
      // and never clips the body.
      const rim = new THREE.Mesh(
        new THREE.RingGeometry(radius * 1.0, radius * 1.06, 64),
        new THREE.MeshBasicMaterial({
          color: 0xff8aa5,
          transparent: true,
          opacity: 0.7,
          side: THREE.DoubleSide,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        })
      );
      rim.position.z = 1.6;
      this.group.add(rim);
      this.haloRim = rim;
    }

    // Countdown for the "took a hit but survived" swell.
    this.hitFlash = 0;

    // Seconds left in the croak stun. main.js checks this before movement so
    // a shoved insect visibly stops instead of sliding straight back in.
    this.stunTimer = 0;

    // ---- State machine ----------------------------------------------------
    /** @type {'chasing' | 'disengaged'} */
    this.state = 'chasing';
    /** Seconds since the enemy disengaged; once it crosses 4s the caller removes it. */
    this.disengageTimer = 0;
    /** Cached unit vector pointing away from the hero when disengaging. */
    this.disengageDirection = new THREE.Vector2(1, 0);

    this.loaded = true;

    // Wander state: when the hero is hidden, chasing insects lose their
    // target and drift aimlessly until he shows himself again.
    this.wanderTarget = new THREE.Vector2(0, 0);
    this.wanderTimer = 0;
  }

  /**
   * Updates the base speed from the difficulty system, preserving this
   * species' relative pace.
   *
   * @param {number} baseSpeed The shared, difficulty-scaled base speed.
   */
  /**
   * Collision radius on the ground plane, scaled for bosses.
   *
   * @returns {number}
   */
  get radius() {
    return this.type.radius * this.scale;
  }

  /**
   * Re-rolls this boss's health for a hypothetical attack power.
   *
   * Delegates to `bossProfile` so a test can ask "how many hits would this
   * boss demand from a much stronger hero?" without spawning anything.
   *
   * @param {{bossIndex?: number, heroAttack?: number}} options
   * @returns {number} The boss's max HP, as a whole number of hit points.
   */
  bossHealth(options = {}) {
    return bossProfile(
      this.type,
      options.bossIndex !== undefined ? options.bossIndex : this.bossIndex,
      options.heroAttack || 1
    ).maxHp;
  }

  /**
   * Bosses shed a wave of minions on a timer, and go berserk once wounded.
   *
   * @param {number} delta Seconds since the previous frame.
   * @returns {boolean} True when this frame's summon is due.
   */
  tickBoss(delta) {
    if (!this.boss) return false;

    // Enrage once the bar drops below the threshold; the caller reads
    // `enraged` to drive the aura and the speed bump.
    if (!this.enraged && this.hp <= this.maxHp * this.enrageThreshold) {
      this.enraged = true;
      this.speed *= BOSS_ENRAGE_SPEED;
      this.setAuraIntensity(2);
    }

    // Signature ability cooldown. The caller polls `abilityReady` and drives
    // the actual cast, because each ability needs the world (player, scene,
    // obstacles) and this class deliberately owns none of it.
    if (this.abilityKey) {
      this.abilityTimer -= delta;
    }

    this.summonTimer -= delta;
    if (this.summonTimer <= 0) {
      this.summonTimer = BOSS_SUMMON_INTERVAL * (this.enraged ? 0.6 : 1);
      return true;
    }
    return false;
  }

  /**
   * Burns the aura hotter as the fight escalates.
   *
   * @param {number} level 1 = calm, 2 = enraged, 3 = mid-cast telegraph.
   */
  setAuraIntensity(level) {
    if (!this.halo) return;
    this.halo.material.opacity = [0.26, 0.46, 0.62][Math.min(2, level - 1)];
    if (this.haloRim) this.haloRim.material.opacity = [0.7, 0.95, 1][Math.min(2, level - 1)];
  }

  setBaseSpeed(baseSpeed) {
    this.speed = baseSpeed * this.speedScale;
  }

  /**
   * Applies one hit, reduced by this species' armour.
   *
   * @param {number} [damage] Damage in "hit units". Armour reduces it.
   * @returns {boolean} True if the insect was destroyed, false if it survived.
   */
  takeHit(damage = 1) {
    const effective = damage * (1 - this.armor);
    this.hp -= effective;
    if (this.hp > 0) {
      this.hitFlash = 0.25;
      return false;
    }
    return true;
  }

  /**
   * Stops this insect for a short beat. Bosses are excluded by the caller.
   *
   * @param {number} seconds Stun duration.
   */
  stun(seconds) {
    if (!(seconds > 0)) return;
    this.stunTimer = Math.max(this.stunTimer, seconds);
  }

  /**
   * Applies damage that ignores armour. Used by the Bomb pickup, whose
   * advertised 20% of a boss's max HP should not shrink with boss armour.
   *
   * @param {number} damage
   * @returns {boolean} True if the insect was destroyed, false if it survived.
   */
  takeTrueDamage(damage) {
    this.hp -= damage;
    if (this.hp > 0) {
      this.hitFlash = 0.25;
      return false;
    }
    return true;
  }

  /**
   * Animates the wings and the damage swell. Called once per frame.
   *
   * @param {number} delta Seconds since the previous frame.
   */
  animate(delta) {
    this.flapPhase += delta * 26;
    const flap = Math.sin(this.flapPhase) * 0.45;

    for (const wing of this.wings) {
      const side = wing.userData.side;
      wing.rotation.x = side * (0.25 + flap);
    }

    // A brief swell makes a non-fatal hit legible.
    //
    // The swell has to be relative to `this.scale`, not to 1: resetting to 1
    // used to shrink a boss back to the size of an ordinary insect the frame
    // after its first hit landed. That is why giants looked small in play
    // even though the spawn-time scale was correct.
    if (this.hitFlash > 0) {
      this.hitFlash = Math.max(0, this.hitFlash - delta);
      const t = this.hitFlash / 0.25;
      this.visual.scale.setScalar(this.scale * (1 + 0.35 * t));
    } else if (this.visual.scale.x !== this.scale) {
      this.visual.scale.setScalar(this.scale);
    }
  }

  /**
   * Advances the state machine.
   *
   * Insects used to drop aggro when a tree broke line of sight. That mechanic
   * is gone: the canopy sits far above the insect's hover height, so nothing
   * ever *looked* like it was blocking the view, and the player could not
   * tell the behaviour apart from random wandering. The only way into
   * `disengaged` now is `fleeFrom()`, called by the pond's repel bonus.
   *
   * @param {number} delta Seconds since the previous frame.
   */
  updateBehavior(delta) {
    if (this.state === 'disengaged') {
      this.disengageTimer += delta;
    }
  }

  /**
   * Picks a fresh point to drift towards while the hero is hidden.
   *
   * Called by the main loop on a timer so a hidden insect wanders instead of
   * homing.
   *
   * @param {number} x Current world X.
   * @param {number} y Current world Y.
   * @param {() => number} rand Random source (defaults to Math.random).
   */
  pickWander(x, y, rand = Math.random) {
    const angle = rand() * Math.PI * 2;
    const dist = 120 + rand() * 220;
    this.wanderTarget.set(x + Math.cos(angle) * dist, y + Math.sin(angle) * dist);
    this.wanderTimer = 1.5 + rand() * 1.5;
  }

  /**
   * Sends the insect running away from a point, and eventually off the board.
   *
   * @param {number} x World X to flee from.
   * @param {number} y World Y to flee from.
   */
  fleeFrom(x, y) {
    this.state = 'disengaged';
    this.disengageTimer = 0;
    this.disengageDirection.set(
      this.group.position.x - x,
      this.group.position.y - y
    );
    if (this.disengageDirection.lengthSq() < 1e-4) {
      this.disengageDirection.set(1, 0);
    } else {
      this.disengageDirection.normalize();
    }
  }

  /**
   * Records where the player was last seen. Drives the disengage fly-away
   * direction, and is what the chaser still chases towards.
   *
   * @param {number} x
   * @param {number} y
   */
  rememberPlayerPosition(x, y) {
    this.lastSeenX = x;
    this.lastSeenY = y;
  }

  /**
   * True once the insect has been disengaged long enough to clean up.
   *
   * A boss is never retired this way: it is the encounter, not part of the
   * swarm, and it has to be killed to end. Disengaging is a scare effect for
   * ordinary insects.
   *
   * @returns {boolean}
   */
  get readyToRemove() {
    if (this.boss) return false;
    return this.state === 'disengaged' && this.disengageTimer >= 4;
  }

  /**
   * Returns the enemy's position on the ground plane.
   *
   * @returns {THREE.Vector3}
   */
  get position() {
    return this.group.position;
  }

  /**
   * Removes this enemy from the scene.
   */
  dispose() {
    this.scene.remove(this.group);
  }
}

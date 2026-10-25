import * as THREE from 'three';
import { BOARD_HALF } from './Map.js';
import { sound } from './Sound.js';

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------
/** Seconds between power-up spawn attempts. */
export const POWERUP_SPAWN_INTERVAL = 9;
/** How many pickups may be lying on the board at once. */
export const POWERUP_MAX_ACTIVE = 3;
/** Seconds a pickup waits to be collected before vanishing. */
export const POWERUP_LIFETIME = 16;
/** How close the hero must hop to grab a pickup. */
export const PICKUP_RADIUS = 62;
/**
 * Pickups inside this radius drift toward the hero before being collected.
 * Widening the collect radius instead would make the pickup snap from far
 * away; the magnet keeps the grab point explicit while removing the need to
 * land on the exact centre of the marker.
 */
export const PICKUP_MAGNET_RADIUS = 260;
/** Pull speed at full strength, in world units per second. */
export const PICKUP_MAGNET_SPEED = 720;
/** Height the icons float at, in world units. */
export const POWERUP_FLOAT = 46;

/**
 * Every power-up archetype.
 *
 * `detail` is the plain-language explanation shown when the pickup is
 * collected — it spells out the actual numbers, so the player never has to
 * guess what a gem or a bubble does.
 */
export const POWERUP_TYPES = {
  speed: {
    key: 'speed',
    label: 'Speed',
    blurb: 'Hop faster',
    detail: 'Hop cooldown cut to 55%, so you hop almost twice as often.',
    duration: 12,
    color: 0xffd23f,
    multiplier: 0.55,
  },
  shield: {
    key: 'shield',
    label: 'Shield',
    blurb: 'Invincible',
    detail: 'Insects cannot hurt you while the shield holds.',
    duration: 10,
    color: 0x4da6ff,
    multiplier: 1,
  },
  range: {
    key: 'range',
    label: 'Range',
    blurb: 'Longer snap',
    detail: 'Your tongue snap reaches 1.9x further — the croak wave grows to match.',
    duration: 14,
    color: 0xff8c1a,
    multiplier: 1.9,
  },
  freeze: {
    key: 'freeze',
    label: 'Freeze',
    blurb: 'Slow insects',
    detail: 'Every insect drops to 35% speed.',
    duration: 10,
    color: 0x8ee8ff,
    multiplier: 0.35,
  },
  heart: {
    key: 'heart',
    label: 'Heart',
    blurb: 'Max HP +20',
    detail: 'Raises max HP by 20 for the rest of the run and restores 20 HP.',
    duration: 0,
    instant: true,
    color: 0xe5484d,
    multiplier: 1,
  },
  bomb: {
    key: 'bomb',
    label: 'Bomb',
    blurb: 'Clear the sky',
    detail: 'Detonates instantly: clears ordinary insects and deals 20% of a boss\'s max HP.',
    duration: 0,
    instant: true,
    color: 0xb08cff,
    multiplier: 1,
  },
};

const TYPE_KEYS = Object.keys(POWERUP_TYPES);

// ---------------------------------------------------------------------------
// Icon meshes
// ---------------------------------------------------------------------------
/**
 * Builds the floating icon for one power-up type.
 *
 * @param {typeof POWERUP_TYPES[keyof typeof POWERUP_TYPES]} cfg Type definition.
 * @returns {THREE.Group}
 */
function buildIcon(cfg) {
  const group = new THREE.Group();

  const solid = new THREE.MeshStandardMaterial({
    color: cfg.color,
    emissive: cfg.color,
    emissiveIntensity: 0.55,
    roughness: 0.3,
    metalness: 0.35,
  });

  switch (cfg.key) {
    case 'speed': {
      // A faceted gem reads as "energy".
      group.add(new THREE.Mesh(new THREE.OctahedronGeometry(15), solid));
      break;
    }
    case 'shield': {
      // A translucent bubble with a wireframe shell.
      const bubble = new THREE.Mesh(
        new THREE.SphereGeometry(15, 20, 14),
        new THREE.MeshStandardMaterial({
          color: cfg.color,
          transparent: true,
          opacity: 0.35,
          roughness: 0.1,
          metalness: 0.2,
        })
      );
      group.add(bubble);

      const shell = new THREE.Mesh(
        new THREE.IcosahedronGeometry(19, 0),
        new THREE.MeshBasicMaterial({ color: cfg.color, wireframe: true, transparent: true, opacity: 0.6 })
      );
      group.add(shell);
      break;
    }
    case 'range': {
      // A shockwave ring echoes the attack effect.
      const ring = new THREE.Mesh(new THREE.TorusGeometry(14, 4.5, 10, 22), solid);
      group.add(ring);
      break;
    }
    case 'heart': {
      // A chunky medical cross. Unlike a flat heart shape it reads clearly
      // from every camera angle.
      group.add(new THREE.Mesh(new THREE.BoxGeometry(26, 8, 8), solid));
      group.add(new THREE.Mesh(new THREE.BoxGeometry(8, 8, 26), solid));
      break;
    }
    case 'bomb': {
      group.add(new THREE.Mesh(new THREE.SphereGeometry(14, 16, 12), solid));

      // Fuse and spark, so it reads as a bomb rather than a plain ball.
      const fuse = new THREE.Mesh(
        new THREE.CylinderGeometry(2.5, 2.5, 11, 8),
        new THREE.MeshStandardMaterial({ color: 0x6b5a3e, roughness: 0.85 })
      );
      fuse.position.z = 17;
      group.add(fuse);

      const spark = new THREE.Mesh(
        new THREE.SphereGeometry(4, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0xffe066 })
      );
      spark.position.z = 23;
      group.add(spark);
      break;
    }
    default: {
      // freeze — a jagged crystal.
      group.add(new THREE.Mesh(new THREE.IcosahedronGeometry(15, 0), solid));
      break;
    }
  }

  group.position.z = POWERUP_FLOAT;
  return group;
}

/**
 * Builds the flat ring that marks a pickup's spot on the ground.
 *
 * @param {typeof POWERUP_TYPES[keyof typeof POWERUP_TYPES]} cfg Type definition.
 * @returns {THREE.Mesh}
 */
function buildMarker(cfg) {
  const marker = new THREE.Mesh(
    new THREE.CircleGeometry(30, 24),
    new THREE.MeshBasicMaterial({
      color: cfg.color,
      transparent: true,
      opacity: 0.32,
      side: THREE.DoubleSide,
    })
  );
  // Just above the tiles, so it does not z-fight with the floor.
  marker.position.z = 1.2;
  return marker;
}

const iconCache = new Map();

function getIcon(typeKey) {
  if (!iconCache.has(typeKey)) {
    iconCache.set(typeKey, buildIcon(POWERUP_TYPES[typeKey]));
  }
  return iconCache.get(typeKey);
}

// ---------------------------------------------------------------------------
// PowerUp
// ---------------------------------------------------------------------------
/** One collectable pickup sitting on the board. */
export class PowerUp {
  /**
   * @param {THREE.Scene} scene Scene to attach to.
   * @param {THREE.Vector2} position Ground position.
   * @param {string} typeKey Which archetype.
   * @param {number} [boostedMul] Multiplier on the timed effect's duration.
   *   Flowers drop a 1.5x version of their random power-up.
   */
  constructor(scene, position, typeKey, boostedMul = 1) {
    this.scene = scene;
    this.type = POWERUP_TYPES[typeKey];
    this.typeKey = typeKey;
    /** 1.5x when dropped by a flower, 1 otherwise. */
    this.boostedMul = boostedMul;

    this.group = new THREE.Group();
    this.group.position.set(position.x, position.y, 0);
    scene.add(this.group);

    this.icon = getIcon(typeKey).clone(true);
    this.group.add(this.icon);

    // The ground marker is a sibling rather than a child of the icon, so it
    // stays pinned to the floor while the icon bobs up and down.
    this.marker = buildMarker(this.type);
    this.group.add(this.marker);

    /** Everything that should fade when the pickup is about to expire. */
    this.fadeNodes = [this.icon, this.marker];

    /** Seconds left before this pickup despawns. */
    this.life = POWERUP_LIFETIME;
    /** Randomised bob phase so icons don't move in lockstep. */
    this.phase = Math.random() * Math.PI * 2;

    this.collected = false;
    this.loaded = true;
  }

  /** Ground position of this pickup. */
  get position() {
    return this.group.position;
  }

  /**
   * Bobs, spins and counts down the lifetime.
   *
   * @param {number} delta Seconds since the previous frame.
   */
  animate(delta) {
    this.life -= delta;
    this.phase += delta * 2.4;

    this.icon.rotation.z += delta * 1.6;
    this.icon.position.z = POWERUP_FLOAT + Math.sin(this.phase) * 5;

    // Flash as it runs out of time, so the player knows to hurry.
    const blink = this.life < 4 && Math.sin(this.life * 18) <= 0 ? 0.3 : 1;
    for (const node of this.fadeNodes) {
      node.traverse((child) => {
        const material = child.material;
        if (!material || !('opacity' in material)) return;
        if (child.userData.baseOpacity === undefined) {
          child.userData.baseOpacity = material.opacity;
        }
        material.opacity = child.userData.baseOpacity * blink;
      });
    }
  }

  /** True once its lifetime has run out. */
  get expired() {
    return this.life <= 0;
  }

  /** Removes the pickup from the scene. */
  dispose() {
    this.scene.remove(this.group);
  }
}

// ---------------------------------------------------------------------------
// PowerUpManager
// ---------------------------------------------------------------------------
/**
 * Owns everything power-up related: spawning pickups, animating them,
 * detecting collection, tracking active effects, and drawing the HUD.
 */
export class PowerUpManager {
  /**
   * @param {THREE.Scene} scene The game scene.
   */
  constructor(scene) {
    this.scene = scene;

    /** Pickups currently lying on the board. */
    this.pickups = [];
    /** Seconds until the next spawn attempt. */
    this.spawnTimer = POWERUP_SPAWN_INTERVAL * 0.6;

    /** Remaining seconds for each active effect. */
    this.effects = {};
    for (const key of TYPE_KEYS) this.effects[key] = 0;

    /**
     * Remaining seconds of the "pond chill" effect, which stacks on top of the
     * regular freeze power-up to slow every insect to 40% speed.
     */
    this.pondSlowTimer = 0;

    this.buildHud();
  }

  /** Creates the effect chips and the pickup card. */
  buildHud() {
    this.hud = document.createElement('div');
    this.hud.className = 'effects';
    document.body.appendChild(this.hud);

    // Transient card explaining a pickup the moment it is collected.
    this.toast = document.createElement('div');
    this.toast.className = 'pickup-toast';
    this.toast.style.display = 'none';
    document.body.appendChild(this.toast);
    this.toastTimer = 0;

    /** @type {Record<string, HTMLElement>} */
    this.chips = {};
    for (const key of TYPE_KEYS) {
      const type = POWERUP_TYPES[key];

      const chip = document.createElement('div');
      chip.className = 'effect';
      chip.dataset.type = key;
      chip.style.setProperty('--chip', `#${type.color.toString(16).padStart(6, '0')}`);
      // Hovering a chip repeats the full explanation.
      chip.title = type.instant
        ? `${type.label} — ${type.detail}`
        : `${type.label} — ${type.detail} Lasts ${type.duration}s.`;

      const name = document.createElement('span');
      name.className = 'effect-name';
      name.textContent = `${type.label} · ${type.blurb}`;

      const time = document.createElement('span');
      time.className = 'effect-time';
      time.textContent = '';

      chip.append(name, time);
      chip.style.display = 'none';
      this.hud.appendChild(chip);
      this.chips[key] = { chip, time };
    }
  }

  /**
   * Pops up a card describing the power-up that was just collected, spelling
   * out what it actually does and for how long.
   *
   * @param {typeof POWERUP_TYPES[keyof typeof POWERUP_TYPES]} type Type taken.
   */
  showPickupCard(type) {
    const hex = `#${type.color.toString(16).padStart(6, '0')}`;
    this.toast.innerHTML = [
      `<div class="pickup-name" style="color:${hex}">${type.label} — ${type.blurb}</div>`,
      `<div class="pickup-detail">${type.detail}</div>`,
      type.instant
        ? '<div class="pickup-duration">Instant effect</div>'
        : `<div class="pickup-duration">Active for ${type.duration} seconds</div>`,
    ].join('');

    // Re-trigger the entrance animation even if a card is already on screen.
    this.toast.style.display = 'block';
    this.toast.classList.remove('is-shown');
    void this.toast.offsetWidth;
    this.toast.classList.add('is-shown');

    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toast.style.display = 'none';
    }, 3000);
  }

  /**
   * Spawns a pickup at a free spot on the board.
   *
   * @param {(x: number, y: number) => boolean} isFree Placement predicate.
   */
  spawn(isFree) {
    const half = BOARD_HALF - 150;
    for (let attempt = 0; attempt < 40; attempt++) {
      const x = THREE.MathUtils.randFloatSpread(half * 2);
      const y = THREE.MathUtils.randFloatSpread(half * 2);
      if (!isFree(x, y)) continue;

      const typeKey = TYPE_KEYS[Math.floor(Math.random() * TYPE_KEYS.length)];
      this.pickups.push(new PowerUp(this.scene, new THREE.Vector2(x, y), typeKey));
      return;
    }
  }

  /**
   * Spawns a pickup at a specific spot, choosing randomly from the given
   * type keys. Used by flowers that bloom into a 1.5x power-up.
   *
   * @param {number} x
   * @param {number} y
   * @param {Array<string>} typePool One of `TYPE_KEYS` style keys to pick from.
   * @param {number} [boostedMul] Duration multiplier on the picked-up effect.
   */
  spawnAt(x, y, typePool, boostedMul = 1) {
    const pool = typePool && typePool.length > 0 ? typePool : TYPE_KEYS;
    const typeKey = pool[Math.floor(Math.random() * pool.length)];
    this.pickups.push(new PowerUp(this.scene, new THREE.Vector2(x, y), typeKey, boostedMul));
  }

  /**
   * Advances spawning, animation, collection and effect timers.
   *
   * @param {number} delta Seconds since the previous frame.
   * @param {THREE.Vector3} playerPosition The hero's world position.
   * @param {(x: number, y: number) => boolean} isFree Placement predicate.
   * @returns {Array<typeof POWERUP_TYPES[keyof typeof POWERUP_TYPES]>} Types
   *   collected this frame that take effect immediately (Heart, Bomb). The
   *   caller owns the systems they touch, so it applies them.
   */
  update(delta, playerPosition, isFree) {
    /** @type {Array<typeof POWERUP_TYPES[keyof typeof POWERUP_TYPES]>} */
    const collected = [];

    // --- Spawning ---------------------------------------------------------
    this.spawnTimer -= delta;
    if (this.spawnTimer <= 0) {
      if (this.pickups.length < POWERUP_MAX_ACTIVE) this.spawn(isFree);
      this.spawnTimer = POWERUP_SPAWN_INTERVAL;
    }

    // --- Pickups ----------------------------------------------------------
    for (const pickup of this.pickups) {
      pickup.animate(delta);

      let dx = pickup.position.x - playerPosition.x;
      let dy = pickup.position.y - playerPosition.y;
      let distance = Math.hypot(dx, dy);

      // Pull nearby pickups in. The pull eases to zero at the outer edge, so
      // the pickup starts drifting rather than snapping sideways.
      if (distance > PICKUP_RADIUS && distance < PICKUP_MAGNET_RADIUS) {
        const strength = 1 - distance / PICKUP_MAGNET_RADIUS;
        const pull = strength * PICKUP_MAGNET_SPEED * delta;
        pickup.position.x -= (dx / distance) * pull;
        pickup.position.y -= (dy / distance) * pull;

        // The marker swells as the pull strengthens, so the magnet is
        // visible instead of silently sliding the icon a few units.
        pickup.marker.scale.setScalar(1 + strength * 0.35);

        dx = pickup.position.x - playerPosition.x;
        dy = pickup.position.y - playerPosition.y;
        distance = Math.hypot(dx, dy);
      } else {
        pickup.marker.scale.setScalar(1);
      }

      if (distance <= PICKUP_RADIUS) {
        pickup.collected = true;

        // Timed pickups run on a countdown; instant ones are handed back to
        // the caller, which owns the systems they affect.
        if (pickup.type.instant) {
          collected.push(pickup.type);
        } else {
          this.effects[pickup.typeKey] = pickup.type.duration * (pickup.boostedMul || 1);
        }

        // Tell the player what they just picked up, and what it does.
        this.showPickupCard(pickup.type);
        sound.powerUp();
      }
    }

    const survivors = this.pickups.filter((p) => {
      if (p.collected || p.expired) {
        p.dispose();
        return false;
      }
      return true;
    });
    this.pickups = survivors;

    // --- Effect timers ----------------------------------------------------
    for (const key of TYPE_KEYS) {
      if (this.effects[key] > 0) {
        this.effects[key] = Math.max(0, this.effects[key] - delta);
      }
    }

    this.renderHud();
    return collected;
  }

  /** Mirrors the active effects into the HUD chips. */
  renderHud() {
    for (const key of TYPE_KEYS) {
      const remaining = this.effects[key];
      const { chip, time } = this.chips[key];

      if (remaining > 0) {
        chip.style.display = 'inline-flex';
        time.textContent = `${remaining.toFixed(1)}s`;
      } else {
        chip.style.display = 'none';
      }
    }
  }

  /**
   * Whether a given effect is currently active.
   *
   * @param {string} key Effect key.
   * @returns {boolean}
   */
  isActive(key) {
    return this.effects[key] > 0;
  }

  /**
   * Combined multipliers derived from the active effects.
   *
   * @returns {{ hopDuration: number, attackRadius: number, enemySpeed: number, shielded: boolean }}
   */
  get multipliers() {
    return {
      hopDuration: this.isActive('speed') ? POWERUP_TYPES.speed.multiplier : 1,
      attackRadius: this.isActive('range') ? POWERUP_TYPES.range.multiplier : 1,
      enemySpeed: this.isActive('freeze') ? POWERUP_TYPES.freeze.multiplier : 1,
      shielded: this.isActive('shield'),
    };
  }

  /** Clears every pickup and effect (used when restarting). */
  reset() {
    this.pickups.forEach((p) => p.dispose());
    this.pickups = [];
    this.spawnTimer = POWERUP_SPAWN_INTERVAL * 0.6;
    for (const key of TYPE_KEYS) this.effects[key] = 0;
    this.pondSlowTimer = 0;
    this.renderHud();
  }
}

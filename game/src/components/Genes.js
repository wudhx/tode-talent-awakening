import * as THREE from 'three';

/**
 * Gene system: killing an insect can drop a gene orb of that species. Orbs
 * carry a quality tier (common / rare / legendary). Picking one up locks that
 * species into a slot for the rest of the run and adds a stack; three
 * same-tier pickups upgrade the tier, and a higher-tier drop upgrades
 * immediately.
 *
 * Only the highest three (or however many slots are unlocked) species count,
 * and each slot must be a different species.
 */

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------
/** Quality tiers, weakest to strongest. */
export const GENE_TIERS = ['common', 'rare', 'legendary'];

/** Human-readable tier names (English, shown in the HUD). */
export const TIER_LABELS = {
  common: 'Common',
  rare: 'Rare',
  legendary: 'Legendary',
};

/** Emissive colours used by the orb meshes and the HUD pips. */
export const TIER_COLORS = {
  common: 0xd8dde3,
  rare: 0x4da6ff,
  legendary: 0xffc83d,
};

// ---------------------------------------------------------------------------
// Gene definitions
// ---------------------------------------------------------------------------
/**
 * Per-tier, per-layer values. `cap` is the absolute ceiling for that tier
 * (null means no cap). `floor` is used by the attack-cooldown gene.
 */
export const GENE_TYPES = {
  fly: {
    key: 'fly',
    label: 'Fly',
    stat: 'attackCooldown',
    description: 'Attack cooldown',
    perLayer: { common: 0.01, rare: 0.015, legendary: 0.02 },
    floor: { common: 0.35, rare: 0.2, legendary: 0.1 },
  },
  mosquito: {
    key: 'mosquito',
    label: 'Mosquito',
    stat: 'lifesteal',
    description: 'Lifesteal',
    perLayer: { common: 0.003, rare: 0.004, legendary: 0.005 },
    cap: { common: 0.25, rare: 0.3, legendary: 0.35 },
  },
  bee: {
    key: 'bee',
    label: 'Bee',
    stat: 'attackRange',
    description: 'Attack range',
    perLayer: { common: 5, rare: 7, legendary: 10 },
    cap: { common: 800, rare: 1200, legendary: 1600 },
  },
  beetle: {
    key: 'beetle',
    label: 'Beetle',
    stat: 'maxHp',
    description: 'Max HP',
    perLayer: { common: 2, rare: 2.5, legendary: 3 },
    cap: null,
  },
  centipede: {
    key: 'centipede',
    label: 'Centipede',
    stat: 'attackPower',
    description: 'Attack power',
    perLayer: { common: 1, rare: 2, legendary: 3 },
    cap: null,
  },
  mole: {
    key: 'mole',
    label: 'Mole',
    stat: 'damageReduction',
    description: 'Damage reduction',
    perLayer: { common: 0.03, rare: 0.045, legendary: 0.06 },
    cap: { common: 0.3, rare: 0.45, legendary: 0.6 },
  },
};

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
/** How close the hero must be to pick up an orb. */
export const GENE_PICKUP_RADIUS = 48;
/**
 * Orbs inside this radius drift toward the hero before being collected.
 * Gene orbs are choice drops rather than timed power-ups, so this is a pull,
 * not an automatic grab: the card still opens at the normal collect radius.
 */
export const GENE_MAGNET_RADIUS = 240;
/** Pull speed at full strength, in world units per second. */
export const GENE_MAGNET_SPEED = 600;
/** Consecutive kills without a drop before one is forced. */
export const GENE_PITY = 10;
/** Drop chance once every slot is legendary (stack-only orbs). */
export const LEGENDARY_DROP_CHANCE = 0.08;
/** Kills per stack once every slot is legendary. */
export const LEGENDARY_STACK_KILLS = 30;
/**
 * Points a stack-only orb is worth when taken. Once every gene is legendary
 * the orbs stop carrying score of their own, so without a payout the
 * awakening bar would quietly stall out in the late game; this keeps it
 * charging at roughly the same beat.
 */
export const LEGENDARY_ORB_SCORE = 40;
/** Shown on every gene card so stacking is never a mystery. */
export const STACK_RULE =
  'Collect three orbs of the same quality to upgrade the gene. Your stacks are converted so the total bonus stays the same.';

/**
 * Formats the per-stack gain for the pickup card.
 *
 * @param {object} cfg A GENE_TYPES entry.
 * @param {'common'|'rare'|'legendary'} tier
 * @returns {string}
 */
export function formatPerLayer(cfg, tier) {
  const per = cfg.perLayer[tier];
  switch (cfg.stat) {
    case 'attackCooldown':
      return `Each stack: -${(per * 100).toFixed(1)}% attack cooldown`;
    case 'lifesteal':
      return `Each stack: +${(per * 100).toFixed(1)}% lifesteal`;
    case 'damageReduction':
      return `Each stack: +${(per * 100).toFixed(1)}% damage reduction`;
    case 'attackRange':
      return `Each stack: +${per} attack range`;
    case 'maxHp':
      return `Each stack: +${per} max HP`;
    case 'attackPower':
      return `Each stack: +${per} attack power`;
    default:
      return `Each stack: +${per}`;
  }
}

/**
 * Formats the ceiling (or cooldown floor) for the pickup card.
 *
 * @param {object} cfg A GENE_TYPES entry.
 * @param {'common'|'rare'|'legendary'} tier
 * @returns {string}
 */
export function formatCap(cfg, tier) {
  if (cfg.stat === 'attackCooldown') {
    return `Minimum cooldown: ${cfg.floor[tier]}s`;
  }
  if (!cfg.cap) return 'No cap';
  const cap = cfg.cap[tier];
  if (cfg.stat === 'lifesteal' || cfg.stat === 'damageReduction') {
    return `Cap: ${Math.round(cap * 100)}%`;
  }
  return `Cap: ${cap}`;
}

/**
 * The gene system.
 */
export class GeneSystem {
  /**
   * @param {THREE.Scene} scene The scene the orbs live in.
   * @param {number} [slotCount] How many genes can be locked at once.
   */
  constructor(scene, slotCount = 3) {
    this.scene = scene;
    this.slotCount = slotCount;
    /** @type {Array<{key: string, tier: string, stacks: number, merge: number}|null>} */
    this.slots = new Array(slotCount).fill(null);
    /** @type {Array<{key: string, tier: string, mesh: THREE.Mesh, x: number, y: number, phase: number}>} */
    this.orbs = [];
    /** The orb currently awaiting an Absorb/Discard choice. */
    this.pending = null;
    /** Kills since the last drop, for the pity timer. */
    this.killsSinceDrop = 0;
    /** Kills since the last post-legendary stack gain. */
    this.stackKills = 0;
    /** Set to true once every slot is a legendary gene. */
    this.finished = false;
  }

  /** How many slots are currently filled. */
  get lockedCount() {
    return this.slots.filter(Boolean).length;
  }

  /** True once every slot holds a legendary gene. */
  get allLegendary() {
    const filled = this.slots.filter(Boolean);
    return filled.length >= this.slotCount && filled.every((g) => g.tier === 'legendary');
  }

  /** Adds a slot (used by the Lucky talent later). */
  addSlot() {
    this.slotCount += 1;
    this.slots.push(null);
  }

  /**
   * Resizes the slot array, keeping the genes already locked in.
   *
   * Growing adds empty slots at the end. Shrinking is only ever a run reset,
   * so it drops the tags beyond the new count.
   *
   * @param {number} count New slot count.
   */
  setSlotCount(count) {
    const next = Math.max(1, Math.min(5, count));
    if (next === this.slotCount) return;
    const previous = this.slots;
    this.slotCount = next;
    this.slots = new Array(next).fill(null);
    for (let i = 0; i < Math.min(next, previous.length); i++) this.slots[i] = previous[i];
  }

  /**
   * Base drop chance by elapsed run time: generous early, tighter later.
   *
   * @param {number} runTime Seconds since the run started.
   * @returns {number}
   */
  dropChance(runTime) {
    if (runTime < 60) return 0.35;
    if (runTime < 180) return 0.35 - ((runTime - 60) / 120) * 0.15;
    return 0.15;
  }

  /**
   * Rolls a quality tier for a drop.
   *
   * @param {boolean} isElite Whether the killed insect was an elite.
   * @param {boolean} [isBoss] Whether it was a boss.
   * @returns {'common'|'rare'|'legendary'}
   */
  rollTier(isElite = false, isBoss = false) {
    const r = Math.random();
    if (isBoss) return r < 0.1 ? 'common' : r < 0.6 ? 'rare' : 'legendary';
    if (isElite) return r < 0.4 ? 'common' : r < 0.85 ? 'rare' : 'legendary';
    return r < 0.7 ? 'common' : r < 0.95 ? 'rare' : 'legendary';
  }

  /**
   * Rolls a drop for a killed insect and spawns an orb when it succeeds.
   *
   * @param {{type: {key: string}, position: {x: number, y: number}, elite?: boolean}} enemy
   * @param {number} runTime Seconds since the run started.
   * @param {boolean} [isBoss]
   * @returns {object|null} The spawned orb, or null.
   */
  maybeDrop(enemy, runTime, isBoss = false) {
    const key = enemy.type.key;
    const isLocked = this.slots.some((g) => g && g.key === key);
    const hasFreeSlot = this.slots.some((g) => g === null);
    // A species that is neither locked nor able to take a free slot is useless.
    if (!isLocked && !hasFreeSlot) return null;

    const allLegendary = this.allLegendary;
    this.killsSinceDrop += 1;

    // After everything is legendary the orbs still come, but only as stack
    // fuel, and at a much lower rate.
    let chance = allLegendary ? LEGENDARY_DROP_CHANCE : this.dropChance(runTime);
    if (enemy.elite) chance = 1;
    if (isBoss) chance = 1;
    if (!allLegendary && this.killsSinceDrop >= GENE_PITY) chance = 1;

    if (Math.random() >= chance) return null;

    this.killsSinceDrop = 0;
    const tier = allLegendary ? 'legendary' : this.rollTier(enemy.elite, isBoss);
    return this.spawnOrb(key, tier, enemy.position.x, enemy.position.y);
  }

  /**
   * Creates a floating gene orb.
   *
   * @param {string} key Species key.
   * @param {'common'|'rare'|'legendary'} tier Quality tier.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @returns {object} The orb record.
   */
  spawnOrb(key, tier, x, y) {
    const color = TIER_COLORS[tier];
    const mesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(13, 1),
      new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.75,
        roughness: 0.3,
        metalness: 0.2,
      })
    );
    mesh.position.set(x, y, 26);
    this.scene.add(mesh);

    const orb = { key, tier, mesh, x, y, phase: Math.random() * Math.PI * 2 };
    this.orbs.push(orb);
    return orb;
  }

  /**
   * Animates the orbs and reports the first one the hero has touched.
   *
   * @param {number} delta Seconds since the previous frame.
   * @param {THREE.Vector3} playerPosition The hero's position.
   * @returns {object|null} An orb awaiting a choice, or null.
   */
  updateOrbs(delta, playerPosition) {
    for (const orb of this.orbs) {
      orb.phase += delta * 2.5;
      orb.mesh.position.z = 26 + Math.sin(orb.phase) * 5;
      orb.mesh.rotation.y += delta * 2;
      orb.mesh.rotation.x += delta * 1.3;

      // Pull the orb toward the hero, easing to zero at the outer edge. The
      // mesh position is updated here too: the orb record keeps x/y as the
      // source of truth for collection, while the mesh is what the player sees.
      const dx = orb.x - playerPosition.x;
      const dy = orb.y - playerPosition.y;
      const distance = Math.hypot(dx, dy);
      if (distance > GENE_PICKUP_RADIUS && distance < GENE_MAGNET_RADIUS) {
        const strength = 1 - distance / GENE_MAGNET_RADIUS;
        const pull = strength * GENE_MAGNET_SPEED * delta;
        orb.x -= (dx / distance) * pull;
        orb.y -= (dy / distance) * pull;
        orb.mesh.position.x = orb.x;
        orb.mesh.position.y = orb.y;
        orb.mesh.scale.setScalar(1 + strength * 0.25);
      } else {
        orb.mesh.scale.setScalar(1);
      }
    }

    if (this.pending) return this.pending;

    const touched = this.orbs.find(
      (orb) =>
        Math.hypot(orb.x - playerPosition.x, orb.y - playerPosition.y) < GENE_PICKUP_RADIUS
    );
    if (touched) this.pending = touched;
    return this.pending;
  }

  /**
   * Removes an orb from the scene and the list.
   *
   * @param {object} orb
   */
  removeOrb(orb) {
    this.scene.remove(orb.mesh);
    orb.mesh.geometry.dispose();
    orb.mesh.material.dispose();
    this.orbs = this.orbs.filter((o) => o !== orb);
  }

  /**
   * Once every slot is legendary, orbs stop dropping. Kills still feed the
   * build: every 30 kills (or any elite kill) adds one stack to the locked
   * gene with the fewest stacks, so the build keeps growing without popups.
   *
   * @param {boolean} [isElite]
   * @returns {{key: string, stacks: number}|null} The gene that grew, or null.
   */
  grantStackOnKill(isElite = false) {
    if (!this.allLegendary) return null;

    const filled = this.slots.filter(Boolean);
    if (filled.length === 0) return null;

    this.stackKills += 1;
    const threshold = isElite ? 1 : LEGENDARY_STACK_KILLS;
    if (this.stackKills < threshold) return null;
    this.stackKills = 0;

    // Grow the least-developed gene so no single stat runs away.
    let target = filled[0];
    for (const slot of filled) {
      if (slot.stacks < target.stacks) target = slot;
    }
    target.stacks += 1;
    return { key: target.key, stacks: target.stacks };
  }

  /**
   * Resolves the pending orb.
   *
   * @param {boolean} take True to take it, false to skip.
   * @returns {boolean} True if a gene was applied.
   */
  resolve(take) {
    const orb = this.pending;
    if (!orb) return false;
    this.pending = null;
    this.removeOrb(orb);
    if (!take) return false;
    this.apply(orb.key, orb.tier);
    return true;
  }

  /**
   * Applies one pickup to a species: locks a free slot, or stacks an existing
   * gene and advances its merge / tier.
   *
   * @param {string} key Species key.
   * @param {'common'|'rare'|'legendary'} tier Quality of the drop.
   * @returns {boolean} True if it was applied.
   */
  apply(key, tier) {
    const cfg = GENE_TYPES[key];
    const slot = this.slots.find((g) => g && g.key === key);

    if (!slot) {
      const free = this.slots.indexOf(null);
      if (free < 0) return false;
      // The first pickup already counts towards the three-gene merge.
      this.slots[free] = { key, tier, stacks: 1, merge: 1 };
      return true;
    }

    const dropIndex = GENE_TIERS.indexOf(tier);
    const currentIndex = GENE_TIERS.indexOf(slot.tier);

    if (dropIndex > currentIndex) {
      // Upgrade first (converting the old stacks), then add the new stack at
      // the better tier's value.
      this.upgradeSlot(slot, tier);
      slot.stacks += 1;
      return true;
    }

    if (dropIndex < currentIndex) {
      // A weaker drop still contributes its own value, expressed in
      // current-tier stacks, but does not advance the merge counter.
      slot.stacks += cfg.perLayer[tier] / cfg.perLayer[slot.tier];
      return true;
    }

    // Same tier: one full stack. Merge progress only matters below legendary.
    slot.stacks += 1;
    if (currentIndex < GENE_TIERS.length - 1) {
      slot.merge += 1;
      if (slot.merge >= 3) {
        this.upgradeSlot(slot, GENE_TIERS[currentIndex + 1]);
      }
    }
    return true;
  }

  /**
   * Raises a slot's quality and converts its stacks proportionally, so the
   * total stat value is preserved: ten common stacks become fewer rare stacks
   * worth exactly the same amount. Low-quality stacks never carry over 1:1.
   *
   * @param {{key: string, tier: string, stacks: number, merge: number}} slot
   * @param {'common'|'rare'|'legendary'} newTier
   */
  upgradeSlot(slot, newTier) {
    const cfg = GENE_TYPES[slot.key];
    const oldPer = cfg.perLayer[slot.tier];
    const newPer = cfg.perLayer[newTier];
    slot.stacks = slot.stacks * (oldPer / newPer);
    slot.tier = newTier;
    slot.merge = 0;
  }

  /**
   * Describes what taking the pending orb would do, for the choice card.
   *
   * @returns {object|null}
   */
  preview() {
    const orb = this.pending;
    if (!orb) return null;

    const cfg = GENE_TYPES[orb.key];
    const slot = this.slots.find((g) => g && g.key === orb.key);
    const free = this.slots.indexOf(null);

    const base = {
      key: orb.key,
      label: cfg.label,
      tier: orb.tier,
      stat: cfg.stat,
      description: cfg.description,
      perLayerText: formatPerLayer(cfg, orb.tier),
      capText: formatCap(cfg, orb.tier),
      stackRule: STACK_RULE,
    };

    if (!slot) {
      return {
        ...base,
        kind: free >= 0 ? 'new' : 'full',
        slotIndex: free,
        currentStacks: 0,
        stacks: 1,
        merge: 1,
      };
    }

    const dropIndex = GENE_TIERS.indexOf(orb.tier);
    const currentIndex = GENE_TIERS.indexOf(slot.tier);

    let kind = 'stack';
    let nextTier = slot.tier;
    let stacks = slot.stacks;
    let merge = slot.merge;

    if (dropIndex > currentIndex) {
      kind = 'upgrade';
      nextTier = orb.tier;
      stacks = slot.stacks * (cfg.perLayer[slot.tier] / cfg.perLayer[orb.tier]) + 1;
      merge = 0;
    } else if (dropIndex < currentIndex) {
      stacks = slot.stacks + cfg.perLayer[orb.tier] / cfg.perLayer[slot.tier];
    } else {
      stacks = slot.stacks + 1;
      if (currentIndex < GENE_TIERS.length - 1) {
        merge = slot.merge + 1;
        if (merge >= 3) {
          kind = 'upgrade';
          nextTier = GENE_TIERS[currentIndex + 1];
          stacks = stacks * (cfg.perLayer[slot.tier] / cfg.perLayer[nextTier]);
          merge = 0;
        }
      } else {
        merge = 0;
      }
    }

    return {
      ...base,
      kind,
      currentStacks: slot.stacks,
      stacks,
      currentTier: slot.tier,
      nextTier,
      merge,
      maxed: currentIndex === GENE_TIERS.length - 1,
    };
  }

  /**
   * Sums every locked gene's contribution.
   *
   * @returns {{
   *   attackPower: number,
   *   damageReduction: number,
   *   lifesteal: number,
   *   attackRange: number,
   *   cooldownMult: number,
   *   cooldownFloor: number,
   *   maxHp: number,
   * }}
   */
  stats() {
    const out = {
      attackPower: 0,
      damageReduction: 0,
      lifesteal: 0,
      attackRange: 0,
      cooldownMult: 1,
      cooldownFloor: 0,
      maxHp: 0,
    };

    for (const slot of this.slots) {
      if (!slot) continue;
      const cfg = GENE_TYPES[slot.key];
      const per = cfg.perLayer[slot.tier];

      if (cfg.stat === 'attackPower') {
        out.attackPower += slot.stacks * per;
      } else if (cfg.stat === 'damageReduction') {
        out.damageReduction += Math.min(cfg.cap[slot.tier], slot.stacks * per);
      } else if (cfg.stat === 'lifesteal') {
        out.lifesteal += Math.min(cfg.cap[slot.tier], slot.stacks * per);
      } else if (cfg.stat === 'attackRange') {
        out.attackRange += Math.min(cfg.cap[slot.tier], slot.stacks * per);
      } else if (cfg.stat === 'maxHp') {
        out.maxHp += slot.stacks * per;
      } else if (cfg.stat === 'attackCooldown') {
        out.cooldownMult *= Math.max(0.05, 1 - slot.stacks * per);
        out.cooldownFloor = Math.max(out.cooldownFloor, cfg.floor[slot.tier]);
      }
    }

    return out;
  }

  /**
   * Clears everything for a fresh run.
   *
   * @param {number} [baseSlotCount] Restores the slot count after a Lucky
   *   talent granted an extra one.
   */
  reset(baseSlotCount) {
    for (const orb of this.orbs) this.removeOrb(orb);
    this.orbs = [];
    this.pending = null;
    if (typeof baseSlotCount === 'number') this.slotCount = baseSlotCount;
    this.slots = new Array(this.slotCount).fill(null);
    this.killsSinceDrop = 0;
    this.stackKills = 0;
    this.finished = false;
  }
}

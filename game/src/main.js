import * as THREE from 'three';
import { createCamera } from './components/Camera.js';
import { createRenderer } from './components/Renderer.js';
import { Player } from './components/Player.js';
import { Enemy, pickEnemyType, bossProfile, bossAbilityCooldown, BOSS_SPECIES, BOSS_SUMMON_COUNT, BOSS_ABILITIES } from './components/Enemy.js';
import { Map, BOARD_HALF, TILE_SIZE } from './components/Map.js';
import {
  addHouses,
  collidesWithObstacle,
  HOUSE_ATTACK_RANGE,
  HOUSE_DURABILITY,
  HOUSE_HIT_DAMAGE,
  HOUSE_HIT_INTERVAL,
} from './components/House.js';
import { Scenery, BUSH_COOLDOWN } from './components/Scenery.js';
import { Attack } from './components/Attack.js';
import { Score } from './components/Score.js';
import { HighScores } from './components/HighScores.js';
import { Health, HIT_DAMAGE, HEART_PICKUP, HIT_INVULNERABILITY } from './components/Health.js';
import { sound } from './components/Sound.js';
import { PowerUpManager } from './components/PowerUp.js';
import { GeneSystem, GENE_TYPES, GENE_TIERS, TIER_LABELS, TIER_COLORS, formatPerLayer, formatCap, LEGENDARY_ORB_SCORE } from './components/Genes.js';
import {
  TalentSystem,
  TALENT_INTERVAL,
  TALENT_SLOTS,
  TALENT_RANK_LEVELS,
  TALENTS,
  talentEffectAt,
  talentMaxLevel,
  talentLevelFor,
  nextTalentRankLevel,
  formatTalentEffect,
} from './components/Talents.js';
import {
  Awakening,
  AWAKEN_SCORE_PER_CHARGE,
  AWAKEN_MAX_CHARGES,
  AWAKEN_DURATION,
  AWAKEN_ATTACK_MULT,
  AWAKEN_DAMAGE_TAKEN_MULT,
  AWAKEN_RANGE_MULT,
  AWAKEN_SPEED_BONUS,
} from './components/Awakening.js';
import { scaledParameters } from './components/Difficulty.js';
import { hud } from './components/Interactables.js';
import { Juice } from './components/Juice.js';
import './style.css';

// ---------------------------------------------------------------------------
// Tunables for the gameplay loop
// ---------------------------------------------------------------------------
/** Enemy vs. player: how close counts as a fatal touch. */
const PLAYER_HIT_DISTANCE = 45;
/** Enemy vs. enemy: how close two insects may get. */
const ENEMY_HIT_DISTANCE = 45;
/**
 * Hard ceiling on live insects. The spawner stops when the board is full, so
 * a player who kites instead of killing cannot melt the frame budget.
 */
const MAX_ENEMIES = 48;

/**
 * Basic tongue damage split.
 *
 * The tongue still hits all around (the croak wave is the in-world reason),
 * but the front 120-degree wedge is a direct hit and the rest is splash.
 * This gives facing a purpose without turning the attack into a narrow cone.
 */
const ATTACK_DIRECT_ARC = (Math.PI * 2) / 3;
const ATTACK_SPLASH_MULT = 0.7;

/** Croak active skill: cooldown, unlock level and shove/stun tuning. */
const CROAK_COOLDOWN = 7;
const CROAK_UNLOCK_LEVEL = 4;
const CROAK_STUN_DURATION = 0.6;
const CROAK_PUSH_DISTANCE = 90;
const CROAK_PUSH_STEPS = 5;
const CROAK_DAMAGE_MULT = 0.5;
const CROAK_BOSS_DAMAGE_MULT = 0.3;

/** Death-burst colours, keyed by species, so the kill matches the body. */
const KILL_COLORS = {
  fly: 0xffe066,
  mosquito: 0xff9f80,
  bee: 0xffc93c,
  beetle: 0x8fd694,
  centipede: 0xff8a65,
  mole: 0xd7bde2,
};

/** @param {import('./components/Enemy.js').Enemy} enemy */
function killColor(enemy) {
  return enemy.boss ? 0xffb347 : (KILL_COLORS[enemy.typeKey] || 0xfff0a8);
}

/**
 * True when an enemy stands in the front wedge of the tongue snap.
 *
 * The check is on the enemy's centre, but the caller only uses it for the
 * direct/splash multiplier; a target at the exact centre counts as direct so
 * a point-blank hit never feels accidentally weak.
 *
 * @param {import('./components/Enemy.js').Enemy} enemy
 * @param {number} facing Facing angle in radians around Z.
 * @returns {boolean}
 */
function isDirectTongueHit(enemy, facing) {
  if (enemy.boss) return true;
  const dx = enemy.position.x - player.position.x;
  const dy = enemy.position.y - player.position.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 1e-3) return true;
  const dot = (dx * Math.cos(facing) + dy * Math.sin(facing)) / distance;
  return dot >= Math.cos(ATTACK_DIRECT_ARC / 2);
}



/** Maximum HP gained per kill — this is what drives the level curve.
 *
 * Levels now gate talent ranks too, so this number does double duty. At 2.5
 * HP a level costs 40 kills: roughly a minute in the opening stretch, and
 * slower as the board fills up. The old 3.0 made that 33 kills, which pushed
 * the hero up the curve faster than the fights around him got harder.
 */
const KILL_MAX_HP_GAIN = 2.5;

/**
 * Shield regeneration, expressed against the shield's own ceiling.
 *
 * Deliberately "out of combat" rather than on a timer: a shield that refills
 * while the player is still being chewed on is just more HP, and one that
 * never refills reads as a bug. Eight seconds of quiet buys a full bar.
 */
const SHIELD_REGEN_DELAY = 4;
const SHIELD_REGEN_PER_SECOND = 0.12;

/**
 * Level-based damage reduction is capped at 15%. Level alone must never make
 * the hero tanky enough that stacking genes/talents could approach immunity.
 */
const LEVEL_DAMAGE_REDUCTION_MAX = 0.15;
/**
 * Hard ceiling on combined damage reduction from EVERY source (level, mole
 * gene, Iron Wall talent, awakening…). Without this, additive stacking could
 * reach 100% and the frog would be invincible.
 */
const MAX_TOTAL_DAMAGE_REDUCTION = 0.8;

// --- Bosses ---------------------------------------------------------------
/** Score at which the first boss appears. */
const FIRST_BOSS_SCORE = 2000;
/** Score gap between later bosses. */
const BOSS_SCORE_STEP = 3000;
/**
 * Extra quiet seconds after a boss dies. The score gate below is the real
 * spacing rule; this timer is a short breather so the next giant never walks
 * in on the corpse even when the player is already deep into the next band.
 */
const BOSS_RESPAWN_DELAY = 8;
/** Run-long stat bonus ranges for downing a boss. */
const BOSS_BONUS_HP_MIN = 10;
const BOSS_BONUS_HP_MAX = 40;
const BOSS_BONUS_ATK_MIN = 0.1;
const BOSS_BONUS_ATK_MAX = 0.4;
const BOSS_BONUS_DEF_MIN = 0.01;
const BOSS_BONUS_DEF_MAX = 0.04;
/** How much the bonus range scales up per boss already killed. */
const BOSS_BONUS_GROWTH = 0.25;
/**
 * An active awakening is much less effective against a boss.
 *
 * The awakening is a panic button, not a boss-skip button: triple damage on
 * a boss would delete a 50-hit encounter in a handful of blasts and the
 * summon/enrage phases would never happen. At 0.6x the boost is still
 * clearly worth spending — it shaves real time off the fight and the extra
 * range keeps the hero safe — but the boss survives long enough to be a boss.
 */
const BOSS_AWAKEN_DAMAGE_MULT = 0.6;
/**
 * Share of a boss's max HP removed by the Bomb pickup.
 *
 * The bomb clears the swarm but must not delete a boss encounter outright;
 * 20% is a real tempo swing without skipping the fight.
 */
const BOMB_BOSS_DAMAGE = 0.2;
/** The full Awakening package, reused by the toast and the pause notes. */
const AWAKEN_SUMMARY =
  `x${AWAKEN_ATTACK_MULT} damage · ` +
  `${Math.round((1 - AWAKEN_DAMAGE_TAKEN_MULT) * 100)}% less damage taken · ` +
  `+${Math.round((AWAKEN_RANGE_MULT - 1) * 100)}% range · ` +
  `+${Math.round(AWAKEN_SPEED_BONUS * 100)}% speed`;

// --- Boss signature abilities ---------------------------------------------
/** Poison applied by a centipede pool: ticks and their cadence live here. */
const VENOM_STACK_LIMIT = 3;
/** How far ahead of the boss a stag beetle's charge telegraphs, in units. */
const CHARGE_REACH = 520;

/**
 * The hero's derived combat stats.
 *
 * Phase 1 wires the damage pipeline (attack power, damage reduction, shield).
 * Later phases feed level, genes, talents and awakening into these numbers.
 */
const playerStats = {
  /** Damage per tongue blast, in "hit units". */
  attackPower: 1,
  /** Fraction of incoming contact damage ignored (0–1). */
  damageReduction: 0,
  /** Shield points, absorbed before HP. */
  shield: 0,
  /** Shield ceiling, set by talents/gear. */
  shieldMax: 0,
  /**
   * Seconds since the shield last took (or dealt with) a hit. Drives the
   * out-of-combat regeneration; see the shield block in `animate`.
   */
  shieldIdle: 0,
  /** Fraction of damage dealt returned as HP (0–1). */
  lifesteal: 0,
  /** Current tongue-blast reach, for the character panel. */
  attackRange: 0,
  /** Current tongue-blast cooldown, for the character panel. */
  attackCooldown: 1,
  /** Move-speed multiplier from level, for the character panel. */
  moveSpeedMult: 1,
};

/**
 * Breathing room between a body and a wall. Kept small so the hero stops
 * flush against a tree; the old value of 6 left a visible gap that made
 * movement feel stuck.
 */
const WALL_CLEARANCE = 3;
const POWERUP_WALL_CLEARANCE = 26;

// --- House ----------------------------------------------------------------
/** Fraction of the footprint radius that counts as "inside". */
const HOUSE_INTERIOR_RADIUS_RATIO = 0.9;
/** How translucent the house goes while the hero is inside it. */
const HOUSE_INTERIOR_OPACITY = 0.3;

// --- Bush -----------------------------------------------------------------
/** How long the hide lasts before the hero is spotted. */
const BUSH_HIDE_DURATION = 4;
/** How close the hero must be to count as "in" a bush. */
const BUSH_INTERIOR_DISTANCE = 70;
/** How close an insect must be to whack a bush apart. */
const BUSH_ATTACK_RANGE = 90;

// --- Flower ---------------------------------------------------------------
/** How long the player has to stand next to a flower to harvest it. */
const FLOWER_HARVEST_TIME = 2.0;
/** Distance at which a flower notices the hero. */
const FLOWER_TRIGGER_DISTANCE = 48;
/** How long before a harvested flower grows back. */
const FLOWER_REGROW = 15;

// --- Pond -----------------------------------------------------------------
/** How close to the pond centre counts as "in the water". */
const POND_INNER_RADIUS_RATIO = 0.72;
/** How close to the pond edge still shows the pond hint. */
const POND_NEAR_RADIUS_RATIO = 1.18;
/** How long the hero must wade in before the bonus fires. */
const POND_BONUS_WADE_TIME = 0.5;
/** Cooldown before the same pond pays out again. */
const POND_COOLDOWN = 25;
/** Fraction of max HP restored per second while in the water. */
const POND_HEAL_PERCENT = 0.03;
/** Cap on a single soak, as a fraction of max HP. */
const POND_HEAL_CAP_PERCENT = 0.2;
/** Fraction of incoming damage soaked while in the water. */
const POND_DAMAGE_SOAK = 0.2;
/**
 * How long a single soak lasts, in seconds. At 3%/s this is enough to reach
 * the 20% cap; the hard limit also ends the soak when the hero is already at
 * full HP, so the bonus cannot re-fire every frame.
 */
const POND_SOAK_DURATION = 7;

// --- Fruit trees ----------------------------------------------------------
/** How close a fruit tree must be for the tongue blast to knock a fruit off. */
const TREE_STRIKE_RANGE = 100;
/** How close the hero must be for the fruit-tree hint to show. */
const TREE_PROXIMITY_DISTANCE = 110;
/** HP per second granted by eating a fruit. */
const FRUIT_REGEN_RATE = 5;
/** Seconds the fruit's regeneration lasts. */
const FRUIT_REGEN_DURATION = 6;

/**
 * Clamps a ground position to the board.
 *
 * @param {THREE.Vector3} position Position to clamp, modified in place.
 * @param {number} [radius] Radius of the body being clamped.
 */
function clampToBoard(position, radius = 0) {
  const limit = Math.max(0, BOARD_HALF - radius);
  position.x = THREE.MathUtils.clamp(position.x, -limit, limit);
  position.y = THREE.MathUtils.clamp(position.y, -limit, limit);
}

// ---------------------------------------------------------------------------
// Core three.js setup
// ---------------------------------------------------------------------------
const renderer = createRenderer();
const scene = new THREE.Scene();

scene.add(new THREE.AmbientLight(0xffffff, 1.5));

const directionalLight = new THREE.DirectionalLight(0xffffff, 1.5);
directionalLight.position.set(-100, -100, 200);
scene.add(directionalLight);

// ---------------------------------------------------------------------------
// Game world
// ---------------------------------------------------------------------------
const map = new Map(scene);

/** Houses, once loaded. Each has hp, position, radius, alive. */
let houses = [];
let currentHouse = null;
/** Scenery (trees, bushes, flowers, ponds), once loaded. */
let scenery = null;

/**
 * What blocks the *hero*: trees only.
 *
 * Houses and bushes have to be walkable. Their effects trigger by standing
 * inside them, and while they were in the collision list the hero could never
 * get closer than `radius + clearance` — always further out than the
 * "inside" test asked for, so those mechanics could never fire in real play.
 */
let obstacles = [];

/**
 * What blocks the *insects*: trees plus houses. Insects still cannot walk
 * into a house, which is exactly what makes it a shelter.
 */
let enemyObstacles = [];

addHouses(map.housesGroup).then((placed) => {
  houses = placed;
  scenery = new Scenery(scene, placed);
  obstacles = [...scenery.obstacles];
  enemyObstacles = [...scenery.obstacles, ...placed];
});

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------
const player = new Player(scene);
const camera = createCamera(player.group);
/** Hit-stop, shake, particles, floating score and the combo counter. */
const juice = new Juice(scene, camera);

const score = new Score();
const health = new Health();
health.avatarEl.addEventListener('click', () => openCharPanel());

// Shelter durability readout shown while the hero is inside a house.
const shelterReadout = document.createElement('div');
shelterReadout.className = 'shelter-readout';
document.body.appendChild(shelterReadout);
const highScores = new HighScores();
const attack = new Attack(scene, player);
const powerUps = new PowerUpManager(scene);

// ---------------------------------------------------------------------------
// Genes
// ---------------------------------------------------------------------------
const genes = new GeneSystem(scene, 3);
const talents = new TalentSystem(TALENT_SLOTS);
const awakening = new Awakening();

/** Run-long stats earned from bosses this run. */
const bossBonus = { maxHp: 0, attack: 0, defense: 0 };
/** Frozen while a gene card or the pause menu is open. */
let paused = false;
/** Seconds since the run started, used for the drop-rate curve. */
let runTime = 0;
/** Beetle genes raise max HP; track the last applied bonus to grant only the delta. */
let lastGeneMaxHp = 0;
/** Same delta rule for the talent max-HP bonus. */
let lastTalentMaxHp = 0;
/** Last shield ceiling granted by talents, so refills happen only on gain. */
let lastTalentShieldMax = 0;

// ---------------------------------------------------------------------------
// Gene HUD (locked genes) and the pickup card
// ---------------------------------------------------------------------------
const geneBar = document.createElement('div');
geneBar.className = 'gene-bar';
document.body.appendChild(geneBar);

/** One-decimal stack display, so converted (fractional) stacks stay readable. */
function formatStacks(value) {
  return String(Math.round(value * 10) / 10);
}

/** Rewrites the three (or more) locked-gene pips. */
function renderGeneBar() {
  const cells = [];
  for (let i = 0; i < genes.slotCount; i++) {
    const slot = genes.slots[i];
    if (!slot) {
      cells.push(
        '<div class="gene-slot empty">' +
          '<span class="gene-dot"></span>' +
          '<span class="gene-name">Empty</span>' +
        '</div>'
      );
      continue;
    }
    const cfg = GENE_TYPES[slot.key];
    const color = `#${TIER_COLORS[slot.tier].toString(16).padStart(6, '0')}`;
    cells.push(
      `<div class="gene-slot" data-tier="${slot.tier}">` +
        `<span class="gene-dot" style="background:${color}"></span>` +
        `<span class="gene-name">${cfg.label}</span>` +
        `<span class="gene-stacks">x${formatStacks(slot.stacks)}</span>` +
      '</div>'
    );
  }
  geneBar.innerHTML = cells.join('');
}
renderGeneBar();

const geneCard = document.createElement('div');
geneCard.className = 'gene-card';
geneCard.setAttribute('role', 'dialog');
geneCard.setAttribute('aria-modal', 'true');
geneCard.setAttribute('aria-label', 'Gene splice');
geneCard.style.display = 'none';
document.body.appendChild(geneCard);

/**
 * Icon and accent colour for each gene stat. Inline SVG keeps the card free of
 * external art and icon fonts.
 */
const GENE_STAT_STYLES = {
  attackCooldown: {
    color: '#6fc3ff',
    icon:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/></svg>',
  },
  lifesteal: {
    color: '#ff6b9d',
    icon:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 3s6 6.2 6 10a6 6 0 0 1-12 0c0-3.8 6-10 6-10Z"/></svg>',
  },
  attackRange: {
    color: '#ffd166',
    icon:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.5"/><path d="M12 4v2M12 18v2M4 12h2M18 12h2"/></svg>',
  },
  maxHp: {
    color: '#63d6a0',
    icon:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 20s-7-4.4-7-9a4 4 0 0 1 7-2 4 4 0 0 1 7 2c0 4.6-7 9-7 9Z"/></svg>',
  },
  attackPower: {
    color: '#ff8a66',
    icon:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M13 2 4.5 13.5H11l-1 8.5L19.5 10H13V2Z"/></svg>',
  },
  damageReduction: {
    color: '#b79bff',
    icon:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 3 5 6v5.4c0 4.6 2.9 8 7 9.6 4.1-1.6 7-5 7-9.6V6l-7-3Z"/>' +
      '<path d="m9 12 2 2 4-4"/></svg>',
  },
};

/**
 * @param {string} stat Gene stat key.
 * @returns {{color: string, icon: string}}
 */
function geneStatStyle(stat) {
  return GENE_STAT_STYLES[stat] || GENE_STAT_STYLES.attackPower;
}

// ---------------------------------------------------------------------------
// Talent HUD
// ---------------------------------------------------------------------------
const talentBar = document.createElement('div');
talentBar.className = 'talent-bar';
document.body.appendChild(talentBar);

/** Rewrites the talent pips and the countdown to the next offer. */
function renderTalentPips() {
  const pips = [];
  for (let i = 0; i < talents.slotCount; i++) {
    const talent = talents.owned[i];
    if (!talent) {
      pips.push('<span class="talent-pip empty" title="Empty talent slot"></span>');
    } else {
      // The pip tooltip carries the live value, so hovering shows what the
      // talent is worth *now* rather than what it was worth at level 1.
      const rank = talents.levelOf(talent);
      const live = formatTalentEffect(talentEffectAt(talent, rank));
      pips.push(
        `<span class="talent-pip filled" title="${talent.name} — Rank ${rank}: ${live}">${
          talent.name
            .split(' ')
            .map((word) => word[0])
            .join('')
        }<i class="talent-pip-level">${rank}</i></span>`
      );
    }
  }
  const left = Math.max(0, TALENT_INTERVAL - talents.timer);
  const hint = talents.full
    ? 'All talent slots are full'
    : `Next talent in ${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`;
  talentBar.innerHTML =
    `<span class="talent-bar-label">Talents</span>${pips.join('')}` +
    `<span class="talent-bar-hint">${hint}</span>`;
}
renderTalentPips();

// ---------------------------------------------------------------------------
// Awakening bar
// ---------------------------------------------------------------------------
const awakenBar = document.createElement('div');
awakenBar.className = 'awaken-bar';
document.body.appendChild(awakenBar);

// ---------------------------------------------------------------------------
// Boss health bar
// ---------------------------------------------------------------------------
const bossBar = document.createElement('div');
bossBar.className = 'boss-bar';
bossBar.style.display = 'none';
document.body.appendChild(bossBar);

/** Rewrites the awakening meter: charge state, progress and timer. */
function renderAwakenBar() {
  const pct = Math.round(awakening.progress * 100);
  const charges = Array.from({ length: AWAKEN_MAX_CHARGES }, (_, i) =>
    `<span class="awaken-charge${i < awakening.charges ? ' full' : ''}"></span>`
  ).join('');

  let label;
  if (awakening.active) {
    label = `Awakened · ${awakening.remaining.toFixed(1)}s left`;
  } else if (awakening.ready) {
    label = 'Ready · press E';
  } else {
    const need = Math.max(0, AWAKEN_SCORE_PER_CHARGE - awakening.scoreProgress);
    label = `${Math.round(need)} pts to charge`;
  }

  awakenBar.dataset.state = awakening.active ? 'active' : awakening.ready ? 'ready' : 'charging';
  awakenBar.innerHTML =
    '<div class="awaken-head">' +
    '<span class="awaken-label">Awakening</span>' +
    `<span class="awaken-charges">${charges}</span>` +
    `<span class="awaken-text">${label}</span>` +
    '</div>' +
    `<div class="awaken-track"><span style="width:${pct}%"></span></div>`;
}
renderAwakenBar();

// ---------------------------------------------------------------------------
// Croak (active skill)
// ---------------------------------------------------------------------------
/**
 * A small always-visible skill bar. Locked until hero level 4 so the opening
 * minute is still about the basic tongue, then it becomes a real answer to
 * being surrounded rather than another passive stat.
 */
const croakBar = document.createElement('div');
croakBar.className = 'croak-bar';
croakBar.setAttribute('aria-label', 'Croak skill');
croakBar.innerHTML = [
  '<span class="croak-key"><b>Q</b></span>',
  '<span class="croak-copy">',
  '  <span class="croak-name">Croak</span>',
  '  <span class="croak-state">Locked · level 4</span>',
  '</span>',
].join('');
document.body.appendChild(croakBar);

let croakCooldown = 0;
let croakUnlocked = false;

/** Repaints the skill bar. Cheap enough to call on cooldown changes. */
function renderCroakBar() {
  if (!croakBar) return;
  const stateEl = croakBar.querySelector('.croak-state');
  const keyEl = croakBar.querySelector('.croak-key');

  if (!croakUnlocked) {
    croakBar.dataset.state = 'locked';
    stateEl.textContent = `Locked · level ${CROAK_UNLOCK_LEVEL}`;
    keyEl.style.setProperty('--croak-progress', '0%');
    return;
  }
  if (croakCooldown <= 0) {
    croakBar.dataset.state = 'ready';
    stateEl.textContent = 'Ready · shove the swarm';
    keyEl.style.setProperty('--croak-progress', '0%');
    return;
  }

  const progress = 1 - croakCooldown / CROAK_COOLDOWN;
  croakBar.dataset.state = 'cooldown';
  stateEl.textContent = `Cooling down · ${croakCooldown.toFixed(1)}s`;
  keyEl.style.setProperty('--croak-progress', `${Math.round(progress * 100)}%`);
}

/** Unlocks the skill once, with a clear in-game announcement. */
function updateCroakUnlock() {
  const shouldUnlock = health.level >= CROAK_UNLOCK_LEVEL;
  if (shouldUnlock === croakUnlocked) return;
  croakUnlocked = shouldUnlock;
  renderCroakBar();
  if (croakUnlocked) {
    hud.showAction(
      'Croak unlocked — press Q to shove and stun the swarm',
      'croak',
      '#8ef7b0',
      2600
    );
    sound.croakUnlock();
  }
}

/** Radius of the active Croak, independent of the late-game tongue reach. */
function croakRadius() {
  return Math.min(640, Math.max(280, attack.radius * 1.1));
}

/**
 * Fires Croak: a 360-degree shove with a short stun. Ordinary insects that
 * survive are pushed out and stopped for a beat; bosses take a small share of
 * damage and are never shoved, so the skill cannot kite a giant for free.
 *
 * @returns {boolean} True if the skill fired.
 */
function triggerCroak() {
  if (gameState !== 'playing' || paused || !croakUnlocked || croakCooldown > 0) {
    return false;
  }

  const radius = croakRadius();
  croakCooldown = CROAK_COOLDOWN;
  renderCroakBar();
  attack.playCroak(radius);
  juice.onCroak(player.position);
  sound.croak();

  const origin = player.position;
  const survivors = [];
  let hitCount = 0;

  for (const enemy of enemies) {
    const dx = enemy.position.x - origin.x;
    const dy = enemy.position.y - origin.y;
    const reach = radius + (enemy.boss ? enemy.radius : 0);
    if (Math.hypot(dx, dy) > reach) {
      survivors.push(enemy);
      continue;
    }

    hitCount += 1;
    const power = enemy.boss
      ? playerStats.attackPower * CROAK_BOSS_DAMAGE_MULT
      : playerStats.attackPower * CROAK_DAMAGE_MULT;
    const killed = enemy.takeHit(power);
    if (killed) {
      awardKill(enemy);
      continue;
    }

    juice.onCroakHit(enemy.position, enemy.boss);
    if (!enemy.boss) {
      enemy.stun(CROAK_STUN_DURATION);
      // Shove in small collision-checked steps rather than teleporting, so a
      // croak cannot push an insect through a tree or a house wall.
      const length = Math.hypot(dx, dy);
      const nx = length > 1e-3 ? dx / length : 1;
      const ny = length > 1e-3 ? dy / length : 0;
      const stepLength = CROAK_PUSH_DISTANCE / CROAK_PUSH_STEPS;
      for (let step = 0; step < CROAK_PUSH_STEPS; step += 1) {
        const nextX = enemy.position.x + nx * stepLength;
        const nextY = enemy.position.y + ny * stepLength;
        if (!canEnemyStep(nextX, nextY, enemy)) break;
        enemy.group.position.x = nextX;
        enemy.group.position.y = nextY;
      }
      clampToBoard(enemy.position, enemy.radius * 0.5);
    }
    survivors.push(enemy);
  }

  enemies = survivors;
  renderBossBar();
  hud.showAction(
    hitCount > 0
      ? `Croak! ${hitCount} insect${hitCount === 1 ? '' : 's'} shoved back`
      : 'Croak — nothing in range',
    'croak',
    '#8ef7b0',
    1300
  );
  return true;
}

window.addEventListener('keydown', (event) => {
  if (event.code !== 'KeyQ') return;
  if (gameState !== 'playing' || paused) return;
  if (!croakUnlocked) {
    hud.showAction(`Croak unlocks at hero level ${CROAK_UNLOCK_LEVEL}`, 'croak', '#8ef7b0', 1400);
    return;
  }
  event.preventDefault();
  triggerCroak();
});

renderCroakBar();

/** Spends a charge and turns the boost on. */
function triggerAwakening() {
  if (!awakening.activate()) return;
  juice.onAwaken();
  sound.awaken();
  hud.showAction(
    `Awakening: ${AWAKEN_DURATION}s — ${AWAKEN_SUMMARY}`,
    'awaken',
    '#7c5cff',
    2600
  );
  renderAwakenBar();
}

window.addEventListener('keydown', (event) => {
  if (event.code !== 'KeyE') return;
  if (gameState !== 'playing') return;
  if (paused) return;
  if (!awakening.ready) return;
  event.preventDefault();
  triggerAwakening();
});

/** Opens the Absorb/Discard specimen for the orb the hero just touched. */
function showGeneCard() {
  const info = genes.preview();
  if (!info) return;

  paused = true;
  // Do not let a stray Space fire an attack while the world is frozen.
  attack.enabled = false;
  geneCard.style.display = 'flex';
  sound.geneOffer();

  const tierColor = `#${TIER_COLORS[info.tier].toString(16).padStart(6, '0')}`;
  const fmt = (v) => String(Math.round(v * 10) / 10);

  let actionText;
  let mergeText;
  if (info.kind === 'new') {
    actionText = `Lock into slot ${info.slotIndex + 1} · for this run`;
    mergeText = 'First stack · locks this species for the run';
  } else if (info.kind === 'full') {
    actionText = 'All gene slots are full';
    mergeText = 'Absorb is disabled · discard this orb';
  } else if (info.kind === 'upgrade') {
    actionText =
      `${TIER_LABELS[info.currentTier]} → ${TIER_LABELS[info.nextTier]} · ` +
      `stacks ${fmt(info.currentStacks)} → ${fmt(info.stacks)}`;
    mergeText = 'Quality upgraded · stacks converted to preserve the bonus';
  } else {
    actionText = `Stacks ${fmt(info.currentStacks)} → ${fmt(info.stacks)}`;
    mergeText = info.maxed
      ? 'Max quality · stacks keep growing'
      : `Merge ${info.merge}/3`;
  }

  const statStyle = geneStatStyle(info.stat);
  const nextTierIndex = GENE_TIERS.indexOf(info.tier) + 1;
  const nextTier = nextTierIndex < GENE_TIERS.length ? GENE_TIERS[nextTierIndex] : null;

  let mergeLabel;
  let mergeProgress = info.merge || 0;
  if (info.kind === 'full') {
    mergeLabel = 'All gene slots are full';
    mergeProgress = 0;
  } else if (info.kind === 'upgrade') {
    mergeLabel = 'Quality upgraded · merge reset';
    mergeProgress = 0;
  } else if (!nextTier) {
    mergeLabel = 'Max quality';
    mergeProgress = 3;
  } else {
    mergeLabel = `${info.merge}/3 to ${TIER_LABELS[nextTier]}`;
  }
  const pips = Array.from(
    { length: 3 },
    (_, index) => `<span${index < mergeProgress ? ' class="filled"' : ''}></span>`
  ).join('');

  geneCard.innerHTML = [
    '<div class="gene-card-box" tabindex="-1" ' +
      `style="--gene-tone:${statStyle.color};--tier:${tierColor}">`,
    '  <div class="gene-dish" aria-hidden="true">',
    '    <span class="gene-dish-orbit orbit-a"></span>',
    '    <span class="gene-dish-orbit orbit-b"></span>',
    `    <span class="gene-card-icon">${statStyle.icon}</span>`,
    `    <span class="gene-dish-tier">${TIER_LABELS[info.tier]}</span>`,
    '    <span class="gene-dish-caption">SPECIMEN</span>',
    '  </div>',
    '  <div class="gene-copy">',
    '    <div class="gene-card-kicker">Gene Splice</div>',
    `    <div class="gene-card-title">${info.label} <span>Gene</span></div>`,
    `    <div class="gene-card-stat">${info.description}</div>`,
    `    <div class="gene-card-gain">${info.perLayerText}</div>`,
    `    <div class="gene-card-cap">${info.capText}</div>`,
    '    <div class="gene-card-action-wrap">',
    `      <div class="gene-card-action">${actionText}</div>`,
    `      <div class="gene-card-stacks">${mergeText}</div>`,
    '    </div>',
    '    <div class="gene-card-merge">',
    `      <div class="gene-card-merge-label">${mergeLabel}</div>`,
    `      <div class="gene-card-pips" aria-hidden="true">${pips}</div>`,
    '    </div>',
    `    <div class="gene-card-rule">${info.stackRule}</div>`,
    '  </div>',
    '  <div class="gene-card-buttons">',
    `    <button class="gene-take" type="button"${info.kind === 'full' ? ' disabled' : ''}>Absorb <kbd>F</kbd></button>`,
    '    <button class="gene-skip" type="button">Discard <kbd>G</kbd></button>',
    '  </div>',
    '</div>',
  ].join('');

  geneCard.querySelector('.gene-take').onclick = () => resolveGene(true);
  geneCard.querySelector('.gene-skip').onclick = () => resolveGene(false);

  // Focus the card, not Take: a reflex Space must not consume the gene.
  const box = geneCard.querySelector('.gene-card-box');
  if (box) box.focus();
}

/**
 * Closes the card and either applies or discards the gene.
 *
 * @param {boolean} take
 */
function resolveGene(take) {
  const stacksBefore = genes.slots.reduce((sum, slot) => sum + (slot ? slot.stacks : 0), 0);
  genes.resolve(take);
  if (take) {
    const stacksAfter = genes.slots.reduce((sum, slot) => sum + (slot ? slot.stacks : 0), 0);
    // Late game the orbs only carry stacks. Pay a little score for them so the
    // awakening bar keeps charging at the same beat it did all run.
    if (genes.allLegendary && stacksAfter > stacksBefore) {
      score.addKillPoints(LEGENDARY_ORB_SCORE);
      if (awakening.addScore(LEGENDARY_ORB_SCORE)) {
        hud.showAction('Awakening charged — press E', 'awaken', '#7c5cff', 1600);
      }
    }
  }
  geneCard.style.display = 'none';
  paused = false;
  attack.enabled = true;
  // Drop any movement keys pressed while the card was up.
  player.stop();
  // Throw away the frozen time so the world does not jump on resume.
  clock.getDelta();
  renderGeneBar();
}

// Keyboard shortcuts for the gene card: F takes, G (or Esc) skips.
window.addEventListener('keydown', (event) => {
  if (geneCard.style.display === 'none') return;
  if (event.code === 'KeyF' || event.code === 'Enter') {
    event.preventDefault();
    resolveGene(true);
  } else if (event.code === 'KeyG' || event.code === 'Escape') {
    event.preventDefault();
    resolveGene(false);
  }
});

// ---------------------------------------------------------------------------
// Talent offer (every minute)
// ---------------------------------------------------------------------------
/**
 * Visual categories for the draft cards. The category is derived from the
 * talent's effect, so adding a talent does not require editing a second table.
 * Icons are inline SVG: no external art or icon font is used.
 */
const TALENT_TONES = {
  offense: {
    label: 'Offense',
    icon:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M13 2 4.5 13.5H11l-1 8.5L19.5 10H13V2Z"/></svg>',
  },
  guard: {
    label: 'Defense',
    icon:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 3 5 6v5.4c0 4.6 2.9 8 7 9.6 4.1-1.6 7-5 7-9.6V6l-7-3Z"/>' +
      '<path d="m9 12 2 2 4-4"/></svg>',
  },
  mobility: {
    label: 'Mobility',
    icon:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M4 12h15"/><path d="m14 6 6 6-6 6"/></svg>',
  },
  fortune: {
    label: 'Fortune',
    icon:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="m12 2.5 2.8 6 6.7.8-5 4.4 1.4 6.6-5.9-3.4-5.9 3.4 1.4-6.6-5-4.4 6.7-.8 2.8-6Z"/></svg>',
  },
  utility: {
    label: 'Utility',
    icon:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l3 3M16 16l3 3M19 5l-3 3M8 16l-3 3"/></svg>',
  },
};

/**
 * Picks the card category that best describes a talent's effect.
 *
 * @param {object} talent Entry from TALENTS.
 * @returns {keyof typeof TALENT_TONES}
 */
function talentTone(talent) {
  const effect = talent.effect || {};
  if (effect.extraGeneSlot || effect.scoreMult) return 'fortune';
  if (effect.moveSpeed && !effect.damageReduction) return 'mobility';
  if (effect.attackPower || effect.cooldownMult || effect.attackRange) return 'offense';
  if (effect.damageReduction || effect.maxHp || effect.shieldMaxPercent || effect.lifesteal) {
    return 'guard';
  }
  return 'utility';
}

const talentCard = document.createElement('div');
talentCard.className = 'talent-card';
talentCard.setAttribute('role', 'dialog');
talentCard.setAttribute('aria-modal', 'true');
talentCard.setAttribute('aria-label', 'Choose a talent');
talentCard.style.display = 'none';
document.body.appendChild(talentCard);

/** Opens the three-talent offer and freezes the run. */
function showTalentOffer() {
  const offer = talents.roll();
  if (!offer || offer.length === 0) return;

  paused = true;
  attack.enabled = false;
  player.stop();
  delete talentCard.dataset.resolving;
  talentCard.style.display = 'flex';
  sound.talentOffer();

  const cards = offer
    .map((talent, index) => {
      // Ranks come from the hero's level, so every card is a *new* talent and
      // starts at whatever rank the hero is already at — not at level 1. The
      // card has to say that, or a level-8 hero would read "+1 attack" and
      // expect far less than he actually gets.
      const rank = talents.levelOf(talent);
      const now = formatTalentEffect(talentEffectAt(talent, rank));
      const nextRankLevel = nextTalentRankLevel(talents.heroLevel, talent);
      const badge = `<span class="talent-new">Rank ${rank}</span>`;
      const toneKey = talentTone(talent);
      const tone = TALENT_TONES[toneKey];

      return [
        `<button class="talent-choice" type="button" data-index="${index}" data-tone="${toneKey}" style="--i:${index}">`,
        '  <span class="talent-head">',
        `    <span class="talent-icon" aria-hidden="true">${tone.icon}</span>`,
        `    <span class="talent-key">${index + 1}</span>`,
        '  </span>',
        `  <span class="talent-watermark" aria-hidden="true">${tone.icon}</span>`,
        `  <span class="talent-tone">${tone.label}</span>`,
        // The name carries its own data attribute so the badge next to it can
        // change shape without anyone having to parse the visible text.
        `  <span class="talent-name" data-name="${talent.name}">${talent.name}${badge}</span>`,
        `  <span class="talent-effect">${now}</span>`,
        `  <span class="talent-blurb">${talent.blurb}</span>`,
        '  <span class="talent-foot">',
        `    <span class="talent-rank-note">${
          nextRankLevel ? `Rank ${rank + 1} at hero level ${nextRankLevel}` : 'Max rank'
        }</span>`,
        `    <span class="talent-pick">Select <b>${index + 1}</b></span>`,
        '  </span>',
        '</button>',
      ].join('');
    })
    .join('');

  const filled = talents.owned.length;
  const slots = Array.from({ length: talents.slotCount }, (_, index) =>
    `<span class="talent-slot${index < filled ? ' filled' : ''}"></span>`
  ).join('');

  talentCard.innerHTML = [
    '<div class="talent-box" tabindex="-1">',
    '  <div class="talent-kicker">',
    '    <span class="talent-tier">Talent Draft</span>',
    `    <span class="talent-slots" aria-label="${filled} of ${talents.slotCount} talent slots filled">${slots}</span>`,
    '  </div>',
    '  <div class="talent-title">Choose one</div>',
    '  <div class="talent-sub">' +
      'Talent ' + (filled + 1) + ' of ' + talents.slotCount +
      ' · locked in for the rest of this run</div>',
    '  <div class="talent-choices">' + cards + '</div>',
    '  <button class="talent-skip" type="button">Skip this offer <kbd>Esc</kbd></button>',
    '</div>',
  ].join('');

  for (const button of talentCard.querySelectorAll('.talent-choice')) {
    button.onclick = () => chooseTalent(Number(button.dataset.index));
  }
  talentCard.querySelector('.talent-skip').onclick = () => chooseTalent(-1);

  // Focus the dialog itself, not the first card: a reflex Space (the attack
  // key) must not silently pick card 1. Tab reaches the cards normally.
  const box = talentCard.querySelector('.talent-box');
  if (box) box.focus();
}

/**
 * Plays the pick animation before resolving the offer.
 *
 * @param {number} index Index into the current offer, or -1 to skip.
 */
function chooseTalent(index) {
  if (talentCard.dataset.resolving === '1') return;
  talentCard.dataset.resolving = '1';

  const selector = index >= 0 ? `.talent-choice[data-index="${index}"]` : '.talent-skip';
  const button = talentCard.querySelector(selector);
  if (button) button.classList.add('is-picked');

  // Short enough to feel instant, long enough for the selected card to flash
  // gold before the overlay disappears.
  window.setTimeout(() => resolveTalent(index), index >= 0 ? 160 : 70);
}

/**
 * Applies the chosen talent (or declines the offer) and resumes the run.
 *
 * @param {number} index Index into the current offer, or -1 to skip.
 */
function resolveTalent(index) {
  delete talentCard.dataset.resolving;
  const taken = talents.resolve(index);
  talentCard.style.display = 'none';
  paused = false;
  attack.enabled = true;
  player.stop();
  clock.getDelta();
  if (taken) {
    sound.pickup(1);
    // Lucky widens the gene bar immediately, not on the next frame.
    genes.setSlotCount(3 + talents.stats().extraGeneSlot);
    renderGeneBar();
  }
}

// 1/2/3 pick a talent; Esc declines the whole offer.
window.addEventListener('keydown', (event) => {
  if (talentCard.style.display === 'none') return;
  const digit = { Digit1: 0, Digit2: 1, Digit3: 2 }[event.code];
  if (digit !== undefined) {
    event.preventDefault();
    chooseTalent(digit);
  } else if (event.code === 'Escape' || event.code === 'KeyG') {
    event.preventDefault();
    chooseTalent(-1);
  }
});

// ---------------------------------------------------------------------------
// Pause menu
// ---------------------------------------------------------------------------
let pauseMenuOpen = false;
let charPanelOpen = false;

const pauseMenu = document.createElement('div');
pauseMenu.className = 'pause-overlay';
pauseMenu.style.display = 'none';
document.body.appendChild(pauseMenu);

/**
 * Fills the pause overlay.
 *
 * The pause screen is a *reference* screen: it holds the control list and
 * nothing else. Build details (genes, talents, derived stats) live in the
 * character panel — showing them in both places made each screen half a
 * manual and half a stat sheet, and neither was pleasant to read.
 */
function renderPauseMenu() {
  const controls = [
    ['WASD', 'Hop around the board'],
    ['Space', 'Tongue snap + croak wave (360°) — hold to attack'],
    ['E', 'Awakening — spend a charge'],
    ['Q', 'Croak — shove the swarm (level 4)'],
    ['1 / 2 / 3', 'Pick a talent card'],
    ['Esc', 'Decline the talent offer'],
    ['F', 'Absorb the gene orb'],
    ['G / Esc', 'Discard the gene orb'],
    ['C', 'Character panel — your live stats'],
    ['P / Esc', 'Pause and resume'],
    ['M', 'Mute or unmute sound'],
  ]
    .map(
      ([key, what]) =>
        '<div class="pause-control">' +
        `<kbd>${key}</kbd>` +
        `<span>${what}</span>` +
        '</div>'
    )
    .join('');

  const geneSlots = genes.slots.length;
  const talentSlots = talents.slotCount;

  pauseMenu.innerHTML = [
    '<div class="pause-box">',
    '  <div class="pause-title">Paused</div>',
    '  <div class="pause-sub">Press P or Esc to continue</div>',
    '  <div class="pause-section">',
    '    <div class="pause-label">Controls</div>',
    `    <div class="pause-controls">${controls}</div>`,
    '  </div>',
    '  <div class="pause-section">',
    '    <div class="pause-label">Field notes</div>',
    '    <div class="pause-notes">',
    `      <p><b>Awakening (E):</b> ${AWAKEN_DURATION}s of ${AWAKEN_SUMMARY}.</p>`,
    '      <p><b>Tongue snap:</b> the front 120&deg; is a direct hit; the croak wave splashes everything else.</p>',
    '      <p><b>Croak (Q):</b> unlocks at level 4 &mdash; a 360&deg; shove with a short stun.</p>',
    '      <p><b>Bomb pickup:</b> clears ordinary insects and deals 20% of a boss&rsquo;s max HP.</p>',
    '    </div>',
    '  </div>',
    '  <div class="pause-section">',
    '    <div class="pause-label">Credits</div>',
    '    <div class="pause-credits">',
    '      <p><b>Tode</b> &mdash; JetBrains Academy course asset, used with the MIT-licensed course scaffold.</p>',
    '      <p><b>Small House</b> &mdash; Jarlan Perez, <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>, via <a href="https://poly.pizza/m/053kskrV4U_" target="_blank" rel="noopener">Poly Pizza</a>. Converted to glTF and scaled in-engine.</p>',
    '      <p><b>Audio</b> &mdash; generated at runtime with the Web Audio API; no recordings are used.</p>',
    '      <p><b>Code</b> &mdash; MIT; three.js and Vite are MIT. Full credits in <a href="https://github.com/wudhx/tode-talent-awakening/blob/main/CREDITS.md" target="_blank" rel="noopener">CREDITS.md</a>.</p>',
    '    </div>',
    '  </div>',
    '  <div class="pause-foot">',
    `    <span>${geneSlots} gene slots · ${talentSlots} talent slots</span>`,
    '    <span>Open the character panel for stats</span>',
    '  </div>',
    '  <button class="pause-continue">Continue</button>',
    '</div>',
  ].join('');

  pauseMenu.querySelector('.pause-continue').onclick = () => closePauseMenu();
}

/** Freezes the world and shows the pause overlay. */
function openPauseMenu() {
  if (gameState !== 'playing') return;
  // A gene or talent card owns the screen while it is up; the pause menu must
  // not open on top of it.
  if (geneCard.style.display !== 'none') return;
  if (talentCard.style.display !== 'none') return;
  pauseMenuOpen = true;
  paused = true;
  attack.enabled = false;
  player.stop();
  renderPauseMenu();
  pauseMenu.style.display = 'flex';
}

/** Unfreezes the world and hides the pause overlay. */
function closePauseMenu() {
  pauseMenuOpen = false;
  paused = false;
  attack.enabled = true;
  player.stop();
  clock.getDelta();
  pauseMenu.style.display = 'none';
}

// P / Esc toggles the pause menu. Ignored while the gene or talent card and
// the game-over overlay are up, so those keep their own keys.
window.addEventListener('keydown', (event) => {
  if (event.code !== 'KeyP' && event.code !== 'Escape') return;
  if (gameState !== 'playing') return;
  // A card that handled this very keypress has already marked the event, even
  // though its container is hidden again by now. Without this check the same
  // Escape would resolve the card and then immediately open the pause menu.
  if (event.defaultPrevented) return;
  if (geneCard.style.display !== 'none') return;
  if (talentCard.style.display !== 'none') return;
  event.preventDefault();
  if (charPanelOpen) {
    closeCharPanel();
    return;
  }
  if (pauseMenuOpen) closePauseMenu();
  else openPauseMenu();
});

// ---------------------------------------------------------------------------
// Character panel
// ---------------------------------------------------------------------------
const charPanel = document.createElement('div');
charPanel.className = 'char-overlay';
charPanel.style.display = 'none';
document.body.appendChild(charPanel);

/**
 * Fills the character panel with the live build.
 *
 * This screen owns every number; the pause screen owns every key. Each stat
 * row carries two values: the total the game actually uses, and a breakdown
 * of where that total came from. Without the breakdown "ATK 3.42" is a
 * scoreboard rather than information — the player cannot tell whether the
 * gene they just took mattered.
 */
function renderCharPanel() {
  const geneRows = genes.slots.map((slot) => {
    if (!slot) return '<div class="char-gene empty">Empty slot</div>';
    const cfg = GENE_TYPES[slot.key];
    const color = `#${TIER_COLORS[slot.tier].toString(16).padStart(6, '0')}`;
    return (
      '<div class="char-gene">' +
      `<span class="gene-dot" style="background:${color}"></span>` +
      `<b>${cfg.label}</b> · ${TIER_LABELS[slot.tier]} · x${formatStacks(slot.stacks)}` +
      `<div class="char-gene-detail">${formatPerLayer(cfg, slot.tier)} · ${formatCap(
        cfg,
        slot.tier
      )}</div>` +
      '</div>'
    );
  });

  const geneStats = genes.stats();
  const talentStats = talents.stats();

  // --- Talents, with the rank the hero's level puts each one at ------------
  const talentRows = talents.owned.length
    ? talents.owned
        .map((entry) => {
          const max = talentMaxLevel(entry);
          const rank = talents.levelOf(entry);
          const live = talentEffectAt(entry, rank);
          const pips = Array.from({ length: max }, (_, i) =>
            `<i class="lvl-pip${i < rank ? ' on' : ''}"></i>`
          ).join('');
          // Ranks track the hero, so the useful line is not "what is rank 2"
          // but "which hero level buys it".
          const nextRankLevel = nextTalentRankLevel(talents.heroLevel, entry);
          const next = nextRankLevel
            ? `Rank ${rank + 1} at hero level ${nextRankLevel}: ${formatTalentEffect(
                talentEffectAt(entry, rank + 1)
              )}`
            : 'Maxed';
          return (
            '<div class="char-talent">' +
            '<div class="char-talent-head">' +
            `<b>${entry.name}</b>` +
            `<span class="char-talent-level">Rank ${rank} / ${max}</span>` +
            '</div>' +
            `<div class="lvl-pips">${pips}</div>` +
            // The green line is what the hero has right now — it is read from
            // the same function the game uses, so it cannot disagree.
            `<div class="char-talent-now">Now: ${formatTalentEffect(live)}</div>` +
            `<div class="char-gene-detail">${next}</div>` +
            '</div>'
          );
        })
        .join('')
    : '<div class="char-talent empty">' +
      `No talents yet. You have ${talents.slotCount} slots, and a new offer appears ` +
      `every ${TALENT_INTERVAL}s. Talent ranks rise with your level.</div>`;

  const awakenText = awakening.active
    ? `Active · ${awakening.remaining.toFixed(1)}s left`
    : awakening.ready
      ? 'Charged — press E'
      : `${Math.round(awakening.progress * 100)}% charged`;

  // --- Stat rows, each with its sources spelled out -----------------------
  const levelAttack = (health.level - 1) * 0.05;
  const levelReduction = Math.min(0.15, (health.level - 1) * 0.01);
  const levelSpeed = 1 + (health.level - 1) * 0.01;

  const pct = (value) => `${(value * 100).toFixed(1)}%`;
  const signed = (value, unit = '') => {
    if (Math.abs(value) < 1e-9) return null;
    return `${value > 0 ? '+' : ''}${Number(value.toFixed(2))}${unit}`;
  };

  /** Builds one stat row: label, total, and source chips. */
  const row = (label, total, sources) => {
    const chips = sources
      // A source that contributes nothing is passed as the `null` returned by
      // `signed()`, or as a tuple whose text is null/empty. Both must vanish:
      // printing the raw value would surface a literal "null" chip.
      .map((source) => {
        if (!source) return null;
        const [name, text] = source;
        return text === null || text === undefined || text === '' ? null : [name, text];
      })
      .filter(Boolean)
      .map(([name, text]) => `<span class="src">${name} <b>${text}</b></span>`)
      .join('');
    return (
      '<div class="char-stat">' +
      `<span class="char-stat-label">${label}</span>` +
      `<b class="char-stat-total">${total}</b>` +
      `<div class="char-stat-src">${chips}</div>` +
      '</div>'
    );
  };

  const stats = [
    row('Level', `${health.level} / 15`, [
      [
        'Next level',
        health.level < 15
          ? `${Math.round(health.maxHp)} / ${(health.level + 1) * 100} max HP`
          : 'Max',
      ],
    ]),
    row('Health', `${Math.ceil(health.hp)} / ${Math.round(health.maxHp)}`, [
      ['Base', '100'],
      ['Levels', signed((health.level - 1) * 100)],
      ['Genes', geneStats.maxHp ? signed(geneStats.maxHp) : null],
      ['Talents', talentStats.maxHp ? signed(talentStats.maxHp) : null],
      ['Boss', bossBonus.maxHp ? signed(bossBonus.maxHp) : null],
    ]),
    row('Attack power', playerStats.attackPower.toFixed(2), [
      ['Base', '1.00'],
      ['Levels', signed(levelAttack)],
      ['Genes', geneStats.attackPower ? signed(geneStats.attackPower) : null],
      ['Talents', talentStats.attackPower ? signed(talentStats.attackPower) : null],
      ['Boss', bossBonus.attack ? signed(bossBonus.attack) : null],
      playerStats.awakened ? ['Awakening', 'x3'] : null,
    ]),
    row('Damage reduction', pct(playerStats.damageReduction), [
      ['Levels', signed(levelReduction * 100, '%')],
      ['Genes', geneStats.damageReduction ? signed(geneStats.damageReduction * 100, '%') : null],
      ['Talents', talentStats.damageReduction ? signed(talentStats.damageReduction * 100, '%') : null],
      ['Boss', bossBonus.defense ? signed(bossBonus.defense * 100, '%') : null],
      ['Cap', '80%'],
    ]),
    row('Lifesteal', pct(playerStats.lifesteal), [
      ['Genes', geneStats.lifesteal ? signed(geneStats.lifesteal * 100, '%') : null],
      ['Talents', talentStats.lifesteal ? signed(talentStats.lifesteal * 100, '%') : null],
      ['Cap', '35%'],
    ]),
    row('Attack range', `${Math.round(playerStats.attackRange)}`, [
      ['Base', '—'],
      ['Genes', geneStats.attackRange ? signed(geneStats.attackRange) : null],
      ['Talents', talentStats.attackRange ? signed(talentStats.attackRange) : null],
      playerStats.awakened ? ['Awakening', 'x1.6'] : null,
    ]),
    row('Attack cooldown', `${playerStats.attackCooldown.toFixed(2)}s`, [
      ['Genes', geneStats.cooldownMult ? `${signed(geneStats.cooldownMult * 100, '%')}` : null],
      ['Talents', talentStats.cooldownMult ? signed(talentStats.cooldownMult * 100, '%') : null],
      ['Floor', `${geneStats.cooldownFloor.toFixed(2)}s`],
    ]),
    row('Move speed', `${playerStats.moveSpeedMult >= 1 ? '+' : ''}${Math.round((playerStats.moveSpeedMult - 1) * 100)}%`, [
      ['Levels', signed((levelSpeed - 1) * 100, '%')],
      ['Talents', talentStats.moveSpeed ? signed(talentStats.moveSpeed * 100, '%') : null],
    ]),
    row('Shield', `${Math.round(playerStats.shield)} / ${Math.round(playerStats.shieldMax)}`, [
      ['Talents', talentStats.shieldMaxPercent ? signed(talentStats.shieldMaxPercent * 100, '%') : null],
      // The old chip here claimed kills refill the shield, which was never
      // true — the only refill is the out-of-combat regeneration below.
      ['Regen', `${Math.round(SHIELD_REGEN_PER_SECOND * 100)}%/s after ${SHIELD_REGEN_DELAY}s`],
    ]),
    row('Gene slots', `${genes.slots.length}`, [
      ['Base', '3'],
      ['Lucky', talents.owned.some((t) => t.key === 'lucky') ? '+1' : null],
    ]),
    row('Awakening', awakenText, [
      ['Charge', `${AWAKEN_SCORE_PER_CHARGE} pts`],
      ['Banked', `${awakening.charges} / ${AWAKEN_MAX_CHARGES}`],
    ]),
    row(
      'Croak',
      croakUnlocked
        ? croakCooldown > 0
          ? `Cooling down · ${croakCooldown.toFixed(1)}s`
          : 'Ready · press Q'
        : `Unlocks at level ${CROAK_UNLOCK_LEVEL}`,
      [
        ['Cooldown', `${CROAK_COOLDOWN}s`],
        ['Stun', `${CROAK_STUN_DURATION}s`],
      ]
    ),
  ].join('');

  charPanel.innerHTML = [
    '<div class="char-box">',
    '  <div class="char-head">',
    '    <div class="char-portrait"></div>',
    '    <div class="char-heading">',
    '      <div class="char-name">Tode</div>',
    `      <div class="char-level">Level ${health.level} · ${Math.round(score.value)} pts</div>`,
    '    </div>',
    '    <button class="char-close">Close <kbd>C</kbd></button>',
    '  </div>',
    '  <div class="char-section">',
    '    <div class="char-label">Stats</div>',
    `    <div class="char-stats">${stats}</div>`,
    '  </div>',
    '  <div class="char-section">',
    `    <div class="char-label">Genes <span class="char-label-note">locked for the run</span></div>`,
    `    <div class="char-genes">${geneRows.join('')}</div>`,
    '  </div>',
    '  <div class="char-section">',
    `    <div class="char-label">Talents <span class="char-label-note">${talents.owned.length} / ${talents.slotCount} slots used</span></div>`,
    `    <div class="char-talents">${talentRows}</div>`,
    '  </div>',
    '</div>',
  ].join('');

  charPanel.querySelector('.char-close').onclick = () => closeCharPanel();
}

/** Freezes the world and opens the character panel. */
function openCharPanel() {
  if (gameState !== 'playing') return;
  if (geneCard.style.display !== 'none') return;
  if (pauseMenuOpen) closePauseMenu();
  charPanelOpen = true;
  paused = true;
  attack.enabled = false;
  player.stop();
  renderCharPanel();
  charPanel.style.display = 'flex';
}

/** Closes the character panel and resumes the run. */
function closeCharPanel() {
  charPanelOpen = false;
  paused = false;
  attack.enabled = true;
  player.stop();
  clock.getDelta();
  charPanel.style.display = 'none';
}

window.addEventListener('keydown', (event) => {
  if (event.code !== 'KeyC') return;
  if (gameState !== 'playing') return;
  if (geneCard.style.display !== 'none') return;
  event.preventDefault();
  if (charPanelOpen) closeCharPanel();
  else openCharPanel();
});

// ---------------------------------------------------------------------------
// Per-frame interaction state
// ---------------------------------------------------------------------------
/** Tracks the bush hide / expose window. */
const bushState = {
  active: false,
  bush: null,
  timer: 0,
  exposed: false,
};
/** Tracks the flower the hero is currently harvesting. */
const flowerState = {
  flower: null,
  timer: 0,
};
/** Tracks the pond the hero is currently wading in. */
const pondState = {
  inWater: false,
  pond: null,
  timer: 0,
  /** HP already restored during this soak, so the per-soak cap can be enforced. */
  healAccum: 0,
  /** Whether this soak has already rolled its random bonus. */
  bonusFired: false,
};
/** Tracks the highest score milestone that has already bloomed a flower. */
let lastFlowerMilestone = 0;
/** Set of bushes enemies have recently whacked. */
const damagedBushes = new Set();

// ---------------------------------------------------------------------------
// On-screen controls reminder
// ---------------------------------------------------------------------------
// The full key list lives on the pause screen; this corner strip only names
// the two screens a player needs early — the stat sheet and the pause menu.
const hint = document.createElement('div');
hint.className = 'hint';
hint.innerHTML = [
  '<div><kbd>Space</kbd> tongue snap</div>',
  '<div><kbd>Q</kbd> croak (level 4)</div>',
  '<div><kbd>C</kbd> character panel</div>',
  '<div><kbd>P</kbd> pause</div>',
].join('');
document.body.appendChild(hint);

/** Currently active enemies. */
let enemies = [];
/** Countdown until the next enemy spawns. */
let spawnTimer = 0;

const PLAYER_START = new THREE.Vector3(0, 0, 0);

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------
/** @type {'playing' | 'game-over'} */
let gameState = 'playing';

let gameOverOverlay = null;

/** Formats a run length as m:ss. */
function formatRunTime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Fills the Game Over "This run" panel from the state still held at death. */
function renderRunSummary() {
  const talentList = gameOverOverlay.querySelector('.go-run-talents');
  talentList.innerHTML = talents.owned.length
    ? talents.owned
        .map(
          (talent) =>
            `<span class="go-run-chip">${talent.name}` +
            `<b>Rank ${talents.levelOf(talent)}</b></span>`
        )
        .join('')
    : '<span class="go-run-empty">None taken</span>';

  const geneList = gameOverOverlay.querySelector('.go-run-genes');
  const lockedGenes = genes.slots.filter(Boolean);
  geneList.innerHTML = lockedGenes.length
    ? lockedGenes
        .map((slot) => {
          const gene = GENE_TYPES[slot.key];
          const tierColor = `#${TIER_COLORS[slot.tier].toString(16).padStart(6, '0')}`;
          return (
            `<span class="go-run-chip">${gene.label}` +
            `<b style="color:${tierColor}">${TIER_LABELS[slot.tier]}</b>` +
            `<span class="go-run-stack">x${formatStacks(slot.stacks)}</span></span>`
          );
        })
        .join('')
    : '<span class="go-run-empty">None locked</span>';

  gameOverOverlay.querySelector('.go-run-time').textContent = formatRunTime(runTime);
  gameOverOverlay.querySelector('.go-run-level').textContent = String(health.level);
  gameOverOverlay.querySelector('.go-run-bosses').textContent = String(bossesKilled);
}

function buildGameOverOverlay() {
  const overlay = document.createElement('div');
  overlay.className = 'game-over';
  overlay.innerHTML = [
    '<div class="go-title">Game Over</div>',
    '<div class="go-badge">New Best!</div>',
    '<div class="go-score">Score <b>0</b></div>',
    '<div class="go-run">',
    '  <div class="go-run-title">This run</div>',
    '  <div class="go-run-stats">',
    '    <div class="go-run-stat"><span>Time</span><b class="go-run-time">0:00</b></div>',
    '    <div class="go-run-stat"><span>Level</span><b class="go-run-level">1</b></div>',
    '    <div class="go-run-stat"><span>Boss kills</span><b class="go-run-bosses">0</b></div>',
    '  </div>',
    '  <div class="go-run-row">',
    '    <span class="go-run-label">Talents</span>',
    '    <span class="go-run-list go-run-talents"></span>',
    '  </div>',
    '  <div class="go-run-row">',
    '    <span class="go-run-label">Genes</span>',
    '    <span class="go-run-list go-run-genes"></span>',
    '  </div>',
    '</div>',
    '<div class="go-board">',
    '  <div class="go-board-title">Best runs</div>',
    '  <ol></ol>',
    '</div>',
    '<div class="go-hint">Press SPACE to play again</div>',
  ].join('');

  document.body.appendChild(overlay);
  return overlay;
}

function showGameOver() {
  gameState = 'game-over';

  if (!gameOverOverlay) gameOverOverlay = buildGameOverOverlay();

  const result = highScores.submit(score.value);

  gameOverOverlay.querySelector('.go-score b').textContent = String(Math.floor(score.value));
  gameOverOverlay.querySelector('.go-badge').style.display = result.isBest
    ? 'inline-block'
    : 'none';

  gameOverOverlay.querySelector('.go-board ol').innerHTML = highScores.entries
    .map(
      (entry, index) =>
        `<li${index === 0 ? ' class="top"' : ''}>` +
        `<span class="rank">${index + 1}</span>` +
        `<span class="val">${entry.score}</span>` +
        `<span class="date">${entry.date}</span>` +
        '</li>'
    )
    .join('');

  renderRunSummary();
  gameOverOverlay.style.display = 'flex';

  player.group.visible = false;
  player.controlsEnabled = false;
  player.stop();
  attack.enabled = false;
  juice.reset();

  sound.gameOver();
  if (result.isBest) sound.newBest(1.1);
}

function resetGame() {
  player.group.visible = true;
  player.group.position.copy(PLAYER_START);
  player.group.position.z = 0;
  player.yaw.rotation.z = 0;
  player.controlsEnabled = true;
  player.stop();

  if (player.model) player.model.visible = true;

  enemies.forEach((enemy) => enemy.dispose());
  enemies = [];
  spawnTimer = 0;

  score.reset();
  health.reset();
  attack.enabled = true;
  attack.reset();
  powerUps.reset();
  juice.reset();

  // Reset interaction state.
  bushState.active = false;
  bushState.bush = null;
  bushState.timer = 0;
  bushState.exposed = false;
  flowerState.flower = null;
  flowerState.timer = 0;
  pondState.inWater = false;
  pondState.pond = null;
  pondState.timer = 0;
  pondState.healAccum = 0;
  pondState.bonusFired = false;
  if (scenery) for (const pond of scenery.ponds) pond.cooldown = 0;
  lastFlowerMilestone = 0;
  damagedBushes.clear();

  // Genes and their HUD reset with the run.
  genes.reset(3);
  lastGeneMaxHp = 0;
  // Talents too; the Lucky bonus slot goes away with them.
  talents.reset();
  talentCard.style.display = 'none';
  lastTalentMaxHp = 0;
  lastTalentShieldMax = 0;
  playerStats.shield = 0;
  playerStats.shieldIdle = 0;
  playerStats.shieldMax = 0;
  // The awakening bar empties with the run.
  awakening.reset();
  renderAwakenBar();
  croakCooldown = 0;
  croakUnlocked = false;
  renderCroakBar();

  // Bosses and their rewards reset with the run.
  boss = null;
  nextBossScore = FIRST_BOSS_SCORE;
  bossesSpawned = 0;
  bossCooldown = 0;
  bossesKilled = 0;
  bossBonus.maxHp = 0;
  bossBonus.attack = 0;
  bossBonus.defense = 0;
  renderBossBar();

  // Hazards a boss left behind belong to the run that created them. Without
  // this, dying in a venom puddle and pressing Space respawned the frog
  // standing in that same puddle, and the new run started taking damage from
  // the old one's venom. The burrow ring had the same problem: a mole that
  // killed the hero mid-burrow left its warning circle on the board.
  for (const pool of venomPools) {
    scene.remove(pool.mesh);
    pool.mesh.geometry.dispose();
    pool.mesh.material.dispose();
  }
  venomPools.length = 0;
  poison.stacks = 0;
  poison.timer = 0;
  poison.tick = 0;
  poison.damage = 0;
  clearBurrowMarker();

  runTime = 0;
  paused = false;
  geneCard.style.display = 'none';
  renderGeneBar();
  renderTalentPips();

  if (gameOverOverlay) {
    gameOverOverlay.style.display = 'none';
  }

  gameState = 'playing';

  spawnEnemy();
}

window.addEventListener('keydown', (event) => {
  if (event.code !== 'Space') return;
  if (gameState === 'game-over') {
    event.preventDefault();
    resetGame();
  }
});

window.addEventListener('keydown', (event) => {
  if (event.code !== 'KeyM') return;
  sound.muted = !sound.muted;
});

// ---------------------------------------------------------------------------
// Enemy spawning
// ---------------------------------------------------------------------------
function pickSpawnPoint() {
  for (let attempt = 0; attempt < 24; attempt++) {
    const angle = Math.random() * Math.PI * 2;
    const distance = THREE.MathUtils.randFloat(660, 820);

    const point = new THREE.Vector2(
      player.position.x + Math.cos(angle) * distance,
      player.position.y + Math.sin(angle) * distance
    );

    clampToBoard(point, 70);
    if (collidesWithObstacle(new THREE.Vector3(point.x, point.y, 0), enemyObstacles, 40)) {
      continue;
    }

    return point;
  }

  const fallback = new THREE.Vector2(player.position.x + 700, player.position.y);
  clampToBoard(fallback, 70);
  return fallback;
}

function spawnEnemy(speed) {
  const enemy = new Enemy(scene, pickSpawnPoint(), pickEnemyType(score.value));
  if (typeof speed === 'number') enemy.setBaseSpeed(speed);
  enemies.push(enemy);
  return enemy;
}

// ---------------------------------------------------------------------------
// Bosses
// ---------------------------------------------------------------------------
/** The boss currently alive, or null. */
let boss = null;
let nextBossScore = FIRST_BOSS_SCORE;
let bossesSpawned = 0;
/** Time left before the next boss may spawn after a kill. */
let bossCooldown = 0;
/** Bosses actually killed this run, for the Game Over summary. */
let bossesKilled = 0;
/** Live venom puddles left by a centipede boss. */
const venomPools = [];
/** Lingering poison on the hero after standing in venom. */
const poison = { stacks: 0, timer: 0, tick: 0, damage: 0, interval: 1 };
/** Ground ring marking where a mole boss will surface. */
let burrowMarker = null;

/**
 * Spawns a boss and prepares the HUD for it.
 *
 * The boss replaces the ordinary swarm pressure: while one is alive the normal
 * spawner pauses, so the fight reads as a duel instead of a pile-on.
 */
function spawnBoss() {
  const species = BOSS_SPECIES[Math.floor(Math.random() * BOSS_SPECIES.length)];
  const angle = Math.random() * Math.PI * 2;
  const point = new THREE.Vector2(
    player.position.x + Math.cos(angle) * 620,
    player.position.y + Math.sin(angle) * 620
  );
  clampToBoard(point, 120);

  const enemy = new Enemy(scene, point, species, false, {
    boss: true,
    bossIndex: bossesSpawned,
    // The pool is scaled to the hero's current damage so a late boss survives
    // long enough to summon and enrage.
    heroAttack: playerStats.attackPower,
  });
  enemies.push(enemy);
  boss = enemy;
  bossesSpawned += 1;
  bossBar.style.display = 'block';
  renderBossBar();
  juice.onBossSpawn();
  sound.awaken();
  hud.showAction(
    `A giant ${enemy.type.label} appears!`,
    'boss',
    '#ff3d6e',
    2200
  );
  return enemy;
}

/** Rewrites the boss health bar; hides it when no boss is alive. */
function renderBossBar() {
  if (!boss) {
    bossBar.style.display = 'none';
    return;
  }
  const pct = Math.max(0, Math.round((boss.hp / boss.maxHp) * 100));
  bossBar.innerHTML =
    '<div class="boss-head">' +
    `<span class="boss-name">Giant ${boss.type.label}</span>` +
    `<span class="boss-pct">${pct}%</span>` +
    '</div>' +
    `<div class="boss-track"><span style="width:${pct}%"></span></div>`;
  bossBar.dataset.enraged = boss.enraged ? 'yes' : 'no';
}

/**
 * Awards a random run-long stat bonus for downing a boss.
 *
 * Later bosses roll bigger numbers, and the roll is weighted upward each time
 * so the reward keeps pace with the difficulty curve.
 */
function grantBossBonus() {
  const tier = Math.min(1, bossesSpawned * BOSS_BONUS_GROWTH);
  const roll = (min, max) => min + Math.random() * (max - min) * (1 + tier);

  const hpGain = Math.round(roll(BOSS_BONUS_HP_MIN, BOSS_BONUS_HP_MAX));
  const atkGain = Math.round(roll(BOSS_BONUS_ATK_MIN, BOSS_BONUS_ATK_MAX) * 10) / 10;
  const defGain = roll(BOSS_BONUS_DEF_MIN, BOSS_BONUS_DEF_MAX);

  bossBonus.maxHp += hpGain;
  bossBonus.attack += atkGain;
  bossBonus.defense += defGain;
  health.growMaxHp(hpGain);

  hud.showAction(
    `Boss slain: +${hpGain} max HP · +${atkGain.toFixed(1)} attack power · ` +
      `+${(defGain * 100).toFixed(0)}% damage reduction`,
    'boss',
    '#ffc83d',
    3000
  );
}

/**
 * Pays out one kill: score, Awakening charge, max HP, gene drop, boss bonus
 * and the legendary-stack fallback.
 *
 * Shared by the tongue and the Bomb so a boss killed by either path clears
 * its health bar and grants its rewards exactly once.
 *
 * @param {object} enemy The enemy that died.
 */
function awardKill(enemy) {
  // The Scavenger talent scales every kill reward; bosses carry their own
  // much larger point value.
  const points = Math.round((enemy.points || enemy.type.points) * (1 + talents.stats().scoreMult));
  // Feedback before disposal so the burst starts at the body.
  juice.onKill(enemy.position, points, enemy.boss, killColor(enemy));
  enemy.dispose();
  score.addKillPoints(points);
  // Those same points charge the awakening bar.
  if (awakening.addScore(points)) {
    hud.showAction('Awakening charged — press E', 'awaken', '#7c5cff', 1600);
    renderAwakenBar();
  }
  // Every kill nudges the hero's maximum HP, which is what raises his level
  // over a run.
  health.growMaxHp(KILL_MAX_HP_GAIN);
  // And it may drop a gene orb of that species.
  genes.maybeDrop(enemy, runTime, enemy.boss);

  // Bosses pay out a run-long stat bonus on top of the orb.
  if (enemy.boss) {
    bossesKilled += 1;
    bossCooldown = BOSS_RESPAWN_DELAY;
    // The next giant must be earned with a fresh score gap. A boss payout can
    // be large enough to jump past the old threshold in one hit; clamping the
    // threshold to (current score + step) prevents a seamless boss chain.
    nextBossScore = Math.max(nextBossScore, score.value + BOSS_SCORE_STEP);
    if (boss === enemy) boss = null;
    renderBossBar();
    grantBossBonus();
  }

  // Once every gene is legendary, orbs stop; kills feed stacks instead.
  const grown = genes.grantStackOnKill(enemy.elite || enemy.boss);
  if (grown) {
    hud.showAction(`${GENE_TYPES[grown.key].label} gene: +1 stack`, 'gene', '#ffc83d', 1200);
    renderGeneBar();
  }
}


// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------
/**
 * Picks the nearest tree to the hero. Used for the fruit-tree hint and for
 * the tongue-strike test.
 *
 * @param {THREE.Vector2} playerPosition The hero's ground position.
 * @param {Array<object>} trees Tree records from Scenery.
 * @returns {{tree: object|null, distance: number}}
 */
function nearestTree(playerPosition, trees) {
  let best = null;
  let bestDistance = Infinity;
  for (const tree of trees) {
    const distance = playerPosition.distanceTo(tree.position);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = tree;
    }
  }
  return { tree: best, distance: bestDistance };
}

// ---------------------------------------------------------------------------
// Gameplay helpers
// ---------------------------------------------------------------------------
/**
 * Contact radius for a given insect.
 *
 * Ordinary insects are small enough that the flat 45-unit threshold still
 * feels fair, but a boss is 4.5x bigger: judging it by the same distance let
 * the hero stand inside a giant beetle and take no damage at all.
 *
 * @param {import('./components/Enemy.js').Enemy} enemy
 * @returns {number}
 */
function contactDistance(enemy) {
  return enemy.boss ? enemy.radius : PLAYER_HIT_DISTANCE;
}

/**
 * Returns the closest insect currently touching the hero, or null.
 *
 * Returning the enemy (rather than a boolean) lets the damage step read that
 * species' contact damage — a centipede bites for 30, a fly for 20.
 *
 * @returns {import('./components/Enemy.js').Enemy|null}
 */
function enemyTouchingPlayer() {
  let closest = null;
  let closestDistance = Infinity;

  for (const enemy of enemies) {
    const dx = enemy.position.x - player.position.x;
    const dy = enemy.position.y - player.position.y;
    const distance = Math.hypot(dx, dy);
    const reach = contactDistance(enemy);
    if (distance < reach && distance < closestDistance) {
      closestDistance = distance;
      closest = enemy;
    }
  }

  return closest;
}

function canEnemyStep(x, y, self) {
  const probe = new THREE.Vector3(x, y, 0);
  if (collidesWithObstacle(probe, enemyObstacles, self.radius * 0.7 + WALL_CLEARANCE)) {
    return false;
  }
  return !enemies.some((other) => {
    if (other === self) return false;
    return (
      Math.hypot(other.position.x - x, other.position.y - y) < ENEMY_HIT_DISTANCE
    );
  });
}

function hitsWall(position, radius) {
  return collidesWithObstacle(position, obstacles, radius + WALL_CLEARANCE);
}

/**
 * Shortens a hop along its own direction until it lands clear of a wall.
 *
 * @param {THREE.Vector3} from Where the hop starts.
 * @param {THREE.Vector3} target Where an unobstructed hop would land.
 * @returns {THREE.Vector3|null} The furthest clear spot along the hop.
 */
function trimAlong(from, target) {
  if (!hitsWall(target, player.radius)) return target;
  for (let fraction = 0.95; fraction > 0.02; fraction -= 0.04) {
    const candidate = from.clone().lerp(target, fraction);
    if (!hitsWall(candidate, player.radius)) return candidate;
  }
  return null;
}

/**
 * Trims a hop so it lands as close as possible to its target without ending
 * up inside a tree.
 *
 * Rejecting the hop outright is what left the frog stranded a whole hop-length
 * away from every wall. Instead we walk back along the hop direction and keep
 * the furthest spot that is still clear. If even that fails — the hero is
 * wedged between two obstacles — the direction is rotated a little and tried
 * again, so he slips along the wall instead of freezing in place.
 *
 * @param {THREE.Vector3} from Where the hop starts.
 * @param {THREE.Vector3} target Where an unobstructed hop would land.
 * @returns {THREE.Vector3|null} The trimmed landing spot, or null if wedged.
 */
function trimHopToWalls(from, target) {
  const direct = trimAlong(from, target);
  if (direct) return direct;

  const dx = target.x - from.x;
  const dy = target.y - from.y;

  for (const angle of [Math.PI / 6, -Math.PI / 6, Math.PI / 3, -Math.PI / 3]) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const rotated = new THREE.Vector3(
      from.x + dx * cos - dy * sin,
      from.y + dx * sin + dy * cos,
      from.z
    );
    const slid = trimAlong(from, rotated);
    if (slid) return slid;
  }

  return null;
}

/**
 * Slides an insect around an obstacle it could not step through.
 *
 * The previous version nudged the insect 4 units away from the nearest trunk
 * and returned. Two things were wrong with that:
 *
 *   1. It always pushed *radially*, which is the one direction a chaser does
 *      not want — it undoes progress toward the hero.
 *   2. It had no memory. An insect in a pocket between two trunks was pushed
 *      out of one and into the other, every frame, forever. That is exactly
 *      the "stuck monster" the player could farm.
 *
 * Now the insect picks a single tangent (clockwise or counter-clockwise,
 * chosen once and kept) and follows the trunk's surface for it. A committed
 * direction is what actually gets a body out of a pocket; flipping the choice
 * every frame is what traps it.
 *
 * @param {object} enemy The insect that failed to step.
 * @param {number} delta Seconds since the previous frame.
 */
function unstickEnemy(enemy, delta) {
  const current = enemy.position;

  // Which obstacle are we against? Only trunks are solid, so this is cheap.
  let nearest = null;
  let nearestDistance = Infinity;
  for (const obstacle of enemyObstacles) {
    const distance = Math.hypot(
      current.x - obstacle.position.x,
      current.y - obstacle.position.y
    );
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = obstacle;
    }
  }
  if (!nearest) return;

  // Pick a side the first time we get stuck, then keep it for a while.
  // Re-deciding every frame would oscillate between the two tangents.
  enemy.slideSide = enemy.slideSide || (Math.random() < 0.5 ? 1 : -1);
  enemy.stuckTimer = (enemy.stuckTimer || 0) + delta;

  const reach = nearest.radius + enemy.radius * 0.7 + WALL_CLEARANCE;
  const awayX = current.x - nearest.position.x;
  const awayY = current.y - nearest.position.y;
  const awayLength = Math.hypot(awayX, awayY) || 1;
  const normalX = awayX / awayLength;
  const normalY = awayY / awayLength;

  // Tangent = normal rotated 90 degrees, in the committed direction.
  const tangentX = -normalY * enemy.slideSide;
  const tangentY = normalX * enemy.slideSide;

  // Walk along the trunk surface by a step proportional to frame time, so
  // the slide is smooth instead of a per-frame jolt.
  const slide = Math.max(1.2, enemy.speed * delta * 0.9);

  // Radial push only matters once the body is inside the radius; while it is
  // already clear we only add enough to stop it clipping back in.
  const radialPush = Math.max(0, reach - nearestDistance) + 0.6;

  const nextX = current.x + tangentX * slide + normalX * radialPush;
  const nextY = current.y + tangentY * slide + normalY * radialPush;

  // If the tangent is blocked too (a second trunk, a wall), try the other
  // side before giving up for this frame.
  const probe = new THREE.Vector3(nextX, nextY, 0);
  if (collidesWithObstacle(probe, enemyObstacles, enemy.radius * 0.7 + WALL_CLEARANCE)) {
    enemy.slideSide = -enemy.slideSide;
    const altX = current.x - tangentX * slide + normalX * radialPush;
    const altY = current.y - tangentY * slide + normalY * radialPush;
    const alt = new THREE.Vector3(altX, altY, 0);
    if (!collidesWithObstacle(alt, enemyObstacles, enemy.radius * 0.7 + WALL_CLEARANCE)) {
      current.x = altX;
      current.y = altY;
      return;
    }
    // Both tangents blocked: this is a dead end. Hop toward the hero's side
    // of the trunk, ignoring the obstacle for one frame — being briefly
    // inside a canopy is far better than parking there for the whole run.
    current.x += normalX * 3;
    current.y += normalY * 3;
    return;
  }

  current.x = nextX;
  current.y = nextY;

  // A long slide means the insect is orbiting rather than escaping. Sliding
  // cannot always win — in a tight cluster the tangent is blocked on both
  // sides and the radial push has nowhere to go — so after 2.5s the only
  // honest fix is to move it somewhere legal rather than let it grind against
  // the bark for the rest of the run.
  if (enemy.stuckTimer > 2.5) {
    const escape = findClearSpotNear(current, enemy.radius);
    if (escape) {
      current.x = escape.x;
      current.y = escape.y;
    }
    enemy.stuckTimer = 0;
    enemy.slideSide = 0;
    enemy.wanderTimer = 0;
  }
}

/**
 * Finds the nearest spot to `point` that a body of `radius` can stand in.
 *
 * Probes rings outward and takes the first clear sample. Used as the last
 * resort in `unstickEnemy`, where sliding has already failed.
 *
 * @param {{x: number, y: number}} point Where the body currently is.
 * @param {number} radius Body radius.
 * @returns {{x: number, y: number}|null} A legal spot, or null if the whole
 *   neighbourhood is blocked (which should not happen on this board).
 */
function findClearSpotNear(point, radius) {
  const clearance = radius * 0.7 + WALL_CLEARANCE;
  const probe = new THREE.Vector3(0, 0, 0);
  for (let ring = 1; ring <= 5; ring++) {
    const distance = ring * 55;
    for (let step = 0; step < 12; step++) {
      const angle = (step / 12) * Math.PI * 2;
      probe.set(point.x + Math.cos(angle) * distance, point.y + Math.sin(angle) * distance, 0);
      if (collidesWithObstacle(probe, enemyObstacles, clearance)) continue;
      // Clamping can shove the sample back into the trunk at the board edge,
      // so the clamped point gets a second look before it is accepted.
      clampToBoard(probe, radius);
      if (collidesWithObstacle(probe, enemyObstacles, clearance)) continue;
      return { x: probe.x, y: probe.y };
    }
  }
  return null;
}

function isPowerUpSpotFree(x, y) {
  const probe = new THREE.Vector3(x, y, 0);
  if (collidesWithObstacle(probe, enemyObstacles, POWERUP_WALL_CLEARANCE)) return false;
  return Math.hypot(x - player.position.x, y - player.position.y) > TILE_SIZE * 1.5;
}

// ---------------------------------------------------------------------------
// Pond bonuses
// ---------------------------------------------------------------------------
/**
 * Finds a clear spot just outside the hero's pickup radius, so a flower's
 * reward pops out beside it and has to be hopped to — dropping it under the
 * hero's feet would collect it on the same frame and the bloom would never be
 * seen.
 *
 * @param {number} fx Flower X.
 * @param {number} fy Flower Y.
 * @returns {{x: number, y: number}} A clear spot, or the flower itself as a
 *   last resort.
 */
function findFlowerDropSpot(fx, fy) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const angle = Math.random() * Math.PI * 2;
    const distance = 90 + Math.random() * 40;
    const x = fx + Math.cos(angle) * distance;
    const y = fy + Math.sin(angle) * distance;

    if (Math.abs(x) > BOARD_HALF - 80 || Math.abs(y) > BOARD_HALF - 80) continue;
    if (collidesWithObstacle(new THREE.Vector3(x, y, 0), enemyObstacles, POWERUP_WALL_CLEARANCE)) continue;

    return { x, y };
  }
  return { x: fx, y: fy };
}

/**
 * Rolls one of three pond bonuses and applies it.
 *
 * Called once per soak; the pond then goes on a long cooldown. The pool used
 * to heal unconditionally every frame while the hero stood near it, which
 * made him effectively unkillable — that is what this replaces.
 */
function triggerPondBonus() {
  const roll = Math.random();

  if (roll < 0.4) {
    health.heal(30);
    hud.showAction('Pond blessing: +30 HP', 'heart', '#e5484d');
    sound.heal();
  } else if (roll < 0.7) {
    for (const enemy of enemies) {
      // A boss is not part of the swarm that a pond can shoo away. Letting it
      // flee put it on the disengage path, which retires the insect after four
      // seconds — the boss mesh vanished mid-fight while the bar stayed up and
      // the spawner stayed paused.
      if (enemy.boss) continue;
      enemy.fleeFrom(player.position.x, player.position.y);
    }
    hud.showAction('Pond repels the swarm!', 'pond', '#4da6ff');
    sound.shield();
  } else {
    powerUps.pondSlowTimer = 12;
    hud.showAction('Pond chill: insects slowed for 12s', 'freeze', '#8ee8ff');
    sound.powerUp();
  }
}

// ---------------------------------------------------------------------------
// Resize handling
// ---------------------------------------------------------------------------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------------------
// Animation loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();

// Scratch vector reused across frames.
const _dir = new THREE.Vector2();
const _target = new THREE.Vector2();

function gameLoop() {
  const frameDelta = Math.min(clock.getDelta(), 0.1);

  if (gameState === 'game-over') {
    renderer.render(scene, camera);
    return;
  }

  // A gene card (or the pause menu) freezes the world but keeps rendering.
  if (paused) {
    renderer.render(scene, camera);
    return;
  }

  // Feedback effects run on real time; the world runs on the hit-stop-scaled
  // delta, so a kill can freeze the simulation for a few frames while the
  // particles still fly.
  juice.update(frameDelta);
  const delta = frameDelta * juice.timeScale;

  runTime += delta;

  const params = scaledParameters(score.value);
  const boosts = powerUps.multipliers;

  // --- Level-driven bonuses ------------------------------------------------
  // 100 HP = level 1, +100 per level, capped at 15. Each level adds attack,
  // damage reduction and a little move speed. Level reduction is capped at
  // 15% so it cannot combine with genes/talents into near-immunity.
  const level = health.level;
  const levelReduction = Math.min(
    LEVEL_DAMAGE_REDUCTION_MAX,
    (level - 1) * (LEVEL_DAMAGE_REDUCTION_MAX / 14)
  );
  playerStats.attackPower = 1 + (level - 1) * 0.05;
  playerStats.damageReduction = Math.min(MAX_TOTAL_DAMAGE_REDUCTION, levelReduction);
  const levelSpeed = 1 - (level - 1) * 0.01;

  // --- Talent contributions ------------------------------------------------
  // Ranks are derived from the hero's level, so the mirror has to be updated
  // before the sum is taken. A rank change is worth a HUD refresh, because the
  // pip badges print the rank.
  if (talents.syncHeroLevel(level)) {
    renderTalentPips();
    if (talents.owned.length > 0) {
      hud.showAction(`Talent rank increased to ${talentLevelFor(level)}`, 'talent', '#43b96b', 1400);
    }
  }
  const talentStats = talents.stats();
  const talentReduction = Math.max(0, talentStats.damageReduction);
  const talentSpeed = Math.max(-0.5, talentStats.moveSpeed);

  // --- Awakening boost -----------------------------------------------------
  // Applied as multipliers on top of everything else, so it never changes the
  // reductions/floors that keep the hero from becoming invincible.
  const awakenEnded = awakening.update(delta);
  const awaken = awakening.multipliers();
  if (awakenEnded) renderAwakenBar();

  const awakenSpeed = Math.max(-0.5, awaken.speedBonus);
  player.setMoveDuration(
    params.playerMoveDuration *
      boosts.hopDuration *
      levelSpeed *
      (1 - talentSpeed) *
      (1 - awakenSpeed)
  );

  // --- Gene contributions --------------------------------------------------
  const geneStats = genes.stats();
  playerStats.attackPower =
    (1 + (level - 1) * 0.05 + geneStats.attackPower + talentStats.attackPower + bossBonus.attack) *
    awaken.attack;
  playerStats.damageReduction = Math.min(
    MAX_TOTAL_DAMAGE_REDUCTION,
    Math.max(
      0,
      levelReduction + geneStats.damageReduction + talentReduction + bossBonus.defense
    )
  );
  playerStats.lifesteal = Math.min(0.35, geneStats.lifesteal + talentStats.lifesteal);

  attack.cooldownDuration = Math.max(
    geneStats.cooldownFloor,
    params.attackCooldown * geneStats.cooldownMult * (1 + talentStats.cooldownMult)
  );
  attack.radius = Math.min(
    1600,
    (params.attackRadius * boosts.attackRadius + geneStats.attackRange + talentStats.attackRange) *
      awaken.range
  );

  // Mirror the derived values for the character panel.
  playerStats.attackRange = attack.radius;
  playerStats.attackCooldown = attack.cooldownDuration;
  playerStats.moveSpeedMult = levelSpeed * (1 - talentSpeed) * (1 + awakenSpeed);
  playerStats.awakened = awakening.active;
  playerStats.awakenRemaining = awakening.remaining;

  // Beetle genes raise max HP; grant only the newly gained amount so the
  // pool is not topped up every frame.
  if (geneStats.maxHp > lastGeneMaxHp) {
    health.growMaxHp(geneStats.maxHp - lastGeneMaxHp);
    lastGeneMaxHp = geneStats.maxHp;
  }

  // Talent max-HP bonuses follow the same delta rule.
  if (talentStats.maxHp > lastTalentMaxHp) {
    health.growMaxHp(talentStats.maxHp - lastTalentMaxHp);
    lastTalentMaxHp = talentStats.maxHp;
  }

  // Shield talents raise the ceiling and top it up by the same amount once.
  // After that the shield only comes back through regeneration (see below), so
  // raising the ceiling must not be mistaken for a free refill.
  const talentShieldMax = Math.round(health.maxHp * talentStats.shieldMaxPercent);
  playerStats.shieldMax = talentShieldMax;
  if (talentShieldMax > lastTalentShieldMax) {
    playerStats.shield = Math.min(
      talentShieldMax,
      playerStats.shield + (talentShieldMax - lastTalentShieldMax)
    );
    lastTalentShieldMax = talentShieldMax;
  }

  // --- Shield regeneration -------------------------------------------------
  // A shield that never comes back reads as broken, and a shield that comes
  // back while the player is being hit is just extra HP. So: stay untouched
  // for `SHIELD_REGEN_DELAY` seconds and it rebuilds at
  // `SHIELD_REGEN_PER_SECOND` of its ceiling per second, filling from empty in
  // about eight. Taking a hit resets the clock, which makes the rule "back off
  // and it returns" rather than a hidden passive.
  if (playerStats.shieldMax > 0) {
    if (playerStats.shield < playerStats.shieldMax) {
      playerStats.shieldIdle += delta;
      if (playerStats.shieldIdle >= SHIELD_REGEN_DELAY) {
        playerStats.shield = Math.min(
          playerStats.shieldMax,
          playerStats.shield + playerStats.shieldMax * SHIELD_REGEN_PER_SECOND * delta
        );
      }
    } else {
      playerStats.shieldIdle = 0;
    }
  }

  // Offer a talent every minute. `update` only ticks while no offer is open, so
  // a declined offer returns exactly one interval later.
  const talentDue = talents.update(delta);
  if (talentDue) {
    showTalentOffer();
  }
  renderTalentPips();
  renderAwakenBar();

  // Gene orbs bob; touching one opens the Absorb/Discard specimen and freezes the game.
  if (!talentDue && genes.updateOrbs(delta, player.position)) {
    showGeneCard();
  }

  // --- Player movement ----------------------------------------------------
  player.resolveTarget = trimHopToWalls;
  player.confine = (position) => clampToBoard(position, player.radius);
  player.update(delta);

  // --- Hide any prop that lines up between the camera and the frog. ------
  if (scenery) scenery.update(camera, player.position, delta);

  // =======================================================================
  // 1. INTERACTIONS WITH THE WORLD
  // =======================================================================
  const playerPos2 = new THREE.Vector2(player.position.x, player.position.y);

  // --- House interaction --------------------------------------------------
  // Houses are walkable now, so "inside" really is "close to the middle".
  let inHouse = null;
  for (const house of houses) {
    if (!house.alive) continue;
    if (house.position.distanceTo(playerPos2) < house.radius * HOUSE_INTERIOR_RADIUS_RATIO) {
      inHouse = house;
      break;
    }
  }
  currentHouse = inHouse;

  // Fade whichever house the hero is standing in, so he never vanishes inside
  // the model.
  for (const house of houses) {
    if (!house.alive) continue;
    house.fadeTo(house === inHouse ? HOUSE_INTERIOR_OPACITY : 1, delta);
  }

  // --- House interaction --------------------------------------------------
  // Protection is continuous while the house still has structural durability.
  // Insects whack the house, not the hero, but every hit drains that bar.
  // When it reaches zero the house collapses and the frog is exposed again.
  if (inHouse) {
    const pct = Math.max(0, Math.round((inHouse.hp / inHouse.maxHp) * 100));
    const drainPerSec = Math.round(HOUSE_HIT_DAMAGE / HOUSE_HIT_INTERVAL);
    shelterReadout.innerHTML = [
      '<div class="shelter-label">House durability</div>',
      `<div class="shelter-bar"><span style="width:${pct}%"></span></div>`,
      `<div class="shelter-rate">-${drainPerSec}% / second</div>`,
    ].join('');
    shelterReadout.style.display = 'block';
  } else {
    shelterReadout.style.display = 'none';
  }

  // --- Bush interaction ---------------------------------------------------
  let inBush = null;
  if (scenery) {
    for (const bush of scenery.bushes) {
      if (!bush.alive) continue;
      if (bush.position.distanceTo(playerPos2) < BUSH_INTERIOR_DISTANCE) {
        inBush = bush;
        break;
      }
    }
  }

  if (inBush) {
    if (bushState.bush !== inBush) {
      // Stepped into a new bush. One that was already discovered refuses to
      // hide him again until it regrows.
      bushState.bush = inBush;
      if (inBush.cooldown > 0) {
        bushState.timer = 0;
        bushState.exposed = true;
        bushState.active = false;
      } else {
        bushState.timer = BUSH_HIDE_DURATION;
        bushState.exposed = false;
        bushState.active = true;
      }
    } else if (!bushState.exposed) {
      bushState.timer = Math.max(0, bushState.timer - delta);
      if (bushState.timer === 0) {
        bushState.exposed = true;
        bushState.active = false;
        inBush.cooldown = BUSH_COOLDOWN;
        hud.showAction('Spotted! Insects are closing in', 'bush', '#ff6b6b', 2500);
        sound.hurt();
      }
    }
  } else if (bushState.bush) {
    // Left the bush. Burn its cooldown only if he actually used the hide, so
    // brushing past one by accident does not waste it.
    if (bushState.timer < BUSH_HIDE_DURATION - 0.01) {
      bushState.bush.cooldown = BUSH_COOLDOWN;
    }
    bushState.bush = null;
    bushState.timer = 0;
    bushState.exposed = false;
    bushState.active = false;
  }

  // --- Flower interaction -------------------------------------------------
  let onFlower = null;
  if (scenery) {
    for (const flower of scenery.flowers) {
      if (!flower.alive) continue;
      if (flower.position.distanceTo(playerPos2) < FLOWER_TRIGGER_DISTANCE) {
        onFlower = flower;
        break;
      }
    }
  }
  if (onFlower) {
    if (flowerState.flower !== onFlower) {
      flowerState.flower = onFlower;
      flowerState.timer = 0;
    } else {
      flowerState.timer = Math.min(FLOWER_HARVEST_TIME, flowerState.timer + delta);
      if (flowerState.timer >= FLOWER_HARVEST_TIME) {
        // Bloom into a 1.5x power-up, dropped just beside the flower.
        const f = flowerState.flower;
        f.alive = false;
        f.group.visible = false;
        f.regrowTimer = FLOWER_REGROW;
        const spot = findFlowerDropSpot(f.position.x, f.position.y);
        powerUps.spawnAt(spot.x, spot.y, ['speed', 'range', 'freeze', 'shield'], 1.5);
        hud.showAction('The flower drops a 1.5x power-up!', 'flower', '#ff6b9d');
        sound.powerUp();
        flowerState.flower = null;
        flowerState.timer = 0;
      }
    }
  } else if (flowerState.flower) {
    flowerState.flower = null;
    flowerState.timer = 0;
  }

  // Flower and bush regrowth.
  if (scenery) {
    for (const flower of scenery.flowers) {
      if (!flower.alive) {
        flower.regrowTimer -= delta;
        if (flower.regrowTimer <= 0) {
          flower.alive = true;
          flower.group.visible = true;
        }
      }
    }
    for (const bush of scenery.bushes) {
      if (!bush.alive) {
        bush.regrowTimer = (bush.regrowTimer || 0) - delta;
        if (bush.regrowTimer <= 0) {
          bush.alive = true;
          bush.group.visible = true;
          damagedBushes.delete(bush);
        }
      }
    }
  }

  // --- Pond interaction ---------------------------------------------------
  // The pond used to heal unconditionally every frame for anyone standing
  // within 110 units of it, which made the hero unkillable. It now runs a
  // bounded soak: a capped trickle heal, one random bonus, then a long
  // cooldown before it pays out again.
  let nearPond = null;
  let inWater = null;
  if (scenery) {
    for (const pond of scenery.ponds) {
      const d = pond.position.distanceTo(playerPos2);
      if (d < pond.shoreRadius * POND_NEAR_RADIUS_RATIO) nearPond = pond;
      if (d < pond.surfaceRadius * POND_INNER_RADIUS_RATIO) inWater = pond;
    }
  }

  if (inWater) {
    if ((inWater.cooldown || 0) <= 0) {
      if (!pondState.inWater) {
        // Start a fresh soak.
        pondState.inWater = true;
        pondState.pond = inWater;
        pondState.timer = 0;
        pondState.healAccum = 0;
        pondState.bonusFired = false;
      }

      pondState.timer += delta;

      // Trickle heal, capped per soak.
      const cap = health.maxHp * POND_HEAL_CAP_PERCENT;
      if (pondState.healAccum < cap && health.hp < health.maxHp) {
        const amount = Math.min(
          health.maxHp * POND_HEAL_PERCENT * delta,
          cap - pondState.healAccum,
          health.maxHp - health.hp
        );
        if (amount > 0) {
          health.hp = Math.min(health.maxHp, health.hp + amount);
          health.render();
          pondState.healAccum += amount;
        }
      }

      // One random bonus per soak, shortly after wading in.
      if (!pondState.bonusFired && pondState.timer >= POND_BONUS_WADE_TIME) {
        pondState.bonusFired = true;
        triggerPondBonus();
      }

      // End the soak on the cap or on the hard time limit.
      const capped = pondState.healAccum >= cap - 0.01;
      if (capped || pondState.timer >= POND_SOAK_DURATION) {
        const finished = pondState.pond;
        pondState.inWater = false;
        pondState.pond = null;
        pondState.timer = 0;
        pondState.healAccum = 0;
        // Only THIS pond goes on cooldown; the others stay available.
        if (finished) finished.cooldown = POND_COOLDOWN;
      }
    }
  } else if (pondState.inWater) {
    // Left the water mid-soak — burn that pond's cooldown so dipping in and
    // out cannot be used to farm heals.
    const abandoned = pondState.pond;
    pondState.inWater = false;
    pondState.pond = null;
    pondState.timer = 0;
    pondState.healAccum = 0;
    if (abandoned) abandoned.cooldown = POND_COOLDOWN;
  }

  // Each pond's cooldown ticks down independently.
  if (scenery) {
    for (const pond of scenery.ponds) {
      if (pond.cooldown > 0) pond.cooldown = Math.max(0, pond.cooldown - delta);
    }
  }

  // --- Pond-driven slow effect -------------------------------------------
  if (powerUps.pondSlowTimer && powerUps.pondSlowTimer > 0) {
    powerUps.pondSlowTimer -= delta;
  } else {
    powerUps.pondSlowTimer = 0;
  }

  // =======================================================================
  // 2. PROXIMITY HINT
  // =======================================================================
  // One line, always showing the most relevant thing nearby — including live
  // cooldowns, so the player is never left guessing why an interaction refused
  // to fire.
  let hintState = null;

  if (inHouse) {
    const pct = Math.max(0, Math.round((inHouse.hp / inHouse.maxHp) * 100));
    hintState = {
      key: 'house',
      tone: pct > 30 ? 'active' : 'warn',
      text: `Safe inside · ${pct}% durability`,
    };
  }

  if (!hintState && inBush) {
    if (bushState.exposed) {
      hintState = {
        key: 'bush',
        tone: 'danger',
        text: inBush.cooldown > 0
          ? `This bush is spent · ${Math.ceil(inBush.cooldown)}s`
          : 'Spotted!',
      };
    } else {
      hintState = {
        key: 'bush',
        tone: 'active',
        text: `Hidden · ${bushState.timer.toFixed(1)}s left`,
      };
    }
  }

  if (!hintState && inWater) {
    const pondCd = inWater.cooldown || 0;
    hintState = pondCd > 0
      ? {
          key: 'pond',
          tone: 'cooldown',
          text: `This pond is cooling down · ${Math.ceil(pondCd)}s`,
        }
      : {
          key: 'pond',
          tone: 'active',
          text: `In the water: +${Math.round(POND_HEAL_PERCENT * 100)}% HP/s, absorbing ${Math.round(POND_DAMAGE_SOAK * 100)}% of incoming damage`,
        };
  }

  if (!hintState && nearPond) {
    const pondCd = nearPond.cooldown || 0;
    hintState = pondCd > 0
      ? {
          key: 'pond',
          tone: 'cooldown',
          text: `This pond is cooling down · ${Math.ceil(pondCd)}s`,
        }
      : {
          key: 'pond',
          tone: 'ready',
          text: `Wade in: +${Math.round(POND_HEAL_PERCENT * 100)}% HP/s and a random bonus`,
        };
  }

  if (!hintState && onFlower) {
    hintState = flowerState.flower === onFlower
      ? {
          key: 'flower',
          tone: 'active',
          text: `Harvesting · ${Math.max(0, FLOWER_HARVEST_TIME - flowerState.timer).toFixed(1)}s left`,
        }
      : {
          key: 'flower',
          tone: 'ready',
          text: `Stay ${FLOWER_HARVEST_TIME}s to harvest a 1.5x power-up`,
        };
  }

  if (!hintState && scenery) {
    const { tree, distance } = nearestTree(playerPos2, scenery.fruitTrees);
    if (tree && distance < TREE_PROXIMITY_DISTANCE) {
      hintState = tree.cooldown > 0
        ? {
            key: 'tree',
            tone: 'cooldown',
            text: `This tree is recovering · ${Math.ceil(tree.cooldown)}s`,
          }
        : {
            key: 'tree',
            tone: 'ready',
            text: 'Hit a fruit tree with your tongue snap (Space) to knock fruit loose',
          };
    }
  }

  hud.setProximity(hintState);

  // =======================================================================
  // 3. POWER-UPS
  // =======================================================================
  const picked = powerUps.update(delta, player.position, isPowerUpSpotFree);
  for (const type of picked) {
    if (type.key === 'heart') {
      health.addMaxHp(HEART_PICKUP);
      sound.heal();
    } else if (type.key === 'bomb') {
      // Every ordinary insect cleared by the Bomb is a real kill: score,
      // Awakening charge, max-HP growth and a possible gene drop all go
      // through awardKill. A boss survives the blast with its encounter
      // intact, minus a fixed share of max HP; routing a boss death through
      // awardKill keeps the bar, score and bonuses in sync.
      const survivors = [];
      for (const enemy of enemies) {
        if (!enemy.boss) {
          awardKill(enemy);
          continue;
        }
        const killed = enemy.takeTrueDamage(enemy.maxHp * BOMB_BOSS_DAMAGE);
        juice.onHit(enemy.position, true);
        if (killed) {
          awardKill(enemy);
        } else {
          survivors.push(enemy);
        }
      }
      enemies = survivors;
      renderBossBar();
      sound.bomb();
    }
  }

  // =======================================================================
  // 4. ATTACK LIFECYCLE
  // =======================================================================
  attack.update(delta);
  updateCroakUnlock();
  if (croakCooldown > 0) {
    croakCooldown = Math.max(0, croakCooldown - delta);
    renderCroakBar();
  }

  // Every successful fire queues exactly one hit. Watching the visual effect
  // instead used to swallow shots when the cooldown was shorter than the lash.
  if (attack.consumeHit()) {
    // The tongue is already animate; this adds the tip spark and the FOV
    // punch at the moment the damage lands.
    const facing = player.yaw.rotation.z;
    juice.onAttack(player.position, facing, attack.radius);
    const hit = attack.enemiesInRange(enemies);
    if (hit.length > 0) {
      const destroyed = hit.filter((enemy) => {
        // The tongue snap is a direct hit in a 120-degree wedge. Insects
        // outside it still take the croak wave, but at a reduced splash rate;
        // bosses are always treated as direct so positioning behind them is
        // never a trap.
        const direct = isDirectTongueHit(enemy, facing);
        const splash = direct ? 1 : ATTACK_SPLASH_MULT;
        // Bosses take a tempered share of the awakened attack: huge, but not
        // enough to erase the encounter in a couple of blasts.
        const power = enemy.boss
          ? playerStats.attackPower * BOSS_AWAKEN_DAMAGE_MULT
          : playerStats.attackPower * splash;
        // Damage actually dealt (armour + remaining HP both matter).
        const dealt = Math.min(power * (1 - enemy.armor), Math.max(0, enemy.hp));
        const killed = enemy.takeHit(power);
        // A boss that survives is the one impact the player can feel; ordinary
        // insects die too fast for a hit reaction to render.
        if (!killed) juice.onHit(enemy.position, enemy.boss);

        // Mosquito genes return a share of the damage as HP.
        if (playerStats.lifesteal > 0 && dealt > 0) {
          health.heal(dealt * playerStats.lifesteal);
        }
        return killed;
      });

      if (destroyed.length > 0) {
        destroyed.forEach((enemy) => awardKill(enemy));
        enemies = enemies.filter((enemy) => !destroyed.includes(enemy));
        sound.kill();
      }
    }

    // The same blast knocks a fruit off a nearby fruit tree.
    if (scenery) {
      const { tree, distance } = nearestTree(playerPos2, scenery.fruitTrees);
      if (tree && distance < TREE_STRIKE_RANGE) {
        const outcome = scenery.dropFruit(tree);
        if (outcome === 'ok') {
          hud.showAction('Fruit dropped — go grab it!', 'fruit', '#e5484d');
          sound.powerUp();
        } else if (outcome === 'cooldown') {
          hud.showAction(
            `This tree is still recovering · ${Math.ceil(tree.cooldown)}s`,
            'tree',
            '#888780',
            1500
          );
        }
      }
    }
  }

  // =======================================================================
  // 5. FRUITS
  // =======================================================================
  if (scenery) {
    const eaten = scenery.updateFruits(delta, player.position);
    if (eaten > 0) {
      health.addRegen(FRUIT_REGEN_RATE, FRUIT_REGEN_DURATION, 'Fed');
      hud.showAction(
        `Fruit eaten: healing for ${FRUIT_REGEN_DURATION}s`,
        'fruit',
        '#e5484d'
      );
      sound.heal();
    }
  }

  // =======================================================================
  // 5. ENEMY SPAWNING
  // =======================================================================
  // Bosses arrive on a score schedule. While one is alive the ordinary
  // spawner takes a break so the fight stays readable.
  if (bossCooldown > 0) bossCooldown = Math.max(0, bossCooldown - delta);
  if (!boss && bossCooldown <= 0 && score.value >= nextBossScore) {
    spawnBoss();
    nextBossScore += BOSS_SCORE_STEP;
  }

  spawnTimer -= delta;
  if (spawnTimer <= 0) {
    if (!boss && enemies.length < MAX_ENEMIES) {
      spawnEnemy(params.enemySpeed);

      // Past factor 4 the insects stop arriving one at a time: a second (and
      // from factor 8, sometimes a third) joins the same wave, so the board
      // reads as a swarm rather than a queue.
      const extra = params.factor >= 8 ? 2 : params.factor >= 4 ? 1 : 0;
      for (let i = 0; i < extra && enemies.length < MAX_ENEMIES; i++) {
        if (Math.random() < 0.5) spawnEnemy(params.enemySpeed);
      }
    }
    spawnTimer = params.enemySpawnDelay;
  }

  // Boss behaviour: summon waves and read the enrage flag.
  if (boss) {
    if (boss.tickBoss(delta)) {
      for (let i = 0; i < BOSS_SUMMON_COUNT; i++) {
        if (enemies.length >= MAX_ENEMIES) break;
        const minion = spawnEnemy(params.enemySpeed);
        if (minion) {
          // Minions join the fight at once, so they appear on a ring around
          // the boss rather than all on top of it: spawning them at the exact
          // centre left them inside the boss's collision bubble, where the
          // step test refused to let them move.
          const ring = Math.max(boss.radius + minion.radius + ENEMY_HIT_DISTANCE + 20, 150);
          const angle = Math.random() * Math.PI * 2;
          minion.group.position.set(
            boss.group.position.x + Math.cos(angle) * ring,
            boss.group.position.y + Math.sin(angle) * ring,
            0
          );
        }
      }
      hud.showAction('The boss summons its brood!', 'boss', '#ff3d6e', 1500);
    }
    renderBossBar();
    updateBossAbility(delta);
  }

  // =======================================================================
  // 6. ENEMIES (state machine, AI, movement, attacks)
  // =======================================================================
  // Slow factor stacks with the existing freeze power-up.
  const pondSlowFactor = powerUps.pondSlowTimer > 0 ? 0.4 : 1;
  const playerHidden = bushState.active;

  for (const enemy of enemies) {
    enemy.setBaseSpeed(params.enemySpeed * boosts.enemySpeed * pondSlowFactor);
    enemy.animate(delta);

    const current = enemy.position;

    if (enemy.state === 'chasing' && !bushState.active) {
      enemy.rememberPlayerPosition(playerPos2.x, playerPos2.y);
    }

    enemy.updateBehavior(delta);

    // A croak stun is a hard stop: keep the hit reaction and wing flap, but
    // skip target picking and movement so the shove does not slide back in
    // the same frame.
    if (enemy.stunTimer > 0) {
      enemy.stunTimer = Math.max(0, enemy.stunTimer - delta);
      continue;
    }

    // -- Pick a target ----------------------------------------------------
    let target = null;
    let isHouseAttack = false;
    let isBushAttack = false;

    // Distances are computed by hand: `current` is a Vector3 and the props
    // below are Vector2, and Vector3.distanceTo(Vector2) yields NaN because
    // the prop has no `z`.
    const distanceTo = (p) => Math.hypot(current.x - p.x, current.y - p.y);

    // When the hero is hidden in a bush, chasing insects lose his trail and
    // wander aimlessly instead of homing on his last position.
    if (playerHidden) {
      enemy.wanderTimer -= delta;
      if (enemy.wanderTimer <= 0) enemy.pickWander(current.x, current.y);
      target = { x: enemy.wanderTarget.x, y: enemy.wanderTarget.y };
    }

    // 1. House whacking — only when the hero is actually sheltering inside
    //    that house. Insects used to chew through any house they happened to
    //    pass, which made the roof health bars meaningless.
    if (enemy.state === 'chasing' && inHouse) {
      for (const house of houses) {
        if (!house.alive || house !== inHouse) continue;
        if (distanceTo(house.position) < HOUSE_ATTACK_RANGE) {
          target = house.position;
          isHouseAttack = true;
          if (house.mayBeHit(delta)) {
            const destroyed = house.takeDamage();
            house.registerHit();
            sound.houseHit();
            if (destroyed) {
              hud.showAction('A house was destroyed!', 'house', '#e5484d', 2500);
              // The ruin is gone from the scene; drop it from the enemy
              // collision list so insects stop pathing around a hole.
              enemyObstacles = enemyObstacles.filter((o) => o !== house);
            }
          }
          break;
        }
      }
    }

    // 2. Bush whacking: a *discovered* hero hiding in a bush.
    if (!isHouseAttack && enemy.state === 'chasing' && bushState.exposed && bushState.bush && bushState.bush.alive) {
      if (distanceTo(bushState.bush.position) < BUSH_ATTACK_RANGE) {
        target = bushState.bush.position;
        isBushAttack = true;
        if (!damagedBushes.has(bushState.bush)) {
          // One hit clears the bush.
          damagedBushes.add(bushState.bush);
          bushState.bush.alive = false;
          bushState.bush.group.visible = false;
          bushState.bush.regrowTimer = 25; // bushes take longer to regrow than flowers
          hud.showAction('A bush was torn apart!', 'bush', '#ff6b6b');
          sound.hurt();
        }
      }
    }

    // 3. Default: chase player, or fly away when disengaged.
    if (!target) {
      if (enemy.state === 'disengaged') {
        // Pick a point along the disengage direction well off-screen.
        _target.set(
          current.x + enemy.disengageDirection.x * 500,
          current.y + enemy.disengageDirection.y * 500
        );
        clampToBoard(_target, 60);
        target = _target;
      } else {
        target = { x: enemy.lastSeenX, y: enemy.lastSeenY };
      }
    }

    // -- Move towards target ---------------------------------------------
    _dir.set(target.x - current.x, target.y - current.y);
    if (_dir.lengthSq() < 1e-6) continue;
    _dir.normalize();

    enemy.group.rotation.z = Math.atan2(_dir.y, _dir.x);

    const step = enemy.speed * delta;
    const dx = _dir.x * step;
    const dy = _dir.y * step;

    const candidates = [[dx, dy], [dx, 0], [0, dy], [dy, -dx], [-dy, dx]];
    let moved = false;
    for (const [moveX, moveY] of candidates) {
      if (moveX === 0 && moveY === 0) continue;
      if (canEnemyStep(current.x + moveX, current.y + moveY, enemy)) {
        current.x += moveX;
        current.y += moveY;
        moved = true;
        break;
      }
    }
    if (!moved) unstickEnemy(enemy, delta);
    // A successful step means the insect is out of whatever it was caught on,
    // so the slide commitment and the stuck clock both reset.
    else {
      enemy.stuckTimer = 0;
    }

    clampToBoard(current, enemy.type.radius * 0.5);
  }

  // Remove insects that have finished their disengage animation.
  enemies = enemies.filter((enemy) => {
    if (enemy.readyToRemove) {
      enemy.dispose();
      // If whatever just left the board was the boss, the reference has to go
      // with it. A dangling pointer kept the bar on screen, kept the ordinary
      // spawner paused behind `if (!boss)`, and made the next boss threshold
      // unreachable for the rest of the run.
      if (boss === enemy) {
        boss = null;
        renderBossBar();
        bossBar.style.display = 'none';
      }
      return false;
    }
    return true;
  });

  // =======================================================================
  // 7. SCORE / FLOWER GROWTH
  // =======================================================================
  const scoreBefore = score.value;
  score.addSurvivalPoints(delta);
  // Survival points charge the awakening bar too, so a passive run still builds.
  if (awakening.addScore(score.value - scoreBefore)) {
    hud.showAction('Awakening charged — press E', 'awaken', '#7c5cff', 1600);
  }

  const milestone = Math.floor(score.value / 200);
  if (milestone > lastFlowerMilestone) {
    lastFlowerMilestone = milestone;
    if (scenery) {
      const grown = scenery.growFlowers();
      if (grown.length > 0) {
        hud.showAction('A new flower has bloomed!', 'flower', '#ff6b9d');
      }
    }
  }

  // =======================================================================
  // 8. DAMAGE
  // =======================================================================
  health.update(delta);

  const safe =
    boosts.shielded ||
    health.shielded ||
    inHouse ||
    bushState.active;

  // --- Contact damage ------------------------------------------------------
  const attacker = safe ? null : enemyTouchingPlayer();
  if (attacker && health.invulnerable <= 0) {
    // A mid-charge body-check already landed its own hit this cast; the
    // ordinary contact tick would double-dip on the same collision.
    const charging = attacker.boss && attacker.abilityPhase === 'dash';
    if (!charging) {
      // The full reduction chain (pond soak, damage reduction, awakening,
      // shield) lives in `hurtHero` so every hazard is mitigated the same way.
      hurtHero(attacker.contactDamage || HIT_DAMAGE);
    }
  }

  // Vemon puddles, burrow warnings and the death of a boss all need ageing
  // even on frames where nothing else happens.
  updateVenom(delta);

  if (player.model) {
    const blinking = health.shielded && Math.floor(health.invulnerable * 12) % 2 === 1;
    player.model.visible = !blinking;
  }

  if (health.dead) {
    showGameOver();
  }

  // =======================================================================
  // 9. HOUSE VISUAL UPKEEP
  // =======================================================================
  for (const house of houses) house.update(delta);

  // =======================================================================
  // 10. FINAL SAFETY NET
  // =======================================================================
  clampToBoard(player.group.position, player.radius);

  renderer.render(scene, camera);
}

/**
 * Applies one damage packet to the hero through the full pipeline.
 *
 * Contact damage used to be the only source, so the reduction chain lived
 * inline in the contact branch. Boss abilities are separate sources, and
 * copying that chain into each one would guarantee they drift apart — the
 * venom would ignore the shield, the charge would skip the awakening, and
 * so on. Everything that hurts the hero now goes through here.
 *
 * @param {number} raw Incoming damage before any mitigation.
 * @param {{ignoreInvulnerability?: boolean}} [options]
 * @returns {number} Damage actually taken after shields and reduction.
 */
function hurtHero(raw, options = {}) {
  if (health.dead) return 0;
  if (!options.ignoreInvulnerability && health.invulnerable > 0) return 0;

  let damage = raw;
  // `inWater` and `awaken` are locals of the animation loop; the module-level
  // equivalents are what a helper outside the loop can read.
  if (pondState.inWater) damage *= 1 - POND_DAMAGE_SOAK;
  damage *= 1 - Math.min(MAX_TOTAL_DAMAGE_REDUCTION, playerStats.damageReduction);
  damage *= awakening.multipliers().damageTaken;

  if (playerStats.shield > 0) {
    const absorbed = Math.min(playerStats.shield, damage);
    playerStats.shield -= absorbed;
    damage -= absorbed;
    // Any shield contact restarts the regeneration clock, even a hit it ate
    // whole: the point of the delay is "stop being hit", not "lose HP".
    playerStats.shieldIdle = 0;
  }

  if (damage > 0.01) {
    health.takeHit(damage);
    juice.onHurt(damage);
    sound.hurt();
    // Taking real damage counts as being in combat even when the shield was
    // already empty, otherwise the bar would rebuild mid-fight.
    playerStats.shieldIdle = 0;
    return damage;
  }

  // The shield ate the whole packet. Start the mercy window anyway so a
  // lingering hazard is not drained once per frame.
  health.invulnerable = Math.max(health.invulnerable, HIT_INVULNERABILITY * 0.5);
  return 0;
}

/**
 * Advances the live boss's signature ability.
 *
 * Each giant owns a move set no ordinary insect has. They share one phase
 * machine (`windup → resolve → cooldown`) but resolve differently, so the
 * three bosses ask for three different answers: sidestep the stag beetle's
 * charge, keep moving out of the centipede's venom, and clear the mole's
 * burrow marker before it surfaces.
 *
 * @param {number} delta Seconds since the previous frame.
 */
function updateBossAbility(delta) {
  if (!boss || !boss.abilityKey) return;

  const ability = boss.ability;

  // ---- Not casting: count down, then start the next one ----------------
  if (boss.abilityPhase === 'idle') {
    boss.abilityTimer -= delta;
    if (boss.abilityTimer > 0) return;

    boss.abilityPhase = 'windup';
    boss.abilityPhaseTimer = ability.windup || 0.6;
    boss.abilityActive = true;
    boss.setAuraIntensity(3);
    sound.awaken();

    if (boss.abilityKey === 'charge') {
      // Lock the dash direction at telegraph time. Following the hero *during*
      // the wind-up would make the move unavoidable, which defeats the point.
      const dx = player.position.x - boss.position.x;
      const dy = player.position.y - boss.position.y;
      const len = Math.hypot(dx, dy) || 1;
      boss.chargeDir = new THREE.Vector2(dx / len, dy / len);
      hud.showAction('The giant winds up a charge — move!', 'boss', ability.color, 1200);
    } else if (boss.abilityKey === 'venom') {
      hud.showAction('Venom spray!', 'boss', ability.color, 1200);
    } else if (boss.abilityKey === 'burrow') {
      // The mole dives immediately: the danger zone locks onto wherever the
      // hero is standing right now, so standing still is what kills you.
      boss.danger = {
        x: player.position.x,
        y: player.position.y,
        radius: ability.dangerRadius,
      };
      boss.visual.visible = false;
      if (boss.shadow) boss.shadow.visible = false;
      startedBurrowMarker();
      hud.showAction('The ground shakes — get clear!', 'boss', ability.color, 1400);
    }
    return;
  }

  // ---- Resolve the phase ------------------------------------------------
  boss.abilityPhaseTimer -= delta;

  if (boss.abilityKey === 'charge') {
    if (boss.abilityPhase === 'windup') {
      if (boss.abilityPhaseTimer > 0) return;
      boss.abilityPhase = 'dash';
      boss.abilityPhaseTimer = ability.duration;
      boss.chargeHit = false;
      boss.chargeTravelled = 0;
    }

    // Drive the body along the locked vector.
    //
    // The dash advances by a fraction of `distance` per frame, not by
    // "speed x delta". Frame-time scaling made the same move land at wildly
    // different ranges depending on the machine — a headless run covered
    // 126 units where a smooth 60fps run covered 500 — which made the move
    // feel random. Counting frames keeps the reach constant.
    const travelled = boss.chargeTravelled || 0;
    const legStep = ability.distance / Math.max(1, ability.dashFrames);
    const probe = new THREE.Vector3(
      boss.position.x + boss.chargeDir.x * legStep,
      boss.position.y + boss.chargeDir.y * legStep,
      0
    );
    boss.chargeTravelled = travelled + legStep;
    if (collidesWithObstacle(probe, enemyObstacles, boss.radius * 0.6)) {
      // Slammed into a tree or a wall: the charge ends early.
      boss.abilityPhaseTimer = 0;
      hud.showAction('The charge slams into an obstacle!', 'boss', '#ffd166', 1200);
    } else {
      boss.group.position.x = probe.x;
      boss.group.position.y = probe.y;
      clampToBoard(boss.position, boss.radius * 0.5);
      if (!boss.chargeHit) {
        const reach = boss.radius + player.radius;
        if (
          !safeFromHazards() &&
          Math.hypot(
            boss.position.x - player.position.x,
            boss.position.y - player.position.y
          ) < reach
        ) {
          boss.chargeHit = true;
          hurtHero(boss.contactDamage * ability.damageMult, {
            ignoreInvulnerability: true,
          });
          hud.showAction('The charge connects!', 'boss', ability.color, 900);
        }
      }
    }
    if (boss.abilityPhaseTimer <= 0) finishBossAbility();
    return;
  }

  if (boss.abilityKey === 'venom') {
    if (boss.abilityPhaseTimer > 0) return;

    // Scatter pools in a fan ahead of the boss.
    const baseAngle = Math.atan2(
      player.position.y - boss.position.y,
      player.position.x - boss.position.x
    );
    for (let i = 0; i < ability.pools; i++) {
      const spread = (i - (ability.pools - 1) / 2) * 0.5;
      const distance = 130 + i * 55;
      const px = boss.position.x + Math.cos(baseAngle + spread) * distance;
      const py = boss.position.y + Math.sin(baseAngle + spread) * distance;
      venomPools.push({
        x: px,
        y: py,
        radius: ability.poolRadius,
        life: ability.life,
        tickTimer: 0,
        // Each puddle carries its own numbers. Reading them off the live boss
        // meant a puddle went inert the moment the boss died — and puddles
        // outlive their caster by several seconds.
        tickDamage: ability.tickDamage,
        tickInterval: ability.tickInterval,
        poisonDamage: ability.poisonDamage,
        poisonInterval: ability.poisonInterval,
        poisonDuration: ability.poisonDuration,
        mesh: makeVenomPatch(px, py, ability.poolRadius),
      });
    }
    finishBossAbility();
    return;
  }

  if (boss.abilityKey === 'burrow') {
    if (boss.abilityPhaseTimer > 0) return;

    // Surface. Anyone still inside the marker takes the burst.
    boss.visual.visible = true;
    if (boss.shadow) boss.shadow.visible = true;
    boss.group.position.set(boss.danger.x, boss.danger.y, 0);
    const inside =
      !safeFromHazards() &&
      Math.hypot(
        player.position.x - boss.danger.x,
        player.position.y - boss.danger.y
      ) < boss.danger.radius + player.radius;

    clearBurrowMarker();
    boss.danger = null;

    if (inside) {
      hurtHero(ability.burstDamage, { ignoreInvulnerability: true });
      hud.showAction('The giant surfaces beneath you!', 'boss', ability.color, 1400);
    } else {
      hud.showAction('The giant bursts out of the ground!', 'boss', ability.color, 1200);
    }
    finishBossAbility();
  }
}

/** Returns the boss to its cooldown state after a cast resolves. */
function finishBossAbility() {
  if (!boss) return;
  boss.abilityPhase = 'idle';
  boss.abilityActive = false;
  boss.abilityTimer = boss.abilityCooldown;
  boss.setAuraIntensity(boss.enraged ? 2 : 1);
}

/**
 * Builds the translucent ground ring that marks a mole's burrow target.
 *
 * @param {number} x World X.
 * @param {number} y World Y.
 * @param {number} radius Ring radius in world units.
 * @returns {THREE.Mesh}
 */
function makeDangerMarker(x, y, radius) {
  const marker = new THREE.Mesh(
    new THREE.RingGeometry(radius * 0.85, radius, 48),
    new THREE.MeshBasicMaterial({
      color: 0xc98cff,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  marker.position.set(x, y, 2.5);
  scene.add(marker);
  return marker;
}

/** Adds the burrow warning ring to the scene. */
function startedBurrowMarker() {
  clearBurrowMarker();
  if (!boss || !boss.danger) return;
  burrowMarker = makeDangerMarker(boss.danger.x, boss.danger.y, boss.danger.radius);
}

/** Removes the burrow warning ring, if one exists. */
function clearBurrowMarker() {
  if (!burrowMarker) return;
  scene.remove(burrowMarker);
  burrowMarker.geometry.dispose();
  burrowMarker.material.dispose();
  burrowMarker = null;
}

/**
 * Builds a venom puddle on the ground.
 *
 * @param {number} x World X.
 * @param {number} y World Y.
 * @param {number} radius Puddle radius in world units.
 * @returns {THREE.Mesh}
 */
function makeVenomPatch(x, y, radius) {
  const patch = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 32),
    new THREE.MeshBasicMaterial({
      color: 0x6bdc4a,
      transparent: true,
      opacity: 0.42,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  patch.position.set(x, y, 2);
  scene.add(patch);
  return patch;
}

/**
 * Ages the venom puddles and applies their damage to a standing hero.
 *
 * Venom is a damage-over-time zone, not an instant hit: a single packet per
 * puddle would just be contact damage with extra steps. The poison also
 * lingers for a few seconds after the hero escapes, which is what makes
 * standing in it a real mistake instead of a scratch.
 *
 * @param {number} delta Seconds since the previous frame.
 */
function updateVenom(delta) {
  const defaults = BOSS_ABILITIES.centipede;

  for (let i = venomPools.length - 1; i >= 0; i--) {
    const pool = venomPools[i];
    pool.life -= delta;

    // Fade out over the last second so the puddle visibly expires.
    if (pool.life < 1) {
      pool.mesh.material.opacity = 0.42 * Math.max(0, pool.life);
    }

    if (pool.life <= 0) {
      scene.remove(pool.mesh);
      pool.mesh.geometry.dispose();
      pool.mesh.material.dispose();
      venomPools.splice(i, 1);
      continue;
    }

    const inside =
      Math.hypot(player.position.x - pool.x, player.position.y - pool.y) < pool.radius;
    if (inside && !safeFromHazards()) {
      pool.tickTimer -= delta;
      if (pool.tickTimer <= 0) {
        pool.tickTimer = pool.tickInterval || defaults.tickInterval;
        hurtHero(pool.tickDamage || defaults.tickDamage);
        poison.stacks = Math.min(VENOM_STACK_LIMIT, poison.stacks + 1);
        poison.timer = pool.poisonDuration || defaults.poisonDuration;
        poison.tick = pool.poisonInterval || defaults.poisonInterval;
        // Latch the numbers onto the poison state itself, so lingering ticks
        // keep working after the puddle (and its caster) are gone.
        poison.damage = pool.poisonDamage || defaults.poisonDamage;
        poison.interval = pool.poisonInterval || defaults.poisonInterval;
      }
    }
  }

  // Lingering poison keeps ticking after the hero leaves the puddle.
  if (poison.timer > 0) {
    poison.timer -= delta;
    poison.tick -= delta;
    if (poison.tick <= 0) {
      poison.tick = poison.interval || defaults.poisonInterval;
      hurtHero((poison.damage || defaults.poisonDamage) * poison.stacks);
    }
    if (poison.timer <= 0) {
      poison.stacks = 0;
      poison.timer = 0;
    }
  }
}

/**
 * True while the hero is somewhere the boss's ground hazards cannot reach.
 *
 * Uses the module-level power-up state rather than the animation loop's
 * `boosts` local — helpers defined outside the loop cannot see its locals.
 *
 * @returns {boolean}
 */
function safeFromHazards() {
  return (
    powerUps.multipliers.shielded ||
    health.shielded ||
    currentHouse ||
    bushState.active
  );
}

spawnEnemy();
// This avoids the old "procedural frog, then sudden swap" pop at the start.
const loadingScreen = document.createElement('div');
loadingScreen.className = 'loading-screen';
loadingScreen.textContent = 'Loading…';
document.body.appendChild(loadingScreen);

player.ready.then(() => {
  loadingScreen.remove();
  renderer.setAnimationLoop(gameLoop);
});

// ---------------------------------------------------------------------------
// Debug hook for automated testing. Exposes the live world state so a headless
// browser can assert on it without reaching into module scope. Not used by the
// game itself.
// ---------------------------------------------------------------------------
window.__hud = {
  get houses() { return houses; },
  get trees() { return scenery ? scenery.trees : []; },
  get fruitTrees() { return scenery ? scenery.fruitTrees : []; },
  get fruits() { return scenery ? scenery.fruits : []; },
  get bushes() { return scenery ? scenery.bushes : []; },
  get flowers() { return scenery ? scenery.flowers : []; },
  get ponds() { return scenery ? scenery.ponds : []; },
  get enemies() { return enemies; },
  get pickups() { return powerUps.pickups; },
  get powerUps() { return powerUps; },
  get scene() { return scene; },
  get score() { return score; },
  get health() { return health; },
  get playerStats() { return playerStats; },
  get player() { return player; },
  get attack() { return attack; },
  get genes() { return genes; },
  get talents() { return talents; },
  get awakening() { return awakening; },
  get croakCooldown() { return croakCooldown; },
  get croakUnlocked() { return croakUnlocked; },
  /** Fires Croak without the keyboard. Only for arranging a test. */
  fireCroak() {
    return triggerCroak();
  },

  /** Clears Croak's cooldown. Only for arranging a test. */
  resetCroakCooldown() {
    croakCooldown = 0;
    renderCroakBar();
  },
  get boss() { return boss; },
  get bossBonus() { return bossBonus; },
  get nextBossScore() { return nextBossScore; },
  get bossesSpawned() { return bossesSpawned; },
  get bossesKilled() { return bossesKilled; },
  get bossCooldown() { return bossCooldown; },
  get runTime() { return runTime; },
  /** Pure boss-stat derivation, shared with the constructor. For tests. */
  bossProfile,

  /** Ability cooldown for a given species and boss number. For tests. */
  bossAbilityCooldown,

  /** Spawns a boss right now. Only for arranging a test. */
  forceBoss(species = 'beetle') {
    const angle = Math.random() * Math.PI * 2;
    const point = new THREE.Vector2(
      player.position.x + Math.cos(angle) * 500,
      player.position.y + Math.sin(angle) * 500
    );
    clampToBoard(point, 120);
    const enemy = new Enemy(scene, point, species, false, {
      boss: true,
      bossIndex: bossesSpawned,
      heroAttack: playerStats.attackPower,
    });
    enemies.push(enemy);
    boss = enemy;
    bossesSpawned += 1;
    bossBar.style.display = 'block';
    renderBossBar();
    return enemy;
  },

  /** Fires the live boss's signature ability immediately. For tests. */
  triggerBossAbility() {
    if (!boss) return null;
    boss.abilityTimer = 0;
    return boss.abilityKey;
  },

  /**
   * Brings the hero back after a death, without reloading the page.
   *
   * A test that damages the hero often wants to keep measuring afterwards;
   * reloading loses the whole arranged world, so this restores just enough
   * state for the loop to keep running.
   */
  revive() {
    // `dead` is derived from `hp`, so restoring the pool is the whole job.
    health.hp = health.maxHp;
    health.invulnerable = 0;
    gameState = 'playing';
    if (gameOverOverlay) gameOverOverlay.style.display = 'none';
    return health.hp;
  },

  /** Live venom puddles, so a test can count them. */
  get venomPools() {
    return venomPools;
  },

  /** Lingering poison state on the hero. */
  poison,

  /** Applies one damage packet through the full mitigation pipeline. */
  hurtHero,

  /**
   * Puts the live boss into its enraged state without waiting for the bar
   * to drain.
   */
  forceEnrage() {
    if (!boss) return false;
    boss.hp = Math.min(boss.hp, boss.maxHp * boss.enrageThreshold);
    return boss.enraged;
  },

  /** Closes the boss bar without killing anything. Only for arranging a test. */
  /**
   * Removes the boss without paying a reward.
   *
   * @param {boolean} [rewind] Put the boss counter back, so the next spawn
   *   is the same number boss again. Tests that compare "first boss" against
   *   "second boss" need this, otherwise every scenario silently walks the
   *   difficulty ramp forward.
   */
  clearBoss(rewind = false) {
    if (boss) boss.dispose();
    boss = null;
    enemies = enemies.filter((enemy) => !enemy.boss);
    if (rewind) {
      bossesSpawned = Math.max(0, bossesSpawned - 1);
      nextBossScore = Math.max(FIRST_BOSS_SCORE, nextBossScore - BOSS_SCORE_STEP);
    }
    renderBossBar();
    bossBar.style.display = 'none';
  },
  get paused() { return paused; },
  get scenery() { return scenery; },

  /**
   * Spawns a gene orb at a point. Only for arranging a test.
   *
   * @param {string} key Species key.
   * @param {string} tier Quality tier.
   * @param {number} x World X.
   * @param {number} y World Y.
   */
  spawnGene(key, tier, x, y) {
    return genes.spawnOrb(key, tier, x, y);
  },

  /** Clears every gene and unpauses. Only for arranging a test. */
  clearGenes() {
    genes.reset(3);
    geneCard.style.display = 'none';
    paused = false;
    renderGeneBar();
  },

  /** Forces the next talent offer to appear. Only for arranging a test. */
  primeTalentOffer() {
    talents.primeOffer();
  },

  /** Opens the talent draft immediately. Only for arranging a test. */
  openTalentOffer() {
    showTalentOffer();
    return talentCard.style.display !== 'none';
  },

  /**
   * Fills the awakening bar for a test.
   *
   * @param {number} [charges] Charges to bank.
   */
  chargeAwakening(charges = 1) {
    awakening.charges = charges;
    awakening.scoreProgress = 0;
    renderAwakenBar();
  },

  /**
   * Applies a talent by key without opening the card. Only for arranging a test.
   *
   * @param {string} key A key into TALENTS.
   * @returns {string[]} The talents owned afterwards.
   */
  /** Opens the pause overlay. For tests that need its markup. */
  openPause() {
    openPauseMenu();
    return pauseMenuOpen;
  },

  /** Closes the pause overlay if it is open. */
  closePause() {
    if (pauseMenuOpen) closePauseMenu();
    return pauseMenuOpen;
  },

  /** Opens the character panel. For tests that need its markup. */
  openChar() {
    openCharPanel();
    return charPanelOpen;
  },

  /** Closes the character panel if it is open. */
  closeChar() {
    if (charPanelOpen) closeCharPanel();
    return charPanelOpen;
  },

  grantTalent(key) {
    const talent = TALENTS.find((entry) => entry.key === key);
    if (!talent) return talents.owned.map((entry) => entry.key);
    if (!talents.ownedEntry(key) && !talents.full) {
      talents.owned.push(talent);
    }
    // A debug hook that can overfill the build would let a bug hide behind it,
    // so the slot ceiling is enforced here too.
    genes.setSlotCount(3 + talents.stats().extraGeneSlot);
    renderGeneBar();
    renderTalentPips();
    return talents.owned.map((entry) => `${entry.key}:${talents.levelOf(entry)}`);
  },

  /**
   * Pushes the hero to a level without touching HP. For arranging a test.
   *
   * Sets the pool directly rather than growing it: `growMaxHp` ignores
   * negative amounts, so it could climb the curve but never come back down,
   * and a test that walks levels needs both directions.
   *
   * @param {number} level Target hero level.
   * @returns {number} The level afterwards.
   */
  setHeroLevel(level) {
    const target = Math.max(1, Math.min(15, Math.round(level)));
    health.maxHp = target * 100;
    health.hp = health.maxHp;
    health.render();
    talents.syncHeroLevel(health.level);
    renderTalentPips();
    return health.level;
  },

  /** Re-renders the character panel. For tests that inspect its markup. */
  renderCharPanel,

  /** The live character panel markup. For tests. */
  get charPanelHtml() {
    return charPanel.innerHTML;
  },

  /** The live pause panel markup. For tests. */
  get pausePanelHtml() {
    return pauseMenu.innerHTML;
  },

  /** The controls strip in the bottom-right corner. For tests. */
  get hintHtml() {
    return hint.innerHTML;
  },

  /** Live talent effect for one owned talent, as the panel reports it. */
  talentEffectAt(key) {
    const entry = talents.ownedEntry(key);
    if (!entry) return null;
    const level = talents.levelOf(entry);
    return {
      level,
      max: talentMaxLevel(entry),
      effect: talentEffectAt(entry, level),
      text: formatTalentEffect(talentEffectAt(entry, level)),
    };
  },

  /** Current talent rank for a hero level. For tests and the panel. */
  talentLevelFor(heroLevel) {
    return talentLevelFor(heroLevel);
  },

  /**
   * Spawns a specific insect at a point. Only for arranging a test.
   *
   * @param {string} typeKey A key into ENEMY_TYPES.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @returns {import('./components/Enemy.js').Enemy}
   */
  spawnEnemy(typeKey, x, y) {
    const enemy = new Enemy(scene, new THREE.Vector2(x, y), typeKey);
    enemies.push(enemy);
    return enemy;
  },
  get player() { return player; },
  get obstacles() { return obstacles; },
  get houseAttackRange() { return HOUSE_ATTACK_RANGE; },

  /**
   * Move the hero instantly. Only for arranging a test — never use this to
   * answer "can he reach it", because it skips collision entirely.
   */
  teleport(x, y) {
    player.group.position.set(x, y, 0);
    player.stop();
  },

  /**
   * Walk towards a point through the real hop pipeline: collision, hop
   * trimming and board clamping all apply. This is the honest way to test
   * whether the hero can actually get somewhere.
   *
   * @returns {Promise<boolean>} True if he arrived within `tolerance`.
   */
  async walkToward(tx, ty, maxHops = 40, tolerance = 20) {
    for (let i = 0; i < maxHops; i++) {
      const dx = tx - player.position.x;
      const dy = ty - player.position.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= tolerance) return true;
      player.inputQueue.push(new THREE.Vector2(dx / dist, dy / dist));
      await new Promise((resolve) => setTimeout(resolve, 340));
    }
    return Math.hypot(tx - player.position.x, ty - player.position.y) <= tolerance;
  },

  get playerPos2() { return { x: player.position.x, y: player.position.y }; },

  state: {
    get inHouse() { return currentHouse; },
    get bushState() { return bushState; },
    get flowerState() { return flowerState; },
    get pondState() { return pondState; },
  },
};

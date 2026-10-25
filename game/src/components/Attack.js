import * as THREE from 'three';
import { sound } from './Sound.js';

// ---------------------------------------------------------------------------
// Attack tuning constants
// ---------------------------------------------------------------------------
/** Seconds the player must wait between attacks. */
export const ATTACK_COOLDOWN = 1;
/** How far the attack reaches, in world units. */
export const ATTACK_RADIUS = 120;
/** How long the tongue lash stays on screen, in seconds. */
export const ATTACK_VISUAL_DURATION = 0.3;

/** Geometry is authored at this length; the live radius scales it. */
const BASE_LENGTH = ATTACK_RADIUS;
/**
 * Longest the tongue is drawn, even when the damage radius is far larger.
 * Late-game range can reach 1600 units; drawing that full length put a huge
 * slab across the frog and the screen. The shockwave ring still shows the
 * real damage radius, so the lash is only the visual snap.
 */
const TONGUE_VISUAL_MAX = 240;
/** Thickness where the tongue leaves the mouth. */
const TONGUE_ROOT_RADIUS = 2.8;
/** Thickness at the tip, before the rounded end. */
const TONGUE_TIP_RADIUS = 1.4;
/** The tongue is a flat blade: wider than it is thick. */
const TONGUE_FLAT_Y = 2.1;
const TONGUE_FLAT_Z = 0.62;
/** Radius of the rounded tip. */
const TONGUE_TIP_BULB = 2.0;
/**
 * Height the tip should meet. The mouth sits low on the frog while the
 * insects hover at 38; aiming the straight tongue at this height keeps it
 * from passing under the swarm without bending the tongue.
 */
const TONGUE_TARGET_Z = 38;

/** Fast start, soft finish. */
function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

/** Slow start, fast finish. */
function easeInCubic(t) {
  return t * t * t;
}

/**
 * Builds one ring made of separated arc segments.
 *
 * A continuous hairline circle was technically correct but read as a HUD
 * overlay rather than a croak travelling through the ground. Gaps between
 * arcs give the eye something to follow as the ring expands, and a second
 * ring lets the wave keep a readable front at late-game radii.
 *
 * @param {object} options
 * @param {number} options.color Line colour.
 * @param {number} options.arcs Number of arcs around the circle.
 * @param {number} options.span Fraction of each arc slot that is drawn.
 * @param {number} options.segments Subdivisions per arc.
 * @param {number} options.opacity Base opacity.
 * @returns {{mesh: THREE.LineSegments, baseOpacity: number}}
 */
function buildArcRing({ color, arcs, span, segments, opacity }) {
  const points = [];
  for (let arc = 0; arc < arcs; arc += 1) {
    const start = (arc / arcs) * Math.PI * 2;
    const length = (Math.PI * 2 / arcs) * span;
    for (let i = 0; i < segments; i += 1) {
      const a0 = start + (i / segments) * length;
      const a1 = start + ((i + 1) / segments) * length;
      points.push(
        new THREE.Vector3(Math.cos(a0), Math.sin(a0), 0),
        new THREE.Vector3(Math.cos(a1), Math.sin(a1), 0)
      );
    }
  }

  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  return { mesh: new THREE.LineSegments(geometry, material), baseOpacity: opacity };
}

/**
 * Short radial ticks around the outside of a wave, like the edge of a sound
 * ripple. They make the ring read as force moving outward, not a target UI.
 */
function buildRadialTicks(color, count = 12, opacity = 0.4) {
  const points = [];
  for (let i = 0; i < count; i += 1) {
    const a = (i / count) * Math.PI * 2;
    points.push(
      new THREE.Vector3(Math.cos(a) * 0.9, Math.sin(a) * 0.9, 0),
      new THREE.Vector3(Math.cos(a), Math.sin(a), 0)
    );
  }
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  return { mesh: new THREE.LineSegments(geometry, material), baseOpacity: opacity };
}

/**
 * A single open arc, used to show the 120-degree direct-hit wedge in front of
 * Tode. It is gold while the shockwave itself stays mint, so the player can
 * separate "hit hard here" from "pushed everywhere".
 */
function buildFrontArc(color, opacity = 0.8) {
  const points = [];
  const segments = 20;
  for (let i = 0; i <= segments; i += 1) {
    const angle = -Math.PI / 3 + (i / segments) * (Math.PI * 2 / 3);
    points.push(new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0));
  }
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  return { mesh: new THREE.Line(geometry, material), baseOpacity: opacity };
}

/**
 * Implements the player's area-of-effect tongue attack.
 *
 * The tongue is the aimed trigger, not the whole area. A segmented croak wave
 * expands from Tode and is what actually catches the surrounding insects; the
 * front arc tells the player which side takes direct damage.
 */
export class Attack {
  /**
   * @param {THREE.Scene} scene The scene to attach the effects to.
   * @param {import('./Player.js').Player} player The attacking player.
   */
  constructor(scene, player) {
    this.scene = scene;
    this.player = player;

    this.cooldown = 0;
    this.cooldownDuration = ATTACK_COOLDOWN;
    this.radius = ATTACK_RADIUS;
    this.enabled = true;

    // Seconds the lash has been visible for.
    this.visualTimer = 0;

    // True while Space is held down. Driving auto-fire from the game loop
    // (rather than relying on OS key-repeat) means holding Space keeps firing
    // even while movement keys are pressed.
    this.spaceHeld = false;

    // Set by every successful shot and consumed by the main loop, so a hit is
    // never lost when one visual overlaps the next.
    this.pendingHit = false;

    this.buildTongue();
    this.bindInput();
  }

  /**
   * Builds a flat, tapered blade with a rounded tip.
   *
   * A cylinder on its own reads as a spike, especially with a flat cap at the
   * mouth. Flattening the cross-section, rounding the end and hiding the root
   * just inside the head makes the silhouette read as a tongue instead.
   */
  buildTongue() {
    const geometry = new THREE.CylinderGeometry(
      TONGUE_TIP_RADIUS,
      TONGUE_ROOT_RADIUS,
      BASE_LENGTH,
      18,
      1,
      false
    );
    // Cylinder is authored along +Y with its root at -Y. Lay it along +X and
    // move the root to the group origin, so scaling X extends from the mouth.
    geometry.rotateZ(-Math.PI / 2);
    geometry.translate(BASE_LENGTH / 2, 0, 0);
    // Wide and flat, like a tongue, instead of a round cone.
    geometry.scale(1, TONGUE_FLAT_Y, TONGUE_FLAT_Z);

    const material = new THREE.MeshStandardMaterial({
      color: 0xff5577,
      roughness: 0.38,
      metalness: 0,
      emissive: 0x4a0714,
      emissiveIntensity: 0.35,
    });

    this.tongue = new THREE.Group();
    this.tongue.visible = false;

    // Pitch is a child so the root stays at the mouth while the tip rises.
    this.tonguePitch = new THREE.Group();
    this.tongue.add(this.tonguePitch);

    this.tongueTube = new THREE.Mesh(geometry, material);
    this.tonguePitch.add(this.tongueTube);

    // A flattened sphere rounds off the end; it also covers the tube's cap.
    const tipGeometry = new THREE.SphereGeometry(TONGUE_TIP_BULB, 18, 14);
    tipGeometry.scale(1, TONGUE_FLAT_Y, TONGUE_FLAT_Z);
    this.tongueTip = new THREE.Mesh(tipGeometry, material);
    this.tongueTip.position.set(BASE_LENGTH, 0, 0);
    this.tonguePitch.add(this.tongueTip);

    // Parent to the model's yaw pivot, not the world: then every turn moves
    // the mouth and the tongue together. The former world-space maths could
    // drift to the side or back when the frog changed direction.
    this.tongueParent = this.player.yaw || this.scene;
    this.tongueParent.add(this.tongue);

    // The basic snap still needs a visible 360-degree consequence: a short
    // croak wave leaves the frog at the same moment the tongue lands. The
    // gold front arc is the direct-hit wedge; the mint rings are the splash.
    this.shockwave = new THREE.Group();
    this.shockwave.visible = false;
    this.scene.add(this.shockwave);

    this.waveParts = [];
    const outer = buildArcRing({
      color: 0x9dffc0,
      arcs: 18,
      span: 0.72,
      segments: 3,
      opacity: 0.62,
    });
    const inner = buildArcRing({
      color: 0xffd76a,
      arcs: 12,
      span: 0.5,
      segments: 2,
      opacity: 0.38,
    });
    const ticks = buildRadialTicks(0x9dffc0, 12, 0.32);
    this.frontArc = buildFrontArc(0xffd76a, 0.78);

    for (const part of [outer, inner, ticks, this.frontArc]) {
      this.waveParts.push(part);
      this.shockwave.add(part.mesh);
    }

    // The active Croak is the same idea at a larger, slower scale. It gets
    // its own group so it can overlap the basic attack without stealing it.
    this.croakWave = new THREE.Group();
    this.croakWave.visible = false;
    this.scene.add(this.croakWave);
    this.croakParts = [];
    for (const part of [
      buildArcRing({ color: 0xb8ffd2, arcs: 24, span: 0.64, segments: 3, opacity: 0.8 }),
      buildArcRing({ color: 0xffd76a, arcs: 16, span: 0.4, segments: 2, opacity: 0.45 }),
      buildArcRing({ color: 0x8ef7b0, arcs: 12, span: 0.3, segments: 2, opacity: 0.28 }),
    ]) {
      this.croakParts.push(part);
      this.croakWave.add(part.mesh);
    }
    this.croakTimer = 0;
    this.croakMaxLife = 0.55;
    this.croakRadius = 280;
  }

  /**
   * Listens for the Space key to fire an attack.
   */
  bindInput() {
    window.addEventListener('keydown', (event) => {
      if (event.code !== 'Space') return;
      event.preventDefault();
      this.spaceHeld = true;
      this.tryAttack();
    });

    window.addEventListener('keyup', (event) => {
      if (event.code !== 'Space') return;
      this.spaceHeld = false;
    });
  }

  /**
   * Fires an attack if the cooldown has elapsed.
   *
   * @returns {boolean} True if the attack actually went off.
   */
  tryAttack() {
    if (!this.enabled || this.cooldown > 0) return false;

    this.cooldown = this.cooldownDuration;

    // Start from the mouth at zero length, so the first frame cannot show a
    // full-size tongue popping out of the frog's feet.
    const mouth = this.player.mouth;
    const visual = Math.min(this.radius, TONGUE_VISUAL_MAX) / BASE_LENGTH;
    const thickness = Math.min(1.35, 1 + (visual - 1) * 0.08);
    this.tongue.position.set(mouth ? mouth.x : 4, 0, mouth ? mouth.z : 8);
    this.tongue.rotation.z = 0;
    this.tongue.scale.set(visual * 0.04, thickness, thickness);
    this.tongueTip.scale.set(1 / (visual * 0.04), 1 / thickness, 1 / thickness);

    this.tongue.visible = true;
    this.shockwave.visible = true;
    this.shockwave.scale.setScalar(this.radius * 0.35);
    this.shockwave.position.set(this.player.position.x, this.player.position.y, 1.5);
    this.shockwave.rotation.z = this.player.yaw ? this.player.yaw.rotation.z : 0;
    this.visualTimer = ATTACK_VISUAL_DURATION;

    sound.attack();

    this.pendingHit = true;

    return true;
  }

  /**
   * Fires the larger, active Croak wave. The skill and its cooldown live in
   * main.js; this class only owns the shared visual language.
   *
   * @param {number} radius Wave radius in world units.
   */
  playCroak(radius) {
    this.croakRadius = Math.max(1, radius);
    this.croakTimer = this.croakMaxLife;
    this.croakWave.visible = true;
    this.croakWave.position.set(this.player.position.x, this.player.position.y, 2.2);
    this.croakWave.rotation.z = this.player.yaw ? this.player.yaw.rotation.z : 0;
    this.croakWave.scale.setScalar(this.croakRadius * 0.18);
    for (const part of this.croakParts) part.mesh.material.opacity = 0;
  }

  /**
   * Returns true exactly once per fired attack, then clears the flag.
   *
   * The main loop uses this instead of watching the visual, so a shot can
   * never be swallowed by an overlapping effect (which happened when the
   * attack cooldown was shorter than the visual lifetime).
   *
   * @returns {boolean}
   */
  consumeHit() {
    if (!this.pendingHit) return false;
    this.pendingHit = false;
    return true;
  }

  /**
   * Advances the cooldown timer and animates the lash.
   *
   * @param {number} delta Seconds since the previous frame.
   */
  update(delta) {
    if (this.cooldown > 0) {
      this.cooldown = Math.max(0, this.cooldown - delta);
    }

    // Holding Space keeps firing as soon as the cooldown allows, regardless
    // of movement keys or OS key-repeat behaviour.
    if (this.spaceHeld && this.enabled && this.cooldown <= 0) {
      this.tryAttack();
    }

    if (this.visualTimer > 0) {
      this.visualTimer = Math.max(0, this.visualTimer - delta);

      const t = 1 - this.visualTimer / ATTACK_VISUAL_DURATION;
      const visual = Math.min(this.radius, TONGUE_VISUAL_MAX) / BASE_LENGTH;
      const thickness = Math.min(1.35, 1 + (visual - 1) * 0.08);

      // Out fast, hold for a beat, snap back.
      let reach;
      if (t < 0.24) reach = easeOutCubic(t / 0.24);
      else if (t < 0.56) reach = 1;
      else reach = 1 - easeInCubic((t - 0.56) / 0.44);
      reach = Math.max(0.04, reach);

      // Local mouth position: the yaw pivot already supplies the facing.
      const mouth = this.player.mouth;
      const mouthX = mouth ? mouth.x : 4;
      const mouthZ = mouth ? mouth.z : 8;
      this.tongue.position.set(mouthX, 0, mouthZ);
      this.tongue.rotation.z = 0;

      // Aim the tip at the swarm's hover height. A longer Range talent
      // flattens the angle instead of lifting the tip into the sky.
      const playerZ = this.player.group ? this.player.group.position.z : this.player.position.z;
      this.tonguePitch.rotation.y = -Math.atan2(
        TONGUE_TARGET_Z - (playerZ + mouthZ),
        Math.max(1, this.radius)
      );

      this.tongue.scale.set(visual * reach, thickness, thickness);
      this.tongueTip.scale.set(1 / (visual * reach), 1 / thickness, 1 / thickness);

      this.shockwave.position.set(this.player.position.x, this.player.position.y, 1.5);
      this.shockwave.rotation.z = this.player.yaw ? this.player.yaw.rotation.z : 0;
      this.shockwave.scale.setScalar(this.radius * (0.35 + 0.75 * t));
      const waveFade = Math.pow(1 - t, 1.15);
      for (const part of this.waveParts) {
        part.mesh.material.opacity = part.baseOpacity * waveFade;
      }

      if (this.visualTimer === 0) {
        this.tongue.visible = false;
        this.shockwave.visible = false;
        for (const part of this.waveParts) part.mesh.material.opacity = 0;
      }
    }

    if (this.croakTimer > 0) {
      this.croakTimer = Math.max(0, this.croakTimer - delta);
      const t = 1 - this.croakTimer / this.croakMaxLife;
      const fade = Math.pow(1 - t, 0.9);
      this.croakWave.position.set(this.player.position.x, this.player.position.y, 2.2);
      this.croakWave.rotation.z =
        (this.player.yaw ? this.player.yaw.rotation.z : 0) + t * 0.3;
      this.croakWave.scale.setScalar(
        this.croakRadius * (0.18 + 0.94 * easeOutCubic(Math.min(1, t * 1.15)))
      );
      for (const part of this.croakParts) {
        part.mesh.material.opacity = part.baseOpacity * fade;
      }
      if (this.croakTimer === 0) {
        this.croakWave.visible = false;
        for (const part of this.croakParts) part.mesh.material.opacity = 0;
      }
    }
  }

  /**
   * Returns the enemies lying inside the current attack radius.
   *
   * Large insects are measured to their body edge rather than their centre,
   * so a boss is hittable when the lash touches its shell instead of only
   * when it reaches the middle of a 4.5x body.
   *
   * @param {import('./Enemy.js').Enemy[]} enemies Active enemies.
   * @returns {import('./Enemy.js').Enemy[]} Enemies to defeat.
   */
  enemiesInRange(enemies) {
    const origin = this.player.position;

    return enemies.filter((enemy) => {
      const dx = enemy.position.x - origin.x;
      const dy = enemy.position.y - origin.y;
      const reach = this.radius + (enemy.boss ? enemy.radius : 0);
      return Math.sqrt(dx * dx + dy * dy) <= reach;
    });
  }

  /**
   * Clears the cooldown and hides the lash (used on game reset).
   */
  reset() {
    this.cooldown = 0;
    this.visualTimer = 0;
    this.pendingHit = false;
    this.tongue.visible = false;
    this.shockwave.visible = false;
    this.croakWave.visible = false;
    this.croakTimer = 0;
    for (const part of this.waveParts) part.mesh.material.opacity = 0;
    for (const part of this.croakParts) part.mesh.material.opacity = 0;
  }
}
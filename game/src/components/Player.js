import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { sound } from './Sound.js';

// ---------------------------------------------------------------------------
// Procedural hero
// ---------------------------------------------------------------------------
/**
 * Builds the hero entirely from primitives.
 *
 * The frog used to be a 1.8 MB GLB, but that file was unreliable to serve from
 * GitHub Pages for some players — the request got dropped and the hero never
 * appeared. Geometry built in code is instant, tiny, and always renders, so the
 * frog can never silently vanish again.
 *
 * Assembled directly in our Z-up world, facing +X, so the yaw pivot can spin
 * him to face his travel direction.
 *
 * @returns {THREE.Group}
 */
function buildFrog() {
  const frog = new THREE.Group();

  const skin = new THREE.MeshStandardMaterial({ color: 0x57b357, roughness: 0.6 });
  const belly = new THREE.MeshStandardMaterial({ color: 0x9ccc65, roughness: 0.7 });
  const footMat = new THREE.MeshStandardMaterial({ color: 0x3f8f3f, roughness: 0.7 });
  const eyeWhite = new THREE.MeshStandardMaterial({ color: 0xf5f7f2, roughness: 0.4 });
  const pupil = new THREE.MeshStandardMaterial({ color: 0x14110f, roughness: 0.3 });

  // Fat, low-sitting body.
  const body = new THREE.Mesh(new THREE.SphereGeometry(16, 20, 16), skin);
  body.scale.set(1.3, 1, 0.82);
  body.position.z = 13;
  frog.add(body);

  // Lighter belly on the front-lower side.
  const bellyMesh = new THREE.Mesh(new THREE.SphereGeometry(11, 16, 14), belly);
  bellyMesh.scale.set(1.1, 1, 0.7);
  bellyMesh.position.set(3, 0, 7);
  frog.add(bellyMesh);

  // Two eyes on top, facing +X.
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(6, 14, 12), eyeWhite);
    eye.position.set(9, side * 9, 25);
    frog.add(eye);
    const pup = new THREE.Mesh(new THREE.SphereGeometry(3, 10, 8), pupil);
    pup.position.set(12, side * 9, 27);
    frog.add(pup);
  }

  // Four flattened foot pads at the corners.
  for (const fx of [15, -15]) {
    for (const fy of [-12, 12]) {
      const foot = new THREE.Mesh(new THREE.SphereGeometry(7, 12, 10), footMat);
      foot.scale.set(1.3, 1, 0.5);
      foot.position.set(fx, fy, 2.5);
      frog.add(foot);
    }
  }

  // Two raised haunches at the back for a frog silhouette.
  for (const side of [-1, 1]) {
    const haunch = new THREE.Mesh(new THREE.SphereGeometry(11, 14, 12), skin);
    haunch.scale.set(1, 1, 0.9);
    haunch.position.set(-13, side * 12, 12);
    frog.add(haunch);
  }

  return frog;
}

// ---------------------------------------------------------------------------
// Movement tuning constants
// ---------------------------------------------------------------------------
/** Base duration of a single hop, in seconds (shrinks as difficulty rises). */
export const MOVE_DURATION = 0.28;
/** How high the hero arcs off the ground during a hop. */
export const JUMP_HEIGHT = 22;
/** How far (in world units) a single hop covers. */
export const JUMP_DISTANCE = 70;
/** Fastest a hop may ever become. */
const MIN_MOVE_DURATION = 0.1;

/**
 * The Player is a THREE.Group that hosts Tode's model.
 *
 * The group is what the game logic moves around in world space, while the
 * inner model keeps its own orientation offsets (needed because the GLB was
 * authored in a Y-up convention and our scene is Z-up).
 */
export class Player {
  /**
   * @param {THREE.Scene} scene The scene the player group should be added to.
   */
  constructor(scene) {
    this.scene = scene;

    // The movable entity in world space. The camera rides along with THIS
    // group, so it must never be rotated — spinning it would spin the whole
    // view and make the controls feel like they only work in one direction.
    this.group = new THREE.Group();
    this.group.position.set(0, 0, 0);
    scene.add(this.group);

    // Facing pivot. Only the model is parented here, so turning the hero
    // towards its travel direction never disturbs the camera.
    this.yaw = new THREE.Group();
    this.group.add(this.yaw);

    // A soft blob shadow is cheaper than a shadow map and does more for the
    // hop than one: it shrinks and fades as Tode leaves the ground.
    this.shadow = new THREE.Mesh(
      new THREE.CircleGeometry(14, 32),
      new THREE.MeshBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 0.18,
        depthWrite: false,
      })
    );
    this.shadow.position.z = 0.8;
    this.shadow.renderOrder = 0;
    scene.add(this.shadow);

    // A thin locator ring around Tode's feet. It ignores depth on purpose:
    // a giant boss can cover most of the frog, but the ring still draws on
    // top, so the player can find their own position during a boss fight.
    this.marker = new THREE.Mesh(
      new THREE.RingGeometry(23, 28, 40),
      new THREE.MeshBasicMaterial({
        color: 0x8ef7b0,
        transparent: true,
        opacity: 0.5,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    this.marker.position.z = 1.2;
    this.marker.renderOrder = 10;
    this.group.add(this.marker);

    // Fit to the loaded model's footprint; the hop animation multiplies this.
    this.shadowBaseScale = 1;

    // Reference to the raw loaded model (rotated/offset independently).
    this.model = null;

    // Which model is in use: 'glb' for the detailed frog, 'procedural' only
    // when the GLB fails to load.
    this.modelSource = null;

    // Populated once the model finishes loading.
    this.loaded = false;

    // Pending keyboard inputs, processed one hop at a time. Only the newest
    // direction waits behind the current hop: tapping or holding a key must
    // not build a long backlog the player has to sit through.
    /** @type {THREE.Vector2[]} */
    this.inputQueue = [];

    // Current movement state, driven by the input queue.
    this.moveState = {
      active: false,
      progress: 0,
      startPosition: new THREE.Vector3(),
      targetPosition: new THREE.Vector3(),
      // Direction the model should be facing (radians around Z).
      rotation: 0,
      // How much of a full-length hop this one is (1 = unobstructed).
      fraction: 1,
    };

    // Freeze all player input while the game-over overlay is showing.
    this.controlsEnabled = true;

    // Seconds a single hop takes. Adjusted by the difficulty system.
    this.moveDuration = MOVE_DURATION;

    // Lets the world trim a hop so the hero comes to rest right against a
    // wall instead of stopping a whole hop short of it. Returns the adjusted
    // landing spot, or null when there is nowhere to go. Set by main.js.
    this.resolveTarget = (from, target) => target;

    // Hard backstop applied to every hop's landing spot, so the frog can
    // never leave the board. Set by main.js.
    this.confine = () => {};

    // Half the frog's widest horizontal extent. Measured from the model once
    // it loads, so collision uses his real size rather than a guess.
    this.radius = 22;

    /**
     * Local mouth anchor, in the player's facing frame: X is how far forward
     * of the centre the tongue starts, Z is its height above the feet. Filled
     * from the loaded model's bounds so a bigger frog still fires from its
     * mouth instead of its chest.
     *
     * @type {THREE.Vector3}
     */
    this.mouth = new THREE.Vector3(10, 0, 8);

    /** Timestamp of the last "blocked" thud, so it cannot machine-gun. */
    this.lastBumpAt = 0;

    this.bindInput();
    this.load();
  }

  /**
   * Loads the detailed frog before the run starts.
   *
   * The old flow showed a procedural placeholder first and swapped in the GLB
   * a moment later, which made the hero visibly change shape at the start of
   * every run. Now the game waits behind a loading screen until the real model
   * is ready; the procedural frog is only used if the GLB actually fails.
   */
  load() {
    this.ready = new Promise((resolve) => {
      const loader = new GLTFLoader();
      loader.load(
        `${import.meta.env.BASE_URL}models/tode.glb`,
        (gltf) => {
          const model = gltf.scene;

          // The asset is authored Y-up with its face on local +Z. First stand
          // it up, then yaw the model a quarter turn so that face points along
          // the game's +X forward axis. Without the second rotation the frog
          // moves sideways and the tongue exits from its flank.
          model.rotation.order = 'ZXY';
          model.rotation.set(Math.PI / 2, 0, Math.PI / 2);

          // Scale the frog to a sensible size for the map. 24 is deliberately a
          // little larger than the old 20: the hero reads better against the
          // 3000-unit board without changing the hitbox math.
          model.scale.setScalar(24);

          // Sit the model exactly on the ground plane (Z = 0) by measuring
          // how far the geometry extends below its own origin.
          model.updateMatrixWorld(true);
          const glbBox = new THREE.Box3().setFromObject(model);
          model.position.z -= glbBox.min.z;

          // Half of the widest horizontal extent is the frog's footprint.
          this.radius =
            Math.max(glbBox.max.x - glbBox.min.x, glbBox.max.y - glbBox.min.y) / 2;

          // Mouth: inside the snout, below the eyes. Five units of inset keeps
          // the flat root cap hidden behind the face; the visible tongue then
          // emerges through the mouth rather than being stuck onto it.
          const height = glbBox.max.z - glbBox.min.z;
          this.mouth.set(
            Math.max(4, glbBox.max.x - 5),
            0,
            Math.max(5, height * 0.54)
          );
          this.shadowBaseScale = Math.max(0.8, this.radius / 10);
          this.shadow.scale.setScalar(this.shadowBaseScale);

          this.model = model;
          this.modelSource = 'glb';
          this.yaw.add(model);
          this.loaded = true;
          resolve();
        },
        undefined,
        () => {
          // The detailed model failed to download. Fall back to the
          // procedural frog so the hero is never missing.
          const placeholder = buildFrog();
          const box = new THREE.Box3().setFromObject(placeholder);
          this.radius = Math.max(box.max.x - box.min.x, box.max.y - box.min.y) / 2;

          const height = box.max.z - box.min.z;
          this.mouth.set(Math.max(4, box.max.x - 5), 0, Math.max(5, height * 0.54));
          this.shadowBaseScale = Math.max(0.8, this.radius / 10);
          this.shadow.scale.setScalar(this.shadowBaseScale);

          this.model = placeholder;
          this.modelSource = 'procedural';
          this.yaw.add(placeholder);
          this.loaded = true;
          resolve();
        }
      );
    });
  }

  /**
   * Listens for arrow-key presses and enqueues the matching direction.
   */
  bindInput() {
    const DIRECTION_KEYS = {
      ArrowUp: new THREE.Vector2(0, 1),
      ArrowDown: new THREE.Vector2(0, -1),
      ArrowLeft: new THREE.Vector2(-1, 0),
      ArrowRight: new THREE.Vector2(1, 0),
    };

    window.addEventListener('keydown', (event) => {
      if (!this.controlsEnabled) return;

      const direction = DIRECTION_KEYS[event.key];
      if (!direction) return;

      event.preventDefault();
      if (this.inputQueue.length >= 1) {
        this.inputQueue[0] = direction;
      } else {
        this.inputQueue.push(direction);
      }
    });
  }

  /**
   * Starts a new hop towards the given direction.
   *
   * The hop is trimmed to whatever the world allows: hopping straight at a
   * house lands the frog against its wall rather than refusing to move.
   *
   * @param {THREE.Vector2} direction Unit vector in the XY plane.
   */
  startMove(direction) {
    const state = this.moveState;

    state.active = true;
    state.progress = 0;
    state.startPosition.copy(this.group.position);

    // Where a full-length hop would land.
    const target = this.group.position.clone();
    target.x += direction.x * JUMP_DISTANCE;
    target.y += direction.y * JUMP_DISTANCE;

    // Let the world trim the hop. A null result means we are wedged and
    // cannot move at all in this direction.
    const resolved = this.resolveTarget(this.group.position, target);
    if (!resolved) {
      state.active = false;
      this.reportBlocked();
      return;
    }

    // Keep the landing spot on the board. This is a clamp rather than a
    // reject, so hopping straight into the edge simply stops at the edge.
    this.confine(resolved);

    const deltaX = resolved.x - this.group.position.x;
    const deltaY = resolved.y - this.group.position.y;
    const distance = Math.hypot(deltaX, deltaY);

    // Nowhere to go — don't start a zero-length hop.
    if (distance < 1e-3) {
      state.active = false;
      this.reportBlocked();
      return;
    }

    state.targetPosition.copy(resolved);
    // How much of a full hop this turned out to be. Drives the arc height and
    // the timing, so a trimmed hop looks like a small hop, not a slow one.
    state.fraction = Math.min(1, distance / JUMP_DISTANCE);

    // Face the direction actually travelled. When the world trimmed or slid
    // the hop, that is not the same as the key that was pressed — facing the
    // key instead would make a slide look like the frog is moonwalking.
    state.rotation = Math.atan2(deltaY, deltaX);
  }

  /**
   * Fires a dull thud when a hop is refused, so "a wall stopped me" is
   * distinguishable from "the controls stopped working".
   */
  reportBlocked() {
    const now = performance.now();
    if (now - this.lastBumpAt < 250) return;
    this.lastBumpAt = now;
    sound.bump();
  }

  /**
   * Advances the current hop. Called once per animation frame.
   *
   * @param {number} delta Seconds elapsed since the previous frame.
   */
  update(delta) {
    // If idle, pick up the next queued input.
    if (!this.moveState.active) {
      if (this.inputQueue.length === 0) return;
      const next = this.inputQueue.shift();
      this.startMove(next);

      // startMove() leaves us idle when the hop is blocked or zero-length.
      if (!this.moveState.active) return;

      // The hop is confirmed — let it be heard.
      sound.jump();
    }

    const state = this.moveState;

    // A trimmed hop covers less ground, so it also takes less time and arcs
    // lower. The floor keeps a wall-hugging hop from becoming a twitch.
    const fraction = state.fraction || 1;
    const duration = this.moveDuration * Math.max(0.45, fraction);

    state.progress = Math.min(1, state.progress + delta / duration);

    // Linear interpolation across the ground plane.
    const x = THREE.MathUtils.lerp(state.startPosition.x, state.targetPosition.x, state.progress);
    const y = THREE.MathUtils.lerp(state.startPosition.y, state.targetPosition.y, state.progress);

    // Parabolic arc for the hop: sin() peaks at progress = 0.5.
    const z =
      Math.sin(state.progress * Math.PI) * JUMP_HEIGHT * Math.max(0.5, fraction);

    this.group.position.set(x, y, z);

    // Smoothly swing the model to face the travel direction. This turns the
    // yaw pivot, NOT the group the camera is attached to.
    this.yaw.rotation.z = state.rotation;

    if (state.progress >= 1) {
      this.group.position.z = 0;
      state.active = false;
    }

    // Belt-and-braces: never let a single frame place the hero off-board.
    this.confine(this.group.position);

    this.shadow.position.set(this.group.position.x, this.group.position.y, 0.8);
    const lift = Math.min(1, this.group.position.z / JUMP_HEIGHT);
    this.shadow.scale.setScalar(this.shadowBaseScale * (1 - 0.35 * lift));
    this.shadow.material.opacity = 0.18 * (1 - 0.55 * lift);

    // Keep the locator on the ground while the body arcs upward.
    this.marker.position.z = 1.2 - this.group.position.z;
  }

  /**
   * Sets how long a single hop takes (driven by dynamic difficulty).
   *
   * @param {number} duration Seconds per hop.
   */
  setMoveDuration(duration) {
    this.moveDuration = Math.max(MIN_MOVE_DURATION, duration);
  }

  /**
   * Returns the player's current position on the ground plane.
   *
   * @returns {THREE.Vector3}
   */
  get position() {
    return this.group.position;
  }

  /**
   * Cancels any in-flight hop and clears queued input.
   */
  stop() {
    this.inputQueue.length = 0;
    this.moveState.active = false;
    this.group.position.z = 0;
    this.shadow.position.set(this.group.position.x, this.group.position.y, 0.8);
    this.shadow.scale.setScalar(this.shadowBaseScale);
    this.shadow.material.opacity = 0.18;
    this.marker.position.z = 1.2;
  }
}

/**
 * On-screen prompts for the world's interactive points (houses, bushes,
 * flowers, ponds, fruit trees).
 *
 * The game is full of props the player can stand in, harvest from or strike,
 * but if they don't know what each one does it reads as wallpaper. Two HUD
 * elements carry that information:
 *
 * 1. A persistent line near the top of the screen. It always describes the
 *    most relevant prop the hero is standing next to, including live state
 *    (how long a cooldown has left, whether a house is safe right now).
 *
 * 2. A short-lived toast that confirms a triggered effect.
 *
 * Both are plain HTML managed by the singleton `hud` instance. Callers supply
 * the text; this module only handles presentation.
 */

const ICONS = {
  house: '🏠',
  bush: '🌿',
  flower: '🌸',
  pond: '💧',
  tree: '🌳',
  pine: '🌲',
  heart: '❤',
  speed: '⚡',
  range: '◎',
  freeze: '❄',
  shield: '🛡',
  bomb: '💣',
  fruit: '🍎',
  croak: '🌀',
};

/**
 * Centralised HUD manager. One instance is created here and imported by
 * main.js.
 */
export class InteractionHud {
  constructor() {
    this.buildProximity();
    this.buildToast();
    this.currentKey = null;
    this.currentText = null;
    this.currentTone = null;
  }

  /** Builds the persistent "what is nearby" line. */
  buildProximity() {
    this.proximityEl = document.createElement('div');
    this.proximityEl.className = 'interaction-proximity';
    this.proximityEl.style.display = 'none';
    document.body.appendChild(this.proximityEl);

    this.proximityIcon = document.createElement('span');
    this.proximityIcon.className = 'interaction-icon';
    this.proximityText = document.createElement('span');
    this.proximityText.className = 'interaction-text';

    this.proximityEl.append(this.proximityIcon, this.proximityText);
  }

  /** Builds the transient effect confirmation toast. */
  buildToast() {
    this.toastEl = document.createElement('div');
    this.toastEl.className = 'interaction-toast';
    this.toastEl.style.display = 'none';
    document.body.appendChild(this.toastEl);
    this.toastTimer = null;
  }

  /**
   * Updates the persistent proximity line.
   *
   * @param {{key: string, text: string, tone?: string}|null} state
   *   `key` picks the icon, `text` is the whole sentence, `tone` drives the
   *   colour (ready / cooldown / active / danger). Pass null to hide.
   */
  setProximity(state) {
    if (!state) {
      if (this.currentKey !== null) {
        this.proximityEl.style.display = 'none';
        this.currentKey = null;
        this.currentText = null;
        this.currentTone = null;
      }
      return;
    }

    const tone = state.tone || 'ready';
    if (
      state.key === this.currentKey &&
      state.text === this.currentText &&
      tone === this.currentTone
    ) {
      return;
    }

    this.currentKey = state.key;
    this.currentText = state.text;
    this.currentTone = tone;

    this.proximityIcon.textContent = ICONS[state.key] || '';
    this.proximityText.textContent = state.text;
    this.proximityEl.dataset.tone = tone;
    this.proximityEl.style.display = 'flex';
  }

  /**
   * Pops a one-shot toast confirming that something just happened.
   *
   * @param {string} message Short, sentence-case line.
   * @param {string} [iconKey] Icon key from the ICONS table.
   * @param {string} [color] CSS colour for the icon.
   * @param {number} [duration] How long to keep the toast up, in ms.
   */
  showAction(message, iconKey = '', color = '#ffe066', duration = 2200) {
    this.toastEl.innerHTML = [
      `<span class="interaction-toast-icon" style="color:${color}">${ICONS[iconKey] || iconKey}</span>`,
      `<span class="interaction-toast-text">${message}</span>`,
    ].join('');

    this.toastEl.style.display = 'flex';
    this.toastEl.classList.remove('is-shown');
    void this.toastEl.offsetWidth;
    this.toastEl.classList.add('is-shown');

    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toastEl.style.display = 'none';
    }, duration);
  }
}

/** The shared instance. main.js imports and uses it. */
export const hud = new InteractionHud();

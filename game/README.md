# Tode: Talent Awakening

> Submission for the **JetBrains Academy "Build Your Game Challenge"** (October 2026)

A 3D survival RPG built with **Three.js**. Guide Tode across a checkerboard meadow: hop to dodge the swarm, keep the tongue snap and croak wave firing, level up until your health bar is the level curve, draft talents, merge genes, and take on three bosses that each demand a different answer.

**▶ Play online:** https://wudhx.github.io/tode-talent-awakening/

## Gameplay

| Action | Key |
|---|---|
| Move (hop) | `W A S D` |
| Tongue snap + croak wave | `Space` (hold to keep attacking) |
| Croak — 360° shove (level 4) | `Q` |
| Awakening | `E` |
| Talent draft | `1` `2` `3`; `Esc` declines |
| Gene specimen | `F` absorbs; `G` / `Esc` discards |
| Character panel | `C` |
| Pause | `P` / `Esc` |
| Mute / unmute sound | `M` |
| Restart (after Game Over) | `Space` |

**Rules**

- **+1 point** for every 10 seconds survived
- **+10 to +40 points** for each insect swallowed (rarer species are worth more)
- Touching an insect deals 20 damage and grants 1.5s of invulnerability; a **Shield** absorbs the hit first
- The higher your score, the faster insects spawn and move, and the tougher the species mix becomes — but Tode's speed and attack range grow too (insects scale slightly faster, so the challenge never fades)

### Insect species

A frog's diet, rendered as six distinct opponents. Each is generated from primitives at runtime — no model files, no textures on disk.

| Species | Traits | Reward |
|---|---|---|
| **Fly** | Baseline speed, small | 10 pts |
| **Mosquito** | Small and very fast (1.65×), long proboscis | 15 pts |
| **Bee** | Banded abdomen (procedurally painted texture), four wings, stinger | 25 pts |
| **Beetle** | Large, armoured — **survives the first hit** | 40 pts |
| **Centipede** | Segmented, slower, 30 contact damage | 35 pts |
| **Mole** | Slow, 50% armour, four hit points | 45 pts |

The spawn table is weighted by score: early runs are almost all flies, beetles start appearing past 60 points, and centipedes and moles join past 150.

### Power-ups

Pickups spawn on the meadow every few seconds and are collected by hopping onto them. Active effects are shown as countdown chips along the bottom of the screen.

| Pickup | Effect | Duration |
|---|---|---|
| **Speed** (yellow gem) | Hop cooldown ×0.55 | 8 s |
| **Shield** (blue bubble) | Invincible — insects cannot end the run | 6 s |
| **Range** (orange ring) | Attack radius ×1.9 | 10 s |
| **Freeze** (ice crystal) | Insects move at 35% speed | 6 s |

### Sound

Every sound effect is **synthesised at runtime with the Web Audio API** — oscillators and gain envelopes, no audio files. That keeps the bundle tiny and guarantees the game ships no third-party or commercially released recordings.

- Hop, tongue snap, croak, swallow, power-up, Game Over
- A separate fanfare plays when you beat your best score
- Browsers block audio until the first interaction, so the audio graph is created lazily on the first key press or click
- `M` toggles mute

### High scores

The **top 5 runs are stored in `localStorage`** and shown on the Game Over panel, along with a **NEW BEST!** badge when you beat your record. The table survives page reloads with no backend.

## Tech Stack

- **Three.js** 0.181 — 3D rendering, GLTF model loading
- **Vite** 7 — dev server and production bundling
- **Web Audio API** — procedural sound synthesis
- **localStorage** — persistent local scoreboard
- **JavaScript (ES Modules)** — no framework

## Project Structure

```
src/
├── main.js              entry: scene assembly + game loop
├── style.css            HUD, effect chips, Game Over panel
└── components/
    ├── Camera.js        perspective camera following the player
    ├── Renderer.js      WebGL renderer
    ├── Player.js        input queue + parabolic hop movement
    ├── Enemy.js         four procedural insect species + spawn weighting
    ├── Map.js           checkerboard ground + grass apron
    ├── House.js         random house obstacles + collision
    ├── Attack.js        area attack + cooldown + visual ring
    ├── Score.js         scoring logic and top-of-screen UI
    ├── Difficulty.js    dynamic difficulty scaling
    ├── PowerUp.js       pickups, effect timers and HUD chips
    ├── Sound.js         procedural Web Audio sound effects
    └── HighScores.js    localStorage top-5 leaderboard
```

## Implementation Highlights

**Hop-based movement** — Each move is not a teleport: a progress value `t ∈ [0, 1]` drives the hop. Horizontal position is linearly interpolated, while height follows `Math.sin(t · π)` to produce a parabolic arc that lands back on the ground.

**Collision detection** — Instead of bounding boxes (too coarse for rounded characters), collision uses a minimum-distance constant, with separate rules for enemy–enemy, enemy–player, and entity–house interactions.

**Dynamic difficulty** — A difficulty factor `1 + score × 0.0012` (capped at 12) linearly scales spawn delay, movement speed, attack cooldown and attack range. Enemy parameters are deliberately tuned to scale slightly faster than the player's, so the challenge never fades.

**Procedural insects** — An early bundled enemy model turned out to be a *skinned* mesh whose scale could not be driven from code, so it rendered invisibly. Rather than fight it, all six species are assembled at runtime from spheres, cones, cylinders and circles, with the bee's stripes painted onto a `CanvasTexture`. Blueprints are cached and cloned, so geometry and materials are shared across the whole swarm.

**Procedural audio** — `Sound.js` builds one `AudioContext` lazily on first input and exposes small note helpers. A shared `tone()` primitive handles the oscillator, the frequency glide and the gain envelope, so each effect is a couple of lines.

**Defensive persistence** — Every `localStorage` read and write in `HighScores.js` is wrapped in `try/catch` and validates the parsed payload, so private-mode browsers or a corrupted entry degrade to an empty board instead of breaking the game.

**AI-assisted development** — The project was built in WebStorm in collaboration with JetBrains Junie, an AI coding agent. The developer defined the requirements, reviewed the generated code, tuned the parameters, and verified the results at every step.

## Run Locally

```bash
npm install
npm run dev      # dev server → http://localhost:5173
npm run build    # production build → dist/
```

## Credits

- `small_house.glb` — Small House by Jarlan Perez (CC-BY) via [Poly Pizza](https://poly.pizza/m/053kskrV4U_)
- Course and `tode.glb` — [JetBrains Academy](https://academy.jetbrains.com/course/30327)
- All insects, power-up icons and sound effects are generated procedurally in code

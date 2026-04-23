KIND = Game (Three.js, single-file).

This project is a GAME, not an app. The whole UI/UX paradigm is different from the rest of the PREFERENCES block. Style / Theme / Header / Density / Bottom menu rules DO NOT apply. Telegram Mini App list-row chrome (`.tm-section`, `.tm-row`, etc.) DOES NOT apply. There is NO bottom tab bar. There is NO header.

## Hard rules

- ONE file: `mini_app/index.html`. Inline CSS and `<script type="module">`. No `app.js`, no separate stylesheet, no routing.
- Three.js is MANDATORY. Load it via ESM CDN with an importmap:
  ```html
  <script type="importmap">
  {"imports":{"three":"https://unpkg.com/three@0.160.0/build/three.module.js","three/addons/":"https://unpkg.com/three@0.160.0/examples/jsm/"}}
  </script>
  <script type="module">import * as THREE from 'three';</script>
  ```
  Do NOT use the global UMD build. Do NOT pin a different version unless you have a real reason.
- The canvas fills the viewport: `100vw × 100vh`. Read `Telegram.WebApp.viewportStableHeight` (and `viewportHeight` as fallback) on resize. Body `margin:0; overflow:hidden; background:#000; touch-action:none;`.
- Initialise Telegram WebApp: `WebApp.ready()`, `WebApp.expand()`, `WebApp.disableVerticalSwipes?.()`, `WebApp.requestFullscreen?.()` (best-effort, swallow errors).
- NO `routes.js`, NO database, NO bot webhook unless the game truly needs a server (multiplayer, leaderboards beyond `CloudStorage`). Default to ZERO backend. If the agent skips the backend, omit `routes.js` entirely — do not generate an empty file.
- Persist progress (high score, settings) with `Telegram.WebApp.CloudStorage` (`getItem` / `setItem`). Fall back to `localStorage` when CloudStorage is unavailable. Wrap every CloudStorage call in try/catch.
- Haptic feedback on meaningful events (hop, hit, score milestone, death): `Telegram.WebApp.HapticFeedback.impactOccurred('light'|'medium'|'heavy')` and `notificationOccurred('success'|'error')`. Best-effort, swallow errors.

## Forbidden

- Bottom tab bars, top headers, list rows, `.tm-section`, `.tm-row`, settings screens. None of those exist in a game.
- Loading any UI font from Google Fonts unless the chosen `gameArtStyle` allows it.
- `localStorage`-only persistence (use CloudStorage first, fall back to localStorage).
- Mouse-only controls — the player is on a phone. Keyboard support is fine for desktop testing but every input MUST also work via touch / pointer events.
- Polluting the global scope. Everything inside the module script.

## Plan-before-code discipline (REQUIRED)

Before writing a single line of game code, the planner MUST enumerate ALL of the following sections in the plan. Skipping any of them is a defect. The build agent MUST produce code that maps 1:1 to this plan.

1. **Coordinate system** — origin, axes, units, world bounds.
2. **Scene graph** — every `THREE.Group` and what lives under it (player, world, environment, UI overlay, lights).
3. **World generator** — how lanes / chunks / rooms / tiles are generated and recycled. Streaming distance ahead and cleanup distance behind.
4. **Camera** — type (perspective vs orthographic), FOV / frustum, follow rules, look-at offset, transition smoothing.
5. **Lighting** — ambient + directional/hemisphere recipe, shadow map size, shadow camera frustum tied to the player so shadows stay sharp.
6. **Player object** — geometry, hitbox, movement model (grid hop, continuous, physics), animation hooks.
7. **Input** — see `gameControls/*.md`. Map every input event to a single intent and queue/debounce it.
8. **Collision / win-loss** — what counts as a hit, what counts as scoring, how the game ends and restarts.
9. **Scoring & state machine** — `idle → playing → dead → restart`. Prevent double-counts and double-restarts.
10. **Mobile controls overlay** — visible on touch devices. See `gameControls/*.md`.
11. **Disposal** — every restart MUST dispose old `THREE.Geometry`/`Material`/`Texture` and remove children. Memory leaks kill phones.
12. **Performance budget** — target 60 FPS on a mid-range phone. Cap pixel ratio at `min(window.devicePixelRatio, 2)`. Reuse geometries/materials, use `InstancedMesh` for repeating lane tiles / props when count > 30.

## Game loop

- One `requestAnimationFrame(loop)` driver. Use a `THREE.Clock` for delta time.
- Clamp `dt = Math.min(clock.getDelta(), 1/30)` so a backgrounded tab doesn't teleport the player on resume.
- Drive everything (movement, animation, spawning) by `dt`, not by frame index.
- `renderer.setAnimationLoop` is acceptable too — pick one and stick with it.

## Resize handling

- On `resize` and on `Telegram.WebApp.onEvent('viewportChanged', …)`: update camera (aspect or frustum), `renderer.setSize`, `setPixelRatio(min(devicePixelRatio,2))`.
- Read `Telegram.WebApp.viewportStableHeight` not `window.innerHeight` for height — the latter shifts when the keyboard opens.

## UI overlay (HTML on top of canvas)

- Allowed elements only: a fixed-position score badge (top-left), a minimal start/death overlay (centered card with title + "Tap to play" / "Tap to retry"), an optional pause button (top-right). Nothing else.
- Use plain `<div>`s with inline-styled glassmorphism. NO Telegram chrome classes.
- Overlay is `position: fixed; pointer-events: none;` by default. Re-enable `pointer-events:auto;` on interactive elements only. Never block the canvas from receiving pointer events on the game area.

## Aesthetic default

Voxel/low-poly with bright saturated palette, soft directional shadows, ambient sky-tinted hemisphere light. Override per `gameArtStyle/*.md`.

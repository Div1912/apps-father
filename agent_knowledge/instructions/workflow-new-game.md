WORKFLOW — NEW GAME (Kind = Game, Three.js single-file build)

The full game rules are in the PREFERENCES block (game.md). Read them FIRST.
This workflow replaces the standard App workflow entirely.

1. list_files (quick scan — the project is almost certainly empty on first build).

2. MANDATORY GAME PLAN — call `technical_plan(...)` with ALL sections below BEFORE writing a single line of code.
   The technical_plan payload is the contract; the code MUST map 1:1 to it.

   **Coordinate system** — origin, axes, units, world bounds.

   **Scene graph** — every THREE.Group and what lives under it:
   ```
   scene
   ├── worldGroup      (tiles, obstacles, pickups — recycled chunks)
   ├── playerGroup     (mesh + hitbox helper)
   ├── lightsGroup     (ambient + directional)
   └── uiGroup         (3D score badges if any; otherwise use HTML overlay)
   ```

   **World generator** — how lanes / chunks / tiles are generated, streamed, and recycled.
   Specify: chunk size, how many chunks ahead to keep, when to despawn behind the player.

   **Camera** — type (perspective/orthographic), FOV, follow offset, look-at target, smoothing formula.

   **Lighting** — AmbientLight color+intensity, DirectionalLight color+intensity+position, shadow map size, shadow camera frustum radius.

   **Player object** — geometry (BoxGeometry? CapsuleGeometry?), hitbox size, movement model (grid hop / continuous / physics), animation: tween library or manual lerp.

   **Input** — map every gesture/key to a single intent:
   ```
   swipe-up / ArrowUp   → jump
   swipe-left           → move left
   swipe-right          → move right
   tap-left-zone        → move left
   tap-right-zone       → move right
   ```

   **Collision / win-loss** — AABB or sphere check, what counts as a hit, what counts as scoring, game-over condition, restart trigger.

   **Scoring & state machine**:
   ```
   idle → playing → dead → restart → playing
   ```
   Explain how to prevent double-counts and double-restarts (guard flags).

   **Mobile controls overlay** — HTML div layout for on-screen buttons. Which buttons, where, what size.

   **Disposal on restart** — list every resource type that must be disposed:
   geometry.dispose(), material.dispose(), texture.dispose(), scene.remove(child) for each group.

   **Performance budget** — pixel ratio cap, InstancedMesh threshold (use when count > 30), geometry/material reuse strategy.

3. Write THREE frontend files: `frontend/index.html`, `frontend/styles.css`, `frontend/app.js`.
   - **index.html**: loads `<link href="styles.css">` and `<script src="app.js">`. Three.js via importmap (version 0.160.0, ESM CDN). Canvas element, HTML overlay for score/UI. Call Telegram.WebApp.ready/expand/disableVerticalSwipes/requestFullscreen with try/catch.
   - **styles.css**: all visual styling — canvas sizing (100vw × 100vh), body (margin:0; overflow:hidden; background:#000; touch-action:none), overlay panels, mobile controls, score display.
   - **app.js**: `<script type="module">`. All game logic — Three.js scene setup, animation loop, input handling, collision, scoring, persistence. Use THREE.Clock; clamp dt = Math.min(clock.getDelta(), 1/30). Persistence via Telegram.WebApp.CloudStorage with localStorage fallback. Haptic feedback on key events.
   - HTML ids/classes must be plain, not escaped. Correct: `<canvas id="game-canvas">`; wrong: `<canvas id="\"game-canvas\"">`.
   - **routes.js is optional** — only create it if the game needs server-side multiplayer or shared leaderboards.

4. configure_app(name, description, longDescription, menuButtonText)
   - One atomic call. First build only. It saves metadata to Apps Father DB first and configures the bot now or when it is later linked.
   - The menu button just opens the game (no special config needed beyond menuButtonText).

5. deploy_to_dev() — deploy and verify via the Dev URL in Telegram.

6. finish(shortSummary, summary) — ONE atomic call at the very end.

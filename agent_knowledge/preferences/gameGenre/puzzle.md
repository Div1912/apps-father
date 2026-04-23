GENRE = Puzzle.

- Turn-based or grid-based logic. No real-time enemy pressure (timers are optional).
- Maintain a discrete `board` data structure (2D array, Map of cell → entity, etc.) as the source of truth. Three.js meshes are a *render* of that state — never read game state from mesh positions.
- After each input: mutate the board, run win/lose detection, then animate meshes to match the new state with a short tween (200-300ms). Inputs locked during the animation.
- Win condition shown in plan explicitly (e.g. "all cells of value X cleared", "reach tile 2048", "every group has matching color"). Lose condition explicit ("no legal moves", "timer 0").
- Persist progress per level via `CloudStorage`. Show a level-select overlay at boot if there are multiple levels.
- Visuals: clean, geometric. No motion blur. Hard easing (ease-out cubic) on tile movement.

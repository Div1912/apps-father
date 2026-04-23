CONTROLS = Touch.

- Use `pointerdown` / `pointermove` / `pointerup` on the canvas, NOT `touchstart`/`mousedown`. Pointer events normalise across input types.
- For tap-to-shoot games: convert pointer coords to NDC then `Raycaster` from camera into the scene to find a target.
- For tap-zone games: divide the screen into named regions (e.g. left half = move left, right half = move right) and dispatch named intents.
- Always call `event.preventDefault()` on pointer events on the canvas to suppress the iOS double-tap zoom.
- Set `touch-action: none` on the canvas (already in the kind/game.md body styles).
- Keyboard fallback for desktop testing: WASD or arrow keys mapped to the same intents. Behind a `if (!('ontouchstart' in window))` guard so it doesn't double-fire on hybrid devices.

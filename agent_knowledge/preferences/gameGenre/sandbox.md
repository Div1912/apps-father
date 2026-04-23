GENRE = Sandbox.

- No fail state. Player builds, places, paints, or arranges. Save/load is the core loop.
- Persist the entire scene state as JSON via `Telegram.WebApp.CloudStorage.setItem('save', ...)`. Auto-save every meaningful change (debounced 500ms).
- World representation: keep all placeable entities in a serialisable array. Mesh creation is derived from this array — never the reverse.
- Tools: minimum two — "place" and "remove". Optional: "rotate", "paint". Show a small tool-strip overlay (top or bottom of screen, NOT a Telegram tab bar — a custom inline-styled strip).
- Camera: free-orbit (pinch to zoom on touch, drag to pan). Use `OrbitControls` from `three/addons/controls/OrbitControls.js` and constrain to keep the world in view.
- No haptic spam — only on placement / removal, not on camera moves.
- Grid snap: every placeable position MUST snap to a 1-unit grid (or whatever the plan specifies).

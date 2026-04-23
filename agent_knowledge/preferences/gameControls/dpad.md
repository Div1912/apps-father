CONTROLS = On-screen D-pad.

- Render an HTML overlay (NOT inside the canvas) anchored bottom-left for the D-pad and bottom-right for an action button. Both `position: fixed`, respect `env(safe-area-inset-bottom)`.
- D-pad layout: 4 directional buttons in a `+` arrangement. Each button is `52×52`, semi-transparent white circle with a chevron glyph, `backdrop-filter: blur(8px)`, `border: 1px solid rgba(255,255,255,0.3)`.
- Action button: single `64×64` circular button with a colored fill (game's primary). Optional secondary action button above it.
- Use `pointerdown` + `pointerup` on each button. Track `held` state per direction so movement continues while the finger is down. Multi-touch must be supported (`pointercancel`, separate `pointerId` tracking).
- Visual feedback: scale to `0.92` on press, return on release (`transition: transform 80ms`).
- Keyboard fallback: arrow keys = D-pad, space = action. Behind feature-detect.
- Hide the D-pad on game-over/start overlays. Show only during `playing` state.

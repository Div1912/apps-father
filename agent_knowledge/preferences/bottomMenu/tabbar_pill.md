BOTTOM NAV = Floating pill.

- Detached capsule-shaped bar that floats above the safe-area. 4 icon-only items (no labels). NO labels — silhouette only.
- Position: `position: fixed`, `bottom: max(18px, env(safe-area-inset-bottom) + 8px)`, `left: 14px`, `right: 14px`. Height 56px. `border-radius: 100px` (full pill).
- Background: dark surface at 92–95% opacity (`rgba(24,24,28,0.95)` in dark theme; `rgba(255,255,255,0.95)` with subtle shadow in light). 1px hairline `rgba(255,255,255,0.07)` border. Drop shadow `0 12px 30px rgba(0,0,0,0.4)`.
- Items: 40px circular tap target, icon-only, color `text-muted` (~50% on surface). On press, brief scale-down feedback.
- Active item: WIDTH ANIMATES to ~64px, becomes a horizontal pill with `border-radius: 100px`, fills with `primary` color, icon flips to `primary-text` (white-on-primary). Soft glow `0 4px 12px rgba(primary, 0.4)`. Width transition uses `cubic-bezier(.2,.7,.2,1)` over 300ms.
- Content beneath must reserve `padding-bottom: 92px` to avoid being covered.
- Forbidden: text labels, square corners, full-width attachment to edge, multiple simultaneously active items, sliding-indicator below icons.

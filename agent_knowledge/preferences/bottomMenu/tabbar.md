BOTTOM NAV = Flat tab bar.

- Fixed bottom tab bar welded to the bottom edge of the viewport. 4–5 icon+label items, no detachment, no shadow lift.
- Bar height 56–64px (excluding safe-area). Sits above `Telegram.WebApp.viewportStableHeight` / `env(safe-area-inset-bottom)`.
- Background: solid surface color (or 92%-opacity ink in dark mode). Top hairline border `1px solid` muted border color. No backdrop-blur, no rounded corners on the bar itself.
- Items: square tap target, 9–11px label under a 20–22px icon. Inactive items use `text-muted` (~45% white in dark / ~50% black in light). Active item flips icon + label to `primary` color. No background pill on the active item.
- All top-level screens are reachable from this bar; no hamburger menu, no drawer, no tabs hiding behind a "more" overflow unless there are >5 sections.
- Forbidden: glass blur, floating pill geometry, gradient backgrounds, animated active indicators that slide between tabs.

BOTTOM NAV = Flat tab bar with center FAB.

- Same flat fixed bar geometry as the standard tab bar (welded to bottom edge, top hairline border, solid surface background, no blur). Height 64–74px to accommodate FAB overhang.
- 4 icon+label items spaced evenly. The CENTER slot is reserved — push the 4 items to leave a 56–64px gap in the middle.
- A circular Floating Action Button sits over that center gap, raised `-16px to -22px` above the bar (overflows above the bar's top edge). Diameter 50–56px. `border-radius: 50%`. Filled with the app's `accent` or vivid gradient (e.g. `linear-gradient(135deg, accent-1, accent-2)`).
- FAB elevation: drop shadow `0 8px 20px rgba(accent, 0.45)` and a 3-4px ring matching the bar's background color so it visually "punches" through (`0 0 0 4px var(--bar-bg)`).
- The FAB MUST be bound to a single primary action (e.g. "New transaction", "New post", "Compose") — same action on every screen.
- Inactive tab items use `text-muted`; active tab uses an accent color DIFFERENT from the FAB color (so they don't compete). Tab labels stay 9–11px.
- Forbidden: pill-shaped or glass nav (use `tabbar_pill` / `tabbar_glass` instead), FAB sitting flush with the bar, FAB used as a tab toggle, multiple FABs.

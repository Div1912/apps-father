BOTTOM NAV = Liquid glass.

- Floating frosted-glass bar that lets the screen content show through. Positioned the same as the floating pill: `position: fixed; bottom: max(18px, env(safe-area-inset-bottom) + 8px); left: 14px; right: 14px;` Height 58px. `border-radius: 28px`.
- Background: `rgba(255,255,255,0.10)` over content. MUST use `backdrop-filter: blur(24px) saturate(180%)` and `-webkit-backdrop-filter: blur(24px) saturate(180%)`. Border `1px solid rgba(255,255,255,0.18)`. Inset highlights: `inset 0 1px 0 rgba(255,255,255,0.25)` (top) + `inset 0 -1px 0 rgba(0,0,0,0.1)` (bottom).
- Outer drop shadow `0 10px 30px rgba(0,0,0,0.25)`.
- Items: 38px circular, icon-only, color `rgba(255,255,255,0.7)`. Active item gets `background: rgba(255,255,255,0.20)` and `inset 0 1px 0 rgba(255,255,255,0.35)`, icon `#fff`.
- A slow specular sheen MUST animate across the bar: a `linear-gradient(90deg, transparent, rgba(255,255,255,0.18), transparent)` pseudo-element translateX from -100% → 100% over ~5s, infinite, ease-in-out.
- Background of the page screens MUST be visually rich (gradient, photo, or radial blobs) so the blur effect is visible. Plain flat backgrounds defeat the style — add at minimum 2 soft radial color blobs behind content.
- Content beneath must reserve `padding-bottom: 92px`.
- Forbidden: opaque solid backgrounds on the bar, hard borders, text labels, this style on backgrounds without color variation.

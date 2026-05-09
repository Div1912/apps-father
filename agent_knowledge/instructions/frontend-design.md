## UI/UX DESIGN MANDATE

Every Telegram Mini App you build must have a **modern, intentional, and visually distinctive UI**. Generic-looking apps are a failure. The design is as important as the functionality.

### Step 1 — Pick a design direction BEFORE writing any CSS

Read the app description and plan. Then choose ONE clear aesthetic direction that fits the context:

- **Dark luxury** — near-black backgrounds, gold/amber accents, sharp edges, tight spacing
- **Neon cyber** — deep dark base, vivid neon accents (cyan, magenta, electric green), glow effects
- **Soft glass** — frosted glass cards, pastel gradients, light blurs, gentle shadows
- **Bold flat** — strong solid colors, geometric shapes, heavy typography, zero gradients
- **Minimal pro** — lots of whitespace (or dark space), one accent color, refined mono/serif type
- **Retro** — muted warm palette, grain texture, chunky rounded shapes, vintage type
- **Vivid game** — saturated colors, playful shapes, bouncy micro-animations, big bold numbers
- Or invent your own direction. The above are starting points, not limits.

Commit fully. A half-executed aesthetic looks worse than a simple one done well.

### Step 2 — Colors: define everything in :root, use nothing from Telegram

```css
:root {
  --bg:       #0d0d12;   /* key background — must match AF.init() colors */
  --surface:  #16161f;
  --border:   rgba(255,255,255,0.07);
  --accent:   #7c6cfc;
  --accent2:  #e05cff;
  --text:     #f0eff8;
  --muted:    #7a7a9a;
}
```
- This is the sample colors. Use your palette or another vars for your design UI variant

- **NEVER** use `var(--tg-theme-*)` for colors — Telegram theme vars are forbidden (see frontend-rules.md rule 5).
- All three `AF.init()` color params (`header`, `bottom`, `background`) must equal `--bg` exactly, so the Telegram chrome blends into the app.
- Use CSS variables for every color — no hardcoded hex values scattered through the stylesheet.

### Step 3 — Typography

- Load ONE Google Font that fits the direction. Add it as a `<link>` in `<head>`.
- Good choices: Sora, DM Sans, Outfit, Nunito, Rajdhani, Unbounded, Space Mono, Bricolage Grotesque, Plus Jakarta Sans, Manrope — but VARY across builds, never repeat the same font.
- FORBIDDEN fonts: Inter, Roboto, Arial, system-ui, sans-serif alone. These produce generic results.
- Set `font-family` on `body`, not just scattered elements.

### Step 4 — Layout and spatial quality

- Use CSS Grid and Flexbox confidently. Avoid inline styles for layout.
- Cards: `border-radius: 16px–24px`, subtle border (`1px solid var(--border)`), no harsh box shadows.
- Spacing: use a consistent scale (8px base). Padding inside cards: 16–20px. Gap between cards: 12px.
- Touch targets: minimum 44px height for any tappable element.
- Bottom nav (if present): fixed, blurred background, safe-area padding.

### Step 5 — Motion (subtle, purposeful)

- Page load: stagger-reveal list items with `animation-delay` (50ms apart max).
- Button press: `transform: scale(0.96)` on `:active`, `transition: 0.12s`.
- Screen transitions: `opacity + translateY(8px)` fade-in, 200ms ease-out.
- NEVER add animation that delays interaction or loops without user trigger.

### Step 6 — Background depth

Don't use plain `background: var(--bg)` alone. Add ONE of:
- Radial gradient blob: `background: radial-gradient(ellipse 60% 40% at 70% 10%, #3a1f6e22, transparent)`
- Subtle noise texture via `background-image: url("data:image/svg+xml,...")` at low opacity
- Grid/dot pattern at 3–5% opacity

### Quality bar

Before finishing, ask yourself:
- Would this look at home in the App Store / Play Store screenshot?
- Does it have a clear visual identity someone could describe in one sentence?
- Are the colors, fonts, and spacing consistent throughout?

If the answer to any of these is "no", iterate the CSS before deploying.

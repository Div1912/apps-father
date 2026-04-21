STYLE = Aurora.

- Palette: background `#050b1a`, surface glass `rgba(255,255,255,0.04)`, text `#ffffff`, muted `rgba(255,255,255,0.35)`, primary gradient `linear-gradient(135deg, #38bdf8, #a855f7)`, accent `#10b981`, border `rgba(255,255,255,0.08)`.
- Typography: Space Grotesk, weights 300/500/700. Apply gradient text (`background-clip: text`) on hero numbers ONLY — never on body or labels.
- Geometry: 16–24px corner radius. Glass cards: `backdrop-filter: blur(20px)` + `background: rgba(255,255,255,0.04)` + 1px translucent borders.
- Background: 3 layered radial gradients (cyan, purple, green) on the root surface. No animation needed. Mandatory aurora nebula effect:
  ```
  radial-gradient(ellipse 80% 60% at 20% 10%, rgba(56,189,248,0.18) 0%, transparent 60%),
  radial-gradient(ellipse 60% 50% at 80% 80%, rgba(168,85,247,0.20) 0%, transparent 55%),
  radial-gradient(ellipse 50% 40% at 50% 40%, rgba(16,185,129,0.12) 0%, transparent 50%)
  ```
- CTAs: glass surface + gradient border + soft glow (`box-shadow: 0 0 30px rgba(168,85,247,0.15)`).
- Tone: futuristic but breathable. Suits analytics, SaaS, fintech.
- Forbidden: hard solid fills on hero surfaces, opaque cards, warm tones, any yellow/orange.

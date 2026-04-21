STYLE = Holo.

- Palette: background `#070b14`, glass surface `rgba(100,200,255,0.03)`, text `rgba(200,235,255,0.9)`, muted `rgba(100,200,255,0.4)`, primary `#64c8ff` (ice blue), border `rgba(100,200,255,0.1)`.
- Typography: Space Grotesk for body. DM Mono for IDs/labels (uppercase, letter-spacing 2px). Hero numbers: 32–40px, weight 700, letter-spacing -2px, with `background-clip: text` gradient white→ice-blue.
- Background grid: perspective grid using two `linear-gradient(rgba(100,200,255,0.04) 1px, transparent 1px)` layers (horizontal + vertical, 28×28px), masked with `radial-gradient` fade from top.
- Top glow: absolute `radial-gradient(ellipse, rgba(50,180,255,0.12) 0%, transparent 70%)` ellipse for a "light source from above" feel.
- 3D card: surface uses `linear-gradient(135deg, rgba(50,180,255,0.06) 0%, rgba(0,50,120,0.08) 100%)` plus `inset 0 1px 0 rgba(255,255,255,0.04)` highlight and a gradient top-line via `::before`.
- HUD elements: corner brackets (3 horizontal lines of decreasing width), animated scan-line (`@keyframes scan` scaleX 0.3→1→0.3), hex/diamond logo containers.
- Geometry: 14–24px corner radius. Soft glow shadows in ice-blue (`0 0 30px rgba(50,180,255,0.08)`).
- Tone: 2040s sci-fi, DeFi, AI platforms, space startups. "We come from the future."
- Forbidden: warm tones, sharp angles, opaque heavy fills, retro skeuomorphism.

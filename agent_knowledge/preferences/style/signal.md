STYLE = Signal.

- Palette: background `#000000`, primary `#00ff46` (terminal green), muted `rgba(0,255,70,0.25)`, warn `rgba(255,200,0,0.7)`, err `rgba(255,50,50,0.7)`, accent `#0ff`.
- Typography: DM Mono for everything. Hierarchy through opacity: commands `0.6`, output `0.85`, values `1.0` with `text-shadow: 0 0 10–20px rgba(0,255,70,0.4)` glow.
- Geometry: 6–14px corner radius. Surfaces are `rgba(0,255,70,0.03)` with 1px green-tinted borders. Progress bars are 2px tall with green glow.
- Texture: scanlines overlay everywhere — `repeating-linear-gradient(0deg, transparent 0–2px, rgba(0,255,70,0.015) 2–3px)` to simulate CRT.
- Layout: terminal-style — prompt symbol (`→` or `$`) before commands, indented output rows. Use a blinking 7×14px green cursor block (`@keyframes cur` with `step-end`).
- Tone: devtools, infrastructure, hacker culture. For developers, DevOps, tech apps.
- Forbidden: rounded buttons over 14px, photographic backgrounds, light themes, any other accent color besides green/cyan/warn-yellow/err-red.

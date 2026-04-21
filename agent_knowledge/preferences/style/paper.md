STYLE = Paper.

- Palette: background `#f5f0e8` (aged paper), surface `#ede8df`, text `#1a1410`, muted `#9b8e7a`, primary `#1a1410` (text `#f5f0e8`), accent `#c0392b` (stamp red), border `rgba(0,0,0,0.10)`.
- Typography: Syne for headings (weight 700/800, letter-spacing −1px). Space Grotesk for body. DM Mono for codes/barcodes/serials. Sharp contrast between weights.
- Geometry: 0–4px corner radius. Dashed borders for line items (`border-bottom: 1px dashed rgba(0,0,0,0.12)`). No box-shadows — depth comes from paper texture noise overlay.
- Texture: SVG fractal noise overlay at opacity 0.04–0.06 with `mix-blend-mode: multiply` on the main background. Mandatory.
- Special elements: rotated stamps (`Confirmed` / `Paid` / `Overdue`) with `border: 2px solid #c0392b` and `transform: rotate(6deg)`. Barcode-style footers in DM Mono. Receipt totals separated by 2px solid black rule.
- Tone: tactile, physical, nostalgic. Perfect for invoices, receipts, tickets, passes.
- Forbidden: gradients on surfaces, glow, glassmorphism, neon colors, rounded buttons.

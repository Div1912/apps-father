ART STYLE = Flat.

- Materials: `MeshBasicMaterial` only — no lighting, no shadows. Solid colors.
- Geometry: simple primitives, often planes (`PlaneGeometry`) facing the camera. Suitable for both 2D-orthographic and 3D where lighting cost is unwelcome.
- Disable shadows entirely (`renderer.shadowMap.enabled = false`).
- Palette: bold, high-contrast. Background a single solid clear color. Foreground entities pop via complementary hues.
  - Suggested: bg `#0e1116`, primary `#00e5ff`, secondary `#ff4081`, accent `#ffeb3b`, danger `#ff5252`.
- No fog, no ambient — flat means flat.
- Glow / bloom is acceptable IF using `EffectComposer` from `three/addons/postprocessing/`. Otherwise rely on solid colors + halo planes.
- Outlines via `LineSegments` on `EdgesGeometry`, white or theme-colored, are encouraged (Geometry Wars feel).

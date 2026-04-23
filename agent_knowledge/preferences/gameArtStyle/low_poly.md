ART STYLE = Low poly.

- Geometry: faceted primitives. `THREE.IcosahedronGeometry`, `ConeGeometry` (low segments: 4-8), `CylinderGeometry` (4-8 radial segments), `SphereGeometry` (8 segments wide × 6 high).
- Materials: `MeshLambertMaterial` with `flatShading: true` so facets show.
- Palette: muted, naturalistic — desaturated greens, browns, grey-blues. Avoid neon. Suggested:
  - Terrain `#3d7a3d`, `#2f5a2f`, `#8b6f47`
  - Sky `#a3c8e2`, fog same
  - Player accent `#d97e3a`, `#b04141`
- Lighting: hemisphere (`sky #c2dfff`, `ground #4a3a2a`, intensity 0.8) + directional (`#fff5e0`, intensity 0.7) with soft shadows.
- Slight fog (`new THREE.Fog(skyColor, 30, 80)`) to blend distant geometry.
- Avoid textures entirely. Color variation comes from per-vertex tinting or distinct meshes.
- Trees: cone trunk + 2-3 stacked icosahedrons for canopy. Rocks: single low-poly icosahedron, scale-jittered.

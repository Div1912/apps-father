ART STYLE = Wireframe.

- Geometry rendered as lines only. Use `THREE.LineSegments` with `EdgesGeometry` of the underlying primitive, NOT `wireframe: true` on materials (which produces ugly triangulation).
  ```js
  const edges = new THREE.EdgesGeometry(boxGeo);
  const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x00ff66 }));
  ```
- Background: solid black `#000`.
- Palette: monochromatic neon over black. Pick ONE primary color (`#00ff66` Tron green, `#00e5ff` cyan, or `#ff00ff` magenta) and use shades of it.
- Optional bloom via `three/addons/postprocessing/UnrealBloomPass.js` for the vector-arcade glow. Threshold 0, strength 0.6, radius 0.4.
- No fills. No textures. No shadows. No fog.
- Player and HUD use the same palette — wireframe means total visual consistency.

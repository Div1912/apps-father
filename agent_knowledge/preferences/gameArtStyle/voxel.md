ART STYLE = Voxel.

- Geometry: `THREE.BoxGeometry` only. Build characters and props out of stacked / grouped boxes. No imported models, no textures.
- Materials: `MeshLambertMaterial` with solid `color`. `flatShading: true`. No textures, no maps.
- Palette: bright + saturated. Suggested base palette (override per game theme):
  - Player accent `#ffd54f`, `#ff7043`
  - Ground / lanes `#7cb342`, `#bdbdbd`, `#5d4037`
  - Sky `#bde7ff`, fog same hue lighter
  - Hazards `#e53935`
- Lighting: hemisphere (`sky #ffffff`, `ground #6699aa`, intensity 0.7) + directional (`#fff8e1`, intensity 0.9) casting shadows.
- Renderer clear color = sky color.
- Use `InstancedMesh` for repeating environment props (trees = stacks of 2 boxes, rocks = single box) when count > 30.
- Chunky scale: smallest visible unit is 0.5 world-unit. Avoid sub-unit detail.
- Edges: optionally add `THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ color: 0x000000, opacity: 0.15, transparent: true }))` for cartoon outlines.

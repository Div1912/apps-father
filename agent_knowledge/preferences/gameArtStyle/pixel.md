ART STYLE = Pixel.

- Render at low internal resolution then upscale with nearest-neighbor:
  ```js
  renderer.setPixelRatio(1);
  const PIXEL_SCALE = 4; // each "pixel" = 4 device pixels
  renderer.setSize(width / PIXEL_SCALE, height / PIXEL_SCALE, false);
  renderer.domElement.style.width = width + 'px';
  renderer.domElement.style.height = height + 'px';
  renderer.domElement.style.imageRendering = 'pixelated';
  ```
- Textures: generate procedurally via `THREE.DataTexture` from an inline `Uint8Array` palette OR draw to an offscreen `CanvasTexture` with crisp rectangles. Set `texture.magFilter = NEAREST; texture.minFilter = NEAREST;`.
- Materials: `MeshBasicMaterial({ map, transparent: true })` for sprites. `MeshLambertMaterial` for lit 3D pixel art.
- Sprites: prefer `THREE.Sprite` for camera-facing pixel-art entities.
- Palette: limit to 16-32 colors total. Suggested NES-ish palette:
  - `#1a1c2c`, `#5d275d`, `#b13e53`, `#ef7d57`, `#ffcd75`, `#a7f070`, `#38b764`, `#257179`, `#29366f`, `#3b5dc9`, `#41a6f6`, `#73eff7`, `#f4f4f4`, `#94b0c2`, `#566c86`, `#333c57`.
- No anti-aliasing on the renderer. No mipmaps on pixel textures.

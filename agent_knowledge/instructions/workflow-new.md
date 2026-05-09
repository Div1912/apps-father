WORKFLOW — NEW APP (fallback / kind unknown)

The Kind-specific workflow was not injected (kind not determined at build time).
Follow the standard App workflow below.

1. This is a NEW project — no existing files yet. Skip list_files / read_file. Proceed directly to Step 2.

2. Load required skills BEFORE writing any code:
   - ALWAYS load: load_skill('af-sdk') + load_skill('backend')
   - App needs file uploads (images, video, audio, docs)? → load_skill('bucket')  ← REQUIRED, not optional
   - Real-time needed? → load_skill('websocket')
   - Custom bot behavior? → load_skill('bot-management')
   Load all applicable skills in ONE parallel batch.

3. MANDATORY TECHNICAL PLAN — call `technical_plan(...)` with ALL sections BEFORE writing any code:

   **DB KEYS** — every key, format, and what it stores.
   **REST ENDPOINTS** — every route: method, path, auth, input, output.
   **WS MESSAGE TYPES** — every type in both directions with exact fields (if WS needed).
   **SCREENS / COMPONENTS** — each screen, what data it loads, what events it reacts to.
   **IMAGES** (if any) — list each image you plan to generate: filename, aspect_ratio, purpose.
     Planning filenames here lets you reference them in HTML/CSS before actually generating them.

   This technical_plan payload is the CONTRACT. Backend and frontend MUST match it exactly.

4. IMAGE GENERATION (optional, up to 3 images per session):
   Use `image_generate(prompt, filename, aspect_ratio, style?, rgb_colors?, background_rgb_color?)`.
   Generate images BEFORE the frontend code that uses them. Saved at /bucket/{projectId}/{filename}.
   Use in HTML:  <img src="/bucket/{projectId}/{filename}">
   Use in CSS:   background-image: url('/bucket/{projectId}/{filename}');
   — Use 16:9 for banners/headers, 1:1 for icons/avatars, 9:16 for portrait heroes.
   — Add a `style` param ('Illustration', 'Pixel art', 'Vector art', etc.) to use stylized rendering.
   — Omit `style` for highest-quality photorealistic output (Recraft V4 Pro).
   — Generate images when they genuinely improve the UI. Don't generate if the app is functional/data-focused.
   CRITICAL — background blending: images always have a solid background (no transparency).
   For ANY image placed ON the app UI (illustrations, characters, icons): ALWAYS pass
   `background_rgb_color` matching the app's CSS background color (convert hex to [r,g,b]).
   Without this the image shows a white box that clashes with dark themes. Read styles.css first.

5. Write backend/routes.js FIRST — all REST endpoints + WS handler from the plan.
   File uploads MUST use AF Bucket (see bucket skill). NEVER write files to local disk in routes.js.

6. Write frontend files (frontend/index.html, frontend/styles.css, frontend/app.js).
   API base: /api/{projectId}/ — WS base: {wsBaseUrl}/ws/{projectId}.

7. shell("npm install <pkg>") if an external package is genuinely needed.

8. configure_app(name, description, longDescription, menuButtonText)
   — ONE atomic call. First build only. Saves to Apps Father DB first and configures the bot now or when it is later linked.

9. fetch_url to read docs only when you need to learn an unfamiliar external API.

10. deploy_to_dev() — deploy and verify.

11. finish(shortSummary, summary, context_diff) — ONE atomic call at the very end. See finish-tool.md.

WORKFLOW FOR UPDATE (fallback / kind unknown):
1. READ THE PROJECT CONTEXT in your prompt FIRST. It contains:
   - Full architecture, all routes, all DB keys, all function names
   - Code Locations with exact line numbers for every route/function
   - UI structure and CSS conventions
   DO NOT grep or read_file to "understand the project" — you already have that info.
2. Use Code Locations to do TARGETED read_file(path, offset, limit) ONLY for the
   exact lines you need to edit. Example: context says "POST /register: line 2015"
   → read_file("backend/routes.js", offset=2015, limit=50) — NOT grep("register").
3. Plan ALL changes before writing any code. Decide which files and which lines.
   If the update adds file uploads → load_skill('bucket') before writing any upload code.
   If the update adds or improves UI visuals → consider image_generate (see step 3b).
3b. IMAGE GENERATION (optional, up to 3 per session):
   Use `image_generate(prompt, filename, aspect_ratio, style?, rgb_colors?, background_rgb_color?)`.
   Generate BEFORE the frontend code that references them. Available at /bucket/{projectId}/{filename}.
   Use when the user explicitly asks for images/illustrations, or when adding them clearly
   improves the visual quality of the app. Do NOT generate images for routine functional updates.
   CRITICAL — background blending: images always have a solid background (no transparency).
   For ANY image placed ON the app UI (illustrations, characters, icons): read styles.css to find
   the CSS background color, convert hex to [r,g,b], and pass as `background_rgb_color`.
   Without this the image shows a white box that clashes with dark themes.
4. Make changes with edit_file (small) or write_file (large).
5. deploy_to_dev() to deploy your code. It runs syntax/contract validation automatically.
6. Verify changed behavior with simulate_api / simulate_telegram / simulate_ws when applicable.
7. Final turn: call finish(shortSummary, summary, context_diff) — ONE atomic call. There is NO separate short_summary/summary/done. See finish-tool.md for the third arg.
IMPORTANT: Do NOT call configure_app during updates — app/bot profile metadata is set only on first build.

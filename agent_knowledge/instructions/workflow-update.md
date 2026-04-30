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
4. Make changes with edit_file (small) or write_file (large).
5. deploy_to_dev() to deploy your code. It runs syntax/contract validation automatically.
6. Verify changed behavior with simulate_api / simulate_telegram / simulate_ws when applicable.
7. Final turn: call finish(shortSummary, summary, context_diff) — ONE atomic call. There is NO separate short_summary/summary/done. See finish-tool.md for the third arg.
IMPORTANT: Do NOT call configure_app during updates — app/bot profile metadata is set only on first build.

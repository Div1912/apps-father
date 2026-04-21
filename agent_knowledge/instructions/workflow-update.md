WORKFLOW FOR UPDATE:
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
5. Run syntax check: shell("node -e \"new Function(require('fs').readFileSync('backend/routes.js','utf8'))\"") BEFORE deploy.
6. deploy_to_dev() to deploy your code.
7. Final turn: call finish(shortSummary, summary) — ONE atomic call. There is NO separate short_summary/summary/done.
IMPORTANT: Do NOT call configure_bot or telegram_api(setMyDescription) during updates — bot description is set only on first build.

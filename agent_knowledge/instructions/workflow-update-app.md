WORKFLOW — UPDATE APP (Kind = App / standard Telegram Mini App)

1. READ THE PROJECT CONTEXT in your prompt FIRST. It contains routes, DB keys, code locations, UI structure, and CSS conventions.
   Do NOT grep/read_file broadly to understand the project if the context already locates the code.

2. Use targeted read_file only for exact lines you need to edit. Example: context says "POST /register: line 2015" → read_file("backend/routes.js", offset=2015, limit=60).

3. Plan all changes before writing code. Decide which files, routes, DB keys, screens, and WS message types are affected.

4. Make changes with edit_file for small targeted edits or write_file for large rewrites.

5. If backend/routes.js changed, deploy_to_dev will run syntax/contract validation automatically. Fix any returned validator errors.

6. deploy_to_dev() to deploy your code.

7. Verify changed backend behavior with simulate_api/server_logs. If the update changes WebSocket behavior, verify with simulate_ws.

8. Final turn: call finish(shortSummary, summary, context_diff) — ONE atomic call. See finish-tool.md for the third arg.

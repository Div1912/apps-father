ARCHITECTURE:
- Frontend: HTML + CSS + vanilla JS — you edit frontend/ (index.html, styles.css, app.js)
- Backend: Express.js routes in backend/routes.js
- WebSocket: generated frontend code should connect to {wsBaseUrl}/ws/{projectId}; dev mode rewrites it to /devws/{projectId} automatically.
- Database: JSON key-value store (db.get/db.set) — backed by SQLite, one file per project
- Files live in: frontend/ (index.html, styles.css, app.js) and backend/ (routes.js) — these paths are relative to YOUR working directory
- ENVIRONMENTS:
  * You work inside a commit folder. Your frontend/ and backend/ are scoped to this commit.
  * To test your changes, call deploy_to_dev() — this copies your code to the development environment.
  * After deploy_to_dev(), test via DEV URLs:
    - Frontend: /dev/{projectId}/
    - API: /devapi/{projectId}/
    - WebSocket: {wsBaseUrl}/devws/{projectId} (write frontend code as /ws/{projectId}; dev middleware rewrites it)
  * Production URLs (/app/, /api/, /ws/) serve from RELEASE — do NOT test against them. They show old code until the user clicks "Publish".
  * NEVER write files outside frontend/ and backend/. You will get an error if you try.
  * Call deploy_to_dev() to push code to the dev environment so the user can verify visually. There are no automated testing tools.
  * DEPLOY LIMIT: You may use deploy_to_dev() at most 4 times per session. Budget them carefully: typically deploy #1 for main code, #2-3 reserved for critical fixes. After deploy #4, you MUST call finish(shortSummary, summary) immediately.
  * If tests fail due to dev environment caching (e.g. WebSocket handlers not reloading, old round data in DB), note it in your finish() summary and move on. Do NOT write workaround/normalization code for dev environment issues.
- You can install npm packages via shell (npm install --save <pkg>)

TESTING IS DISABLED:
- http_request and server_logs tools are NOT available. Do NOT attempt to call them.
- The user visually verifies the app after deploy_to_dev. Trust your code.
- ALWAYS run syntax check on routes.js BEFORE deploy_to_dev:
  shell("node -e \"new Function(require('fs').readFileSync('backend/routes.js','utf8'))\"")

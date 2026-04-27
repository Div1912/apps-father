ASKING THE USER (ask_user tool):
- Use ask_user ONLY when you need information the user MUST provide: API keys, credentials, external account IDs, design choices, styling, naming, or a choice between fundamentally different approaches where guessing wrong wastes significant effort.
- If a requested feature needs an API key, credential, paid provider, or external account ID and there is no good public no-key alternative, you MUST call ask_user before coding that integration.
- NEVER use `process.env`, `"not-set"`, placeholder keys, fake AI responses, or mock provider data as a substitute for asking the user.
- NEVER use ask_user for implementation details, or anything you can decide yourself.
- NEVER call ask_user in parallel with other tools — it must be the ONLY tool in its turn.
- Always provide clear options as buttons when the question has a finite set of answers.
- If the user clicks Skip or doesn't answer a credential/API-key question, do not fake the integration. Use a real no-key fallback if one exists, or finish with a clear blocked note explaining what credential is missing.
- After receiving a credential from ask_user: write it to `backend/.env` using write_file (one KEY=VALUE per line), then reference it in routes.js via the `env` argument: `env.MY_KEY`. Never write secrets directly into routes.js source code.
  Example:
    write_file("backend/.env", "OPENAI_KEY=sk-...\nOTHER_SECRET=abc")
    Then in routes.js: module.exports = function(router, db, projectId, env) { const key = env.OPENAI_KEY; ... }

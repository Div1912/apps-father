FINISH TOOL — three arguments:

`finish(shortSummary, summary, context_diff?)`

1. **shortSummary** — user-facing, non-technical. 3–5 word title + 1–2 sentences. NO jargon, NO code, NO file names. Example: "Added daily challenge\n\nUsers now get a fresh puzzle every day with a streak counter."

2. **summary** — full technical changelog for the next agent run. Architecture decisions, new files, behavior changes, anything the next update should know.

3. **context_diff** — optional but STRONGLY RECOMMENDED. 1–3 sentences describing the architectural delta of THIS commit only. The platform appends it to the project passport without an LLM call (cheap), so the next 4 commits can run with up-to-date context essentially for free. Every 5th commit then folds these deltas back into the body of the passport via a regen.

What belongs in `context_diff`:
- New routes (method + path + purpose), removed routes
- New DB keys / removed keys
- New screens or pages, removed screens
- New WebSocket event types
- New npm packages used in a non-trivial way
- Architectural decisions (e.g. "Switched leaderboard storage from db.users to db.scores keyed by week")

What does NOT belong:
- Bug fixes that don't change architecture (those go in `summary` only)
- Cosmetic CSS tweaks
- Comment-only edits

Examples (good):
- "Added GET /api/leaderboard returning top-10 by score; reads db.users.scores."
- "New screen #profile with avatar upload; uses POST /api/upload-avatar (multipart) and db.profiles.avatarUrl."
- "Removed legacy /api/stats-v1 and replaced with paginated /api/stats?page=N."
- "Added WS event type 'round_started' broadcast from /api/round/start."

Example (bad — too verbose / not architectural):
- "Refactored color scheme and made the buttons feel more responsive after several rounds of polishing." → put this in `summary` instead.

If you don't pass `context_diff`, the platform falls back to the first line of `summary`. That works but is less precise — prefer to author it yourself.

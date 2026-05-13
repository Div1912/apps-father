# Per-project worker runtime (DEV)

This folder ships the worker side of the apps-father isolation work: one
Node.js process per project, dropped to its own Linux user, mounting both
release and development runtimes on `127.0.0.1:<port>`. Main process proxies
all `/app/:id/api/*`, `/dev/:id/api/*` and the equivalent WS upgrades into
these workers.

```
runner/
├── worker-entry.js     # spawned by main; sole worker bootstrap
├── install-runner.sh   # host-level setup (apt-install acl, mkdir /srv/apps-father/projects)
└── lib/
    ├── loadRuntime.js     # require(routes.js) + env+db wiring per runtime
    ├── sqlite-kv.js       # db.{get,set,delete,keys,getAll} compat wrapper
    ├── bot-bridge.js      # grammY dispatcher for /__worker/bot-update
    ├── bucket-helper.js   # db.bucket.{upload,uploadBase64} new helper
    ├── bucket-proxy.js    # backward-compat /bucket/:id/upload local proxy
    └── init-data.js       # HMAC verifier for Telegram WebApp initData
```

## Cutover order (DEV)

```bash
# 0. Make sure the migrations batch has been applied so projects.worker_port
#    and projects.worker_username exist.

# 1. Upload runner code + scripts
deploy.ps1 → tick "Upload runner/" + "Run runner/install-runner.sh"

# 2. Stop main, flip RUNTIME_MODE
ssh root@<dev>
  pm2 stop apps-father-dev
  $EDITOR /opt/apps-father-dev/.env   # set RUNTIME_MODE=worker

# 3. Migrate project trees + create afp_<hash> users
  cd /opt/apps-father-dev
  node scripts/migrate-to-runner-dev.js --dry-run  # review first
  node scripts/migrate-to-runner-dev.js            # actually move

# 4. Start main in worker mode
  pm2 start apps-father-dev

# 5. Run smoke tests
  PROJECT_ID_A=<id1> PROJECT_ID_B=<id2> ADMIN_PASSWORD=*** \
    bash scripts/smoke-tests-runner-dev.sh
```

## Lifecycle (Phase 1)

- Workers are stopped at boot. `runnerManager.list()` is empty.
- The first inbound request triggers a lazy spawn:
  ```
  ensureRunning(id) → allocate port → spawn(uid=afp_X, env=allowlist) →
  poll /__worker/health 200 → forward request
  ```
- Crash supervision = exponential backoff 1→2→4→8→16s, max 5 in 5 min, then
  circuit-break (manual reset via `POST /admin/api/workers/<id>/reload`).
- Reload after `commit.syncToDev` / `commit.releaseCurrentDev` only triggers
  if the worker is currently running. Otherwise it picks up new code on the
  next lazy spawn.

## Admin JSON API (Phase 1)

```
GET  /admin/api/workers              # list registry + per-worker summary
GET  /admin/api/workers/:id          # detail + last 200 log lines
POST /admin/api/workers/:id/stop     # SIGTERM 30s drain → SIGKILL
POST /admin/api/workers/:id/restart  # stop + ensureRunning
POST /admin/api/workers/:id/reload   # alias of restart (different counter)
POST /admin/api/workers/stop-all     # graceful drain across registry
```

All gated by the existing admin auth middleware. Phase 2 will add the
SPA Workers tab plus provision/pin/set-tier/clear-cache/log-stream/metrics.

## Env handed to user routes.js

The 4th arg to `routeModule(router, db, projectId, env)` contains only:
- `BASE_URL`
- `PROJECT_ID`
- `INTERNAL_BASE_URL` (points at the worker's own listener — bucket calls
  hit the local proxy which adds `x-af-internal` upstream)
- everything from the project's own `<runtime>/backend/.env`

Never in `env`: `AF_INTERNAL_SECRET`, `BOT_TOKEN`, `RUNNER_SECRET`. The bot
token reaches user code only via `db.botToken` for the release runtime.
`db.botToken` is `null` for the development runtime.

## Bucket access

```js
// New (preferred): typed helper
const { file_id, direct_link } = await db.bucket.upload(buffer, mime);

// Backward compat: existing fetch(env.INTERNAL_BASE_URL + ...) calls keep
// working — the worker's local bucket proxy injects AF_INTERNAL_SECRET on
// the upstream call. User code does not need to send the header.
```

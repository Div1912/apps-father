# Workers → Docker rollout

Operator runbook for migrating the per-project worker runtime from the
legacy `child_process` + Linux-user backend to Docker containers.

## What changes

- `RUNTIME_MODE=docker` selects `DockerRunnerService` instead of
  `RunnerManager`. Both implement the same `IRunnerManager` interface, so
  every runner consumer (Server Control mini_app, agent `ServerLogsTool`,
  admin Workers tab, runner-proxy, bot-forwarder, commit reload hooks)
  keeps working without code changes.
- Each project gets its own container `afp-<projectId>` with strict CPU /
  memory / PID limits and a read-only root filesystem.
- The agent's `ShellTool` now runs commands via `docker exec` as the
  unprivileged `node` user — closes the pre-rollout RCE-as-root attack
  surface.
- Per-project `node_modules` live in `/srv/apps-father/projects/<id>/node_modules`
  (mounted into containers as `/workspace/node_modules`).
- A WebSocket admin console (`/admin/api/projects/:id/console/ws`) is
  exposed for operator inspection.

## Rollout order

1. **DEV** — full deployment + smoke test:
   ```powershell
   ./scripts/migrate-workers-to-docker.ps1
   # choose DEV with TAB
   ```
   Verify in DEV admin Workers tab and a few sample projects.

2. **PROD** — copy the image from DEV (skip rebuild) and run:
   ```powershell
   ./scripts/transfer-runner-image.ps1
   ./scripts/migrate-workers-to-docker.ps1
   # choose PROD with TAB
   ```

## Rollback

The legacy worker backend is kept intact. To revert:

```bash
ssh root@<server>
sed -i '/^RUNTIME_MODE=/d' /opt/apps-father{-dev,}/.env
echo 'RUNTIME_MODE=worker' >> /opt/apps-father{-dev,}/.env   # or in-process
pm2 restart apps-father{-dev,} --update-env
```

Containers stay around but become inert. To clean up:

```bash
docker ps -aq --filter label=afp.runner=worker | xargs -r docker rm -f
```

Project files on disk are unchanged either way (the container only
bind-mounted `/srv/apps-father/projects/<id>`).

## Pieces

| File | Role |
|---|---|
| `runner/Dockerfile` | base image with worker-entry + lib + node deps |
| `runner/package.json` | platform-baked deps (express, ws, dotenv, better-sqlite3, grammy) |
| `scripts/build-runner-image.{sh,ps1}` | build `apps-father-runner:latest` |
| `scripts/setup-docker-network.sh` | create `apps-father-runners` bridge + iptables egress filter |
| `scripts/migrate-workers-to-docker.{sh,ps1}` | end-to-end migration |
| `scripts/transfer-runner-image.ps1` | DEV → PROD image transfer (skip rebuild) |
| `src/services/docker-runner.service.ts` | new IRunnerManager backend |
| `src/services/runner-types.ts` | shared interface + types |
| `src/web/routes/console-ws.ts` | admin console WebSocket handler |
| `admin/js/console-modal.js` | xterm.js front-end for the console |

## Architectural notes

- Containers attach to a dedicated bridge network with `--icc=false` so
  workers cannot see each other; outbound internet stays open for Telegram
  API / OpenAI / etc.
- Host iptables rules block container → host gateway / loopback / private
  LAN / cloud metadata. Outbound public internet stays open.
- The platform main process keeps running on the host (root). It's
  responsible for the runner-proxy, admin UI, mini_app, agent build chain,
  and database access — none of which changes under this migration.
- Agent's `ServerLogsTool` keeps its synchronous API: `DockerRunnerService`
  pipes `docker logs --follow` into an in-memory ring buffer at spawn time,
  same shape as the legacy `RunnerManager`.
- Runner Server Control endpoints (`/admin/projects/:id/worker/{status,
  stop, restart, reload}`, `/api/projects/:id/worker/logs`) are
  byte-identical because they go through `runnerManager.*`, which now
  routes to whichever backend is active.
- Maintenance mode files (`projects/<id>/.maintenance`) live on the host
  outside the container's volume mount, so the platform-side check in the
  proxy works unchanged.

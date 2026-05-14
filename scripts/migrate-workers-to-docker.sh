#!/usr/bin/env bash
#
# migrate-workers-to-docker.sh — migrate per-project workers from the legacy
# Linux-user runtime to Docker containers.
#
# Run this **on the server** after:
#   1. Docker is installed
#   2. The apps-father-runners network exists (scripts/setup-docker-network.sh)
#   3. The apps-father-runner:latest image is built (scripts/build-runner-image.sh)
#
# What it does (idempotent — safe to re-run):
#   1. Reads project IDs from /srv/apps-father/projects/.
#   2. For each project, ensures /srv/apps-father/projects/<id>/package.json
#      exists. Pre-seeds it with `{ "name": "workspace", ... }` so future
#      `npm install --save-exact` calls inside the container have a target.
#   3. Re-chowns the project tree to UID/GID 1000 (the `node` user inside the
#      `node:20-alpine` image), so writes from the container hit files the
#      platform on the host can still read/write.
#   4. Reports whether RUNTIME_MODE in .env is already "docker"; nudges the
#      operator to flip it and restart pm2 if not.
#
# This script does NOT stop workers or start containers — that happens
# automatically when the platform main process boots with RUNTIME_MODE=docker
# (DockerRunnerService.adoptExistingContainers + lazy spawn on first request).

set -euo pipefail

PROJECTS_ROOT="${RUNNER_PROJECTS_ROOT:-/srv/apps-father/projects}"
APP_DIR="${APP_DIR:-/opt/apps-father-dev}"
ENV_FILE="${APP_DIR}/.env"
NODE_UID=1000
NODE_GID=1000

echo ">>> Migrating workers to Docker"
echo "    Projects root: ${PROJECTS_ROOT}"
echo "    App dir:       ${APP_DIR}"
echo ""

# ── 1. Sanity checks ─────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  echo "FAIL: docker is not installed. Run get.docker.com first."
  exit 1
fi

if ! docker network inspect apps-father-runners >/dev/null 2>&1; then
  echo "FAIL: apps-father-runners network missing. Run scripts/setup-docker-network.sh first."
  exit 1
fi

if ! docker image inspect apps-father-runner:latest >/dev/null 2>&1; then
  echo "FAIL: apps-father-runner:latest image missing. Run scripts/build-runner-image.sh first."
  exit 1
fi

if [ ! -d "${PROJECTS_ROOT}" ]; then
  echo "FAIL: projects root ${PROJECTS_ROOT} does not exist."
  exit 1
fi

# ── 2. Per-project preparation ───────────────────────────────────────────────
total=0
seeded=0
chowned=0

for proj_dir in "${PROJECTS_ROOT}"/*; do
  [ -d "${proj_dir}" ] || continue
  project_id="$(basename "${proj_dir}")"
  total=$((total + 1))

  # Seed package.json if missing
  if [ ! -f "${proj_dir}/package.json" ]; then
    cat > "${proj_dir}/package.json" <<EOF
{
  "name": "workspace",
  "version": "1.0.0",
  "private": true,
  "description": "Per-project npm dependencies for project ${project_id}. Managed by the apps-father agent via the npm_install tool."
}
EOF
    seeded=$((seeded + 1))
    echo "  seeded:  ${project_id:0:8}…/package.json"
  fi

  # Re-chown to node user (uid 1000) inside the container. We deliberately
  # change ownership across the whole tree so the container can write to
  # data dirs, sqlite WALs, etc. The host platform process runs as root
  # so it can still read everything regardless.
  current_uid="$(stat -c '%u' "${proj_dir}" 2>/dev/null || echo 0)"
  if [ "${current_uid}" != "${NODE_UID}" ]; then
    chown -R "${NODE_UID}:${NODE_GID}" "${proj_dir}"
    chowned=$((chowned + 1))
    echo "  chowned: ${project_id:0:8}…/ → ${NODE_UID}:${NODE_GID}"
  fi
done

echo ""
echo "  Total projects: ${total}"
echo "  Seeded package.json: ${seeded}"
echo "  Re-chowned to node user: ${chowned}"
echo ""

# ── 3. Verify .env runtime mode ──────────────────────────────────────────────
if [ -f "${ENV_FILE}" ]; then
  current_mode="$(grep -E '^RUNTIME_MODE=' "${ENV_FILE}" | cut -d'=' -f2 | tr -d '"' | tr -d "'" | tr -d ' ' || true)"
  if [ "${current_mode}" = "docker" ]; then
    echo "OK: RUNTIME_MODE=docker already set in ${ENV_FILE}"
  else
    echo "ACTION REQUIRED: set RUNTIME_MODE=docker in ${ENV_FILE} (currently: '${current_mode:-unset}')"
    echo "  Suggested:"
    echo "    sed -i '/^RUNTIME_MODE=/d' ${ENV_FILE} && echo 'RUNTIME_MODE=docker' >> ${ENV_FILE}"
    echo "  Then: pm2 restart apps-father-dev"
  fi
else
  echo "WARN: ${ENV_FILE} not found — the platform must be configured separately."
fi

echo ""
echo ">>> Migration complete."
echo "    The platform will adopt running containers (if any) and lazy-spawn"
echo "    new ones on the first inbound request per project."

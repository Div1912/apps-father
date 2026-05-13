#!/usr/bin/env bash
# install-runner.sh — host-level setup for per-project worker runtime.
#
# Idempotent: safe to re-run on every deploy. Run once on each box
# that hosts apps-father workers (currently only the DEV box).

set -euo pipefail

PROJECTS_ROOT="${RUNNER_PROJECTS_ROOT:-/srv/apps-father/projects}"
APP_DIR="${APP_DIR:-/opt/apps-father-dev}"

echo "[install-runner] PROJECTS_ROOT=$PROJECTS_ROOT"

# 1. ACL package — required for setfacl in runner-provision.service.ts.
if ! command -v setfacl >/dev/null 2>&1; then
  echo "[install-runner] Installing acl package…"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y
    apt-get install -y acl
  elif command -v yum >/dev/null 2>&1; then
    yum install -y acl
  else
    echo "[install-runner] WARNING: no apt-get/yum found; install acl manually."
  fi
fi

# 2. Create the project tree root (711 = list-traversable but not readable by others).
mkdir -p "$PROJECTS_ROOT"
chown root:root "$PROJECTS_ROOT"
chmod 711 "$PROJECTS_ROOT"

# 3. The /srv/apps-father parent must also be world-traversable so non-root
#    project users can chdir into their own subtree.
mkdir -p "$(dirname "$PROJECTS_ROOT")"
chmod 711 "$(dirname "$PROJECTS_ROOT")"

# 4. Make sure /opt/apps-father-dev/.env stays root:root 600 (defensive — main
#    process boots with this anyway, but the migration window may flip it).
if [[ -f "$APP_DIR/.env" ]]; then
  chown root:root "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  echo "[install-runner] Locked $APP_DIR/.env to root:root 600"
fi

# 5. Sanity check: list directory perms so the deploy log shows them.
ls -la "$(dirname "$PROJECTS_ROOT")" || true
ls -la "$PROJECTS_ROOT" || true

echo "[install-runner] Done."

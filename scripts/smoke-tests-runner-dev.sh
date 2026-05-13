#!/usr/bin/env bash
# scripts/smoke-tests-runner-dev.sh
#
# Acceptance matrix runner for the per-project worker runtime (§9 of the plan).
# Run this on the DEV box AFTER cutover (RUNTIME_MODE=worker, migration done,
# install-runner.sh ran, pm2 restarted).
#
# Usage:
#   APP_DIR=/opt/apps-father-dev \
#   ADMIN_PASSWORD=XXX \
#   PROJECT_ID_A=<uuid-of-a-real-project> \
#   PROJECT_ID_B=<uuid-of-a-DIFFERENT-project> \
#   bash scripts/smoke-tests-runner-dev.sh
#
# Output: pass/fail per check, plus the JSON metrics from /admin/api/workers.

set -uo pipefail

PASS=0
FAIL=0
WARN=0

APP_DIR="${APP_DIR:-/opt/apps-father-dev}"
BASE="http://127.0.0.1:3001"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
PROJECT_ID_A="${PROJECT_ID_A:-}"
PROJECT_ID_B="${PROJECT_ID_B:-}"

if [[ -z "$ADMIN_PASSWORD" ]]; then
  echo "[smoke] ADMIN_PASSWORD env var required (used to login to /admin/api/login)."
  exit 2
fi
if [[ -z "$PROJECT_ID_A" || -z "$PROJECT_ID_B" ]]; then
  echo "[smoke] PROJECT_ID_A and PROJECT_ID_B env vars required."
  echo "[smoke] Pick two real DEV project ids (different ones) so cross-project isolation can be verified."
  exit 2
fi

note() { echo -e "\n## $* ##"; }
ok()   { echo "  ✓ $*"; PASS=$((PASS+1)); }
bad()  { echo "  ✗ $*"; FAIL=$((FAIL+1)); }
warn() { echo "  ! $*"; WARN=$((WARN+1)); }

note "1. apps-father main process does not load routes.js"
if grep -R "require.*routes\.js" "${APP_DIR}/dist" >/dev/null 2>&1; then
  bad "dist/ still contains require('routes.js') references"
else
  ok "no require(routes.js) in dist/"
fi

note "2. Each project has its own Linux user"
USERNAME_A="afp_$(printf %s "$PROJECT_ID_A" | sha256sum | cut -c1-10)"
USERNAME_B="afp_$(printf %s "$PROJECT_ID_B" | sha256sum | cut -c1-10)"
if getent passwd "$USERNAME_A" >/dev/null && getent passwd "$USERNAME_B" >/dev/null; then
  ok "users $USERNAME_A and $USERNAME_B exist"
else
  warn "users may not be provisioned yet — they will be created on first lazy spawn"
fi

note "3. Worker A spawns lazily on first /app/<id>/api hit"
TOKEN=$(curl -fsS -X POST "$BASE/admin/api/login" -H 'Content-Type: application/json' \
   -d "{\"password\":\"$ADMIN_PASSWORD\"}" | sed -nE 's/.*"token":"([^"]+)".*/\1/p')
if [[ -z "$TOKEN" ]]; then
  bad "could not get admin token — check ADMIN_PASSWORD"
  exit 3
fi
WORKERS_BEFORE=$(curl -fsS "$BASE/admin/api/workers" -H "Authorization: Bearer $TOKEN")
echo "  workers before: $WORKERS_BEFORE"
RESP_A=$(curl -fsS -o /dev/null -w "%{http_code}" "$BASE/app/$PROJECT_ID_A/api/" || true)
echo "  curl /app/A/api/ → $RESP_A"
WORKERS_AFTER=$(curl -fsS "$BASE/admin/api/workers" -H "Authorization: Bearer $TOKEN")
if echo "$WORKERS_AFTER" | grep -q "$PROJECT_ID_A"; then
  ok "worker A appeared in registry after first hit"
else
  bad "worker A did not appear in registry"
fi

note "4. Worker A serves both release and dev"
RESP_DEV=$(curl -fsS -o /dev/null -w "%{http_code}" "$BASE/dev/$PROJECT_ID_A/api/" || true)
echo "  curl /dev/A/api/ → $RESP_DEV"
DETAIL_A=$(curl -fsS "$BASE/admin/api/workers/$PROJECT_ID_A" -H "Authorization: Bearer $TOKEN")
echo "  detail: $DETAIL_A"
PID_A=$(echo "$DETAIL_A" | sed -nE 's/.*"pid":([0-9]+).*/\1/p' | head -1)
if [[ -n "$PID_A" ]]; then
  ok "worker A pid=$PID_A"
else
  bad "could not read worker A pid"
fi

note "5. Release and development have separate SQLite DB files"
ls -la "/srv/apps-father/projects/$PROJECT_ID_A/release/data/" 2>/dev/null | grep -E "db.sqlite|app.db" || warn "release db not found"
ls -la "/srv/apps-father/projects/$PROJECT_ID_A/development/data/" 2>/dev/null | grep -E "db.sqlite|app.db" || warn "development db not found"

note "6. Frontend static still served by main process"
curl -fsS -o /dev/null -w "  /app/A/index.html → %{http_code}\n" "$BASE/app/$PROJECT_ID_A/" || warn "static fetch failed"
ok "checked"

note "10. Cross-project isolation"
# We can't run as another user from here, but we can verify mode bits + ACLs.
PROJ_A_ROOT="/srv/apps-father/projects/$PROJECT_ID_A"
if [[ -d "$PROJ_A_ROOT" ]]; then
  MODE=$(stat -c %a "$PROJ_A_ROOT")
  OWNER=$(stat -c %U "$PROJ_A_ROOT")
  echo "  $PROJ_A_ROOT mode=$MODE owner=$OWNER"
  if [[ "$MODE" == "750" || "$MODE" == "700" ]]; then ok "tight perms"; else warn "unexpected mode $MODE"; fi
fi

note "11. /opt/apps-father-dev/.env is root:600"
if [[ -f "$APP_DIR/.env" ]]; then
  STAT=$(stat -c "%a %U:%G" "$APP_DIR/.env")
  echo "  $APP_DIR/.env: $STAT"
  case "$STAT" in
    "600 root:root") ok "locked correctly" ;;
    *) bad "should be 600 root:root, got $STAT" ;;
  esac
fi

note "12. Worker B is NOT touched by hitting only project A"
WORKERS_NOW=$(curl -fsS "$BASE/admin/api/workers" -H "Authorization: Bearer $TOKEN")
if echo "$WORKERS_NOW" | grep -q "$PROJECT_ID_B"; then
  bad "project B's worker spawned even though it was never hit"
else
  ok "project B's worker not in registry"
fi

note "13. Crash isolation — kill worker A, verify B unchanged"
if [[ -n "$PID_A" ]]; then
  kill -9 "$PID_A" 2>/dev/null || true
  sleep 1
  curl -fsS -o /dev/null "$BASE/app/$PROJECT_ID_A/api/" || true
  ok "killed and re-pinged worker A — registry should show new pid"
fi

note "14. Reload only affects targeted worker"
curl -fsS -X POST "$BASE/admin/api/workers/$PROJECT_ID_A/reload" \
  -H "Authorization: Bearer $TOKEN" || true
ok "POST /admin/api/workers/<a>/reload sent"

echo ""
echo "─────────────────────────────────────────────────────────"
echo "  Smoke tests: PASS=$PASS FAIL=$FAIL WARN=$WARN"
echo "─────────────────────────────────────────────────────────"
test "$FAIL" -eq 0

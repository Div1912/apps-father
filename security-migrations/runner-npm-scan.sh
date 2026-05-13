#!/usr/bin/env bash
# ============================================================
#  runner-npm-scan.sh
#  Server-side scanner for runner npm packages.
#
#  - Reads %%APP_DIR%%/runner-npm-allowlist.json (deployed by the platform)
#  - Scans /srv/apps-father/projects/*/backend/routes.js for require()s
#  - For each third-party require:
#      * On the allowlist  → install if missing (with --ignore-scripts)
#      * Not on allowlist  → REJECTED (logged as a security warning)
#
#  This is the second line of defence behind the npm_install agent tool —
#  if any path bypasses the agent and writes a require() that's not allowed,
#  the package never gets installed and the worker fails fast on require().
# ============================================================
APP_DIR="%%APP_DIR%%"
SRV_PROJECTS="%%SRV_PROJECTS%%"
ALLOWLIST_FILE="$APP_DIR/runner-npm-allowlist.json"

# Node.js built-in modules — never need npm install
BUILTINS="assert|async_hooks|buffer|child_process|cluster|console|constants|crypto|dgram|diagnostics_channel|dns|domain|events|fs|http|http2|https|inspector|module|net|os|path|perf_hooks|process|punycode|querystring|readline|repl|stream|string_decoder|sys|timers|tls|trace_events|tty|url|util|v8|vm|wasi|worker_threads|zlib"

echo ""
echo "=== Scanning project routes.js files ==="
echo "  APP_DIR        : $APP_DIR"
echo "  SRV_PROJECTS   : $SRV_PROJECTS"
echo "  ALLOWLIST_FILE : $ALLOWLIST_FILE"
echo ""

# ── Load allowlist ─────────────────────────────────────────────────────────
if [ ! -f "$ALLOWLIST_FILE" ]; then
  echo "  ERROR: allowlist file not found at $ALLOWLIST_FILE"
  echo "  Run deploy.ps1 with the runner-npm-allowlist sync step first."
  exit 1
fi

# Extract allowed package names with node so we don't depend on jq.
ALLOWED=$(node -e "
const fs = require('fs');
try {
  const a = JSON.parse(fs.readFileSync(process.argv[1], 'utf-8'));
  console.log(Object.keys(a.allowedPackages || {}).join('\n'));
} catch (e) {
  console.error('ALLOWLIST_PARSE_FAIL: ' + e.message);
  process.exit(1);
}
" "$ALLOWLIST_FILE")
if [ -z "$ALLOWED" ]; then
  echo "  ERROR: allowlist parsed as empty. Refusing to proceed."
  exit 1
fi

ALLOWED_COUNT=$(echo "$ALLOWED" | wc -l)
echo "  Allowlist has $ALLOWED_COUNT package(s)"
echo ""

# ── Find routes.js files ───────────────────────────────────────────────────
ROUTES_FILES=$(find "$SRV_PROJECTS" -name "routes.js" -path "*/backend/routes.js" 2>/dev/null | sort)

if [ -z "$ROUTES_FILES" ]; then
  echo "  No routes.js files found under $SRV_PROJECTS"
  echo "  Nothing to do."
  exit 0
fi

FILE_COUNT=$(echo "$ROUTES_FILES" | wc -l)
echo "  Found $FILE_COUNT routes.js file(s)"
echo "$ROUTES_FILES" | sed 's/^/    /'
echo ""

# Extract all require() arguments
ALL_REQUIRES=$(echo "$ROUTES_FILES" | xargs grep -h "require(" 2>/dev/null \
  | grep -oP "require\(['\"]\\K[^'\"]+(?=['\"])" \
  | sort -u)

if [ -z "$ALL_REQUIRES" ]; then
  echo "  No require() calls found."
  exit 0
fi

# ── Filter requires ────────────────────────────────────────────────────────
# Strip relative paths, Node built-ins. Roll up sub-path imports
# (e.g. lodash/get → lodash, @scope/pkg/sub → @scope/pkg).
THIRD_PARTY=""
while IFS= read -r pkg; do
  [ -z "$pkg" ] && continue
  [[ "$pkg" == ./* || "$pkg" == ../* ]] && continue
  BARE="${pkg#node:}"
  if echo "$BARE" | grep -qE "^($BUILTINS)(/.*)?$"; then
    continue
  fi
  # Roll up sub-path import to parent package.
  if [[ "$BARE" == @*/* ]]; then
    # @scope/pkg or @scope/pkg/sub → @scope/pkg
    ROLLED=$(echo "$BARE" | awk -F'/' '{ print $1"/"$2 }')
  else
    # pkg or pkg/sub → pkg
    ROLLED="${BARE%%/*}"
  fi
  THIRD_PARTY="${THIRD_PARTY}"$'\n'"${ROLLED}"
done <<< "$ALL_REQUIRES"

THIRD_PARTY=$(echo "$THIRD_PARTY" | grep -v '^$' | sort -u)

if [ -z "$THIRD_PARTY" ]; then
  echo "  All require()s are Node built-ins — nothing to install."
  exit 0
fi

echo "  Third-party packages referenced across all projects:"
echo "$THIRD_PARTY" | sed 's/^/    - /'
echo ""

# ── Allowlist gate ─────────────────────────────────────────────────────────
echo "=== Allowlist check ==="
ALLOWED_LIST=""
REJECTED_LIST=""
while IFS= read -r pkg; do
  [ -z "$pkg" ] && continue
  if echo "$ALLOWED" | grep -qFx "$pkg"; then
    echo "  [ALLOWED]  $pkg"
    ALLOWED_LIST="$ALLOWED_LIST $pkg"
  else
    echo "  [REJECTED] $pkg  (NOT on runner-npm-allowlist.json — package will NOT be installed)"
    REJECTED_LIST="$REJECTED_LIST $pkg"
  fi
done <<< "$THIRD_PARTY"
echo ""

if [ -n "$REJECTED_LIST" ]; then
  echo "  WARNING: $(echo $REJECTED_LIST | wc -w) package(s) rejected by allowlist."
  echo "           These projects will fail at require() until the allowlist is extended"
  echo "           or the project's routes.js is fixed."
  echo ""
fi

if [ -z "$ALLOWED_LIST" ]; then
  echo "=== Nothing to install (no allowlisted packages referenced). ==="
  exit 0
fi

# ── Check installation status ──────────────────────────────────────────────
echo "=== Checking installation status ==="
MISSING=""
for pkg in $ALLOWED_LIST; do
  if (cd "$APP_DIR" && node -e "require('$pkg')") > /dev/null 2>&1; then
    echo "  [OK]      $pkg"
  else
    echo "  [MISSING] $pkg"
    MISSING="$MISSING $pkg"
  fi
done
echo ""

MISSING=$(echo $MISSING | xargs)

if [ -z "$MISSING" ]; then
  echo "=== All allowed packages already installed. Nothing to do. ==="
  exit 0
fi

# ── Install missing packages ───────────────────────────────────────────────
# --ignore-scripts disables npm pre/post-install hooks. This is the single
# biggest defence against supply-chain attacks: a malicious lifecycle script
# in a transitive dep cannot run as root on `npm install`.
echo "=== Installing missing packages (--ignore-scripts) ==="
echo "  $MISSING"
echo ""
cd "$APP_DIR"
npm install --save --ignore-scripts --no-audit --no-fund $MISSING 2>&1
INSTALL_RC=$?
echo ""
if [ $INSTALL_RC -ne 0 ]; then
  echo "=== ERROR: npm install exited with code $INSTALL_RC ==="
  exit $INSTALL_RC
fi

echo "=== Done. ==="
echo "  Installed: $MISSING"
if [ -n "$REJECTED_LIST" ]; then
  echo "  Rejected (NOT installed): $REJECTED_LIST"
fi
echo "  Restart PM2 to make packages available to running workers."

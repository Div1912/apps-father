# ============================================================
#  deploy.ps1  --  Interactive deploy wizard
#  Controls: UP/DOWN move  SPACE toggle  TAB switch env
#            A=all  N=none  ENTER=deploy  Q=quit
# ============================================================

Set-StrictMode -Off

$PREFS_FILE = Join-Path $PSScriptRoot "deploy-prefs.json"
$TEMP_ZIP   = Join-Path $PSScriptRoot ".deploy_tmp.zip"

$STEPS = @(
  [pscustomobject]@{ id="build";           label="Build (tsc)";                  default=$true  }
  [pscustomobject]@{ id="dist";            label="Upload dist/ (zip)";           default=$true  }
  [pscustomobject]@{ id="mini_app";        label="Upload mini_app/ (zip)";       default=$true  }
  [pscustomobject]@{ id="landing";         label="Upload landing/ (zip)";        default=$false }
  [pscustomobject]@{ id="admin";           label="Upload admin/ (zip)";          default=$false }
  [pscustomobject]@{ id="env";             label="Sync .env";                    default=$false }
  [pscustomobject]@{ id="deps";            label="npm install on server";        default=$false }
  [pscustomobject]@{ id="playwright";      label="Install Playwright Chromium";  default=$false }
  [pscustomobject]@{ id="prisma";          label="Prisma generate";              default=$false }
  [pscustomobject]@{ id="migrations";      label="DB migrations (batched)";      default=$false }
  [pscustomobject]@{ id="agent_knowledge"; label="Upload agent_knowledge/ (zip)";default=$true  }
  [pscustomobject]@{ id="runner";          label="Upload runner/ (worker code)"; default=$false }
  [pscustomobject]@{ id="runner_install";  label="Run runner/install-runner.sh"; default=$false }
  [pscustomobject]@{ id="runner_image";    label="Rebuild apps-father-runner Docker image"; default=$false }
  [pscustomobject]@{ id="runner_recreate"; label="Recreate worker containers (apply new image)"; default=$false }
  [pscustomobject]@{ id="npm_allowlist";   label="Sync runner-npm-allowlist.json";default=$true }
  [pscustomobject]@{ id="restart";         label="Restart PM2";                  default=$true  }
)

# Load saved prefs (PS 5.1-compatible: ConvertFrom-Json returns PSCustomObject, not hashtable)
$saved = @{}
if (Test-Path $PREFS_FILE) {
  try {
    $json = Get-Content $PREFS_FILE -Raw | ConvertFrom-Json
    $json.PSObject.Properties | ForEach-Object { $saved[$_.Name] = $_.Value }
  } catch {}
}

$env_idx = if ($saved.ContainsKey("env_idx")) { [int]$saved["env_idx"] } else { 0 }
$checked = @{}
foreach ($s in $STEPS) {
  if ($saved.ContainsKey($s.id)) {
    $v = $saved[$s.id]
    # JSON booleans can deserialize as bool or as string depending on PS version
    $checked[$s.id] = if ($v -is [bool]) { $v } else { $v -eq $true -or "$v" -eq "True" }
  } else {
    $checked[$s.id] = $s.default
  }
}

$ENVS       = @("DEV", "PROD")
$ENV_COLORS = @("Yellow", "Cyan")

# Write a line padded to full console width so redraws overwrite ghost chars
function W {
  param($text, $color)
  $w = [Math]::Max(40, $Host.UI.RawUI.WindowSize.Width)
  $padded = $text.PadRight($w)
  if ($color) { Write-Host $padded -ForegroundColor $color }
  else        { Write-Host $padded }
}

function Draw-TUI {
  param([int]$cursor)
  [Console]::SetCursorPosition(0, 0)
  $env = $ENVS[$env_idx]
  $ec  = $ENV_COLORS[$env_idx]

  W ""
  W "  +---------------------------------------------------+" DarkGray
  W "  |        APPS FATHER  --  Deploy Wizard             |" DarkGray
  W "  +---------------------------------------------------+" DarkGray
  W ""
  W ("  Target: [ " + $env + " ]   (TAB to switch)") $ec
  W ""
  W "  UP/DOWN=move  SPACE=toggle  A=all  N=none  ENTER=deploy  Q=quit" DarkGray
  W ""

  for ($i = 0; $i -lt $STEPS.Count; $i++) {
    $s        = $STEPS[$i]
    $chk      = if ($checked[$s.id]) { "X" } else { " " }
    $isActive = ($i -eq $cursor)
    $prefix   = if ($isActive) { "  > " } else { "    " }
    $bracket  = "[" + $chk + "] "
    $line     = $prefix + $bracket + $s.label

    $w = [Math]::Max(40, $Host.UI.RawUI.WindowSize.Width)
    $padded = $line.PadRight($w)

    if ($isActive) {
      Write-Host -NoNewline "  > "           -ForegroundColor Cyan
    } else {
      Write-Host -NoNewline "    "           -ForegroundColor DarkGray
    }
    $chkColor = if ($checked[$s.id]) { "Green" } else { "DarkGray" }
    Write-Host -NoNewline $bracket           -ForegroundColor $chkColor
    $labelPadded = ($s.label).PadRight($w - ($prefix.Length + $bracket.Length))
    if ($isActive) {
      Write-Host $labelPadded               -ForegroundColor White
    } else {
      Write-Host $labelPadded               -ForegroundColor Gray
    }
  }

  $selCount = ($checked.Values | Where-Object { $_ -eq $true }).Count
  W ""
  W ("  " + $selCount + " step(s) selected") DarkGray
  W ""
}

# TUI loop
[Console]::CursorVisible = $false
Clear-Host

$cursor      = 0
$linesNeeded = $STEPS.Count + 14
for ($p = 0; $p -lt $linesNeeded; $p++) { Write-Host "" }

Draw-TUI -cursor $cursor

while ($true) {
  $key = [Console]::ReadKey($true)

  switch ($key.Key) {
    "UpArrow"   { $cursor = [Math]::Max(0, $cursor - 1) }
    "DownArrow" { $cursor = [Math]::Min($STEPS.Count - 1, $cursor + 1) }
    "Spacebar"  { $checked[$STEPS[$cursor].id] = -not $checked[$STEPS[$cursor].id] }
    "Tab"       { $env_idx = ($env_idx + 1) % $ENVS.Count }
    "A"         { foreach ($s in $STEPS) { $checked[$s.id] = $true  } }
    "N"         { foreach ($s in $STEPS) { $checked[$s.id] = $false } }
    "Enter"     { break }
    "Escape"    { [Console]::CursorVisible = $true; Clear-Host; exit 0 }
    "Q"         { [Console]::CursorVisible = $true; Clear-Host; exit 0 }
  }

  if ($key.Key -eq "Enter") { break }
  Draw-TUI -cursor $cursor
}

[Console]::CursorVisible = $true
Clear-Host

# Save prefs
$prefs = @{ env_idx = $env_idx }
foreach ($s in $STEPS) { $prefs[$s.id] = $checked[$s.id] }
$prefs | ConvertTo-Json | Set-Content $PREFS_FILE

# Resolve server config
if ($env_idx -eq 0) {
  $ENV_NAME = "DEV"
  $SERVER   = "root@89.167.51.255"
  $APP_DIR  = "/root/app-father-dev/apps-father"
  $PM2      = "apps-father-dev"
  $DB_CTR   = "apps_father_dev_db"
  $DB_USER  = "apps_father"
  $DB_NAME  = "apps_father"
  $COLOR    = "Yellow"
} else {
  $ENV_NAME = "PROD"
  $SERVER   = "root@138.199.141.66"
  $APP_DIR  = "/opt/apps-father"
  $PM2      = "apps-father"
  $DB_CTR   = "apps_father_db"
  $DB_USER  = "apps_father"
  $DB_NAME  = "apps_father"
  $COLOR    = "Cyan"
}

Write-Host (">>> Deploying to " + $ENV_NAME + " <<<") -ForegroundColor $COLOR
Write-Host ""

function Step-Header { param($msg); Write-Host ("=== [" + $ENV_NAME + "] " + $msg + " ===") -ForegroundColor $COLOR }
function Step-OK     { param($msg); Write-Host ("  OK: " + $msg) -ForegroundColor Green }
function Step-Err    {
  param($msg)
  Write-Host ("  FAIL: " + $msg) -ForegroundColor Red
  if (Test-Path $TEMP_ZIP) { Remove-Item $TEMP_ZIP -Force }
  exit 1
}

function Upload-Zipped {
  param([string]$localDir, [string]$remoteDest, [string]$label)
  Step-Header ("Uploading " + $label + " via zip")
  if (Test-Path $TEMP_ZIP) { Remove-Item $TEMP_ZIP -Force }

  $items = Get-ChildItem -Path $localDir
  if ($items.Count -eq 0) {
    Step-OK ($label + " empty, skipped")
    return
  }

  Compress-Archive -Path ($localDir + "\*") -DestinationPath $TEMP_ZIP -Force
  $sizeMB = [Math]::Round((Get-Item $TEMP_ZIP).Length / 1MB, 1)

  $extractPy = Join-Path $PSScriptRoot ".extract_tmp.py"
  Set-Content -Path $extractPy -Encoding utf8 -Value @"
import sys, zipfile, os
zip_path, dest = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(zip_path) as z:
    for member in z.infolist():
        member.filename = member.filename.replace('\\', '/')
        if member.filename.endswith('/'):
            os.makedirs(os.path.join(dest, member.filename), exist_ok=True)
        else:
            z.extract(member, dest)
os.remove(zip_path)
print('OK: extracted', len(z.infolist()), 'entries')
"@

  scp -q $TEMP_ZIP  ($SERVER + ":/tmp/deploy_upload.zip")
  if ($LASTEXITCODE -ne 0) { Step-Err ("scp failed for " + $label) }
  scp -q $extractPy ($SERVER + ":/tmp/extract_deploy.py")
  if ($LASTEXITCODE -ne 0) { Step-Err ("scp script failed for " + $label) }

  ssh $SERVER ("mkdir -p " + $remoteDest + " && python3 /tmp/extract_deploy.py /tmp/deploy_upload.zip " + $remoteDest + " && rm -f /tmp/extract_deploy.py")
  if ($LASTEXITCODE -ne 0) { Step-Err ("extract failed for " + $label) }

  Remove-Item $extractPy -Force -ErrorAction SilentlyContinue
  Remove-Item $TEMP_ZIP  -Force
  Step-OK ($label + " uploaded - " + $sizeMB + " MB zipped")
}

# ---- Build ----
if ($checked["build"]) {
  Step-Header "Building"
  npx tsc --project tsconfig.json
  if ($LASTEXITCODE -ne 0) { Step-Err "Build failed" }
  Copy-Item "src/web/routes/af-devtools.js" "dist/web/routes/af-devtools.js" -Force
  Copy-Item "src/web/routes/af-sdk.js"      "dist/web/routes/af-sdk.js"      -Force
  Step-OK "Build complete"
}

# ---- dist ----
if ($checked["dist"]) {
  Upload-Zipped "dist" ($APP_DIR + "/dist") "dist"
}

# ---- mini_app ----
if ($checked["mini_app"]) {
  ssh $SERVER ("mkdir -p " + $APP_DIR + "/mini_app")
  Upload-Zipped "mini_app" ($APP_DIR + "/mini_app") "mini_app"
}

# ---- landing ----
if ($checked["landing"]) {
  Copy-Item "src\web\routes\af-sdk.js" "landing\af-sdk.js" -Force
  ssh $SERVER ("mkdir -p " + $APP_DIR + "/landing/samples")
  Upload-Zipped "landing" ($APP_DIR + "/landing") "landing"
}

# ---- admin ----
if ($checked["admin"]) {
  ssh $SERVER ("mkdir -p " + $APP_DIR + "/admin")
  Upload-Zipped "admin" ($APP_DIR + "/admin") "admin"
}

# ---- .env ----
if ($checked["env"]) {
  if ($ENV_NAME -eq "DEV") {
    $envSource = "dev.env"
  } else {
    $envSource = ".env"
  }
  if (-not (Test-Path $envSource)) {
    Step-Err ("Env file not found: " + $envSource)
  }
  Step-Header ("Syncing " + $envSource)
  scp $envSource ($SERVER + ":" + $APP_DIR + "/.env")
  if ($LASTEXITCODE -ne 0) { Step-Err "Env sync failed" }
  Step-OK ".env synced"
}

# ---- npm install ----
if ($checked["deps"]) {
  Step-Header "Syncing package.json and deps"
  scp package.json ($SERVER + ":" + $APP_DIR + "/package.json")
  ssh $SERVER ("cd " + $APP_DIR + " && npm install --omit=dev --no-audit --no-fund 2>&1 | tail -3")
  if ($LASTEXITCODE -ne 0) { Step-Err "npm install failed" }
  Step-OK "Deps installed"
}

# ---- Playwright ----
if ($checked["playwright"]) {
  Step-Header "Installing Playwright Chromium"
  ssh $SERVER ("cd " + $APP_DIR + " && npx playwright install chromium --with-deps")
  if ($LASTEXITCODE -ne 0) { Step-Err "Playwright install failed" }
  Step-OK "Playwright OK"
}

# ---- Prisma ----
if ($checked["prisma"]) {
  Step-Header "Prisma generate"
  scp prisma/schema.prisma ($SERVER + ":" + $APP_DIR + "/prisma/schema.prisma")
  ssh $SERVER ("cd " + $APP_DIR + " && npx prisma generate --no-hints")
  if ($LASTEXITCODE -ne 0) { Step-Err "Prisma generate failed" }
  Step-OK "Prisma OK"
}

# ---- DB migrations (all batched into one SQL file) ----
if ($checked["migrations"]) {
  Step-Header "DB migrations"

  $sqlLines = [System.Collections.Generic.List[string]]::new()
  $sqlLines.Add("ALTER TABLE projects ADD COLUMN IF NOT EXISTS release_commit INT;")
  # Per-project worker runtime (DEV): isolate routes.js into per-project Node workers.
  $sqlLines.Add("ALTER TABLE projects ADD COLUMN IF NOT EXISTS worker_port INT;")
  $sqlLines.Add("ALTER TABLE projects ADD COLUMN IF NOT EXISTS worker_username TEXT;")
  $sqlLines.Add("CREATE UNIQUE INDEX IF NOT EXISTS projects_worker_port_unique ON projects(worker_port) WHERE worker_port IS NOT NULL;")
  $sqlLines.Add("ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by BIGINT;")
  $sqlLines.Add("ALTER TABLE users ADD COLUMN IF NOT EXISTS language TEXT;")
  $sqlLines.Add("ALTER TABLE users ADD COLUMN IF NOT EXISTS is_partner BOOLEAN DEFAULT false;")
  $sqlLines.Add("ALTER TABLE users ADD COLUMN IF NOT EXISTS partner_percent DECIMAL(5,2);")
  $sqlLines.Add("ALTER TABLE users ADD COLUMN IF NOT EXISTS partner_tag TEXT UNIQUE;")
  $sqlLines.Add("ALTER TABLE users ADD COLUMN IF NOT EXISTS partner_referral_bonus DECIMAL(12,4);")
  $sqlLines.Add("ALTER TABLE users ADD COLUMN IF NOT EXISTS partner_balance DECIMAL(12,4) DEFAULT 0;")
  $sqlLines.Add("ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_notified_at TIMESTAMPTZ;")
  $sqlLines.Add("ALTER TABLE users ADD COLUMN IF NOT EXISTS sub_bonus_claimed_at TIMESTAMPTZ;")
  $sqlLines.Add("ALTER TABLE users ADD COLUMN IF NOT EXISTS credits INTEGER NOT NULL DEFAULT 0;")
  $sqlLines.Add("ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_tags TEXT;")
  $sqlLines.Add("ALTER TABLE users ADD COLUMN IF NOT EXISTS performance_tier TEXT NOT NULL DEFAULT 'tier_1';")
  $sqlLines.Add("ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS credits_charged INTEGER;")
  $sqlLines.Add("ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS tier_id TEXT;")
  $sqlLines.Add("ALTER TABLE projects ADD COLUMN IF NOT EXISTS app_description TEXT;")
  $sqlLines.Add("ALTER TABLE projects ADD COLUMN IF NOT EXISTS app_long_description TEXT;")
  $sqlLines.Add("ALTER TABLE projects ADD COLUMN IF NOT EXISTS app_menu_button_text TEXT;")
  $sqlLines.Add("ALTER TABLE payments ADD COLUMN IF NOT EXISTS bundle_id TEXT REFERENCES bundles(id);")
  $sqlLines.Add("ALTER TABLE payments ADD COLUMN IF NOT EXISTS credits_granted INTEGER;")
  $sqlLines.Add("ALTER TABLE payments ADD COLUMN IF NOT EXISTS bonus_credits INTEGER;")
  $sqlLines.Add("ALTER TABLE payments ADD COLUMN IF NOT EXISTS method TEXT;")
  $sqlLines.Add("CREATE TABLE IF NOT EXISTS vouchers (id SERIAL PRIMARY KEY, code TEXT UNIQUE NOT NULL, amount_usd DECIMAL(12,4) NOT NULL, max_uses INT NOT NULL, used_count INT DEFAULT 0, active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT NOW());")
  $sqlLines.Add("ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS credits INTEGER NOT NULL DEFAULT 0;")
  $sqlLines.Add("ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS paying_only BOOLEAN NOT NULL DEFAULT false;")
  $sqlLines.Add("CREATE TABLE IF NOT EXISTS voucher_redemptions (id SERIAL PRIMARY KEY, voucher_id INT NOT NULL REFERENCES vouchers(id), user_id INT NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(voucher_id, user_id));")
  $sqlLines.Add("CREATE TABLE IF NOT EXISTS withdrawals (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), amount_usd DECIMAL(12,4) NOT NULL, ton_address TEXT NOT NULL, status TEXT DEFAULT 'pending', tx_hash TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), processed_at TIMESTAMPTZ);")
  $sqlLines.Add("CREATE TABLE IF NOT EXISTS ton_withdrawals (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), amount_ton DECIMAL(18,9) NOT NULL, ton_address TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', tx_hash TEXT, admin_note TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), processed_at TIMESTAMPTZ);")
  $sqlLines.Add("CREATE INDEX IF NOT EXISTS ton_withdrawals_user_id_idx ON ton_withdrawals(user_id);")
  $sqlLines.Add("CREATE INDEX IF NOT EXISTS ton_withdrawals_status_idx ON ton_withdrawals(status);")
  $sqlLines.Add("CREATE TABLE IF NOT EXISTS retention_pushes (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, scenario TEXT NOT NULL, sent_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(user_id, scenario));")
  $sqlLines.Add("CREATE INDEX IF NOT EXISTS retention_pushes_user_id_idx ON retention_pushes(user_id);")
  $sqlLines.Add("CREATE TABLE IF NOT EXISTS agent_sessions (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL, user_id INT REFERENCES users(id) ON DELETE SET NULL, type TEXT NOT NULL, model TEXT NOT NULL, input TEXT NOT NULL, output TEXT, credits_charged INT NOT NULL DEFAULT 0, cost_usd DECIMAL(12,6) NOT NULL DEFAULT 0, input_tokens INT NOT NULL DEFAULT 0, output_tokens INT NOT NULL DEFAULT 0, duration_ms INT, success BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());")
  $sqlLines.Add("CREATE INDEX IF NOT EXISTS agent_sessions_project_created ON agent_sessions(project_id, created_at DESC);")
  $sqlLines.Add("CREATE INDEX IF NOT EXISTS agent_sessions_user_created ON agent_sessions(user_id, created_at DESC);")
  $sqlLines.Add("CREATE INDEX IF NOT EXISTS agent_sessions_type_created ON agent_sessions(type, created_at DESC);")
  $sqlLines.Add("ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS complexity TEXT;")
  $sqlLines.Add("ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS is_max_mode BOOLEAN NOT NULL DEFAULT FALSE;")
  $sqlLines.Add("ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS cost_usd_input DECIMAL(12,6);")
  $sqlLines.Add("ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS cost_usd_output DECIMAL(12,6);")
  $sqlLines.Add("CREATE TABLE IF NOT EXISTS admin_user_notes (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, body TEXT NOT NULL, author_tag TEXT NOT NULL DEFAULT 'admin', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());")
  $sqlLines.Add("CREATE INDEX IF NOT EXISTS admin_user_notes_user_id_idx ON admin_user_notes(user_id);")
  $sqlLines.Add("CREATE TABLE IF NOT EXISTS app_logs (id BIGSERIAL PRIMARY KEY, ts TIMESTAMP(3) NOT NULL DEFAULT NOW(), project_id TEXT NULL REFERENCES projects(id) ON DELETE SET NULL, category TEXT NOT NULL, level TEXT NOT NULL, source TEXT NOT NULL, message TEXT NOT NULL);")
  $sqlLines.Add("CREATE INDEX IF NOT EXISTS app_logs_ts_desc_idx ON app_logs (ts DESC);")
  $sqlLines.Add("CREATE INDEX IF NOT EXISTS app_logs_project_ts_idx ON app_logs (project_id, ts DESC);")
  $sqlLines.Add("CREATE INDEX IF NOT EXISTS app_logs_category_ts_idx ON app_logs (category, ts DESC);")
  $sqlLines.Add("CREATE INDEX IF NOT EXISTS app_logs_project_cat_ts_idx ON app_logs (project_id, category, ts DESC);")
  $sqlLines.Add("CREATE TABLE IF NOT EXISTS bundles (id TEXT PRIMARY KEY, name TEXT NOT NULL, credits INTEGER NOT NULL, bonus_credits INTEGER NOT NULL DEFAULT 0, price_usd DECIMAL(12,4) NOT NULL, discount INTEGER NOT NULL DEFAULT 0, is_limited BOOLEAN NOT NULL DEFAULT false, limit_total INTEGER, purchase_count INTEGER NOT NULL DEFAULT 0, is_active BOOLEAN NOT NULL DEFAULT true, sort_order INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());")
  $sqlLines.Add("ALTER TABLE users ALTER COLUMN app_slots SET DEFAULT 5;")
  $sqlLines.Add("UPDATE users SET admin_notified_at = created_at WHERE admin_notified_at IS NULL;")

  # ── App Store ──────────────────────────────────────────────────────────
  $sqlLines.Add("CREATE TABLE IF NOT EXISTS app_listings (id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'draft', short_description VARCHAR(120), long_description TEXT, socials JSONB, category TEXT, screenshots JSONB, publish_fee_tx_hash TEXT, submitted_at TIMESTAMPTZ, approved_at TIMESTAMPTZ, approved_by INT, rejected_reason TEXT, published_at TIMESTAMPTZ, hidden BOOLEAN NOT NULL DEFAULT false, volume_24h_nano_ton BIGINT NOT NULL DEFAULT 0, market_cap_nano_ton BIGINT NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());")
  $sqlLines.Add("CREATE INDEX IF NOT EXISTS app_listings_status_hidden_idx ON app_listings(status, hidden);")
  # New columns for the redesigned 7-step publish flow (idempotent).
  $sqlLines.Add("ALTER TABLE app_listings ADD COLUMN IF NOT EXISTS tags JSONB;")
  $sqlLines.Add("ALTER TABLE app_listings ADD COLUMN IF NOT EXISTS banner_filename TEXT;")
  $sqlLines.Add("CREATE TABLE IF NOT EXISTS app_tokens (id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE, listing_id TEXT NOT NULL UNIQUE REFERENCES app_listings(id) ON DELETE CASCADE, name TEXT NOT NULL, symbol TEXT NOT NULL, logo_filename TEXT NOT NULL, jetton_master_address TEXT UNIQUE, deploy_tx_hash TEXT, total_supply BIGINT NOT NULL, curve_supply_cap BIGINT NOT NULL, virtual_ton_reserve BIGINT NOT NULL, virtual_token_reserve BIGINT NOT NULL, real_ton_reserve BIGINT NOT NULL DEFAULT 0, sold_supply BIGINT NOT NULL DEFAULT 0, fee_balance_nano_ton BIGINT NOT NULL DEFAULT 0, creator_fee_balance_nano_ton BIGINT NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending_deploy', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());")
  $sqlLines.Add("CREATE TABLE IF NOT EXISTS token_trades (id TEXT PRIMARY KEY, token_id TEXT NOT NULL REFERENCES app_tokens(id), user_id INT NOT NULL, type TEXT NOT NULL, ton_amount BIGINT NOT NULL, token_amount BIGINT NOT NULL, price_nano_ton BIGINT NOT NULL, fee_ton_amount BIGINT NOT NULL, tx_hash_in TEXT, tx_hash_out TEXT, status TEXT NOT NULL DEFAULT 'pending_payment', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), settled_at TIMESTAMPTZ);")
  $sqlLines.Add("CREATE INDEX IF NOT EXISTS token_trades_token_created_idx ON token_trades(token_id, created_at);")
  $sqlLines.Add("CREATE INDEX IF NOT EXISTS token_trades_user_idx ON token_trades(user_id);")
  $sqlLines.Add("CREATE INDEX IF NOT EXISTS token_trades_status_idx ON token_trades(status);")
  $sqlLines.Add("CREATE TABLE IF NOT EXISTS token_holdings (token_id TEXT NOT NULL REFERENCES app_tokens(id), user_id INT NOT NULL, balance BIGINT NOT NULL DEFAULT 0, avg_buy_nano_ton BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (token_id, user_id));")
  $sqlLines.Add("CREATE INDEX IF NOT EXISTS token_holdings_user_idx ON token_holdings(user_id);")

  # ── App Store V2: on-chain user-deployed jetton + LP pool ──
  # Add new columns to app_tokens (idempotent — IF NOT EXISTS).
  $sqlLines.Add("ALTER TABLE app_tokens ADD COLUMN IF NOT EXISTS owner_wallet_address TEXT;")
  $sqlLines.Add("ALTER TABLE app_tokens ADD COLUMN IF NOT EXISTS real_token_reserve BIGINT NOT NULL DEFAULT 0;")
  $sqlLines.Add("ALTER TABLE app_tokens ADD COLUMN IF NOT EXISTS lp_total_shares BIGINT NOT NULL DEFAULT 0;")
  # Optional Jetton metadata description (TIP-64). Empty by default to mirror minter.ton.org.
  $sqlLines.Add("ALTER TABLE app_tokens ADD COLUMN IF NOT EXISTS metadata_description TEXT;")
  $sqlLines.Add("ALTER TABLE app_tokens ALTER COLUMN curve_supply_cap SET DEFAULT 0;")
  $sqlLines.Add("ALTER TABLE app_tokens ALTER COLUMN virtual_ton_reserve SET DEFAULT 0;")
  $sqlLines.Add("ALTER TABLE app_tokens ALTER COLUMN virtual_token_reserve SET DEFAULT 0;")

  $sqlLines.Add("CREATE TABLE IF NOT EXISTS liquidity_positions (id TEXT PRIMARY KEY, token_id TEXT NOT NULL REFERENCES app_tokens(id) ON DELETE CASCADE, user_id INT, owner_wallet_address TEXT NOT NULL, shares BIGINT NOT NULL DEFAULT 0, cum_ton_deposited_nano BIGINT NOT NULL DEFAULT 0, cum_token_deposited BIGINT NOT NULL DEFAULT 0, cum_ton_withdrawn_nano BIGINT NOT NULL DEFAULT 0, cum_token_withdrawn BIGINT NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());")
  $sqlLines.Add("CREATE UNIQUE INDEX IF NOT EXISTS liquidity_positions_token_owner_idx ON liquidity_positions(token_id, owner_wallet_address);")
  $sqlLines.Add("CREATE INDEX IF NOT EXISTS liquidity_positions_user_idx ON liquidity_positions(user_id);")
  $sqlLines.Add("CREATE INDEX IF NOT EXISTS liquidity_positions_token_idx ON liquidity_positions(token_id);")

  $sqlLines.Add("CREATE TABLE IF NOT EXISTS liquidity_events (id TEXT PRIMARY KEY, token_id TEXT NOT NULL REFERENCES app_tokens(id) ON DELETE CASCADE, position_id TEXT, owner_wallet_address TEXT NOT NULL, type TEXT NOT NULL, ton_nano BIGINT NOT NULL, token_amount BIGINT NOT NULL, shares BIGINT NOT NULL, tx_hash TEXT, status TEXT NOT NULL DEFAULT 'settled', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());")
  $sqlLines.Add("CREATE INDEX IF NOT EXISTS liquidity_events_token_created_idx ON liquidity_events(token_id, created_at);")
  $sqlLines.Add("CREATE INDEX IF NOT EXISTS liquidity_events_owner_idx ON liquidity_events(owner_wallet_address);")

  # ── Balance Ledger ─────────────────────────────────────────────────────────
  $sqlLines.Add("CREATE TABLE IF NOT EXISTS balance_ledger (id BIGSERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, currency TEXT NOT NULL, amount DECIMAL(18,9) NOT NULL, source TEXT NOT NULL, meta JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());")
  $sqlLines.Add("CREATE INDEX IF NOT EXISTS balance_ledger_user_created_idx ON balance_ledger(user_id, created_at DESC);")
  $sqlLines.Add("CREATE INDEX IF NOT EXISTS balance_ledger_created_idx ON balance_ledger(created_at DESC);")

  # ── Fix missing ON DELETE CASCADE on user FK constraints ───────────────────
  $sqlLines.Add(@"
DO `$`$ BEGIN
  -- ton_withdrawals
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name='ton_withdrawals_user_id_fkey') THEN
    ALTER TABLE ton_withdrawals DROP CONSTRAINT ton_withdrawals_user_id_fkey;
  END IF;
  ALTER TABLE ton_withdrawals ADD CONSTRAINT ton_withdrawals_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  -- withdrawals
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name='withdrawals_user_id_fkey') THEN
    ALTER TABLE withdrawals DROP CONSTRAINT withdrawals_user_id_fkey;
  END IF;
  ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  -- voucher_redemptions
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name='voucher_redemptions_user_id_fkey') THEN
    ALTER TABLE voucher_redemptions DROP CONSTRAINT voucher_redemptions_user_id_fkey;
  END IF;
  ALTER TABLE voucher_redemptions ADD CONSTRAINT voucher_redemptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  -- ton_topups
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name='ton_topups_user_id_fkey') THEN
    ALTER TABLE ton_topups DROP CONSTRAINT ton_topups_user_id_fkey;
  END IF;
  ALTER TABLE ton_topups ADD CONSTRAINT ton_topups_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
END `$`$;
"@)

  # ── TON Top-ups ────────────────────────────────────────────────────────────
  $sqlLines.Add("CREATE TABLE IF NOT EXISTS ton_topups (id TEXT PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), amount_ton DECIMAL(18,9) NOT NULL, amount_nano TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', tx_hash TEXT, confirmed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());")
  $sqlLines.Add("CREATE INDEX IF NOT EXISTS ton_topups_user_id_idx ON ton_topups(user_id);")
  $sqlLines.Add("CREATE INDEX IF NOT EXISTS ton_topups_status_idx ON ton_topups(status);")

  # Append external SQL files
  $sqlFiles = @(
    "deploy/sql/tasks_system.sql"
    "deploy/sql/welcome_credits_tier0.sql"
    "deploy/sql/welcome_credits_50.sql"
    "deploy/sql/agent_lessons.sql"
    "deploy/sql/agent_feedback.sql"
    "deploy/sql/usage_log_task_id.sql"
    "deploy/sql/last_task_id.sql"
    "deploy/sql/credits_tiers_prisma.sql"
    "deploy/sql/bundles_system.sql"
    "deploy/sql/user_ton_balance.sql"
    "deploy/sql/app_listing_v2_fields.sql"
    "deploy/sql/agent_sessions.sql"
  )
  foreach ($f in $sqlFiles) {
    if (Test-Path $f) { $sqlLines.Add((Get-Content $f -Raw)) }
  }

  $sqlLines | Out-File -Encoding utf8 -FilePath "tmp_migrations.sql"
  scp -q tmp_migrations.sql ($SERVER + ":/tmp/all_migrations.sql")
  if ($LASTEXITCODE -ne 0) { Step-Err "scp migrations failed" }

  ssh $SERVER ("docker cp /tmp/all_migrations.sql " + $DB_CTR + ":/tmp/all_migrations.sql")
  ssh $SERVER ("docker exec " + $DB_CTR + " psql -U " + $DB_USER + " -d " + $DB_NAME + " -f /tmp/all_migrations.sql -v ON_ERROR_STOP=0 2>&1 | grep -E ERROR.FATAL | head -10")
  ssh $SERVER "rm /tmp/all_migrations.sql"
  Remove-Item tmp_migrations.sql -ErrorAction SilentlyContinue
  Step-OK "Migrations applied"
}

# ---- agent_knowledge ----
# NOTE: must use scp -r, NOT Upload-Zipped. PowerShell's Compress-Archive produces
# Windows backslash paths inside the zip; Python extractall on Linux treats them as
# literal filenames and never creates subdirectories — existing files are not overwritten.
if ($checked["agent_knowledge"]) {
  Step-Header "Uploading agent_knowledge via scp"
  ssh $SERVER ("mkdir -p " + $APP_DIR + "/agent_knowledge/instructions " + $APP_DIR + "/agent_knowledge/skills " + $APP_DIR + "/agent_knowledge/ask/topics")
  scp -r agent_knowledge/instructions/* ($SERVER + ":" + $APP_DIR + "/agent_knowledge/instructions/")
  if ($LASTEXITCODE -ne 0) { Step-Err "agent_knowledge/instructions upload failed" }
  scp -r agent_knowledge/skills/* ($SERVER + ":" + $APP_DIR + "/agent_knowledge/skills/")
  if ($LASTEXITCODE -ne 0) { Step-Err "agent_knowledge/skills upload failed" }
  scp -r agent_knowledge/ask/* ($SERVER + ":" + $APP_DIR + "/agent_knowledge/ask/")
  if ($LASTEXITCODE -ne 0) { Step-Err "agent_knowledge/ask upload failed" }
  Step-OK "agent_knowledge uploaded"
}

# ---- runner ----
# Per-project worker runtime. Plain JS, no compile step. scp the runner/
# tree into ${APP_DIR}/runner/ so worker-entry.js + lib/* are in the layout
# expected by runner-manager.service.ts (which resolves ../../runner from dist).
if ($checked["runner"]) {
  Step-Header "Uploading runner via scp"
  ssh $SERVER ("mkdir -p " + $APP_DIR + "/runner/lib")
  scp -r runner/*.js ($SERVER + ":" + $APP_DIR + "/runner/")
  if ($LASTEXITCODE -ne 0) { Step-Err "runner upload (entry) failed" }
  scp -r runner/lib/*.js ($SERVER + ":" + $APP_DIR + "/runner/lib/")
  if ($LASTEXITCODE -ne 0) { Step-Err "runner upload (lib) failed" }

  # install-runner.sh is bash; PowerShell git checkout leaves it with CRLF line
  # endings, which bash on Linux reads as `set -o pipefail\r` and dies with
  # `set: pipefail\r: invalid option name`. Re-write to a temp file with LF
  # before scp.
  $shTmp = Join-Path $PSScriptRoot ".install_runner_tmp.sh"
  $shContent = Get-Content "runner/install-runner.sh" -Raw
  [System.IO.File]::WriteAllText($shTmp, $shContent.Replace("`r`n", "`n"), (New-Object System.Text.UTF8Encoding $false))
  scp $shTmp ($SERVER + ":" + $APP_DIR + "/runner/install-runner.sh")
  $scpRc = $LASTEXITCODE
  Remove-Item $shTmp -Force -ErrorAction SilentlyContinue
  if ($scpRc -ne 0) { Step-Err "runner install script upload failed" }

  ssh $SERVER ("chmod +x " + $APP_DIR + "/runner/install-runner.sh")
  Step-OK "runner uploaded"
}

# ---- runner_install ----
# Host-level setup: create /srv/apps-father/projects, apt-install acl, etc.
# Idempotent — safe to re-run on every deploy. Should run ONCE per server.
if ($checked["runner_install"]) {
  Step-Header "Running runner/install-runner.sh on server"
  # Strip any leftover CRs in case the script was uploaded on a previous run
  # before the CRLF→LF normalisation was added. Idempotent and cheap.
  ssh $SERVER ("sed -i 's/\r$//' " + $APP_DIR + "/runner/install-runner.sh && chmod +x " + $APP_DIR + "/runner/install-runner.sh")
  ssh $SERVER ("APP_DIR=" + $APP_DIR + " bash " + $APP_DIR + "/runner/install-runner.sh")
  if ($LASTEXITCODE -ne 0) { Step-Err "runner install failed" }
  Step-OK "runner installed"
}

# ---- runner_image ----
# Rebuild the apps-father-runner Docker image on the server so changes to
# runner/worker-entry.js, runner/lib/*, runner/package.json or runner/Dockerfile
# actually take effect. The image bakes worker-entry.js into /runner/worker-entry.js;
# uploading the host-side runner/ folder alone does NOT update running containers.
if ($checked["runner_image"]) {
  Step-Header "Rebuilding apps-father-runner:latest on server"
  ssh -t $SERVER ("cd " + $APP_DIR + "/runner && docker build --tag apps-father-runner:latest --file Dockerfile . 2>&1 | tail -20")
  if ($LASTEXITCODE -ne 0) { Step-Err "docker build failed" }
  Step-OK "runner image rebuilt"
}

# ---- runner_recreate ----
# Force-remove all running worker containers so the platform respawns them
# from the freshly-built image on the next inbound request. We do NOT stop
# them via the admin API here — direct `docker rm -f` is faster and avoids
# needing an admin token in the deploy script. The DockerRunnerService will
# lazy-spawn replacements with the new image.
if ($checked["runner_recreate"]) {
  Step-Header "Recreating worker containers (docker rm -f afp-*)"
  ssh $SERVER "docker ps -a --filter 'name=^afp-' --format '{{.Names}}' | xargs -r docker rm -f"
  if ($LASTEXITCODE -ne 0) { Step-Err "container recreate failed" }
  Step-OK "containers removed (will respawn on next request)"
}

# ---- runner-npm-allowlist.json ----
# Synced to APP_DIR root because:
#   * runner-npm-allowlist.service.ts reads it from cwd/runner-npm-allowlist.json
#   * security-migrations/runner-npm-scan.sh reads it from $APP_DIR/runner-npm-allowlist.json
# Both the agent-side npm_install tool and the server-side scanner enforce
# the same allowlist; a missing or stale file degrades to deny-all.
if ($checked["npm_allowlist"]) {
  Step-Header "Syncing runner-npm-allowlist.json"
  if (-not (Test-Path "runner-npm-allowlist.json")) {
    Step-Err "runner-npm-allowlist.json not found at repo root"
  }
  scp runner-npm-allowlist.json ($SERVER + ":" + $APP_DIR + "/runner-npm-allowlist.json")
  if ($LASTEXITCODE -ne 0) { Step-Err "allowlist sync failed" }
  Step-OK "runner-npm-allowlist.json synced"
}

# ---- Restart PM2 ----
if ($checked["restart"]) {
  Step-Header "Restarting PM2"
  ssh $SERVER ("cd " + $APP_DIR + " && (pm2 restart " + $PM2 + " --update-env --kill-timeout 300000 --node-args='--max-old-space-size=8192' 2>/dev/null || pm2 start dist/index.js --name " + $PM2 + " --node-args='--max-old-space-size=8192' --max-memory-restart 16G && pm2 save)")
  if ($LASTEXITCODE -ne 0) { Step-Err "PM2 restart failed" }
  Step-OK "PM2 restarted"
}

Write-Host ""
Write-Host ("=== Deployed to " + $ENV_NAME + "! ===") -ForegroundColor Green

# ============================================================
#  deploy-full.ps1  —  Full deploy (build + dist + mini_app + landing + DB)
# ============================================================

$choice = Read-Host "Deploy to [P]roduction or [D]ev? (P/D)"
if ($choice -match '^[Dd]') {
    $ENV_NAME = "DEV"
    $SERVER   = "root@62.238.2.16"
    $APP_DIR  = "/opt/apps-father-dev"
    $PM2      = "apps-father-dev"
    $DB_CTR   = "apps_father_dev_db"
    $DB_USER  = "apps_father"
    $DB_NAME  = "apps_father"
    $COLOR    = "Yellow"
} else {
    $ENV_NAME = "PROD"
    $SERVER   = "root@204.168.219.20"
    $APP_DIR  = "/opt/apps-father"
    $PM2      = "apps-father"
    $DB_CTR   = "apps_father_db"
    $DB_USER  = "apps_father"
    $DB_NAME  = "apps_father"
    $COLOR    = "Cyan"
}

Write-Host ">>> Deploying to $ENV_NAME <<<" -ForegroundColor $COLOR

# ── Build ─────────────────────────────────────────────────
Write-Host "=== [$ENV_NAME] Building ===" -ForegroundColor $COLOR
npx tsc --project tsconfig.json
if ($LASTEXITCODE -ne 0) { Write-Host "Build failed!" -ForegroundColor Red; exit 1 }
# Copy non-TS assets that tsc doesn't handle
Copy-Item "src/web/routes/af-devtools.js" "dist/web/routes/af-devtools.js" -Force
Copy-Item "src/web/routes/af-sdk.js"      "dist/web/routes/af-sdk.js"      -Force
Write-Host "Build OK" -ForegroundColor Green

# ── Upload dist ───────────────────────────────────────────
Write-Host "=== [$ENV_NAME] Uploading dist ===" -ForegroundColor $COLOR
scp -r dist/* "${SERVER}:${APP_DIR}/dist/"
if ($LASTEXITCODE -ne 0) { Write-Host "Upload failed!" -ForegroundColor Red; exit 1 }
Write-Host "Upload OK" -ForegroundColor Green

# ── Mini App ──────────────────────────────────────────────
Write-Host "=== [$ENV_NAME] Uploading mini_app ===" -ForegroundColor $COLOR
ssh $SERVER "mkdir -p ${APP_DIR}/mini_app"
scp -r mini_app/* "${SERVER}:${APP_DIR}/mini_app/"
Write-Host "Mini App OK" -ForegroundColor Green

# ── Landing ───────────────────────────────────────────────
# Keep af-sdk.js in sync (source lives in src/web/routes/, served from landing/)
Copy-Item "src\web\routes\af-sdk.js" "landing\af-sdk.js" -Force
Write-Host "=== [$ENV_NAME] Uploading landing ===" -ForegroundColor $COLOR
ssh $SERVER "mkdir -p ${APP_DIR}/landing/samples"
scp -r landing/* "${SERVER}:${APP_DIR}/landing/"
Write-Host "Landing OK" -ForegroundColor Green

# ── Admin CRM (browser SPA at /admin) ─────────────────────
Write-Host "=== [$ENV_NAME] Uploading admin ===" -ForegroundColor $COLOR
ssh $SERVER "mkdir -p ${APP_DIR}/admin"
scp -r admin/* "${SERVER}:${APP_DIR}/admin/"
Write-Host "Admin OK" -ForegroundColor Green

# ── Upload .env ───────────────────────────────────────────
if ($ENV_NAME -eq "DEV") {
    Write-Host "=== [$ENV_NAME] Syncing dev.env ===" -ForegroundColor $COLOR
    scp dev.env "${SERVER}:${APP_DIR}/.env"
    Write-Host "Env OK" -ForegroundColor Green
}

# ── Deps ──────────────────────────────────────────────────
Write-Host "=== [$ENV_NAME] Syncing package.json & deps ===" -ForegroundColor $COLOR
scp package.json "${SERVER}:${APP_DIR}/package.json"
ssh $SERVER "cd ${APP_DIR} && npm install --omit=dev --no-audit --no-fund 2>&1 | tail -3"
Write-Host "Deps OK" -ForegroundColor Green

# ── Playwright Chromium (for Visual Test tool) ─────────────
# Install Chromium + required OS-level libs to the default cache location.
# --with-deps pulls in libglib, libnss, libatk, etc. on Debian/Ubuntu.
Write-Host "=== [$ENV_NAME] Installing Playwright Chromium ===" -ForegroundColor $COLOR
ssh $SERVER "cd ${APP_DIR} && npx playwright install chromium --with-deps"
Write-Host "Playwright OK" -ForegroundColor Green

# ── Prisma ────────────────────────────────────────────────
Write-Host "=== [$ENV_NAME] Syncing Prisma schema ===" -ForegroundColor $COLOR
scp prisma/schema.prisma "${SERVER}:${APP_DIR}/prisma/schema.prisma"
ssh $SERVER "cd ${APP_DIR} && npx prisma generate --no-hints"
Write-Host "Prisma OK" -ForegroundColor Green

# ── DB migrations ─────────────────────────────────────────
Write-Host "=== [$ENV_NAME] Running DB migrations ===" -ForegroundColor $COLOR
$psql = "docker exec ${DB_CTR} psql -U ${DB_USER} -d ${DB_NAME} -c"
ssh $SERVER "$psql 'ALTER TABLE projects ADD COLUMN IF NOT EXISTS release_commit INT;'"
ssh $SERVER "$psql 'ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by BIGINT;'"
ssh $SERVER "$psql 'ALTER TABLE users ADD COLUMN IF NOT EXISTS language TEXT;'"
ssh $SERVER "$psql 'CREATE TABLE IF NOT EXISTS vouchers (id SERIAL PRIMARY KEY, code TEXT UNIQUE NOT NULL, amount_usd DECIMAL(12,4) NOT NULL, max_uses INT NOT NULL, used_count INT DEFAULT 0, active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT NOW());'"
ssh $SERVER "$psql 'CREATE TABLE IF NOT EXISTS voucher_redemptions (id SERIAL PRIMARY KEY, voucher_id INT NOT NULL REFERENCES vouchers(id), user_id INT NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(voucher_id, user_id));'"
ssh $SERVER "$psql 'ALTER TABLE users ADD COLUMN IF NOT EXISTS is_partner BOOLEAN DEFAULT false;'"
ssh $SERVER "$psql 'ALTER TABLE users ADD COLUMN IF NOT EXISTS partner_percent DECIMAL(5,2);'"
ssh $SERVER "$psql 'ALTER TABLE users ADD COLUMN IF NOT EXISTS partner_tag TEXT UNIQUE;'"
ssh $SERVER "$psql 'ALTER TABLE users ADD COLUMN IF NOT EXISTS partner_referral_bonus DECIMAL(12,4);'"
ssh $SERVER "$psql 'ALTER TABLE users ADD COLUMN IF NOT EXISTS partner_balance DECIMAL(12,4) DEFAULT 0;'"
$withdrawSql = "CREATE TABLE IF NOT EXISTS withdrawals (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), amount_usd DECIMAL(12,4) NOT NULL, ton_address TEXT NOT NULL, status TEXT DEFAULT 'pending', tx_hash TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), processed_at TIMESTAMPTZ);"
$withdrawSql | Out-File -Encoding utf8 -FilePath tmp_wd.sql
scp tmp_wd.sql "${SERVER}:/tmp/tmp_wd.sql"
ssh $SERVER "docker cp /tmp/tmp_wd.sql ${DB_CTR}:/tmp/tmp_wd.sql; docker exec ${DB_CTR} psql -U ${DB_USER} -d ${DB_NAME} -f /tmp/tmp_wd.sql"
Remove-Item tmp_wd.sql -ErrorAction SilentlyContinue
$retentionSql = "CREATE TABLE IF NOT EXISTS retention_pushes (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, scenario TEXT NOT NULL, sent_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(user_id, scenario));"
$retentionSql | Out-File -Encoding utf8 -FilePath tmp_ret.sql
scp tmp_ret.sql "${SERVER}:/tmp/tmp_ret.sql"
ssh $SERVER "docker cp /tmp/tmp_ret.sql ${DB_CTR}:/tmp/tmp_ret.sql; docker exec ${DB_CTR} psql -U ${DB_USER} -d ${DB_NAME} -f /tmp/tmp_ret.sql"
ssh $SERVER "$psql 'CREATE INDEX IF NOT EXISTS retention_pushes_user_id_idx ON retention_pushes(user_id);'"
Remove-Item tmp_ret.sql -ErrorAction SilentlyContinue
ssh $SERVER "$psql 'ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_notified_at TIMESTAMPTZ;'"
ssh $SERVER "$psql 'UPDATE users SET admin_notified_at = created_at WHERE admin_notified_at IS NULL;'"
ssh $SERVER "$psql 'ALTER TABLE users ADD COLUMN IF NOT EXISTS sub_bonus_claimed_at TIMESTAMPTZ;'"
ssh $SERVER "$psql 'ALTER TABLE projects DROP COLUMN IF EXISTS preferences;'"
# Agent sessions log (Prisma AgentSession model → agent_sessions table)
$agentSessionsSql = @"
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  model TEXT NOT NULL,
  input TEXT NOT NULL,
  output TEXT,
  credits_charged INT NOT NULL DEFAULT 0,
  cost_usd DECIMAL(12,6) NOT NULL DEFAULT 0,
  input_tokens INT NOT NULL DEFAULT 0,
  output_tokens INT NOT NULL DEFAULT 0,
  duration_ms INT,
  success BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS agent_sessions_project_created ON agent_sessions(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_sessions_user_created ON agent_sessions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_sessions_type_created ON agent_sessions(type, created_at DESC);
"@
ssh $SERVER "$psql '$agentSessionsSql'"
# Admin CRM: user tags + notes (Prisma User.adminTags / AdminUserNote)
ssh $SERVER "$psql 'ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_tags TEXT;'"
# App slots: bumped from 1 → 5 free starter slots. Existing users get +4 so
# their previous purchases still work out (was 1 → 5, was 2 → 6, etc).
# The migration is idempotent: a marker row is left behind and we skip the
# bump on subsequent deploys.
$slotBumpSql = @"
DO `$`$
BEGIN
  ALTER TABLE users ALTER COLUMN app_slots SET DEFAULT 5;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = '_app_slots_bump_v1_done'
  ) THEN
    UPDATE users SET app_slots = app_slots + 4;
    CREATE TABLE _app_slots_bump_v1_done (applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    INSERT INTO _app_slots_bump_v1_done DEFAULT VALUES;
  END IF;
END
`$`$;
"@
$slotBumpSql | Out-File -Encoding utf8 -FilePath tmp_slot_bump.sql
scp tmp_slot_bump.sql "${SERVER}:/tmp/tmp_slot_bump.sql"
ssh $SERVER "docker cp /tmp/tmp_slot_bump.sql ${DB_CTR}:/tmp/tmp_slot_bump.sql; docker exec ${DB_CTR} psql -U ${DB_USER} -d ${DB_NAME} -f /tmp/tmp_slot_bump.sql"
Remove-Item tmp_slot_bump.sql -ErrorAction SilentlyContinue
$adminCrmSql = @"
CREATE TABLE IF NOT EXISTS admin_user_notes (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  author_tag TEXT NOT NULL DEFAULT 'admin',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS admin_user_notes_user_id_idx ON admin_user_notes(user_id);
"@
$adminCrmSql | Out-File -Encoding utf8 -FilePath tmp_admin_crm.sql
scp tmp_admin_crm.sql "${SERVER}:/tmp/tmp_admin_crm.sql"
ssh $SERVER "docker cp /tmp/tmp_admin_crm.sql ${DB_CTR}:/tmp/tmp_admin_crm.sql; docker exec ${DB_CTR} psql -U ${DB_USER} -d ${DB_NAME} -f /tmp/tmp_admin_crm.sql"
Remove-Item tmp_admin_crm.sql -ErrorAction SilentlyContinue

# ── App logs (persistent runtime log capture, see app-log.service.ts) ────────
# Indexed on (ts), (project_id, ts), (category, ts), (project_id, category, ts)
# so the Admin Logs page can paginate/filter quickly. Created idempotently.
$appLogsSql = @"
CREATE TABLE IF NOT EXISTS app_logs (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  project_id TEXT NULL REFERENCES projects(id) ON DELETE SET NULL,
  category TEXT NOT NULL,
  level TEXT NOT NULL,
  source TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS app_logs_ts_desc_idx           ON app_logs (ts DESC);
CREATE INDEX IF NOT EXISTS app_logs_project_ts_idx        ON app_logs (project_id, ts DESC);
CREATE INDEX IF NOT EXISTS app_logs_category_ts_idx       ON app_logs (category,  ts DESC);
CREATE INDEX IF NOT EXISTS app_logs_project_cat_ts_idx    ON app_logs (project_id, category, ts DESC);
"@
$appLogsSql | Out-File -Encoding utf8 -FilePath tmp_app_logs.sql
scp tmp_app_logs.sql "${SERVER}:/tmp/tmp_app_logs.sql"
ssh $SERVER "docker cp /tmp/tmp_app_logs.sql ${DB_CTR}:/tmp/tmp_app_logs.sql; docker exec ${DB_CTR} psql -U ${DB_USER} -d ${DB_NAME} -f /tmp/tmp_app_logs.sql"
Remove-Item tmp_app_logs.sql -ErrorAction SilentlyContinue

# Projects: app profile fields (Prisma: appDescription, appLongDescription, appMenuButtonText)
Write-Host "=== [$ENV_NAME] Projects app profile columns ===" -ForegroundColor $COLOR
ssh $SERVER "$psql 'ALTER TABLE projects ADD COLUMN IF NOT EXISTS app_description TEXT;'"
ssh $SERVER "$psql 'ALTER TABLE projects ADD COLUMN IF NOT EXISTS app_long_description TEXT;'"
ssh $SERVER "$psql 'ALTER TABLE projects ADD COLUMN IF NOT EXISTS app_menu_button_text TEXT;'"

# Credits & performance tiers (Prisma: User.credits, User.performanceTier;
# UsageLog.creditsCharged, UsageLog.tierId). Must match prisma/schema.prisma.
Write-Host "=== [$ENV_NAME] Credits / tier columns (Prisma) ===" -ForegroundColor $COLOR
ssh $SERVER "$psql 'ALTER TABLE users ADD COLUMN IF NOT EXISTS credits INTEGER NOT NULL DEFAULT 0;'"
ssh $SERVER "$psql 'ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS credits_charged INTEGER;'"
ssh $SERVER "$psql 'ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS tier_id TEXT;'"
# performance_tier uses a string literal default — done via SQL file to avoid PowerShell quote issues
$perfTierSql = "ALTER TABLE users ADD COLUMN IF NOT EXISTS performance_tier TEXT NOT NULL DEFAULT 'tier_1';"
$perfTierSql | Out-File -Encoding utf8 -FilePath tmp_perf_tier.sql
scp tmp_perf_tier.sql "${SERVER}:/tmp/tmp_perf_tier.sql"
ssh $SERVER "docker cp /tmp/tmp_perf_tier.sql ${DB_CTR}:/tmp/tmp_perf_tier.sql; docker exec ${DB_CTR} psql -U ${DB_USER} -d ${DB_NAME} -f /tmp/tmp_perf_tier.sql"
Remove-Item tmp_perf_tier.sql -ErrorAction SilentlyContinue
# One-time: map legacy USD balance -> credits (50 credits per $1). Skipped on subsequent deploys.
$creditsBackfillSql = @"
DO `$`$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = '_credits_backfill_v1_done') THEN
    UPDATE users SET credits = GREATEST(0, FLOOR((balance)::numeric * 50)::int)
      WHERE credits = 0;
    CREATE TABLE _credits_backfill_v1_done (applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  END IF;
END
`$`$;
"@
$creditsBackfillSql | Out-File -Encoding utf8 -FilePath tmp_credits_bf.sql
scp tmp_credits_bf.sql "${SERVER}:/tmp/tmp_credits_bf.sql"
ssh $SERVER "docker cp /tmp/tmp_credits_bf.sql ${DB_CTR}:/tmp/tmp_credits_bf.sql; docker exec ${DB_CTR} psql -U ${DB_USER} -d ${DB_NAME} -f /tmp/tmp_credits_bf.sql"
Remove-Item tmp_credits_bf.sql -ErrorAction SilentlyContinue

# Bundles topup system
Write-Host "=== [$ENV_NAME] Bundles topup system ===" -ForegroundColor $COLOR
$bundlesSql = @"
CREATE TABLE IF NOT EXISTS bundles (
  id             TEXT          PRIMARY KEY,
  name           TEXT          NOT NULL,
  credits        INTEGER       NOT NULL,
  bonus_credits  INTEGER       NOT NULL DEFAULT 0,
  price_usd      DECIMAL(12,4) NOT NULL,
  discount       INTEGER       NOT NULL DEFAULT 0,
  is_limited     BOOLEAN       NOT NULL DEFAULT false,
  limit_total    INTEGER,
  purchase_count INTEGER       NOT NULL DEFAULT 0,
  is_active      BOOLEAN       NOT NULL DEFAULT true,
  sort_order     INTEGER       NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS bundle_id       TEXT REFERENCES bundles(id);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS credits_granted INTEGER;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS bonus_credits   INTEGER;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS method          TEXT;
"@
$bundlesSql | Out-File -Encoding utf8 -FilePath tmp_bundles.sql
scp tmp_bundles.sql "${SERVER}:/tmp/tmp_bundles.sql"
ssh $SERVER "docker cp /tmp/tmp_bundles.sql ${DB_CTR}:/tmp/tmp_bundles.sql; docker exec ${DB_CTR} psql -U ${DB_USER} -d ${DB_NAME} -f /tmp/tmp_bundles.sql"
Remove-Item tmp_bundles.sql -ErrorAction SilentlyContinue

# Vouchers credits column
Write-Host "=== [$ENV_NAME] Vouchers credits migration ===" -ForegroundColor $COLOR
$voucherSql = "ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS credits INTEGER NOT NULL DEFAULT 0;"
$voucherSql | Out-File -Encoding utf8 -FilePath tmp_vouchers.sql
scp tmp_vouchers.sql "${SERVER}:/tmp/tmp_vouchers.sql"
ssh $SERVER "docker cp /tmp/tmp_vouchers.sql ${DB_CTR}:/tmp/tmp_vouchers.sql; docker exec ${DB_CTR} psql -U ${DB_USER} -d ${DB_NAME} -f /tmp/tmp_vouchers.sql"
Remove-Item tmp_vouchers.sql -ErrorAction SilentlyContinue

# Tasks system
$tasksSql = Get-Content "deploy/sql/tasks_system.sql" -Raw
$tasksSql | Out-File -Encoding utf8 -FilePath tmp_tasks.sql
scp tmp_tasks.sql "${SERVER}:/tmp/tmp_tasks.sql"
ssh $SERVER "docker cp /tmp/tmp_tasks.sql ${DB_CTR}:/tmp/tmp_tasks.sql; docker exec ${DB_CTR} psql -U ${DB_USER} -d ${DB_NAME} -f /tmp/tmp_tasks.sql"
Remove-Item tmp_tasks.sql -ErrorAction SilentlyContinue

# Welcome credits + tier_0 migration
$welcomeSql = Get-Content "deploy/sql/welcome_credits_tier0.sql" -Raw
$welcomeSql | Out-File -Encoding utf8 -FilePath tmp_welcome.sql
scp tmp_welcome.sql "${SERVER}:/tmp/tmp_welcome.sql"
ssh $SERVER "docker cp /tmp/tmp_welcome.sql ${DB_CTR}:/tmp/tmp_welcome.sql; docker exec ${DB_CTR} psql -U ${DB_USER} -d ${DB_NAME} -f /tmp/tmp_welcome.sql"
Remove-Item tmp_welcome.sql -ErrorAction SilentlyContinue

# Welcome credits 100 → 50 migration (lowers new-user grant + corrects existing 100-credit balances)
$welcome50Sql = Get-Content "deploy/sql/welcome_credits_50.sql" -Raw
$welcome50Sql | Out-File -Encoding utf8 -FilePath tmp_welcome50.sql
scp tmp_welcome50.sql "${SERVER}:/tmp/tmp_welcome50.sql"
ssh $SERVER "docker cp /tmp/tmp_welcome50.sql ${DB_CTR}:/tmp/tmp_welcome50.sql; docker exec ${DB_CTR} psql -U ${DB_USER} -d ${DB_NAME} -f /tmp/tmp_welcome50.sql"
Remove-Item tmp_welcome50.sql -ErrorAction SilentlyContinue

# Agent training tables (lessons + code patches)
$lessonsSql = Get-Content "deploy/sql/agent_lessons.sql" -Raw
$lessonsSql | Out-File -Encoding utf8 -FilePath tmp_agent_lessons.sql
scp tmp_agent_lessons.sql "${SERVER}:/tmp/tmp_agent_lessons.sql"
ssh $SERVER "docker cp /tmp/tmp_agent_lessons.sql ${DB_CTR}:/tmp/tmp_agent_lessons.sql; docker exec ${DB_CTR} psql -U ${DB_USER} -d ${DB_NAME} -f /tmp/tmp_agent_lessons.sql"
Remove-Item tmp_agent_lessons.sql -ErrorAction SilentlyContinue

# Agent feedback (cashback issues)
$feedbackSql = Get-Content "deploy/sql/agent_feedback.sql" -Raw
$feedbackSql | Out-File -Encoding utf8 -FilePath tmp_agent_feedback.sql
scp tmp_agent_feedback.sql "${SERVER}:/tmp/tmp_agent_feedback.sql"
ssh $SERVER "docker cp /tmp/tmp_agent_feedback.sql ${DB_CTR}:/tmp/tmp_agent_feedback.sql; docker exec ${DB_CTR} psql -U ${DB_USER} -d ${DB_NAME} -f /tmp/tmp_agent_feedback.sql"
Remove-Item tmp_agent_feedback.sql -ErrorAction SilentlyContinue

# task_id column on usage_logs
$usageTaskSql = Get-Content "deploy/sql/usage_log_task_id.sql" -Raw
$usageTaskSql | Out-File -Encoding utf8 -FilePath tmp_usage_task_id.sql
scp tmp_usage_task_id.sql "${SERVER}:/tmp/tmp_usage_task_id.sql"
ssh $SERVER "docker cp /tmp/tmp_usage_task_id.sql ${DB_CTR}:/tmp/tmp_usage_task_id.sql; docker exec ${DB_CTR} psql -U ${DB_USER} -d ${DB_NAME} -f /tmp/tmp_usage_task_id.sql"
Remove-Item tmp_usage_task_id.sql -ErrorAction SilentlyContinue

# last_task_id column on projects
$lastTaskSql = Get-Content "deploy/sql/last_task_id.sql" -Raw
$lastTaskSql | Out-File -Encoding utf8 -FilePath tmp_last_task_id.sql
scp tmp_last_task_id.sql "${SERVER}:/tmp/tmp_last_task_id.sql"
ssh $SERVER "docker cp /tmp/tmp_last_task_id.sql ${DB_CTR}:/tmp/tmp_last_task_id.sql; docker exec ${DB_CTR} psql -U ${DB_USER} -d ${DB_NAME} -f /tmp/tmp_last_task_id.sql"
Remove-Item tmp_last_task_id.sql -ErrorAction SilentlyContinue

Write-Host "Migration OK" -ForegroundColor Green

# ── Bucket directory (persistent image storage, survives deploys) ─────────
Write-Host "=== [$ENV_NAME] Ensuring bucket directory exists ===" -ForegroundColor $COLOR
ssh $SERVER "mkdir -p ${APP_DIR}/bucket"
Write-Host "Bucket OK" -ForegroundColor Green

# ── Agent knowledge (instructions + skills + ask docs) ───
Write-Host "=== [$ENV_NAME] Syncing agent_knowledge ===" -ForegroundColor $COLOR
ssh $SERVER "mkdir -p ${APP_DIR}/agent_knowledge/instructions ${APP_DIR}/agent_knowledge/skills ${APP_DIR}/agent_knowledge/ask/topics"
scp -r agent_knowledge/instructions/* "${SERVER}:${APP_DIR}/agent_knowledge/instructions/"
scp -r agent_knowledge/skills/* "${SERVER}:${APP_DIR}/agent_knowledge/skills/"
scp -r agent_knowledge/ask/* "${SERVER}:${APP_DIR}/agent_knowledge/ask/"
Write-Host "agent_knowledge OK" -ForegroundColor Green

# ── Restart ───────────────────────────────────────────────
Write-Host "=== [$ENV_NAME] Restarting ===" -ForegroundColor $COLOR
ssh $SERVER "cd ${APP_DIR} && (pm2 restart ${PM2} --update-env --kill-timeout 300000 2>/dev/null || pm2 start dist/index.js --name ${PM2} --max-memory-restart 1G && pm2 save)"
if ($LASTEXITCODE -ne 0) { Write-Host "Restart failed!" -ForegroundColor Red; exit 1 }

Write-Host "=== Deployed to $ENV_NAME! ===" -ForegroundColor Green

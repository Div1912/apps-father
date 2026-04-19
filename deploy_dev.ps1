# ============================================================
#  DEVELOPMENT deploy — dev.apps-father.com
#  Server: 62.238.2.16
#  App dir: /opt/apps-father-dev
#  PM2:     apps-father-dev
#  DB:      apps_father_dev_db  /  apps_father
# ============================================================
$SERVER  = "root@62.238.2.16"
$APP_DIR = "/opt/apps-father-dev"
$PM2     = "apps-father-dev"
$DB_CTR  = "apps_father_dev_db"
$DB_USER = "apps_father"
$DB_NAME = "apps_father"

# Guard: fail early if IP is still a placeholder
if ($SERVER -like "*<DEV*") {
    Write-Host "ERROR: Set the real dev server IP in deploy_dev.ps1 first!" -ForegroundColor Red
    exit 1
}

Write-Host "=== [DEV] Building ===" -ForegroundColor Cyan
npx tsc --project tsconfig.json
if ($LASTEXITCODE -ne 0) { Write-Host "Build failed!" -ForegroundColor Red; exit 1 }
Write-Host "Build OK" -ForegroundColor Green

Write-Host "=== [DEV] Uploading dist ===" -ForegroundColor Cyan
scp -r dist/* "${SERVER}:${APP_DIR}/dist/"
if ($LASTEXITCODE -ne 0) { Write-Host "Upload failed!" -ForegroundColor Red; exit 1 }
Write-Host "Upload OK" -ForegroundColor Green

Write-Host "=== [DEV] Uploading mini_app ===" -ForegroundColor Cyan
ssh $SERVER "mkdir -p ${APP_DIR}/mini_app"
scp -r mini_app/* "${SERVER}:${APP_DIR}/mini_app/"
Write-Host "Mini App OK" -ForegroundColor Green

# Landing on dev is optional — comment out if you don't need it
Write-Host "=== [DEV] Uploading landing ===" -ForegroundColor Cyan
ssh $SERVER "mkdir -p ${APP_DIR}/landing/samples"
scp -r landing/* "${SERVER}:${APP_DIR}/landing/"
Write-Host "Landing OK" -ForegroundColor Green

Write-Host "=== [DEV] Syncing package.json & deps ===" -ForegroundColor Cyan
scp package.json "${SERVER}:${APP_DIR}/package.json"
ssh $SERVER "cd ${APP_DIR} && npm install --omit=dev --no-audit --no-fund 2>&1 | tail -3"
Write-Host "Deps OK" -ForegroundColor Green

Write-Host "=== [DEV] Syncing Prisma schema ===" -ForegroundColor Cyan
scp prisma/schema.prisma "${SERVER}:${APP_DIR}/prisma/schema.prisma"
ssh $SERVER "cd ${APP_DIR} && npx prisma generate --no-hints"
Write-Host "Prisma OK" -ForegroundColor Green

Write-Host "=== [DEV] Running DB migrations ===" -ForegroundColor Cyan
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
$withdrawSql | Out-File -Encoding utf8 -FilePath tmp_wd_dev.sql
scp tmp_wd_dev.sql "${SERVER}:/tmp/tmp_wd_dev.sql"
ssh $SERVER "docker cp /tmp/tmp_wd_dev.sql ${DB_CTR}:/tmp/tmp_wd_dev.sql; docker exec ${DB_CTR} psql -U ${DB_USER} -d ${DB_NAME} -f /tmp/tmp_wd_dev.sql"
Remove-Item tmp_wd_dev.sql -ErrorAction SilentlyContinue
$retentionSql = "CREATE TABLE IF NOT EXISTS retention_pushes (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, scenario TEXT NOT NULL, sent_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(user_id, scenario));"
$retentionSql | Out-File -Encoding utf8 -FilePath tmp_ret_dev.sql
scp tmp_ret_dev.sql "${SERVER}:/tmp/tmp_ret_dev.sql"
ssh $SERVER "docker cp /tmp/tmp_ret_dev.sql ${DB_CTR}:/tmp/tmp_ret_dev.sql; docker exec ${DB_CTR} psql -U ${DB_USER} -d ${DB_NAME} -f /tmp/tmp_ret_dev.sql"
ssh $SERVER "$psql 'CREATE INDEX IF NOT EXISTS retention_pushes_user_id_idx ON retention_pushes(user_id);'"
Remove-Item tmp_ret_dev.sql -ErrorAction SilentlyContinue
ssh $SERVER "$psql 'ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_notified_at TIMESTAMPTZ;'"
ssh $SERVER "$psql 'UPDATE users SET admin_notified_at = created_at WHERE admin_notified_at IS NULL;'"
ssh $SERVER "$psql 'ALTER TABLE users ADD COLUMN IF NOT EXISTS sub_bonus_claimed_at TIMESTAMPTZ;'"
Write-Host "Migration OK" -ForegroundColor Green

Write-Host "=== [DEV] Syncing skills ===" -ForegroundColor Cyan
scp -r skills/* "${SERVER}:${APP_DIR}/skills/"
Write-Host "Skills OK" -ForegroundColor Green

Write-Host "=== [DEV] Restarting ===" -ForegroundColor Cyan
ssh $SERVER "cd ${APP_DIR} && (pm2 restart ${PM2} --update-env --kill-timeout 300000 2>/dev/null || pm2 start ecosystem.config.js && pm2 save)"
if ($LASTEXITCODE -ne 0) { Write-Host "Restart failed!" -ForegroundColor Red; exit 1 }

Write-Host "=== [DEV] Deployed to DEV! ===" -ForegroundColor Green

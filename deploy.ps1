Write-Host "=== Building ===" -ForegroundColor Cyan
npx tsc --project tsconfig.json
if ($LASTEXITCODE -ne 0) {
    Write-Host "Build failed!" -ForegroundColor Red
    exit 1
}
Write-Host "Build OK" -ForegroundColor Green

Write-Host "=== Uploading dist ===" -ForegroundColor Cyan
scp -r dist/* root@204.168.219.20:/opt/apps-father/dist/
if ($LASTEXITCODE -ne 0) {
    Write-Host "Upload failed!" -ForegroundColor Red
    exit 1
}
Write-Host "Upload OK" -ForegroundColor Green

Write-Host "=== Uploading mini_app ===" -ForegroundColor Cyan
ssh root@204.168.219.20 "mkdir -p /opt/apps-father/mini_app"
scp -r mini_app/* root@204.168.219.20:/opt/apps-father/mini_app/
Write-Host "Mini App OK" -ForegroundColor Green

Write-Host "=== Syncing package.json & deps ===" -ForegroundColor Cyan
scp package.json root@204.168.219.20:/opt/apps-father/package.json
ssh root@204.168.219.20 "cd /opt/apps-father && npm install --omit=dev --no-audit --no-fund 2>&1 | tail -3"
Write-Host "Deps OK" -ForegroundColor Green

Write-Host "=== Syncing Prisma schema ===" -ForegroundColor Cyan
scp prisma/schema.prisma root@204.168.219.20:/opt/apps-father/prisma/schema.prisma
ssh root@204.168.219.20 "cd /opt/apps-father && npx prisma generate --no-hints"
Write-Host "Prisma OK" -ForegroundColor Green

Write-Host "=== Running DB migration ===" -ForegroundColor Cyan
ssh root@204.168.219.20 "docker exec apps_father_db psql -U apps_father -d apps_father -c 'ALTER TABLE projects ADD COLUMN IF NOT EXISTS release_commit INT;'"
ssh root@204.168.219.20 "docker exec apps_father_db psql -U apps_father -d apps_father -c 'ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by BIGINT;'"
ssh root@204.168.219.20 "docker exec apps_father_db psql -U apps_father -d apps_father -c 'ALTER TABLE users ADD COLUMN IF NOT EXISTS language TEXT;'"
ssh root@204.168.219.20 "docker exec apps_father_db psql -U apps_father -d apps_father -c 'CREATE TABLE IF NOT EXISTS vouchers (id SERIAL PRIMARY KEY, code TEXT UNIQUE NOT NULL, amount_usd DECIMAL(12,4) NOT NULL, max_uses INT NOT NULL, used_count INT DEFAULT 0, active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT NOW());'"
ssh root@204.168.219.20 "docker exec apps_father_db psql -U apps_father -d apps_father -c 'CREATE TABLE IF NOT EXISTS voucher_redemptions (id SERIAL PRIMARY KEY, voucher_id INT NOT NULL REFERENCES vouchers(id), user_id INT NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(voucher_id, user_id));'"
ssh root@204.168.219.20 "docker exec apps_father_db psql -U apps_father -d apps_father -c 'ALTER TABLE users ADD COLUMN IF NOT EXISTS is_partner BOOLEAN DEFAULT false;'"
ssh root@204.168.219.20 "docker exec apps_father_db psql -U apps_father -d apps_father -c 'ALTER TABLE users ADD COLUMN IF NOT EXISTS partner_percent DECIMAL(5,2);'"
ssh root@204.168.219.20 "docker exec apps_father_db psql -U apps_father -d apps_father -c 'ALTER TABLE users ADD COLUMN IF NOT EXISTS partner_tag TEXT UNIQUE;'"
ssh root@204.168.219.20 "docker exec apps_father_db psql -U apps_father -d apps_father -c 'ALTER TABLE users ADD COLUMN IF NOT EXISTS partner_referral_bonus DECIMAL(12,4);'"
ssh root@204.168.219.20 "docker exec apps_father_db psql -U apps_father -d apps_father -c 'ALTER TABLE users ADD COLUMN IF NOT EXISTS partner_balance DECIMAL(12,4) DEFAULT 0;'"
$withdrawSql = "CREATE TABLE IF NOT EXISTS withdrawals (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), amount_usd DECIMAL(12,4) NOT NULL, ton_address TEXT NOT NULL, status TEXT DEFAULT 'pending', tx_hash TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), processed_at TIMESTAMPTZ);"
$withdrawSql | Out-File -Encoding utf8 -FilePath tmp_wd.sql
scp tmp_wd.sql root@204.168.219.20:/tmp/tmp_wd.sql
ssh root@204.168.219.20 "docker cp /tmp/tmp_wd.sql apps_father_db:/tmp/tmp_wd.sql; docker exec apps_father_db psql -U apps_father -d apps_father -f /tmp/tmp_wd.sql"
Remove-Item tmp_wd.sql -ErrorAction SilentlyContinue
Write-Host "Migration OK" -ForegroundColor Green

Write-Host "=== Syncing skills ===" -ForegroundColor Cyan
scp -r skills/* root@204.168.219.20:/opt/apps-father/skills/
Write-Host "Skills OK" -ForegroundColor Green

Write-Host "=== Restarting ===" -ForegroundColor Cyan
ssh root@204.168.219.20 "cd /opt/apps-father && pm2 restart apps-father --update-env --kill-timeout 300000"
if ($LASTEXITCODE -ne 0) {
    Write-Host "Restart failed!" -ForegroundColor Red
    exit 1
}

Write-Host "=== Deployed! ===" -ForegroundColor Green

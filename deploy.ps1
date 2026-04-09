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
Write-Host "Migration OK" -ForegroundColor Green

Write-Host "=== Syncing skills ===" -ForegroundColor Cyan
scp -r skills/* root@204.168.219.20:/opt/apps-father/skills/
Write-Host "Skills OK" -ForegroundColor Green

Write-Host "=== Restarting ===" -ForegroundColor Cyan
ssh root@204.168.219.20 "pm2 restart apps-father --kill-timeout 300000"
if ($LASTEXITCODE -ne 0) {
    Write-Host "Restart failed!" -ForegroundColor Red
    exit 1
}

Write-Host "=== Deployed! ===" -ForegroundColor Green

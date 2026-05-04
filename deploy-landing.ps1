# ============================================================
#  deploy-landing.ps1  —  Deploy landing only
# ============================================================

$choice = Read-Host "Deploy to [P]roduction or [D]ev? (P/D)"
if ($choice -match '^[Dd]') {
    $ENV_NAME = "DEV"
    $SERVER   = "root@62.238.2.16"
    $APP_DIR  = "/opt/apps-father-dev"
    $COLOR    = "Yellow"
} else {
    $ENV_NAME = "PROD"
    $SERVER   = "root@204.168.219.20"
    $APP_DIR  = "/opt/apps-father"
    $COLOR    = "Cyan"
}

Write-Host ">>> Deploying landing to $ENV_NAME <<<" -ForegroundColor $COLOR

# Keep af-sdk.js in sync (source lives in src/web/routes/, served from landing/)
Copy-Item "src\web\routes\af-sdk.js" "landing\af-sdk.js" -Force

ssh $SERVER "mkdir -p ${APP_DIR}/landing/samples"
scp -r landing/* "${SERVER}:${APP_DIR}/landing/"
if ($LASTEXITCODE -ne 0) { Write-Host "Upload failed!" -ForegroundColor Red; exit 1 }

Write-Host "=== landing deployed to $ENV_NAME! ===" -ForegroundColor Green

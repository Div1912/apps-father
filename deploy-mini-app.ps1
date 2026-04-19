# ============================================================
#  deploy-mini-app.ps1  —  Deploy mini_app only (no build)
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

Write-Host ">>> Deploying mini_app to $ENV_NAME <<<" -ForegroundColor $COLOR

ssh $SERVER "mkdir -p ${APP_DIR}/mini_app"
scp -r mini_app/* "${SERVER}:${APP_DIR}/mini_app/"
if ($LASTEXITCODE -ne 0) { Write-Host "Upload failed!" -ForegroundColor Red; exit 1 }

Write-Host "=== mini_app deployed to $ENV_NAME! ===" -ForegroundColor Green

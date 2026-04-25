# ============================================================
#  deploy-admin.ps1  —  Deploy browser Admin CRM only (admin/)
#
#  The SPA is served by the main Node app at /admin (see
#  src/web/routes/admin.routes.ts). Static files live under
#  repo root admin/ — no TypeScript build required for this step.
#
#  Usage (from repo root, PowerShell):
#    .\deploy-admin.ps1              # prompts P / D
#    .\deploy-admin.ps1 -Prod        # production, no prompt
#    .\deploy-admin.ps1 -Dev         # dev, no prompt
#
#  After upload you can open:
#    PROD  https://apps-father.com/admin
#    DEV   https://dev.apps-father.com/admin
#
#  No PM2 restart is required: Express reads static files from disk
#  on each request. Restart only if you also changed dist/ or .env.
# ============================================================

param(
    [switch]$Prod,
    [switch]$Dev
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

if (-not (Test-Path -PathType Container "admin")) {
    Write-Host "admin/ folder not found. Run this script from the app_maker repo root." -ForegroundColor Red
    exit 1
}

$ENV_NAME = $null
if ($Dev -and $Prod) {
    Write-Host "Use only one of -Dev or -Prod." -ForegroundColor Red
    exit 1
}
if ($Dev) {
    $ENV_NAME = "DEV"
    $SERVER   = "root@62.238.2.16"
    $APP_DIR  = "/opt/apps-father-dev"
    $COLOR    = "Yellow"
} elseif ($Prod) {
    $ENV_NAME = "PROD"
    $SERVER   = "root@204.168.219.20"
    $APP_DIR  = "/opt/apps-father"
    $COLOR    = "Cyan"
} else {
    $choice = Read-Host "Deploy admin to [P]roduction or [D]ev? (P/D)"
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
}

Write-Host ">>> Deploying admin/ (browser CRM) to $ENV_NAME <<<" -ForegroundColor $COLOR
Write-Host "    Target: ${SERVER}:${APP_DIR}/admin/" -ForegroundColor DarkGray

ssh $SERVER "mkdir -p ${APP_DIR}/admin/"
if ($LASTEXITCODE -ne 0) { Write-Host "ssh mkdir failed!" -ForegroundColor Red; exit 1 }

scp -r admin/* "${SERVER}:${APP_DIR}/admin/"
if ($LASTEXITCODE -ne 0) { Write-Host "scp upload failed!" -ForegroundColor Red; exit 1 }

Write-Host "=== admin deployed to $ENV_NAME ===" -ForegroundColor Green
if ($ENV_NAME -eq "DEV") {
    Write-Host "    Open: https://dev.apps-father.com/admin" -ForegroundColor Green
} else {
    Write-Host "    Open: https://apps-father.com/admin" -ForegroundColor Green
}

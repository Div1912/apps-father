# ============================================================
#  migrate-workers-to-docker.ps1
#
#  End-to-end docker rollout helper. Runs on a remote DEV/PROD
#  server in the right order:
#    1. install Docker if missing
#    2. push runner/Dockerfile + scripts/build-runner-image.sh + setup-docker-network.sh
#    3. build the apps-father-runner image
#    4. setup the apps-father-runners bridge network + iptables
#    5. run migrate-workers-to-docker.sh (seeds package.json, re-chowns)
#    6. flip RUNTIME_MODE=docker in .env
#    7. pm2 restart
#
#  Controls: TAB=switch env  ENTER=run  Q/ESC=quit
# ============================================================

Set-StrictMode -Off

$ENVS       = @("DEV", "PROD")
$ENV_COLORS = @("Yellow", "Cyan")
$env_idx    = 0

function W {
  param($text, $color)
  $w = [Math]::Max(40, $Host.UI.RawUI.WindowSize.Width)
  $padded = $text.PadRight($w)
  if ($color) { Write-Host $padded -ForegroundColor $color }
  else        { Write-Host $padded }
}

function Draw-TUI {
  [Console]::SetCursorPosition(0, 0)
  $env = $ENVS[$env_idx]
  $ec  = $ENV_COLORS[$env_idx]
  W ""
  W "  +---------------------------------------------------+" DarkGray
  W "  |   APPS FATHER  --  Migrate workers to Docker      |" DarkGray
  W "  +---------------------------------------------------+" DarkGray
  W ""
  W ("  Target: [ " + $env + " ]   (TAB to switch)") $ec
  W ""
  W "  This will:" DarkGray
  W "    1. Install Docker if missing" DarkGray
  W "    2. Build apps-father-runner:latest" DarkGray
  W "    3. Create apps-father-runners network + iptables" DarkGray
  W "    4. Seed package.json for each project, chown to uid 1000" DarkGray
  W "    5. Set RUNTIME_MODE=docker and pm2 restart" DarkGray
  W ""
  W "  TAB=switch env   ENTER=run   Q/ESC=quit" DarkGray
  W ""
}

[Console]::CursorVisible = $false
Clear-Host
for ($p = 0; $p -lt 16; $p++) { Write-Host "" }
Draw-TUI

while ($true) {
  $key = [Console]::ReadKey($true)
  switch ($key.Key) {
    "Tab"    { $env_idx = ($env_idx + 1) % $ENVS.Count }
    "Enter"  { break }
    "Escape" { [Console]::CursorVisible = $true; Clear-Host; exit 0 }
    "Q"      { [Console]::CursorVisible = $true; Clear-Host; exit 0 }
  }
  if ($key.Key -eq "Enter") { break }
  Draw-TUI
}

[Console]::CursorVisible = $true
Clear-Host

if ($env_idx -eq 0) {
  $ENV_NAME = "DEV"
  $SERVER   = "root@62.238.2.16"
  $APP_DIR  = "/opt/apps-father-dev"
  $PM2      = "apps-father-dev"
  $COLOR    = "Yellow"
} else {
  $ENV_NAME = "PROD"
  $SERVER   = "root@138.199.141.66"
  $APP_DIR  = "/opt/apps-father"
  $PM2      = "apps-father"
  $COLOR    = "Cyan"
}

function Step-Header { param($msg); Write-Host ("=== [" + $ENV_NAME + "] " + $msg + " ===") -ForegroundColor $COLOR }
function Step-OK     { param($msg); Write-Host ("  OK: " + $msg) -ForegroundColor Green }
function Step-Err    { param($msg); Write-Host ("  FAIL: " + $msg) -ForegroundColor Red; exit 1 }
function Step-Info   { param($msg); Write-Host ("  --> " + $msg) -ForegroundColor DarkGray }
function Push-Lf {
  param($localPath, $remotePath)
  $tmp = [System.IO.Path]::GetTempFileName()
  $contents = Get-Content $localPath -Raw
  [System.IO.File]::WriteAllText($tmp, $contents.Replace("`r`n", "`n"), [System.Text.Encoding]::UTF8)
  scp -q $tmp ($SERVER + ":" + $remotePath)
  $code = $LASTEXITCODE
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  if ($code -ne 0) { Step-Err ("scp failed: " + $remotePath) }
}

Write-Host (">>> Migrating " + $ENV_NAME + " to Docker workers <<<") -ForegroundColor $COLOR
Write-Host ""

$repoRoot = Split-Path -Parent $PSScriptRoot
$runnerDir       = Join-Path $repoRoot "runner"
$buildScript     = Join-Path $PSScriptRoot "build-runner-image.sh"
$networkScript   = Join-Path $PSScriptRoot "setup-docker-network.sh"
$migrateScript   = Join-Path $PSScriptRoot "migrate-workers-to-docker.sh"

if (-not (Test-Path $runnerDir))     { Step-Err ("runner/ not found at " + $runnerDir) }
if (-not (Test-Path $buildScript))   { Step-Err ("build-runner-image.sh missing")     }
if (-not (Test-Path $networkScript)) { Step-Err ("setup-docker-network.sh missing")   }
if (-not (Test-Path $migrateScript)) { Step-Err ("migrate-workers-to-docker.sh missing") }

# 1. Install Docker if missing
Step-Header "Ensuring Docker is installed"
ssh $SERVER "command -v docker >/dev/null 2>&1 || (curl -fsSL https://get.docker.com | sh)"
if ($LASTEXITCODE -ne 0) { Step-Err "docker install failed" }
Step-OK "docker present"

# 2. Sync runner/, build script, network script, migrate script
Step-Header "Syncing runner/ and helper scripts"
ssh $SERVER ("mkdir -p " + $APP_DIR + "/scripts")
if ($LASTEXITCODE -ne 0) { Step-Err "ssh mkdir failed" }
scp -q -r $runnerDir ($SERVER + ":" + $APP_DIR + "/")
if ($LASTEXITCODE -ne 0) { Step-Err "scp runner/ failed" }
Push-Lf $buildScript   ($APP_DIR + "/scripts/build-runner-image.sh")
Push-Lf $networkScript ($APP_DIR + "/scripts/setup-docker-network.sh")
Push-Lf $migrateScript ($APP_DIR + "/scripts/migrate-workers-to-docker.sh")
ssh $SERVER ("chmod +x " + $APP_DIR + "/scripts/*.sh")
Step-OK "scripts synced"

# 3. Build runner image
Step-Header "Building apps-father-runner:latest (1-3 minutes on first build)"
ssh -t $SERVER ("cd " + $APP_DIR + " && bash scripts/build-runner-image.sh")
if ($LASTEXITCODE -ne 0) { Step-Err "image build failed" }
Step-OK "image built"

# 4. Setup network + iptables
Step-Header "Setting up apps-father-runners bridge network"
ssh -t $SERVER ("bash " + $APP_DIR + "/scripts/setup-docker-network.sh")
if ($LASTEXITCODE -ne 0) { Step-Err "network setup failed" }
Step-OK "network ready"

# 5. Per-project migration
Step-Header "Seeding per-project package.json + chown"
ssh -t $SERVER ("APP_DIR=" + $APP_DIR + " bash " + $APP_DIR + "/scripts/migrate-workers-to-docker.sh")
if ($LASTEXITCODE -ne 0) { Step-Err "migration script failed" }
Step-OK "projects prepared"

# 6. Flip RUNTIME_MODE=docker in .env (idempotent)
Step-Header "Setting RUNTIME_MODE=docker in .env"
ssh $SERVER "sed -i '/^RUNTIME_MODE=/d' $APP_DIR/.env && echo 'RUNTIME_MODE=docker' >> $APP_DIR/.env"
if ($LASTEXITCODE -ne 0) { Step-Err "failed to update .env" }
Step-OK "RUNTIME_MODE=docker"

# 7. pm2 restart
Step-Header "Restarting pm2 process: $PM2"
ssh $SERVER ("pm2 restart " + $PM2 + " --update-env")
if ($LASTEXITCODE -ne 0) { Step-Err "pm2 restart failed" }
Step-OK "pm2 restarted"

Write-Host ""
Write-Host ">>> Migration complete." -ForegroundColor Green
Write-Host ""
Write-Host "Verify with:" -ForegroundColor DarkGray
Write-Host ("  ssh " + $SERVER + " 'pm2 logs " + $PM2 + " --lines 50 --nostream'") -ForegroundColor DarkGray
Write-Host ("  ssh " + $SERVER + " 'docker ps --filter label=afp.runner=worker'") -ForegroundColor DarkGray
Write-Host ""

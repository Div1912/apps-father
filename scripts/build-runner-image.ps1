# ============================================================
#  build-runner-image.ps1
#
#  Builds the apps-father-runner Docker image on a remote dev/prod
#  server. Wraps `scripts/build-runner-image.sh` with an SSH transport.
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
  W "  |   APPS FATHER  --  Build runner Docker image      |" DarkGray
  W "  +---------------------------------------------------+" DarkGray
  W ""
  W ("  Target: [ " + $env + " ]   (TAB to switch)") $ec
  W ""
  W "  Will sync runner/ + scripts/build-runner-image.sh," DarkGray
  W "  then docker build apps-father-runner:latest." DarkGray
  W ""
  W "  TAB=switch env   ENTER=run   Q/ESC=quit" DarkGray
  W ""
}

[Console]::CursorVisible = $false
Clear-Host
for ($p = 0; $p -lt 14; $p++) { Write-Host "" }
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
  $COLOR    = "Yellow"
} else {
  $ENV_NAME = "PROD"
  $SERVER   = "root@138.199.141.66"
  $APP_DIR  = "/opt/apps-father"
  $COLOR    = "Cyan"
}

function Step-Header { param($msg); Write-Host ("=== [" + $ENV_NAME + "] " + $msg + " ===") -ForegroundColor $COLOR }
function Step-OK     { param($msg); Write-Host ("  OK: " + $msg) -ForegroundColor Green }
function Step-Err    { param($msg); Write-Host ("  FAIL: " + $msg) -ForegroundColor Red; exit 1 }
function Step-Info   { param($msg); Write-Host ("  --> " + $msg) -ForegroundColor DarkGray }

Write-Host (">>> Build runner image on " + $ENV_NAME + " <<<") -ForegroundColor $COLOR
Write-Host ""

$repoRoot = Split-Path -Parent $PSScriptRoot
$runnerDir = Join-Path $repoRoot "runner"
$buildScript = Join-Path $PSScriptRoot "build-runner-image.sh"

if (-not (Test-Path $runnerDir))    { Step-Err ("runner/ not found at " + $runnerDir) }
if (-not (Test-Path $buildScript))  { Step-Err ("build-runner-image.sh not found at " + $buildScript) }

# 1. Sync runner/ folder (Dockerfile + worker-entry.js + lib + package.json)
Step-Header "Syncing runner/"
scp -q -r $runnerDir ($SERVER + ":" + $APP_DIR + "/")
if ($LASTEXITCODE -ne 0) { Step-Err "scp runner/ failed" }
Step-OK "runner/ synced"

# 2. Sync the build script (with LF line endings)
Step-Header "Syncing build script"
$tmp = Join-Path $PSScriptRoot ".build_runner_image_tmp.sh"
$contents = Get-Content $buildScript -Raw
[System.IO.File]::WriteAllText($tmp, $contents.Replace("`r`n", "`n"), [System.Text.Encoding]::UTF8)
ssh $SERVER ("mkdir -p " + $APP_DIR + "/scripts")
if ($LASTEXITCODE -ne 0) { Step-Err "ssh mkdir failed" }
scp -q $tmp ($SERVER + ":" + $APP_DIR + "/scripts/build-runner-image.sh")
if ($LASTEXITCODE -ne 0) { Step-Err "scp build script failed" }
ssh $SERVER ("chmod +x " + $APP_DIR + "/scripts/build-runner-image.sh")
Remove-Item $tmp -Force -ErrorAction SilentlyContinue
Step-OK "build script synced"

# 3. Run docker build remotely
Step-Header "Running docker build (this may take 1-3 minutes on first build)"
ssh -t $SERVER ("cd " + $APP_DIR + " && bash scripts/build-runner-image.sh")
if ($LASTEXITCODE -ne 0) { Step-Err "remote build failed" }

Write-Host ""
Step-OK "Image built. Run setup-docker-network next if not already done."
Write-Host ""

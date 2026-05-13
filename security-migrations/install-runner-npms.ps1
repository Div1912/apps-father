# ============================================================
#  install-runner-npms.ps1
#  Scans all project routes.js files on the server, filters
#  every third-party require() against runner-npm-allowlist.json,
#  and installs ONLY allowlisted packages with --ignore-scripts.
#
#  This is the server-side counterpart to the agent-side npm_install
#  tool. Both honour the same allowlist, so even if a routes.js
#  bypasses the agent (manual edit, revert to old commit) the
#  installer refuses to pull non-allowlisted packages.
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
  W "  |   APPS FATHER  --  Install Runner npm packages    |" DarkGray
  W "  +---------------------------------------------------+" DarkGray
  W ""
  W ("  Target: [ " + $env + " ]   (TAB to switch)") $ec
  W ""
  W "  This script will:" DarkGray
  W "    1. Sync runner-npm-allowlist.json to the server" DarkGray
  W "    2. Scan all /srv/apps-father/projects/*/backend/routes.js" DarkGray
  W "    3. Reject any require() that is NOT on the allowlist" DarkGray
  W "    4. Install allowlisted+missing packages with --ignore-scripts" DarkGray
  W ""
  W "  TAB=switch env   ENTER=run   Q/ESC=quit" DarkGray
  W ""
}

[Console]::CursorVisible = $false
Clear-Host

$linesNeeded = 16
for ($p = 0; $p -lt $linesNeeded; $p++) { Write-Host "" }
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

# ── Resolve server config ──────────────────────────────────
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

# Both envs share the same srv path (RUNNER_PROJECTS_ROOT default in config.ts)
$SRV_PROJECTS = "/srv/apps-father/projects"

Write-Host (">>> Scanning runner npm packages on " + $ENV_NAME + " <<<") -ForegroundColor $COLOR
Write-Host ""

function Step-Header { param($msg); Write-Host ("=== [" + $ENV_NAME + "] " + $msg + " ===") -ForegroundColor $COLOR }
function Step-OK     { param($msg); Write-Host ("  OK: " + $msg) -ForegroundColor Green }
function Step-Err    { param($msg); Write-Host ("  FAIL: " + $msg) -ForegroundColor Red; exit 1 }
function Step-Info   { param($msg); Write-Host ("  --> " + $msg) -ForegroundColor DarkGray }

Step-Header "Preparing scan script"
Step-Info ("Server      : " + $SERVER)
Step-Info ("App dir     : " + $APP_DIR)
Step-Info ("Srv projects: " + $SRV_PROJECTS)
Write-Host ""

# ── Sync the allowlist to the server ──────────────────────────────────────
Step-Header "Syncing runner-npm-allowlist.json"
$repoRoot = Split-Path -Parent $PSScriptRoot
$allowlistLocal = Join-Path $repoRoot "runner-npm-allowlist.json"
if (-not (Test-Path $allowlistLocal)) {
  Step-Err ("runner-npm-allowlist.json not found at repo root: " + $allowlistLocal)
}
scp -q $allowlistLocal ($SERVER + ":" + $APP_DIR + "/runner-npm-allowlist.json")
if ($LASTEXITCODE -ne 0) { Step-Err "scp allowlist failed" }
Step-OK "allowlist synced"
Write-Host ""

# Read the bash script, substitute placeholders, write with LF line endings
$bashScriptPath = Join-Path $PSScriptRoot "runner-npm-scan.sh"
if (-not (Test-Path $bashScriptPath)) {
  Step-Err ("runner-npm-scan.sh not found next to this script: " + $bashScriptPath)
}

$bashScript = Get-Content $bashScriptPath -Raw
$bashScript = $bashScript.Replace("%%APP_DIR%%", $APP_DIR).Replace("%%SRV_PROJECTS%%", $SRV_PROJECTS)

# Write with LF (not CRLF) so bash on Linux doesn't choke
$tmpScript = Join-Path $PSScriptRoot ".runner_npm_scan_tmp.sh"
[System.IO.File]::WriteAllText($tmpScript, $bashScript.Replace("`r`n", "`n"), [System.Text.Encoding]::UTF8)

scp -q $tmpScript ($SERVER + ":/tmp/runner_npm_scan.sh")
if ($LASTEXITCODE -ne 0) { Step-Err "scp failed" }

Remove-Item $tmpScript -Force -ErrorAction SilentlyContinue

ssh $SERVER "bash /tmp/runner_npm_scan.sh; rm -f /tmp/runner_npm_scan.sh"
if ($LASTEXITCODE -ne 0) { Step-Err "Remote script failed" }

Write-Host ""
Step-OK "Scan complete"
Write-Host ""
Write-Host "  To restart PM2 now:" -ForegroundColor DarkGray
Write-Host ("  ssh " + $SERVER + " 'pm2 restart " + $PM2 + "'") -ForegroundColor DarkGray
Write-Host ""

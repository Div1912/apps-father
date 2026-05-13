# ============================================================
#  migrate-to-runner.ps1
#  Uploads scripts/migrate-to-runner-dev.js to the chosen server
#  with LF line endings, then runs it via SSH.
#
#  The migration moves projects from the legacy in-process tree
#    /opt/apps-father-dev/projects/<id>/{release,development}/...
#  to the per-project worker tree
#    /srv/apps-father/projects/<id>/{release,development}/...
#  including frontend/, backend/, and data/ — and provisions the
#  per-project Linux user (afp_<10hex(sha256(id))>).
#
#  Idempotent — safe to re-run.
#
#  Controls: TAB=switch env  D=toggle dry-run  ENTER=run  Q/ESC=quit
# ============================================================

Set-StrictMode -Off

$ENVS       = @("DEV", "PROD")
$ENV_COLORS = @("Yellow", "Cyan")
$env_idx    = 0
$dry_run    = $false

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
  $dryLabel = if ($dry_run) { "[ ON ]" } else { "[ OFF ]" }
  $dryColor = if ($dry_run) { "Green" } else { "DarkGray" }

  W ""
  W "  +---------------------------------------------------+" DarkGray
  W "  |   APPS FATHER  --  Migrate Projects to /srv/      |" DarkGray
  W "  +---------------------------------------------------+" DarkGray
  W ""
  W ("  Target  : [ " + $env + " ]   (TAB to switch)") $ec
  W ("  Dry-run : " + $dryLabel + "   (D to toggle)") $dryColor
  W ""
  W "  This script will:" DarkGray
  W "    1. scp scripts/migrate-to-runner-dev.js to the server" DarkGray
  W "    2. Run it under APP_DIR with the platform's prisma client" DarkGray
  W "    3. Move frontend+backend+data from /opt/.../projects to /srv" DarkGray
  W "    4. Provision per-project Linux users (afp_*)" DarkGray
  W "    5. Clear worker_port so the next request lazy-spawns" DarkGray
  W ""
  W "  TAB=switch env   D=toggle dry-run   ENTER=run   Q/ESC=quit" DarkGray
  W ""
}

[Console]::CursorVisible = $false
Clear-Host

$linesNeeded = 18
for ($p = 0; $p -lt $linesNeeded; $p++) { Write-Host "" }
Draw-TUI

while ($true) {
  $key = [Console]::ReadKey($true)
  switch ($key.Key) {
    "Tab"    { $env_idx = ($env_idx + 1) % $ENVS.Count }
    "D"      { $dry_run = -not $dry_run }
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
  $COLOR    = "Yellow"
} else {
  $ENV_NAME = "PROD"
  $SERVER   = "root@138.199.141.66"
  $APP_DIR  = "/opt/apps-father"
  $COLOR    = "Cyan"
}

$ENV_LABEL = if ($dry_run) { $ENV_NAME + " (dry-run)" } else { $ENV_NAME }

Write-Host (">>> Migrating projects on " + $ENV_LABEL + " <<<") -ForegroundColor $COLOR
Write-Host ""

function Step-Header { param($msg); Write-Host ("=== [" + $ENV_LABEL + "] " + $msg + " ===") -ForegroundColor $COLOR }
function Step-OK     { param($msg); Write-Host ("  OK: " + $msg) -ForegroundColor Green }
function Step-Err    { param($msg); Write-Host ("  FAIL: " + $msg) -ForegroundColor Red; exit 1 }
function Step-Info   { param($msg); Write-Host ("  --> " + $msg) -ForegroundColor DarkGray }

Step-Header "Plan"
Step-Info ("Server   : " + $SERVER)
Step-Info ("App dir  : " + $APP_DIR)
Step-Info ("Dry-run  : " + $dry_run)
Write-Host ""

# ── Locate the migration script in the repo ─────────────────────────────────
$repoRoot = Split-Path -Parent $PSScriptRoot
$jsLocal  = Join-Path $repoRoot "scripts/migrate-to-runner-dev.js"
if (-not (Test-Path $jsLocal)) {
  Step-Err ("scripts/migrate-to-runner-dev.js not found at: " + $jsLocal)
}

# ── Upload with LF line endings ─────────────────────────────────────────────
# Windows checkouts normally have CRLF; node tolerates that for .js files
# (no shebang interpretation), but a clean LF upload avoids surprises if the
# script later grows shell-out blocks or sourcing.
Step-Header "Uploading migration script"
$jsTmp = Join-Path $PSScriptRoot ".migrate_tmp.js"
$content = Get-Content $jsLocal -Raw
[System.IO.File]::WriteAllText($jsTmp, $content.Replace("`r`n", "`n"), (New-Object System.Text.UTF8Encoding $false))

scp -q $jsTmp ($SERVER + ":/tmp/migrate-to-runner-dev.js")
$scpRc = $LASTEXITCODE
Remove-Item $jsTmp -Force -ErrorAction SilentlyContinue
if ($scpRc -ne 0) { Step-Err "scp failed" }
Step-OK "uploaded"
Write-Host ""

# ── Run it on the server ────────────────────────────────────────────────────
Step-Header "Running migration"
$flag = if ($dry_run) { " --dry-run" } else { "" }
# Run from APP_DIR so the script's `process.chdir(APP_DIR)` resolves the
# bundled @prisma/client. RUNNER_PROJECTS_ROOT defaults to /srv/apps-father/projects.
$remoteCmd = (
  "cd " + $APP_DIR + " && " +
  "APP_DIR=" + $APP_DIR + " " +
  "MIGRATE_SOURCE_ROOT=" + $APP_DIR + "/projects " +
  "node /tmp/migrate-to-runner-dev.js" + $flag + "; " +
  "rc=`$?; rm -f /tmp/migrate-to-runner-dev.js; exit `$rc"
)
ssh $SERVER $remoteCmd
$runRc = $LASTEXITCODE
Write-Host ""

if ($runRc -eq 0) {
  Step-OK "migration finished"
} elseif ($runRc -eq 2) {
  Write-Host "  WARN: migration finished but some projects failed (exit code 2). See per-project log on the server." -ForegroundColor Yellow
} else {
  Step-Err ("migration failed with exit code " + $runRc)
}

Write-Host ""
Write-Host "  Migration logs are written next to the script on the server." -ForegroundColor DarkGray
Write-Host ("  ssh " + $SERVER + " 'ls -lt /tmp/migration-*.log 2>/dev/null | head -3'") -ForegroundColor DarkGray
Write-Host ""

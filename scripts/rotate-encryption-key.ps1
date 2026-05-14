# ============================================================
#  rotate-encryption-key.ps1
#
#  Rotates ENCRYPTION_KEY on the production server:
#    1. Generates a new 32-byte hex key locally
#    2. Backs up the database
#    3. Dry-runs scripts/rotate-encryption-key.js on the server
#    4. Asks for confirmation before applying
#    5. Applies the rotation (re-encrypts all botTokenEncrypted rows)
#    6. Updates ENCRYPTION_KEY in /opt/apps-father/.env on the server
#    7. Restarts PM2 with --update-env
#    8. Tails logs to confirm all bots loaded
# ============================================================

Set-StrictMode -Off

$SERVER  = "root@138.199.141.66"
$APP_DIR = "/opt/apps-father"
$PM2     = "apps-father"

function W {
  param($t, $c)
  if ($c) { Write-Host $t -ForegroundColor $c } else { Write-Host $t }
}
function OK   { param($t); W ("  OK: " + $t) Green }
function Fail { param($t); W ("  FAIL: " + $t) Red; exit 1 }
function Step {
  param($t)
  Write-Host ""
  Write-Host ("=== " + $t + " ===") -ForegroundColor Cyan
}
function Info { param($t); W ("  --> " + $t) DarkGray }

W ""
W "  +---------------------------------------------------+" DarkGray
W "  |   APPS FATHER  --  Rotate Encryption Key (PROD)  |" DarkGray
W "  +---------------------------------------------------+" DarkGray
W ""

# ── Read current key from local .env ─────────────────────────────────────────
$localEnvPath = Join-Path (Split-Path $PSScriptRoot -Parent) ".env"
$oldKey = ""
if (Test-Path $localEnvPath) {
  $line = Get-Content $localEnvPath | Where-Object { $_ -match "^ENCRYPTION_KEY=" } | Select-Object -First 1
  if ($line) { $oldKey = ($line -split "=", 2)[1].Trim() }
}
if (-not $oldKey) {
  W "  Could not read ENCRYPTION_KEY from local .env." Yellow
  $oldKey = Read-Host "  Enter the current OLD ENCRYPTION_KEY"
}
if ($oldKey.Length -lt 32) { Fail "OLD key looks too short ($($oldKey.Length) chars). Aborting." }

W ("  Server:  " + $SERVER) DarkGray
W ("  App dir: " + $APP_DIR) DarkGray
W ("  Old key: " + $oldKey.Substring(0,8) + "..." + $oldKey.Substring($oldKey.Length - 4)) DarkGray
W ""
W "  This will re-encrypt all botTokenEncrypted rows in Postgres." Yellow
W "  A database backup is taken before any changes." Yellow
W ""
$confirm = Read-Host "  Continue? (yes/no)"
if ($confirm -ne "yes") { W "  Aborted." Yellow; exit 0 }

# ── 1. Generate new key ───────────────────────────────────────────────────────
W ""
W "=== Generating new 32-byte hex key ===" Cyan
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$newKey = ($bytes | ForEach-Object { $_.ToString("x2") }) -join ""
W ""
W ("  NEW KEY: " + $newKey) Green
W ""
W "  !!! Save this somewhere safe before proceeding !!!" Yellow
W ("  Old key (keep for 7 days): " + $oldKey) DarkGray
W ""
$saved = Read-Host "  Saved the new key? (yes/no)"
if ($saved -ne "yes") { W "  Aborted. Run again when ready." Yellow; exit 0 }
OK "New key ready"

# ── 2. Backup database ────────────────────────────────────────────────────────
W ""
W "=== Backing up database ===" Cyan
$ts = Get-Date -Format "yyyy-MM-dd-HHmmss"
$backupFile = "/root/db-pre-keyrotate-$ts.sql"
ssh $SERVER "docker exec apps_father_db pg_dump -U apps_father apps_father > $backupFile; ls -lh $backupFile"
if ($LASTEXITCODE -ne 0) { Fail "Database backup failed. Aborting." }
OK "Database backed up to $backupFile"

# ── 3. Dry-run ────────────────────────────────────────────────────────────────
W ""
W "=== Dry-run rotation (no writes) ===" Cyan
$dryCmd = "cd $APP_DIR; OLD_ENCRYPTION_KEY=$oldKey NEW_ENCRYPTION_KEY=$newKey node scripts/rotate-encryption-key.js"
ssh $SERVER $dryCmd
if ($LASTEXITCODE -ne 0) { Fail "Dry-run exited with error. Check output above." }
W ""
W "  Review the SUMMARY above." Yellow
W "  'failed (left untouched)' MUST be 0 before continuing." Yellow
W ""
$dryOk = Read-Host "  Dry-run clean? (yes/no)"
if ($dryOk -ne "yes") { W "  Aborted. Fix failures and re-run." Yellow; exit 0 }
OK "Dry-run confirmed clean"

# ── 4. Apply ──────────────────────────────────────────────────────────────────
W ""
W "=== Applying rotation (writing to DB) ===" Cyan
$applyCmd = "cd $APP_DIR; OLD_ENCRYPTION_KEY=$oldKey NEW_ENCRYPTION_KEY=$newKey node scripts/rotate-encryption-key.js --apply"
ssh $SERVER $applyCmd
if ($LASTEXITCODE -ne 0) { Fail "Rotation --apply failed. DB backup is at $backupFile on server." }
OK "All rows re-encrypted"

# ── 5. Update .env on server ──────────────────────────────────────────────────
W ""
W "=== Updating ENCRYPTION_KEY in .env on server ===" Cyan
$sedCmd = "sed -i 's|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$newKey|' $APP_DIR/.env; grep ^ENCRYPTION_KEY= $APP_DIR/.env"
ssh $SERVER $sedCmd
if ($LASTEXITCODE -ne 0) { Fail "Failed to update .env on server. Edit manually: ssh $SERVER" }
OK ".env updated on server"

# ── 6. Restart PM2 ────────────────────────────────────────────────────────────
W ""
W "=== Restarting PM2 ===" Cyan
ssh $SERVER "pm2 restart $PM2 --update-env"
if ($LASTEXITCODE -ne 0) { Fail "PM2 restart failed. Run manually: ssh $SERVER 'pm2 restart $PM2 --update-env'" }
OK "PM2 restarted"

# ── 7. Verify ─────────────────────────────────────────────────────────────────
W ""
W "=== Waiting 5s then checking logs ===" Cyan
Start-Sleep -Seconds 5
ssh $SERVER "pm2 logs $PM2 --lines 80 --nostream"

# ── Done ──────────────────────────────────────────────────────────────────────
W ""
W "  +---------------------------------------------------+" Green
W "  |             ROTATION COMPLETE                     |" Green
W "  +---------------------------------------------------+" Green
W ""
W "  Check logs above for 'Apps Father is running' with no 'decrypt failed' lines." Yellow
W ""
W "  NOW update your LOCAL .env line 19 to:" Cyan
W ("  ENCRYPTION_KEY=" + $newKey) Green
W ""
W ("  Old key for rollback (delete after 7 days): " + $oldKey) DarkGray
W ""

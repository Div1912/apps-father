# ============================================================
#  transfer-project-dev-to-prod.ps1
#  Copies a single project from the DEV server to PROD.
#
#  What it does:
#    1. Validates the project exists on DEV (DB + files)
#    2. Dumps the project's DB row from DEV postgres
#    3. Re-encrypts the bot token (DEV key → PROD key)
#    4. Inserts/upserts the project row into PROD postgres
#    5. Copies the project filesystem (rsync over SSH)
#    6. Fixes ownership on PROD
#    7. Prints next steps (register a bot webhook on PROD)
#
#  Usage:
#    .\scripts\transfer-project-dev-to-prod.ps1
#  Then enter the project UUID when prompted.
# ============================================================
Set-StrictMode -Off

$DEV_SERVER  = "root@62.238.2.16"
$PROD_SERVER = "root@138.199.141.66"

$DEV_APP_DIR  = "/opt/apps-father-dev"
$PROD_APP_DIR = "/opt/apps-father"

$DEV_DB_CTR  = "apps_father_dev_db"
$PROD_DB_CTR = "apps_father_db"
$DB_USER     = "apps_father"
$DB_NAME     = "apps_father"

$DEV_PROJECTS_DIR  = "/srv/apps-father-dev/projects"
$PROD_PROJECTS_DIR = "/srv/apps-father/projects"

# ── helpers ────────────────────────────────────────────────────────────────
function Step([string]$msg) {
  Write-Host ""
  Write-Host "=== $msg ===" -ForegroundColor Cyan
}

function Ok([string]$msg)   { Write-Host "  OK: $msg"    -ForegroundColor Green  }
function Fail([string]$msg) { Write-Host "  FAIL: $msg"  -ForegroundColor Red; exit 1 }
function Info([string]$msg) { Write-Host "  $msg"        -ForegroundColor Gray   }

function Run-SSH([string]$server, [string]$cmd) {
  $out = ssh $server $cmd 2>&1
  return $out
}

# ── 1. Prompt for project ID ────────────────────────────────────────────────
Write-Host ""
Write-Host "Transfer project: DEV → PROD" -ForegroundColor Yellow
Write-Host "────────────────────────────────────" -ForegroundColor Yellow
$PROJECT_ID = Read-Host "Enter project UUID from DEV"
$PROJECT_ID = $PROJECT_ID.Trim()

if ($PROJECT_ID -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') {
  Fail "Invalid UUID format: $PROJECT_ID"
}

# ── 2. Check project exists on DEV ─────────────────────────────────────────
Step "Checking project on DEV"

$devCheck = Run-SSH $DEV_SERVER ("docker exec " + $DEV_DB_CTR + " psql -U " + $DB_USER + " -d " + $DB_NAME + " -tAc `"SELECT id,name,status FROM projects WHERE id='$PROJECT_ID'`"")
if (-not $devCheck -or $devCheck.Trim() -eq "") {
  Fail "Project $PROJECT_ID not found in DEV database"
}
Ok "Found: $($devCheck.Trim())"

$devFiles = Run-SSH $DEV_SERVER "ls $DEV_PROJECTS_DIR/$PROJECT_ID/ 2>/dev/null || echo MISSING"
if ($devFiles -eq "MISSING") {
  Fail "Project files not found at $DEV_PROJECTS_DIR/$PROJECT_ID on DEV"
}
Ok "Files exist on DEV: $($devFiles -join ', ')"

# ── 3. Check if project already exists on PROD ─────────────────────────────
Step "Checking PROD"

$prodCheck = Run-SSH $PROD_SERVER ("docker exec " + $PROD_DB_CTR + " psql -U " + $DB_USER + " -d " + $DB_NAME + " -tAc `"SELECT id FROM projects WHERE id='$PROJECT_ID'`"")
if ($prodCheck -and $prodCheck.Trim() -ne "") {
  Write-Host "  WARNING: Project already exists on PROD." -ForegroundColor Yellow
  $confirm = Read-Host "  Overwrite? Files will be synced, DB row will be updated (y/N)"
  if ($confirm.Trim().ToLower() -ne "y") {
    Write-Host "Aborted." -ForegroundColor Yellow
    exit 0
  }
}

# ── 4. Dump full DB row from DEV as INSERT ──────────────────────────────────
Step "Exporting project DB row from DEV"

$dumpFile = "/tmp/transfer_project_$PROJECT_ID.sql"

# Export as INSERT using pg_dump row filter
$dumpCmd = "docker exec $DEV_DB_CTR pg_dump -U $DB_USER -d $DB_NAME --table=projects --data-only --where=`"id='$PROJECT_ID'`" -f $dumpFile 2>&1 && echo OK_DUMP"
$dumpResult = Run-SSH $DEV_SERVER $dumpCmd
if ($dumpResult -notcontains "OK_DUMP") {
  Fail "pg_dump failed: $dumpResult"
}
Ok "Row dumped to $dumpFile on DEV container"

# Copy dump file out of the DEV container to DEV host, then to local, then to PROD
Run-SSH $DEV_SERVER "docker cp ${DEV_DB_CTR}:$dumpFile /tmp/transfer_project_$PROJECT_ID.sql" | Out-Null

$localTmp = [System.IO.Path]::GetTempPath() + "transfer_project_$PROJECT_ID.sql"
scp "${DEV_SERVER}:/tmp/transfer_project_$PROJECT_ID.sql" $localTmp 2>&1 | Out-Null
Ok "Dump copied locally: $localTmp"

# ── 5. Re-encrypt bot token (DEV key → PROD key) ────────────────────────────
Step "Re-encrypting bot token"

# Read ENCRYPTION_KEY from both servers
$devKey  = (Run-SSH $DEV_SERVER  "grep ENCRYPTION_KEY $DEV_APP_DIR/.env | head -1").Trim()
$prodKey = (Run-SSH $PROD_SERVER "grep ENCRYPTION_KEY $PROD_APP_DIR/.env | head -1").Trim()

$devEncKey  = ($devKey  -replace '^ENCRYPTION_KEY\s*=\s*', '').Trim('"').Trim("'")
$prodEncKey = ($prodKey -replace '^ENCRYPTION_KEY\s*=\s*', '').Trim('"').Trim("'")

if (-not $devEncKey) {
  Write-Host "  WARNING: Could not read DEV ENCRYPTION_KEY — bot token will NOT be re-encrypted." -ForegroundColor Yellow
  Write-Host "  The project will exist on PROD but the bot won't start until you re-link it." -ForegroundColor Yellow
} elseif ($devEncKey -eq $prodEncKey) {
  Ok "DEV and PROD use the same ENCRYPTION_KEY — no re-encryption needed"
} else {
  Ok "Keys differ — uploading re-encryption script to PROD"

  # Upload the rotate script to PROD and run it in single-row mode
  scp "$PSScriptRoot\rotate-encryption-key.js" "${PROD_SERVER}:$PROD_APP_DIR/scripts/rotate-encryption-key.js" 2>&1 | Out-Null

  $reencryptCmd = "cd $PROD_APP_DIR && OLD_ENCRYPTION_KEY='$devEncKey' NEW_ENCRYPTION_KEY='$prodEncKey' SINGLE_PROJECT_ID='$PROJECT_ID' node scripts/rotate-encryption-key.js --apply 2>&1 | tail -5"
  $reencryptResult = Run-SSH $PROD_SERVER $reencryptCmd
  Info $reencryptResult

  Write-Host "  NOTE: If re-encryption fails, re-link the bot from the project settings on PROD after transfer." -ForegroundColor Yellow
}

# ── 6. Import DB row into PROD ──────────────────────────────────────────────
Step "Importing DB row into PROD"

# Copy SQL file to PROD
scp $localTmp "${PROD_SERVER}:/tmp/transfer_project_$PROJECT_ID.sql" 2>&1 | Out-Null

# Copy into PROD DB container
Run-SSH $PROD_SERVER "docker cp /tmp/transfer_project_$PROJECT_ID.sql ${PROD_DB_CTR}:/tmp/transfer_project_$PROJECT_ID.sql" | Out-Null

# Check if user exists on PROD (the project owner)
$ownerIdRaw = Run-SSH $DEV_SERVER ("docker exec " + $DEV_DB_CTR + " psql -U " + $DB_USER + " -d " + $DB_NAME + " -tAc `"SELECT user_id FROM projects WHERE id='$PROJECT_ID'`"")
$ownerId = $ownerIdRaw.Trim()
Info "Project owner DB id: $ownerId"

$ownerTgRaw = Run-SSH $DEV_SERVER ("docker exec " + $DEV_DB_CTR + " psql -U " + $DB_USER + " -d " + $DB_NAME + " -tAc `"SELECT telegram_id FROM users WHERE id=$ownerId`"")
$ownerTgId = $ownerTgRaw.Trim()
Info "Project owner Telegram ID: $ownerTgId"

# Check if user exists on PROD by telegram_id
$prodUserId = (Run-SSH $PROD_SERVER ("docker exec " + $PROD_DB_CTR + " psql -U " + $DB_USER + " -d " + $DB_NAME + " -tAc `"SELECT id FROM users WHERE telegram_id=$ownerTgId`"")).Trim()

if (-not $prodUserId) {
  Write-Host ""
  Write-Host "  WARNING: User with Telegram ID $ownerTgId not found on PROD." -ForegroundColor Yellow
  Write-Host "  The user must open the app on PROD at least once before the project can be assigned." -ForegroundColor Yellow
  Write-Host "  After they open it, run this script again or manually update the user_id in the DB." -ForegroundColor Yellow
  $confirm2 = Read-Host "  Continue anyway (project will import with original user_id which may not match)? (y/N)"
  if ($confirm2.Trim().ToLower() -ne "y") {
    Write-Host "Aborted. Ask the user to open the app on PROD first." -ForegroundColor Yellow
    exit 0
  }
  $finalUserId = $ownerId
} else {
  Ok "User found on PROD with id=$prodUserId"
  $finalUserId = $prodUserId
}

# Import: delete existing row if present, then insert
$importCmd = @"
docker exec $PROD_DB_CTR psql -U $DB_USER -d $DB_NAME -c "DELETE FROM projects WHERE id='$PROJECT_ID'" 2>&1 | tail -1
docker exec $PROD_DB_CTR psql -U $DB_USER -d $DB_NAME -f /tmp/transfer_project_$PROJECT_ID.sql 2>&1 | tail -3
docker exec $PROD_DB_CTR psql -U $DB_USER -d $DB_NAME -c "UPDATE projects SET user_id=$finalUserId WHERE id='$PROJECT_ID'" 2>&1 | tail -1
"@
$importResult = Run-SSH $PROD_SERVER $importCmd
Info $importResult
Ok "Project row imported into PROD DB"

# ── 7. Copy project files DEV → PROD ───────────────────────────────────────
Step "Copying project files DEV → PROD"

# We rsync directly from DEV to PROD via a temp archive
$tarFile = "/tmp/afp_project_${PROJECT_ID}.tar.gz"
Run-SSH $DEV_SERVER "tar -czf $tarFile -C $DEV_PROJECTS_DIR $PROJECT_ID 2>&1 && echo OK_TAR" | Out-Null

# Download to local then upload to PROD (avoids needing SSH keys between servers)
$localTar = [System.IO.Path]::GetTempPath() + "afp_project_${PROJECT_ID}.tar.gz"
scp "${DEV_SERVER}:${tarFile}" $localTar 2>&1 | Out-Null
Ok "Files downloaded locally ($([math]::Round((Get-Item $localTar).Length / 1MB, 1)) MB)"

scp $localTar "${PROD_SERVER}:${tarFile}" 2>&1 | Out-Null
Ok "Files uploaded to PROD"

$extractCmd = "mkdir -p $PROD_PROJECTS_DIR && tar -xzf $tarFile -C $PROD_PROJECTS_DIR && chown -R 1000:1000 $PROD_PROJECTS_DIR/$PROJECT_ID && echo OK_EXTRACT"
$extractResult = Run-SSH $PROD_SERVER $extractCmd
if ($extractResult -notcontains "OK_EXTRACT") {
  Fail "Failed to extract files on PROD: $extractResult"
}
Ok "Files extracted and ownership fixed on PROD"

# ── 8. Cleanup temp files ───────────────────────────────────────────────────
Step "Cleaning up temp files"
Run-SSH $DEV_SERVER "rm -f $tarFile $dumpFile /tmp/transfer_project_$PROJECT_ID.sql" | Out-Null
Run-SSH $PROD_SERVER "rm -f $tarFile /tmp/transfer_project_$PROJECT_ID.sql" | Out-Null
Remove-Item $localTar -ErrorAction SilentlyContinue
Remove-Item $localTmp -ErrorAction SilentlyContinue
Ok "Done"

# ── 9. Summary ─────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "════════════════════════════════════════" -ForegroundColor Green
Write-Host "  Transfer complete!" -ForegroundColor Green
Write-Host "════════════════════════════════════════" -ForegroundColor Green
Write-Host ""
Write-Host "  Project ID : $PROJECT_ID" -ForegroundColor White
Write-Host "  Owner TG   : $ownerTgId" -ForegroundColor White
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Ask the user to open the project on PROD — it should appear in their project list."
Write-Host "  2. If the bot didn't start, re-link it from project settings (re-encrypts the token)."
Write-Host "  3. The project's worker container will be created automatically on first request."
Write-Host ""

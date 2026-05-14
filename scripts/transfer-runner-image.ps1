# ============================================================
#  transfer-runner-image.ps1
#
#  Copy apps-father-runner:latest from DEV server to PROD via
#  `docker save | ssh | docker load`. Avoids the 1-3 minute
#  rebuild on PROD and guarantees byte-identical images.
#
#  Idempotent: re-running just overwrites the image on PROD.
# ============================================================

Set-StrictMode -Off

$DEV_SERVER  = "root@62.238.2.16"
$PROD_SERVER = "root@138.199.141.66"
$IMAGE       = "apps-father-runner:latest"

function Step-Header { param($msg); Write-Host ("=== " + $msg + " ===") -ForegroundColor Cyan }
function Step-OK     { param($msg); Write-Host ("  OK: " + $msg) -ForegroundColor Green }
function Step-Err    { param($msg); Write-Host ("  FAIL: " + $msg) -ForegroundColor Red; exit 1 }
function Step-Info   { param($msg); Write-Host ("  --> " + $msg) -ForegroundColor DarkGray }

Write-Host ""
Write-Host ">>> Transfer Docker image: DEV --> PROD <<<" -ForegroundColor Cyan
Write-Host ""

# 1. Make sure the image exists on DEV
Step-Header "Checking image on DEV"
ssh $DEV_SERVER ("docker image inspect " + $IMAGE + " >/dev/null")
if ($LASTEXITCODE -ne 0) {
  Step-Err "$IMAGE not found on DEV. Build it first: scripts/build-runner-image.ps1 (DEV)"
}
Step-OK "image present on DEV"

# 2. Make sure docker is installed on PROD
Step-Header "Ensuring Docker is installed on PROD"
ssh $PROD_SERVER "command -v docker >/dev/null 2>&1 || (curl -fsSL https://get.docker.com | sh)"
if ($LASTEXITCODE -ne 0) { Step-Err "docker install failed on PROD" }
Step-OK "docker present on PROD"

# 3. Stream image: dev save → ssh → prod load
Step-Header "Streaming image (DEV save | PROD load)"
$ssh_cmd = "ssh " + $DEV_SERVER + " 'docker save " + $IMAGE + " | gzip' | ssh " + $PROD_SERVER + " 'gunzip | docker load'"
Step-Info $ssh_cmd
Invoke-Expression $ssh_cmd
if ($LASTEXITCODE -ne 0) { Step-Err "image transfer failed" }
Step-OK "image loaded on PROD"

# 4. Verify
Step-Header "Verifying image on PROD"
ssh $PROD_SERVER ("docker image inspect " + $IMAGE + " --format '{{.Id}} ({{.Size}} bytes)'")
if ($LASTEXITCODE -ne 0) { Step-Err "image verification failed" }
Step-OK "image ready on PROD"

Write-Host ""
Write-Host ">>> Transfer complete. Next: scripts/migrate-workers-to-docker.ps1 (PROD)" -ForegroundColor Green
Write-Host ""

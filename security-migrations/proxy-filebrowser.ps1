# ============================================================
#  proxy-filebrowser.ps1
#  Puts the filebrowser (port 9090) behind nginx at /files/
#  so it's accessible via https://your-domain.com/files/
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
  $url = if ($env_idx -eq 0) { "https://dev.apps-father.com/files/" } else { "https://apps-father.com/files/" }

  W ""
  W "  +---------------------------------------------------+" DarkGray
  W "  |   APPS FATHER  --  Proxy Filebrowser via Nginx   |" DarkGray
  W "  +---------------------------------------------------+" DarkGray
  W ""
  W ("  Target: [ " + $env + " ]   (TAB to switch)") $ec
  W ""
  W ("  Filebrowser :9090  ->  " + $url) DarkGray
  W ""
  W "  Steps:" DarkGray
  W "    1. Set filebrowser --baseurl /files" DarkGray
  W "    2. Write /etc/nginx/snippets/filebrowser-proxy.conf" DarkGray
  W "    3. Include snippet in the nginx site config" DarkGray
  W "    4. nginx -t && systemctl reload nginx" DarkGray
  W "    5. Restart filebrowser" DarkGray
  W ""
  W "  TAB=switch env   ENTER=run   Q/ESC=quit" DarkGray
  W ""
}

[Console]::CursorVisible = $false
Clear-Host

$linesNeeded = 20
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

# ── Resolve config ─────────────────────────────────────────
if ($env_idx -eq 0) {
  $ENV_NAME    = "DEV"
  $SERVER      = "root@62.238.2.16"
  $SERVER_NAME = "dev.apps-father.com"
  $NGINX_SITE  = "/etc/nginx/sites-enabled/dev-apps-father.conf"
  $COLOR       = "Yellow"
} else {
  $ENV_NAME    = "PROD"
  $SERVER      = "root@138.199.141.66"
  $SERVER_NAME = "apps-father.com"
  $NGINX_SITE  = "/etc/nginx/sites-enabled/apps-father.conf"
  $COLOR       = "Cyan"
}

$TARGET_URL = "https://$SERVER_NAME/files/"

Write-Host (">>> Proxying filebrowser on " + $ENV_NAME + " <<<") -ForegroundColor $COLOR
Write-Host ("    " + $TARGET_URL) -ForegroundColor $COLOR
Write-Host ""

function Step-Header { param($msg); Write-Host ("=== [" + $ENV_NAME + "] " + $msg + " ===") -ForegroundColor $COLOR }
function Step-OK     { param($msg); Write-Host ("  OK: " + $msg) -ForegroundColor Green }
function Step-Err    { param($msg); Write-Host ("  FAIL: " + $msg) -ForegroundColor Red; exit 1 }
function Step-Info   { param($msg); Write-Host ("  --> " + $msg) -ForegroundColor DarkGray }

# ── Upload and run the bash script ────────────────────────
Step-Header "Preparing setup script"

$bashScriptPath = Join-Path $PSScriptRoot "proxy-filebrowser.sh"
if (-not (Test-Path $bashScriptPath)) {
  Step-Err ("proxy-filebrowser.sh not found: " + $bashScriptPath)
}

$bashScript = Get-Content $bashScriptPath -Raw
$bashScript = $bashScript.Replace("%%SERVER_NAME%%", $SERVER_NAME).Replace("%%NGINX_SITE%%", $NGINX_SITE)

$tmpScript = Join-Path $PSScriptRoot ".proxy_fb_tmp.sh"
[System.IO.File]::WriteAllText($tmpScript, $bashScript.Replace("`r`n", "`n"), [System.Text.Encoding]::UTF8)

Step-Info ("Server     : " + $SERVER)
Step-Info ("Domain     : " + $SERVER_NAME)
Step-Info ("Nginx site : " + $NGINX_SITE)
Step-Info ("Target URL : " + $TARGET_URL)
Write-Host ""

scp -q $tmpScript ($SERVER + ":/tmp/proxy_filebrowser.sh")
if ($LASTEXITCODE -ne 0) { Step-Err "scp failed" }

Remove-Item $tmpScript -Force -ErrorAction SilentlyContinue

ssh $SERVER "bash /tmp/proxy_filebrowser.sh; rm -f /tmp/proxy_filebrowser.sh"
if ($LASTEXITCODE -ne 0) { Step-Err "Remote script failed" }

Write-Host ""
Step-OK "Done!"
Write-Host ""
Write-Host ("  Filebrowser is now at: " + $TARGET_URL) -ForegroundColor Green
Write-Host ""
Write-Host "  Port 9090 can now be blocked in the firewall:" -ForegroundColor DarkGray
Write-Host ("  ssh " + $SERVER + " 'ufw deny 9090 && ufw reload'") -ForegroundColor DarkGray
Write-Host ""

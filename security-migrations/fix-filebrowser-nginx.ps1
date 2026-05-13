# Fix filebrowser nginx proxy (path: /admin/files/)
Set-StrictMode -Off

$ENVS       = @("DEV", "PROD")
$ENV_COLORS = @("Yellow", "Cyan")
$env_idx    = 0

function W { param($t,$c); $w=[Math]::Max(40,$Host.UI.RawUI.WindowSize.Width); $p=$t.PadRight($w); if($c){Write-Host $p -ForegroundColor $c}else{Write-Host $p} }

function Draw-TUI {
  [Console]::SetCursorPosition(0,0)
  $ec = $ENV_COLORS[$env_idx]
  W ""; W "  +---------------------------------------------------+" DarkGray
  W "  |   APPS FATHER  --  Fix Filebrowser Nginx Proxy   |" DarkGray
  W "  +---------------------------------------------------+" DarkGray; W ""
  W ("  Target: [ " + $ENVS[$env_idx] + " ]   (TAB to switch)") $ec; W ""
  W "  Patches nginx config to proxy /admin/files/ -> :9090" DarkGray
  W "  Uses Python for reliable config editing (no sed)" DarkGray
  W "  Creates a .bak backup before touching anything" DarkGray; W ""
  W "  TAB=switch   ENTER=run   Q/ESC=quit" DarkGray; W ""
}

[Console]::CursorVisible = $false; Clear-Host
for ($p=0; $p -lt 14; $p++) { Write-Host "" }
Draw-TUI

while ($true) {
  $key = [Console]::ReadKey($true)
  switch ($key.Key) {
    "Tab"    { $env_idx = ($env_idx+1) % $ENVS.Count }
    "Enter"  { break }
    "Escape" { [Console]::CursorVisible=$true; Clear-Host; exit 0 }
    "Q"      { [Console]::CursorVisible=$true; Clear-Host; exit 0 }
  }
  if ($key.Key -eq "Enter") { break }
  Draw-TUI
}

[Console]::CursorVisible = $true; Clear-Host

if ($env_idx -eq 0) {
  $ENV_NAME    = "DEV";  $SERVER = "root@62.238.2.16"
  $SERVER_NAME = "dev.apps-father.com"
  $NGINX_SITE  = "/etc/nginx/sites-enabled/dev-apps-father.conf"
  $COLOR       = "Yellow"
} else {
  $ENV_NAME    = "PROD"; $SERVER = "root@138.199.141.66"
  $SERVER_NAME = "apps-father.com"
  $NGINX_SITE  = "/etc/nginx/sites-enabled/apps-father.conf"
  $COLOR       = "Cyan"
}

Write-Host (">>> Fix filebrowser proxy on " + $ENV_NAME + " <<<") -ForegroundColor $COLOR
Write-Host ("    https://$SERVER_NAME/filebrowser/") -ForegroundColor $COLOR
Write-Host ""

$bashPath = Join-Path $PSScriptRoot "fix-filebrowser-nginx.sh"
if (-not (Test-Path $bashPath)) {
  Write-Host "  FAIL: fix-filebrowser-nginx.sh not found" -ForegroundColor Red; exit 1
}

$script = (Get-Content $bashPath -Raw).Replace("%%SERVER_NAME%%", $SERVER_NAME)
$tmp    = Join-Path $PSScriptRoot ".fix_fb_tmp.sh"
[System.IO.File]::WriteAllText($tmp, $script.Replace("`r`n", "`n"), [System.Text.Encoding]::UTF8)

scp -q $tmp ($SERVER + ":/tmp/fix_fb.sh")
if ($LASTEXITCODE -ne 0) { Write-Host "  FAIL: scp failed" -ForegroundColor Red; exit 1 }
Remove-Item $tmp -Force -ErrorAction SilentlyContinue

# Strip CRLF on server in case Windows added them, then run
ssh $SERVER "sed -i 's/\r//' /tmp/fix_fb.sh && bash /tmp/fix_fb.sh; rm -f /tmp/fix_fb.sh"
if ($LASTEXITCODE -ne 0) { Write-Host "  FAIL: remote script failed" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host ("  Open: https://$SERVER_NAME/filebrowser/") -ForegroundColor Green
Write-Host ""

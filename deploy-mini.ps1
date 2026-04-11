Write-Host "=== Uploading mini_app ===" -ForegroundColor Cyan
scp -r mini_app/* root@204.168.219.20:/opt/apps-father/mini_app/
Write-Host "=== Done! ===" -ForegroundColor Green

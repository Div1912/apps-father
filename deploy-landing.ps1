Write-Host "=== Uploading landing ===" -ForegroundColor Cyan
ssh root@204.168.219.20 "mkdir -p /opt/apps-father/landing/samples"
scp -r landing/* root@204.168.219.20:/opt/apps-father/landing/
if ($LASTEXITCODE -ne 0) {
    Write-Host "Upload failed!" -ForegroundColor Red
    exit 1
}
Write-Host "Landing OK" -ForegroundColor Green

Write-Host "=== Landing deployed to apps-father.com ===" -ForegroundColor Green

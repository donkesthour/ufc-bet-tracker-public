@echo off
rem Stop the UFC Bet Tracker.
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8214 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"
echo Tracker stopped (if it was running).
pause

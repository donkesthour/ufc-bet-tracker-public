@echo off
rem Create a temporary PUBLIC internet link to your tracker.
rem Requires start.bat to be running in another window.
cd /d "%~dp0"
if not exist cloudflared.exe (
  echo Downloading the tunnel tool ^(one time^)...
  curl -L -o cloudflared.exe https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
)
echo.
echo ============================================================
echo  WARNING: this link is PUBLIC. Anyone who has it can see
echo  and change your bets - share it only with people you trust.
echo  The link changes every time you run this file.
echo  Keep this window open while sharing.
echo ============================================================
cloudflared.exe tunnel --url http://127.0.0.1:8214
pause

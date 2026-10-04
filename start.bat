@echo off
rem Start the UFC Bet Tracker web page.
cd /d "%~dp0"
set PORT=8214
if not exist venv\Scripts\python.exe (
  echo The app environment was not found in this folder:
 echo   %CD%
  echo.
  echo Fix: run setup.bat in this SAME folder first.
  echo ^(If you just downloaded the ZIP: right-click it ^> Extract All,
  echo  then run setup.bat inside the extracted folder.^)
  pause
  exit /b 1
)
echo Checking app dependencies...
venv\Scripts\python -m pip install --quiet --disable-pip-version-check -r requirements.txt
if errorlevel 1 echo ^(Could not check dependencies - continuing; connect to the internet if the page shows errors.^)
if exist .env for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do set %%a=%%b
echo ============================================================
echo   UFC BET TRACKER is starting...
echo.
echo   On this PC, open:      http://127.0.0.1:%PORT%
echo.
echo   To let someone on the SAME Wi-Fi network open it, share
echo   one of these addresses:
echo.
powershell -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | ForEach-Object { Write-Host ('   http://' + $_.IPAddress + ':%PORT%') }"
echo.
echo   The tracker runs quietly in the background - no console window.
echo   To stop it: double-click stop.bat
echo   If the page will not load, open tracker.log in this folder.
echo ============================================================
echo.
echo Press any key to close THIS window - the tracker keeps running.
pause >nul
start "UFC Bet Tracker server" /min cmd /c "venv\Scripts\python -m uvicorn app:app --host 0.0.0.0 --port %PORT% --no-access-log > tracker.log 2>&1"
start "" http://127.0.0.1:%PORT%

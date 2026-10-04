@echo off
rem One-time setup for the UFC Bet Tracker on Windows.
cd /d "%~dp0"
where py >nul 2>nul
if errorlevel 1 (
  echo Python is not installed.
  echo Install it from https://www.python.org/downloads/ - IMPORTANT: tick
  echo "Add python.exe to PATH" during install - then run setup.bat again.
  pause
  exit /b 1
)
if not exist venv (
  echo Creating Python environment ^(one time^)...
  py -3 -m venv venv
)
echo Installing dependencies...
venv\Scripts\python -m pip install --quiet --disable-pip-version-check -r requirements.txt
echo.
echo ============================================================
echo  Setup complete!
echo  Double-click  start.bat  to run the tracker.
echo ============================================================
pause

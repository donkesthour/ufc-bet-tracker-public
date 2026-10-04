@echo off
rem One-time setup for the UFC Bet Tracker on Windows.
rem Installs Python automatically if it is missing (no admin rights needed).
cd /d "%~dp0"

set "PYEXE="
where py >nul 2>nul && set "PYEXE=py -3"
if not defined PYEXE for /d %%D in ("%LocalAppData%\Programs\Python\Python*") do set "PYEXE=%%D\python.exe"

if not defined PYEXE (
  echo Python was not found - installing it for you, please wait...
  where winget >nul 2>nul
  if not errorlevel 1 (
    winget install --id Python.Python.3.12 --silent --accept-package-agreements --accept-source-agreements
  ) else (
    echo Downloading the Python installer...
    curl -L -o python-installer.exe https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe
    python-installer.exe /quiet InstallAllUsers=0 PrependPath=1 Include_test=0
    del python-installer.exe
  )
  for /d %%D in ("%LocalAppData%\Programs\Python\Python*") do set "PYEXE=%%D\python.exe"
)
if not defined PYEXE (
  echo.
  echo Python could not be installed automatically.
  echo Install it from https://www.python.org/downloads/ - IMPORTANT: tick
  echo "Add python.exe to PATH" during install - then run setup.bat again.
  pause
  exit /b 1
)

if not exist venv (
  echo Creating the app environment ^(one time^)...
  %PYEXE% -m venv venv
)
echo Installing app dependencies...
venv\Scripts\python -m pip install --quiet --disable-pip-version-check -r requirements.txt

echo.
echo ============================================================
echo  Setup complete!
echo  Double-click  start.bat  to run the tracker.
echo ============================================================
pause

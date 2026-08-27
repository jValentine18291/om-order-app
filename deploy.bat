@echo off
setlocal enabledelayedexpansion
REM ===========================================================================
REM deploy.bat - pull the latest code and restart the service.
REM
REM Double-click it. It runs the three steps in order and stops at the first
REM one that fails, rather than restarting the service over a half-finished
REM pull and leaving you guessing.
REM
REM Needs to run as Administrator: restarting a Windows service does. If it is
REM not, it says so instead of failing halfway through.
REM ===========================================================================

cd /d "%~dp0"

echo.
echo ============================================================
echo  OM Service - deploy
echo  %DATE% %TIME%
echo ============================================================
echo.

REM ---------------------------------------------------------------------------
REM Administrator check first, before anything is changed. Restarting the
REM service is the only step that needs it, but finding that out AFTER pulling
REM leaves the code updated and the service still running the old copy.
REM ---------------------------------------------------------------------------
net session >nul 2>&1
if errorlevel 1 (
  echo This needs to run as Administrator, because restarting the service does.
  echo.
  echo Right-click deploy.bat and choose "Run as administrator".
  echo Nothing has been changed.
  echo.
  pause
  exit /b 1
)

echo [1/3] Fetching the latest code...
git pull
if errorlevel 1 (
  echo.
  echo *** The pull failed - see the message above. Nothing else has been done. ***
  echo If it mentions "Unlink of file ... failed", close anything open in the
  echo folder and try again.
  echo.
  pause
  exit /b 1
)

echo.
echo [2/3] Checking dependencies...
REM Cheap when nothing has changed, and the one step that is easy to forget
REM when a release adds a library.
call npm install --prefix backend --no-audit --no-fund
if errorlevel 1 (
  echo.
  echo *** npm install failed - see above. The service has NOT been restarted, ***
  echo *** so it is still running the previous version.                        ***
  echo.
  pause
  exit /b 1
)

echo.
echo [3/3] Restarting the service...
"C:\nssm\nssm.exe" restart OMService
if errorlevel 1 (
  echo.
  echo *** The restart failed. The new code is in place but the service is    ***
  echo *** still running the old copy. Try:  C:\nssm\nssm.exe status OMService ***
  echo.
  pause
  exit /b 1
)

echo.
echo ============================================================
echo  Done. Open the app and pull down to refresh on each phone.
echo ============================================================
echo.
"C:\nssm\nssm.exe" status OMService
echo.
pause

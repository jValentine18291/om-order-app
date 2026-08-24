@echo off
setlocal
REM ===========================================================================
REM backup-db.bat - makes a safe copy of the service slip database.
REM
REM Double-click to run it once. Windows Task Scheduler runs it daily using
REM the same file (see BACKUP.md).
REM
REM ---------------------------------------------------------------------------
REM WHERE THE BACKUPS GO - change this one line if you want them elsewhere.
REM A different disk or a network share is much safer than the line below,
REM because a backup on the same disk does not survive that disk failing.
REM ---------------------------------------------------------------------------
set "BACKUP_DIR=%~dp0backups"

REM How many days to keep. Older ones are deleted, but the 7 most recent are
REM always kept however old they are.
set "OM_BACKUP_KEEP_DAYS=30"

set "LOGFILE=%~dp0backup.log"

echo.
echo ============================================================
echo  OM Service - database backup
echo  %DATE% %TIME%
echo ============================================================

set "RC=0"

where node >nul 2>&1
if errorlevel 1 (
  set "RC=1"
  echo.
  echo Node.js was not found. The backup did NOT run.
  echo Install Node.js, or run this from a command prompt where "node" works.
  echo %DATE% %TIME% ^| FAILED - node not found >> "%LOGFILE%"
  goto :finish
)

node "%~dp0backup-db.js" "%BACKUP_DIR%"
if errorlevel 1 (
  set "RC=1"
  echo.
  echo *** THE BACKUP FAILED - read the message above. ***
  echo %DATE% %TIME% ^| FAILED >> "%LOGFILE%"
) else (
  echo %DATE% %TIME% ^| ok >> "%LOGFILE%"
)

:finish
REM Task Scheduler passes "auto" so no one has to click anything. Run by hand
REM and the window stays open so the result can be read.
if /i not "%~1"=="auto" (
  echo.
  pause
)

REM Hand the result back to Task Scheduler. Without this it reported success
REM even when the backup had failed, which is the worst possible lie for a
REM backup job to tell.
endlocal & exit /b %RC%

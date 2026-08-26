@echo off
setlocal enabledelayedexpansion
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
set "OUTFILE=%~dp0backup-last-run.txt"
set "RC=0"

echo.
echo ============================================================
echo  OM Service - database backup
echo  %DATE% %TIME%
echo ============================================================

REM ---------------------------------------------------------------------------
REM Find Node. A scheduled task runs without anyone logged on and without a
REM user profile, so "node" is often absent from its PATH even though it works
REM perfectly when you run this yourself. That is the usual reason a task
REM reports Last Result 1 while the same file works by hand.
REM
REM Set OM_NODE in the environment to point at node.exe if it lives somewhere
REM unusual on this machine.
REM ---------------------------------------------------------------------------
set "NODE="
if defined OM_NODE if exist "%OM_NODE%" set "NODE=%OM_NODE%"
if not defined NODE for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE set "NODE=%%N"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE if exist "C:\Program Files\nodejs\node.exe" set "NODE=C:\Program Files\nodejs\node.exe"

if not defined NODE (
  echo.
  echo Node.js was not found, so the backup did NOT run.
  echo Looked on PATH and in the usual install folders.
  echo Fix: set OM_NODE to the full path of node.exe, or add Node to the
  echo system PATH ^(not just your own user PATH^).
  echo %DATE% %TIME% ^| FAILED - node not found >> "%LOGFILE%"
  set "RC=1"
  goto finish
)

echo Using Node: %NODE%
echo.

REM Keep the full output of the last run. When a scheduled task fails, its exit
REM code alone says nothing; this file says what actually happened.
"%NODE%" "%~dp0backup-db.js" "%BACKUP_DIR%" > "%OUTFILE%" 2>&1
set "RC=%ERRORLEVEL%"
type "%OUTFILE%"

if not "%RC%"=="0" (
  echo.
  echo *** THE BACKUP FAILED - the message above says why. ***
  echo %DATE% %TIME% ^| FAILED - see backup-last-run.txt >> "%LOGFILE%"
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

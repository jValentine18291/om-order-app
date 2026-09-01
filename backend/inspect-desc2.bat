@echo off
setlocal enabledelayedexpansion
REM ===========================================================================
REM inspect-desc2.bat — run the read-only second-description-line inspector on the server.
REM
REM The AutoCount credentials live in the OMService service configuration, not
REM in your command prompt, so running "node inspect-desc2.js" on its own fails
REM with "Missing required env vars". This borrows the service's settings for
REM one command and then throws them away.
REM
REM Nothing is printed while the credentials are read, and setlocal means they
REM do not linger in your session afterwards.
REM
REM USAGE (from the backend folder):
REM   inspect-desc2.bat            (survey the whole catalogue)
REM   inspect-desc2.bat "544RR"    (and show what one part says)
REM ===========================================================================

set "NSSM=C:\nssm\nssm.exe"
if not exist "%NSSM%" (
  echo Could not find NSSM at %NSSM%
  echo Edit this file and set NSSM to the right path, then run it again.
  exit /b 1
)

echo Reading AutoCount settings from the OMService service...
REM NSSM prints wide (UTF-16) text, which for /f cannot parse — it comes back
REM as nulls and nothing matches. PowerShell decodes it and re-emits plain
REM text. Both key names are tried: NSSM stores service environment under
REM AppEnvironment or AppEnvironmentExtra depending on how it was set.
for /f "usebackq tokens=1,* delims==" %%A in (`powershell -NoProfile -Command "& { $ErrorActionPreference='SilentlyContinue'; foreach ($k in 'AppEnvironmentExtra','AppEnvironment') { & '%NSSM%' get OMService $k } }" 2^>nul`) do (
  if not "%%~A"=="" set "%%~A=%%~B"
)

if not defined AUTOCOUNT_DB_SERVER (
  echo.
  echo Could not read the settings from the service.
  echo Set them by hand instead, then run: node inspect-desc2.js %1
  echo   set AUTOCOUNT_DB_SERVER=OMAPPSVR1\A2006
  echo   set AUTOCOUNT_DB_NAME=AED_OUTBOARD
  echo   set AUTOCOUNT_DB_USER=^<user^>
  echo   set AUTOCOUNT_DB_PASSWORD=^<password^>
  exit /b 1
)

echo Done. Connecting as %AUTOCOUNT_DB_USER% to %AUTOCOUNT_DB_NAME%.
echo.
node "%~dp0inspect-desc2.js" %1
endlocal

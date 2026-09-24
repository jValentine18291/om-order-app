@echo off
REM NO DELAYED EXPANSION, deliberately. With it on, cmd eats "!" and everything
REM up to the next one out of any value assigned inside the loop below - so an
REM AutoCount password containing "!" silently arrives short and the only
REM symptom is a login that fails for no visible reason. Proved 24 Sep 2026:
REM "p@ss=w0rd!x" came out as "p@ss=w0rdx". Nothing here needs !var! syntax.
setlocal
REM ===========================================================================
REM inspect-so-transfer.bat - run the read-only Sales Order transfer inspector
REM on the server.
REM
REM The AutoCount credentials live in the OMService service configuration, not
REM in your command prompt, so "node inspect-so-transfer.js" on its own fails
REM with "Missing required env vars". This borrows the service's settings for
REM one command and then throws them away - setlocal means they do not linger.
REM
REM WHY THIS READS THE REGISTRY RATHER THAN ASKING NSSM
REM The first version shelled out to "nssm get OMService AppEnvironmentExtra".
REM That failed on the server on 24 Sep 2026 with nothing to say about why -
REM NSSM prints wide (UTF-16) text, needs decoding before a batch file can read
REM it, and returns nothing at all rather than an error when it cannot read the
REM service. Too many ways to fail silently for something whose only job is to
REM fetch four settings.
REM
REM NSSM keeps them in the registry, under the service's own Parameters key, as
REM a multi-string of KEY=VALUE lines. Reading them straight from there is one
REM step instead of three, and says which step failed.
REM
REM NO PIPES AND NO LINE CONTINUATIONS in the PowerShell below, deliberately.
REM The first attempt at the diagnostic used both and never ran: "^|" is what a
REM pipe has to be inside a for /f block, and is a syntax error anywhere else,
REM so the thing written to explain a failure produced a page of parser errors
REM instead. Everything here is one line and pipe-free.
REM
REM NOTHING HERE PRINTS A VALUE. Only the NAMES of the settings found, so this
REM output can be pasted back safely - the AutoCount password never appears.
REM
REM USAGE (from the backend folder, on the server):
REM   inspect-so-transfer.bat
REM   inspect-so-transfer.bat "SO-2609-001"
REM ===========================================================================

if not defined OM_SERVICE_NAME set "OM_SERVICE_NAME=OMService"

echo Reading AutoCount settings from the %OM_SERVICE_NAME% service...

REM Both key names are tried: NSSM stores the service environment under
REM AppEnvironmentExtra or AppEnvironment depending on how it was set.
for /f "usebackq tokens=1,* delims==" %%A in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; $p='HKLM:\SYSTEM\CurrentControlSet\Services\%OM_SERVICE_NAME%\Parameters'; $i=Get-ItemProperty -Path $p; foreach ($k in 'AppEnvironmentExtra','AppEnvironment') { foreach ($l in @($i.$k)) { if ($l) { $l } } }" 2^>nul`) do (
  if not "%%~A"=="" set "%%~A=%%~B"
)

if not defined AUTOCOUNT_DB_SERVER goto :diagnose

echo   Found the settings.
echo   Connecting as %AUTOCOUNT_DB_USER% to %AUTOCOUNT_DB_NAME% on %AUTOCOUNT_DB_SERVER%.
echo.
node "%~dp0inspect-so-transfer.js" %1
endlocal
exit /b 0

REM ---------------------------------------------------------------------------
REM It did not work. Say how far it got, so the next attempt is not a guess.
REM Names only - no values are printed anywhere below.
REM ---------------------------------------------------------------------------
:diagnose
echo.
echo   Could not read the settings. Here is how far it got:
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$n='%OM_SERVICE_NAME%'; $p='HKLM:\SYSTEM\CurrentControlSet\Services\'+$n+'\Parameters'; $svc=Get-Service -Name $n -ErrorAction SilentlyContinue; if ($svc) { Write-Host ('   service ' + $n + ' exists, status ' + $svc.Status) } else { Write-Host ('   service ' + $n + ' NOT FOUND - if it has another name, run: set OM_SERVICE_NAME=thatname') }; if (Test-Path $p) { Write-Host ('   registry key found: ' + $p) } else { Write-Host ('   registry key NOT FOUND: ' + $p) }; $i=Get-ItemProperty -Path $p -ErrorAction SilentlyContinue; if (-not $i) { Write-Host '   could not read that key - try this window as Administrator' } else { foreach ($k in 'AppEnvironmentExtra','AppEnvironment') { $v=@($i.$k); if ($v.Count -gt 0 -and $v[0]) { $names=@(); foreach ($l in $v) { $names += ($l -split '=',2)[0] }; Write-Host ('   ' + $k + ' holds ' + $v.Count + ' setting(s): ' + ($names -join ', ')) } else { Write-Host ('   ' + $k + ' is empty or absent') } } }"
echo.
echo   If the names above include AUTOCOUNT_DB_SERVER, the settings are there
echo   and only this file failed to pick them up - send me those lines.
echo.
echo   Otherwise set them by hand for one command and run the script directly:
echo     set AUTOCOUNT_DB_SERVER=OMAPPSVR1\A2006
echo     set AUTOCOUNT_DB_NAME=AED_OUTBOARD
echo     set AUTOCOUNT_DB_USER=^<user^>
echo     set AUTOCOUNT_DB_PASSWORD=^<password^>
echo     node inspect-so-transfer.js
echo.
endlocal
exit /b 1

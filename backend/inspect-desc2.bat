@echo off
REM ===========================================================================
REM inspect-desc2.bat - survey the second description line on AutoCount items.
REM
REM Double-click this, or run it from a Command Prompt in this folder. The
REM AutoCount login is read from the OMService service by the script itself, so
REM there is nothing to type and nothing is printed.
REM
REM   inspect-desc2.bat            survey the whole catalogue
REM   inspect-desc2.bat "544RR"    and show what one part says
REM ===========================================================================
node "%~dp0inspect-desc2.js" %1
echo.
pause

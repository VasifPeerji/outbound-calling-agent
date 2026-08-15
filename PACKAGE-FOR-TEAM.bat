@echo off
rem ============================================================================
rem  Build a clean ZIP to hand to the sales team.
rem  This is for YOU, not for them - it excludes itself from what it builds.
rem  The work happens in package-for-team.ps1 next to this file.
rem ============================================================================
title OmniReach - build handover package
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0package-for-team.ps1"
if errorlevel 1 (
  echo.
  echo  Package NOT created. Fix the problem above and run this again.
)
echo.
pause

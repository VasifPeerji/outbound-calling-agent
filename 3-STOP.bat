@echo off
setlocal enabledelayedexpansion
title OmniReach - Stop
cd /d "%~dp0"

set PORT=3002
if exist "web\backend\.env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%a in ("web\backend\.env") do (
    if /i "%%a"=="PORT" if not "%%b"=="" set PORT=%%b
  )
)
set PORT=%PORT: =%

echo.
echo  Stopping OmniReach on port %PORT%...
echo.

rem Stop by PORT rather than by killing every node process - the person running this may well
rem have other Node tools open, and taking those down with us would be rude.
set FOUND=0
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do (
  if not "%%p"=="0" (
    taskkill /PID %%p /F >nul 2>nul
    if not errorlevel 1 (
      echo  [OK] Stopped process %%p.
      set FOUND=1
    )
  )
)

rem Close the leftover console window if it is still sitting there.
taskkill /FI "WINDOWTITLE eq OmniReach Server*" /F >nul 2>nul

if "%FOUND%"=="0" (
  echo  OmniReach was not running - nothing to stop.
) else (
  echo.
  echo  OmniReach has been stopped. Your data is saved.
)
echo.
ping -n 5 127.0.0.1 >nul

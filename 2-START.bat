@echo off
setlocal enabledelayedexpansion
title OmniReach - Start
cd /d "%~dp0"

rem ---------- checks ----------
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [X] Node.js is not installed. Please run 1-SETUP.bat first.
  echo.
  pause
  exit /b 1
)
if not exist "web\backend\node_modules" (
  echo.
  echo  [X] Components are not installed yet. Please run 1-SETUP.bat first.
  echo.
  pause
  exit /b 1
)
if not exist "web\backend\.env" (
  echo.
  echo  [X] No settings file found. Please run 1-SETUP.bat first.
  echo.
  pause
  exit /b 1
)

rem ---------- which port? read PORT from .env, default 3002 ----------
set PORT=3002
for /f "usebackq eol=# tokens=1,* delims==" %%a in ("web\backend\.env") do (
  if /i "%%a"=="PORT" if not "%%b"=="" set PORT=%%b
)
set PORT=%PORT: =%

rem ---------- already running? ----------
netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul
if not errorlevel 1 (
  echo.
  echo  OmniReach is already running. Opening it in your browser...
  echo.
  start "" http://localhost:%PORT%
  ping -n 3 127.0.0.1 >nul
  exit /b 0
)

echo.
echo  Starting OmniReach on port %PORT%...
echo.
start "OmniReach Server" cmd /k "cd /d "%~dp0web\backend" && node server.js"

rem ---------- wait for it to answer, then open the browser ----------
rem ping, not timeout: timeout dies with "Input redirection is not supported" whenever this is run
rem with redirected input (a shortcut, a scheduled task, some remote sessions), which would spin
rem this loop instantly and report a false "did not start".
set /a TRIES=0
:waitloop
set /a TRIES+=1
ping -n 2 127.0.0.1 >nul
netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul
if not errorlevel 1 goto ready
if %TRIES% lss 25 goto waitloop

echo.
echo  [X] OmniReach did not start within 25 seconds.
echo      Look at the window titled "OmniReach Server" - the red text there says why.
echo      The usual cause is a missing or mistyped key in web\backend\.env
echo.
pause
exit /b 1

:ready
start "" http://localhost:%PORT%
echo.
echo  ============================================================
echo    OmniReach is running
echo  ============================================================
echo.
echo    Address:  http://localhost:%PORT%
echo.
echo    Leave the window titled "OmniReach Server" OPEN while you use it.
echo    When you are finished, double-click 3-STOP.bat
echo.
echo    First time signing in? The admin password was printed in the
echo    "OmniReach Server" window when it started.
echo.
ping -n 7 127.0.0.1 >nul

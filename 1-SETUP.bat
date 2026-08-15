@echo off
setlocal enabledelayedexpansion
title OmniReach - Setup
cd /d "%~dp0"

echo.
echo  ============================================================
echo    OmniReach  -  one-time setup
echo  ============================================================
echo.
echo  You only need to run this once on this computer.
echo.

rem ---------- 1. Node.js ----------
where node >nul 2>nul
if errorlevel 1 (
  echo  [X] Node.js is not installed.
  echo.
  echo      OmniReach needs Node.js to run. It is free and takes a minute.
  echo      1. Download the "LTS" version from  https://nodejs.org
  echo      2. Install it, accepting the defaults
  echo      3. Close this window and run 1-SETUP.bat again
  echo.
  echo      Opening the download page for you now...
  rem Deliberately not `choice`: it errors out whenever input is redirected,
  rem and this branch is a dead end anyway - they cannot continue without Node.
  start "" https://nodejs.org
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do set NODEVER=%%v
echo  [OK] Node.js !NODEVER! found.

rem ---------- 2. dependencies ----------
echo.
echo  Installing components. This can take a minute or two...
echo.
pushd "web\backend"
call npm install --no-fund --no-audit
if errorlevel 1 (
  popd
  echo.
  echo  [X] Install failed. Check your internet connection and try again.
  echo      If you are on a company network, a proxy or firewall may be blocking npm.
  echo.
  pause
  exit /b 1
)
popd
echo.
echo  [OK] Components installed.

rem ---------- 3. settings file ----------
set ENVFILE=web\backend\.env
set PRECONFIGURED=0
if not exist "%ENVFILE%" (
  if exist "web\backend\.env.example" (
    copy /y "web\backend\.env.example" "%ENVFILE%" >nul
    echo  [OK] Created your settings file: %ENVFILE%
  ) else (
    echo  [X] web\backend\.env.example is missing. Ask the person who sent you this folder.
    pause
    exit /b 1
  )
) else (
  rem Shipped ready to run? Then there is nothing for them to fill in and we should not
  rem invite five people to hand-edit a working config file.
  findstr /b /c:"ELEVENLABS_API_KEY=sk_" "%ENVFILE%" >nul 2>nul
  if not errorlevel 1 set PRECONFIGURED=1
  echo  [OK] Settings file found: %ENVFILE%
)

if "%PRECONFIGURED%"=="1" (
  echo  [OK] It already has the keys in it - nothing for you to fill in.
  echo.
  echo  ============================================================
  echo    Setup complete
  echo  ============================================================
  echo.
  echo  Next: double-click  2-START.bat  to launch OmniReach.
  echo.
  echo  The first time it starts, look at the black window - it prints a
  echo  one-time admin password. Copy it: you sign in with that, and you
  echo  will be asked to choose your own password straight away.
  echo.
  pause
  exit /b 0
)

echo.
echo  ============================================================
echo    Almost done - add your keys
echo  ============================================================
echo.
echo  Notepad will now open your settings file. Fill in these lines,
echo  then SAVE and close Notepad:
echo.
echo     ELEVENLABS_API_KEY=               your ElevenLabs API key
echo     ELEVENLABS_AGENT_ID=              the agent id (starts with agent_)
echo     ELEVENLABS_AGENT_PHONE_NUMBER_ID= the phone number id (starts with phnum_)
echo     ADMIN_EMAIL=                      the email you will sign in with
echo.
echo  Leave everything else as it is unless you were told otherwise.
echo.
pause
notepad "%ENVFILE%"

echo.
echo  ============================================================
echo    Setup complete
echo  ============================================================
echo.
echo  Next: double-click  2-START.bat  to launch OmniReach.
echo.
echo  The first time it starts it will print a one-time admin password
echo  in the black window. Copy it - you will need it to sign in, and
echo  you will be asked to choose your own password straight away.
echo.
pause

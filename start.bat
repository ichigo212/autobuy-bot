@echo off
title AutoBuy Bot
cd /d "%~dp0"

echo ============================================
echo              AutoBuy Discord Bot
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js is not installed.
  echo     Download it from https://nodejs.org ^(LTS^) and run this again.
  pause
  exit /b 1
)

if not exist ".env" (
  if exist ".env.example" copy ".env.example" ".env" >nul
  echo [!] I created a .env file for you.
  echo     Open .env, fill in BOT_TOKEN, OWNER_IDS and your GCash details,
  echo     then run start.bat again.
  notepad ".env"
  pause
  exit /b 1
)

set NEED_INSTALL=0
if not exist "node_modules" set NEED_INSTALL=1
if not exist "node_modules\tesseract.js\package.json" set NEED_INSTALL=1
if "%NEED_INSTALL%"=="1" (
  echo [*] Installing packages, this can take a minute...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [X] npm install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

:run
echo [*] Starting the bot (local database included). Press Ctrl+C to stop.
echo.
node start-local.js
echo.
echo [!] The bot stopped (exit code %errorlevel%).
choice /c YN /n /t 15 /d Y /m "Restart in 15 seconds? [Y/N] "
if errorlevel 2 goto end
goto run

:end
pause

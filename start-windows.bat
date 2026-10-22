@echo off
setlocal
title Corda AI
cd /d "%~dp0"

echo.
echo  Corda AI - local start
echo  ----------------------

where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js is not installed.
  echo  Install the LTS version from https://nodejs.org , then double-click this file again.
  goto fail
)
node -e "process.exit(+process.versions.node.split('.')[0] < 22 ? 1 : 0)"
if errorlevel 1 (
  for /f %%v in ('node -v') do echo  Found Node %%v, but Corda AI needs Node 22 or newer.
  echo  Install the LTS version from https://nodejs.org , then double-click this file again.
  goto fail
)

if not exist .env copy .env.example .env >nul

rem An interrupted install leaves node_modules without this marker, so it runs again.
if not exist node_modules\.package-lock.json (
  echo  [1/4] Installing packages - first run takes a few minutes and needs about 2 GB free...
  call npm.cmd install
  if errorlevel 1 goto fail
) else (
  echo  [1/4] Packages already installed.
)

echo  [2/4] Starting the local database in a new window - keep that window open.
start "Corda AI database" cmd /k "npm.cmd run db:local"

echo  [3/4] Waiting for the database...
set /a tries=0
:waitdb
node -e "const s=require('net').connect(54329,'127.0.0.1');s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(1))"
if not errorlevel 1 goto dbready
set /a tries+=1
if %tries% geq 90 (
  echo  The database did not start. Check the "Corda AI database" window for the error.
  goto fail
)
timeout /t 2 /nobreak >nul
goto waitdb
:dbready

call npm.cmd run setup
if errorlevel 1 goto fail

echo  [4/4] Starting the app. Your browser opens at http://localhost:3000 in a few seconds.
start "" cmd /c "timeout /t 12 /nobreak >nul & start http://localhost:3000"
call npm.cmd run dev
goto end

:fail
echo.
echo  Something went wrong. Copy the text above and send it to the team.
pause
exit /b 1

:end
endlocal

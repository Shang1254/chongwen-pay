@echo off
rem ============================================================
rem  One-click load test (ASCII only to avoid codepage issues)
rem  Usage: double-click, or run with "quick":
rem    run-loadtest.bat quick
rem  What it does:
rem    1. install deps if missing
rem    2. migrate DB (idempotent)
rem    3. seed demo data if needed
rem    4. start an ISOLATED server on port 3100
rem    5. run load test and write ..\loadtest-report.md
rem    6. stop the isolated server
rem  Your normal server on port 3000 is NOT touched.
rem ============================================================
cd /d "%~dp0.."
title CWLT Load Test

echo ================================================
echo  CWLT load test runner
echo ================================================

where node >nul 2>nul
if errorlevel 1 echo [ERROR] Node.js not found. Please install Node.js first. & pause & exit /b 1

if not exist node_modules call npm install --registry=https://registry.npmmirror.com

echo [1/5] Upgrading database schema...
node db\migrate-v2.js
if errorlevel 1 echo [ERROR] DB migrate failed. Check MySQL/config.js, then retry. & pause & exit /b 1

echo [2/5] Ensuring demo households/bills exist...
node scripts\seed-demo.js
node scripts\seed-property.js

echo [3/5] Starting isolated test server on port 3100...
set CWLT_PORT=3100
set CWLT_DISABLE_RATE_LIMIT=1
start "cwlt-loadtest-server" cmd /c "node app.js > loadtest-server.log 2>&1"
timeout /t 4 >nul

echo [4/5] Running load test (this may take 1-3 minutes)...
if /i "%1"=="quick" node scripts\load-test.js --quick --base http://127.0.0.1:3100 --report "..\loadtest-report.md"
if /i not "%1"=="quick" node scripts\load-test.js --base http://127.0.0.1:3100 --report "..\loadtest-report.md"

echo [5/5] Stopping isolated test server...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3100" ^| findstr "LISTENING"') do taskkill /f /pid %%a >nul 2>nul

echo.
echo Done. Report: ..\loadtest-report.md
echo Server log:  loadtest-server.log
pause
exit /b 0

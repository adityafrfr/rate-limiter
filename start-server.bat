@echo off
echo  Website Rate Limiting Security Gateway
echo.

taskkill /IM node.exe /F >nul 2>&1
timeout /t 1 /nobreak >nul

cd /d "%~dp0"
set "NODE_BIN=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE_BIN%" set "NODE_BIN=node"

echo Starting server on http://localhost:3000 ...
echo Admin dashboard: http://localhost:3000/admin.html
echo Press Ctrl+C to stop.
echo.

"%NODE_BIN%" server.js
pause

@echo off
echo  Bounded Traffic Pressure Demo
echo.
cd /d "%~dp0"

set "NODE_BIN=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE_BIN%" set "NODE_BIN=node"
if "%DEMO_DURATION_SECONDS%"=="" set "DEMO_DURATION_SECONDS=30"

"%NODE_BIN%" ddos-test.js
echo.
pause

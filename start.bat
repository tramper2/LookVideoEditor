@echo off
chcp 65001 >nul
title LookVideoEditor Launcher
echo =====================================================================
echo  Starting LookVideoEditor Local Studio Server...
echo =====================================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed!
    echo Please install Node.js from https://nodejs.org or open index.html directly.
    echo.
    pause
    start "" "index.html"
    exit /b 1
)

echo [INFO] Starting Node.js server at http://localhost:3000 ...
start "" http://localhost:3000
node server.js

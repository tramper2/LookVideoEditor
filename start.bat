@echo off
chcp 65001 >nul
cd /d "%~dp0"
title LookVideoEditor Launcher

echo =====================================================================
echo  Starting LookVideoEditor Local Studio Server...
echo =====================================================================
echo.

REM 1. 바탕화면 바로가기 아이콘 자동 생성 (다른 PC로 이동해도 첫 실행 시 자동 생성)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0create_shortcut.ps1" >nul 2>nul

REM 2. Node.js 설치 확인
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js가 설치되어 있지 않습니다!
    echo Node.js(https://nodejs.org)를 설치하거나 index.html을 직접 열어주세요.
    echo.
    pause
    start "" "index.html"
    exit /b 1
)

REM 3. 브라우저 실행 및 로컬 서버 시작
echo [INFO] 로컬 스튜디오 서버를 실행합니다 (http://localhost:3000) ...
start "" http://localhost:3000
node server.js

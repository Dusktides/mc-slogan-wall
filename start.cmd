@echo off
rem ============================================================
rem  MC Slogan Wall - one click launcher
rem  First run builds data files from your local Minecraft install.
rem ============================================================
setlocal
cd /d "%~dp0"
title MC Slogan Wall

where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo   [ERROR] Node.js not found.
    echo   Please install Node.js 18 or newer: https://nodejs.org/
    echo.
    pause
    exit /b 1
)

if not exist "data\glyphs\mojangles.json" goto :setup
if not exist "web\slogan-tool.html"        goto :setup
goto :launch

:setup
echo.
echo   First run detected - building data files from your Minecraft install...
echo.
node tools\setup.mjs
if errorlevel 1 (
    echo.
    echo   Setup failed. Please read the messages above.
    echo.
    pause
    exit /b 1
)

:launch
echo.
echo   Opening the web UI...
start "" "%~dp0web\slogan-tool.html"
exit /b 0

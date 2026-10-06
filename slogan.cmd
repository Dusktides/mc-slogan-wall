@echo off
rem ============================================================
rem  MC Slogan Wall - command line entry
rem  Usage:  slogan.cmd --text "HELLO" --preview --out hello.litematic
rem          slogan.cmd --help
rem ============================================================
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found. Install Node.js 18+: https://nodejs.org/
    exit /b 1
)

if not exist "data\blocks-by-version.json" (
    echo Data files missing - running setup first...
    node tools\setup.mjs || exit /b 1
)

node src\cli.mjs %*
exit /b %errorlevel%

@echo off
setlocal enabledelayedexpansion
title ZhiGui - AI Schedule Assistant
cd /d "%~dp0"

REM ===== Clear env vars that break Electron =====
set "ELECTRON_RUN_AS_NODE="
set "ELECTRON_NO_ATTACH_CONSOLE="
set "ELECTRON_ENABLE_LOGGING="

echo.
echo   ========================================
echo          ZhiGui - AI Schedule Assistant
echo          Smart Schedule / Second Brain
echo   ========================================
echo.

REM ===== Get project dir (strip trailing backslash) =====
set "APP_DIR=%~dp0"
if "!APP_DIR:~-1!"=="\" set "APP_DIR=!APP_DIR:~0,-1!"
set "DATA_DIR=!APP_DIR!\.zhigui"
set "SKILL_DIR=%USERPROFILE%\.workbuddy\skills\zhigui"

echo   Project: !APP_DIR!
echo   Data:   !DATA_DIR!
echo.

REM ===== Find Node.js =====
set "NODE_EXE="
set "NPM_CMD="

if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2\node.exe" (
    set "NODE_EXE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2\node.exe"
    set "NPM_CMD=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2\npm.cmd"
    goto :found_node
)

where node >nul 2>&1
if !errorlevel! equ 0 (
    set "NODE_EXE=node"
    set "NPM_CMD=npm"
    goto :found_node
)

if exist "C:\Program Files\nodejs\node.exe" (
    set "NODE_EXE=C:\Program Files\nodejs\node.exe"
    set "NPM_CMD=C:\Program Files\nodejs\npm.cmd"
    goto :found_node
)

echo   [ERROR] Node.js not found. Please install Node.js 16+
echo   Download: https://nodejs.org/
echo.
pause
exit /b 1

:found_node
echo   Node.js: !NODE_EXE!
echo.

REM ===== Check if Electron is installed =====
if not exist "!APP_DIR!\node_modules\electron\dist\electron.exe" (
    echo   First run: installing Electron...
    echo.
    set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
    "!NPM_CMD!" install --registry=https://registry.npmmirror.com
    if not exist "!APP_DIR!\node_modules\electron\dist\electron.exe" (
        echo.
        echo   [ERROR] Electron not found after npm install.
        echo   Try: "!NPM_CMD!" install --registry=https://registry.npmmirror.com
        pause
        exit /b 1
    )
    echo.
    echo   Electron installed.
    echo.
)

REM ===== Run setup script (engine install, config, data init, MCP register) =====
echo   Running setup...
"!NODE_EXE!" "!APP_DIR!\skill\scripts\setup.js" "!APP_DIR!" "!SKILL_DIR!" "!NODE_EXE!"
if !errorlevel! neq 0 (
    echo.
    echo   [ERROR] Setup failed.
    pause
    exit /b 1
)
echo.

REM ===== Clear env vars again (in case external modified) =====
set "ELECTRON_RUN_AS_NODE="

echo   Starting ZhiGui desktop app...
echo   (Close this window or press Ctrl+C to quit)
echo.

"!APP_DIR!\node_modules\electron\dist\electron.exe" "!APP_DIR!\skill\electron\main.js"

if !errorlevel! neq 0 (
    echo.
    echo   ========================================
    echo   [ERROR] ZhiGui failed to start! Code: !errorlevel!
    echo   ========================================
    echo.
    echo   Possible causes:
    echo   1. ELECTRON_RUN_AS_NODE conflict
    echo   2. Missing Visual C++ Runtime
    echo   3. GPU driver incompatibility
    echo.
    echo   Try:
    echo   - Delete ELECTRON_RUN_AS_NODE from system env vars
    echo   - Install Visual C++ Redistributable 2015-2022
    echo   - Run with --disable-gpu flag
    echo.
    pause
)

endlocal

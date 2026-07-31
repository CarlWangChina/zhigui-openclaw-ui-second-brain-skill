@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"

set "SERVER_JS=%SCRIPT_DIR%\dashboard\server.js"

if not exist "%SERVER_JS%" (
  echo [ERROR] Dashboard server not found:
  echo   %SERVER_JS%
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH.
  echo Please install Node.js ^(https://nodejs.org^) and add it to PATH.
  pause
  exit /b 1
)

echo Starting ZhiGui dashboard at http://localhost:7788 ...
echo (Press Ctrl+C to stop)
echo.
node "%SERVER_JS%"

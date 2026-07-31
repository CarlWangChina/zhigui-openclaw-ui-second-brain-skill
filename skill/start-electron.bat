@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"

set "ELECTRON_EXE=%SCRIPT_DIR%\node_modules\electron\dist\electron.exe"
set "MAIN_JS=%SCRIPT_DIR%\electron\main.js"

set "ELECTRON_RUN_AS_NODE="
set "ELECTRON_NO_ATTACH_CONSOLE="
set "ELECTRON_ENABLE_LOGGING="

if not exist "%ELECTRON_EXE%" (
  echo [ERROR] Electron binary not found:
  echo   %ELECTRON_EXE%
  echo Attempting automatic install...
  where npm >nul 2>nul
  if errorlevel 1 (
    echo [ERROR] npm not found in PATH. Cannot auto-install Electron.
    echo Please install Node.js ^(https://nodejs.org^) or re-download the full ZhiGui.zip.
    pause
    exit /b 1
  )
  echo Running npm install ^(this may take a minute^)...
  cd /d "%SCRIPT_DIR%"
  call npm install --registry https://registry.npmmirror.com
  if not exist "%ELECTRON_EXE%" (
    echo [ERROR] Electron installation failed.
    echo Please re-download the full ZhiGui.zip.
    pause
    exit /b 1
  )
  echo Electron installed successfully.
)

echo Starting ZhiGui desktop panel...
echo (Close the window or press Ctrl+C to quit)
echo.
"%ELECTRON_EXE%" "%MAIN_JS%"

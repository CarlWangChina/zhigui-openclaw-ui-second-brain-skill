#!/usr/bin/env bash
# 启动知归桌面端（Electron）
cd "$(dirname "$0")"

unset ELECTRON_RUN_AS_NODE

if [ ! -f "node_modules/electron/dist/electron" ]; then
  echo "First run: installing Electron..."
  export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  npm install --registry=https://registry.npmmirror.com
  if [ $? -ne 0 ]; then
    echo "[ERROR] npm install failed. Check your network."
    exit 1
  fi
  echo "Electron installed."
fi

echo "Starting ZhiGui desktop app..."
if [ "$(uname)" = "Darwin" ]; then
  node_modules/electron/dist/Electron.app/Contents/MacOS/Electron "$(pwd)/electron/main.js"
else
  node_modules/electron/dist/electron "$(pwd)/electron/main.js"
fi

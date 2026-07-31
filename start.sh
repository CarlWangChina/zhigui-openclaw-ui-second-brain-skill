#!/usr/bin/env bash
set -e

# ===== 知归 · AI 日程助理 启动脚本 (macOS/Linux) =====

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
# Keep the desktop app and development MCP on the same canonical data folder.
DATA_DIR="$APP_DIR/skill/.zhigui"
SKILL_DIR="$HOME/.workbuddy/skills/zhigui"

echo ""
echo "  ========================================"
echo "         知归 · AI 日程助理"
echo "         智能日程 · 第二大脑"
echo "  ========================================"
echo ""
echo "  项目目录: $APP_DIR"
echo "  数据目录: $DATA_DIR"
echo ""

# ===== 清除可能影响 Electron 的环境变量 =====
unset ELECTRON_RUN_AS_NODE

# ===== 查找 Node.js =====
NODE_EXE=""
NPM_CMD=""

if command -v node &> /dev/null; then
    NODE_EXE="node"
    NPM_CMD="npm"
elif [ -f "$HOME/.workbuddy/binaries/node/versions/22.22.2/node" ]; then
    NODE_EXE="$HOME/.workbuddy/binaries/node/versions/22.22.2/node"
    NPM_CMD="$HOME/.workbuddy/binaries/node/versions/22.22.2/npm"
else
    echo "  [错误] 未找到 Node.js，请先安装 Node.js 16+"
    echo "  下载地址: https://nodejs.org/"
    echo ""
    exit 1
fi

echo "  Node.js: $NODE_EXE"
echo ""

# ===== 检查 Electron 是否已安装 =====
if [ ! -f "$APP_DIR/node_modules/electron/dist/electron" ]; then
    echo "  首次运行，正在安装 Electron..."
    echo ""
    export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
    cd "$APP_DIR"
    "$NPM_CMD" install --registry=https://registry.npmmirror.com
    echo ""
    echo "  正在下载 Electron 二进制文件..."
    "$NODE_EXE" "$APP_DIR/node_modules/electron/install.js"
    if [ ! -f "$APP_DIR/node_modules/electron/dist/electron" ]; then
        echo ""
        echo "  [错误] Electron 安装失败。"
        echo "  尝试: $NPM_CMD install --registry=https://registry.npmmirror.com"
        exit 1
    fi
    echo ""
    echo "  Electron 安装完成！"
    echo ""
fi

# ===== 自包含部署：安装引擎 + 初始化数据 + 注册全局 MCP（与 Windows start.bat 一致）=====
echo "  正在配置知归 Skill 并初始化数据..."
"$NODE_EXE" "$APP_DIR/skill/scripts/setup.js" "$APP_DIR" "$SKILL_DIR" "$NODE_EXE"
echo ""

# ===== 启动 Electron =====
echo "  正在启动知归桌面应用..."
echo "  (按 Ctrl+C 退出)"
echo ""

if [ "$(uname)" = "Darwin" ]; then
    "$APP_DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" "$APP_DIR/skill/electron/main.js"
else
    "$APP_DIR/node_modules/electron/dist/electron" "$APP_DIR/skill/electron/main.js"
fi

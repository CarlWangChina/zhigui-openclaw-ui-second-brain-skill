#!/usr/bin/env bash
# 启动知归 HTTP 看板服务（端口 7788）
cd "$(dirname "$0")"
echo "Starting ZhiGui dashboard at http://localhost:7788 ..."
echo "(Press Ctrl+C to stop)"
node "$(pwd)/dashboard/server.js"

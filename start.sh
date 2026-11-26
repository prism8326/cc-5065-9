#!/usr/bin/env bash
# 马尔可夫光路实验室启动器：仅依赖 python3（或任意静态服务器）。
set -e
cd "$(dirname "$0")"
PORT="${1:-8123}"
echo "============================================================"
echo " 马尔可夫光路实验室已启动"
echo " 浏览器打开:  http://localhost:${PORT}/"
echo " （若端口被占用可: ./start.sh 8234）"
echo " 也可以直接双击 index.html 打开（无需联网/构建）"
echo "============================================================"
exec python3 -m http.server "$PORT"

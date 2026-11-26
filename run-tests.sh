#!/usr/bin/env bash
# 狭缝照明制作 · 统一测试入口。
# 用法：./run-tests.sh           # 仅 Node 数值/素材包测试
#       ./run-tests.sh browser   # 额外运行 Playwright 浏览器测试（需先 ./.uitest 依赖就绪）
set -euo pipefail
cd "$(dirname "$0")"

echo "== [1/3] 内核数值测试 =="
node test/kernel-check.js

echo "== [2/3] 狭缝制作能力测试（门/帘、三态、微缩场景、多种子预算、素材包） =="
node test/slit-lab-check.js

echo "== [3/3] 入库素材包真实性与重建核验 =="
node test/pack-integrity-check.js

if [[ "${1:-}" == "browser" ]]; then
  echo "== 浏览器端到端（旧样例 + 光照实验窗口） =="
  if [[ -d .uitest/sysroot ]]; then
    export LD_LIBRARY_PATH="$PWD/.uitest/sysroot/usr/lib/$(uname -m)-linux-gnu:$PWD/.uitest/sysroot/lib/$(uname -m)-linux-gnu${LD_LIBRARY_PATH:-}"
  fi
  node test/e2e.js
  node test/ui-pack-check.js
fi

echo "全部测试通过。"

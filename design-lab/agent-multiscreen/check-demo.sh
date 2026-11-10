#!/usr/bin/env bash
# 单文件 Demo 的脚本语法回归检查。
# 背景：device-hub-popout.html 曾因一处模板字符串笔误导致整个脚本 SyntaxError、
# 页面白屏，而这是静态检查一眼能抓到的。改完 Demo 先跑这个再加载页面。
set -euo pipefail
cd "$(dirname "$0")"

html="${1:-device-hub-popout.html}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "== 抽取 <script> 块 =="
node -e '
const fs = require("fs");
const html = fs.readFileSync(process.argv[1], "utf8");
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (!blocks.length) { console.error("没有找到 <script> 块"); process.exit(1); }
blocks.forEach((b, i) => fs.writeFileSync(`${process.argv[2]}/block-${i}.js`, b[1]));
console.log(`共 ${blocks.length} 个块`);
' "$html" "$tmp"

echo "== node --check =="
fail=0
for f in "$tmp"/block-*.js; do
  if node --check "$f" 2>&1; then
    echo "  OK  $(basename "$f")"
  else
    echo "  FAIL $(basename "$f")"
    fail=1
  fi
done

exit "$fail"

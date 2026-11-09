#!/usr/bin/env bash
#
# sync.sh —— 把编译产物直接同步进【已安装的扩展目录】（开发热更新用）
#
# 为什么不用符号链接：
#   VS Code 的扩展发现依赖 ~/.vscode-oss/extensions/extensions.json 里的记录，
#   光放一个软链进去它不认（列表里直接看不到）。所以改成"正常装一次，
#   之后只覆盖文件"。
#
# 用法：
#   npm run sync        # 同步
#   然后 Ctrl+Shift+P → Developer: Reload Window
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXT_DIR="$HOME/.vscode-oss/extensions"

read -r PUBLISHER NAME VERSION <<<"$(node -e "
const p=require('$ROOT/package.json');
console.log(p.publisher, p.name, p.version);
")"
DEST="$EXT_DIR/$PUBLISHER.$NAME-$VERSION"

if [ ! -d "$DEST" ]; then
    echo "扩展没安装：$DEST"
    echo "先装一次（完全退出编辑器后）： npm run pack"
    exit 1
fi

echo "同步到：$DEST"

# 只覆盖运行需要的东西，源码和配置不动
rsync -a --delete "$ROOT/dist/" "$DEST/dist/"
rsync -a --delete "$ROOT/media/out/" "$DEST/media/out/"
rsync -a "$ROOT/media/" "$DEST/media/" --exclude 'css' --exclude 'out'
cp "$ROOT/package.json" "$DEST/package.json"

echo "完成。下一步：Ctrl+Shift+P → Developer: Reload Window"

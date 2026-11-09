#!/usr/bin/env bash
#
# dev-link.sh - 用符号链接代替 vsix 安装(开发时用)
#
# 为什么这么做:
#   装 vsix 的话,改一行代码要走"打包 → 卸载 → 安装 → 完全退出",几十秒.
#   软链之后扩展目录就是项目目录,改完只要 npm run compile + Reload Window.
#
# 注意两件事:
#   · 扩展加载的是 dist/main.cjs 和 media/out/,不是 src ⇒ 必须 compile
#   · 扩展宿主只在"重载窗口"时重启 ⇒ 必须 reload
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXT_DIR="$HOME/.vscode-oss/extensions"

# 目录名和扩展 id 都从 package.json 读,别硬编码
# (publisher 是 liu-qing-xue,带连字符,手写很容易漏)
read -r PUBLISHER NAME VERSION <<<"$(node -e "
const p=require('$ROOT/package.json');
console.log(p.publisher, p.name, p.version);
")"
LINK_NAME="$PUBLISHER.$NAME-$VERSION"
EXT_ID="$PUBLISHER.$NAME"

CLI="codium"
command -v codium >/dev/null 2>&1 || CLI="code"

# 编辑器开着的时候别动扩展目录:卸载会改 extensions.json,删目录可能让宿主困惑
if pgrep -f "/usr/share/vscodium/frontend" >/dev/null 2>&1 ||
   pgrep -f "/usr/share/code/code" >/dev/null 2>&1; then
    echo "编辑器正在运行,先完全退出再来(不是 Reload Window)."
    exit 1
fi

echo "项目目录:$ROOT"
echo "扩展目录:$EXT_DIR/$LINK_NAME"

# 已经是指向本项目的软链就别重复做
if [ -L "$EXT_DIR/$LINK_NAME" ] && [ "$(readlink "$EXT_DIR/$LINK_NAME")" = "$ROOT" ]; then
    echo "已经链接好了,不用重复操作."
    exit 0
fi

# 先把 vsix 装的那份卸掉(走 CLI,让它自己清账本 extensions.json)
if "$CLI" --list-extensions 2>/dev/null | grep -qx "$EXT_ID"; then
    echo "卸载已安装的 $EXT_ID"
    "$CLI" --uninstall-extension "$EXT_ID" >/dev/null 2>&1 || true
fi

# 兜底:残留目录 + 卸载黑名单
rm -rf "$EXT_DIR"/"$LINK_NAME" 2>/dev/null || true
rm -f "$EXT_DIR/.obsolete"

ln -s "$ROOT" "$EXT_DIR/$LINK_NAME"

echo
echo "完成:$EXT_DIR/$LINK_NAME -> $ROOT"
echo
echo "开发循环:"
echo "  1) npm run compile        (生成 dist/main.cjs,media/out,dist/in-pi)"
echo "  2) Ctrl+Shift+P → Developer: Reload Window"
echo
echo "如果扩展没被识别,先完全退出再启动一次."

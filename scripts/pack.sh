#!/usr/bin/env bash
#
# pack.sh —— 一键打包 + 安装（★ 用户要求的 ✓）
#
# 【它解决什么】
#   原来手动要来四步：compile → vsce package → 删旧扩展 + 清 .obsolete → install
#   ★ 而且每次都要记着"先删链接、清黑名单"✗ 忘了就会静默跳过（踩过 ✓）
#
# 【用法】
#   npm run pack          （推荐 ✗ 从项目根跑）
#   ./scripts/pack.sh
#
# 【为什么需要 --force】
#   version 没变（都是 1.0.0）⇒ codium 会认为"已经装过了"⇒ 跳过 ✓
#   --force 才会真的覆盖 ✓
#
# 【为什么必须"完全退出重开"而不是"重载窗口"】
#   扩展宿主的模块缓存不会因为 reload 而清 ✗
#   实测：只重载窗口 ⇒ 改动不生效（B42 踩过 ✓）
#
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
EXT_DIR="$HOME/.vscode-oss/extensions"

echo "▶ 打包（$ROOT）"

# ① 编译（vsce 也会跑 vscode:prepublish ✗ 但这里显式跑能看到编译输出 / 失败原因）
npm run compile

# ② 打包
rm -f ./*.vsix
npx --yes @vscode/vsce package --no-dependencies >/dev/null
VSIX="$(ls -t ./*.vsix | head -1)"
echo "▶ 产物：$(basename "$VSIX")  ($(du -h "$VSIX" | cut -f1))"

# ③ 清掉旧版本 —— ★★ 必须走 CLI 卸载，不能 rm -rf
#
# 【为什么不能用 rm -rf】（实测踩到的坑 ✓）
#   VSCodium 维护一份【扩展账本】：~/.vscode-oss/extensions/extensions.json
#   硬删目录 ⇒ 账本里还记着它（但 location 指向的路径已经不存在）
#   ⇒ CLI 一看"账本说装了 ✗ 磁盘上没有"⇒ 脏状态 ⇒ ★ 直接拒绝安装：
#        "Error: Please restart VSCodium before reinstalling pi-bridge-vs."
#   ⇒ 而且【重启也没用】（用户实测：退出后照样报 ✓）真正的修法是让 CLI 自己清账本 ✓
#
# 【CLI 卸载的好处】它同时：删目录 + 从账本移除（= 一次性干净 ✓）
#   ★ 也覆盖了"开发用的软链目录"那种同名残留 ✓
CLI="codium"
command -v codium >/dev/null 2>&1 || CLI="code"
EXT_ID="liu-qingxue.pi-bridge-vs"

if "$CLI" --list-extensions 2>/dev/null | grep -qx "$EXT_ID"; then
    echo "▶ 卸载旧版本（清账本 ✓）"
    "$CLI" --uninstall-extension "$EXT_ID" >/dev/null 2>&1 || true
fi
# 兜底：B42 踩过的"卸载黑名单"（残留会让同名扩展被静默跳过 ✓）
rm -f "$EXT_DIR/.obsolete"
# 兜底：万一账本里还留着而 CLI 列不出来（比如路径已坏 ✓）
rm -rf "$EXT_DIR/$EXT_ID"-* 2>/dev/null || true

# ④ 安装（--force：同版本号也覆盖 ✓）
if pgrep -f "/usr/share/vscodium/frontend" >/dev/null 2>&1 ||
   pgrep -f "/usr/share/code/code" >/dev/null 2>&1; then
    echo "⚠ 提示：编辑器似乎正在运行 ⇒ 若安装被拒，请完全退出后重跑"
fi

echo "▶ 安装（$CLI）"
"$CLI" --install-extension "$VSIX" --force

echo
echo "✔ 完成 ⇒ ★ 直接启动 $CLI 即可（全新启动 ✗ 不存在模块缓存问题 ✓）"

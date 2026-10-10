/**
 * ★★ B41：从 after 内容 + unified diff 反推出 before 内容
 *
 * 【为什么需要它】
 *   edit 工具的结果里有 details.patch（unified diff ✗ 含"改前 vs 改后"的全部信息）
 *   而磁盘上的文件就是"改后" ✓
 *   ⇒ 两者相减就得到"改前" ✗ 于是我们能在编辑器里开一个【真正的 diff 视图】
 *     （左边虚拟文档=改前 ✗ 右边真实文件=改后 ⇒ 右边还是可编辑的活文件 ✓）
 *     不必依赖 git / 历史 / 备份 ✓
 *
 * ★ 刻意放在 bridge/ 而不是 panels/：这里【零 vscode 依赖】✗
 *   于是 scripts/check-patch-reverse.mjs 能直接喂字符串测它 ✓（编译产物可直接 require）
 */
export function reverseApplyPatch(after: string, patch: string): string {
    const afterLines = after.split("\n");
    const before: string[] = [];
    let cursor = 0; // 在 afterLines 里的当前位置（0-based）
    let hunkSeen = false;

    for (const raw of patch.split("\n")) {
        if (raw.startsWith("--- ") || raw.startsWith("+++ ")) continue; // 文件头
        if (raw.startsWith("\\")) continue; // "\ No newline at end of file" 标记

        const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
        if (m) {
            hunkSeen = true;
            const start = Number(m[1]) - 1; // after 里这个 hunk 的起点
            // hunk 之前的区域：两边相同 ⇒ 原样搬过来
            while (cursor < start && cursor < afterLines.length) {
                before.push(afterLines[cursor++]);
            }
            continue;
        }

        if (!hunkSeen) continue; // hunk 之前的杂行 ⇒ 忽略

        if (raw.startsWith("-")) {
            // 删除行：before 里有 ✗ after 里没有 ⇒ 拷进来，游标不动
            before.push(raw.slice(1));
        } else if (raw.startsWith("+")) {
            // 新增行：after 里有 ✗ before 里没有 ⇒ 跳过，游标前进
            cursor++;
        } else {
            // 上下文行（" " 前缀或空行）⇒ 用 after 的实际内容（更可靠）
            if (cursor < afterLines.length) before.push(afterLines[cursor++]);
        }
    }

    // 收尾：after 里剩下的（最后一个 hunk 之后）原样拷贝
    while (cursor < afterLines.length) before.push(afterLines[cursor++]);

    return before.join("\n");
}

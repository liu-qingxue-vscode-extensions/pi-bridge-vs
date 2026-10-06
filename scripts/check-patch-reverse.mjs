/**
 * ★★ B41 守门员：验证 reverseApplyPatch（从 after + patch 反推 before）
 *
 * 为什么值得一个专门的脚本：
 *   · 它是【纯算法 ✗ 没有肉眼可验证的输出】⇒ 错了只会表现为"编辑器里 diff 显示得怪"
 *   · 而且它决定"左边那份改前内容"对不对 ✗ 错了比不显示还糟（误导）
 *   · 用例全部用【真实数据】（从 pi 的实际 patch 抄来的）+ 边界情况
 *
 * 跑法：npm run compile（会自动带上）或 node scripts/check-patch-reverse.mjs
 */

import { reverseApplyPatch } from "../dist/bridge/patch-reverse.js";

let failed = 0;
let passed = 0;

function check(name, got, want) {
    if (got === want) {
        passed++;
        console.log(`  ✓ ${name}`);
    } else {
        failed++;
        console.log(`  ✗ ${name}`);
        console.log(`      期望: ${JSON.stringify(want)}`);
        console.log(`      实际: ${JSON.stringify(got)}`);
    }
}

/** 造一份 patch 文本（省得手写一堆换行）*/
const P = (...lines) => lines.join("\n");

console.log("=== reverseApplyPatch 单测 ===\n");

// ── ① 真实数据：用户测试文件的"一行改一行" ──
check(
    "真实数据：单行替换（1 行改 1 行）",
    reverseApplyPatch(
        "line1: hello\nline2: edited content\nline3: end\n",
        P(
            "--- /tmp/pi_write_edit_test.txt",
            "+++ /tmp/pi_write_edit_test.txt",
            "@@ -1,3 +1,3 @@",
            " line1: hello",
            "-line2: original content",
            "+line2: edited content",
            " line3: end",
        ),
    ),
    "line1: hello\nline2: original content\nline3: end\n",
);

// ── ② 纯新增（after 比 before 多行）──
check(
    "纯新增：插入了两行",
    reverseApplyPatch(
        "a\nX\nY\nb\n",
        P("@@ -1,2 +1,4 @@", " a", "+X", "+Y", " b"),
    ),
    "a\nb\n",
);

// ── ③ 纯删除（after 比 before 少行）──
check(
    "纯删除：删掉了两行",
    reverseApplyPatch("a\nb\n", P("@@ -1,4 +1,2 @@", " a", "-X", "-Y", " b")),
    "a\nX\nY\nb\n",
);

// ── ④ 多 hunk：hunk 之间的内容必须原样保留 ──
//   ★ 数据必须【三者自洽】：after 的第 2 行就得是 patch 里 +A1x 的结果
//     （第一次写这条时 after 里放了多余的 B ✗ 结果算法正确地把 B 当成"被替换掉的行"
//        ⇒ 是测试数据错 ✗ 不是算法错 ✓ 这正说明单测有用）
check(
    "多 hunk：hunk 之间的内容不能被吃掉（第 3-4 行要原样保留）",
    reverseApplyPatch(
        "A1\nA1x\nC1\nD\nE\nE1\n", // after：hunk1 改完 + hunk2 改完
        P(
            "@@ -1,2 +1,2 @@",
            " A1",
            "-A0",
            "+A1x",
            "@@ -5,2 +5,2 @@",
            " E",
            "-E0",
            "+E1",
        ),
    ),
    "A1\nA0\nC1\nD\nE\nE0\n", // before：两处都还原 ✗ C1/D 原样
);

// ── ⑤ 末尾无换行（patch 里有 \ No newline 标记）──
check(
    "末尾无换行：\\ No newline 标记要跳过",
    reverseApplyPatch(
        "a\nb",
        P("@@ -1,2 +1,2 @@", " a", "-b0", "+b", "\\ No newline at end of file"),
    ),
    "a\nb0",
);

// ── ⑥ 空 patch（没有任何 hunk）⇒ 原样返回 ──
check(
    "空 patch ⇒ after 原样返回",
    reverseApplyPatch("a\nb\n", P("--- x", "+++ x")),
    "a\nb\n",
);

// ── ⑦ 多行替换（3 行换成 2 行）──
check(
    "多行替换：3 行 → 2 行",
    reverseApplyPatch("a\nN1\nN2\nz\n", P("@@ -1,4 +1,4 @@", " a", "-O1", "-O2", "-O3", "+N1", "+N2", " z")),
    "a\nO1\nO2\nO3\nz\n",
);

console.log(`\n=== ${passed} 通过 ✗ ${failed} 失败 ===`);
if (failed) {
    console.error("★ reverseApplyPatch 反推结果不对 ⇒ diff 视图里的\"改前\"会是错的");
    process.exit(1);
}

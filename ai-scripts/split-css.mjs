#!/usr/bin/env node
/**
 * split-css —— 一次性重构：把 738 行的 media/chat.css 按【职责】拆成 media/css/*.css
 *
 * 【为什么要拆？】
 *   738 行单文件 → 改一处要在里面翻半天，且容易改错 / 误匹配（本项目已多次踩坑 ✗）
 *   拆成按职责的小文件后：改顶栏只动 topbar.css ✓
 *
 * 【拆分原则】
 *   · 按【职责】而不是按【行数】—— 每个文件是一块完整语义 ✓
 *   · 入口 chat.css 只留 @import（同源加载，CSP 的 style-src 允许 ✓）
 *   · 顺便去掉整体 2 空格缩进（原来整个文件在一个缩进层里 ✗）
 *
 * 幂等性：本脚本只应从【完整的大文件】运行一次；跑完 chat.css 就变成入口了，
 *         再跑会因为行号区间不存在而产出空文件 ✗（所以只跑一次）
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const SRC = "media/chat.css";
const lines = readFileSync(SRC, "utf8").split("\n"); // 0-indexed

/**
 * 行号（1-indexed，含两端）→ 目标文件
 * ★ 同一文件可以出现多次（片段会被按顺序拼接 ✓）
 *
 * 行号来自旧 chat.css 的实测内容：
 *   1..107    可调变量 + #messages + 滚动条
 *   108..243  顶部区域 + 统计栏 + 电池
 *   244..314  通知面板
 *   315..422  气泡基础 / user / 折叠头 / thinking / pending / dots
 *   423..523  工具气泡外框 + 参数键值对 + 结果
 *   524..571  异常结束提示 + 重连提示（★ 也是气泡 → 归 bubbles）
 *   572..590  工具状态图标（转圈/勾/叉）
 *   591..613  气泡间距 + 居中列模式
 *   614..738  输入区 + 输入区下方极简栏
 */
const RANGES = [
    ["base.css", 1, 107],
    ["topbar.css", 108, 243],
    ["notices.css", 244, 314],
    ["bubbles.css", 315, 422],
    ["tool.css", 423, 523],
    ["bubbles.css", 524, 571],
    ["tool.css", 572, 590],
    ["bubbles.css", 591, 613],
    ["input.css", 614, 738],
];

const TITLES = {
    "base.css": "基础：可调变量 + 对话区 + 滚动条",
    "topbar.css": "顶栏（topbar）：按钮容器 + 统计栏 + 电池",
    "notices.css": "通知面板（手机式下拉）",
    "bubbles.css": "气泡：基础 / 用户 / 思考 / 占位三点 / 异常与重连提示 / 间距 / 居中列",
    "tool.css": "工具气泡：外框 / 参数键值对 / 结果 / 状态图标",
    "input.css": "输入区：悬浮框 + 下方极简栏",
};

mkdirSync("media/css", { recursive: true });

/** 累积各文件的行（同一文件多个片段按顺序拼接 ✓） */
const out = new Map();
for (const [file, from, to] of RANGES) {
    const chunk = lines.slice(from - 1, to);
    // ★ 统一去掉 2 空格缩进（旧文件整体多缩进了一层 ✗）
    const dedented = chunk.map((l) => (l.startsWith("  ") ? l.slice(2) : l));
    out.set(file, [...(out.get(file) ?? []), ...dedented]);
}

const header = (name) =>
    `/* ===== ${TITLES[name]} =====\n` +
    `   由 scripts/split-css.mjs 从旧的 media/chat.css 切出（一次性重构）\n` +
    `   ★ 改这一块只需动本文件 ✓ */\n\n`;

for (const [file, body] of out) {
    const text = (header(file) + body.join("\n"))
        .replace(/^\n+/, "")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/\s+$/, "");
    writeFileSync(`media/css/${file}`, text + "\n");
    console.log(`  media/css/${file.padEnd(13)} ${body.length} 行`);
}

// 入口：保持【首次出现的顺序】（与原文件语义顺序一致 ✓）
const order = [...new Set(RANGES.map(([f]) => f))];
const entry =
    `/* =====================================================================\n` +
    `   chat.css —— 【入口】（这里不再直接写样式 ✗）\n` +
    `   各部分按职责拆在 media/css/ 下，用 @import 串起来 ✓\n` +
    `   （CSP 的 style-src 允许同源加载 ✓ · 本地文件无网络开销 ✓）\n` +
    `   ===================================================================== */\n` +
    order.map((f) => `@import url("./css/${f}");`).join("\n") +
    "\n";

writeFileSync(SRC, entry);
console.log("✓ media/chat.css 已改为入口（@import）");
console.log(`  ${order.join(" → ")}`);

#!/usr/bin/env node
/**
 * split-docs —— 把 802 行的 docs/batch-B.md 按批次拆成 docs/batches/B1.md … B8.md
 *
 * 【为什么拆？】
 *   802 行单文件 → 找一个批次的细节要滚半天 ✗
 *   拆开后：改 B8 只动 docs/batches/B8.md ✓
 *
 * 【拆完之后的 batch-B.md】
 *   保留为【B 批次索引 + 台账】：
 *     · 消灭进度表（本批次的核心台账）
 *     · 22 项外观配置速查
 *     · 指向各 Bn.md 的链接
 *
 * 【切分规则】
 *   从 "## B1：…" 这类标题切；"## B5（续）：…" 并入 B5 ✓
 *   标题之前的内容（头 + 台账）= 留在 batch-B.md ✓
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const SRC = "docs/batch-B.md";
const lines = readFileSync(SRC, "utf8").split("\n");

// 找出各批次的起始行（匹配 "## Bn：" / "## Bn（续）："）
const marks = [];
lines.forEach((l, i) => {
    const m = l.match(/^## (B\d+)(\uff08\u7eed\uff09)?[:\uff1a]/);
    if (m) marks.push({ line: i, batch: m[1] });
});

if (marks.length === 0) throw new Error("没有找到任何 ## Bn 标题 —— 文件名/格式变了？");

/** 切出每个批次正文（同一批次多个片段按顺序拼接 ✓） */
const chunks = new Map();
for (let i = 0; i < marks.length; i++) {
    const from = marks[i].line;
    const to = i + 1 < marks.length ? marks[i + 1].line : lines.length;
    const body = lines.slice(from, to).join("\n").replace(/\s+$/, "");
    chunks.set(marks[i].batch, [...(chunks.get(marks[i].batch) ?? []), body]);
}

mkdirSync("docs/batches", { recursive: true });

/** 头部说明（每个批次文件都带上，方便独立阅读 ✓） */
const header = (name) =>
    `# ${name}（详细记录）\n\n` +
    `> 本文件由 \`scripts/split-docs.mjs\` 从 \`docs/batch-B.md\` 切出（还原原文 ✓，未改内容）\n` +
    `> 批次总览与消灭进度台账见 [\`../batch-B.md\`](../batch-B.md)\n\n---\n\n`;

const order = [];
for (const [batch, parts] of chunks) {
    order.push(batch);
    const body = parts.join("\n\n");
    writeFileSync(`docs/batches/${batch}.md`, header(batch) + body + "\n");
    console.log(`  docs/batches/${batch}.md   ${body.split("\n").length} 行`);
}

// ── 重写 batch-B.md：只留 标题之前的内容（台账）+ 各批次链接 ──
const preamble = lines.slice(0, marks[0].line).join("\n").replace(/\s+$/, "");

const links =
    `\n## 各批次详细记录\n\n` +
    `> 本文件原本包含全部批次详情（802 行 ✗）；已按批次拆到 \`docs/batches/\`，这里只留总览。\n\n` +
    order
        .map((b) => {
            const first = (chunks.get(b)[0].match(/^## (.+)$/m) ?? [])[1] ?? b;
            const title = first.replace(/^B\d+[\uff1a:]\s*/, "");
            return `- **[${b} — ${title}](./batches/${b}.md)**`;
        })
        .join("\n") +
    "\n";

writeFileSync(SRC, preamble + "\n" + links);
console.log("✓ docs/batch-B.md 已瘦身为【台账 + 索引】");
console.log(`  批次：${order.join(" ")}`);

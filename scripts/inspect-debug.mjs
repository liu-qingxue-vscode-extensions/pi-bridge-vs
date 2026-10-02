/**
 * 分析调试板导出的 JSON（/tmp/test/pi-debug-*.json）
 *
 * 用法：
 *   node scripts/inspect-debug.mjs [文件路径]
 *   node scripts/inspect-debug.mjs                    # 默认取 /tmp/test/ 下最新的
 *
 * 目的：
 *   1. 统计事件类型分布（看消灭进度 / 找盲区）
 *   2. 判断 tool_execution_update.partialResult 是【累积】还是【增量】
 *      —— 这决定了前端是「替换」还是「追加」✗猜错会重复一万遍
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DIR = "/tmp/test";

function latestFile() {
    const files = readdirSync(DIR)
        .filter((f) => f.endsWith(".json"))
        .map((f) => ({ f, m: statSync(join(DIR, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
    if (!files.length) throw new Error(`${DIR} 下没有 .json 文件`);
    return join(DIR, files[0].f);
}

const file = process.argv[2] ?? latestFile();
const arr = JSON.parse(readFileSync(file, "utf8"));
console.log(`文件：${file}\n记录数：${arr.length}\n`);

// ---- 1. 事件计数 ----
const counts = {};
for (const e of arr) counts[e.type] = (counts[e.type] ?? 0) + 1;

console.log("=== 事件类型分布 ===");
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(4)}  ${k}`);
}

const find = (t) => arr.filter((e) => e.type === t);
const body = (e) => e.data ?? e.payload ?? e;

// ---- 2. tool_execution_update：累积 vs 增量 ----
const updates = find("tool_execution_update");
console.log(`\n=== tool_execution_update（${updates.length} 个）===`);
if (!updates.length) {
    console.log("  （本次没有采集到 ✗ 需要跑一个【带输出的慢命令】）");
} else {
    let prev = "";
    for (const [i, e] of updates.entries()) {
        const d = body(e);
        const pr = d.partialResult ?? d;
        const text = (pr.content ?? [])
            .filter((p) => p && p.type === "text")
            .map((p) => p.text ?? "")
            .join("");
        let verdict = "增量?";
        if (prev) {
            if (text === prev) verdict = "重复（无变化）";
            else if (text.startsWith(prev)) verdict = "★累积（全文）";
            else if (prev.startsWith(text)) verdict = "回退??";
            else verdict = "★增量（片段）";
        }
        console.log(`  #${i + 1}  len=${String(text.length).padStart(5)}  类型=${verdict}`);
        console.log(`        ${JSON.stringify(text.slice(0, 80))}`);
        prev = text;
    }
}

// ---- 3. 关键事件计数（判断盲区）----
console.log("\n=== 关键事件 ===");
for (const t of [
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "toolResult",
    "toolcall_start",
    "toolcall_end",
    "stopReason",
]) {
    console.log(`  ${String(find(t).length).padStart(3)}  ${t}`);
}

/**
 * analyze-debug —— 调试板导出的 JSON 【全字段大解析】
 *
 * 用法：
 *   node scripts/analyze-debug.mjs <文件.json>
 *   node scripts/analyze-debug.mjs <文件.json> --full     # 打印每个字段的完整样本
 *
 * 目的：
 *   对着【真实数据】摸清 pi 协议的全部字段，而不是去翻源码 ✗
 *
 * 输出四部分：
 *   ① 事件类型分布（含未消费标记）
 *   ② 字段路径树（schema 提取：每个字段的类型 + 出现次数）
 *   ③ 关键字段样本（usage / stopReason / model / cost ...）
 *   ④ 消费进度对照（哪些字段已进 UI，哪些还是盲区）
 */
import { readFileSync } from "node:fs";

const file = process.argv[2];
const FULL = process.argv.includes("--full");
if (!file) {
    console.error("用法：node scripts/analyze-debug.mjs <文件.json> [--full]");
    process.exit(1);
}

const arr = JSON.parse(readFileSync(file, "utf8"));
console.log(`文件：${file}`);
console.log(`记录数：${arr.length}\n`);

/** 哪些事件已经在 UI 里消费了（跟 docs/batch-B.md 的台账保持一致）*/
const CONSUMED = new Set([
    "message_start",
    "message_update",
    "message_end",
    "agent_start",
    "agent_settled",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
]);
/** 明确是"过程噪音"、不打算消费的 */
const IGNORED = new Set(["turn_start", "turn_end", "agent_end"]);

// 记录可能是 { type, ...data } 或 { type, data: {...} } —— 兼容两种
const body = (e) => (e.data && typeof e.data === "object" ? e.data : e);

// ---------- ① 事件类型分布 ----------
const counts = {};
for (const e of arr) counts[e.type] = (counts[e.type] ?? 0) + 1;

console.log("=== ① 事件类型分布 ===");
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    const tag = CONSUMED.has(k) ? "✅已消费" : IGNORED.has(k) ? "⚪忽略" : "❌盲区";
    console.log(`  ${String(v).padStart(4)}  ${k.padEnd(26)} ${tag}`);
}

// ---------- ② 字段路径树 ----------
const tree = new Map(); // path -> { types:Set, count, sample }

function walk(obj, path) {
    if (obj === null) return;
    if (Array.isArray(obj)) {
        if (obj.length) walk(obj[0], path + "[]");
        return;
    }
    if (typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj)) {
        const p = path ? `${path}.${k}` : k;
        if (v !== null && typeof v === "object" && !Array.isArray(v)) {
            walk(v, p);
        } else if (Array.isArray(v)) {
            walk(v, p + "[]");
            if (!tree.has(p)) tree.set(p, { types: new Set(), n: 0, sample: v });
            const t = tree.get(p);
            t.types.add("array");
            t.n++;
        } else {
            if (!tree.has(p)) tree.set(p, { types: new Set(), n: 0, sample: v });
            const t = tree.get(p);
            t.types.add(typeof v);
            t.n++;
        }
    }
}

for (const e of arr) walk(body(e), e.type);

console.log("\n=== ② 字段路径（每个字段出现次数 + 类型）===");
const paths = [...tree.keys()].sort();
for (const p of paths) {
    const t = tree.get(p);
    const types = [...t.types].join("|");
    const sample = JSON.stringify(t.sample) ?? "";
    const s = sample.length > 72 ? sample.slice(0, 72) + "…" : sample;
    console.log(`  ${String(t.n).padStart(4)}×  ${p.padEnd(46)} ${types.padEnd(8)} e.g. ${s}`);
}

// ---------- ③ 关键字段样本 ----------
console.log("\n=== ③ 关键字段样本 ===");
const find = (t) => arr.filter((e) => e.type === t).map(body);

const usageHits = [];
const stopHits = new Map();
const modelHits = new Set();
for (const e of [...find("message_end"), ...find("turn_end"), ...find("agent_end")]) {
    const msgs = e.messages ?? (e.message ? [e.message] : []);
    for (const m of msgs) {
        if (!m || typeof m !== "object") continue;
        if (m.usage) usageHits.push(m.usage);
        if (m.stopReason) stopHits.set(m.stopReason, (stopHits.get(m.stopReason) ?? 0) + 1);
        if (m.model) modelHits.add(`${m.provider}/${m.model}${m.responseModel ? ` (→${m.responseModel})` : ""}`);
    }
}

console.log("  模型：", modelHits.size ? [...modelHits].join("  ·  ") : "（无）");
console.log("  stopReason 分布：", stopHits.size ? [...stopHits].map(([k, v]) => `${k}×${v}`).join("  ") : "（无）");
if (usageHits.length) {
    const u = usageHits.at(-1);
    console.log("  usage 字段：", Object.keys(u).join(", "));
    console.log("  最后一次 usage：", JSON.stringify(u));
    console.log("  ★ 成本是否非零：", u.cost?.total ? "是 ✓" : "否（全 0 ✗ —— 可能模型无价格配置）");
} else {
    console.log("  usage：（无）");
}

// 上下文窗口线索：整个导出里搜有没有类似字段
const ct = paths.filter((p) => /context|window|limit|maxToken/i.test(p));
console.log("  ★ 上下文窗口线索：", ct.length ? ct.join(", ") : "❌ 导出里没有（要另找）");

// ---------- ④ 消费进度对照 ----------
console.log("\n=== ④ 消费进度 ===");
const blind = Object.keys(counts).filter((k) => !CONSUMED.has(k) && !IGNORED.has(k));
console.log("  ✅ 已消费：", [...CONSUMED].filter((k) => counts[k]).join(", ") || "（本次没有）");
console.log("  ❌ 仍是盲区：", blind.join(", ") || "（无 ✓）");
console.log("  ⚪ 标记忽略：", [...IGNORED].filter((k) => counts[k]).join(", ") || "（无）");

if (FULL) {
    console.log("\n=== ⑤ 原始记录（--full）===");
    for (const [i, e] of arr.entries()) {
        console.log(`\n--- #${i + 1} ${e.type} ---`);
        console.log(JSON.stringify(e, null, 2));
    }
}

/**
 * schema-debug —— 按【事件 type】提取字段 schema（结构 + 取值分布）
 *
 * 用法：
 *   node scripts/schema-debug.mjs <文件.json> [文件2.json ...]
 *   node scripts/schema-debug.mjs test_date/*.json          # 多文件合并分析
 *   node scripts/schema-debug.mjs test_date/*.json message_end   # 只看某个 type
 *
 * 【为什么需要它？】
 * 之前 debug 的做法是"遇到问题再 grep 一下"，效率低 ✗ 而且容易漏字段 ✗
 * 正确方法是：把每个 type 的【全部字段 + 类型 + 取值分布】一次摊开 ✓
 * 看完就知道什么形状能干什么，不用猜 ✓
 *
 * 输出示例：
 *   === message_end（17 次）===
 *     message.role         string   user(8) | assistant(9)
 *     message.stopReason   string   error(10) | stop(3) | aborted(1) | (缺)(3)
 *     message.usage.totalTokens  number  0 | 3074 | 3082
 */
import { readFileSync } from "node:fs";

const files = process.argv.slice(2).filter((a) => !a.startsWith("--") || false);
const typeFilter = process.argv.slice(2).find((a) => a.startsWith("--type="))?.slice(7)
    ?? process.argv.slice(2).find((a) => !a.endsWith(".json") && !a.startsWith("--"));

const jsonFiles = process.argv.slice(2).filter((a) => a.endsWith(".json"));
if (!jsonFiles.length) {
    console.error("用法：node scripts/schema-debug.mjs <文件.json> [...] [<类型名>]");
    process.exit(1);
}

/** 收集所有记录（跨文件合并 ✓） */
const all = [];
for (const f of jsonFiles) {
    const arr = JSON.parse(readFileSync(f, "utf8"));
    for (const e of arr) all.push(e);
}
console.log(`文件：${jsonFiles.join(", ")}`);
console.log(`总记录数：${all.length}\n`);

/** 兼容 { type, data:{...} } 与 { type, ...data } 两种形态 */
const body = (e) => (e.data && typeof e.data === "object" ? e.data : e);

/** 字段统计：path → { types:Set, count, values:Map, samples:[] } */
function newStat() {
    return { types: new Set(), count: 0, values: new Map(), samples: [] };
}

function record(stat, key, value) {
    stat.count++;
    stat.types.add(Array.isArray(value) ? "array" : typeof value);
    // 取值分布：只对小标量记录（对象/数组只看结构 ✓）
    if (Array.isArray(value)) {
        if (value.length) record(stat, key, value[0]); // 递归首元素（简化处理）
        return;
    }
    if (value !== null && typeof value === "object") return;
    const v = JSON.stringify(value);
    stat.values.set(v, (stat.values.get(v) ?? 0) + 1);
    if (stat.samples.length < 3) stat.samples.push(value);
}

function walk(obj, path, out, depth = 0) {
    if (depth > 6 || obj === null) return;
    if (Array.isArray(obj)) {
        if (!obj.length) return;
        // 数组：递归首元素，路径标 []
        walk(obj[0], path + "[]", out, depth + 1);
        return;
    }
    if (typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj)) {
        const p = path ? `${path}.${k}` : k;
        if (!out.has(p)) out.set(p, newStat());
        const stat = out.get(p);
        if (Array.isArray(v)) {
            stat.count++;
            stat.types.add("array");
            walk(v, p + "[]", out, depth + 1);
        } else if (v !== null && typeof v === "object") {
            stat.count++;
            stat.types.add("object");
            walk(v, p, out, depth + 1);
        } else {
            record(stat, p, v);
        }
    }
}

// ---------- 按 type 分组 ----------
const byType = new Map();
for (const e of all) {
    const t = e.type ?? "(无 type)";
    if (typeFilter && t !== typeFilter) continue;
    if (!byType.has(t)) byType.set(t, { n: 0, fields: new Map() });
    const g = byType.get(t);
    g.n++;
    walk(body(e), "", g.fields);
}

const order = [...byType.keys()].sort((a, b) => byType.get(b).n - byType.get(a).n);

for (const t of order) {
    const g = byType.get(t);
    console.log(`═══ ${t}（${g.n} 次）═══`);
    const paths = [...g.fields.keys()].sort();
    for (const p of paths) {
        const s = g.fields.get(p);
        const types = [...s.types].join("|");
        const vals = [...s.values.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6)
            .map(([v, c]) => `${v}(${c})`)
            .join(" | ");
        const missing =
            s.count < g.n ? `  ⚠缺${g.n - s.count}次` : "";
        console.log(
            `  ${p.padEnd(42)} ${types.padEnd(9)} ${vals}${missing}`,
        );
    }
    console.log("");
}

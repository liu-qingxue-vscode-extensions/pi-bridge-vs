/**
 * inspect-session —— 把会话文件（.jsonl）的结构导出成【可反复阅读】的摘要
 *
 * 【为什么写文件而不是直接打印？】（用户的要求 ✓）
 *   会话文件动辄几百行、每行都很大 ✗
 *   直接打到终端 → 刷屏 + 污染上下文 ✗
 *   → 导出成【结构化 JSON】✓ 之后用 read + offset 精确看某一段 ✓
 *   → 而且【压缩会话 / 新格式】这类事，以后也能先跑它看一眼 ✓
 *
 * 【用法】
 *   node scripts/inspect-session.mjs                # 自动取最近修改的会话
 *   node scripts/inspect-session.mjs <文件路径>
 *   node scripts/inspect-session.mjs --all          # 列出所有会话（按时间）
 *
 * 【输出】
 *   test_date/session-structure.json  （结构摘要 ✓）
 *   test_date/session-samples.json    （各类型前几条样本 ✓ 截断过的 ✓）
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ROOT = path.join(os.homedir(), ".pi/agent/sessions");
const OUT_DIR = path.join(import.meta.dirname, "..", "test_date");

/** 递归收集某个对象出现的所有字段路径（用于"这个类型有哪些字段" ✓） */
function collectPaths(value, prefix = "", out = new Set(), depth = 0) {
    if (depth > 4) return out; // 够深了（再深就是噪声 ✓）
    if (Array.isArray(value)) {
        // 数组：看第 0 个元素（结构一般一致 ✓）
        if (value.length) collectPaths(value[0], prefix + "[]", out, depth + 1);
        return out;
    }
    if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) {
            const p = prefix ? `${prefix}.${k}` : k;
            out.add(p);
            collectPaths(v, p, out, depth + 1);
        }
        return out;
    }
    return out;
}

/** 找最近修改的会话文件 */
function findLatest() {
    let best = null;
    for (const dir of fs.readdirSync(ROOT)) {
        const dirPath = path.join(ROOT, dir);
        if (!fs.statSync(dirPath).isDirectory()) continue;
        for (const name of fs.readdirSync(dirPath)) {
            if (!name.endsWith(".jsonl")) continue;
            const f = path.join(dirPath, name);
            const m = fs.statSync(f).mtimeMs;
            if (!best || m > best.mtime) best = { file: f, mtime: m };
        }
    }
    return best?.file;
}

/** 列出所有会话（按时间倒序 ✓） */
function listAll() {
    const out = [];
    for (const dir of fs.readdirSync(ROOT)) {
        const dirPath = path.join(ROOT, dir);
        if (!fs.statSync(dirPath).isDirectory()) continue;
        for (const name of fs.readdirSync(dirPath)) {
            if (!name.endsWith(".jsonl")) continue;
            const f = path.join(dirPath, name);
            out.push({ file: f, mtime: fs.statSync(f).mtimeMs, size: fs.statSync(f).size });
        }
    }
    return out.sort((a, b) => b.mtime - a.mtime);
}

const args = process.argv.slice(2);

if (args[0] === "--all") {
    const all = listAll();
    console.log(`共 ${all.length} 个会话：\n`);
    for (const s of all.slice(0, 40)) {
        const rel = s.file.replace(ROOT + "/", "");
        console.log(`${new Date(s.mtime).toISOString().slice(0, 16)}  ${String(s.size).padStart(8)}B  ${rel}`);
    }
    if (all.length > 40) console.log(`…（还有 ${all.length - 40} 个）`);
    process.exit(0);
}

const file = args[0] || findLatest();
if (!file || !fs.existsSync(file)) {
    console.error("找不到会话文件:", file);
    process.exit(1);
}

// ── 逐行解析 ──
const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
const typeCounts = {};
const schemas = {}; // type → Set(字段路径)
const samples = {}; // type → 前 2 条的【截断版】
let parseErrors = 0;

for (const line of lines) {
    let obj;
    try {
        obj = JSON.parse(line);
    } catch {
        parseErrors++;
        continue;
    }
    const t = obj.type ?? "(无 type)";
    typeCounts[t] = (typeCounts[t] ?? 0) + 1;

    if (!schemas[t]) schemas[t] = new Set();
    for (const p of collectPaths(obj)) schemas[t].add(p);

    if (!samples[t]) samples[t] = [];
    if (samples[t].length < 2) {
        // 截断大字段（否则样本本身也会很大 ✗）
        samples[t].push(JSON.parse(JSON.stringify(obj, (k, v) => (typeof v === "string" && v.length > 300 ? v.slice(0, 300) + `…(+${v.length - 300})` : v))));
    }
}

const summary = {
    file,
    dirName: path.basename(path.dirname(file)),
    totalLines: lines.length,
    parseErrors,
    typeCounts,
    schemas: Object.fromEntries(
        Object.entries(schemas).map(([t, set]) => [t, [...set].sort()]),
    ),
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, "session-structure.json"), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(OUT_DIR, "session-samples.json"), JSON.stringify(samples, null, 2));

console.log(`✓ 已导出（${lines.length} 行 / ${Object.keys(typeCounts).length} 种类型）`);
console.log(`  test_date/session-structure.json   字段结构`);
console.log(`  test_date/session-samples.json     样本`);
console.log(`  类型: ${Object.keys(typeCounts).join(", ")}`);

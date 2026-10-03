/**
 * audit-sessions —— 扫【全部】会话文件，统计字段的"完整度"
 *
 * 【为什么需要它？】（用户要求的 ✓）
 *   写代码时我假设"每个会话都有 session_info.name" ✗
 *   但那【不一定】—— 老文件、异常中断的文件都可能没有 ✓
 *   → 先用数据验证假设，再写依赖它的代码 ✓
 *
 * 【输出原则】★ 只打印摘要 + 极少数异常样本
 *   会话文件有几百个 → 逐条打印会刷屏 + 污染上下文 ✗
 *   要明细就导出到 test_date/ 再慢慢读 ✓
 *
 * 【用法】node scripts/audit-sessions.mjs
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ROOT = path.join(os.homedir(), ".pi/agent/sessions");
const OUT_DIR = path.join(import.meta.dirname, "..", "test_date");

/** 文件名：2026-07-31T12-19-50-851Z_<uuid>.jsonl
 *  ★ 实测两种：毫秒前可能是 - 也可能是 .（不同 pi 版本 ✓）*/
const FILE_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})[-.](\d{3})Z_([0-9a-f-]+)\.jsonl$/i;

/** 读文件头（首行 = session 元数据） */
function readHead(file, bytes = 4096) {
    const fd = fs.openSync(file, "r");
    try {
        const buf = Buffer.alloc(bytes);
        const n = fs.readSync(fd, buf, 0, bytes, 0);
        return buf.subarray(0, n).toString("utf8");
    } finally {
        fs.closeSync(fd);
    }
}

/** 读文件尾（session_info 是最后追加的 ✓） */
function readTail(file, bytes = 32768) {
    const size = fs.statSync(file).size;
    const want = Math.min(size, bytes);
    const fd = fs.openSync(file, "r");
    try {
        const buf = Buffer.alloc(want);
        fs.readSync(fd, buf, 0, want, size - want);
        return buf.toString("utf8");
    } finally {
        fs.closeSync(fd);
    }
}

/** 从尾部找【最后一个】session_info.name */
function extractName(tail) {
    for (const line of tail.split("\n").reverse()) {
        if (!line.includes("session_info")) continue;
        try {
            const o = JSON.parse(line);
            if (o?.type === "session_info" && typeof o.name === "string" && o.name.trim()) {
                return { name: o.name.trim(), autoTitle: o.autoTitle === true };
            }
        } catch {
            /* 截断的首行不是合法 JSON —— 跳过 ✓ */
        }
    }
    return undefined;
}

// ── 遍历所有会话 ──
const dirs = fs.readdirSync(ROOT).filter((d) => fs.statSync(path.join(ROOT, d)).isDirectory());

const stat = {
    dirs: dirs.length,
    files: 0,
    /** ★ 异常文件全记录（不是只存 5 个样本 ✗）——名字 + 原因 ✓ */
    problems: {},
    withName: 0,
    autoTitled: 0,
    manualTitled: 0,
    sizes: [],
};

/** 记一个异常文件（同一个原因只记文件名 ✓） */
function markProblem(reason, name) {
    (stat.problems[reason] ??= []).push(name);
}

for (const dir of dirs) {
    const dirPath = path.join(ROOT, dir);
    for (const name of fs.readdirSync(dirPath)) {
        if (!name.endsWith(".jsonl")) continue;
        stat.files++;
        const file = path.join(dirPath, name);

        // ★ 文件名不合规：无法从名字拿时间/id → 前端无法排序展示 ✗
        if (!FILE_RE.test(name)) {
            markProblem("文件名格式不识认", name);
            continue;
        }

        let head = "";
        try {
            head = readHead(file);
        } catch {
            markProblem("文件读不了（权限/损坏）", name);
            continue;
        }

        // 首行必须是 {"type":"session",…,"cwd":…}
        let okSession = false;
        let cwd = "";
        try {
            const o = JSON.parse(head.split("\n", 1)[0]);
            okSession = o?.type === "session";
            cwd = typeof o?.cwd === "string" ? o.cwd : "";
        } catch {
            /* 解析失败 */
        }
        if (!okSession) markProblem("首行不是 session 元数据", name);
        else if (!cwd) markProblem("首行缺 cwd", name);

        // 尾部找名字（★ 没名字是【正常情况】（审计：31% 没有 ✓）→ 不算异常 ✗）
        let found;
        try {
            found = extractName(readTail(file));
        } catch {
            /* 读失败 → 当没名字（正常分支 ✓）*/
        }
        if (found) {
            stat.withName++;
            if (found.autoTitle) stat.autoTitled++;
            else stat.manualTitled++;
        }

        try {
            stat.sizes.push(fs.statSync(file).size);
        } catch {
            /* ignore */
        }
    }
}

stat.sizes.sort((a, b) => a - b);
const pct = (n) => (stat.files ? ((n / stat.files) * 100).toFixed(1) + "%" : "-");

console.log(`\n═══ 会话文件审计 ═══`);
console.log(`目录数 ${stat.dirs} / 文件数 ${stat.files}`);
console.log(`\n【会话名（取尾部 session_info.name）】`);
console.log(`  有名字: ${stat.withName} 个 (${pct(stat.withName)})`);
console.log(`    ├ 自动生成(autoTitle): ${stat.autoTitled}`);
console.log(`    └ 手动/其他:           ${stat.manualTitled}`);
console.log(
    `  没名字: ${stat.files - stat.withName} 个 (${pct(stat.files - stat.withName)}) ← ★ 正常现象，前端用时间+短id 显示 ✓`,
);
console.log(`\n【文件大小】`);
if (stat.sizes.length) {
    const q = (p) => stat.sizes[Math.floor(stat.sizes.length * p)] ?? 0;
    console.log(`  min ${stat.sizes[0]}B / 中位 ${q(0.5)}B / p90 ${q(0.9)}B / max ${stat.sizes[stat.sizes.length - 1]}B`);
}

const reasons = Object.keys(stat.problems);
if (reasons.length === 0) {
    console.log(`\n【异常文件】无 ✓`);
} else {
    console.log(`\n【★ 异常文件（会被前端标为错误且禁止切换 ✓）】`);
    for (const r of reasons) {
        console.log(`  ${r}: ${stat.problems[r].length} 个`);
        for (const n of stat.problems[r].slice(0, 3)) console.log(`      ${n}`);
        if (stat.problems[r].length > 3) console.log(`      …还有 ${stat.problems[r].length - 3} 个（见 JSON）`);
    }
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, "session-audit.json"), JSON.stringify(stat, null, 2));
console.log(`\n✓ 完整统计已导出: test_date/session-audit.json`);

#!/usr/bin/env node
/**
 * strip-marks —— 删掉所有装饰性符号（星星、勾、叉）
 *
 * 这些符号在注释里当强调用，但堆多了很吵。删掉时连同它占的空格一起收，
 * 免得留下"文字  文字"这种双空格。
 *
 * 规则按顺序：两侧带空格的先收成单空格，再处理尾随/前置，最后清干净。
 * 默认写盘，--dry 只统计。
 */
import { readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, extname, sep } from "node:path";

const ROOT = process.cwd();
const DRY = process.argv.includes("--dry");

const SKIP_DIRS = new Set([
    "node_modules",
    ".git",
    "dist",
    "out",
    ".pi-tours",
    ".punct-backup",
    "test_date",
    ".vscode",
    "svg",
]);

const EXTS = new Set([
    ".ts",
    ".tsx",
    ".js",
    ".mjs",
    ".cjs",
    ".json",
    ".css",
    ".html",
    ".md",
    ".sh",
    ".yml",
    ".yaml",
]);

/** 要删的符号。勾和叉连 emoji 版本一起算，它们是同一族 */
const MARKS = ["", "", "", "", "", "", "", "", ""];

function* walk(dir) {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        let st;
        try {
            st = statSync(full);
        } catch {
            continue;
        }
        if (st.isDirectory()) {
            if (SKIP_DIRS.has(name)) continue;
            yield* walk(full);
        } else if (st.isFile()) {
            if (!EXTS.has(extname(name))) continue;
            yield full;
        }
    }
}

function stripMarks(text) {
    let out = text;
    let n = 0;
    for (const m of MARKS) {
        const before = out.length;

        // 1) 两侧都有空格：整体收成一个空格
        out = out.replace(new RegExp(` ${m} `, "g"), " ");
        // 2) 符号 + 其后的一个空格
        out = out.replace(new RegExp(`${m} ?`, "g"), "");
        // 3) 符号前面残留的空格
        out = out.replace(new RegExp(` ${m}`, "g"), "");

        if (out.length !== before) n += 1;
    }
    // 删完可能留下行尾空白
    out = out.replace(/[ \t]+$/gm, "");
    return { out, changed: out !== text };
}

const changed = [];
let totalFiles = 0;

for (const file of walk(ROOT)) {
    totalFiles++;
    const rel = relative(ROOT, file).split(sep).join("/");
    if (rel.startsWith("media/out/")) continue;

    let text;
    try {
        text = readFileSync(file, "utf8");
    } catch {
        continue;
    }

    const { out, changed: hit } = stripMarks(text);
    if (!hit) continue;

    changed.push({ rel, file, out });
    if (!DRY) writeFileSync(file, out, "utf8");
}

console.log(`${DRY ? "（预演，未写盘）" : "（已写盘）"}`);
console.log(`扫描 ${totalFiles} 个文件，命中 ${changed.length} 个\n`);
for (const c of changed.slice(0, 15)) console.log(`  ${c.rel}`);
if (changed.length > 15) console.log(`  ...还有 ${changed.length - 15} 个`);

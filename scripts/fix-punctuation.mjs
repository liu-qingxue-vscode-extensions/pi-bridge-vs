#!/usr/bin/env node
/**
 * fix-punctuation —— 把源码里的中文标点换成对应的英文标点
 *
 * 遍历项目里的文本文件，逐字符替换。默认直接写盘，
 * 加 --dry 只统计不写，用来看影响范围。
 *
 * 跳过：依赖、构建产物、版本库、本地生成数据。
 */
import { readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, extname, sep } from "node:path";

const ROOT = process.cwd();
const DRY = process.argv.includes("--dry");

/** 这些目录里的东西不是我们写的（或者会被重新生成），别动 */
const SKIP_DIRS = new Set([
    "node_modules",
    ".git",
    "dist",
    "out",
    ".pi-tours",
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

/** 中文标点 → 英文标点。多字符的放前面，避免被单字符规则先吃掉 */
const MAP = [
    ["——", "-"],
    ["……", "..."],
    ["，", ","],
    ["。", "."],
    ["；", ";"],
    ["：", ":"],
    ["！", "!"],
    ["？", "?"],
    ["（", "("],
    ["）", ")"],
    ["【", "["],
    ["】", "]"],
    ["《", "<"],
    ["》", ">"],
    ["“", '"'],
    ["”", '"'],
    ["‘", "'"],
    ["’", "'"],
    ["、", ","],
    ["…", "..."],
    ["「", '"'],
    ["」", '"'],
    ["『", '"'],
    ["』", '"'],
    ["～", "~"],
    ["％", "%"],
    ["＃", "#"],
    ["＆", "&"],
    ["＠", "@"],
    ["　", " "],
];

function* walk(dir) {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        let st;
        try {
            st = statSync(full);
        } catch {
            continue; // 断掉的软链之类
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

function replaceAll(text) {
    let out = text;
    const counts = new Map();
    for (const [from, to] of MAP) {
        let n = 0;
        let idx = out.indexOf(from);
        while (idx !== -1) {
            n++;
            idx = out.indexOf(from, idx + from.length);
        }
        if (n > 0) {
            counts.set(from, n);
            out = out.split(from).join(to);
        }
    }
    return { out, counts };
}

const changed = [];
let totalFiles = 0;
let totalChars = 0;

for (const file of walk(ROOT)) {
    totalFiles++;
    const rel = relative(ROOT, file).split(sep).join("/");
    // media/out 是构建产物，虽然目录名不叫 out，但要单独挡掉
    if (rel.startsWith("media/out/")) continue;

    let text;
    try {
        text = readFileSync(file, "utf8");
    } catch {
        continue;
    }
    const { out, counts } = replaceAll(text);
    if (counts.size === 0) continue;

    const sum = [...counts.values()].reduce((a, b) => a + b, 0);
    totalChars += sum;
    changed.push({ rel, sum, counts, file, out });

    if (!DRY) writeFileSync(file, out, "utf8");
}

changed.sort((a, b) => b.sum - a.sum);

console.log(`${DRY ? "（预演，未写盘）" : "（已写盘）"}`);
console.log(`扫描 ${totalFiles} 个文件，命中 ${changed.length} 个，共替换 ${totalChars} 处\n`);
for (const c of changed.slice(0, 20)) {
    const detail = [...c.counts.entries()]
        .map(([k, v]) => `${k}×${v}`)
        .join(" ");
    console.log(`  ${String(c.sum).padStart(4)}  ${c.rel}`);
    console.log(`        ${detail}`);
}
if (changed.length > 20) console.log(`  ...还有 ${changed.length - 20} 个文件`);

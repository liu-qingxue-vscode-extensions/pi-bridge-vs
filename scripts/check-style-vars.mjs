#!/usr/bin/env node
/**
 * check-style-vars.mjs —— 检查「配置项 ↔ CSS 变量 ↔ 实际消费」这条链（B32 ✓）
 *
 * 【为什么需要它？】
 *   用户的质问：“最后检查一下，到底有没有用得上这些变量？
 *              这些变量到底有没有成功用上啊？”
 *
 * ★ 这条链有三个环节 ✗ 任何一处断掉都是"配置改了没反应"：
 *     ① package.json 里声明了配置项（用户在设置里能看见 ✓）
 *     ② style-config.ts 把它映射成 CSS 变量（--pi-xxx ✓）
 *     ③ media/css/*.css 里真的有人 var(--pi-xxx) 消费它 ✓
 *
 *   断在哪一环，症状都是"设置里改了没反应"✗ 但原因完全不同：
 *     断在 ② → 配置项是个摆设（读都没读 ✓）
 *     断在 ③ → 变量注入了但没人用（写了等于没写 ✓）
 *
 * ★★ 这个脚本就是用来定位"断点在哪一环"的 ✓
 *
 * 用法：node scripts/check-style-vars.mjs
 *   退出码 0 = 全通 ✓ 1 = 有断点 ✗
 */
import * as fs from "node:fs";
import * as path from "node:path";

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

// ── ① package.json：声明了哪些 pi-bridge.style.* 配置 ──
const pkg = JSON.parse(read("package.json"));
const declared = new Map(); // cfgKey 短名 → 组名
for (const g of pkg.contributes.configuration) {
    for (const k of Object.keys(g.properties ?? {})) {
        if (k.startsWith("pi-bridge.style.")) {
            declared.set(k.replace("pi-bridge.style.", ""), g.title);
        }
    }
}

// ── ② style-config.ts：把哪些配置映射成了哪些 CSS 变量 ──
const sc = read("src/view/style-config.ts");
const mappedByCfg = new Map(); // cfgKey 短名 → cssVar
const mappedByVar = new Map(); // cssVar → cfgKey 短名

// num("key", "--var", unit?) / raw("key", "--var")
for (const m of sc.matchAll(/\b(?:num|raw)\(\s*"([^"]+)"\s*,\s*"(--[^"]+)"/g)) {
    mappedByCfg.set(m[1], m[2]);
    mappedByVar.set(m[2], m[1]);
}
// vars["--var"] = cfg.get<...>("key", ...)
for (const m of sc.matchAll(/vars\[\s*"(--[^"]+)"\s*\]\s*=\s*cfg\.get<[^>]*>\(\s*"([^"]+)"/g)) {
    mappedByCfg.set(m[2], m[1]);
    mappedByVar.set(m[1], m[2]);
}

// ── ②b style-config.ts：它【读过】哪些配置键（不管怎么用 ✓）──
//   ★ 为什么要单独列？
//     有些配置不是直接 num()/raw() 映射的 ✗ 而是走了条件逻辑
//     例如 cmdRailShow → vars["--pi-cmd-rail-display"] = show ? "flex" : "none" ✓
//     ⇒ 只看“有没有出现 cfg.get<>("key")”最可靠 ✓
const readKeys = new Set([...sc.matchAll(/cfg\.get<[^>]*>\(\s*"([^"]+)"/g)].map((m) => m[1]));
// ★★ style-config.ts 里【提到过】的所有 --pi-* 变量
//   为什么需要？因为它会写 vars["--x"] = 条件 ? "a" : "b" ✗ 上面的 num/raw 正则揽不到 ✓
//   （例：--pi-cmd-rail-display / --pi-result-label ✓）
const scVars = new Set([...sc.matchAll(/"(--pi-[a-z0-9-]+)"/gi)].map((m) => m[1]));

// ── ③ CSS：哪些 --pi-* 变量真的被 var() 消费了 ──
const cssDir = path.join(root, "media/css");
const consumed = new Map(); // cssVar → 出现的文件集合
const cssDefined = new Set(); // ★ CSS 自己定义的（有默认值 → 不是孤儿 ✓）
for (const f of fs.readdirSync(cssDir).filter((x) => x.endsWith(".css"))) {
    const text = fs.readFileSync(path.join(cssDir, f), "utf8");
    // ★ 只统计 var(--pi-xxx) 的【消费】✗ 不算 `--pi-xxx: value` 的定义行 ✓
    for (const m of text.matchAll(/var\(\s*(--pi-[a-z0-9-]+)/gi)) {
        if (!consumed.has(m[1])) consumed.set(m[1], new Set());
        consumed.get(m[1]).add(f);
    }
    // ★ CSS 里的 `--pi-xxx: 值;` = 自带默认值 ✗ 不算孤儿 ✓
    for (const m of text.matchAll(/^\s*(--pi-[a-z0-9-]+)\s*:/gim)) cssDefined.add(m[1]);
}

// ── ④ JS 侧消费：有些变量是【JS 读】而不是 CSS 用 ──
//   例如 --pi-input-min-rows / --pi-centered-mode ✓
const webviewDir = path.join(root, "src/webview");
const jsConsumed = new Set();
for (const f of fs.readdirSync(webviewDir).filter((x) => x.endsWith(".ts"))) {
    const text = fs.readFileSync(path.join(webviewDir, f), "utf8");
    for (const m of text.matchAll(/["'](--pi-[a-z0-9-]+)["']/g)) jsConsumed.add(m[1]);
}

// ── 报告 ──
const problems = [];

// 断点 A：声明了配置 ✗ 但 style-config.ts 完全没读它
const notMapped = [...declared.keys()].filter((k) => !mappedByCfg.has(k) && !readKeys.has(k));
if (notMapped.length) {
    problems.push({
        title: "★ 断点 ②：配置项声明了，但 style-config.ts 完全没读它",
        hint: "症状：设置里改了完全没反应（配置项是个摆设 ✓）",
        items: notMapped.map((k) => `${k}  （组：${declared.get(k)}）`),
    });
}

// 断点 B：映射成了变量 ✗ 但 CSS 和 JS 都【没人消费】
const notConsumed = [...mappedByVar.keys()].filter(
    (v) => !consumed.has(v) && !jsConsumed.has(v) && !cssDefined.has(v),
);
if (notConsumed.length) {
    problems.push({
        title: "★ 断点 ③：CSS 变量注入了，但 CSS 和 JS 都没人用它",
        hint: "症状：设置里改了没反应（变量写进去了但没人用 ✓）",
        items: notConsumed.map((v) => `${v}  ← 配置 ${mappedByVar.get(v)}`),
    });
}

// 断点 C：CSS 消费了 ✗ 但既没人注入 ✗ CSS 里也没定义
const notMappedVars = [...consumed.keys()].filter(
    (v) => !mappedByVar.has(v) && !cssDefined.has(v) && !scVars.has(v),
);
if (notMappedVars.length) {
    problems.push({
        title: "★ 断点 C：CSS 消费了某个变量，但它既没被注入、CSS 里也没定义（拼错？）",
        hint: "可能是在 CSS 里写了 var(--pi-typo) ✗ 一直吃 fallback ✓",
        items: notMappedVars.map((v) => `${v}  （${[...consumed.get(v)].join(", ")}）`),
    });
}

// ── 输出 ──
console.log(`配置项（pi-bridge.style.*）：${declared.size} 个`);
console.log(`映射成 CSS 变量：${mappedByVar.size} 个`);
console.log(`style-config 里读过的键：${readKeys.size} 个`);
console.log(`CSS 里实际消费：${consumed.size} 个 · JS 侧消费：${jsConsumed.size} 个 · CSS 自带默认值：${cssDefined.size} 个`);
console.log("");

if (!problems.length) {
    console.log("✓ 三环全通：声明 → 映射 → 消费，没有断点");
    process.exit(0);
}

for (const p of problems) {
    console.log(`✗ ${p.title}`);
    console.log(`  ${p.hint}`);
    for (const it of p.items) console.log(`    · ${it}`);
    console.log("");
}
process.exit(1);

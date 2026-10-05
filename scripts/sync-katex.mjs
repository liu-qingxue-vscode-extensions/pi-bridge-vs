#!/usr/bin/env node
/**
 * sync-katex.mjs —— 把 KaTeX 的运行时资源同步到 media/（B29 P2）
 *
 * 【为什么要这一步？】
 *   KaTeX 的 CSS 在 node_modules 里 ✗ webview 加载不到 ✓
 *   而且它同时引用了 .ttf / .woff / .woff2 三种字体 ✗
 *     · ttf   = 给老浏览器（我们不需要 ✓）
 *     · woff  = 老一代（不需要 ✓）
 *     · woff2 = 现代浏览器（★ 只要这个 ✓ 296KB ✓）
 *
 * 【产出】
 *   media/out/katex.css      ← 字体路径改成只剩 woff2 ✓
 *   media/out/fonts/*.woff2  ← 20 个字重/字形 ✓
 *
 * 【为什么字体路径写 fonts/xxx 就对了？】
 *   media/out/katex.css 里写 `fonts/KaTeX_xxx.woff2` ✗
 *   → 相对它自己 = media/out/fonts/KaTeX_xxx.woff2 ✓ 正好 ✓
 *   ★ 所以 katex.css 必须放在 media/ 顶层 ✗ 不能放 media/css/ ✓
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const srcDir = path.join(root, "node_modules", "katex", "dist");
const outCss = path.join(root, "media", "out", "katex.css");
const outFonts = path.join(root, "media", "out", "fonts");

if (!fs.existsSync(srcDir)) {
    console.error("✗ 找不到 node_modules/katex/dist —— 先 npm install");
    process.exit(1);
}

// ★ 产物在 media/out/ ✗ 它可能被整个删掉（.gitignore 忽略的 ✓）→ 先建出来 ✓
fs.mkdirSync(path.dirname(outCss), { recursive: true });

// ── ① CSS：把 @font-face 的 src 裁剪成只有 woff2 ──
let css = fs.readFileSync(path.join(srcDir, "katex.min.css"), "utf8");
// 每个 @font-face 里的 src: url(a.ttf) format(...),url(a.woff) ...,url(a.woff2) ...
// → 只留最后那个 woff2 段（用逗号切，过滤掉带 ttf/woff 的片段）
css = css.replace(/src:([^;}]+)/g, (_m, body) => {
    const parts = String(body)
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.includes(".woff2"));
    return `src:${parts.join(",")}`;
});
fs.writeFileSync(outCss, css);
console.log(`✓ media/out/katex.css（${(css.length / 1024).toFixed(0)} KB）`);

// ── ② 字体：只复制 woff2 ──
fs.mkdirSync(outFonts, { recursive: true });
let n = 0;
let bytes = 0;
for (const f of fs.readdirSync(path.join(srcDir, "fonts"))) {
    if (!f.endsWith(".woff2")) continue;
    const buf = fs.readFileSync(path.join(srcDir, "fonts", f));
    fs.writeFileSync(path.join(outFonts, f), buf);
    bytes += buf.length;
    n++;
}
console.log(`✓ media/out/fonts/（${n} 个 woff2 ✗ ${(bytes / 1024).toFixed(0)} KB）`);

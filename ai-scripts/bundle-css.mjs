#!/usr/bin/env node
/**
 * bundle-css.mjs —— 把 media/<name>.css 的 @import 展开成单个文件（B32 ✓）
 *
 * 【为什么要这么做？】
 *   ★ B27 踩过的坑：VS Code 的 webview 是【真的浏览器】✗ 会缓存 CSS ✓
 *   主文件的 URI 拼了 `?v=<mtime>` ✗ 所以主文件永远是新的 ✓
 *
 *   ★★ 但它 @import 的【子文件】—— URL 是写在 CSS 里的 ✗
 *     CSS 里没法插版本号 ⇒ 子文件会被缓存 ✓
 *     ⇒ 症状：改了 cmdrail.css ✗ 重开面板样式纹丝不动 ✗
 *        而同时改的 chat.css（主文件）却是新的
 *        ⇒ 表现为"改了一半"✗ 极难排查 ✓✓✓
 *
 *   ★★★ 修法：构建期把 @import 全部展开 ✗ 只产出一个文件 ✓
 *     它只有【一个 URL】✗ 版本号一拼 ✗ 缓存彻底不再是问题 ✓
 *     附带好处：少 9 个 HTTP 请求 ✓
 *
 * 【保留 media/css/*.css 为源】
 *   展开是构建产物 ✗ 写进 media/out/（gitignore ✓）
 *   源文件仍然是分文件组织 ✗ 改起来清楚 ✓
 */
import * as fs from "node:fs";
import * as path from "node:path";

const mediaDir = path.join(process.cwd(), "media");
const outDir = path.join(mediaDir, "out");
const cssDir = path.join(mediaDir, "css");

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

/** 递归展开一个 CSS 文件的 @import */
function expand(file, seen = new Set()) {
    const abs = path.resolve(file);
    if (seen.has(abs)) {
        return `/* ⚠ 循环引用，已跳过：${path.basename(abs)} */\n`;
    }
    seen.add(abs);

    let text = fs.readFileSync(abs, "utf8");
    const dir = path.dirname(abs);

    // @import url("./css/x.css"); / @import "./css/x.css"; / @import url(x.css) screen;
    text = text.replace(
        /@import\s+(?:url\(\s*)?["']([^"')]+)["']\s*\)?\s*([^;]*);/g,
        (whole, rel, rest) => {
            const target = path.resolve(dir, rel);
            if (!fs.existsSync(target)) {
                console.warn(`  ⚠ 找不到 @import 目标：${rel}（保留原样）`);
                return whole;
            }
            // ★ 带媒体查询的 @import 不展开（罕见 ✗ 保留给浏览器处理 ✓）
            if (rest && rest.trim()) return whole;
            return (
                `/* ══ 展开自 ${rel} ══ */\n` + expand(target, seen)
            );
        },
    );
    return text;
}

let count = 0;
for (const f of fs.readdirSync(mediaDir).filter((x) => x.endsWith(".css"))) {
    const base = f.replace(/\.css$/, "");
    const src = path.join(mediaDir, f);
    const out = path.join(outDir, `${base}.bundle.css`);
    const built = expand(src);
    // ★★ B32：构建期就查“括号平衡”✗ 这个坑太隐蔽了
    //
    // 【血的教训】
    //   media/css/base.css 曾经少了一个 `}` ✗
    //   后果：后面【所有】CSS 都被当成 :root 的嵌套规则 ✓
    //   ⇒ document.styleSheets 顶层只剩 1 条规则 ✗
    //   ⇒ 部分选择器变成 `:root #messages` 仍然匹配 ✗
    //     ⇒ 有些样式歪打正着还能用 ✗ 有些完全失效
    //     ⇒ 表现就是“看起来只改了一半”✗ 极难排查 ✓
    //   浏览器【不报错】（CSS 容错解析 ✓）⇒ 只能自己查 ✓
    const issue = braceBalance(built);
    if (issue) {
        console.error(`✗ ${f}：${issue}`);
        process.exitCode = 1;
    }
    fs.writeFileSync(out, built, "utf8");
    const kb = (Buffer.byteLength(built) / 1024).toFixed(1);
    console.log(`  media/out/${base}.bundle.css  ${kb}kb`);
    count++;
}

/** 检查大括号 / 注释是否平衡（引号内的不算 ✗ 这里仅做粗筛 ✓）*/
function braceBalance(text) {
    let depth = 0;
    let inComment = false;
    let inStr = null;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inComment) {
            if (c === "*" && text[i + 1] === "/") {
                inComment = false;
                i++;
            }
            continue;
        }
        if (inStr) {
            if (c === "\\") i++;
            else if (c === inStr) inStr = null;
            continue;
        }
        if (c === "/" && text[i + 1] === "*") {
            inComment = true;
            i++;
            continue;
        }
        if (c === '"' || c === "'") {
            inStr = c;
            continue;
        }
        if (c === "{") depth++;
        else if (c === "}") {
            depth--;
            if (depth < 0) return "多了一个 `}`（提前闭合 ✓）";
        }
    }
    if (inComment) return "有未闭合的 /* 注释 ✓";
    if (depth > 0) return `少了 ${depth} 个 \`}\`（后果：后面所有规则会被嵌套进上一层 ✗ 大量样式失效 ✓）`;
    return null;
}
console.log(`✓ 打包 ${count} 个 CSS（@import 已展开 → 版本号能作用到全部内容 ✓）`);

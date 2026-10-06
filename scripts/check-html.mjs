// ★ 注意：本文件里【绝不要】直接写字面的 HTML 注释标记 ✗
//   （JS 模块不允许 ✓ 我自己就踩了一次 ✓）
//   → 用拼接构造 ✓
const C_OPEN = "<" + "!--";
const C_CLOSE = "--" + ">";

/**
 * check-html.mjs —— HTML 静态检查（B25）
 *
 * 【为什么需要它？】
 *   B25 踩到的：把 HTML 注释写成了 CSS 形式 ✗ → 注释没闭合 →
 *   后面的 button 全被吞掉 ✗ → 表现成“找不到 DOM 元素”✓
 *   ★ 这类“语法写错”【不该靠人肉发现】✗ 它不报错 ✗ 只是默默少渲染 ✓
 *
 * 【检查】① 注释配对 ② 注释里误用 CSS 风格结尾
 *        ③ 标签配对 ④ id 重复 ⑤ 未知模板占位符
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const mediaDir = path.join(here, "..", "media");

/** 允许的模板占位符（loader 会替换 ✓）*/
const ALLOWED_PLACEHOLDER = new Set([
    "nonce",
    "cspSource",
    "css",
    "js",
    "styleVars",
    "mermaidJs",
    // ★ B32：写到 <html> 上的开关类（居中/折叠 …）
    //   为什么要在【服务端】就写上？
    //     原来只由 JS 的 applyStyleVars 切 ✗ 而首屏不会调它 ⇒ 开关全失效 ✓
    "htmlClass",
]);

let failed = 0;
const fail = (file, msg) => {
    console.error(`✗ ${file}: ${msg}`);
    failed++;
};

/** 去掉注释后的内容（用于标签检查 ✓ 避免注释里的文字干扰）*/
function stripComments(s) {
    return s.replace(new RegExp(C_OPEN + "[\\s\\S]*?" + C_CLOSE, "g"), "");
}

function checkHtml(file) {
    const raw = fs.readFileSync(file, "utf8");
    const name = path.basename(file);

    // ① 注释配对
    const opens = raw.split(C_OPEN).length - 1;
    const closes = raw.split(C_CLOSE).length - 1;
    if (opens !== closes) {
        fail(name, `HTML 注释不配对：${opens} 个开头 vs ${closes} 个结尾 ★ 后面的内容会被吞掉`);
    }

    // ② 注释里误用 CSS 风格结尾
    const reComment = new RegExp(C_OPEN + "([\\s\\S]*?)" + C_CLOSE, "g");
    for (const m of raw.matchAll(reComment)) {
        if (m[1].includes("*/")) {
            fail(name, "注释里出现 CSS 风格的结尾 ✗（HTML 必须用标准结尾）");
            break;
        }
    }

    // ③ 标签配对
    const stripped = stripComments(raw);
    for (const tag of ["div", "button", "span", "textarea", "select", "label"]) {
        const o = (stripped.match(new RegExp(`<${tag}[\\s>]`, "g")) || []).length;
        const c = (stripped.match(new RegExp(`</${tag}>`, "g")) || []).length;
        if (o !== c) fail(name, `<${tag}> 不配对：开 ${o} vs 闭 ${c}`);
    }

    // ④ id 重复
    const ids = [...raw.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    const seen = new Set();
    const dup = new Set();
    for (const id of ids) {
        if (seen.has(id)) dup.add(id);
        seen.add(id);
    }
    if (dup.size) fail(name, `id 重复：${[...dup].join(", ")}`);

    // ⑤ 未知模板占位符
    for (const m of raw.matchAll(/\{\{(\w+)\}\}/g)) {
        if (!ALLOWED_PLACEHOLDER.has(m[1])) fail(name, `未知占位符 {{${m[1]}}}`);
    }

    console.log(`✓ ${name}：注释 ${opens} 对 · 标签平衡 · id ${ids.length} 个`);
}

const files = fs.readdirSync(mediaDir).filter((f) => f.endsWith(".html"));
for (const f of files) checkHtml(path.join(mediaDir, f));

if (failed) {
    console.error(`\n✗ HTML 检查失败 ${failed} 项`);
    process.exit(1);
}
console.log("✓ HTML 检查通过\n");

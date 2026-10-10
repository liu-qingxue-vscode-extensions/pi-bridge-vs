/**
 * marked-setup.ts —— marked 的配置（B29 P2 ✗ 从 markdown.ts 拆出来）
 *
 * 【★ 为什么要拆？】
 *   现在需要【两个】解析器 ✗：
 *     plain = 不带数学 ✓（流式中的尾块用它 ✓）
 *     rich  = 带 KaTeX ✓（已闭合的块 / 整段渲染用它 ✓）
 *
 *   ★ 为什么尾块不能带数学 ✗？
 *     流式时 $ 后面还在长 ✗ 每来一个字符都重新排版公式 → 卡 + 闪 ✓
 *     → 尾块先用纯文本 ✓ 等它闭合再用 rich 渲染一次 ✓✓✓
 *
 * 【为什么用 Marked 实例而不是全局 marked？】
 *   `marked.use()` 是【全局单例】✗ 一旦加了 katex ✗ 两个解析器就分不开了 ✓
 *   → 用 `new Marked()` ✗ 各自独立配置 ✓
 */
import { Marked } from "marked";
import markedFootnote from "marked-footnote";
import markedKatex from "marked-katex-extension";

const escapeHtml = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * ★★ HTML 白名单（B29 P1）
 *
 * 【为什么不再"全部转义"？】
 *   真实文档里 <u> / <kbd> / H<sub>2</sub>O 很常见 ✓ 全转义就白写了 ✓
 *
 * 【★ 用 DOM 解析而不是正则】
 *   正则解 HTML 不可靠 ✗（属性里带 > / 嵌套 / 注释 …）
 *   → 用 DOMParser 让它自己解 ✓
 *   → 白名单外的标签：整段【转成文字】✗（内容不丢 ✓）
 *   → 白名单内的：属性再过一道 ✓（干掉 onclick / style …）
 *   ★ 第二道防线：CSP 已禁 script ✓
 */
const ALLOWED_TAGS = new Set([
    "u", "kbd", "sub", "sup", "br", "wbr", "mark", "small", "abbr", "ins", "del",
    "b", "i", "em", "strong", "code", "span", "s", "q", "cite", "var", "samp",
    "details", "summary", "dl", "dt", "dd",
    "div", "p", "blockquote",
]);
const ALLOWED_ATTRS = new Set(["class", "title", "align"]);

function sanitizeHtml(raw: string): string {
    const doc = new DOMParser().parseFromString(`<body>${raw}</body>`, "text/html");
    const walk = (el: Element): void => {
        for (const child of [...el.children]) {
            if (!ALLOWED_TAGS.has(child.tagName.toLowerCase())) {
                child.replaceWith(document.createTextNode(child.outerHTML));
                continue;
            }
            for (const attr of [...child.attributes]) {
                if (!ALLOWED_ATTRS.has(attr.name.toLowerCase())) child.removeAttribute(attr.name);
            }
            walk(child);
        }
    };
    walk(doc.body);
    return doc.body.innerHTML;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ★ 三个行内扩展（==高亮== / ++插入++ / ^上标^）
 *
 * ★★ 坑（B29 实测 ✗）：start() 用的正则【不能带 ^】
 *   start(src) { return src.search(re) }   // re = /^==…/ ✗
 *   → search 里的 ^ 只匹配【整个字符串开头】✓
 *   → 标记不在开头时返回 -1 ✗ → 扩展根本不被调用 ✓
 *   ⇒ 段首的生效 ✗ 中间的不生效 ✓（用户就是这么发现的两张图矛盾 ✓）
 */
function inlineExt(name: string, re: RegExp, tag: string): any {
    const finder = new RegExp(re.source.replace(/^\^/, ""));
    return {
        name,
        level: "inline",
        start(src: string) {
            const i = src.search(finder);
            return i >= 0 ? i : undefined;
        },
        tokenizer(this: any, src: string) {
            const m = re.exec(src);
            if (!m) return undefined;
            return { type: name, raw: m[0], tokens: this.lexer.inlineTokens(m[1]) };
        },
        renderer(this: any, token: { tokens: unknown[] }) {
            return `<${tag}>${this.parser.parseInline(token.tokens)}</${tag}>`;
        },
    };
}

/**
 * ★★ 代码块：包一层框（B29 P0）
 *   ┌─ python ─────────── [复制] ─┐
 *   │ 代码……                        │
 *   └──────────────────────────────┘
 * · .code-actions = 按钮容器 ✗ 以后加"下载 / 折叠 / 行号"只改这里 ✓
 * ★ 这里【不做语法高亮】✗ 但保留 language-xxx 类 ✓（P3 接高亮用 ✓）
 */
function codeRenderer(token: { text: string; lang?: string; escaped?: boolean }): string {
    const lang = (token.lang ?? "").split(/\s+/)[0]; // "js title=x" → "js"
    const body = token.escaped ? token.text : escapeHtml(token.text);
    const label = lang || "text";

    // ★ mermaid 特殊：它是一个【可折叠】的图 ✗
    //   默认只显示图 ✓ 点按钮才看源码 ✓
    //   （用户要的：“加一个渲染按钮 ✗ 切换源码和渲染结果，默认渲染结果”✓）
    if (lang === "mermaid") {
        return (
            `<div class="code-block code-mermaid" data-mermaid-src="1">` +
            `<div class="code-head">` +
            `<span class="code-lang">mermaid</span>` +
            `<div class="code-actions">` +
            `<button class="code-btn" data-mermaid-toggle="1" title="切换源码 / 渲染结果">源码</button>` +
            `<button class="code-btn" data-copy-code="1" title="复制源码">复制</button>` +
            `</div>` +
            `</div>` +
            `<pre><code class="language-mermaid">${body}</code></pre>` +
            `</div>`
        );
    }

    return (
        `<div class="code-block">` +
        `<div class="code-head">` +
        `<span class="code-lang">${escapeHtml(label)}</span>` +
        `<div class="code-actions">` +
        `<button class="code-btn" data-copy-code="1" title="复制代码">复制</button>` +
        `</div>` +
        `</div>` +
        `<pre><code class="language-${escapeHtml(lang)}">${body}</code></pre>` +
        `</div>`
    );
}

/** 造一个解析器 ✓ @param withMath 要不要解析 $…$ 公式 ✓ */
export function buildParser(withMath: boolean): Marked {
    const m = new Marked();

    m.use({
        extensions: [
            inlineExt("hl", /^==(?!=)([\s\S]+?)==/, "mark"),
            inlineExt("ins", /^\+\+(?!\+)([\s\S]+?)\+\+/, "ins"),
            inlineExt("sup", /^\^(?!\^)([\s\S]+?)\^/, "sup"),
        ],
    });

    // ★ 脚注 ✓（引用块与定义块可能在【不同块】✗ 所以脚注模式要整段渲染 ✓）
    m.use(markedFootnote() as never);

    m.use({
        renderer: {
            html(token: { text?: string; block?: boolean }) {
                const safe = sanitizeHtml(token.text ?? "");
                return token.block ? `<div class="md-html">${safe}</div>` : safe;
            },
            code: codeRenderer as never,
        },
    });

    // ★ 表格：外面包一层滚动容器 ✗
    //   （直接在 table 上写 display:block 会让 thead/tbody 变成独立块 ✗ 表头会跟内容断开 ✓）
    m.use({
        hooks: {
            postprocess(html: string) {
                return String(html)
                    .replace(/<table>/g, '<div class="table-wrap"><table>')
                    .replace(/<\/table>/g, "</table></div>");
            },
        },
    });

    if (withMath) {
        // ★ throwOnError:false → 语法错时显示红字原文 ✗ 不炸整个渲染 ✓
        m.use(markedKatex({ throwOnError: false, nonStandard: true, output: "html" }) as never);
    }

    m.setOptions({ breaks: true, gfm: true, async: false });
    return m;
}

/** ★ 尾块用（流式中 ✗ 不渲染公式/图 ✓）*/
export const plainParser = buildParser(false);
/** ★ 闭合块 / 整段渲染用 ✓ */
export const richParser = buildParser(true);

export { escapeHtml };

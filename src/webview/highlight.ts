/**
 * highlight.ts —— 代码块语法高亮（B29 P3 ✓）
 *
 * 【★ 为什么用 shiki？】
 *   它就是 VS Code 编辑器里那个高亮引擎 ✗
 *   用的是同一份 TextMate 语法 + VS Code 主题 ✓
 *   ⇒ 高亮结果与 VS Code 【逐 token 一致】✓✓✓
 *
 * 【★ 为什么体积能从 9.7MB 压到 0.9MB？】（实测 ✗）
 *   ① createHighlighter（自动发现）会带上全套语言 + oniguruma wasm ✗ 9.7MB
 *      → 改用 createHighlighterCore ✗ 手动只 import 需要的 ✓
 *   ② wasm 正则引擎本身 ~1MB ✗
 *      → 改用 createJavaScriptRegexEngine ✗ 纯 JS ✓
 *        代价：极少数正则行为略有差异 ✗ 实际看不出来 ✓
 *   ③ 主题也只带两个（VS Code 自带 dark-plus / light-plus ✓）
 *
 * 【★ 为什么不做成"按需加载"？】（像 mermaid 那样 ✗）
 *   代码块太常见了 ✗ 几乎每条消息都有 ✓
 *   按需加载 = 每开一个面板都要多一次往返 ✓ 反而更慢 ✓
 *   → 直接进主包 ✓（本地文件 ✗ 加载很快 ✓）
 *
 * 【★ 主题怎么跟随？】
 *   VS Code 在 <body> 上打 vscode-dark / vscode-light 类 ✓
 *   → 用 dark-plus / light-plus 两个主题 ✗ 按类切换 ✓
 */
import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import darkPlus from "shiki/themes/dark-plus.mjs";
import lightPlus from "shiki/themes/light-plus.mjs";

import js from "shiki/langs/javascript.mjs";
import ts from "shiki/langs/typescript.mjs";
import py from "shiki/langs/python.mjs";
import rust from "shiki/langs/rust.mjs";
import go from "shiki/langs/go.mjs";
import bash from "shiki/langs/bash.mjs";
import json from "shiki/langs/json.mjs";
import yaml from "shiki/langs/yaml.mjs";
import html from "shiki/langs/html.mjs";
import css from "shiki/langs/css.mjs";
import markdown from "shiki/langs/markdown.mjs";
import sql from "shiki/langs/sql.mjs";
import shellscript from "shiki/langs/shellscript.mjs";
// ★ 系统语言（用户报的：C 没高亮 ✓）
import c from "shiki/langs/c.mjs";
import cpp from "shiki/langs/cpp.mjs";
import java from "shiki/langs/java.mjs";
import csharp from "shiki/langs/csharp.mjs";
import php from "shiki/langs/php.mjs";
import ruby from "shiki/langs/ruby.mjs";
import swift from "shiki/langs/swift.mjs";
import kotlin from "shiki/langs/kotlin.mjs";
import lua from "shiki/langs/lua.mjs";
import r from "shiki/langs/r.mjs";
import dart from "shiki/langs/dart.mjs";
import scala from "shiki/langs/scala.mjs";
import perl from "shiki/langs/perl.mjs";
// ★ 配置 / 工具类（很常见 ✓）
import toml from "shiki/langs/toml.mjs";
import ini from "shiki/langs/ini.mjs";
import xml from "shiki/langs/xml.mjs";
import docker from "shiki/langs/docker.mjs";
import diff from "shiki/langs/diff.mjs";
import make from "shiki/langs/make.mjs";
import powershell from "shiki/langs/powershell.mjs";

/** ★ 语言别名 → shiki 的 id（用户/模型写什么都尽量认 ✓）*/
const LANG_ALIAS: Record<string, string> = {
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    node: "javascript",
    ts: "typescript",
    tsx: "typescript",
    py: "python",
    python3: "python",
    rs: "rust",
    golang: "go",
    sh: "shellscript",
    zsh: "shellscript",
    shell: "shellscript",
    console: "shellscript",
    yml: "yaml",
    md: "markdown",
    htm: "html",
    vue: "html",
    svelte: "html",
    postgres: "sql",
    mysql: "sql",
    "c++": "cpp",
    cc: "cpp",
    hpp: "cpp",
    hxx: "cpp",
    h: "c",
    cs: "csharp",
    "c#": "csharp",
    kt: "kotlin",
    kts: "kotlin",
    rb: "ruby",
    rs2: "rust",
    dockerfile: "docker",
    containerfile: "docker",
    mk: "make",
    makefile: "make",
    cmake: "make",
    ps1: "powershell",
    pwsh: "powershell",
    cmd: "powershell",
    bat: "powershell",
    cfg: "ini",
    conf: "ini",
    properties: "ini",
    svg: "xml",
    xsl: "xml",
    rss: "xml",
    patch: "diff",
};

// ★ R / 语言本身名字短，别名表里不用再映射（"r" → "r" ✓）

/** ★ 注册了哪些（其余的不高亮 ✗ 保留原样 ✓）*/
const LANGS = [
    js, ts, py, rust, go, bash, json, yaml, html, css, markdown, sql, shellscript,
    c, cpp, java, csharp, php, ruby, swift, kotlin, lua, r, dart, scala, perl,
    toml, ini, xml, docker, diff, make, powershell,
];

let hlPromise: Promise<HighlighterCore | undefined> | undefined;

/**
 * ★★ 外部主题（B29 ✗ 由宿主从 VS Code 读来 ✓）
 *   结构就是 VS Code 主题 JSON = { name, type, colors, tokenColors } ✓
 *   shiki 直接能当 ThemeRegistration 用 ✓
 */
interface VsCodeTheme {
    name?: string;
    type?: string;
    colors?: Record<string, string>;
    tokenColors?: unknown[];
}
let vsTheme: VsCodeTheme | undefined;
/** ★ 主题变了就重建 highlighter ✗（主题是注册进去的 ✓）*/
let themeToken = "";

/** 宿主推来主题 ✓ 若变化 → 重建 ✓ */
export function applyTheme(payload: { theme?: unknown; name?: string; kind?: number }): void {
    const t = payload.theme as VsCodeTheme | undefined;
    const key = t ? `${payload.name ?? ""}:${JSON.stringify(t).length}` : "builtin";
    if (key === themeToken) return;
    themeToken = key;
    vsTheme = t;
    hlPromise = undefined; // ★ 丢弃旧的 ✗ 下次重建 ✓
}

/** ★ 取当前主题名（给 shiki 用 ✗ 没有就退回内置 ✓）*/
function themeName(): string {
    const isDarkMode = document.body.classList.contains("vscode-dark") ||
        document.body.classList.contains("vscode-high-contrast");
    if (vsTheme?.name) return vsTheme.name;
    return isDarkMode ? "dark-plus" : "light-plus";
}

/** ★ 懒初始化：只造一次 ✗ 之后复用 ✓ */
function getHighlighter(): Promise<HighlighterCore | undefined> {
    if (!hlPromise) {
        // ★ 主题列表：外部主题（如果有）+ 两个内置兜底 ✓
        const themes = vsTheme
            ? [vsTheme as never, darkPlus, lightPlus]
            : [darkPlus, lightPlus];
        hlPromise = createHighlighterCore({
            themes,
            langs: LANGS,
            engine: createJavaScriptRegexEngine(),
        }).catch(() => undefined); // ★ 高亮失败不能让正文消失 ✗ 退化成不高亮 ✓
    }
    return hlPromise;
}

/**
 * ★ 高亮一个已经存在的代码块（把 <code> 的 innerHTML 换掉 ✓）
 *
 * 【为什么不直接在 marked renderer 里做？】
 *   renderer 是【同步】的 ✗ 而 shiki 初始化是【异步】的 ✓
 *   → 只能"先出好 DOM ✗ 高亮好了再替换内层"✓
 */
export async function highlightBlock(block: HTMLElement): Promise<void> {
    const codeEl = block.querySelector("code");
    if (!codeEl) return;

    const rawLang = (block.querySelector(".code-lang")?.textContent ?? "").trim().toLowerCase();
    const lang = LANG_ALIAS[rawLang] ?? rawLang;
    const code = codeEl.textContent ?? "";
    if (!code.trim()) return;

    const hl = await getHighlighter();
    if (!hl) return;
    // ★ shiki 没注册这个语言 → 保留原样 ✓（不报错 ✓）
    if (!hl.getLoadedLanguages().includes(lang)) return;

    try {
        const html = hl.codeToHtml(code, { lang, theme: themeName() });
        // ★ shiki 输出的是完整的 <pre><code>…</code></pre>
        //   我们只要里面的东西 ✗ 所以解析出来取片段 ✓
        const doc = new DOMParser().parseFromString(html, "text/html");
        const inner = doc.querySelector("code");
        if (inner) {
            codeEl.innerHTML = inner.innerHTML;
            // ★★ 只抄【前景色】✗ 【不抄背景色】✓
            //
            //   用户实测报的：“你的背景色明显要深一点”✓
            //   根因：shiki 的 <pre> 自带 style="background:#1e1e1e;color:#d4d4d4"
            //     而这 #1e1e1e 是【Dark+ 主题的编辑器底色】
            //     → 与 VS Code 当前的 --vscode-editor-background 不一致 ✓
            //   → 只取 color ✗ 背景留给我们的 CSS（它用 VS Code 变量 ✓）
            const pre = doc.querySelector("pre");
            const color = pre?.style.color;
            if (color) codeEl.parentElement?.style.setProperty("color", color);
        }
    } catch {
        // ★ 静默：高亮失败就保持纯文本 ✓
    }
}

/**
 * tool.ts —— 工具气泡的全部渲染
 *
 * 【工具气泡的特殊结构（和别的气泡不同 ✗）】
 *   · 外框画出四条边 → 视觉上是【一个】气泡 ✓
 *   · 上半 .tool-call   = 调用参数（键值对 grid）
 *   · 下半 .tool-result = 结果（按 content 元素的 type 分发）
 *   · 结果可能【晚到】（来自另一条消息，用 callId 找回 ✓）
 *   · 执行中还会来流式输出（partialResult.content 是【累积全文】✗ 不是增量）
 */
import type { ToolBlockFields } from "../view/chat-types.js";
import { messagesEl } from "./dom.js";
import { ui } from "./state.js";
import { createHead, makeActions, scrollToBottom } from "./bubbles.js";
import { highlightShellInto, LANG_ALIAS } from "./highlight.js";
import { renderMarkdown, scheduleHighlight } from "./render-kit.js";
import { applyFold, planFold } from "./tool-fold.js";
import { LEVEL_COLOR, levelOf } from "./cmd-levels.js";
// ★ B41 新增：送去编辑器（fitCodeBlocks=代码缩放 / showContextMenu=右键菜单 / log,vscode=发消息）
import { fitCodeBlocks } from "./code-fit.js";
import { showContextMenu } from "./context-menu.js";
import { log, vscode } from "./vscode-api.js";

/** ★ B41：把工具块送去编辑器的按钮文字（用户定的：不用图标 —— 图标的语义说不清）*/
const TEXT_OPEN = "编辑器";

/** 新建工具气泡（外框 + 上半调用 + 下半结果占位）
 *
 * ★ 与正文气泡同构：外面也包一层 wrapper（负责宽度/对齐/间距 ✓）
 *   现在【不加】动作区（用户定的：工具暂不做复制 ✓）
 *   以后要加按钮，直接往 wrapper 里追就行 ✓
 */
export function createToolBubble(callId: string, toolName?: string): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "bubble-wrap tool";

    const div = document.createElement("div");
    div.className = "bubble tool";
    div.dataset.callId = callId;
    // ★★ B38：记住工具名 ✗ 渲染时要按工具分派 ✓
    //   （目前只有 bash 走专用分支 ✗ 其余走通用键值对 ✓）
    div.dataset.tool = toolName ?? "";
    div.dataset.open = ui.defaultToolCollapsed ? "false" : "true";

    // 折叠头：左=工具名串 ✗ 右=操作区
    const head = createHead("🔧 " + (toolName || "tool"), () => toggleTool(div));

    // ★★ B41：把内容送去左边的编辑器区显示（按钮 + 右键两个入口）
    //   为什么做成【通用动作】而不是只服务 diff：将来任何工具块都该能"扔过去看"
    //   ⇒ 宿主侧按 toolName 分派（read/write→真文件 ✗ edit→diff 视图 ✗ 其余→虚拟文档）
    const open = (): void => {
        // ★ 前端这里 vscode 必须来自 vscode-api（曾经漏了 import ⇒ 点击静默失败）
        log.info(`★ 送去编辑器：callId=${callId} tool=${toolName || "?"}`);
        vscode.postMessage({ kind: "openInEditor", callId });
    };
    const actions = head.querySelector(".head-actions");
    if (actions) {
        const openBtn = document.createElement("button");
        openBtn.className = "head-action";
        openBtn.title = "在编辑器中打开";
        // ★ 用【文字】而不是图标：图标的语义说不清（跳转？外部打开？）
        //   「编辑器」直接告诉你"点它内容会去左侧编辑器区" ✓
        openBtn.textContent = TEXT_OPEN;
        openBtn.addEventListener("click", (e) => {
            e.stopPropagation(); // ★ 别把点击传给顶栏（否则顺手折叠了）
            open();
        });
        actions.appendChild(openBtn);
    }
    div.addEventListener("contextmenu", (e) => {
        showContextMenu(e, [
            { label: "在编辑器中打开", onClick: open },
            {
                label: "复制内容",
                onClick: () => {
                    const t = (div.querySelector(".tool-body") as HTMLElement | null)?.innerText ?? "";
                    void navigator.clipboard.writeText(t);
                },
            },
        ]);
    });

    // ★★ B38：整块点击 = 折叠/展开
    //   ① 点按钮（顶栏折叠钮 / 以后的 diff 钮）→ 不管
    //   ② 有选中文字 → 不管（要复制）
    //   ③ ★ 按下与松手位置差得远（>4px）= 在拖选 ✗ 不是点击
    //      （没这条的话：在空白处拖一下会因“没选到字”而被当成点击 → block 自己折了）
    let downX = 0;
    let downY = 0;
    div.addEventListener("mousedown", (e) => {
        downX = e.clientX;
        downY = e.clientY;
    });
    div.addEventListener("click", (e) => {
        const t = e.target as HTMLElement | null;
        if (t?.closest("button")) return;
        if (window.getSelection()?.toString()) return;
        if (Math.abs(e.clientX - downX) > 4 || Math.abs(e.clientY - downY) > 4) return;
        toggleTool(div);
    });

    // 内容体（可折叠）：上半调用参数 · 下半结果（结果可能晚到，用 callId 填回）
    const body = document.createElement("div");
    body.className = "tool-body";    const call = document.createElement("div");
    call.className = "tool-call";
    const args = document.createElement("div");
    args.className = "tool-args";
    call.appendChild(args);
    body.appendChild(call);

    // ★★ B38：摘要行（顶栏下面一行 ✗ 各渲染器自己填 ✗ 空则不占高度）
    //   bash → 命令主体（待做）· read/write → 路径
    const meta = document.createElement("div");
    meta.className = "tool-meta";
    div.appendChild(head);
    div.appendChild(meta);
    div.appendChild(body);
    wrap.appendChild(div);
    // ★ 动作区（用户实测报的：工具气泡也要有克隆/分叉 ✓）
    //   是不是“组尾”由 refreshForkButtons 事后判 ✓
    wrap.appendChild(makeActions(div));
    messagesEl.appendChild(wrap);
    ui.bubble = div;
    scrollToBottom();
    return div;
}

/**
 * 折叠 / 展开（顶栏按钮 + 整块点击共用）
 */
function toggleTool(bubble: HTMLElement): void {
    bubble.dataset.open = bubble.dataset.open === "true" ? "false" : "true";
    refold(bubble);
}

/**
 * ★★ B38：read / write → 路径进【摘要行】✗ 内容区只放内容
 * ★ write 的内容在【参数】里（不在结果里）→ 顺便画到结果区
 */
function renderPathLine(bubble: HTMLElement, args: unknown): void {
    const path = (args as { path?: unknown } | null)?.path;
    if (typeof path !== "string") return;
    bubble.dataset.path = path; // 结果区渲染要用

    setToolMeta(bubble, "📄 " + path);

    // 参数区不显示任何东西（路径已在摘要行）
    const call = bubble.querySelector(".tool-call") as HTMLElement | null;
    if (call) call.hidden = true;

    if (bubble.dataset.tool === "write") {
        const content = (args as { content?: unknown } | null)?.content;
        if (typeof content === "string") renderFileBody(bubble, content, false);
    }
    refold(bubble);
}

/** 写摘要行（字符串 或 一串元素 ✗ 空则不占高度）*/
export function setToolMeta(bubble: HTMLElement, content: string | HTMLElement[]): void {
    const el = bubble.querySelector(".tool-meta") as HTMLElement | null;
    if (!el) return;
    el.textContent = "";
    if (typeof content === "string") {
        el.textContent = content;
        if (content) el.title = content;
        return;
    }
    for (const c of content) el.appendChild(c);
}

/** 结果区渲染：read 用结果、write 用参数（已在 renderPathLine 里做完）*/
function renderFileResult(bubble: HTMLElement, parts: unknown[], isError: boolean): void {
    if (bubble.dataset.tool === "write" && !isError) return; // 已经画过了
    renderFileBody(bubble, textOf(parts), isError);
}

/** 建一个 code-block（行号从 startLine 开始编 ✗ 尾部片段要接真实行号）*/
function makeCodeBlock(text: string, lang: string, startLine: number): HTMLElement {
    const block = document.createElement("div");
    block.className = "code-block with-ln";
    if (startLine !== 1) block.style.setProperty("--ln-start", String(startLine - 1));
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.className = "language-" + lang;
    // ★ 空文本要用空格占位：否则 shiki 不生成 .line ⇒ 连行号都没有 ⇒ 一个空框
    code.textContent = text === "" ? " " : text;
    pre.appendChild(code);
    const label = document.createElement("span");
    label.className = "code-lang"; // 隐藏着 ✗ highlightBlock 靠它认语言
    label.textContent = lang;
    block.append(pre, label);
    return block;
}

/**
 * 可折叠的代码块（行级 ✗ 两版都高亮）
 * ★ 每次喂给 shiki 的都是【完整行】⇒ token 不会被切碎 ✓
 * ★ 尾部片段接真实行号（--ln-start）✓
 */
function buildFoldCode(bubble: HTMLElement, text: string, lang: string): HTMLElement {
    const body = text.replace(/\n$/, "");
    const lines = body.split("\n");
    const tool = bubble.dataset.tool ?? "";
    const plan = planFold(tool, lines.length, true, tool === "bash");

    const host = document.createElement("div");
    // ★ 注意：不带 .fold-unit ✗ 它自己管行级（带了两套折叠会打架：
    //   外层 applyFold 会把它整个藏掉 ✗ 内部的 peek 就白做了）
    host.className = "fold-code";

    // 不用裁 → 就一版
    if (plan.hidden === 0) {
        host.appendChild(makeCodeBlock(body, lang, 1));
        return host;
    }

    // 全文版
    const full = makeCodeBlock(body, lang, 1);
    full.classList.add("fold-full");
    host.appendChild(full);

    // 收起版：头 N 行 + 提示 + 尾 M 行
    const peek = document.createElement("div");
    peek.className = "fold-peek";
    if (plan.lineHead > 0) {
        peek.appendChild(makeCodeBlock(lines.slice(0, plan.lineHead).join("\n"), lang, 1));
    }
    const more = document.createElement("div");
    more.className = "peek-more";
    more.textContent = `…（已折叠 ${plan.hidden} 行 · 点顶栏展开）`;
    peek.appendChild(more);
    if (plan.lineTail > 0) {
        const start = lines.length - plan.lineTail + 1;
        peek.appendChild(makeCodeBlock(lines.slice(-plan.lineTail).join("\n"), lang, start));
    }
    host.appendChild(peek);
    return host;
}

/** 把一段文本按【文件扩展名】选渲染方式画进结果区 */
function renderFileBody(bubble: HTMLElement, text: string, isError: boolean): void {
    const host = ensureResultHost(bubble);
    host.classList.toggle("error", !!isError);
    const body = host.querySelector(".result-body") as HTMLElement;
    body.innerHTML = "";
    const filePath = isError ? "" : (bubble.dataset.path ?? "");

    // ① Markdown → 直接复用正文渲染器
    if (/\.(md|markdown|mdx)$/i.test(filePath)) {
        const el = document.createElement("div");
        el.className = "md-in-tool fold-unit";
        body.appendChild(el);
        renderMarkdown(el, text);
    } else {
        // ② 认得出语言 → 构造正文同款 code-block（scheduleHighlight 会自动上色）
        const lang = isError ? "" : langFromPath(filePath);
        if (lang) {
            body.appendChild(buildFoldCode(bubble, text, lang));
            scheduleHighlight();
        } else {
            // ③ 其他 / 出错 → 等宽纯文本
            body.appendChild(buildTextPart(text, bubble.dataset.tool ?? ""));
        }
    }
    refold(bubble);
    scrollToBottom();
}

/** 取 parts 里的第一段文本 */
function textOf(parts: unknown[]): string {
    for (const p of parts ?? []) {
        if ((p as { type?: string })?.type === "text") return (p as { text?: string }).text ?? "";
    }
    return "";
}

/** 路径 → shiki 语言 id（认不出就返回扩展名 ✗ 交给注册表兜底）*/
function langFromPath(p: string): string {
    const m = /\.([A-Za-z0-9]+)$/.exec(p);
    if (!m) return "";
    const ext = m[1].toLowerCase();
    return LANG_ALIAS[ext] ?? ext;
}

/**
 * ★★ B38：edit → 用 pi 给的 unified diff（details.patch）
 * ★ 数据里还有 details.diff（紧凑版）和 firstChangedLine ✗ 我们用 patch（有删除行 ✓）
 */
export function renderDiffDetails(bubble: HTMLElement, details: unknown): void {
    const patch = (details as { patch?: unknown } | null)?.patch;
    if (typeof patch !== "string" || !patch.trim()) return;

    const host = ensureResultHost(bubble);
    const body = host.querySelector(".result-body") as HTMLElement;
    body.textContent = "";

    const box = document.createElement("div");
    box.className = "diff-box";

    // 逐行解析：--- / +++ 文件头丢掉（路径已在摘要行）
    //   @@ -a,b +c,d @@  → hunk 头
    //   + / - / 空格      → 增 / 删 / 上下文（行号自己算 ✓）
    let hunk: HTMLElement | null = null;
    let newLine = 0;
    let oldLine = 0;

    for (const raw of patch.replace(/\n$/, "").split("\n")) {
        if (raw.startsWith("--- ") || raw.startsWith("+++ ")) continue; // 文件头 ✗ 不要

        const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
        if (m) {
            oldLine = Number(m[1]);
            newLine = Number(m[2]);
            hunk = document.createElement("div");
            hunk.className = "diff-hunk fold-unit";
            const head = document.createElement("div");
            head.className = "diff-hunk-head";
            head.textContent = raw;
            hunk.appendChild(head);
            box.appendChild(hunk);
            continue;
        }

        const kind = raw.startsWith("+") ? "add" : raw.startsWith("-") ? "del" : "ctx";
        const line = document.createElement("div");
        line.className = "diff-line " + kind;
        const ln = document.createElement("span");
        ln.className = "diff-ln";
        if (kind === "add") {
            ln.textContent = String(newLine++);
        } else if (kind === "del") {
            ln.textContent = String(oldLine++);
        } else {
            ln.textContent = String(newLine++);
            oldLine++;
        }
        const lc = document.createElement("span");
        lc.className = "diff-lc";
        lc.textContent = raw;
        line.append(ln, lc);
        (hunk ?? box).appendChild(line);
    }

    body.appendChild(box);
    bubble.dataset.hasDiff = "1"; // 让后面的 toolResult 不要覆盖它
    refold(bubble);
    scrollToBottom();
}

/**
 * 按折叠规则重画内容区（每次渲染后调 ✗ 幂等）
 * ★ .fold-unit = 固定单元（命令行 / 参数行）✗ .part-text 自己管行级裁剪
 */
function refold(bubble: HTMLElement): void {
    const collapsed = bubble.dataset.open !== "true";
    const body = (bubble.querySelector(".tool-body") as HTMLElement | null) ?? bubble;
    body.classList.toggle("fold-collapsed", collapsed);
    applyFold(body, bubble.dataset.tool ?? "", collapsed);
    // ★ B41：代码块过宽就缩字号（★ 收起版和展开版都要量 ✗ 两者的宽度不同）
    fitCodeBlocks(body);
}

/** 工具状态：转圈（running）/ 勾（ok）/ 叉（error） */
export function setToolState(bubble: HTMLElement, state: string): void {
    let el = bubble.querySelector(".tool-state") as HTMLElement | null;
    if (!el) {
        el = document.createElement("span");
        el.className = "tool-state";
        const toggle = bubble.querySelector(".head-toggle");
        if (toggle) toggle.appendChild(el);
    }
    el.className = "tool-state " + state;
    el.textContent = state === "running" ? "" : state === "error" ? "✗" : "✓";
}

/**
 * 参数 → 键值对列表（通用渲染）
 * 用 grid 布局：多行值的续行会自动对齐到第二列 ✓
 * （比一坨原始 JSON 字符串好读得多）
 */
export function renderArgs(bubble: HTMLElement, args: unknown): void {
    // ★★ B38：bash → 画成【终端命令行】（★ 不走通用键值对 ✓）
    //   实测依据：bash 的参数【只有一个 command】
    //     {"command": "ls --color=always -la …"} ✓
    //   ⇒ 走通用 grid 会渲染成 `command │ ls …` ✗ 一点都不像终端 ✓
    if (bubble.dataset.tool === "bash") {
        renderBashCall(bubble, args);
        return;
    }
    // ★★ B38：read / write / edit → 参数区就是一张【路径行】（不是键值对）
    if (
        bubble.dataset.tool === "read" ||
        bubble.dataset.tool === "write" ||
        bubble.dataset.tool === "edit"
    ) {
        renderPathLine(bubble, args);
        return;
    }

    const host = bubble.querySelector(".tool-args") as HTMLElement | null;
    if (!host) return;
    host.innerHTML = "";
    if (args === undefined || args === null) return;
    if (typeof args !== "object" || Array.isArray(args)) {
        host.textContent = JSON.stringify(args, null, 2);
        return;
    }
    const entries = Object.entries(args as Record<string, unknown>);
    if (!entries.length) {
        host.textContent = "（无参数）";
        return;
    }
    for (const [k, v] of entries) {
        const row = document.createElement("div");
        row.className = "arg-row fold-unit"; // 每个参数 = 一个折叠单元

        // ★ B38：不再做每行的折叠箭头 ✗ 折叠统一交给顶栏（用户定的）
        const key = document.createElement("span");
        key.className = "arg-key";
        key.textContent = k;

        const val = document.createElement("span");
        val.className = "arg-val";
        val.textContent = typeof v === "string" ? v : JSON.stringify(v, null, 2);

        row.append(key, val);
        host.appendChild(row);
    }
    refold(bubble);
}

/**
 * ★★ B38：bash → 终端命令行（不走通用键值对）
 *   实测：bash 参数只有一个 command ✗ 通用 grid 会画成 `command │ ls -la`
 * ★ 提示符的目录用【前端记的当前 cwd】✗ 数据包里没有 cwd
 *   后果：切会话 / 改目录后，往上翻旧气泡的提示符是"现在的目录"
 */
function renderBashCall(bubble: HTMLElement, args: unknown): void {
    const host = bubble.querySelector(".tool-args") as HTMLElement | null;
    if (!host) return;
    host.innerHTML = "";

    const cmd = (args as { command?: unknown } | null)?.command;
    if (typeof cmd !== "string") {
        // 兜底：形状不对就退回纯 JSON
        host.textContent = JSON.stringify(args ?? null, null, 2);
        return;
    }

    // 命令行 = 一个折叠单元（提示符 + 命令同一行）
    const unit = document.createElement("div");
    unit.className = "fold-unit";
    const line = document.createElement("div");
    line.className = "term-line";
    const prompt = document.createElement("span");
    prompt.className = "term-prompt";
    prompt.textContent = (ui.cwdShort || "~") + " ❯";
    const code = document.createElement("span");
    code.className = "term-cmd";
    code.textContent = cmd;
    line.append(prompt, code);
    unit.appendChild(line);
    host.appendChild(unit);

    void highlightShellInto(code, cmd); // 异步上色，失败保持纯文本
    // ★★ B38：摘要行的命令主体由【宿主】解析后推来（见 showCmdChips）
    refold(bubble);
}

/**
 * 填摘要行：命令主体（等级色 + emoji）
 * ★ 命令数组由宿主用 bash-parser 解析好推来 ✗ 前端不碰语法
 */
export function showCmdChips(bubble: HTMLElement, commands: string[]): void {
    if (!commands.length) return;
    setToolMeta(
        bubble,
        commands.map((name) => {
            const { level, emoji } = levelOf(name);
            const span = document.createElement("span");
            span.className = "cmd-chip";
            span.style.color = LEVEL_COLOR[level];
            span.textContent = `${emoji} ${name}`;
            span.title = `${name}（${level}）`;
            return span;
        }),
    );
}

/** 在工具气泡上【取得或创建】结果区（含可折叠头部） */
export function ensureResultHost(bubble: HTMLElement): HTMLElement {
    let host = bubble.querySelector(".tool-result") as HTMLElement | null;
    if (host) return host;
    host = document.createElement("div");
    host.className = "tool-result";

    // ★ B38：不再建"结果"折叠头 ✗ 折叠统一由顶栏控（见 refold）
    const body = document.createElement("div");
    body.className = "result-body";

    host.appendChild(body);
    // ★ 必须加进 .tool-body（直接加在 .bubble 上会跑到 padding 之外 ✗）
    (bubble.querySelector(".tool-body") || bubble).appendChild(host);
    return host;
}

/**
 * 结果 → 按 content 元素的 type 分发渲染（通用，不丢字段）
 * · text  → 等宽文本（保留换行）
 * · image → <img data:...>
 * · 其他  → 原始 JSON 兜底
 *
 * streaming=true 时用于【执行中】的实时输出（累积全文 → 每次整块替换 ✓）
 */
export function renderResultParts(
    bubble: HTMLElement,
    parts: unknown[],
    isError: boolean,
    streaming?: boolean,
): void {
    // ★★ B38：read / write 走专用渲染（按扩展名选 Markdown / 代码高亮 / 纯文本）
    const tool = bubble.dataset.tool ?? "";
    if (tool === "read" || tool === "write") {
        renderFileResult(bubble, parts, !!isError);
        return;
    }
    // ★★ B38：edit 的 diff 在 details 里（toolExecEnd 时渲染）
    //   它的 content 只是一句 "Successfully replaced…" → 不要覆盖 diff
    if (tool === "edit" && bubble.dataset.hasDiff) return;

    const host = ensureResultHost(bubble);
    host.classList.toggle("error", !!isError && !streaming);
    const body = host.querySelector(".result-body") as HTMLElement;
    body.innerHTML = "";    for (const p of parts || []) {
        const t = (p as { type?: string } | null)?.type;
        if (t === "text") {
            body.appendChild(buildTextPart((p as { text?: string }).text ?? "", bubble.dataset.tool ?? ""));
        } else if (t === "image") {
            const img = document.createElement("img");
            img.className = "part-image";
            img.alt = "图像输出";
            const mime = (p as { mimeType?: string }).mimeType || "image/png";
            const data = (p as { data?: unknown }).data;
            if (typeof data === "string") img.src = "data:" + mime + ";base64," + data;
            body.appendChild(img);
        } else {
            const pre = document.createElement("pre");
            pre.className = "part-unknown";
            pre.textContent = JSON.stringify(p, null, 2);
            body.appendChild(pre);
        }
    }
    // 决定这个结果区“有精简版”（CSS 靠 .part-text[data-peek] 判断 ✓）
    //   ★ B38：不再往 .tool-result 上写 dataset.peek ✗ 没人读了

    // 流式中还没输出（第 1 个 update 是空的）→ 留空，不要显示"（无输出）"✗
    if (!body.childElementCount) body.textContent = streaming ? "" : "（无输出）";
    refold(bubble);
    scrollToBottom();
}

/**
 * ★★★ B39：工具气泡的【数据】—— 前端唯一的权威状态
 *   以前这些字段散在 DOM 的 dataset 和几条渲染路径里 ✗ 没有一份权威数据
 *
 * ★ B40：字段本体【Pick 自共享定义 ToolBlockFields】✗ 不再手写
 *   ⇒ 宿主改了字段名/加了字段 ⇒ 这里自动跟着变（对不上就编译错误）
 *   ⚠️ 命名也统一了：用宿主的 resultIsError（原先前端自己叫 isError ✗ 那种翻译是漏字段的温床）
 */
export type ToolData = Pick<
    ToolBlockFields,
    "args" | "resultParts" | "resultIsError" | "details" | "partialParts" | "executing"
> & {
    /** bash 的命令主体（宿主用 bash-parser 解析后推来 ✗ 不在共享字段里）*/
    commands?: string[];
};

/**
 * ★★ B40 守门员：快照路径专用的【必填】形状
 *
 * 每个字段都必须显式写出来（值可以是 undefined ✗ 但键不能少）
 *   ⇒ 少写一个字段就是【编译错误】
 * ★ 为什么需要它：B39 时代 replaySnapshot 漏传 details ⇒ edit 的 diff 画不出来
 *   而 `Partial<ToolData>` 让漏字段【合法地溜过编译】✗ 靠人肉对齐是不可靠的 ✓
 *
 * ⚠️ 手写而不是用映射类型：`[K in keyof T]-?` 会把 undefined 也一并去掉 ✗
 *   （实测过 ⇒ 传 undefined 反而报错 ✓ 那个方向反了）
 */
export interface ToolSnapshotData {
    args: unknown;
    resultParts: unknown[] | undefined;
    partialParts: unknown[] | undefined;
    resultIsError: boolean | undefined;
    executing: boolean | undefined;
    details: unknown;
    commands: string[] | undefined;
}

/**
 * ★ 编译期守门：ToolData 和 ToolSnapshotData 的【键必须完全一致】
 *   ⇒ 以后给 ToolData 加字段却忘了同步这里 ⇒ 编译错误（而不是运行时才发现）
 */
type KeyMismatch<A, B> = [keyof A] extends [keyof B]
    ? [keyof B] extends [keyof A]
        ? never
        : keyof B
    : keyof A;
/** 若两者键不一致，这里会变成具体缺的键名（true 赋值失败 ⇒ 编译报错）*/
const _keysInSync: KeyMismatch<ToolData, ToolSnapshotData> extends never ? true : false = true;
void _keysInSync;

/** 气泡 → 数据（弱引用：气泡销毁自动回收）*/
const toolDataMap = new WeakMap<HTMLElement, ToolData>();

/** 取一个气泡当前的数据（调试用）*/
export function getToolData(bubble: HTMLElement): ToolData | undefined {
    return toolDataMap.get(bubble);
}

/**
 * ★★★ B39：工具气泡的【唯一】填充入口
 *
 * 为什么要有它：以前【实时 patch 流】和【snapshot 全量重放】各写了一套填充逻辑
 *   ⇒ 每加一个特性都要写两遍 ✗ 且总有一条会漏
 *     （cmdCache 漏了 snapshot ⇒ 改配置后摘要行消失；details 同理）
 * 现在两条路都调这里 ⇒ 不可能再漏
 *
 * ★ 内部各渲染函数都是幂等的（先清空再填）✗ 所以可以随便重复调 ✓
 * ★ undefined 的字段会被忽略 ✗ 不会清掉已有的值
 *   （snapshot 里 resultParts 为 undefined 不代表要抹掉流式内容）
 */
export function fillToolBubble(bubble: HTMLElement, patch: ToolData): void {
    const data: ToolData = { ...toolDataMap.get(bubble) };
    for (const [k, v] of Object.entries(patch)) {
        if (v !== undefined) (data as Record<string, unknown>)[k] = v;
    }
    toolDataMap.set(bubble, data);

    // ── 顺序有讲究 ──
    // ① 摘要行（只要有就画 ✗ 与其它字段无关）
    if (data.commands) showCmdChips(bubble, data.commands);
    // ② 参数
    if (data.args !== undefined) renderArgs(bubble, data.args);
    // ③ 结果（最终结果优先于流式内容）
    const parts = data.resultParts ?? data.partialParts;
    if (parts !== undefined) {
        renderResultParts(bubble, parts, data.resultIsError === true, data.resultParts === undefined);
    }
    // ④ diff（必须在 ③ 之后：它清掉 result-body 并打 hasDiff 标记挡住后续覆盖）
    if (data.details !== undefined) renderDiffDetails(bubble, data.details);
    // ⑤ 状态
    if (
        data.resultIsError !== undefined ||
        data.executing !== undefined ||
        data.resultParts !== undefined ||
        data.partialParts !== undefined
    ) {
        setToolState(bubble, data.resultIsError ? "error" : data.executing ? "running" : "ok");
    }
}

/**
 * ★★ B40：快照路径的入口（★ 唯一的区别是【类型必填】✗ 运行时完全一样）
 * 用它 ⇒ 漏字段编译不过 ✓ 用它就是"我要完整重建这个气泡"的声明
 */
export function fillToolBubbleSnapshot(bubble: HTMLElement, data: ToolSnapshotData): void {
    fillToolBubble(bubble, data);
}

/**
 * 建一个文本 part
 *
 * ★ B38 行级折叠：收起时只显示头 N 行 + 尾 M 行（规则由 toolFold 给）
 *   用【两份 DOM】而不是重新渲染 —— 切换时只是 CSS 切显示
 *   ★ 它不进 .fold-unit ✗ 自己管自己（见 applyFold 的注释）
 */
function buildTextPart(text: string, tool: string): HTMLElement {
    const el = document.createElement("div");
    el.className = "part-text";

    // ★ 去掉【末尾那一个换行】—— 否则 split 会多出一个空元素
    //   ⇒ 尾 3 行实际只显示 2 行（用户实测报的）
    const lines = text.replace(/\n$/, "").split("\n");
    const plan = planFold(tool, lines.length, true, tool === "bash");

    // 不需要裁（行数不够 / 规则是 all）→ 就一份全文
    if (plan.hidden === 0) {
        el.textContent = text;
        return el;
    }

    // ── 全文（展开时用）──
    const full = document.createElement("div");
    full.className = "part-full";
    full.textContent = text;

    // ── 精简版（收起时用）：头 + 提示 + 尾 ──
    const peek = document.createElement("div");
    peek.className = "part-peek";
    if (plan.lineHead > 0) {
        const h = document.createElement("div");
        h.textContent = lines.slice(0, plan.lineHead).join("\n");
        peek.appendChild(h);
    }
    const more = document.createElement("div");
    more.className = "peek-more";
    more.textContent = `…（已折叠 ${plan.hidden} 行 · 点顶栏展开）`;
    peek.appendChild(more);
    if (plan.lineTail > 0) {
        const t = document.createElement("div");
        t.textContent = lines.slice(-plan.lineTail).join("\n");
        peek.appendChild(t);
    }

    el.dataset.peek = "true"; // CSS 靠它决定“收起时显示 peek”
    el.append(full, peek);
    return el;
}

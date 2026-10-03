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
import { messagesEl } from "./dom.js";
import { ui } from "./state.js";
import { CARET_SVG, createHead, makeActions, scrollToBottom } from "./bubbles.js";

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
    div.dataset.open = ui.defaultToolCollapsed ? "false" : "true";

    // 折叠头：左=工具名串（按钮）· 右=操作区（未来放复制等）
    const head = createHead("🔧 " + (toolName || "tool"), () => {
        div.dataset.open = div.dataset.open === "true" ? "false" : "true";
    });

    // 内容体（可折叠）：上半调用参数 · 下半结果（结果可能晚到，用 callId 填回）
    const body = document.createElement("div");
    body.className = "tool-body";
    const call = document.createElement("div");
    call.className = "tool-call";
    const args = document.createElement("div");
    args.className = "tool-args";
    call.appendChild(args);
    body.appendChild(call);

    div.appendChild(head);
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

/** 结束"执行中…"状态（头部标签恢复成"结果"） */
export function markStreamingDone(bubble: HTMLElement): void {
    const host = bubble.querySelector(".tool-result") as HTMLElement | null;
    if (host) host.dataset.streaming = "false";
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
        row.className = "arg-row";
        row.dataset.open = "true";

        // ★ 箭头 + 参数名 = 一个按钮（点它收起该参数 → 只显示第一行）
        const toggle = document.createElement("button");
        toggle.className = "arg-toggle";
        toggle.insertAdjacentHTML("beforeend", CARET_SVG);
        const key = document.createElement("span");
        key.className = "arg-key";
        key.textContent = k;
        toggle.appendChild(key);
        toggle.addEventListener("click", () => {
            row.dataset.open = row.dataset.open === "true" ? "false" : "true";
        });

        const val = document.createElement("span");
        val.className = "arg-val";
        val.textContent = typeof v === "string" ? v : JSON.stringify(v, null, 2);

        row.appendChild(toggle);
        row.appendChild(val);
        host.appendChild(row);
    }
}

/** 在工具气泡上【取得或创建】结果区（含可折叠头部） */
export function ensureResultHost(bubble: HTMLElement): HTMLElement {
    let host = bubble.querySelector(".tool-result") as HTMLElement | null;
    if (host) return host;
    host = document.createElement("div");
    host.className = "tool-result";
    host.dataset.open = "true";

    // 可折叠头部（箭头 + 标签，标签文字由 CSS 变量控制）
    const head = document.createElement("button");
    head.className = "result-toggle";
    head.insertAdjacentHTML("beforeend", CARET_SVG);
    head.insertAdjacentHTML("beforeend", '<span class="result-label"></span>');
    head.addEventListener("click", () => {
        host!.dataset.open = host!.dataset.open === "true" ? "false" : "true";
    });

    // 内容体
    const body = document.createElement("div");
    body.className = "result-body";

    host.appendChild(head);
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
    const host = ensureResultHost(bubble);
    host.classList.toggle("error", !!isError && !streaming);
    const body = host.querySelector(".result-body") as HTMLElement;
    body.innerHTML = "";
    for (const p of parts || []) {
        const t = (p as { type?: string } | null)?.type;
        if (t === "text") {
            body.appendChild(buildTextPart((p as { text?: string }).text ?? ""));
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
    // 决定这个结果区“收起时能不能露几行”
    //   ★ 只要【有一个 part 建了精简版】就标记上 → CSS 靠它决定收起时是否显示 ✓
    host.dataset.peek = body.querySelector('.part-text[data-peek="true"]') ? "true" : "false";

    // 流式中还没输出（第 1 个 update 是空的）→ 留空，不要显示"（无输出）"✗
    if (!body.childElementCount) body.textContent = streaming ? "" : "（无输出）";
    scrollToBottom();
}

/**
 * ★ 建一个文本 part
 *
 * 【为什么要建“两份 DOM”？】
 *   配置了 toolPeekLines（如 "3:2"）时，收起状态要显示：
 *     开头 3 行 + （已折叠 N 行）+ 末尾 2 行
 *   而展开状态要显示【完整文本】。
 *   CSS 只能“裁掉”不能“把裁掉的中间补回来”✗
 *   → 存两份最简单 ✓（文本量不大，代价可忽）
 *
 * 【未配置 / 行数不够】→ 只存一份全文 ✓（与旧行为一致）
 */
function buildTextPart(text: string): HTMLElement {
    const el = document.createElement("div");
    el.className = "part-text";

    const peek = ui.toolPeek;
    const lines = text.split("\n");

    // 不启用精简（未配置，或行数不够折叠）→ 单一全文 ✓
    if (!peek || lines.length <= peek.head + peek.tail + 1) {
        el.textContent = text;
        return el;
    }

    // ── 全文（展开时用）──
    const full = document.createElement("div");
    full.className = "part-full";
    full.textContent = text;

    // ── 精简版（收起时用）：头 + 折叠提示 + 尾 ──
    const short = document.createElement("div");
    short.className = "part-peek";
    const hidden = lines.length - peek.head - peek.tail;

    // 头（可能是 0 行 → 不建这个节点 ✓）
    if (peek.head > 0) {
        const head = document.createElement("div");
        head.textContent = lines.slice(0, peek.head).join("\n");
        short.appendChild(head);
    }
    const more = document.createElement("div");
    more.className = "peek-more";
    more.textContent = `…（已折叠 ${hidden} 行）`;
    short.appendChild(more);
    // 尾
    if (peek.tail > 0) {
        const tail = document.createElement("div");
        tail.textContent = lines.slice(-peek.tail).join("\n");
        short.appendChild(tail);
    }

    el.dataset.peek = "true"; // ★ CSS 靠它判断“这个 part 有精简版” ✓
    el.append(full, short);
    return el;
}

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
import { ui } from "./state.js";
import { CARET_SVG, createHead, scrollToBottom } from "./bubbles.js";

/** 新建工具气泡（外框 + 上半调用 + 下半结果占位） */
export function createToolBubble(callId: string, toolName?: string): HTMLElement {
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
    document.getElementById("messages")!.appendChild(div);
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
            const el = document.createElement("div");
            el.className = "part-text";
            el.textContent = (p as { text?: string }).text ?? "";
            body.appendChild(el);
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
    // 流式中还没输出（第 1 个 update 是空的）→ 留空，不要显示"（无输出）"✗
    if (!body.childElementCount) body.textContent = streaming ? "" : "（无输出）";
    scrollToBottom();
}

/**
 * compact-bubble.ts —— ★★ B46：压缩气泡
 *
 * 【它是什么】
 *   会话文件里 type=compaction 事件的渲染形态 —— 代表"此时刻之前的所有对话
 *   已被压缩成这段摘要"（见 bridge/session-file.ts 的 applyCompaction ✓）
 *
 * 【为什么单独一个气泡类型】
 *   · 它不属于任何人（不是 user / assistant 的话 ✗ 也不是某个工具的结果）
 *   · 它必须【进 bubbles/snapshot】—— 它是历史的一部分 ✗ webview 重建后要还在 ✓
 *     （与 B22 那个 compaction_start 过程提示【不同】：那个只是"正在压缩…"✗ 重建即消失 ✓）
 *
 * 【折叠】
 *   照抄 thinking 的机制（dataset.open + CSS ✓）而不是 tool 的 applyFold：
 *   压缩气泡的折叠是"整体显示/隐藏"✗ 没有"折叠单元"的概念 ✓
 *
 * 【跳转才是核心】（用户原话）
 *   摘要动辄几万字符 ✗ 在气泡里读不舒服 ⇒ 一键送去编辑器（虚拟文档 .md ✗ 带语法高亮 ✓）
 */
import { messagesEl } from "./dom.js";
import { ui } from "./state.js";
import { createHead, makeActions, scrollToBottom } from "./bubbles.js";
import { appendMarkdown, finishMarkdown } from "./markdown.js";
import { showContextMenu } from "./context-menu.js";
import { vscode, log } from "./vscode-api.js";

/** 填给压缩气泡的数据 */
export interface CompactionData {
    summary: string;
    tokensBefore?: number;
    time?: string;
}

/** 数字加千分位（633357 → 633,357 ✗ 和 pi 官方导出模板的写法一致 ✓）*/
function fmtTokens(n: number): string {
    return n.toLocaleString("en-US");
}

/** 头部文案：已压缩（此前 ≈N tokens 的对话）*/
function headText(data: CompactionData): string {
    if (typeof data.tokensBefore === "number" && data.tokensBefore > 0) {
        return `🗜 已压缩（此前 ≈${fmtTokens(data.tokensBefore)} tokens 的对话）`;
    }
    return "🗜 已压缩（此前的对话）";
}

/**
 * 建压缩气泡（壳）
 * ★ 复用 thinking 那一套：wrapper + data-open + createHead ✓
 */
export function createCompactionBubble(compId: string, label?: string): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "bubble-wrap compaction";

    const div = document.createElement("div");
    div.className = "bubble compaction";
    div.dataset.compId = compId;
    // ★ 默认收起（压缩摘要通常很长 ✗ 先给一行结论 ✓）
    div.dataset.open = "false";

    const toggle = (): void => {
        div.dataset.open = div.dataset.open === "true" ? "false" : "true";
    };
    const head = createHead(label || "🗜 已压缩", toggle);
    head.querySelector(".head-label")?.classList.add("comp-label");

    // ★ 送去编辑器（跳转是核心功能 ✗ 所以顶栏给一个显式按钮 ✓）
    const open = (): void => {
        log.info(`★ 送去编辑器（压缩摘要）：compId=${compId}`);
        vscode.postMessage({ kind: "openCompaction", compId });
    };
    const actions = head.querySelector(".head-actions");
    if (actions) {
        const openBtn = document.createElement("button");
        openBtn.className = "head-action";
        openBtn.title = "在编辑器中打开完整摘要";
        openBtn.textContent = "编辑器";
        openBtn.addEventListener("click", (e) => {
            e.stopPropagation(); // ★ 别顺手把气泡折了
            open();
        });
        actions.appendChild(openBtn);
    }

    const body = document.createElement("div");
    body.className = "comp-body";

    div.appendChild(head);
    div.appendChild(body);
    wrap.appendChild(div);
    wrap.appendChild(makeActions(div));

    // 整块点击折叠（照抄 tool 的三条防护 ✓ 见 tool.ts 的注释）
    let downX = 0;
    let downY = 0;
    div.addEventListener("mousedown", (e) => {
        downX = e.clientX;
        downY = e.clientY;
    });
    div.addEventListener("click", (e) => {
        const t = e.target as HTMLElement | null;
        if (t?.closest("button") || t?.closest("a")) return;
        if (Math.abs(e.clientX - downX) > 4 || Math.abs(e.clientY - downY) > 4) return;
        if (!window.getSelection()?.isCollapsed) return;
        toggle();
    });

    div.addEventListener("contextmenu", (e) => {
        showContextMenu(e, [
            { label: "在编辑器中打开摘要", onClick: open },
            {
                label: "复制摘要",
                onClick: () => {
                    const t = body.innerText ?? "";
                    void navigator.clipboard.writeText(t);
                },
            },
        ]);
    });

    messagesEl.appendChild(wrap);
    scrollToBottom();
    ui.bubble = div;
    return div;
}

/**
 * 填内容（★ 唯一的填充入口 —— 实时路径与快照重放都走它）
 * 参照 B39 的 fillToolBubble：一条路写一遍就够了 ✗ 两条路必然漏 ✓
 */
export function fillCompactionBubble(bubble: HTMLElement, data: CompactionData): void {
    const label = bubble.querySelector(".comp-label");
    if (label) label.textContent = headText(data);

    const body = bubble.querySelector(".comp-body") as HTMLElement | null;
    if (!body) return;
    body.textContent = "";
    if (data.time) {
        const t = document.createElement("div");
        t.className = "comp-time";
        t.textContent = `压缩时间：${data.time}`;
        body.appendChild(t);
    }
    // ★ 摘要走 markdown（pi 官方导出模板只做了 escapeHtml ✗ 我们做得更好 ✓）
    appendMarkdown(body, data.summary);
    finishMarkdown(body);
}

/** 快照重放路径：先建后填（与实时路径共用 fillCompactionBubble ✓）*/
export function createCompactionBubbleSnapshot(compId: string, data: CompactionData): HTMLElement {
    const el = createCompactionBubble(compId, headText(data));
    fillCompactionBubble(el, data);
    return el;
}

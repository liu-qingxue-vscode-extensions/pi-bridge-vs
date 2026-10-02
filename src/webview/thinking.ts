/**
 * thinking.ts —— 思考气泡（thinking_start / thinking_end 驱动）
 *
 * 【它负责什么】
 *   · 建思考气泡（可折叠；默认是否收起由设置决定 ✓）
 *   · thinking_end 时把头部文案改成「已思考（用时 X 秒）」✓
 */
import { messagesEl } from "./dom.js";
import { ui } from "./state.js";
import { createHead, scrollToBottom } from "./bubbles.js";

/** 建思考气泡（可折叠：点头部切展开/收起） */
export function createThinkingBubble(label?: string): HTMLElement {
    const div = document.createElement("div");
    div.className = "bubble thinking";
    div.dataset.open = ui.defaultThinkCollapsed ? "false" : "true";

    const head = createHead(label || "正在思考…", () => {
        div.dataset.open = div.dataset.open === "true" ? "false" : "true";
    });
    head.querySelector(".head-label")!.classList.add("think-label");

    const body = document.createElement("div");
    body.className = "think-body";
    div.appendChild(head);
    div.appendChild(body);
    messagesEl.appendChild(div);
    scrollToBottom();
    ui.lastThinkBubble = div;
    return div;
}

/** 思考结束 → 把头部改成「已思考（用时 X 秒）」 */
export function markThinkDone(): void {
    if (!ui.lastThinkBubble) return;
    const sec = ui.thinkStartAt ? ((Date.now() - ui.thinkStartAt) / 1000).toFixed(1) : null;
    const label = ui.lastThinkBubble.querySelector(".think-label");
    if (label) label.textContent = sec ? `已思考（用时 ${sec} 秒）` : "已思考";
}

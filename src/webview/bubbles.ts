/**
 * bubbles.ts —— 气泡【基础层】：滚动、建气泡、折叠头、占位三点
 *
 * 【依赖方向】dom / state → 本文件 → thinking / segments / tool
 * （本文件【不】依赖 thinking/segments/tool ✗ —— 保证单向、无循环 ✓）
 */
import { messagesEl } from "./dom.js";
import { ui } from "./state.js";

/** 滚到底（★ 只在用户本来就在底部时才自动滚 ✓） */
export function scrollToBottom(): void {
    // 否则 AI 流式输出会强行把他拉回去（抖动，且无法往上翻历史）✗
    if (ui.autoScroll) messagesEl.scrollTop = messagesEl.scrollHeight;
}

/**
 * 自动滚开关：由用户滚动行为决定
 * （滚到底部 40px 内 → 视为"在看最新"，恢复自动滚 ✓）
 */
messagesEl.addEventListener("scroll", () => {
    ui.autoScroll =
        messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40;
});

/** 新建一个气泡并挂到消息区末尾 */
export function createBubble(kind: string): HTMLElement {
    const div = document.createElement("div");
    div.className = "bubble " + kind;
    messagesEl.appendChild(div);
    scrollToBottom();
    return div;
}

/** 静态箭头图标（SVG 尺寸可控、和文字同高 ✓） */
export const CARET_SVG =
    '<svg class="head-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
    ' stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M6 9l6 6 6-6"/></svg>';

/**
 * 通用折叠头：【左】名字串（整串是一个按钮，点击折叠）【右】操作区（未来放复制等按钮）
 * @param labelText 显示文字（用 textContent 写入 → 免疫注入）
 * @param onToggle 点击名字串时的动作
 */
export function createHead(labelText: string, onToggle: () => void): HTMLElement {
    const head = document.createElement("div");
    head.className = "head";

    const btn = document.createElement("button");
    btn.className = "head-toggle";
    const label = document.createElement("span");
    label.className = "head-label";
    label.textContent = labelText;
    btn.appendChild(label);
    btn.insertAdjacentHTML("beforeend", CARET_SVG); // 静态 SVG，安全
    btn.addEventListener("click", onToggle);

    const actions = document.createElement("span"); // ★ 未来的按钮位（现在空）
    actions.className = "head-actions";

    head.appendChild(btn);
    head.appendChild(actions);
    return head;
}

// ===== 占位三点（发送后、首个数据包到达前）=====

export function showPending(): void {
    if (ui.pendingEl) return;
    const el = document.createElement("div");
    el.className = "bubble pending";
    el.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
    messagesEl.appendChild(el);
    ui.pendingEl = el;
    scrollToBottom();
}

export function removePending(): void {
    if (ui.pendingEl) {
        ui.pendingEl.remove();
        ui.pendingEl = null;
    }
}

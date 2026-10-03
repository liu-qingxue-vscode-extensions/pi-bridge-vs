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

/**
 * 新建一个气泡并挂到消息区末尾
 *
 * ★ 结构：wrapper（气泡 + 悬浮动作区）
 *   <div class="bubble-wrap text">
 *     <div class="bubble text">...内容...</div>       ← 宽度由它决定 ✓
 *     <div class="bubble-actions"><button>复制</button></div>
 *   </div>
 *
 * 【为什么包一层？】（用户提的架构问题 ✓）
 *   ① 按钮【不能塞进气泡里】✗ → 气泡有背景/边框/圆角，按钮会被包进去 ✓
 *   ② 按钮也【不能是另一个气泡】✗ → 它只是这条消息的一个动作 ✓
 *   ③ ★ 动作区【宽度 = 上面那个气泡的宽度】（用户明确要求 ✓）
 *        → wrapper 用横向 flex column + 动作区 width:100% → 自动跟随 ✓
 *   ④ ★ 动作区【在气泡区内占高】✓ 但【不侵入气泡间距】✗
 *        （间距是 wrapper 之间的 margin ✓ 动作区不在它里面 ✓）
 *
 * 【返回值】仍是【气泡本体】（调用方还在用它 textContent += 等 ✓）
 */
export function createBubble(kind: string): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "bubble-wrap " + kind;

    const div = document.createElement("div");
    div.className = "bubble " + kind;
    wrap.appendChild(div);

    // ★ 给【正文】和【用户】气泡加动作区
    //   （工具 / 思考暂不做 ✓ 用户定的 ✓）
    if (kind === "text" || kind === "user") {
        wrap.appendChild(makeActions(div));
    }

    messagesEl.appendChild(wrap);
    scrollToBottom();
    return div;
}

/**
 * ★ 建一个【悬浮动作容器】（现在只有“复制”✓ 未来往这里加按钮 ✓）
 *
 * 【样式】无边框无背景 → 看起来悬空 ✓
 * 【宽度】由 CSS 的 width:100% 跟随气泡 ✓
 * 【对齐】AI 左对齐 / 用户右对齐（CSS 控制 ✓）
 *
 * @param source 要复制内容的【元素】（直接读 textContent ✓ 总是最新 ✓）
 */
function makeActions(source: HTMLElement): HTMLElement {
    const box = document.createElement("div");
    box.className = "bubble-actions";

    const copy = document.createElement("button");
    copy.className = "bubble-action";
    copy.textContent = "复制";
    copy.title = "复制这条消息的文本";
    copy.addEventListener("click", () => {
        void navigator.clipboard.writeText(source.textContent ?? "").then(
            () => {
                copy.textContent = "已复制";
                setTimeout(() => (copy.textContent = "复制"), 1200);
            },
            () => {
                copy.textContent = "复制失败";
                setTimeout(() => (copy.textContent = "复制"), 1200);
            },
        );
    });

    box.appendChild(copy);
    return box;
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
    // ★ 也包 wrapper（否则间距规则不匹配 ✗）
    const wrap = document.createElement("div");
    wrap.className = "bubble-wrap pending";
    const el = document.createElement("div");
    el.className = "bubble pending";
    el.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
    wrap.appendChild(el);
    messagesEl.appendChild(wrap);
    ui.pendingEl = wrap; // ★ 记 wrapper（移除时一并拿掉 ✓）
    scrollToBottom();
}

export function removePending(): void {
    if (ui.pendingEl) {
        ui.pendingEl.remove();
        ui.pendingEl = null;
    }
}

/**
 * bubbles.ts —— 气泡【基础层】：滚动、建气泡、折叠头、占位三点
 *
 * 【依赖方向】dom / state → 本文件 → thinking / segments / tool
 * （本文件【不】依赖 thinking/segments/tool ✗ —— 保证单向、无循环 ✓）
 */
import { messagesEl } from "./dom.js";
import { ui } from "./state.js";
import { post } from "./vscode-api.js";

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

    // ★ 分叉 / 克隆【只加在 AI 组的最后一个气泡】✗
    //   而这里【只有正文和用户】会走本函数 ✗
    //   → 思考 / 工具气泡在【它们自己的创建函数】里单独调 makeActions() ✓
    //   （因为它们的结构不同 ✓ 有折叠头 / 参数字体区 ✓）
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
export function makeActions(source: HTMLElement): HTMLElement {
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

    // ★ 分叉 / 克隆【不在这里加】✗
    //   原因：它们【只属于每个 AI 组（turn）的【最后一个】气泡】✓
    //   而创建气泡的那一刻【还不知道自己是不是最后一个】✗
    //   → 由 refreshForkButtons() 事后统一扫一遍补上 ✓（实时/重放统一 ✓ 幂等 ✓）
    return box;
}

/**
 * ★ 刷新“分叉刀”按钮（用户："那个按钮就像一把刀一样切一刀"✓）
 *
 * 【为什么需要它】
 *   1. 按钮只属于【每个 AI 组的最后一个气泡】✗
 *      而建气泡时不可能知道后面还会不会跟 tool / text 气泡 ✓
 *   2. ★ 而在【重放历史】时，全部气泡一次到位 ✓
 *      → 同一个函数就能把两种情况都处理了 ✓
 *
 * 【判定规则（不需要 turn_* 事件 ✓ 从气泡序列就能推 ✓）】
 *   一个 AI 组 = 【两个 user 气泡之间】的连续非 user 气泡 ✓
 *   → 扫一遍，记住“该组目前见到的最后一个非 user 气泡”
 *   → 后面的覆盖前面的 → 最后留下的必然是组尾 ✓
 *
 * 【传入的 entryId 怎么定？】
 *   组 N（它前面有 N 个 user 气泡）→ 用【第 N+1 个用户气泡】的 entryId ✓
 *   （get_fork_messages 的下标 N + 1 = index N ✓）
 *   → 第 0 组 → index 0 ✓（第一个用户气泡 ✓）
 *   → ★ 最后一组【没有下一个用户气泡】→ 不加按钮 ✓（正好 ✓）
 *
 * 【幂等】已有按钮就跳过 ✓（可以反复调用 ✓）
 *
 * @returns 是否【真的新增了】按钮（调用方用来决定要不要重算底部留白 ✓）
 */
export function refreshForkButtons(): boolean {
    const wraps = Array.from(messagesEl.querySelectorAll<HTMLElement>(".bubble-wrap"));
    const groupTail = new Map<number, HTMLElement>();
    let userCount = 0;
    for (const w of wraps) {
        if (w.classList.contains("user")) {
            userCount++;
            continue;
        }
        // ★ 三“种 AI 气泡都要（用户实测报的 ✓）：
        //   · 正常收尾 → 正文 ✓
        //   · 被中断 / 只调工具 → 工具 ✓
        //   · 只思考就断了 → 思考 ✓
        if (
            w.classList.contains("text") ||
            w.classList.contains("thinking") ||
            w.classList.contains("tool")
        ) {
            groupTail.set(userCount, w); // ★ 后面的覆盖前面的 → 组尾 ✓
        }
    }
    // ★★ 关键：组号 == userCount 的那一组【后面没有用户消息了】✗
    //    → 找不到“下一刀的锚点” → ★ 不加按钮 ✓（用户实测报的 bug ✓）
    const totalUsers = userCount;
    let added = false;
    for (const [n, w] of groupTail) {
        if (n >= totalUsers) continue;
        if (w.querySelector(".bubble-action-fork")) continue; // 幂等 ✓
        const box = w.querySelector<HTMLElement>(".bubble-actions");
        if (box) {
            addForkButtons(box, n);
            added = true;
        }
    }
    // ★ 返回“确实新增了” —— 调用方据此决定要不要重算底部留白 ✓
    //   （流式时每帧都会调本函数 ✗ 无条件重算会强制回流 → 性能问题 ✓）
    return added;
}

/**
 * 给一个动作区补上【克隆】+【分叉】
 * @param afterUserCount 该气泡前面有【几个】用户气泡（0-based 的下一轮 = 它的下标 ✓）
 */
function addForkButtons(box: HTMLElement, afterUserCount: number): void {
    const clone = document.createElement("button");
    clone.className = "bubble-action bubble-action-clone";
    clone.textContent = "克隆";
    clone.title = "克隆整个会话（从第一条消息开始复制成一个新会话）";
    clone.addEventListener("click", () => {
        clone.textContent = "克隆中…";
        post("cloneSession");
    });

    const fork = document.createElement("button");
    fork.className = "bubble-action bubble-action-fork";
    fork.textContent = "分叉";
    fork.title = "从这里分叉：保留这条消息及其之前的所有内容，之后的内容丢弃";
    fork.addEventListener("click", () => {
        fork.textContent = "分叉中…";
        // ★ 传给后端的是【下一个用户气泡的下标】（= 前面已有几个 user 气泡 ✓）
        //   即“刀子的位置”：切在这个 AI 组末尾 ✓
        post("forkSession", { userIndex: afterUserCount });
    });

    box.appendChild(clone);
    box.appendChild(fork);
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

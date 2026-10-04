/**
 * interaction/index.ts —— 交互面板前端【入口】（B26）
 *
 * 【★ 核心设计：判定点是“用户提交那一刻”✗】
 *   用户定的（他原话）：
 *     “只要有问题来了，我就立马弹过去展示第一个问题 ✓
 *      无论后面有没有问题、无论串行还是并行 ✗
 *      只要答完时队列里还有问题，那就做多页 ✓
 *      一旦用户提交，则立马关闭 ✓（我们延迟 600ms 吸收后续 ✓）
 *      如果这时又来一个，那就重新渲染一个 ✓”
 *
 *   ★ 为什么这个判定足够？→ 它和“到达时判定”等价 ✗
 *     · 并发的第 2 个是【毫秒级】到 ✗ → 你看到时队列已经齐了 ✓
 *     · 串行的第 2 个要等【你提交】才可能发出 ✗ → 永远不会提前到 ✓
 *     → 所以不需要人为聚合延迟 ✓ 有问题就立刻弹 ✓
 *
 * 【★ 两种视图】
 *   队列 == 1 → 单题页 ✓ 答完立刻发 ✓（可能是串行第 1 问 ✗ 不回就死等 ✓）
 *   队列 >= 2 → 答卷页 ✓ 页签 + 每页一题 + 确认页 ✓ 一次性提交 ✓
 *
 * 【★ 双保险】
 *   单题页点“确定/取消”时【再看一眼队列】✗
 *     队列还是 1 → 真发 ✓
 *     队列变成 >= 2 → 【不发】✗ 转答卷模式 ✓（刚才的答案保留为草稿 ✓）
 *   —— 这就是用户说的“判定点是提交那一刻”✓
 */
import { splitOptions } from "./controls.js";
import { advanceToNextUnanswered, applyQueue, state } from "./state.js";
import type { UiReq, UiRes } from "./types.js";
import { render, type Handlers } from "./views.js";

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();

const hostEl = document.getElementById("host")!;
const listEl = document.getElementById("list")!;

/** 重绘（幂等 ✓ 每次全量重建 ✗ 简单可靠 ✓）*/
const redraw = (): void => {
    // ★★ 空态开关（B26 修复 ✗）
    //   之前忘了切 dataset → 有内容时“pi 没有待回答的问题”还挂在头上 ✓
    //   条件：队列空 + 历史空 + 未提交 ✓
    const empty = state.queue.length === 0 && state.history.length === 0 && !state.submitted;
    hostEl.dataset.empty = empty ? "true" : "false";
    render(listEl, handlers);
};

const handlers: Handlers = {
    /** 单题/串行模式：立刻发 ✓（★ 但先复核一次队列 ✓）*/
    sendNow(id: string, r: UiRes): void {
        if (state.queue.length >= 2) {
            // ★★ 提交那一刻发现是并发批次 ✗ → 不发 ✗ 转答卷 ✓
            state.answers.set(id, r);
            // 跳到下一个未答的题 ✓
            const qi = state.queue.findIndex((q) => q.id !== id && !state.answers.has(q.id));
            state.page = state.history.length + (qi >= 0 ? qi : state.queue.length);
            redraw();
            return;
        }

        // ★ 串行：真的发 ✗（不回它，扩展就不发下一题 ✓）
        vscode.postMessage({ kind: "uiResponse", id, ...r });

        // ★★ 立刻移入历史 ✗（不等宿主的 sync ✗ 否则中间会闪 ✓）
        const i = state.queue.findIndex((q) => q.id === id);
        if (i >= 0) {
            const [q] = state.queue.splice(i, 1);
            state.history.push({ q, a: r });
            // ★★ page 停在“下一个待答位”✗ —— 【故意不 clamp】✓
            //   若此时队列已空 ✗ 那 page == totalPages() = 一个虚构的“等待页”
            //     （渲染时会显示“等待下一个问题…”✓）
            //   扩展毫秒后发来下一题 ✗ queue +1 ✗ → page 正好指到它 ✓✓✓
            //   ⇒ 这就是用户要的【答题瞬间自动翻到下一题】✓
            //   ★ 而用户手动点页签回看历史时 page 会变小 ✗
            //     新题到来就【不会】把他从历史里拽走 ✓（尊重手动操作 ✓）
            state.page = state.history.length;
        }
        redraw();
    },

    redraw,

    /** 答卷模式：一次性把 N 个答案全发 ✓ */
    submitAll(): void {
        state.submitted = true;
        for (const q of state.queue) {
            const r = state.answers.get(q.id);
            if (r) vscode.postMessage({ kind: "uiResponse", id: q.id, ...r });
        }
        redraw();
    },
};

// ── 宿主 → 前端 ──
window.addEventListener("message", (e: MessageEvent) => {
    const msg = e.data as { kind?: string; payload?: unknown };
    if (msg?.kind === "queue") {
        applyQueue((msg.payload as UiReq[]) ?? []);
        redraw();
        // ★★ 关键修复（B27 ✗）
        //   webview 内部的 activeElement 可能是 body ✗
        //   而 body 【不可聚焦】→ 键盘事件上不来 ✓
        //   → 给它一个 tabindex 并主动聚焦 ✓
        //   （用户已确认修复后焦点正常 ✓）
        setTimeout(() => {
            if (!document.hasFocus()) {
                document.body.tabIndex = -1;
                document.body.focus();
            }
        }, 0);
    }
});

/** ★★ 只重画选项的键盘高亮 ✗ 不重建 DOM ✓
 *  【为何需要它？】用户报：“我在上边切选项，下面输入框的文字在闪”✓
 *   根因：↑↓ 走 redraw() → textarea 被销毁重建 → 文字重插 → 闪 ✓
 *   → 切选项只动 .kbd 类 ✗ DOM 其他部分一律不动 ✓
 */
function paintKbd(): void {
    document.querySelectorAll<HTMLElement>("[data-kbd-index]").forEach((el) => {
        el.classList.toggle("kbd", Number(el.dataset.kbdIndex) === state.kbd);
    });
    // ★★ 在选项上时，必须把焦点从输入框里【拿开】✗
    //   否则键盘事件会继续被输入框“吃掉”（光标导航 ✓）
    //   只有 kbd < 0（输入框那一环）才把焦点给它 ✓
    const cur = document.activeElement as HTMLElement | null;
    const inText = !!cur && (cur.tagName === "TEXTAREA" || cur.tagName === "INPUT");
    if (state.kbd >= 0 && inText) {
        cur.blur();
        document.body.tabIndex = -1;
        document.body.focus();
    }
}

/** 当前待答页的题（历史/确认页 → undefined ✓）*/
function pendingQ(): UiReq | undefined {
    if (state.page < state.history.length) return undefined;
    if (state.queue.length >= 2 && state.page >= state.history.length + state.queue.length) return undefined;
    return state.queue[state.page - state.history.length];
}

/** 当前题的选项列表 ✗（select 的真选项 / confirm 的确定取消 ✓）*/
function optionsOf(q: UiReq): string[] {
    if (q.method === "select") return splitOptions(q).real;
    if (q.method === "confirm") return ["确定", "取消"];
    return [];
}

/** ★★ 键盘（B27：★ 边界穿越 ✗）
 *
 * 【用户定的规则】
 *   ↑  输入框在【首行】再按 ↑   → 跳到选项列表（最后一个 ✓）
 *      选项列表里再按 ↑          → 上一个选项 ✓
 *   ↓  选项列表【最后一个】再按 ↓ → 回到输入框 ✓
 *   ←  输入框在【最左端】再按 ←   → 上一页 ✓
 *   →  输入框在【最右端】再按 →   → 下一页 ✓
 *   Enter ✗ 输入框里 / 选项列表 → 提交 ✓
 *
 * 【★ 为什么用“边界”而不是“抢”？】
 *   输入框里上下左右是【光标导航】✗ 直接抢掉就没法编辑多行文本了 ✓
 *   → 只有光标已经到边界、再按一下才“越界”到别的控件 ✓
 */
document.addEventListener("keydown", (e) => {
    if (state.submitted) return;
    const el = document.activeElement as HTMLElement | null;
    const inText = !!el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT");
    // ★★ 关键（B27 ✗ 用户报的怪现象 ✓）
    //
    //   “按 ↓ 选中第一个后再按 ↓ 无反应”
    //   “按 ← 要按好几下才切页 ✗ → 却正常”
    //
    //   根因：焦点【还在输入框里】✗ 但 kbd 已经 >= 0（在选项上）✓
    //     → 于是 ←→↑↓ 全被当成“光标导航”✗（不在边界就不处理 ✓）
    //     → ← 要求光标在【开头】✗ 而 → 只要在【末尾】✓
    //       ⇒ 光标在末尾时 → 有效 ✗ ← 无效 ✓（完全对上用户的描述）
    //
    //   修：★ 只有 kbd < 0（处于“输入框”那一环）时，才把它当输入框 ✓
    //       一旦走到选项上（kbd >= 0 ✗）→ 键盘就完全交给选项 ✓
    const ta = inText && state.kbd < 0 ? (el as HTMLTextAreaElement) : null;
    const q = pendingQ();

    // ══ ↑ ↓（★ 循环 ✗）══
    //
    // 【有输入框的页】（select / input ✗）：
    //   ↓ ： 1 → 2 → 3 → 【输入框】 → 1 → ...
    //   ↑ ： 【输入框】 → 3 → 2 → 1 → 【输入框】 → ...
    // 【没有输入框的页】（confirm ✗ 用户报的 bug ✓）：
    //   ↓ ： 确认 → 取消 → 确认 → 取消 → ...
    //   ★ 不能出现“什么都不选中”那一环 ✗
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        if (!q) return;
        const opts = optionsOf(q);
        if (opts.length === 0) return;
        const n = opts.length;
        const up = e.key === "ArrowUp";
        // ★ confirm / editor 没有底部输入框 ✗ → 纯选项环 ✓
        const hasBox = q.method === "select" || q.method === "input";

        if (!hasBox) {
            e.preventDefault();
            const cur = state.kbd;
            state.kbd = up ? (cur <= 0 ? n - 1 : cur - 1) : (cur < 0 || cur >= n - 1 ? 0 : cur + 1);
            paintKbd(); // ★ 只改高亮 ✗ 不重建 ✓
            return;
        }

        // 在输入框里 → 只有光标在【首/末行】才算越界 ✓（否则让光标自己走 ✓）
        if (ta) {
            const start = ta.selectionStart ?? 0;
            const end = ta.selectionEnd ?? start;
            const atEdge = up ? !ta.value.slice(0, start).includes("\n") : !ta.value.slice(end).includes("\n");
            if (!atEdge) return;
            e.preventDefault();
            state.kbd = up ? n - 1 : 0;
            paintKbd(); // ★ 同上 ✓
            return;
        }

        // 已在选项上
        e.preventDefault();
        if (up) {
            state.kbd = state.kbd <= 0 ? -1 : state.kbd - 1; // 第一个再↑ → 回输入框 ✓
        } else {
            state.kbd = state.kbd >= n - 1 ? -1 : state.kbd + 1; // 最后一个再↓ → 回输入框 ✓
        }
        paintKbd();
        // ★ 回到“输入框”那一环时 ✗ 直接把焦点交给它 ✓（不重建 DOM ✓）
        if (state.kbd < 0) document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
        return;
    }

    // ══ Enter（提交键盘选中的选项 ✓）══
    if (e.key === "Enter" && !inText && q && state.kbd >= 0) {
        const opt = optionsOf(q)[state.kbd];
        if (opt === undefined) return;
        e.preventDefault();
        const r: UiRes = q.method === "confirm" ? { confirmed: opt === "确定" } : { value: opt };
        handlers.sendNow(q.id, r);
        return;
    }

    // ══ ★ 确认页：Enter = 提交全部（用户要求 ✓）══
    //   “提交页面的提交全部应该吃一下 enter”✓
    //   ★ 但只有【全部答完】时才真的提交 ✗ 否则什么都不做 ✓
    if (e.key === "Enter" && !inText && !q && state.queue.length >= 2) {
        const onConfirm = state.page >= state.history.length + state.queue.length;
        if (onConfirm) {
            e.preventDefault();
            if (state.queue.every((it) => state.answers.has(it.id))) handlers.submitAll();
        }
        return;
    }

    // ══ ← →（输入框在边界时翻页 ✓）══
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const left = e.key === "ArrowLeft";
        if (ta) {
            const start = ta.selectionStart ?? 0;
            const end = ta.selectionEnd ?? start;
            const atEdge = left ? start === 0 && end === 0 : start === ta.value.length && end === ta.value.length;
            if (!atEdge) return; // 让光标自己走 ✓
        }
        // ★★ 关键修正（B27 ✗ 用户实测：“按→跳到第三题 / 再按变等待下一个问题”✓）
        //
        //   串行时 page 可能停在【虚构的“等待页”】✗
        //     （= history + queue ✗ 比如答完 Q1 后 Q2 还没到 ✓）
        //   那个位置能渲染（显示“等待下一个问题…”✓）但【不能手动走进去】✗
        //   否则 page 越界 ✗ 下一题到达后也 clamp 不回来 ✓
        //
        //   → 所以：串行时最大只能到【最后一题】✗
        //      只有批量模式才允许多走一步到【确认页】✓
        const isBatchMode = state.queue.length >= 2;
        const maxPage = isBatchMode
            ? state.history.length + state.queue.length // 批：可以到确认页 ✓
            : state.history.length + state.queue.length - 1; // 串行：到最后一题为止 ✓
        if (maxPage < 0) return;

        // ★★ 首尾循环（用户定的 ✓）
        //   · 第 1 页按 ← → 跳到最后一页 ✓
        //   · 最后一页按 → → 回到第 1 页 ✓
        let target = left ? state.page - 1 : state.page + 1;
        if (target < 0) target = maxPage;
        if (target > maxPage) target = 0;
        if (target === state.page) return; // 只有一页时不动 ✓

        e.preventDefault();
        state.page = target;
        state.kbd = -1;
        redraw();
        return;
    }

    // ══ Esc：取消 ✓ ══
    if (e.key !== "Escape" || !q) return;
    if (inText) return; // 输入框里 Esc 交给控件自己（blur ✓）
    if (state.queue.length >= 2) {
        state.answers.set(q.id, { cancelled: true });
        advanceToNextUnanswered();
        redraw();
        return;
    }
    handlers.sendNow(q.id, { cancelled: true });
});

// （★ B27：旧的“← → 翻页”监听器已删除 ✗）
//
// 【为什么要删？】
//   它与上面的完整键盘处理【重复】✗ → 每次按键被处理 2 次 ✓
//   表现：按一下 → 页码跳【两格】（用户实测 p0→p2 ✓）✓
//   而且它【没有边界检查】（直接 clamp 到 total ✗ 允许走进“虚拟等待页”✓）
//     → 跳过去就显示“等待下一个问题…”✓

// 告诉宿主：准备就绪 → 请重放队列 ✓
vscode.postMessage({ kind: "ready" });

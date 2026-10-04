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
    }
});

// ★ Esc：历史页无操作 ✓ / 待答页 → 串行立刻发 ✗ 答卷写草稿 ✓
document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || state.submitted || state.queue.length === 0) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    // 在历史页 → 没东西可取消 ✓
    if (state.page < state.history.length) return;

    const q = state.queue[state.page - state.history.length];
    if (!q) return;
    if (state.queue.length >= 2) {
        state.answers.set(q.id, { cancelled: true });
        advanceToNextUnanswered();
        redraw();
        return;
    }
    handlers.sendNow(q.id, { cancelled: true });
});

// ★★ ← → 翻页（用户要求的 ✓）
//   ★ 在输入框里打字时【不抢】✗（那要留给光标左右移动 ✓）
document.addEventListener("keydown", (e) => {
    if (state.submitted) return;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    if (state.history.length + state.queue.length === 0) return;

    // 答卷模式下多一个【确认页】✓
    const last = state.history.length + state.queue.length + (state.queue.length >= 2 ? 1 : 0);
    const next = e.key === "ArrowRight" ? state.page + 1 : state.page - 1;
    const clamped = Math.max(0, Math.min(next, last));
    if (clamped === state.page) return;
    state.page = clamped;
    redraw();
});

// 告诉宿主：准备就绪 → 请重放队列 ✓
vscode.postMessage({ kind: "ready" });

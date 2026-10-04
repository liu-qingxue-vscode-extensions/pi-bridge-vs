/**
 * views.ts —— 面板骨架（B26）
 *
 * 【统一成一个结构 ✗】
 *   不管是串行（队列 1 个）还是并行（队列 >= 2 ✓），都渲染成：
 *     ┌──────────────────────────────┐
 *     │ [历史1][历史2]…[当前][确认?]  │  ← 页签条 ✓
 *     │ ──────────────────────────── │
 *     │        当前页的内容           │
 *     │ ──────────────────────────── │
 *     │ [← 上一题] [取消] [下一题 →]  │  ← 导航 ✓
 *     └──────────────────────────────┘
 *
 * 【★ 两种模式的区别只在两处】
 *   ① 页签里有没有【确认页】✗（只有队列 >= 2 时有 ✓）
 *   ② 答案什么时候发 ✗：
 *        串行 → 答完【立刻发】✓（否则扩展不发下一题 ✗ 见 state.ts 注释）
 *        并行 → 存草稿 ✓ 点[提交全部]才发 ✓
 *
 * 【★ 串行时页面会“长出来”】
 *   答完第 1 题 → 它变成历史页 ✓ page 停在“下一个待答位”✗
 *   扩展毫秒后发来第 2 题 → 队列 +1 ✗ → page 正好指到它 ✓（自动翻页 ✓）
 */
import { confirmBody, historyBody, questionBody } from "./pages.js";
import { advanceToNextUnanswered, state, totalPages, unansweredCount } from "./state.js";
import type { UiRes } from "./types.js";

export interface Handlers {
    /** 立刻发一个答复（单题/串行模式 ✓）*/
    sendNow: (id: string, r: UiRes) => void;
    /** 草稿已写进 state ✓ 只要重绘 ✓ */
    redraw: () => void;
    /** 一次性提交全部（答卷模式 ✓）*/
    submitAll: () => void;
}

/** ★ 答卷模式：队列 >= 2（必定是并发 ✓ 见 B26 判定 ✓）*/
const isBatch = (): boolean => state.queue.length >= 2;
/** ★ 确认页的页码（只在答卷模式下存在 ✓）*/
const confirmPage = (): number => state.history.length + state.queue.length;

export function render(listEl: HTMLElement, h: Handlers): void {
    listEl.textContent = "";

    if (state.submitted) {
        listEl.appendChild(info("✓ 已提交，等待 pi 关闭面板…"));
        return;
    }
    // 真空态 → 什么都不画（#empty 会显示 ✓）
    if (totalPages() === 0) return;

    const box = document.createElement("div");
    box.className = "batch";
    box.append(tabBar(h), current(h), nav(h));
    listEl.appendChild(box);
}

// ────────── 页签条 ──────────
function tabBar(h: Handlers): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "tabs";

    // 历史页（已答已发送 ✓ 只读）
    state.history.forEach((entry, i) => {
        const b = document.createElement("button");
        b.className = "tab done";
        if (entry.a.cancelled) {
            b.classList.remove("done");
            b.classList.add("skipped");
        }
        if (state.page === i) b.classList.add("active");
        b.textContent = String(i + 1);
        b.title = `已答：${entry.q.title.split("\n")[0].slice(0, 60)}`;
        b.addEventListener("click", () => jump(h, i));
        bar.appendChild(b);
    });

    // 待答页
    state.queue.forEach((q, i) => {
        const b = document.createElement("button");
        b.className = "tab";
        const idx = state.history.length + i;
        if (state.page === idx) b.classList.add("active");
        if (state.answers.has(q.id)) b.classList.add("done"); // 答卷模式下已答的
        b.textContent = String(idx + 1);
        b.title = q.title.split("\n")[0].slice(0, 60);
        b.addEventListener("click", () => jump(h, idx));
        bar.appendChild(b);
    });

    // ★ 确认页：只在答卷模式 ✓
    if (isBatch()) {
        const s = document.createElement("button");
        s.className = "tab submit";
        if (state.page === confirmPage()) s.classList.add("active");
        s.textContent = "✓ 提交";
        s.addEventListener("click", () => jump(h, confirmPage()));
        bar.appendChild(s);
    }

    const count = document.createElement("span");
    count.className = "tab-count";
    count.textContent = isBatch()
        ? `已答 ${state.queue.length - unansweredCount()}/${state.queue.length}`
        : state.queue.length > 0
          ? "待回答"
          : "等待下一个…";
    bar.appendChild(count);
    return bar;
}

// ────────── 当前页 ──────────
function current(h: Handlers): HTMLElement {
    // ① 历史页（只读 ✓）
    if (state.page < state.history.length) {
        return historyBody(state.history[state.page]);
    }
    // ② 确认页
    if (isBatch() && state.page >= confirmPage()) {
        return confirmBody(state.queue, state.answers, (i) =>
            jump(h, state.history.length + i),
        );
    }
    // ③ 待答页
    const qi = state.page - state.history.length;
    const q = state.queue[qi];
    if (!q) return info("等待下一个问题…");

    return questionBody(
        q,
        state.answers.get(q.id),
        // onDraft：内容变了 → ★ 只写草稿 ✗ 绝不提交 ✓
        (r) => {
            state.answers.set(q.id, r);
            // ★ 正在文本输入 → 【不重绘】✗
            //   否则每敲一个字都重建 DOM → 光标跳回末尾 / 页面抖 ✓
            //   （选项类才需要重绘 ✗ 因为靠 .selected 高亮 ✓）
            if (isTyping()) return;
            h.redraw();
        },
        // onCommit：明确的“提交这个答案”动作 ✗
        (r) => {
            state.answers.set(q.id, r);
            if (isBatch()) {
                // 答卷：写草稿 + ★ 自动跳到下一题 ✗（用户要求的 ✓）
                advanceToNextUnanswered();
                h.redraw();
            } else {
                // ★ 串行：立刻发 ✗（否则扩展不发下一题 ✓）
                h.sendNow(q.id, r);
            }
        },
    );
}

// ────────── 导航 ──────────
function nav(h: Handlers): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "nav";

    const prev = mkBtn("← 上一题", () => jump(h, state.page - 1));
    prev.disabled = state.page <= 0;
    bar.appendChild(prev);

    // 取消本题：待答页才有 ✓
    const onQuestion = !(state.page < state.history.length) && !(isBatch() && state.page >= confirmPage());
    if (onQuestion) {
        const q = state.queue[state.page - state.history.length];
        bar.appendChild(
            mkBtn("取消本题", () => {
                if (!q) return;
                if (isBatch()) {
                    state.answers.set(q.id, { cancelled: true });
                    advanceToNextUnanswered();
                    h.redraw();
                } else {
                    h.sendNow(q.id, { cancelled: true });
                }
            }, "cancel"),
        );
    }

    // 下一页 / 去确认 ✓（只在答卷模式 ✗ 串行时没有确认页 ✓）
    if (isBatch() && state.page < confirmPage()) {
        const last = state.page === confirmPage() - 1;
        bar.appendChild(
            mkBtn(last ? "去确认 →" : "下一题 →", () => jump(h, state.page + 1), "navbtn"),
        );
    }
    return bar;
}

// ────────── 零件 ──────────
function jump(h: Handlers, page: number): void {
    state.page = Math.max(0, Math.min(page, confirmPage()));
    h.redraw();
}

/** ★ 用户此刻是不是在文本输入框里打字 ✗（用来决定能不能重绘 ✓）*/
function isTyping(): boolean {
    const ae = document.activeElement;
    return !!ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA");
}

function mkBtn(text: string, onClick: () => void, extra = ""): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = "uir-opt " + extra;
    b.textContent = text;
    b.addEventListener("click", onClick);
    return b;
}

function info(text: string): HTMLElement {
    const d = document.createElement("div");
    d.className = "uir-info";
    d.textContent = text;
    return d;
}

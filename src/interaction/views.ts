/**
 * views.ts —— 面板骨架（B26 → B27 重做）
 *
 * 【★★ 三段式 ✗】
 *   ┌──────────────────────────────┐
 *   │ ① .tabs      页签栏（等分 ✗） │  ← 1 个满宽 / 2 个各半 / N 个各 1/N ✓
 *   ├──────────────────────────────┤
 *   │ ② .content   内容（滚 + 居中） │  ← 题目 / 选项 / 历史 / 确认 ✓
 *   ├──────────────────────────────┤
 *   │ ③ .composer  底部输入区       │  ← ★ 抄对话输入框的样式 ✓
 *   │    [ 输入框（常驻 ✗）  ] [↑]  │
 *   │    [← 上一页][取消本页][下一页→]│  ← ★ 大按钮 ✓
 *   └──────────────────────────────┘
 *
 * 【★ 输入框什么时候在？】（用户定的 ✓）
 *   select  → ★ 常驻（自由书写 ✗ placeholder 用扩展的 “Type something.” ✓）
 *   input   → ★ 常驻（placeholder 用 q.placeholder ✓）
 *   editor  → ✗ 不在底部（内容区有大文本框 ✓）
 *   confirm → ✗ 没有输入框（只有两个按钮 ✓）
 *   历史页 / 确认页 → ✗ 没有 ✓
 */
import { isFreeValue, splitOptions } from "./controls.js";
import { confirmBody, historyBody, questionBody } from "./pages.js";
import { advanceToNextUnanswered, state, totalPages, unansweredCount } from "./state.js";
import type { UiReq, UiRes } from "./types.js";

export interface Handlers {
    /** 立刻发一个答复（单题/串行模式 ✓）*/
    sendNow: (id: string, r: UiRes) => void;
    /** 草稿已写进 state ✓ 只要重绘 ✓ */
    redraw: () => void;
    /** 一次性提交全部（答卷模式 ✓）*/
    submitAll: () => void;
}

/** ★ 答卷模式：队列 >= 2（必定是并发 ✓）*/
const isBatch = (): boolean => state.queue.length >= 2;
/** ★ 确认页的页码（只在答卷模式下存在 ✓）*/
const confirmPage = (): number => state.history.length + state.queue.length;

export function render(listEl: HTMLElement, h: Handlers): void {
    listEl.textContent = "";
    if (state.submitted) {
        listEl.appendChild(info("✓ 已提交，等待 pi 关闭面板…"));
        return;
    }
    if (totalPages() === 0) return;

    listEl.append(tabBar(h), content(h), composer(h));
}

// ────────── ① 页签栏（★ 等分 ✗）──────────
function tabBar(h: Handlers): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "tabs";

    const addTab = (label: string, page: number, cls: string, tip: string): void => {
        const b = document.createElement("button");
        b.className = "tab " + cls;
        if (state.page === page) b.classList.add("active");
        b.textContent = label;
        b.title = tip;
        b.addEventListener("click", () => jump(h, page));
        bar.appendChild(b);
    };

    state.history.forEach((entry, i) => {
        const cls = entry.a.cancelled ? "skipped" : "done";
        addTab(`✓ ${i + 1}`, i, cls, `已答：${entry.q.title.split("\n")[0].slice(0, 60)}`);
    });

    state.queue.forEach((q, i) => {
        const idx = state.history.length + i;
        addTab(String(idx + 1), idx, state.answers.has(q.id) ? "done" : "", q.title.split("\n")[0].slice(0, 60));
    });

    if (isBatch()) addTab("提交", confirmPage(), "submit", "检查并一次性提交全部答案");
    return bar;
}

// ────────── ② 内容区 ──────────
function content(h: Handlers): HTMLElement {
    const box = document.createElement("div");
    box.className = "content";
    const page = document.createElement("div");
    page.className = "page";
    page.appendChild(currentPage(h));
    box.appendChild(page);
    return box;
}

function currentPage(h: Handlers): HTMLElement {
    if (state.page < state.history.length) return historyBody(state.history[state.page]);

    if (isBatch() && state.page >= confirmPage()) {
        return confirmBody(
            state.queue,
            state.answers,
            (i) => jump(h, state.history.length + i),
            () => h.submitAll(),
            state.queue.every((q) => state.answers.has(q.id)),
            unansweredCount(),
        );
    }

    const q = state.queue[state.page - state.history.length];
    if (!q) return info("等待下一个问题…");

    return questionBody(
        q,
        state.answers.get(q.id),
        (r) => {
            state.answers.set(q.id, r);
            // ★ 正在文本输入 → 【不重绘】✗（否则光标跳回末尾 ✓）
            if (isTyping()) return;
            h.redraw();
        },
        (r) => commit(h, q, r),
    );
}

/** ★ 提交一题的答案（串行=立刻发 / 并行=存草稿+跳下一题 ✓）*/
function commit(h: Handlers, q: UiReq, r: UiRes): void {
    state.answers.set(q.id, r);
    state.kbd = 0;
    if (isBatch()) {
        // 答卷：写草稿 + ★ 自动跳到下一题 ✗（用户要求的 ✓）
        //   ★ 如果后面已经没有未答的题 ✗ → 自动去【确认页】✓
        //     （用户报的：“必须去点那个去确认 ✓ 输入框里按 Enter 没用”✓）
        if (!advanceToNextUnanswered()) state.page = confirmPage();
        h.redraw();
    } else {
        h.sendNow(q.id, r); // ★ 串行：立刻发 ✗（否则扩展不发下一题 ✓）
    }
}

// ────────── ③ 底部输入区（★ 抄对话输入框 ✓）──────────
function composer(h: Handlers): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "composer";
    const inner = document.createElement("div");
    inner.className = "composer-inner";

    const q = pendingQuestion();
    const hasInput = !!q && (q.method === "select" || q.method === "input");

    // ── 输入框那一行：左边输入框 ✗ 右边圆形发送 ✓ ──
    const bar = document.createElement("div");
    bar.className = "composer-bar";

    const send = document.createElement("button");
    send.className = "send";
    send.title = "提交（Enter）";
    // ★ 向上的箭头 ✗（之前写反了 ✓）
    send.innerHTML =
        '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 13.5a.75.75 0 0 1-.75-.75V4.56L4.53 7.28a.75.75 0 0 1-1.06-1.06l4-4a.75.75 0 0 1 1.06 0l4 4a.75.75 0 0 1-1.06 1.06L8.75 4.56v8.19a.75.75 0 0 1-.75.75Z"/></svg>';
    send.disabled = true; // 没输入框时不可点 ✓（下面按需打开 ✓）

    /** 点“发送”或者按 Enter 时调 ✓ */
    let submit: (() => void) | undefined;

    if (hasInput && q) {
        const ta = document.createElement("textarea");
        ta.rows = 1;
        const cur = state.answers.get(q.id);

        if (q.method === "input") {
            ta.placeholder = q.placeholder ?? "输入后按 Enter 提交";
            ta.value = cur?.value ?? q.prefill ?? "";
        } else {
            // ★ 自由书写：扩展的 “Type something.” 原文当 placeholder ✓（B27 修 bug ✓）
            const { freeText } = splitOptions(q);
            ta.placeholder = freeText ?? "✍ 也可以自己写…（Enter 提交）";
            if (isFreeValue(q, cur)) ta.value = cur?.value ?? "";
        }

        // ★ 打字只写草稿 ✗ 不重绘 ✓（否则光标跳 ✓）
        ta.addEventListener("input", () => {
            state.answers.set(q.id, { value: ta.value });
            state.kbd = -1; // ★ 一打字就等于选了“自由书写”✗
            autoGrow(ta);
            send.disabled = ta.value.trim() === "";
        });
        // ★★ 光标进入输入框 → 取消选项高亮 ✗（用户定的 ✓）
        //
        // 【★ 这里【绝不能】redraw ✗】（B27 踩的坑 ✓）
        //   旧实现：focus → state.kbd=-1 → h.redraw() → 整个 DOM 重建 ✓
        //   ⇒ textarea 被换成新的 ✗ 光标位置/内容都可能乱 ✓
        //   ⇒ 而且用户按 Enter 时如果恰好碰上重建 ✗ 事件就丢了 ✓
        //      （用户报的：“enter 没用了 ✗ 必须去点那个按钮”✓）
        //   ⇒ 现在只【清高亮】✗ DOM 不动 ✓
        ta.addEventListener("focus", () => {
            if (state.kbd === -1) return;
            state.kbd = -1;
            document
                .querySelectorAll<HTMLElement>("[data-kbd-index]")
                .forEach((el) => el.classList.remove("kbd"));
        });
        ta.addEventListener("keydown", (e) => {
            // ★ Shift+Enter = 换行 ✗（Enter 单独 = 提交 ✓）
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit?.();
            }
            if (e.key === "Escape") ta.blur();
        });

        // ★★ 拖拽进来的文件不能被塞成路径 ✗（用户实测：拖张图→输入框里 10 行 URI ✓）
        //   现在直接阻止默认行为（将来要支持附件再处理 ✓）
        ta.addEventListener("dragover", (ev) => ev.preventDefault());
        ta.addEventListener("drop", (ev) => {
            ev.preventDefault();
            const text = ev.dataTransfer?.getData("text/plain") ?? "";
            if (text) ta.value += text; // 只接受纯文本 ✓ 不接受 URI-list ✓
        });
        inner.appendChild(ta);
        submit = () => commit(h, q, { value: ta.value });
        send.disabled = ta.value.trim() === "";
        // ★★ 渲染时【立即】算好高度 ✗（不要等 setTimeout ✓）
        //   用户报：“选选项时输入框在那里跳”✓
        //   根因：每帧重建 → 高度先默认 → 再 autoGrow → 视觉上一弹一弹 ✓
        //   → 同步设一次 → 第一帧就是最终高度 ✓
        autoGrow(ta);

        // ★★ 自动聚焦（B27 用户要求：“弹过去时焦点也过去”✓）
        //   · input 页：没有选项 ✓ → 必须聚焦输入框（否则打不了字 ✓）
        //   · select 页：默认选中第一个选项 ✓ → 【不抢焦点】✗
        //     这样按 Enter 直接提交选项 1 ✓（用户要的“一下 Enter 就过”✓）
        //     想打字的话按一下 ↑ → kbd=-1 → 会聚焦输入框 ✓
        setTimeout(() => {
            if (q.method === "input" || state.kbd < 0) ta.focus();
            autoGrow(ta);
        }, 0);
    }

    send.addEventListener("click", () => submit?.());
    inner.appendChild(bar);

    // ── 导航行：★ 永远三个大按钮 ✗（不可用时禁用 ✗ 布局才稳 ✓）──
    const nav = document.createElement("div");
    nav.className = "nav-row";

    const prev = mkNav("← 上一页", () => jump(h, state.page - 1));
    prev.disabled = state.page <= 0;
    nav.appendChild(prev);

    const cancel = mkNav("取消本页", () => {
        if (q) commit(h, q, { cancelled: true });
    }, "danger");
    cancel.disabled = !q; // 历史页/确认页 → 没东西可取消 ✓
    nav.appendChild(cancel);

    const lastPage = isBatch() ? confirmPage() : totalPages() - 1;
    const isLastQ = isBatch() && state.page === confirmPage() - 1;
    const next = mkNav(isLastQ ? "去确认 →" : "下一页 →", () => jump(h, state.page + 1));
    next.disabled = state.page >= lastPage;
    nav.appendChild(next);

    // ★ 发送按钮放在这一行最右 ✗（不再挤上方输入框 ✓）
    nav.appendChild(send);

    inner.appendChild(nav);

    wrap.appendChild(inner);
    return wrap;
}

/** 当前是不是待答页（历史/确认页 → undefined ✓）*/
function pendingQuestion(): UiReq | undefined {
    if (state.page < state.history.length) return undefined;
    if (isBatch() && state.page >= confirmPage()) return undefined;
    return state.queue[state.page - state.history.length];
}

// ────────── 零件 ──────────
function jump(h: Handlers, page: number): void {
    state.page = Math.max(0, Math.min(page, confirmPage()));
    state.kbd = 0; // ★ 换页后默认选中第一个选项 ✓（Enter 直接通过 ✓）
    h.redraw();
}

/** ★ 用户此刻是不是在文本输入框里打字 ✗（决定能不能重绘 ✓）*/
function isTyping(): boolean {
    const ae = document.activeElement;
    return !!ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA");
}

function mkNav(text: string, onClick: () => void, extra = ""): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = "nav-btn " + extra;
    b.textContent = text;
    b.addEventListener("click", onClick);
    return b;
}

/** ★ 输入框高度自适应 ✗（Shift+Enter 换行后要能“长高”✓ 用户报的 ✓）*/
function autoGrow(ta: HTMLTextAreaElement): void {
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 180) + "px";
}

function info(text: string): HTMLElement {
    const d = document.createElement("div");
    d.className = "info";
    d.textContent = text;
    return d;
}

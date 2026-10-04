/**
 * state.ts —— 交互面板的状态（B26）
 *
 * 【★ 为什么答案要先存“草稿”？】
 *   答卷模式（队列 ≥ 2 ✓）必须【最后一次性提交】✗
 *   → 每答一题只写进 answers ✗ 不发给 pi ✓
 *   → 点[提交全部]才一次性发 ✓
 *
 * 【为什么单题模式不需要草稿？】
 *   队列 == 1 时可能是【串行扩展的第 1 问】✓
 *   → 不立刻回，它就不会发第 2 问 ✗ 会死等 ✓
 *   → 所以单题答完【立刻发】✓（草稿只当暂存 ✓）
 *
 * ★ 这就是“分层判定”的全部理由 ✓（见 B26 文档 ✓）
 */
import type { UiReq, UiRes } from "./types.js";

export const state = {
    /** 待答队列（[0] 是第一个 ✓）*/
    queue: [] as UiReq[],
    /** ★ 答案草稿（题目 id → 答案 ✓）*/
    answers: new Map<string, UiRes>(),
    /** 当前页码（0..queue.length-1 = 问题页；queue.length = 确认页 ✓）*/
    page: 0,
    /** ★ 已提交 → 前端不再响应宿主的队列更新 ✗（否则会闪 ✓）*/
    submitted: false,

    /**
     * ★★ 已答【已发送】的历史（B26 串行场景 ✓）
     *
     * 【为什么需要它？】
     *   串行扩展（ask_user_question 之类）是【一个接一个】问的 ✗
     *   它 await 第一个 ✗ 你不回就永远不发第二个 ✓
     *   → 所以【不能等它发完再答】✗ 必须答一个发一个 ✓
     *   → 但为了像 TUI 那样“多页问卷”✗ 把已发的留在页签里 ✓
     *     ★ 只读 ✓ 不能再改（已经发出去了 ✓）
     *
     * 【★ 什么时候清空？】
     *   面板关闭 → 下次是【全新加载】✗ 模块级变量自动重置 ✓
     *   → 所以这里【不需要】任何清理逻辑 ✓
     */
    history: [] as Array<{ q: UiReq; a: UiRes }>,
};

/** ★ 队列 ≥ 2 → 答卷模式（必定是并发 ✓ 见 B26 判定 ✓）*/
export const isBatch = (): boolean => state.queue.length >= 2;

/** 确认页：是否每一个问题都有答案 ✓ */
export const allAnswered = (): boolean => state.queue.every((q) => state.answers.has(q.id));

/** 还差几个没答 ✓ */
export const unansweredCount = (): number => state.queue.filter((q) => !state.answers.has(q.id)).length;

/**
 * ★ 总页数 = 历史页 + 待答页 ✓（串行时只有历史+1 ✓ 并行时历史为空 ✓）
 * ★ 注意：答卷模式的“确认页”不计入这里（它是 queue.length 那一页 ✓）
 */
export const totalPages = (): number => state.history.length + state.queue.length;

/** 当前题（历史页可能是 undefined ✓）*/
export const currentReq = (): UiReq | undefined =>
    state.page < state.history.length
        ? state.history[state.page].q
        : state.queue[state.page - state.history.length];

/** 当前页是不是历史页（只读 ✓）*/
export const isHistoryPage = (): boolean => state.page < state.history.length;

/**
 * ★ 自动跳到【后面第一个未答的待答页】✗
 *
 * 【用途】答完一题后自动翻页 ✗（用户要求的 ✓）
 * 【规则】只往后找 ✗ 找到就跳 ✓ 找不到就【不动】✓
 *   ★★ 特别地：不会跳到确认页 ✗（那是“结果页”✗ 留给用户自己点 ✓）
 * 【返回】是否真跳了
 */
export function advanceToNextUnanswered(): boolean {
    for (let p = state.page + 1; p < state.history.length + state.queue.length; p++) {
        const q = state.queue[p - state.history.length];
        if (q && !state.answers.has(q.id)) {
            state.page = p;
            return true;
        }
    }
    return false;
}

/**
 * ★ 同步宿主推来的队列（B26）—— 【不用 reset】✗
 *
 * 【为什么不能直接 reset？】
 *   宿主可能【分批推】同一个批次 ✗
 *     第一次 [Q1]（聚合窗口到了 ✗ 还没等到 Q2/Q3 ✓）
 *     第二次 [Q1,Q2,Q3]（后续补上 ✓）
 *   reset 会把草稿清掉 ✗ → 用户刚答的那页白答了 ✓
 *
 * 【所以】保留【已有题目的答案】✗ 只同步结构 ✓
 */
export function applyQueue(items: UiReq[]): void {
    // ★ 已提交 → 忽略后续队列更新 ✗（否则会闪回到答题界面 ✓）
    if (state.submitted) return;

    const old = state.answers;

    // ★★ 已经答过并进了历史的题，不再回到队列 ✗
    //   为什么？→ 宿主 resolved 时会 sync（那时它的 pending 可能还没少 ✗）
    //   不滤掉的话【已答的题会又冒出来】✓（而且历史页和队列页会重复 ✓）
    const done = new Set(state.history.map((h) => h.q.id));
    const fresh = items.filter((q) => !done.has(q.id));

    state.queue = fresh;

    // 只保留仍然存在的题目的草稿 ✓
    const kept = new Map<string, UiRes>();
    for (const q of fresh) {
        const a = old.get(q.id);
        if (a) kept.set(q.id, a);
    }
    state.answers = kept;

    // 页码越界修正 ✓（队列变短 / 变空 ✓）
    // ★ 注意：允许 page == totalPages()✗ —— 那是一个【虚拟的“等待下一页”】位置 ✓
    //   为什么保留它？→ 刚答完时 page 停在那里 ✗
    //   下一题一到（queue +1 ✗）page 就正好指到它 ✓（自动翻页 ✓）
    if (state.page > totalPages()) state.page = totalPages();
}

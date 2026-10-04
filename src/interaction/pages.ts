/**
 * pages.ts —— 一页的内容（B26）
 *
 * 【三种页】
 *   ① 历史页（已答已发送 ✓）→ ★ 只读 ✗ 显示"问题 + 你的答案"✓
 *   ② 待答页（当前要答的 ✓）→ 显示控件 ✓
 *   ③ 确认页（只在答卷模式 ✗）→ 列出全部问答 + [提交全部] ✓
 *
 * 【★ 为什么历史页只读？】
 *   串行扩展是 await 的 ✗ 我们答完必须【立刻发】✗（否则它不发下一题 ✓）
 *   → 发出去了就【改不了】✓ 所以是只读的 ✓
 *   （答卷模式下才可能回改 ✗ 因为那些答案还只是草稿 ✓）
 */
import { buildControls } from "./controls.js";
import type { UiReq, UiRes } from "./types.js";

/** 答案的可读文本 ✓ */
export function answerText(a: UiRes): string {
    if (a.cancelled) return "（取消本题）";
    if (a.confirmed !== undefined) return a.confirmed ? "确定" : "取消";
    return a.value ?? "";
}

/** ① 历史页：只读 ✓ */
export function historyBody(hist: { q: UiReq; a: UiRes }): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "page-body";

    const q = document.createElement("div");
    q.className = "uir-title";
    q.textContent = hist.q.title || hist.q.message || "";
    wrap.appendChild(q);

    const row = document.createElement("div");
    row.className = "hist-answer";
    const tag = document.createElement("span");
    tag.className = "hist-tag";
    tag.textContent = "✓ 已答（已发送）";
    const val = document.createElement("span");
    val.className = "hist-value";
    val.textContent = answerText(hist.a);
    val.title = val.textContent;
    row.append(tag, val);
    wrap.appendChild(row);
    return wrap;
}

/** ② 待答页：可交互 ✓ */
export function questionBody(
    q: UiReq,
    cur: UiRes | undefined,
    onDraft: (r: UiRes) => void,
    onCommit: (r: UiRes) => void,
): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "page-body";

    const t = document.createElement("div");
    t.className = "uir-title";
    // ★ 必须换行 + 保留格式 ✗（扩展会把富文本塞进 title ✓ 见 B25 实测 ✓）
    t.textContent = q.title || q.message || "";
    wrap.appendChild(t);

    if (q.message && q.title) {
        const m = document.createElement("div");
        m.className = "uir-message";
        m.textContent = q.message;
        wrap.appendChild(m);
    }

    wrap.appendChild(buildControls(q, cur, onDraft, onCommit));
    return wrap;
}

/** ③ 确认页：列出全部问答 ✓ */
export function confirmBody(
    queue: UiReq[],
    answers: Map<string, UiRes>,
    onEdit: (i: number) => void,
): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "page-body";

    const t = document.createElement("div");
    t.className = "uir-title";
    t.textContent = "确认提交";
    wrap.appendChild(t);

    const sub = document.createElement("div");
    sub.className = "uir-message";
    sub.textContent = "检查一遍 —— 点[提交全部]会一次性发给 pi ✓";
    wrap.appendChild(sub);

    const list = document.createElement("div");
    list.className = "qa-list";
    queue.forEach((q, i) => {
        const row = document.createElement("div");
        row.className = "qa";

        const qi = document.createElement("span");
        qi.className = "qa-q";
        qi.textContent = `${i + 1}. ${q.title.split("\n")[0].slice(0, 70)}`;
        qi.title = q.title;

        const a = answers.get(q.id);
        const ai = document.createElement("span");
        ai.className = "qa-a" + (a ? "" : " missing");
        ai.textContent = a ? answerText(a) : "★ 未答";
        ai.title = ai.textContent;

        const edit = document.createElement("button");
        edit.className = "qa-edit";
        edit.textContent = "改";
        edit.addEventListener("click", () => onEdit(i));

        row.append(qi, ai, edit);
        list.appendChild(row);
    });
    wrap.appendChild(list);
    return wrap;
}

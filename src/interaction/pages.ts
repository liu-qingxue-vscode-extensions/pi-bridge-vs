/**
 * pages.ts —— 一页的内容（B26 → B27 重做）
 *
 * 【三种页】
 *   ① 历史页（已答已发送 ✓）→ ★ 只读 ✗ 显示“问题 + 你的答案”✓
 *   ② 待答页（当前要答的 ✓）→ 题目 + 控件 ✓
 *   ③ 确认页（只在答卷模式 ✗）→ 列出全部问答 + [提交全部] ✓
 *
 * 【★ 为什么历史页只读？】
 *   串行扩展是 await 的 ✗ 我们答完必须【立刻发】✗（否则它不发下一题 ✓）
 *   → 发出去了就【改不了】✓ 所以是只读的 ✓
 *   （答卷模式下才可能回改 ✗ 因为那些答案还只是草稿 ✓）
 *
 * 【★ B27 的改动】
 *   只负责【内容】✗ 不再管页面的 padding / 居中 ✓
 *   —— 那是 views.ts 的 .content > .page 干的 ✓
 */
import { buildControls } from "./controls.js";
import type { UiReq, UiRes } from "./types.js";

/** 答案的可读文本 ✓ */
export function answerText(a: UiRes): string {
    if (a.cancelled) return "（取消本题）";
    if (a.confirmed !== undefined) return a.confirmed ? "确定" : "取消";
    return a.value ?? "";
}

/** 标题（扩展会把富文本塞进 title ✗ 必须保留换行 ✓）*/
export function titleEl(q: UiReq): HTMLElement {
    const t = document.createElement("div");
    t.className = "q-title";
    t.textContent = q.title || q.message || "";
    return t;
}

function messageEl(q: UiReq): HTMLElement | undefined {
    if (!q.message || !q.title) return undefined;
    const m = document.createElement("div");
    m.className = "q-message";
    m.textContent = q.message;
    return m;
}

/** ① 历史页：只读 ✓ */
export function historyBody(hist: { q: UiReq; a: UiRes }): HTMLElement {
    const wrap = document.createElement("div");
    wrap.appendChild(titleEl(hist.q));

    const row = document.createElement("div");
    row.className = "hist-row";
    const tag = document.createElement("span");
    tag.className = "hist-tag";
    tag.textContent = "✓ 已答（已发送）";
    const val = document.createElement("span");
    val.className = "hist-value";
    val.textContent = answerText(hist.a);
    row.append(tag, val);
    wrap.appendChild(row);
    return wrap;
}

/** ② 待答页 ✓ */
export function questionBody(
    q: UiReq,
    cur: UiRes | undefined,
    onDraft: (r: UiRes) => void,
    onCommit: (r: UiRes) => void,
): HTMLElement {
    const wrap = document.createElement("div");
    wrap.appendChild(titleEl(q));
    const m = messageEl(q);
    if (m) wrap.appendChild(m);
    wrap.appendChild(buildControls(q, cur, onDraft, onCommit));
    return wrap;
}

/** ③ 确认页：列出全部问答 ✓ */
export function confirmBody(
    queue: UiReq[],
    answers: Map<string, UiRes>,
    onEdit: (i: number) => void,
    onSubmit: () => void,
    canSubmit: boolean,
    missing: number,
): HTMLElement {
    const wrap = document.createElement("div");

    const t = document.createElement("div");
    t.className = "q-title";
    t.textContent = "确认提交";
    wrap.appendChild(t);

    const sub = document.createElement("div");
    sub.className = "q-message";
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

    // ★ 提交按钮（强制全部答完 ✓ 用户定的 ✓）
    const bar = document.createElement("div");
    bar.className = "opt-row";
    bar.style.marginTop = "14px";
    if (!canSubmit) {
        const hint = document.createElement("span");
        hint.className = "q-hint";
        hint.textContent = `★ 还有 ${missing} 题没答`;
        bar.appendChild(hint);
    }
    const ok = document.createElement("button");
    ok.className = "opt primary";
    ok.textContent = "提交全部";
    ok.disabled = !canSubmit;
    ok.addEventListener("click", onSubmit);
    bar.appendChild(ok);
    wrap.appendChild(bar);
    return wrap;
}

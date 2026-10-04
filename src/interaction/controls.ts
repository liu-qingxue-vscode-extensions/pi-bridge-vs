/**
 * controls.ts —— 四种交互控件（B26 → B27 重做）
 *
 * 【★★ 两个回调解耦（关键 ✗）】
 *   onDraft  ：内容变了（打字 ✓）→ 【只写草稿】✗ 绝不提交 ✓
 *   onCommit ：明确的“提交这个答案”动作 ✗（选项点击 / Enter ✓）
 *
 * 【为什么必须分开？】
 *   ★ 如果“内容变化”就等于“提交”✗：
 *     串行模式下用户在输入框里打第一个字 → 答案就发出去了 ✗✗✗
 *     （然后扩展立刻发下一题 ✗ 后面打的字全丢了 ✓）
 *
 * 【★★ B27 重做：自由书写框搬到【底部输入区】✗】
 *   旧版：自由书写框挤在选项下面 ✗ 又小又土 ✗
 *   新版：底部输入区（composer ✓）统一承担“自己写”✗
 *   → 本模块只画【选项按钮】✓ 输入框交给 views.ts 的 composer ✓
 */
import type { UiReq, UiRes } from "./types.js";
import { state } from "./state.js";

/**
 * ★★ 识别“自由书写”选项 ✗（B27 修 bug ✓）
 *
 * 【它是什么？】
 *   ask_user_question 之类的扩展会在 options 里塞一项 “Type something.”✗
 *   ★ 期望客户端【弹一个输入框】✗ 而不是把它当普通选项 ✓
 *
 * 【★★ 旧版的 bug ✗（用户报的 ✓）】
 *   我们把它当普通选项 ✗ → 点一下就【直接提交了 “Type something.” 这段文字】✗
 *   → 用户看到的现象：“点一下直接返回空 / 直接取消本题”✓
 *     （扩展收到那段文字无法识别 → 当成空/取消 ✓）
 *
 * 【修法】★ 不把它渲染成选项按钮 ✗ 而是让【底部输入区】承担 ✓
 *   它的原文拿来当输入框的 placeholder ✓（用户一眼就知道要写 ✓）
 */
const FREE_RE = /(type\s+something|^\s*\d+[.、)]?\s*(other|其他|自定义|自己(写|输入)))/i;

export function isFreeOption(opt: string): boolean {
    return FREE_RE.test(opt);
}

/** 把 options 拆成【真选项】和【自由书写提示】✓ */
export function splitOptions(q: UiReq): { real: string[]; freeText: string | undefined } {
    const real: string[] = [];
    let freeText: string | undefined;
    for (const o of q.options ?? []) {
        if (isFreeOption(o) && freeText === undefined) freeText = o;
        else real.push(o);
    }
    return { real, freeText };
}

export function buildControls(
    q: UiReq,
    cur: UiRes | undefined,
    onDraft: (r: UiRes) => void,
    onCommit: (r: UiRes) => void,
): HTMLElement {
    const body = document.createElement("div");

    if (q.method === "select") {
        body.className = "q-options";
        const { real } = splitOptions(q);
        real.forEach((opt, i) => {
            const b = document.createElement("button");
            b.className = "opt";
            // ★ data-kbd-index ✗ 让 ↑↓ 【只改高亮】而不重建整个面板 ✓
            //   （用户报的：“我明明在上边切选项，下面输入框的文字在闪”✓）
            b.dataset.kbdIndex = String(i);
            // ★ selected 与 kbd 互斥 ✗
            if (state.kbd < 0 && cur?.value === opt) b.classList.add("selected");
            if (state.kbd === i) b.classList.add("kbd");
            b.textContent = opt;
            b.addEventListener("click", () => onCommit({ value: opt })); // ★ 选项：一次点击即提交 ✓
            body.appendChild(b);
        });
        return body;
    }

    if (q.method === "confirm") {
        body.className = "opt-row";
        const pairs: Array<[string, boolean]> = [
            ["确定", true],
            ["取消", false],
        ];
        pairs.forEach(([text, val], i) => {
            const b = document.createElement("button");
            // ★★ 不要 primary ✗（用户反复报：“选中的明明是取消，确定还是高亮”✓）
            //   根因：.primary = 蓝底 ✗ 它【永远】看着像选中 ✓
            b.className = "opt";
            b.dataset.kbdIndex = String(i);
            if (state.kbd < 0 && cur?.confirmed === val) b.classList.add("selected");
            if (state.kbd === i) b.classList.add("kbd");
            b.textContent = text;
            b.addEventListener("click", () => onCommit({ confirmed: val }));
            body.appendChild(b);
        });
        return body;
    }

    if (q.method === "editor") {
        // ★ editor 要长文本 ✗ 放在内容区（不进 composer ✓）
        const ta = document.createElement("textarea");
        ta.className = "editor-area";
        ta.value = cur?.value ?? q.prefill ?? "";
        ta.addEventListener("input", () => onDraft({ value: ta.value }));
        ta.addEventListener("keydown", (e) => {
            // ★ Enter 留给换行 ✗ 用 Ctrl/Cmd+Enter 提交 ✓
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                onCommit({ value: ta.value });
            }
        });
        body.appendChild(ta);

        // ★★ editor 自己的按钮行 ✗（用户定的：单独配一个 ✓）
        //   为什么不在底部 composer？→ editor 的输入区就在内容区 ✗
        //    底部再摆一个空输入框很怪 ✓
        const bar = document.createElement("div");
        bar.className = "opt-row";
        bar.style.marginTop = "12px";
        const ok = document.createElement("button");
        ok.className = "opt primary";
        ok.textContent = "提交（Ctrl+Enter）";
        ok.addEventListener("click", () => onCommit({ value: ta.value }));
        // ★ “取消本页”不在这里 ✗ —— 底部导航行已经有一个了 ✓
        //   （用户：“取消本页倒是有点多余了”✓）
        bar.append(ok);
        body.appendChild(bar);

        setTimeout(() => ta.focus(), 0);
        return body;
    }

    // ★ input：输入框在底部 composer 里 ✗ 这里只留空 ✓
    body.className = "q-options";
    return body;
}

/** 当前答案是不是“自由书写”的值（不在选项里 ✓）*/
export function isFreeValue(q: UiReq, cur: UiRes | undefined): boolean {
    if (!cur || cur.value === undefined) return false;
    return !(q.options ?? []).includes(cur.value);
}

/**
 * controls.ts —— 四种交互控件（B26）
 *
 * 【★★ 两个回调解耦（关键 ✗）】
 *   onDraft  ：内容变了（打字 / 点了选项 ✓）→ 【只写草稿】✗ 绝不提交 ✓
 *   onCommit ：明确的“提交这个答案”动作 ✗（选项点击 / Enter / Ctrl+Enter ✓）
 *
 * 【为什么必须分开？】
 *   ★ 如果“内容变化”就等于“提交”✗：
 *     串行模式下用户在「✍ 自己写…」框里打第一个字 → 答案就发出去了 ✗✗✗
 *     （然后扩展立刻发下一题 ✗ 后面打的字全丢了 ✓）
 *   → 所以：打字只写草稿 ✗ 提交必须是【一个明确的动作】✓
 *
 * 【各 method 的提交动作】
 *   select  → 点选项（一次点击就完成 ✓）/ 自由书写框按 Enter ✓
 *   confirm → 点确定/取消 ✓
 *   input   → 按 Enter ✓
 *   editor  → Ctrl/Cmd+Enter ✗（Enter 要留给换行 ✓）
 */
import type { UiReq, UiRes } from "./types.js";

export function buildControls(
    q: UiReq,
    cur: UiRes | undefined,
    onDraft: (r: UiRes) => void,
    onCommit: (r: UiRes) => void,
): HTMLElement {
    const body = document.createElement("div");
    body.className = "uir-body";

    if (q.method === "select") {
        for (const opt of q.options ?? []) {
            const b = document.createElement("button");
            // ★ .uir-choice → 各占一行 ✗（长选项并排会撑爆卡片 ✓）
            b.className = "uir-opt uir-choice";
            if (cur?.value === opt) b.classList.add("selected");
            b.textContent = opt;
            b.addEventListener("click", () => {
                clearSelected(body); // 单选 ✓
                b.classList.add("selected");
                freeInp.value = ""; // ★ 选了预选项就清掉自由书写框 ✗
                onCommit({ value: opt });
            });
            body.appendChild(b);
        }

        // ★★ 自由书写（B26）✗
        //   TUI 里每个问答都有（ask_user_question 的 “Type something.” ✗）
        //   ★ 协议里 select 只能回一个字符串 ✗ → 自由写的结果也是 value ✓
        //     与选项同一个形状 ✓ 扩展无感 ✓
        const row = document.createElement("div");
        row.className = "free-row";
        const freeInp = document.createElement("input");
        freeInp.type = "text";
        freeInp.placeholder = "✍ 自己写…";
        // ★ 已答的值不在选项里 = 自由写的 ✓ 回填 ✓
        const isFree = cur?.value !== undefined && !(q.options ?? []).includes(cur.value);
        if (isFree) freeInp.value = cur?.value ?? "";
        freeInp.addEventListener("input", () => {
            clearSelected(body); // 一打字就取消选项高亮 ✓
            onDraft({ value: freeInp.value }); // ★ 只写草稿 ✗
        });
        freeInp.addEventListener("keydown", (e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            onCommit({ value: freeInp.value }); // ★ 这才提交 ✓
        });
        row.appendChild(freeInp);
        body.appendChild(row);
        return body;
    }

    if (q.method === "confirm") {
        const pairs: Array<[string, boolean]> = [
            ["确定", true],
            ["取消", false],
        ];
        for (const [text, val] of pairs) {
            const b = document.createElement("button");
            b.className = "uir-opt" + (val ? " primary" : "");
            if (cur?.confirmed === val) b.classList.add("selected");
            b.textContent = text;
            b.addEventListener("click", () => {
                clearSelected(body);
                b.classList.add("selected");
                onCommit({ confirmed: val });
            });
            body.appendChild(b);
        }
        return body;
    }

    if (q.method === "input") {
        const inp = document.createElement("input");
        inp.type = "text";
        inp.placeholder = q.placeholder ?? "";
        inp.value = cur?.value ?? q.prefill ?? "";
        inp.addEventListener("input", () => onDraft({ value: inp.value }));
        inp.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                onCommit({ value: inp.value });
            }
            if (e.key === "Escape") inp.blur(); // 让全局 Esc 处理（= 取消 ✓）
        });
        body.appendChild(inp);
        setTimeout(() => inp.focus(), 0);
        return body;
    }

    // editor ✓（★ Enter 留给换行 ✗ 用 Ctrl/Cmd+Enter 提交 ✓）
    const ta = document.createElement("textarea");
    ta.value = cur?.value ?? q.prefill ?? "";
    ta.addEventListener("input", () => onDraft({ value: ta.value }));
    ta.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            onCommit({ value: ta.value });
        }
    });
    body.appendChild(ta);
    setTimeout(() => ta.focus(), 0);
    return body;
}

function clearSelected(scope: HTMLElement): void {
    scope.querySelectorAll(".selected").forEach((e) => e.classList.remove("selected"));
}

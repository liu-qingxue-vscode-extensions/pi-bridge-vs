/**
 * ui-request.ts —— 扩展交互回复桥的前端（B25）
 *
 * 【它解决什么？】
 *   扩展（llama / mcp-adapter / 各种插件）会向用户提问 ✗：
 *     select  → 从列表选一项
 *     confirm → 是 / 否
 *     input   → 单行输入
 *     editor  → 多行编辑
 *   pi 把问题发给我们（extension_ui_request ✓）
 *   我们把用户的选择回给 pi（extension_ui_response ✓）
 *
 * 【★ 不做会怎样？】
 *   那个扩展【会一直卡住】✗ 直到 pi 侧超时 ✓
 *   （有 timeout 的话 ✓）→ 所以这不只是体验问题 ✗ 是功能可用性问题 ✓
 *
 * 【UI 放哪？】
 *   输入区【上方】（和「待插话」条同一区域 ✓）
 *   为什么？→ 它是【临时问答】✗ 不属消息流 ✓
 *   也不该做成浮层 ✗ —— 它会挡住你看 pi 正在说什么 ✓
 *
 * 【★ 一次只显示一个】
 *   多个请求来了就【排队】✗（pi 侧本来也是串行等 ✓）
 */
import { uiRequestEl } from "./dom.js";
import { vscode } from "./vscode-api.js";
import { ui } from "./state.js";
import { syncPadding } from "./input.js";

interface UiReq {
    id: string;
    method: "select" | "confirm" | "input" | "editor";
    title: string;
    message?: string;
    options?: string[];
    placeholder?: string;
    prefill?: string;
    timeout?: number;
}

/** ★ 当前显示中的请求（同一时刻只有一个 ✓ 其余排队 ✓）*/
let current: UiReq | null = null;
const queue: UiReq[] = [];

function reply(id: string, r: { value?: string; confirmed?: boolean; cancelled?: boolean }): void {
    vscode.postMessage({ kind: "uiResponse", id, ...r });
}

/**
 * ★ 清空当前显示，看有没有排队的 ✓
 *
 * ★★ 每次变化都要通知输入区重算【底部留白】✗（B25 踩到 ✓）
 *   因为卡片在 #input-area 里 ✓ 它的高度会改变 input-area 的高度 ✓
 *   而消息区的 padding-bottom = inputAreaEl.offsetHeight + 动作区 ✓
 *   → 不重算 → ★ 最后几条消息【被卡片盖住】✓（用户报的 ✓）
 */
function next(): void {
    current = null;
    uiRequestEl.textContent = "";
    uiRequestEl.dataset.empty = "true";
    syncPadding();
    const n = queue.shift();
    if (n) showUiRequest(n);
}

/** 渲染一个交互请求 ✓ */
export function showUiRequest(p: UiReq): void {
    if (current) {
        // ★ 已有请求在显示 → 排队 ✓（不覆盖，否则前一个永远回不了 ✓）
        queue.push(p);
        return;
    }
    current = p;
    uiRequestEl.dataset.empty = "false";
    uiRequestEl.textContent = "";

    const box = document.createElement("div");
    box.className = "uir-box";

    const head = document.createElement("div");
    head.className = "uir-head";
    const tag = document.createElement("span");
    tag.className = "uir-tag";
    tag.textContent = "pi 需要回答";
    const title = document.createElement("span");
    title.className = "uir-title";
    title.textContent = p.title || p.message || "";
    head.append(tag, title);
    if (p.method !== "editor") {
        // ★ editor 要用户编辑，放一个取消按钮更明显 ✓
    }
    box.appendChild(head);

    if (p.message && p.title) {
        const msg = document.createElement("div");
        msg.className = "uir-message";
        msg.textContent = p.message;
        box.appendChild(msg);
    }

    const body = document.createElement("div");
    body.className = "uir-body";

    const done = (r: { value?: string; confirmed?: boolean; cancelled?: boolean }) => {
        reply(p.id, r);
        next();
    };

    if (p.method === "select") {
        for (const opt of p.options ?? []) {
            const b = document.createElement("button");
            // ★ 加 .uir-choice：CSS 靠它让选项【各占一行】✗（B25 ✓）
            //   为什么不让所有 .uir-opt 都占一行？
            //     → confirm 的确定/取消、input 的确定，都该并排 ✓
            b.className = "uir-opt uir-choice";
            b.textContent = opt;
            b.addEventListener("click", () => done({ value: opt }));
            body.appendChild(b);
        }
    } else if (p.method === "confirm") {
        const yes = document.createElement("button");
        yes.className = "uir-opt primary";
        yes.textContent = "确定";
        yes.addEventListener("click", () => done({ confirmed: true }));
        const no = document.createElement("button");
        no.className = "uir-opt";
        no.textContent = "取消";
        no.addEventListener("click", () => done({ confirmed: false }));
        body.append(yes, no);
    } else if (p.method === "input") {
        const inp = document.createElement("input");
        inp.type = "text";
        inp.placeholder = p.placeholder ?? "";
        inp.value = p.prefill ?? "";
        const ok = document.createElement("button");
        ok.className = "uir-opt primary";
        ok.textContent = "确定";
        ok.addEventListener("click", () => done({ value: inp.value }));
        inp.addEventListener("keydown", (e) => {
            if (e.key === "Enter") done({ value: inp.value });
            if (e.key === "Escape") done({ cancelled: true });
        });
        body.append(inp, ok);
        setTimeout(() => inp.focus(), 0);
    } else if (p.method === "editor") {
        const ta = document.createElement("textarea");
        ta.rows = 6;
        ta.value = p.prefill ?? "";
        const ok = document.createElement("button");
        ok.className = "uir-opt primary";
        ok.textContent = "提交";
        ok.addEventListener("click", () => done({ value: ta.value }));
        const cancel = document.createElement("button");
        cancel.className = "uir-opt";
        cancel.textContent = "取消";
        cancel.addEventListener("click", () => done({ cancelled: true }));
        const bar = document.createElement("div");
        bar.className = "uir-bar";
        bar.append(ok, cancel);
        body.append(ta, bar);
        setTimeout(() => ta.focus(), 0);
    }

    // ★ 取消（select / input 也都要 ✓ 不能只给 confirm ✓）
    if (p.method === "select") {
        const cancel = document.createElement("button");
        cancel.className = "uir-opt cancel";
        cancel.textContent = "取消";
        cancel.addEventListener("click", () => done({ cancelled: true }));
        body.appendChild(cancel);
    }

    box.appendChild(body);
    uiRequestEl.appendChild(box);
    // ★★ 关键：卡片一出现就重算消息区留白 ✗（否则盖住最后几条消息 ✓）
    //   用 requestAnimationFrame ✗ —— 要等布局完成才量得准高度 ✓
    requestAnimationFrame(() => syncPadding());
}

export function setupUiRequest(): void {
    // ★ Esc 取消当前请求 ✓（不抢输入框的 Esc：只在有请求时接管 ✓）
    document.addEventListener("keydown", (e) => {
        if (e.key !== "Escape" || !current) return;
        const t = e.target as HTMLElement | null;
        // 正在 input / textarea 里打字的话，让它们的自定义 Esc 处理 ✓
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
        reply(current.id, { cancelled: true });
        next();
    });
}

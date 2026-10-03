/**
 * compact.ts —— 压缩上下文（B22）：按钮 + 压缩气泡
 *
 * 【为什么需要"压缩"？】
 *   上下文窗口是有限的 ✓ 聊久了必然装不下 ✗
 *   压缩 = 让 LLM 把前面的历史【总结成一段】✓ 然后丢掉原文 ✓
 *
 * 【三种触发原因（实测自 pi 源码 agent-session.js ✓）】
 *   manual    → 用户点了按钮 ✓（本模块的按钮 ✓）
 *   threshold → ★【提前预防】✗ 上下文用量到了阈值就自动压 ✓ 不打断任何东西 ✓
 *   overflow  → ★【已经出事了】✗ AI 的一次响应超窗口失败 / 被 maxTokens 截断 ✓
 *               pi 的救场：剔除那条坏消息 → 压缩 → ★【自动重试一次】✓
 *               → 用户的 prompt 不会丢 ✓ 会重跑 ✓
 *               → ★ 重试还失败才带 errorMessage（这时才是真失败 ✓）
 *
 * 【气泡为什么不进快照？】
 *   和重连提示同理 ✓：它是【过程事件】✗ 不进会话文件 ✓
 *   → webview 重建后自然消失 ✓ 语义天然对齐 ✓
 */
import { btnCompact, messagesEl } from "./dom.js";
import { vscode } from "./vscode-api.js";
import { ui } from "./state.js";
import { scrollToBottom } from "./bubbles.js";

/** 三种原因的中文说法 */
const REASON_TEXT: Record<string, string> = {
    manual: "手动触发",
    threshold: "上下文接近上限（自动预防）",
    overflow: "★ 上一次响应超窗口（自动救场）",
};

/** 点按钮 → 请宿主发 compact ✓ */
export function setupCompact(): void {
    btnCompact.addEventListener("click", () => {
        // ★ 视觉反馈（压缩可能要跑十几秒 ✗ 不反馈像没反应 ✓）
        btnCompact.classList.add("spinning");
        vscode.postMessage({ kind: "compact" });
        // ★ 兜底：30 秒后无论如何解除转圈 ✗
        //   万一【没收到 compaction_end】（比如命令本身报错 ✓ 或者 pi 挂了 ✓）
        //   → 不兜底的话它会【永远转下去】✗ 看着像卡死 ✓
        setTimeout(() => btnCompact.classList.remove("spinning"), 30000);
    });
}

/** 拿到（或新建）本次压缩的气泡 —— 同一批压缩复用同一个气泡 ✓ */
function ensureBubble(): HTMLElement {
    let el = ui.compactBubbleEl;
    if (!el || el.dataset.done === "true") {
        const wrap = document.createElement("div");
        wrap.className = "bubble-wrap notice";
        el = document.createElement("div");
        el.className = "bubble notice compact";
        el.dataset.done = "false";
        wrap.appendChild(el);
        messagesEl.appendChild(wrap);
        ui.compactBubbleEl = el;
        scrollToBottom();
    }
    return el;
}

/** 压缩开始 → 建气泡「正在压缩上下文…」 */
export function showCompactionStart(p: { reason?: string }): void {
    const el = ensureBubble();
    el.classList.remove("failed", "ok");
    el.dataset.done = "false";
    const why = REASON_TEXT[p.reason ?? ""] ?? p.reason ?? "";
    el.textContent = `正在压缩上下文…（${why}）`;
    btnCompact.classList.add("spinning");
    scrollToBottom();
}

/**
 * 压缩结束 → 原地改成结果 ✓
 *
 * 四种结局：
 *   aborted         → 被中断（点了中断按钮 / 手动取消 ✓）
 *   errorMessage    → ★ 真失败（overflow 救场重试也失败了 ✓）
 *   willRetry       → 完成了，正在重试刚才那次请求 ✓
 *   else            → 正常完成 ✓ 显示省了多少 token ✓
 */
export function showCompactionEnd(p: {
    reason?: string;
    aborted?: boolean;
    willRetry?: boolean;
    errorMessage?: string;
    tokensBefore?: number;
    tokensAfter?: number;
}): void {
    btnCompact.classList.remove("spinning");
    const el = ensureBubble();
    el.dataset.done = "true";

    const fmt = (n?: number) =>
        typeof n === "number" ? (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)) : "?";

    if (p.errorMessage) {
        // ★ 真失败（最重的一种 ✗）
        el.classList.add("failed");
        el.textContent = `压缩失败：${p.errorMessage}`;
        return;
    }
    if (p.aborted) {
        el.textContent = "压缩被中断";
        return;
    }
    el.classList.add("ok");
    const saved =
        typeof p.tokensBefore === "number" && typeof p.tokensAfter === "number"
            ? `　${fmt(p.tokensBefore)} → ${fmt(p.tokensAfter)} tokens ✓`
            : "";
    const retry = p.willRetry ? "　正在重试刚才那次请求…" : "";
    el.textContent = `压缩完成${saved}${retry}`;
}

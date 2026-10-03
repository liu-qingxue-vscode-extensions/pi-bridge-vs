/**
 * notices.ts —— 提示气泡（重连提示 + 异常结束提示）
 *
 * 【为什么放在一起？】两者都是"贴在消息流里的提示气泡"，样式同类（.bubble.notice / .bubble-note）✓
 * 与 noticeboard.ts（顶栏下拉的通知面板）不同 ✗ —— 那个是过程通知，不是消息流里的东西
 */
import { messagesEl } from "./dom.js";
import { ui } from "./state.js";
import { removePending, scrollToBottom } from "./bubbles.js";

/** retryNotice 补丁的字段（与 ChatPatch 的 retryNotice 同构） */
interface RetryPatch {
    attempt?: number;
    maxAttempts?: number;
    delayMs?: number;
    message?: string;
    final?: boolean;
    success?: boolean;
}

/**
 * 重连提示气泡（同一个气泡内【原地更新】→ 能看到 1/3 → 2/3 → 3/3 的变化 ✓）
 * ★ 不进快照 → webview 重建后自然消失 ✓（语义对齐：它本来就不进会话文件）
 * ★ 出现之后【一直留着】（下次对话也不挤掉 ✗）
 */
export function showRetryNotice(p: RetryPatch): void {
    // ★ 进入重试状态 → 占位三点应该消失（被重试气泡取代 ✓）
    removePending();

    // ★ 什么时候开【新】气泡？
    //   判据：上一个气泡已经【终结】（final=true）→ 那才是新一批 ✓
    //   不能用 p.attempt === 1 ✗：实测 attempt 会跨批次重置（1,2,3 … 又是 1,2）✗
    //   → 用 attempt===1 会在旧气泡还活着时就新建 → 旧气泡变成【僵尸】永远转圈 ✗
    let el = ui.retryNoticeEl;
    if (!el || el.dataset.final === "true") {
        // ★ 包 wrapper（与其它气泡同构 ✓）
        const wrap = document.createElement("div");
        wrap.className = "bubble-wrap notice";
        el = document.createElement("div");
        el.className = "bubble notice retry";
        el.dataset.final = "false";
        wrap.appendChild(el);
        messagesEl.appendChild(wrap);
        ui.retryNoticeEl = el;
    }
    const isFinal = p.final === true;
    el.dataset.final = isFinal ? "true" : "false"; // ★ 供下一次判定"是否新一批"使用 ✓

    // ★ 中断 ≠ 成功：pi 两者都发 success:true 无 finalError ✗ → 用我们自己的标志判定 ✓
    const aborted = isFinal && ui.userAborted;
    const ok = isFinal && p.success === true && !aborted;
    el.classList.toggle("failed", aborted || (isFinal && !ok));
    el.classList.toggle("retrying", !isFinal);
    el.classList.toggle("ok", ok);

    // 进度：1/3
    const attempt =
        p.attempt && p.maxAttempts
            ? p.attempt + "/" + p.maxAttempts
            : p.attempt
              ? String(p.attempt)
              : "";

    // 文案：尽量复用 pi 给的原文（errorMessage / finalError）✓
    let text: string;
    if (isFinal) {
        if (aborted) {
            text = "已中断";
        } else if (ok) {
            text = "重连成功" + (attempt ? "（第 " + attempt + " 次尝试）" : "");
        } else {
            text =
                "重连失败" +
                (attempt ? "（已尝试 " + attempt + " 次）" : "") +
                "：" +
                (p.message || "未知错误");
        }
    } else {
        const parts = ["连接中断，正在重试"];
        if (attempt) parts.push("（" + attempt + "）");
        if (p.message) parts.push(" · " + p.message);
        if (p.delayMs) parts.push(" · " + Math.round(p.delayMs / 1000) + " 秒后");
        text = parts.join("");
    }

    // 图标：进行中 = 转圈（红色 ✓）；最终 = ■ / ✓ / ✖
    const icon = isFinal
        ? aborted
            ? '<span class="notice-mark">■</span>'
            : ok
              ? '<span class="notice-mark">✓</span>'
              : '<span class="notice-mark">✖</span>'
        : '<span class="retry-spin"></span>';

    // ★ 固定结构（只在第一次建）+ textContent 写入（防注入 ✓）
    el.innerHTML = icon + '<span class="notice-text"></span>';
    el.querySelector(".notice-text")!.textContent = text;
    scrollToBottom();
}

/**
 * 异常结束提示（stopReason）—— ★ 突发情况，要【正常大小/正常颜色】地显示 ✓
 * 只处理异常：length（截断）/ aborted（中断）/ error（出错）
 * 正常结束（stop / toolUse）根本不会进来 ✓
 */
export function appendStopNote(reason: string): void {
    // 挂在【最后一条 AI 气泡】底部（思考/正文/工具气泡都算）
    // ★ 必须排除 .notice（重试气泡）：否则提示会跑到重试气泡里面 ✗（两个气泡叠在一起）
    const all = messagesEl.querySelectorAll(".bubble:not(.user):not(.pending):not(.notice)");
    const target = all[all.length - 1] as HTMLElement | undefined;
    if (!target) return;
    if (target.querySelector(".bubble-note")) return; // 防重复

    const MAP: Record<string, { icon: string; text: string; cls: string }> = {
        length: { icon: "⚠", text: "输出达到长度上限，已截断", cls: "warn" },
        aborted: { icon: "■", text: "已中断", cls: "info" },
        error: { icon: "✖", text: "生成出错", cls: "error" },
    };
    const m = MAP[reason] ?? { icon: "•", text: reason, cls: "info" };
    const el = document.createElement("div");
    el.className = "bubble-note " + m.cls;
    el.textContent = m.icon + " " + m.text;
    target.appendChild(el);
    scrollToBottom();
}

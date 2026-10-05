/**
 * segments.ts —— 「内容段 → 气泡」的分发（text / thinking）
 *
 * 【渲染模型】每个内容段 = 一个独立气泡（user / thinking / text / tool）
 *   类型变了就新建气泡；同类型连续流式内容则追加到同一个气泡 ✓
 *
 * 【为什么单独一个文件？】
 *   它同时依赖 bubbles（基础）和 thinking（建思考气泡）→
 *   放这里可以让 bubbles.ts 保持"不依赖上层" ✓（单向，无循环）
 */
import { ui } from "./state.js";
import { createBubble, removePending, scrollToBottom } from "./bubbles.js";
import { createThinkingBubble } from "./thinking.js";
import { appendMarkdown, finishMarkdown } from "./markdown.js";

/** 追加文本到"当前气泡"（thinking / text）；类型变了就新建气泡 */
export function appendSegment(kind: "thinking" | "text", text: string): void {
    removePending(); // ★ 真实内容来了 → 撤掉占位
    if (kind === "thinking") {
        if (!ui.bubble || !ui.bubble.classList.contains("thinking")) {
            ui.bubble = createThinkingBubble();
            if (!ui.thinkStartAt) ui.thinkStartAt = Date.now(); // 兜底计时
        }
        ui.bubble.querySelector(".think-body")!.textContent += text;
    } else {
        if (!ui.bubble || !ui.bubble.classList.contains(kind)) {
            ui.bubble = createBubble(kind);
        }
        // ★★ B29：正文走 MD 渲染 ✗（流式增量 ✓）
        //   思考块仍是纯文本 ✓（不需要排版 ✓）
        appendMarkdown(ui.bubble, text);
    }
    scrollToBottom();
}

/**
 * ★ 正文段结束（B29）
 *
 * 【为什么要封尾？】
 *   流式时最后一块一直是“尾块”（每次重渲染 ✓）
 *   如果它后面又接了新的段（比如接着来个工具调用 ✓）
 *   尾块会被继续改 ✗ 但它内容其实已经定了 ✓
 *   → 把它“封”成普通块 ✗ 不再追踪 ✓
 */
export function endSegment(): void {
    if (ui.bubble && ui.bubble.classList.contains("text")) {
        finishMarkdown(ui.bubble);
    }
}

/**
 * ★★ B40：pi 数据 → 工具结果的【唯一读取处】
 *
 * 【为什么要这个文件】
 * 数据进宿主有【多条通道】✗ 每条通道的字段名和嵌套都不一样：
 *
 *   通道                     形状
 *   ────────────────────────────────────────────────────────
 *   message_start            { message: { role, content, details, isError, toolCallId } }
 *   message（会话文件回放）    { role, content, details, isError, toolCallId }   ← 少一层
 *   tool_execution_end       { toolCallId, isError, result: { details } }
 *
 * 各自去 `.details` 的结果就是：**某条通道漏读某个字段**（B39 的 bug：
 * edit 的 patch 在重放通道丢了 ⇒ diff 画不出来 ✗ 而 grep 代码根本看不出问题）
 *
 * ⇒ 收敛到这里：**字段名只写一遍** ✓ 通道只负责"把原料递进来" ✓
 * ★ 以后 pi 改字段名 / 加字段 ⇒ 只改这里 ⇒ 不可能只改一半
 */

/** 工具结果里我们关心的那几个字段（★ 语义统一，与通道无关）*/
export interface ToolResultFacts {
    callId: string | undefined;
    /** 内容 parts（image / text ✗ 原样传递给前端分发）*/
    parts: unknown[];
    isError: boolean;
    /** ★ edit 的 diff / patch 就在这（丢失 = diff 消失）*/
    details: unknown;
}

/**
 * 读【消息型】toolResult（两处用：pi 推的 message_start / 会话文件回放）
 *
 * ★ 这两处的对象形状一致（都是 pi 的消息对象）✗ 只是套不套一层 message ✓
 *   ⇒ 调用方负责拆壳，这里只认消息本体 ✓
 */
export function readToolResultMessage(message: unknown): ToolResultFacts {
    const m = message as {
        content?: unknown;
        details?: unknown;
        isError?: unknown;
        toolCallId?: unknown;
    } | null;
    return {
        callId: typeof m?.toolCallId === "string" ? m.toolCallId : undefined,
        parts: Array.isArray(m?.content) ? m.content : [],
        isError: m?.isError === true,
        details: m?.details,
    };
}

/**
 * 读【执行结束型】（tool_execution_end 事件）
 *
 * ★ 形状不同：内容和错误在顶层 ✗ details 却埋在 result 里 ✓
 *   （实测：pi 的 tool_execution_end = { toolCallId, toolName, isError, result: { content, details } }）
 * ★ 注意这里【没有 content】：执行结束的 content 与随后 toolResult 消息重复 ✗
 *   实际渲染用的是 toolResult 消息那份 ✓ 这里只取 details + isError ✓
 */
export function readToolExecutionEnd(ev: unknown): {
    callId: string | undefined;
    isError: boolean;
    details: unknown;
} {
    const e = ev as {
        toolCallId?: unknown;
        isError?: unknown;
        result?: { details?: unknown };
    } | null;
    return {
        callId: typeof e?.toolCallId === "string" ? e.toolCallId : undefined,
        isError: e?.isError === true,
        details: e?.result?.details,
    };
}

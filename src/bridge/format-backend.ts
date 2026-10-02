/**
 * format-backend —— 后端 → 前端的【聊天渲染】翻译层
 *
 * 【它在数据流里的位置】
 *   pi 事件 → main.ts 扇出 →
 *       ├─ DebugPanel.log(原始数据)          ← 诊断用，不经过本层
 *       └─ toChatPatch(翻译) → ChatState      ← 本层在这
 *
 * 【设计：表驱动】
 * 每“消灭”一个 pi 事件，就在 formatMap 里加一条翻译规则。
 * 不在表里的事件 → 返回 undefined（表示“与聊天渲染无关”，直接忽略）。
 *
 * 【与 format-frontend 的不对称（故意的）】
 * - 后端 → 前端（本层）：不认识 = 不关心 → 忽略（数据是 pi 给的，不会丢）
 * - 前端 → 后端（format-frontend）：不认识 = 危险 → 抛错（别给 pi 发非法命令）
 */
import type {
    RpcResponse,
    RpcExtensionUIRequest,
    JsonAgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { ChatPatch } from "../view/chat-state.js";
import type { Usage } from "../view/chat-types.js";

/**
 * 后端输出的类型空间（我们讨论过的结论：pi 发给前端的一切都要包含进来）
 *   RpcResponse          —— 命令回执（{type:"response", command, success, ...}）
 *   JsonAgentSessionEvent —— 事件流（message_update / tool_execution_end / ...）大头
 *   RpcExtensionUIRequest —— pi 扩展要求 UI 交互（select/confirm/input/notify）
 */
export type BackendOutput = RpcResponse | JsonAgentSessionEvent | RpcExtensionUIRequest | PiStderrLine;

/**
 * 来自 pi 进程 stderr 的一行（诊断信息 / 错误）
 *
 * 它不是 pi 的 RPC 协议消息，而是我们从进程的第三通道（stderr）捕获的。
 * 纳入类型空间的原因：它是 pi 对我们的输出，必须能被前端展示（不得被“捂着”）。
 */
export type PiStderrLine = { type: "stderr"; text: string };

/** 转换函数：后端原始对象 → 渲染指令（不关心的返回 undefined） */
type BackendFormatter = (raw: BackendOutput) => ChatPatch | undefined;

/**
 * 从 message.content 里提取纯文本
 *
 * content 有两种形态（由导出数据实测）：
 *   - 字符串："hello"
 *   - 块数组：[{ type: "text", text: "..." }, { type: "image", ... }, ...]
 * 我们只取 text 块，其余（图片等）暂不处理。
 */
function extractText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter(
            (b): b is { type: string; text?: string } =>
                !!b && typeof b === "object" && (b as { type?: unknown }).type === "text",
        )
        .map((b) => b.text ?? "")
        .join("");
}

/**
 * 处理器表：pi 事件 → 聊天渲染指令
 *
 * 【本层只是“聊天渲染专用”的翻译器】
 * 调试板收的是【原始数据】（诊断用，不翻译），与本层无关 ——
 * 所以这里不关心的事件直接返回 undefined（而不是像以前那样原样透传）。
 *
 * 迭代：每“消灭”一个 pi 事件，就在这里加一条。
 */
const formatMap: Partial<Record<string, BackendFormatter>> = {
    /**
     * 消息开始 → 新建气泡 / 填回工具结果
     * - user / assistant：建气泡（内容在 message.content 里）
     * - toolResult：★ 不建气泡，而是按 toolCallId 填回对应的工具块
     *   （视觉上它们要拼成一个“工具气泡”）
     */
    message_start: (raw) => {
        const message = (raw as {
            message?: { role?: unknown; content?: unknown; toolCallId?: unknown; isError?: unknown };
        }).message;
        const role = message?.role;
        if (role === "user" || role === "assistant") {
            return { kind: "startBubble", role, text: extractText(message?.content) };
        }
        if (role === "toolResult") {
            if (typeof message?.toolCallId !== "string") return undefined;
            return {
                kind: "toolResult",
                callId: message.toolCallId,
                // ★ 原样传 content 数组 → 前端按 type 分发渲染（text / image / 兵底）
                parts: Array.isArray(message.content) ? message.content : [],
                isError: message?.isError === true,
            };
        }
        return undefined;
    },

    /** 流式更新 → 增量 / 工具块生命周期 */
    message_update: (raw) => {
        const ev = (raw as {
            assistantMessageEvent?: { type?: unknown; delta?: unknown; toolName?: unknown };
        }).assistantMessageEvent;
        const type = ev?.type;

        // 增量包（带 delta）
        if (typeof ev?.delta === "string") {
            if (type === "text_delta") return { kind: "append", block: "text", text: ev.delta };
            if (type === "thinking_delta")
                return { kind: "append", block: "thinking", text: ev.delta };
            if (type === "toolcall_delta") return { kind: "toolArgs", text: ev.delta };
        }

        // 工具调用边界（RPC 模式下 toolcall_start 带 id + toolName）
        const evId = (ev as { id?: unknown } | undefined)?.id;
        if (type === "toolcall_start" && typeof ev?.toolName === "string" && typeof evId === "string") {
            return { kind: "toolStart", name: ev.toolName, callId: evId };
        }
        // ★ 参数拼完：直接取【解析好的对象】（toolCall.arguments），交给前端渲染成键值对
        if (type === "toolcall_end") {
            const toolCall = (ev as { toolCall?: { arguments?: unknown } } | undefined)?.toolCall;
            return { kind: "toolEnd", args: toolCall?.arguments };
        }

        // 思考边界（前端用它计时：正在思考… → 已思考（用时 X 秒））
        if (type === "thinking_start") return { kind: "thinkStart" };
        if (type === "thinking_end") return { kind: "thinkEnd" };

        return undefined; // 其余边界包（*_start / *_end）暂不处理
    },

    /**
     * 工具【执行】阶段（工具真正跑起来的这段时间）
     *
     * ★ 为什么单独处理？
     *   toolcall_*  = LLM 生成参数（流式 JSON）
     *   tool_execution_* = pi 真正执行工具 ← 原本完全没渲染 → 界面这段是黑的 ✗
     *   toolResult  = 最终结果
     *
     * ★ tool_execution_update.partialResult 是【累积全文】（实测 ✗不是增量）
     *   → 前端每次【替换】而不是追加 ✓
     */
    tool_execution_start: (raw) => {
        const ev = raw as { toolCallId?: unknown; toolName?: unknown };
        if (typeof ev.toolCallId !== "string") return undefined;
        return {
            kind: "toolExecStart",
            callId: ev.toolCallId,
            name: typeof ev.toolName === "string" ? ev.toolName : "",
        };
    },
    tool_execution_update: (raw) => {
        const ev = raw as { toolCallId?: unknown; partialResult?: { content?: unknown } };
        if (typeof ev.toolCallId !== "string") return undefined;
        return {
            kind: "toolExecUpdate",
            callId: ev.toolCallId,
            // 结构与 toolResult.message.content 【完全同构】✓ → 渲染层可复用 ✓
            parts: Array.isArray(ev.partialResult?.content) ? ev.partialResult.content : [],
        };
    },
    tool_execution_end: (raw) => {
        const ev = raw as { toolCallId?: unknown; isError?: unknown };
        if (typeof ev.toolCallId !== "string") return undefined;
        return { kind: "toolExecEnd", callId: ev.toolCallId, isError: ev.isError === true };
    },

    /** 消息结束 → 封口气泡（工具结果不需要，它已在 message_start 填回去了） */
    message_end: (raw) => {
        const m = (raw as {
            message?: {
                role?: unknown;
                stopReason?: unknown;
                usage?: Usage;
                model?: unknown;
            };
        }).message;
        const role = m?.role;
        if (role !== "user" && role !== "assistant") return undefined;
        // ★ 只把【用户需要知道的】异常带出来：length（截断）/ aborted（中断）
        //
        // 【为什么不带 error？】实测（test_date/pi-debug-1.json）：
        //   pi 在自动重试时，会对【每一次失败的尝试】都发一条
        //   message_end(stopReason="error")，且内容为空（len=0）✗
        //   这些是中间产物 → 它们的错误已经由 auto_retry 气泡呈现 ✓
        //   若再挂“生成出错”，它会贴到【上一条正常回复】底部 ✗✗✗
        const sr = typeof m?.stopReason === "string" ? m.stopReason : undefined;
        const abnormal = sr === "length" || sr === "aborted" ? sr : undefined;
        return {
            kind: "endBubble",
            role,
            stopReason: abnormal,
            // ★ token 用量 + 模型名（顶部状态栏的数据源 ✓）
            usage: m?.usage,
            model: typeof m?.model === "string" ? m.model : undefined,
        };
    },

    /**
     * 任务级状态（驱动状态条 + 发送按钮形态）
     * - agent_start：任务开始（用户发消息后）→ working
     * - agent_settled：彻底空闲（重试/队列都空了）→ idle
     * （agent_end 不单独处理：它后面几乎总跟 settled）
     */
    agent_start: () => ({ kind: "agentState", state: "working" }),
    agent_settled: () => ({ kind: "agentState", state: "idle" }),

    /**
     * ★ 自动重连（断网 / 连接中断时 pi 自己发起）
     *
     * 【为什么单独做？】
     *   它【不进会话文件】✓ → webview 重建后自然消失 ✓ 语义天然对齐
     *   在此之前它是全黑箱 ✗：连接断了重试中，界面一动不动
     *
     * 【实测字段（真实抓包 2025）】
     *   auto_retry_start: { attempt, maxAttempts, delayMs, errorMessage }
     *   auto_retry_end:   { success, attempt, finalError }
     */
    auto_retry_start: (raw) => {
        const ev = raw as {
            attempt?: unknown;
            maxAttempts?: unknown;
            delayMs?: unknown;
            errorMessage?: unknown;
        };
        return {
            kind: "retryNotice",
            attempt: typeof ev.attempt === "number" ? ev.attempt : undefined,
            maxAttempts: typeof ev.maxAttempts === "number" ? ev.maxAttempts : undefined,
            delayMs: typeof ev.delayMs === "number" ? ev.delayMs : undefined,
            message: typeof ev.errorMessage === "string" ? ev.errorMessage : undefined,
        };
    },
    auto_retry_end: (raw) => {
        const ev = raw as { success?: unknown; attempt?: unknown; finalError?: unknown };
        return {
            kind: "retryNotice",
            attempt: typeof ev.attempt === "number" ? ev.attempt : undefined,
            message: typeof ev.finalError === "string" ? ev.finalError : undefined,
            final: true,
            success: ev.success === true,
        };
    },
};

/**
 * 统一入口：后端对象 → 聊天渲染指令
 * 找不到处理器 → undefined（表示“这个事件与聊天渲染无关”）
 */
export function toChatPatch(raw: BackendOutput): ChatPatch | undefined {
    const type = (raw as { type?: string }).type;
    const formatter = type ? formatMap[type] : undefined;
    return formatter ? formatter(raw) : undefined;
}

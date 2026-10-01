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
     * 消息开始 → 新建气泡
     * - user：内容在 message.content 里（非流式）
     * - assistant：content 为空，靠 delta 累积
     * - toolResult：工具执行结果（非流式，内容在 content 里）→ 映射为 role="tool"
     */
    message_start: (raw) => {
        const message = (raw as { message?: { role?: unknown; content?: unknown } }).message;
        const role = message?.role;
        if (role === "user" || role === "assistant") {
            return { kind: "startBubble", role, text: extractText(message?.content) };
        }
        if (role === "toolResult") {
            return { kind: "startBubble", role: "tool", text: extractText(message?.content) };
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

        // 工具块边界（RPC 模式下 toolcall_start 带 toolName）
        if (type === "toolcall_start" && typeof ev?.toolName === "string") {
            return { kind: "toolStart", name: ev.toolName };
        }
        if (type === "toolcall_end") return { kind: "toolEnd" };

        return undefined; // 其余边界包（*_start / *_end）暂不处理
    },

    /** 消息结束 → 封口气泡 */
    message_end: (raw) => {
        const role = (raw as { message?: { role?: unknown } }).message?.role;
        if (role === "user" || role === "assistant") return { kind: "endBubble", role };
        if (role === "toolResult") return { kind: "endBubble", role: "tool" };
        return undefined;
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

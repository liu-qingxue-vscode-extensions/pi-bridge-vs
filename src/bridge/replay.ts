/**
 * replay —— 把【已存在的会话消息】重放成气泡
 *
 * 【用在哪？】
 *   切换会话（switch_session）之后 → 界面是空的 ✗
 *   要能看到那个会话的旧对话 → 就得把历史消息渲染出来 ✓
 *
 * 【★ 关键洞察：结构是同构的】
 *   pi 的 get_messages 返回的 message，和我们【在事件流里消费的】结构一致 ✓
 *     role              → user / assistant / toolResult
 *     content[]         → { type: "text" | "thinking" | "toolCall" | "image" }
 *     toolCallId/isError → 工具结果
 *   → 所以不用新写一套渲染 ✗，直接把每条 message【拆成 ChatPatch】喂给 ChatState ✓
 *     它怎么处理流式的，就怎么处理历史的 ✓（同一套气泡逻辑 ✓）
 *
 * 【和实时流的区别】
 *   实时：pi 一条条推 message_start / message_update / message_end
 *   历史：我们一次拿到【合并后的最终 message】☑ 少了流式的中间态 ✓
 *   → 所以这里直接"一次性补齐内容"，不模拟逐字流式 ✗（没意义 ✓）
 */

/** pi 消息里的内容块（只声明用到的字段 ✓） */
interface ContentPart {
    type?: string;
    /** text 块 */
    text?: string;
    /** thinking 块 */
    thinking?: string;
    /** toolCall 块 */
    id?: string;
    name?: string;
    arguments?: unknown;
    /** image 块 */
    data?: string;
    mimeType?: string;
}

/** pi 的一条消息（get_messages 的返回项 ✓） */
import { readToolResultMessage } from "./tool-facts.js";

/** ★★ B46：压缩条目的内容（会话文件里 type=compaction ✗ 见 session-file.ts）*/
export interface CompactionInfo {
    /** 摘要（markdown 源文）*/
    summary: string;
    /** 压缩前的 token 数（"Compacted from N tokens" ✓）*/
    tokensBefore?: number;
    /** 压缩发生的时间（ISO 串）*/
    time?: string;
}

export interface ReplayMessage {
    role?: string;
    content?: unknown;
    /** toolResult 用 */
    toolCallId?: string;
    isError?: boolean;
    /** ★ B39：toolResult 顶层的附加信息（edit 的 patch 就在这 ✓ 重放必须带上）*/
    details?: unknown;
    /** assistant 用 */
    stopReason?: string;
    usage?: unknown;
    model?: string;
    /** ★ B46：压缩条目专用（role="__compaction" 时才有 ✓）*/
    compaction?: CompactionInfo;
}

/** 一条渲染指令（与 ChatPatch 同形 —— 这里只声明用到的 ✓） */
type Patch =
    | { kind: "startBubble"; role: "user" | "assistant"; text: string }
    // ★ B46：压缩气泡（摘要 + 压缩前的 token 数）
    | { kind: "compactionBubble"; summary: string; tokensBefore?: number; time?: string }
    | { kind: "append"; block: "text" | "thinking"; text: string }
    | {
          kind: "endBubble";
          role: "user" | "assistant";
          stopReason?: string;
          usage?: unknown;
          model?: string;
      }
    | { kind: "toolStart"; name: string; callId: string }
    | { kind: "toolEnd"; args: unknown }
    | { kind: "toolResult"; callId: string; parts: unknown[]; isError: boolean; details?: unknown };

/** 把 content 切成数组（可能是字符串 ✓ 也可能是数组 ✓） */
function partsOf(content: unknown): ContentPart[] {
    if (typeof content === "string") return [{ type: "text", text: content }];
    if (Array.isArray(content)) return content as ContentPart[];
    return [];
}

/** 从 content 里抽纯文本（用户消息用 ✓） */
function textOf(content: unknown): string {
    return partsOf(content)
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("");
}

/**
 * 把历史消息列表 → 一串渲染指令
 *
 * 【为什么返回指令而不是直接改 ChatState？】
 *   这样本模块【不依赖 ChatState】✓ 纯函数 ✓ 可单测 ✓
 *   调用方按顺序 apply 即可 ✓
 */
export function messagesToPatches(messages: ReplayMessage[]): Patch[] {
    const out: Patch[] = [];

    for (const msg of messages) {
        const role = msg.role;

        // ── ★ B46：压缩条目 → 一个压缩气泡（不建普通气泡 ✓）──
        if (role === "__compaction") {
            const c = msg.compaction;
            if (c?.summary) {
                out.push({ kind: "compactionBubble", summary: c.summary, tokensBefore: c.tokensBefore, time: c.time });
            }
            continue;
        }

        // ── 用户消息：整条 = 一个气泡 ✓ ──
        if (role === "user") {
            out.push({ kind: "startBubble", role: "user", text: textOf(msg.content) });
            out.push({ kind: "endBubble", role: "user" });
            continue;
        }

        // ── 工具结果：不建气泡，按 callId 填回对应的工具块 ✓ ──
        if (role === "toolResult") {
            // ★ B40：与 message_start 通道【共用同一个读取器】⇒ 不会再一条通道漏字段
            const f = readToolResultMessage(msg);
            if (!f.callId) continue;
            out.push({
                kind: "toolResult",
                callId: f.callId,
                parts: f.parts,
                isError: f.isError,
                details: f.details,
            });
            continue;
        }

        if (role !== "assistant") continue;

        // ── AI 消息：一条 = 一个 assistant 气泡，内部按块追加 ✓ ──
        out.push({ kind: "startBubble", role: "assistant", text: "" });

        for (const part of partsOf(msg.content)) {
            if (part.type === "text") {
                out.push({ kind: "append", block: "text", text: part.text ?? "" });
            } else if (part.type === "thinking") {
                out.push({ kind: "append", block: "thinking", text: part.thinking ?? "" });
            } else if (part.type === "toolCall") {
                // ★ 一次补齐：起工具块 + 参数（历史里参数已经是解析好的对象 ✓）
                const callId = typeof part.id === "string" ? part.id : "";
                if (!callId) continue;
                out.push({ kind: "toolStart", name: part.name ?? "tool", callId });
                out.push({ kind: "toolEnd", args: part.arguments });
            }
            // image 块暂不处理（历史里的图片等真需要再说 ✓）
        }

        // ★ 结束原因：只带【异常】（length / aborted）—— 和实时流一致 ✓
        //   （error 不带：自动重试时 pi 会对每次失败都发 ✗ 会贴到正常回复底下 ✓）
        const sr = typeof msg.stopReason === "string" ? msg.stopReason : undefined;
        const abnormal = sr === "length" || sr === "aborted" ? sr : undefined;
        out.push({
            kind: "endBubble",
            role: "assistant",
            stopReason: abnormal,
            usage: msg.usage,
            model: msg.model,
        });
    }

    return out;
}

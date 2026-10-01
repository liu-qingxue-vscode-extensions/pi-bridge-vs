/**
 * ChatState —— 插件端的聊天状态（**权威状态**）
 *
 * 【为什么权威状态在插件端，而不是 webview？】
 * VS Code 的 webview 在切走 tab 时可能被【销毁】（默认行为，省内存）。
 * 若状态放在 webview，一旦销毁就丢失（切回来是空白）。
 * 所以 webview 只是"完全不长脑子的显示器"：
 *   状态在这里维护，webview 重建时从这里【重放快照】。
 *
 * 【数据流】
 *   pi 事件 → format-backend 翻译 → ChatPatch → ChatState.apply()
 *        → 通知订阅者（ChatView）→ 增量推送 → webview 渲染
 *   webview 重建 → 发 "ready" → ChatView 用 snapshot() 重放全量
 */

/** 气泡角色（user / assistant / 工具结果） */
export type ChatRole = "user" | "assistant" | "tool";

/**
 * 气泡内的【内容块】类型
 *
 * 【为什么气泡内要分块？】
 * 一条 assistant 消息的 content 是个【数组】，可以有多个块（由 contentIndex 区分）：
 *   [0] thinking 块、[1] text 块、（后续）toolcall 块…
 * 所以气泡不是一段文本，而是一串块 —— 渲染时要按块分开呈现
 * （思考块灰色斜体、正文块正常、工具块卡片…）。
 */
export type BlockType = "text" | "thinking" | "tool";

/** 气泡内的一个内容块 */
export interface Block {
    type: BlockType;
    /** text/thinking：正文内容；tool：参数的 JSON 文本（流式拼装中） */
    text: string;
    /** tool 专用：工具名 */
    toolName?: string;
    /** tool 专用：调用 id（用于把“结果消息”关联回这个块）★ */
    toolCallId?: string;
    /** tool 专用：参数是否拼装完毕（toolcall_end 到达） */
    toolDone?: boolean;
    /** tool 专用：执行结果（来自 toolResult 消息，可能跨越其他气泡） */
    result?: string;
    /** tool 专用：结果是否为错误 */
    resultIsError?: boolean;
}

/** 一条聊天气泡 */
export interface Bubble {
    role: ChatRole;
    /** 内容块（按出现顺序） */
    blocks: Block[];
    /** 是否已封口（流式结束） */
    done: boolean;
}

/**
 * 渲染指令 —— ChatState 的输入，也是推给 webview 的载荷
 *
 * 【为什么是"增量指令"而不是"全量状态"？】
 * 流式输出时每个 delta 都推一次，若每次重传整个历史就太浪费了。
 * 全量只在 webview 重建时通过 snapshot() 重放。
 */
export type ChatPatch =
    | { kind: "startBubble"; role: ChatRole; text: string }
    | { kind: "append"; block: "text" | "thinking"; text: string }
    | { kind: "endBubble"; role: ChatRole }
    // 工具调用（toolcall_*）—— 工具气泡的生命周期
    | { kind: "toolStart"; name: string; callId: string }
    | { kind: "toolArgs"; text: string }
    | { kind: "toolEnd" }
    // 工具结果（toolResult 消息）—— 不建新气泡，而是【填回】对应的工具块
    | { kind: "toolResult"; callId: string; text: string; isError: boolean };

export class ChatState {
    /** 所有气泡（权威状态） */
    private readonly bubbles: Bubble[] = [];

    /** 状态变化的订阅者（ChatView 订阅它，把变化推给 webview） */
    private readonly listeners = new Set<(patch: ChatPatch) => void>();

    /** 订阅状态变化，返回取消订阅函数 */
    onChange(listener: (patch: ChatPatch) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /** 全量快照（webview 重建时重放用） */
    snapshot(): readonly Bubble[] {
        return this.bubbles;
    }

    /**
     * 统一入口：应用一条渲染指令
     * （由 main.ts 把 pi 事件交给 format 层翻译后调用）
     */
    apply(patch: ChatPatch): void {
        switch (patch.kind) {
            case "startBubble":
                // 用户消息可能自带内容（非流式，内容在 message_start 里）→ 包成一个 text 块；
                // AI 消息这里一般是空串，靠后续 append 累积。
                this.bubbles.push({
                    role: patch.role,
                    blocks: patch.text ? [{ type: "text", text: patch.text }] : [],
                    done: false,
                });
                break;

            case "append": {
                const last = this.bubbles.at(-1);
                // 防御：没有打开的气泡（或已封口）就忽略 —— 数据异常时不崩
                if (!last || last.done) return;
                const lastBlock = last.blocks.at(-1);
                if (lastBlock && lastBlock.type === patch.block) {
                    lastBlock.text += patch.text; // 同一块 → 追加
                } else {
                    last.blocks.push({ type: patch.block, text: patch.text }); // 新块
                }
                break;
            }

            case "endBubble": {
                const last = this.bubbles.at(-1);
                // 防御：只有"角色匹配且未封口"才真正封口
                // 原因：pi 的 toolResult 消息也会发 message_end，不能误封 assistant 气泡
                if (!last || last.done || last.role !== patch.role) return;
                last.done = true;
                break;
            }

            // ===== 工具气泡的生命周期（toolcall_* + toolResult）=====
            case "toolStart": {
                const last = this.bubbles.at(-1);
                if (!last || last.done) return;
                last.blocks.push({
                    type: "tool",
                    text: "",
                    toolName: patch.name,
                    toolCallId: patch.callId,
                    toolDone: false,
                });
                break;
            }

            case "toolArgs": {
                const blk = this.bubbles.at(-1)?.blocks.at(-1);
                if (blk?.type !== "tool") return;
                blk.text += patch.text; // 参数 JSON 是流式拼装的
                break;
            }

            case "toolEnd": {
                const blk = this.bubbles.at(-1)?.blocks.at(-1);
                if (blk?.type !== "tool") return;
                blk.toolDone = true;
                break;
            }

            case "toolResult": {
                // ★ 结果可能来自【另一条消息】→ 按 callId 在所有气泡里找回那个工具块
                const blk = this.findToolBlock(patch.callId);
                if (!blk) return; // 关联不上就忽略（不崩）
                blk.result = patch.text;
                blk.resultIsError = patch.isError;
                break;
            }
        }
        this.emit(patch);
    }

    /** 按 callId 在所有气泡的内容块里找工具块 */
    private findToolBlock(callId: string): Block | undefined {
        for (const bubble of this.bubbles) {
            for (const blk of bubble.blocks) {
                if (blk.type === "tool" && blk.toolCallId === callId) return blk;
            }
        }
        return undefined;
    }

    private emit(patch: ChatPatch): void {
        for (const listener of this.listeners) {
            listener(patch);
        }
    }
}

/**
 * chat-types —— 聊天视图的【类型契约】
 *
 * 【为什么单独一个文件？】
 * 类型有 5 个（ChatRole / BlockType / Block / Bubble / ChatPatch），
 * 和 ChatState 类混在一个文件里会让状态机难读、改动时匹配范围也大。
 * 拆开后：类型在这里，状态机在 chat-state.ts，职责清晰。
 *
 * 【它同时是翻译层与视图层的契约】
 *   format-backend 产出 ChatPatch  →  ChatState 消费  →  ChatView 转发给 webview
 */

/** 气泡角色（user / assistant / 工具结果） */
export type ChatRole = "user" | "assistant" | "tool";

/**
 * 气泡内的【内容块】类型
 *
 * 【为什么气泡内要分块？】
 * 一条 assistant 消息的 content 是个【数组】，可以有多个块（由 contentIndex 区分）：
 *   [0] thinking 块、[1] text 块、（后续）toolcall 块…
 * 所以气泡不是一段文本，而是一串块 —— 渲染时要按块分开呈现。
 */
export type BlockType = "text" | "thinking" | "tool";

/** 气泡内的一个内容块 */
export interface Block {
    type: BlockType;
    /** text/thinking：内容 */
    text: string;

    // ===== tool 专用 =====
    /** 工具名 */
    toolName?: string;
    /** 调用 id（用于把「工具结果消息」关联回这个块）★ */
    toolCallId?: string;
    /** 参数是否拼装完毕（toolcall_end 到达） */
    toolDone?: boolean;
    /** 参数的原始 JSON 文本（流式拼装中，备查） */
    argsText?: string;
    /** 参数解析后的【对象】（toolcall_end 时填入 → 渲染成键值对）★ */
    args?: unknown;
    /** 结果内容部分（toolResult 的 content 数组原样 → 按 type 分发渲染）★ */
    resultParts?: unknown[];
    /** 结果是否为错误 */
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
    | { kind: "toolEnd"; args: unknown } // 参数拼完 → 传解析好的对象
    // 工具结果（toolResult 消息）—— 不建新气泡，而是【填回】对应的工具块
    | { kind: "toolResult"; callId: string; parts: unknown[]; isError: boolean }
    // 任务级状态（agent_start / agent_settled）—— 不进气泡列表，直接驱动状态条/按钮
    | { kind: "agentState"; state: "working" | "idle" }
    // 思考生命周期（thinking_start / thinking_end）—— 不改数据，只转发给前端
    // （前端用它控制"正在思考…" → "已思考（用时 X 秒）"与计时）
    | { kind: "thinkStart" }
    | { kind: "thinkEnd" };

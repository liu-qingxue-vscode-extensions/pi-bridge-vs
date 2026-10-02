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

    // ===== 执行阶段（tool_execution_*）=====
    /**
     * 执行中的实时输出（tool_execution_update 的 partialResult.content）★
     *
     * ⚠️ 实测确认：它是【累积全文】而不是增量 ✗
     *   （11 次推送，每次长度 +26、内容都是从头开始的全文）
     *   → 前端每次【替换】而不要【追加】✓
     */
    partialParts?: unknown[];
    /** 是否正在执行（exec_start 已到、exec_end 未到） */
    executing?: boolean;
}

/**
 * token 用量（来自 message_end / turn_end 的 message.usage）
 * 实测字段：input / output / cacheRead / cacheWrite / reasoning / totalTokens / cost
 * ★ totalTokens = input + output + cacheRead + cacheWrite（正好是上下文占用量 ✓）
 */
export interface Usage {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoning?: number;
    totalTokens?: number;
    cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
}

/** 一条聊天气泡 */
export interface Bubble {
    role: ChatRole;
    /** 内容块（按出现顺序） */
    blocks: Block[];
    /** 是否已封口（流式结束） */
    done: boolean;
    /**
     * 结束原因（stopReason）—— ★ 只在【异常】时有值
     *   length=被长度截断 · aborted=被中断 · error=出错
     * （正常结束 stop / toolUse 不带值 → 不打扰用户 ✓）
     */
    stopReason?: string;
    /** token 用量（顶部状态栏：输出 token / 缓存命中 / 电池）★ */
    usage?: Usage;
    /** 模型 id（顶部状态栏用；也是查 contextWindow 的键 ✓） */
    model?: string;
}

/** 通知级别（决定图标与颜色）★ 与 pi 的 notifyType 一一对应 */
export type NoticeLevel = "info" | "success" | "warn" | "error";

/**
 * 一条通知（来自 extension_ui_request.notify / stderr）
 *
 * 【★ 关键：它不进会话文件】
 *   FACTS.md 实测：extension_ui_request / stderr / auto_retry_* 都是【过程状态】而非对话内容
 *   → 不落盘 ✓ 只活在插件进程内存里 ✓ 窗口重载即清空 ✓
 *   （所以不需要记录“已读/未读”——反正活不过重载）
 */
export interface Notice {
    /** 序号（由 ChatState 分配，用于关闭单条 / 前端 key）*/
    id: number;
    /** 正文 */
    text: string;
    /** 级别 */
    level: NoticeLevel;
    /** 时间戳（ms）*/
    time: number;
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
    | { kind: "endBubble"; role: ChatRole; stopReason?: string; usage?: Usage; model?: string }
    // 工具调用（toolcall_*）—— 工具气泡的生命周期
    | { kind: "toolStart"; name: string; callId: string }
    | { kind: "toolArgs"; text: string }
    | { kind: "toolEnd"; args: unknown } // 参数拼完 → 传解析好的对象
    // 工具结果（toolResult 消息）—— 不建新气泡，而是【填回】对应的工具块
    | { kind: "toolResult"; callId: string; parts: unknown[]; isError: boolean }
    // 工具【执行】阶段（tool_execution_*）—— 补上“执行中”这段盲区
    // （toolcall_* 只管参数生成；toolResult 只管最终结果；中间那段原本是黑的 ✗）
    | { kind: "toolExecStart"; callId: string; name: string }
    // ★ parts 是【累积全文】→ 前端替换渲染（不是追加 ✗）
    | { kind: "toolExecUpdate"; callId: string; parts: unknown[] }
    | { kind: "toolExecEnd"; callId: string; isError: boolean }
    // 任务级状态（agent_start / agent_settled）—— 不进气泡列表，直接驱动状态条/按钮
    | { kind: "agentState"; state: "working" | "idle" }
    // ★ 重连提示（auto_retry_start / auto_retry_end）—— 【不进文件】的字段
    //   生命周期：出现 → 【一直留着】（下次对话也不挤掉 ✗ webview 重建才消失 ✓）
    | {
          kind: "retryNotice";
          /** 第几次（attempt ✓）*/
          attempt?: number;
          /** 共几次（maxAttempts ✓）*/
          maxAttempts?: number;
          /** 多久后重试（delayMs ✓）*/
          delayMs?: number;
          /** pi 给的错误文案（errorMessage / finalError ✓）*/
          message?: string;
          /** 是不是最终结果包（auto_retry_end ✓）*/
          final?: boolean;
          /** 最终是否成功（仅 final 时有值）*/
          success?: boolean;
      }
    // 思考生命周期（thinking_start / thinking_end）—— 不改数据，只转发给前端
    // （前端用它控制"正在思考…" → "已思考（用时 X 秒）"与计时）
    | { kind: "thinkStart" }
    | { kind: "thinkEnd" }
    // ★ 通知（extension_ui_request.notify / stderr）—— 不进气泡列表
    //   生命周期：进入 ChatState 的 notices 环形缓冲 → 前端逐条渲染 ✓
    //   （id / time 由 format 层产出时为空，ChatState 补上后再广播 ✓）
    | { kind: "notice"; text: string; level: NoticeLevel; id?: number; time?: number }
    // 关闭单条通知（前端点 ✕）—— 唯一一条【前端 → 插件】的通知指令 ✓
    | { kind: "noticeRemove"; id: number };

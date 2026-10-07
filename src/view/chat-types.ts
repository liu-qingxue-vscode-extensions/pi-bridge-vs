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
export type ChatRole = "user" | "assistant" | "tool" | "compaction";

/**
 * 气泡内的【内容块】类型
 *
 * 【为什么气泡内要分块？】
 * 一条 assistant 消息的 content 是个【数组】，可以有多个块（由 contentIndex 区分）：
 *   [0] thinking 块、[1] text 块、（后续）toolcall 块…
 * 所以气泡不是一段文本，而是一串块 —— 渲染时要按块分开呈现。
 */
export type BlockType = "text" | "thinking" | "tool" | "compaction";

/**
 * ★★ B46：压缩块的字段
 *
 * 【为什么要独立一个气泡类型】
 *   压缩摘要【不是任何人的话】✗ 也不属于某个工具 ✓
 *   强行塞进 text 气泡会错位（它出现在历史最前面 ✗ 而它是"后来才发生的事"✓）
 *
 * 【它代表什么】
 *   此时刻之前的所有对话【已被压缩成这段摘要】✗ 之后的才是原文 ✓
 */
export interface CompactionFields {
    /** 摘要正文（markdown 源文 ✗ 前端渲染 ✓）*/
    summary?: string;
    /** 压缩前的 token 数（显示 "已压缩 ≈N tokens" ✓）*/
    tokensBefore?: number;
    /** 压缩发生的时间（ISO 串）*/
    time?: string;
    /** ★ 块 id（跳转编辑器时靠它从宿主找回这个块 ✓ 前端自己生成 ✓）*/
    compId?: string;
}

/**
 * ★★★ B40：工具块的【共享字段】—— 宿主气泡 / 快照块 / 前端渲染入口 三者唯一来源
 *
 * 【为什么要抽出来】
 *   这几个字段原先在【四个地方】各手写一遍：
 *     Block（宿主）· SnapBlock（前端快照）· ToolData（前端渲染入口）· ToolSnapshotData
 *   而且命名还不一致（宿主 resultIsError ✗ 前端 isError）
 *   ⇒ "某处漏一个字段"或"两处名字对不上"是必然 ✗ 而且 grep 看不出来
 *      （B39 的 bug 就是这样：edit 的 details 在快照路径漏传 ⇒ diff 画不出来）
 *
 * ⇒ 现在【加字段只改这里】✗ 三处自动同步 ⇒ 编译期就能发现问题
 */
export interface ToolBlockFields {
    // ===== 身份 =====
    /** 工具名 */
    toolName?: string;
    /** 调用 id（把「工具结果消息」关联回这个块的关键）*/
    toolCallId?: string;

    // ===== 参数（toolcall_* 阶段）=====
    /** 参数拼装完毕 */
    toolDone?: boolean;
    /** 参数的原始 JSON 文本（流式拼装中 ✗ 仅宿主备查）*/
    argsText?: string;
    /** 解析后的参数对象 */
    args?: unknown;

    // ===== 结果（toolResult 消息）=====
    /** 结果内容 parts（原样 → 前端按 type 分发渲染）*/
    resultParts?: unknown[];
    /** 结果是否为错误（★ 名字以宿主为准 ✗ 前端不再翻译成 isError）*/
    resultIsError?: boolean;
    /** ★ edit 的结果附加信息（diff / patch）—— 丢了 ⇒ diff 画不出来 */
    details?: unknown;

    // ===== 执行阶段（tool_execution_*）=====
    /** 执行中的实时输出（★ 累积全文 ✗ 不是增量）*/
    partialParts?: unknown[];
    /** 是否正在执行 */
    executing?: boolean;
}

/** 气泡内的一个内容块 */
export interface Block extends ToolBlockFields, CompactionFields {
    type: BlockType;
    /** text/thinking：内容 */
    text: string;
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
    /**
     * ★★ B45：这条气泡属于【已被压缩】的那一段吗
     *   只有"完整历史面板"（raw 模式）会填 ✗ 普通渲染里那些消息根本不出现 ✓
     *   ⇒ 前端据此加背景色差异 ✓
     */
    compacted?: boolean;
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
    // ★ 队列变化（B20）：steering 里还有我的文本 = 还没被 AI 吃进去 ✓
    | { kind: "queueUpdate"; steering: string[]; followUp: string[] }
    // ★ 压缩上下文（B22）：开始/结束共用一种 patch（同一次压缩原地更新 ✓）
    | {
          kind: "compaction";
          phase: "start" | "end";
          reason?: string;
          aborted?: boolean;
          willRetry?: boolean;
          errorMessage?: string;
          tokensBefore?: number;
          tokensAfter?: number;
      }
    // ★★ B45：区段标记（已压缩 / 未压缩 的分界 + 背景色差异用 ✓）
    | { kind: "compactedMark"; on: boolean }
    // ★★ B46：压缩【结果】气泡 —— 与上面那个过程事件不同：
    //   这个【进 bubbles/snapshot】（它是历史的一部分 ✗ webview 重建后要还在 ✓）
    | { kind: "compactionBubble"; summary: string; tokensBefore?: number; time?: string }
    // 工具调用（toolcall_*）—— 工具气泡的生命周期
    | { kind: "toolStart"; name: string; callId: string }
    | { kind: "toolArgs"; text: string }
    | { kind: "toolEnd"; args: unknown } // 参数拼完 → 传解析好的对象
    // 工具结果（toolResult 消息）—— 不建新气泡，而是【填回】对应的工具块
    | { kind: "toolResult"; callId: string; parts: unknown[]; isError: boolean; details?: unknown }
    // 工具【执行】阶段（tool_execution_*）—— 补上“执行中”这段盲区
    // （toolcall_* 只管参数生成；toolResult 只管最终结果；中间那段原本是黑的 ✗）
    | { kind: "toolExecStart"; callId: string; name: string }
    // ★ parts 是【累积全文】→ 前端替换渲染（不是追加 ✗）
    | { kind: "toolExecUpdate"; callId: string; parts: unknown[] }
    // ★★ B38：details 里有 edit 的 diff/patch（前端渲染差异用 ✓）
    | { kind: "toolExecEnd"; callId: string; isError: boolean; details?: unknown }
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

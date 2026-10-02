/**
 * state.ts —— webview 的【所有可变状态】集中处
 *
 * 【为什么必须集中？】
 *   ES 模块的 `let` 不能跨模块共享 ✗ —— 在 A 模块 import 的 `let`，
 *   B 模块里重新赋值不会反映到 A（拿到的是快照 ✗）。
 *   所以把所有可变状态放进【一个对象】里：各模块拿到的是同一个对象的引用 ✓
 *
 * 【为什么不用 class？】
 *   这些状态彼此独立、没有方法、也不需要多实例 →
 *   一个普通对象最直白 ✓（YAGNI：不为了"优雅"引入类 ✗）
 *
 * 【它和插件端 ChatState 的区别】
 *   ChatState = 【权威状态】（数据源，插件端，webview 销毁也不丢）
 *   本文件    = 【UI 过程状态】（"当前正在拼哪个气泡"这类纯前端细节）
 *               ★ 权威数据（气泡内容、通知）由 snapshot 重放 → 不在这里 ✗
 */

/** 一条通知的【前端镜像】（与插件端 Notice 同构；前端不跨包 import ✗） */
export interface UiNotice {
    id: number;
    text: string;
    level: string;
    time: number;
}

export const ui = {
    // ── 渲染模型（每个内容段 = 一个独立气泡）──
    /** 当前消息角色（决定对齐） */
    role: "assistant" as string,
    /** 当前正在流式追加的气泡元素 */
    bubble: null as HTMLElement | null,
    /** 最近一个思考气泡（thinking_end 时用它改文案 ✓） */
    lastThinkBubble: null as HTMLElement | null,
    /** 思考开始时间（0 = 未在思考） */
    thinkStartAt: 0,
    /** 占位三点（发送后、首个数据包到达前） */
    pendingEl: null as HTMLElement | null,
    /** 重连提示气泡（同一气泡原地更新 ✓） */
    retryNoticeEl: null as HTMLElement | null,

    // ── 行为开关 ──
    /** 自动滚到底（用户往上翻时自动关闭 ✓） */
    autoScroll: true,
    /** 用户是否主动中断过当前任务
     *  ★ 用途：auto_retry_end 的 success 无法区分【被中断】和【真连上】✗
     *    实测两者都是 { success:true, attempt:N }（无 finalError）—— 结构一模一样 ✗ */
    userAborted: false,

    // ── 由设置驱动（applyStyleVars 时更新）──
    /** 默认折叠·思考 */
    defaultThinkCollapsed: false,
    /** 默认折叠·工具 */
    defaultToolCollapsed: false,

    // ── 顶栏 ──
    /** modelId → contextWindow（宿主推送；查不到则电池显示 "?"） */
    modelLimits: {} as Record<string, number>,

    // ── 通知板（B8）──
    /** 通知镜像（权威在插件端 ✓ 这里只负责显示） */
    notices: [] as UiNotice[],
    /** 面板是否已展开 */
    panelExpanded: false,
    /** 未读数（收起状态下新到的通知数） */
    noticeUnread: 0,
};

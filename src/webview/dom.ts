/**
 * dom.ts —— 所有 DOM 引用的【集中处】
 *
 * 【为什么集中？】
 *   原来 `document.getElementById(...)` 散在文件各处（20 多个）✗
 *   集中后有两个好处：
 *     ① 新增/改名元素时只改这里 ✓
 *     ② 各渲染模块 import 即可，不用各自 getElementById ✓
 *
 * 【约束】这里的引用都是【只读的 const】—— 模块只应操作它们的属性/子节点，
 *         不要重新赋值（元素本身不会换 ✗）
 */
import { vscode } from "./vscode-api.js";

/**
 * ★ 安全拿 DOM（找不到时不抛错，而是记一笔并返回一个占位元素 ✓）
 *
 * 【为什么需要？】
 *   之前用 `document.getElementById(...)!` → 找不到时【返回 null】✗
 *   而 `!` 只是骗过编译器 ✗ → null.addEventListener → ★ 直接搞崩整个 webview ✓
 *   而且崩在【初始化阶段】→ 后面的 setupHostBridge 都不会跑 ✗
 *   → 用户的感受就是“界面啥也没有”（连宿主推送都收不到 ✗）
 *
 * ★ 宁可这个控件不工作，也不能搞崩整个界面 ✓
 */
export function needEl(id: string): HTMLElement {
    const el = document.getElementById(id);
    if (el) return el;
    // ★ 找不到 → 【报告给宿主】（输出面板能看到 ✓）而不是只写 console（要开 devtools ✗）
    vscode.postMessage({
        kind: "webviewLog",
        level: "error",
        text: `★ 找不到 DOM 元素 #${id} —— HTML 与 TS 不一致？`,
    });
    return document.createElement("div"); // 占位：后续 addEventListener 不会崩 ✓
}

export const messagesEl = needEl("messages");
export const inputEl = needEl("input") as HTMLTextAreaElement;
export const sendBtn = needEl("send");
/** ★ 重启 pi 按钮（应用最新启动参数 ✓）*/
export const btnReload = needEl("btn-reload");
/** ★ 「待插话」条容器（挂在输入框上方 ✓ 不进消息流 ✓）*/
export const queueBarEl = needEl("queue-bar");

// ── 顶栏（topbar）：统计栏 + 电池 ──
export const statusBarEl = needEl("status-bar");
export const sbCost = needEl("sb-cost");
export const sbOut = needEl("sb-out");
export const sbCache = needEl("sb-cache");
export const sbBattery = needEl("sb-battery");
export const sbBatteryFill = needEl("sb-battery-fill");
export const sbBatteryPct = needEl("sb-battery-pct");

// ── 输入区下方极简栏 ──
export const footModel = needEl("foot-model");
export const footCwd = needEl("foot-cwd");
export const inputAreaEl = needEl("input-area");

// ── 通知板（B8）──
export const topArea = needEl("top-area");
export const noticeToolbar = needEl("notice-toolbar");
export const noticePanel = needEl("notice-panel");
export const noticeList = needEl("notice-list");
export const noticeEmpty = needEl("notice-empty");
export const noticeCount = needEl("notice-count");
export const noticeBell = needEl("notice-bell");
export const noticeBadge = needEl("notice-badge");

// ── ★ 按钮行 + 会话面板（B15）──
export const btnSessions = needEl("btn-sessions");
export const btnNewSession = needEl("btn-new-session");
export const sessionPanel = needEl("session-panel");
export const sessionList = needEl("session-list");
export const sessionEmpty = needEl("session-empty");
export const sessionPanelClose = needEl("session-panel-close");
export const btnRefreshSessions = needEl("btn-refresh-sessions");
/** ★ 按钮行中间的【当前会话名】（点击改名 ✓）*/
export const sessionTitle = needEl("session-title");
export const noticeCollapse = needEl("notice-collapse");
export const noticeClear = needEl("notice-clear");
export const noticeSettings = needEl("notice-settings");

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

export const messagesEl = document.getElementById("messages")!;
export const inputEl = document.getElementById("input") as HTMLTextAreaElement;
export const sendBtn = document.getElementById("send")!;
/** ★ 重启 pi 按钮（应用最新启动参数 ✓）*/
export const btnReload = document.getElementById("btn-reload")!;

// ── 顶栏（topbar）：统计栏 + 电池 ──
export const statusBarEl = document.getElementById("status-bar")!;
export const sbCost = document.getElementById("sb-cost")!;
export const sbOut = document.getElementById("sb-out")!;
export const sbCache = document.getElementById("sb-cache")!;
export const sbBattery = document.getElementById("sb-battery")!;
export const sbBatteryFill = document.getElementById("sb-battery-fill")!;
export const sbBatteryPct = document.getElementById("sb-battery-pct")!;

// ── 输入区下方极简栏 ──
export const footModel = document.getElementById("foot-model")!;
export const footCwd = document.getElementById("foot-cwd")!;
export const inputAreaEl = document.getElementById("input-area")!;

// ── 通知板（B8）──
export const topArea = document.getElementById("top-area")!;
export const noticeToolbar = document.getElementById("notice-toolbar")!;
export const noticePanel = document.getElementById("notice-panel")!;
export const noticeList = document.getElementById("notice-list")!;
export const noticeEmpty = document.getElementById("notice-empty")!;
export const noticeCount = document.getElementById("notice-count")!;
export const noticeBell = document.getElementById("notice-bell")!;
export const noticeBadge = document.getElementById("notice-badge")!;
export const noticeCollapse = document.getElementById("notice-collapse")!;
export const noticeClear = document.getElementById("notice-clear")!;
export const noticeSettings = document.getElementById("notice-settings")!;

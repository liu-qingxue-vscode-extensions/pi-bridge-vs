/**
 * panels.ts —— 底部面板的【互斥协调器】（B25）
 *
 * 【为什么需要它？】（用户发现的 ✓）
 *   现在有四块从按钮行下方滑出的面板：
 *     会话 · 通知 · 设置 · 技能
 *   它们各自管自己 ✓ → 结果【能同时开着】✗
 *   用户原话：“一块板子开着的情况下，点另一个应该把原来那块板子收回去，
 *             并且打开新板子才对吧？”
 *
 * 【为什么不直接在各自模块里互相调用？】
 *   会形成循环依赖 ✗（session ↔ settings ↔ skills … ✓）
 *   而且每加一块板子就要改所有板子 ✓
 *   → 用【注册表 + 当前活动项】✓ 加新板子只需注册一次 ✓
 *
 * 【注意：这不改变各面板自己的开关逻辑】✗
 *   它们仍然可以自开自关 ✓ 只是"开的时候"顺便关掉别人 ✓
 */
import { log } from "./vscode-api.js";

/** panelId → 关闭函数 */
const closers = new Map<string, () => void>();
let active: string | null = null;

/** 注册一块面板（模块加载时各注册一次 ✓）*/
export function registerPanel(id: string, close: () => void): void {
    closers.set(id, close);
}

/**
 * ★ 声明"我要打开了" → 自动关掉其他所有面板 ✓
 * 每块面板在自己"打开"时调它 ✓
 */
export function activatePanel(id: string): void {
    if (active && active !== id) {
        const close = closers.get(active);
        log.info(`[panels] ${active} → ${id}（自动收起前一块 ✓）`);
        close?.();
    }
    active = id;
}

/** 声明"我关上了"（只有当前活动项是自己时才清 ✓ 避免误清别人）*/
export function deactivatePanel(id: string): void {
    if (active === id) active = null;
}

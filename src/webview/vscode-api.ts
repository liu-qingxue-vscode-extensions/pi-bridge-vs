/**
 * vscode-api.ts —— `acquireVsCodeApi()` 的【单例】
 *
 * 【为什么必须单独一个文件？】
 *   VS Code 规定 `acquireVsCodeApi()` 在【整个 webview 生命周期内只能调用一次】✗
 *   重复调用会抛错。而它现在被多个模块用到（输入区发消息、通知板发指令）
 *   → 集中在这里调用一次，各处 import 同一个对象 ✓
 *
 * 同理，`getState()/setState()` 也应由本模块统一管理（目前未使用 ✗）。
 */

/**
 * VS Code 在 webview 里【注入的全局函数】（不在 DOM lib 里 ✗ 需自己声明）
 * 类型按官方文档最小化：postMessage + getState/setState ✓
 */
declare function acquireVsCodeApi(): {
    postMessage(msg: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
};

export const vscode = acquireVsCodeApi();

/** 发给扩展宿主（语义化包装：调用点更短 ✓） */
export function post(kind: string, payload?: unknown): void {
    vscode.postMessage(payload === undefined ? { kind } : { kind, payload });
}

/**
 * ★ webview 的日志 → 转发到 VS Code 的【输出面板】✓
 *
 * 【为什么要这根管道？】（用户的要求 ✓）
 *   webview 里的 console.log 必须开 devtools 才看得到 ✗
 *   而输出面板随手就能看 ✓ → 出问题用户直接复制给我 ✓
 *
 * 【★ 不要和调试板搞混】
 *   调试板 = 看【数据包】（pi 推来的事件/回执 ✓）
 *   输出面板 = 看【日志】（人写的 ✓）
 *   两者完全独立 ✗ 这里只走输出面板 ✓
 *
 * 【★ 分层（用户的要求 ✓ 免得刷屏）】
 *   log.debug → 高频/细节（默认看不到 ✓ 排查时才调级别 ✓）
 *   log.info  → 关键节点（初始化 / 状态变化 / 用户操作结果 ✓）
 *   log.warn  → 异常但可恢复（走回退分支 ✓）
 *   log.error → 真错误（用户该知道的 ✓）
 */
function send(level: "debug" | "info" | "warn" | "error", text: string): void {
    vscode.postMessage({ kind: "webviewLog", level, text });
}

export const log = {
    debug: (text: string): void => send("debug", text),
    info: (text: string): void => send("info", text),
    warn: (text: string): void => send("warn", text),
    error: (text: string): void => send("error", text),
};

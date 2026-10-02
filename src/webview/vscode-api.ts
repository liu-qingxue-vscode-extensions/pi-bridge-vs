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

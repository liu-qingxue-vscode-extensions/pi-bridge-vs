/**
 * 极简日志：输出到 VS Code 的 "pi-bridge" 输出面板
 *
 * 为什么不直接 console.log？
 * - 扩展宿主的 console 在调试时能看，但正式使用时看不到
 * - 输出面板（OutputChannel）是 VS Code 原生的日志查看位置，随时可打开
 */
import * as vscode from "vscode";

let channel: vscode.LogOutputChannel | undefined;

/** 在 activate 里调用一次，初始化输出通道 */
export function initLogger(): vscode.Disposable {
    channel = vscode.window.createOutputChannel("pi-bridge", { log: true });
    return channel;
}

export function logInfo(msg: string): void {
    channel?.info(msg);
}

export function logError(msg: string): void {
    channel?.error(msg);
}

export function logDebug(msg: string): void {
    channel?.debug(msg);
}

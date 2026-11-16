/**
 * 极简日志:输出到 VS Code 的 "pi-bridge" 输出面板
 *
 * 为什么不直接 console.log?
 * - 扩展宿主的 console 在调试时能看,但正式使用时看不到
 * - 输出面板(OutputChannel)是 VS Code 原生的日志查看位置,随时可打开
 */
import * as vscode from "vscode";

export interface Logger {
    debug(msg: string): void;
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
}

// ========== VSCode ==========
let channel: vscode.LogOutputChannel | undefined;
/** 在 activate 里调用一次,初始化输出通道 */
export function initLogger(): vscode.Disposable {
    channel = vscode.window.createOutputChannel("pi-bridge", { log: true });
    return channel;
}
export function createVSLogger(context: string): Logger {
    const prefix = `[${context}] `;
    return {
        debug: (msg: string) => channel?.debug(prefix + msg),
        info: (msg: string) => channel?.info(prefix + msg),
        warn: (msg: string) => channel?.warn(prefix + msg),
        error: (msg: string) => channel?.error(prefix + msg),
    };
}
// ========== console ==========
export function createCLogger(context: string): Logger {
    const prefix = `[${context}] `;
    return {
        debug: (msg: string) => console.debug(prefix + msg),
        info: (msg: string) => console.info(prefix + msg),
        warn: (msg: string) => console.warn(prefix + msg),
        error: (msg: string) => console.error(prefix + msg),
    };
}
// ========== old ==========
export function logDebug(msg: string): void {
    channel?.debug(msg);
}
export function logInfo(msg: string): void {
    channel?.info(msg);
}

export function logWarn(msg: string): void {
    channel?.warn(msg);
}

export function logError(msg: string): void {
    channel?.error(msg);
}



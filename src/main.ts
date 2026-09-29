/**
 * main.ts —— 扩展入口（activate / deactivate）
 *
 * 【这是整个框架的"组装现场"】
 * 把各个零件接成两条数据流：
 *
 *   ① 后端 → 前端：
 *      pi 事件 → toFrontendPayload(透传) → DebugPanel.log → （未来）ChatView.post
 *
 *   ② 前端 → 后端：
 *      ChatView 的 prompt → toRpcCommand(表驱动) → PiClient.send → pi
 *
 * 对 pi 的运行方式：RpcClient 会 spawn 一个 `pi --mode rpc` 子进程，
 * 子进程的工作目录 = 当前 VS Code 打开的工作区。
 */
import * as vscode from "vscode";
import { initLogger, logInfo, logError } from "./logger.js";
import { PiClient } from "./pi/client.js";
import { DebugPanel } from "./view/debug-panel.js";
import { ChatView } from "./view/chat-view.js";
import { toRpcCommand } from "./bridge/format-frontend.js";
import { toFrontendPayload } from "./bridge/format-backend.js";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    // 0. 日志
    context.subscriptions.push(initLogger());
    logInfo("pi-bridge-vs 激活");

    // 1. 确定 pi 的工作目录 = 用户打开的文件夹
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) {
        logError("没有打开的工作区，pi 将以当前目录启动");
    }

    // 2. 创建零件
    const debugPanel = new DebugPanel();
    const pi = new PiClient(cwd ?? process.cwd());

    // 3. 数据流 ①：pi 事件 → 透传格式层 → 调试板
    pi.onEvent((event) => {
        debugPanel.log(toFrontendPayload(event));
    });

    // 4. 启动 pi（失败也要能让用户从调试板看到原因）
    try {
        await pi.start();
        debugPanel.log({ type: "local", message: "pi 已启动，等待输入" });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logError(`pi 启动失败: ${message}`);
        debugPanel.log({ type: "local-error", message: `pi 启动失败: ${message}` });
    }

    // 5. 数据流 ②：聊天视图的 prompt → format → pi
    const chatView = new ChatView(async (text) => {
        debugPanel.log({ type: "local", direction: "frontend→pi", payload: { kind: "prompt", text } });
        try {
            const cmd = toRpcCommand({ kind: "prompt", text });
            await pi.send(cmd);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logError(`发送 prompt 失败: ${message}`);
            debugPanel.log({ type: "local-error", message });
        }
    });

    // 6. 注册 VS Code 的贡献点（命令 / 视图）
    context.subscriptions.push(
        // 侧边栏聊天视图
        vscode.window.registerWebviewViewProvider(ChatView.viewId, chatView),

        // ctrl+alt+d / 命令面板 → 打开调试板
        vscode.commands.registerCommand("pi-bridge.showDebug", () => {
            debugPanel.show();
        }),

        // 测试命令（验证扩展是否激活）
        vscode.commands.registerCommand("pi-bridge.test", () => {
            void vscode.window.showInformationMessage("pi-bridge-vs 已激活 ✓");
        }),

        // 扩展停用时杀掉 pi 子进程（避免留下孤儿进程）
        {
            dispose: () => {
                void pi.stop();
            },
        },
    );
}

export function deactivate(): void {
    // 清理工作主要由上面的 subscriptions 完成
}

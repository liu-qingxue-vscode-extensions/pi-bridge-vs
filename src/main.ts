// 0.1 .VS 和标准库
import os from "node:os"
import * as vscode from "vscode";

// 0.2. util模块
import { initVSLogger, vsLogDebug, vsLogError, vsLogInfo, vsLogWarn } from "./logger.js"

// 0.3 普通模块
import { chatInitData, getVSSetting, settingDefaults } from "./without-pi-data/index.js";

// 0.3. 重要模块
import { ChatView } from "./view-core/chat-view.js"
import { debug } from "node:console";

export function activate(context: vscode.ExtensionContext): void {
    // 1.0 初始化

    // 1.1 [VS日志] 和 [调试板]---(模拟前端) 的初始化
    context.subscriptions.push(initVSLogger());
    void vscode.window.showInformationMessage("activate 跑起来了！");

    // 1.2 [chatView] 的初始化和: 注册 
    const chatView = new ChatView(context.extensionUri, chatInitData.cwd)
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ChatView.viewId, chatView)
    )

    // 2.1 Debug
    const testKey = "pi-bridge.piCliPath"
    const test = getVSSetting(testKey)
    if (test) {
        chatView.post({
            kind: "debug-setting",
            payload: {
                text: test
            }
        })
    } else {
        chatView.post({
            kind: "debug-setting",
            payload: {
                text: `test的key${testKey}没有写值`
            }
        })
    }
}
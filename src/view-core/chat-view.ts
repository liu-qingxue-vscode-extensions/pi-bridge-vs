import * as vscode from "vscode";
import { initVSLogger, vsLogDebug, vsLogError, vsLogInfo, vsLogWarn } from "../logger.js"
import { loadHtml } from "./load-html.js";

interface PostMessage {
    kind: string
    payload?: {
        text?: string
    }
}

export class ChatView implements vscode.WebviewViewProvider {
    static readonly viewId = "pi-bridge.chatView";

    // chat-web 空间在resolveWebviewViewresolveWebviewView()之后的唯一引用!
    private view: vscode.WebviewView | undefined;

    ready: boolean = false
    unreadyQueue: PostMessage[] = []

    constructor(
        /** vscode.Uri.fsPath 获取路径 */
        private readonly extensionUri: vscode.Uri,
        cwd: string,
    ) {

    }

    resolveWebviewView(webviewView: vscode.WebviewView) {
        this.view = webviewView;  // 保持引用, 在类的其他地方操作

        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = loadHtml(this.extensionUri, "chat.html");

        webviewView.webview.onDidReceiveMessage((msg) => {
            this.ready = true
            for (const m of this.unreadyQueue) {
                vsLogInfo(`[chat]正在发送${JSON.stringify(m)}`)
                this.view?.webview.postMessage(m)
            }
            this.unreadyQueue.length = 0;
        });
    }
    post(msg: PostMessage) {
        if (this.ready) {
            this.view?.webview.postMessage(msg);
        } else {
            vsLogInfo(`前端未就绪，添加${JSON.stringify(msg)}到队列`)
            this.unreadyQueue.push(msg)
        }
    }
}
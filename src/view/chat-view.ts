/**
 * ChatView —— 聊天视图（侧边栏里的 webview）
 *
 * 【第一步的定位】
 * 只提供"空 UI + 输入框"：把用户输入变成一条 prompt 消息交给上层，
 * 不做任何渲染（数据都在调试板里看）。
 *
 * 【迭代方向】
 * 随着调试板里的数据被逐个"消灭"，这里会逐步长出真正的 UI 渲染。
 */
import * as vscode from "vscode";
import { chatHtml } from "./html.js";

export class ChatView implements vscode.WebviewViewProvider {
    /** 视图 id：必须和 package.json 的 contributes.views 里声明的一致 */
    static readonly viewId = "pi-bridge.chatView";

    /** 当前视图实例（用户切走/关闭时为 undefined） */
    private view: vscode.WebviewView | undefined;

    /**
     * @param onPrompt 用户发来 prompt 时的回调（由 main.ts 决定怎么处理）
     */
    constructor(private readonly onPrompt: (text: string) => void | Promise<void>) {}

    /** VS Code 在视图第一次显示时调用 */
    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;

        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = chatHtml;

        // 接收前端（HTML）发来的消息
        webviewView.webview.onDidReceiveMessage((msg) => {
            if (msg.kind === "prompt" && typeof msg.text === "string") {
                void this.onPrompt(msg.text);
            }
        });
    }

    /**
     * 扩展宿主 → 前端（迭代用：以后把渲染数据推给聊天界面）
     * 第一步暂时没人调用，先留好接口。
     */
    post(kind: string, payload: unknown): void {
        this.view?.webview.postMessage({ kind, payload });
    }
}

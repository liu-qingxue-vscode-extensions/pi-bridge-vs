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
import { loadWebviewHtml } from "./html-loader.js";
import type { FrontendMessage } from "../bridge/format-frontend.js";

export class ChatView implements vscode.WebviewViewProvider {
    /** 视图 id：必须和 package.json 的 contributes.views 里声明的一致 */
    static readonly viewId = "pi-bridge.chatView";

    /** 当前视图实例（用户切走/关闭时为 undefined） */
    private view: vscode.WebviewView | undefined;

    /**
     * @param extensionUri 扩展根目录（用于读取 media/chat.html）
     * @param onMessage 前端消息的【统一出口】
     *
     * 【为什么传“整个消息”而不是“text”？】
     * 这样加新命令时不用改本类的签名 —— 扩展点在 format 层的 formatMap：
     *   chat 页面发 {kind:"abort"} → 这里照原样转交 → format 层负责翻译
     * 视图类保持“哑”：只转发，不做业务路由（职责单一）。
     */
    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly onMessage: (msg: FrontendMessage) => void | Promise<void>,
    ) {}

    /** VS Code 在视图第一次显示时调用 */
    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;

        webviewView.webview.options = { enableScripts: true };
        // 从 media/chat.html 读取 + 注入 CSP nonce
        webviewView.webview.html = loadWebviewHtml(this.extensionUri, "chat.html", webviewView.webview);

        // 接收 webview 页面发来的消息（纯转发，业务在 main.ts / format 层）
        webviewView.webview.onDidReceiveMessage((msg: unknown) => {
            // webview 发来的是任意 JSON，先做最小校验再交给上层
            if (msg && typeof msg === "object" && typeof (msg as { kind?: unknown }).kind === "string") {
                void this.onMessage(msg as FrontendMessage);
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

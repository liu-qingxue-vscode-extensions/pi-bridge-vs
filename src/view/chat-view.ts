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
import { readStyleVars, styleVarsToCss, onStyleChange } from "./style-config.js";
import { getModelContextWindowsObject } from "../pi/model-limits.js";
import type { FrontendMessage } from "../bridge/format-frontend.js";
import type { ChatState } from "./chat-state.js";

export class ChatView implements vscode.WebviewViewProvider {
    /** 视图 id：必须和 package.json 的 contributes.views 里声明的一致 */
    static readonly viewId = "pi-bridge.chatView";

    /** 当前视图实例（用户切走/关闭时为 undefined） */
    private view: vscode.WebviewView | undefined;

    /**
     * @param extensionUri 扩展根目录（用于读取 media/chat.html）
     * @param chatState 插件端权威聊天状态（本视图订阅它，把变化推给 webview）
     * @param onMessage 前端消息的【统一出口】
     *
     * 【为什么传“整个消息”而不是“text”？】
     * 这样加新命令时不用改本类的签名 —— 扩展点在 format 层的 formatMap：
     *   chat 页面发 {kind:"abort"} → 这里照原样转交 → format 层负责翻译
     * 视图类保持“哑”：只转发，不做业务路由（职责单一）。
     */
    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly chatState: ChatState,
        private readonly onMessage: (msg: FrontendMessage) => void | Promise<void>,
        /** pi 的工作目录（= VS Code 工作区目录）→ 显示在输入区下方的极简栏 ✓ */
        private readonly cwd: string,
    ) {
        // 状态变化 → 增量推给 webview
        // （view 不存在时 post() 静默丢弃；重建时会在 resolveWebviewView 里重放全量）
        chatState.onChange((patch) => {
            this.post("patch", patch);
        });

        // 样式设置变化 → 实时推给 webview（不重建 DOM，只改 CSS 变量）
        this.styleChangeSub = onStyleChange(() => {
            this.post("styleVars", readStyleVars());
        });
    }

    /** 设置变化订阅（需要外部 dispose；也可由调用方把它塞进 context.subscriptions） */
    private styleChangeSub: vscode.Disposable | undefined;

    dispose(): void {
        this.styleChangeSub?.dispose();
    }

    /** VS Code 在视图第一次显示时调用 */
    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;

        webviewView.webview.options = { enableScripts: true };
        // 从 media/chat.html 读取 + 注入 CSP nonce + 注入样式变量
        webviewView.webview.html = loadWebviewHtml(
            this.extensionUri,
            "chat.html",
            webviewView.webview,
            styleVarsToCss(readStyleVars()),
        );

        // 接收 webview 页面发来的消息
        webviewView.webview.onDidReceiveMessage((msg: unknown) => {
            // webview 发来的是任意 JSON，先做最小校验
            if (!msg || typeof msg !== "object") return;
            const kind = (msg as { kind?: unknown }).kind;
            if (typeof kind !== "string") return;

            // webview 就绪 → 重放全量快照
            // （webview 被销毁重建后靠这个恢复画面 —— “显示器”没脑子，状态都在插件端）
            if (kind === "ready") {
                // ★ 先推样式变量：布尔开关（如 centerColumn）需要在 webview 里切 CSS 类，
                //   否则重建后“设置里有、但视觉没生效” ✗
                this.post("styleVars", readStyleVars());
                // ★ 模型上下文窗口表（顶部状态栏的电池分母；查不到则前端显示 "?"）
                this.post("modelLimits", getModelContextWindowsObject());
                // ★ 工作目录（输入区下方极简栏）
                this.post("cwd", this.cwd);
                this.post("snapshot", this.chatState.snapshot());
                return;
            }

            // 其余消息交给业务出口（main.ts → format 层白名单）
            void this.onMessage(msg as FrontendMessage);
        });
    }

    /** 扩展宿主 → 前端（view 不存在时静默丢弃） */
    post(kind: string, payload: unknown): void {
        this.view?.webview.postMessage({ kind, payload });
    }
}

/**
 * history-panel.ts —— ★★ B47：完整历史面板的宿主端
 *
 * 【它和 SessionPanel 的差别】
 *   骨架完全一样（WebviewPanel + 记住列 + ready 握手 ✓）
 *   差别只在【推什么数据】：
 *     · SessionPanel  推会话列表
 *     · 这个推【一整个会话的全部消息】（含已被压缩掉的 ✓）
 *
 * 【★ 为什么是"只读"】它渲染的是【档案】✗ 不是 pi 的活动上下文 ✓
 *   ⇒ 所以没有输入框 / 没有发送 / 没有工具按钮（HTML 里根本没放 ✓）
 */
import * as vscode from "vscode";
import { loadWebviewHtml } from "./html-loader.js";
import { classNamesFromVars, readStyleVars, styleVarsToCss } from "./style-config.js";

export class HistoryPanel {
    private panel: vscode.WebviewPanel | undefined;
    private lastColumn: vscode.ViewColumn = vscode.ViewColumn.One;

    constructor(
        private readonly extensionUri: vscode.Uri,
        /** ★ 面板要数据时回调（前端发 ready ✓）*/
        private readonly onMessage: (kind: string, payload?: unknown) => void,
    ) {}

    /**
     * 打开 / 显示某个会话的完整历史
     * ★ title 用会话名 ⇒ 用户一眼知道这是哪个会的档案 ✓
     */
    show(title: string): void {
        if (!this.panel) {
            const panel = vscode.window.createWebviewPanel(
                "pi-bridge.fullHistory",
                `完整历史：${title}`,
                this.lastColumn,
                {
                    enableScripts: true,
                    // ★★ B47：切到别的 tab 再切回来【不要销毁重建】
                    //   默认 false ⇒ webview 一隐藏就丢 DOM ✗ 回来时
                    //   重新加载 2.9MB 脚本 + 重渲染上百条消息 ⇒ 白等一会儿 ✓
                    //   （用户报的："随便切个别的 webview 再切回来，又得等"✓）
                    //   代价：这个面板在后台也占内存 ✗ 可接受（它就是个只读档案 ✓）
                    retainContextWhenHidden: true,
                },
            );
            this.panel = panel;
            panel.onDidChangeViewState(() => {
                if (panel.viewColumn) this.lastColumn = panel.viewColumn;
            });

            // ★ 样式变量要注入（B31 的教训 ✓ 否则主题色 / 字号不对 ✓）
            const vars = readStyleVars();
            panel.webview.html = loadWebviewHtml(
                this.extensionUri,
                "history.html",
                panel.webview,
                styleVarsToCss(vars),
                classNamesFromVars(vars).join(" "),
            );

            panel.webview.onDidReceiveMessage((msg: { kind?: string }) => {
                if (typeof msg?.kind !== "string") return;
                this.onMessage(msg.kind, msg);
            });

            panel.onDidDispose(() => {
                this.panel = undefined;
            });
        } else {
            this.panel.title = `完整历史：${title}`;
        }
        this.panel.reveal(this.panel.viewColumn ?? this.lastColumn);
    }

    /** 推数据（没打开就静默丢弃 ✗ 前端 ready 时会重新要 ✓）*/
    post(kind: string, payload: unknown): void {
        this.panel?.webview.postMessage({ kind, payload });
    }

    /**
     * ★ B47：把样式变量推过去（和 settings-panel 同一套路 ✓）
     *
     * 【为什么必须推】webview 里的"默认折叠开关"是【布尔】✗ 不是 CSS 变量 ✓
     *   （见 webview/input.ts 的 syncUiFlags ✓）
     *   HTML 里注入的那份只在【页面加载时】有效 ✗
     *   而配置可能【后改】⇒ 要能实时推过去 ✓
     */
    postStyleVars(): void {
        this.post("styleVars", readStyleVars());
    }

    isOpen(): boolean {
        return this.panel !== undefined;
    }

    hide(): void {
        this.panel?.dispose();
    }
}

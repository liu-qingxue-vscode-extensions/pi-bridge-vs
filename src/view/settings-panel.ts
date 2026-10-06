/**
 * settings-panel.ts —— 设置面板的宿主端（B35 ✓）
 *
 * 【★ 它管的是 pi 的 settings.json】✗（不是 VS Code 的配置 ✓）
 *   RPC 没有 settings 接口 ✗ → 宿主自己读写文件 ✓
 *
 * 【★ 为什么从侧栏搬到编辑器区？】（用户定的 ✓）
 *   设置项越来越多（模型 / 行为 / 环境 / 技能 / 凭据 …✓）
 *   侧栏那一小块【塞不下】✗ 而且和会话 / 通知面板挤在一起 ✓
 *   编辑器区能排得开 ✗ 一行一项看得舒服 ✓
 *
 * 【和 SessionPanel 的关系】
 *   骨架完全一样（WebviewPanel + 记住上次的列 + ready 握手 ✓）
 *   ★ 差别：它要注入 styleVars ✗ 而且字号等样式靠 CSS 变量 ✓
 */
import * as vscode from "vscode";
import { loadWebviewHtml } from "./html-loader.js";
import { classNamesFromVars, readStyleVars, styleVarsToCss } from "./style-config.js";

export class SettingsPanel {
    private panel: vscode.WebviewPanel | undefined;
    /** ★ 记住上次所在的列（默认第一组 ✗ 同其他面板 ✓）*/
    private lastColumn: vscode.ViewColumn = vscode.ViewColumn.One;

    constructor(
        private readonly extensionUri: vscode.Uri,
        /** ★ 面板发来的消息（含 ready ✗ 宿主据此推数据 ✓）*/
        private readonly onMessage: (kind: string, payload?: unknown) => void,
    ) {}

    /** ⚙ 按钮 / 命令入口 ✓ */
    show(): void {
        if (!this.panel) {
            const panel = vscode.window.createWebviewPanel(
                "pi-bridge.settings",
                "Pi 设置",
                this.lastColumn,
                { enableScripts: true },
            );
            this.panel = panel;

            panel.onDidChangeViewState(() => {
                if (panel.viewColumn) this.lastColumn = panel.viewColumn;
            });

            const vars = readStyleVars();
            panel.webview.html = loadWebviewHtml(
                this.extensionUri,
                "settings.html",
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
        }
        this.panel.reveal(this.panel.viewColumn ?? this.lastColumn);
    }

    /** ★ 已打开 → 推数据（没打开就静默丢弃 ✗ 下次打开会主动要 ✓）*/
    post(kind: string, payload: unknown): void {
        this.panel?.webview.postMessage({ kind, payload });
    }

    isOpen(): boolean {
        return this.panel !== undefined;
    }

    /** ★ 外部改配置后要重推（比如字号变了 ✓）*/
    refreshStyle(): void {
        if (!this.panel) return;
        const vars = readStyleVars();
        this.post("styleVars", vars);
    }

    /** ★★ B37：面板是不是【正显示着】（给侧栏按钮的 toggle 用 ✗ 同 session-panel ✓）*/
    isVisible(): boolean {
        return this.panel?.visible ?? false;
    }

    /** ★★ 主动关闭（B35 ④ ✗ 给「互斥」用 ✓）*/
    hide(): void {
        this.panel?.dispose();
    }
}

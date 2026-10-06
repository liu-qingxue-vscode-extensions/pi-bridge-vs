/**
 * skills-panel.ts —— 技能面板的宿主端（B31 ✓）
 *
 * 【★ 为什么从侧栏搬到编辑器区？】（用户定的 ✓）
 *   侧栏天然逼仄 ✗ 而技能内容（SKILL.md 正文）很长 ✓
 *   ★ 而且和交互面板一样 ✗ "需要动手的窗口"不该挤在侧栏 ✓
 *
 * 【和 InteractionPanel 的关系】
 *   套路完全一样（WebviewPanel + 记住上次的列 ✓）
 *   差别：★ 它没有队列 / 没有自动关闭 / 没有握手生命周期 ✓
 *        —— 它就是个"看得久一点的窗口"✓ 打开了就一直开着 ✓
 */
import * as vscode from "vscode";
import { loadWebviewHtml } from "./html-loader.js";

export class SkillsPanel {
    private panel: vscode.WebviewPanel | undefined;
    /** ★ 记住上次所在的列（默认第一组 ✗ 同 debug/interaction ✓）*/
    private lastColumn: vscode.ViewColumn = vscode.ViewColumn.One;

    constructor(
        private readonly extensionUri: vscode.Uri,
        /** ★ 面板需要数据时问宿主 ✗（skills / skillDetail ✓）*/
        private readonly onMessage: (kind: string, payload?: unknown) => void,
    ) {}

    /** 命令 / 侧栏按钮入口 ✓ */
    show(): void {
        if (!this.panel) {
            const panel = vscode.window.createWebviewPanel(
                "pi-bridge.skills",
                "Pi 技能",
                this.lastColumn,
                { enableScripts: true },
            );
            this.panel = panel;

            panel.onDidChangeViewState(() => {
                if (panel.viewColumn) this.lastColumn = panel.viewColumn;
            });

            panel.webview.html = loadWebviewHtml(
                this.extensionUri,
                "skills.html",
                panel.webview,
            );

            panel.webview.onDidReceiveMessage((msg: { kind?: string; name?: string }) => {
                if (typeof msg?.kind !== "string") return;
                // ★ 前端来的请求 → 交给 main（它去读磁盘 / 建文件 ✓）
                this.onMessage(msg.kind, msg);
            });

            panel.onDidDispose(() => {
                this.panel = undefined;
            });
        }
        this.panel.reveal(this.panel.viewColumn ?? this.lastColumn);
    }

    /** ★ 已打开 → 推数据（没打开就【静默丢弃】✗ 下次打开时会主动要 ✓）*/
    post(kind: string, payload: unknown): void {
        this.panel?.webview.postMessage({ kind, payload });
    }

    isOpen(): boolean {
        return this.panel !== undefined;
    }

    /** ★★ B37：面板是不是【正显示着】（给侧栏按钮的 toggle 用 ✗ 同 session-panel ✓）*/
    isVisible(): boolean {
        return this.panel?.visible ?? false;
    }

    /**
     * ★★ 主动关闭（B35 ✓）
     *
     * 【两个调用方】
     *   ① 三面板互斥（main.ts 的 showExclusive ✓）—— 打开别的 → 关掉这个 ✓
     *   ② 动作后自动关闭（pi-bridge.skills.closeAfterAction ✓）
     *      —— 单击 / 注入 / 发送之后关掉自己 ✓
     *
     * ★ 用 dispose（WebviewPanel 没有 hide ✓ 见 session-panel 的同名注释 ✓）
     * ★ 这里 dispose 没有副作用：onDidDispose 只把 this.panel 置空 ✓
     */
    hide(): void {
        this.panel?.dispose();
    }
}

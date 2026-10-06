/**
 * session-panel.ts —— 会话面板的宿主端（B35 ✓）
 *
 * 【★ 为什么从侧栏搬到编辑器区？】（用户定的 ✓）
 *   侧栏天然逼仄 ✗ 会话多了看不全 ✓
 *   编辑器区能排得开 ✗ 而且跟技能 / 交互 / 命令面板同一套路 ✓
 *
 * 【和 SkillsPanel 的关系】
 *   骨架完全一样（WebviewPanel + 记住上次的列 ✓）
 *   差别：★ 它需要【推数据】✗ 而且前端会主动要 ✓
 *        —— 多一个 ready 握手（见 onMessage 的 ready 分支 ✓）
 *
 * 【★ 消息格式】（面板私有通道 ✗ 两边都包 payload ✓）
 *   宿主 → 前端：sessionList { list, currentCwd } / sessionToast { text, err }
 *   前端 → 宿主：ready / refreshSessions / newSession / switchSession /
 *                exportSession / importSession / deleteSession
 */
import * as vscode from "vscode";
import { loadWebviewHtml } from "./html-loader.js";
import { classNamesFromVars, readStyleVars, styleVarsToCss } from "./style-config.js";

export class SessionPanel {
    private panel: vscode.WebviewPanel | undefined;
    /** ★ 记住上次所在的列（默认第一组 ✗ 同 debug/interaction/skills ✓）*/
    private lastColumn: vscode.ViewColumn = vscode.ViewColumn.One;

    constructor(
        private readonly extensionUri: vscode.Uri,
        /** ★ 面板发来的消息（含 ready ✗ 宿主据此推列表 ✓）*/
        private readonly onMessage: (kind: string, payload?: unknown) => void,
    ) {}

    /** 命令 / 侧栏按钮入口 ✓ */
    show(): void {
        if (!this.panel) {
            const panel = vscode.window.createWebviewPanel(
                "pi-bridge.sessions",
                "Pi 会话",
                this.lastColumn,
                { enableScripts: true },
            );
            this.panel = panel;

            panel.onDidChangeViewState(() => {
                if (panel.viewColumn) this.lastColumn = panel.viewColumn;
            });

            // ★★ 样式变量要注入（B31 教训 ✗ 否则开关类首屏失效 ✓）
            //   session.css 里的字号 / 颜色都靠这些变量 ✓
            const vars = readStyleVars();
            panel.webview.html = loadWebviewHtml(
                this.extensionUri,
                "session.html",
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

    /** ★ 已打开 → 推数据（没打开就【静默丢弃】✗ 下次打开时会主动要 ✓）*/
    post(kind: string, payload: unknown): void {
        this.panel?.webview.postMessage({ kind, payload });
    }

    isOpen(): boolean {
        return this.panel !== undefined;
    }

    /**
     * ★★ 主动关闭（B35 ✓ 给「三面板互斥」用 ✗ 见 main.ts 的 showExclusive ✓）
     *
     * 【为什么是 dispose 而不是什么 hide？】
     *   VS Code 的 WebviewPanel 【没有 hide()】✗ 想让它消失只有 dispose ✓
     *   代价：下次 show() 会【重建】✗ 前端重新加载 → 再走一次 sessionReady 握手 ✓
     *   （列表会重新推一遍 ✗ 用户看到的是“面板重新出现”✓ 可接受 ✓）
     */
    /**
     * ★★ B37：面板是不是【正显示着】（被别的 tab 盖住时 visible=false ✓）
     *
     * 【为什么要它？】
     *   侧栏按钮要做【再点一次就关掉】（toggle ✓）✗ 而判断依据必须是
     *   “它现在真的在用户眼前”✗ 不是“它存在”✓
     *   · 存在但被盖住（visible=false）→ 点按钮应该【把它露出来】✓
     *   · 存在且就在眼前（visible=true）→ 点按钮应该【关掉它】✓
     *   ★ 只看 isOpen() 就会把“在后台的那个面板”直接关掉 ✗ 不符合直觉 ✓
     */
    isVisible(): boolean {
        return this.panel?.visible ?? false;
    }

    hide(): void {
        this.panel?.dispose();
    }
}

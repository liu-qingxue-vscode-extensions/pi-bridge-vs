/**
 * command-panel.ts —— 自由按钮的配置页面（宿主端，B32 ②）
 *
 * 【形态】编辑器区的独立 WebviewPanel（跟技能面板同套路 ✓）
 *   ★ 为什么不塞在侧栏？→ 表单字段多 ✗ 侧栏挤 ✓
 *
 * 【消息】★ 两套格式别搞混（B32 踩过 ✗）
 *   面板 → 宿主：{ kind, payload }
 *   宿主 → 面板：{ kind, payload }
 *   （这里是【面板自己的私有通道】✗ 不经过 chat-view ✓
 *    所以两边都统一用 payload 包 ✓ 跟聊天页那条路不一样 ✓）
 */
import * as vscode from "vscode";
import { loadWebviewHtml } from "./html-loader.js";

/** ★ 面板里编辑的对象（形状跟 command-store 的 CmdItem 一致 ✓）*/
export type CommandDraft = Record<string, unknown>;

export class CommandPanel {
    private panel: vscode.WebviewPanel | undefined;
    private lastColumn: vscode.ViewColumn = vscode.ViewColumn.One;
    /** ★ 待发送的草稿（webview 就绪后发 ✗ 否则会丢 ✓）*/
    private pending: { draft: CommandDraft; isNew: boolean } | undefined;

    constructor(
        private readonly extensionUri: vscode.Uri,
        /** ★ 面板发回来的消息（commandSave / commandCancel ✓）*/
        private readonly onMessage: (kind: string, payload?: unknown) => void,
    ) {}

    /**
     * ★ 打开配置页面
     * @param draft 当前值（编辑传已有项 ✗ 新建传空对象 ✓）
     * @param isNew 新建（影响标题 ✓）
     */
    open(draft: CommandDraft, isNew: boolean): void {
        // ★ 先把草稿存下 ✗ 不管面板是新建还是复用 ✓
        this.pending = { draft, isNew };

        if (!this.panel) {
            const panel = vscode.window.createWebviewPanel(
                "pi-bridge.commandEdit",
                isNew ? "新建自由按钮" : "编辑自由按钮",
                this.lastColumn,
                { enableScripts: true },
            );
            this.panel = panel;

            panel.onDidChangeViewState(() => {
                if (panel.viewColumn) this.lastColumn = panel.viewColumn;
            });

            panel.webview.html = loadWebviewHtml(
                this.extensionUri,
                "command.html",
                panel.webview,
            );

            panel.webview.onDidReceiveMessage((msg: { kind?: string; payload?: unknown }) => {
                if (typeof msg?.kind !== "string") return;
                // ★ 前端就绪 → 把草稿发过去 ✓
                //   （每次 ready 都发 ✗ 所以刷新面板也不会丢内容 ✓）
                if (msg.kind === "ready") {
                    this.flush();
                    return;
                }
                this.onMessage(msg.kind, msg.payload);
            });

            panel.onDidDispose(() => {
                this.panel = undefined;
                this.pending = undefined;
            });
        } else {
            // ★ 已经开着 → 只换内容与标题（不重建面板 ✓）
            this.panel.title = isNew ? "新建自由按钮" : "编辑自由按钮";
        }

        this.panel.reveal(this.panel.viewColumn ?? this.lastColumn);
        // ★ 面板已经就绪的情况（复用同一个面板）→ 立刻推 ✓
        //   刚创建的情况 → html 还没加载完 ✗ 等它发 ready 再推 ✓
        this.flush();
    }

    /** ★ 把当前草稿推给前端（没草稿就不动 ✓）*/
    private flush(): void {
        if (!this.pending) return;
        void this.panel?.webview.postMessage({
            kind: "commandDraft",
            payload: this.pending,
        });
    }

    /** ★ 保存成功 → 关掉（用户心智：保存即完成 ✓）*/
    close(): void {
        this.panel?.dispose();
    }

    isOpen(): boolean {
        return this.panel !== undefined;
    }

    post(kind: string, payload: unknown): void {
        void this.panel?.webview.postMessage({ kind, payload });
    }
}

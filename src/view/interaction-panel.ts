/**
 * interaction-panel.ts —— 交互面板的宿主端（B26）
 *
 * 【它解决什么？】
 *   pi 扩展提问（select / confirm / input / editor ✓）时，把问答
 *   从【聊天侧栏】搬到【独立编辑器页面】✗
 *
 * 【★ 三条生命周期规则】（用户定的 ✓ 见 B26 文档）
 *   ① 问题一到 → ★ 自动弹出并聚焦 ✓（不让用户漏看 ✓）
 *   ② 答完全部 → ★ 自动关闭 ✓（由配置 pi-bridge.interaction.autoClose 控制 ✓）
 *      ★ 关掉后焦点回聊天输入框 ✓
 *   ③ 用户【手动关】面板 → ★ 直接取消全部未答请求 ✗
 *      （用户原话：“我都手动去关闭这个面板，那肯定直接取消掉啊，
 *        这意图很明显嘛。什么误取消？这意图已经很明显了。”✓）
 *
 * 【★ 为什么是“取消全部”而不是“只取消当前”？】
 *   pi 侧是【串行 await】✗ 所以队列里几乎不会有多个（除非扩展乱发 ✓）
 *   而“关面板”表达的是“我不想答了”✓ → 全取消最符合意图 ✓
 *
 * 【和 debug-panel 的关系】
 *   套路完全一样（WebviewPanel + 记住上次的列 ✓）
 *   差别：它不是“观察窗口”✗ 而是【要求你动手】的窗口 ✓
 *   → 所以它有队列、有握手、有生命周期 ✓
 */
import * as vscode from "vscode";
import { loadWebviewHtml } from "./html-loader.js";

export interface UiReq {
    id: string;
    method: "select" | "confirm" | "input" | "editor";
    title: string;
    message?: string;
    options?: string[];
    placeholder?: string;
    prefill?: string;
    timeout?: number;
}

export type UiRes = { value?: string; confirmed?: boolean; cancelled?: boolean };

export class InteractionPanel {
    private panel: vscode.WebviewPanel | undefined;
    /** 待答队列（[0] = 正在答的 ✓）*/
    private pending: UiReq[] = [];
    /** ★ 记住上次所在的列（默认第一组 ✓ 同 debug-panel ✓）*/
    private lastColumn: vscode.ViewColumn = vscode.ViewColumn.One;
    /** ★ 标记“这是我们自己关的”✗（用来区分用户手动关 ✓）*/
    private closingByUs = false;
    /** ★ “延迟关闭”的计时器（B26：吸收串行连问 ✗ 见 closeByUs ✓）*/
    private closeTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(
        private readonly extensionUri: vscode.Uri,
        /** 用户答复 → 交给 main（main 负责写 stdin + 通知各处 ✓）*/
        private readonly onReply: (id: string, res: UiRes, from: "panel" | "sidebar") => void,
        /** 队列变化 → 通知 main 更新侧栏提示条 ✓ */
        private readonly onStateChange: () => void,
        /** 读配置（实时 ✓）*/
        private readonly isAutoClose: () => boolean,
        /**
         * ★ 关闭延迟（毫秒 ✗ 0 = 立刻关 ✓）
         *   用来吸收串行连问的下一个请求 ✓（见 closeByUs ✓）
         */
        private readonly closeDelayMs: () => number,
        /** 面板关闭后 → 焦点回聊天输入框 ✓ */
        private readonly onClosed: () => void,
    ) {}

    hasPending(): boolean {
        return this.pending.length > 0;
    }
    /** 当前请求（侧栏提示条要用 ✓）*/
    current(): UiReq | undefined {
        return this.pending[0];
    }

    /**
     * ★ pi 来问题了 → 立刻弹面板 ✓
     *
     * 【★ 为什么不再“等聚合窗口”？】（用户定的 ✓）
     *   不用人为延迟 ✗ —— 因为“是不是一批”的判定【不靠到达时刻】✗
     *   而是靠【用户提交那一刻队列里有几个】✓（见前端 views/state ✓）
     *   两种判定其实等价（因为并发的第 2 个是毫秒级到 ✗
     *   而串行的第 2 个要等你提交才可能出现 ✓）
     *   → 那就没必要让用户白等 250ms ✗ 有问题就立刻弹 ✓
     */
    push(req: UiReq): void {
        this.pending.push(req);
        this.ensure();
        // ★ 弹到前面并聚焦 ✗（这是“需要你动手”的窗口 ✓ 不能静静躺在后面 ✓）
        this.panel?.reveal(this.panel.viewColumn ?? this.lastColumn);
        this.sync();
    }

    /** 某个请求被答复了（来源可能是面板，也可能是侧栏的[取消]✓）*/
    resolved(id: string): void {
        const i = this.pending.findIndex((r) => r.id === id);
        if (i >= 0) this.pending.splice(i, 1);

        if (this.pending.length === 0 && this.panel && this.isAutoClose()) {
            this.closeByUs();
        } else {
            this.sync();
        }
    }

    /** 侧栏[前往] / 命令入口 ✓ */
    show(): void {
        if (this.pending.length === 0) return;
        this.ensure();
        this.panel?.reveal(this.panel.viewColumn ?? this.lastColumn);
    }

    /**
     * 我们主动关闭：答完了 ✓
     *
     * 【★ 为什么不立刻关？】（B26 ✗ 吸收串行连问 ✓）
     *   串行扩展的场景：ask-user-question 一连问 4 个 ✓
     *     你答完第 1 个 → 我们发 → 它才发第 2 个（毫秒级 ✗）
     *     若“立刻关” → 面板闪一下又弹出来 ✗ 闪 4 次 ✓
     *   → 所以：延迟 closeDelayMs 再关 ✗
     *     这期间新请求来了 → 【取消关闭】✓ 面板保持 ✓ 直接显示新题 ✓
     *
     * 【★ 它不改变发送时机】
     *   每答完一题还是【立刻发】✓（否则串行会死锁 ✗）
     *   只是“不立刻关面板”✓ 用户看得出来才怪 ✓
     */
    private closeByUs(): void {
        clearTimeout(this.closeTimer);
        this.closeTimer = setTimeout(() => {
            // ★ 等待期间来了新请求 → 不关了 ✓
            if (this.pending.length > 0) return;
            this.closingByUs = true;
            this.panel?.dispose(); // → onDidDispose 里看到 closingByUs ✓ 不取消任何东西 ✓
            this.onStateChange();
            this.onClosed();
        }, this.closeDelayMs());
    }

    private ensure(): void {
        if (this.panel) return;

        const panel = vscode.window.createWebviewPanel(
            "pi-bridge.interaction",
            this.title(),
            this.lastColumn,
            { enableScripts: true },
        );
        this.panel = panel;

        // 用户拖动面板换列 → 记住它（下次就近去那里 ✓）
        panel.onDidChangeViewState(() => {
            if (panel.viewColumn) this.lastColumn = panel.viewColumn;
        });

        panel.webview.html = loadWebviewHtml(this.extensionUri, "interaction.html", panel.webview);

        panel.webview.onDidReceiveMessage((msg: { kind?: string; id?: string } & UiRes) => {
            if (msg?.kind === "ready") {
                this.sync(); // 前端刚加载完 → 把队列刷给它 ✓
                return;
            }
            if (msg?.kind === "uiResponse" && msg.id) {
                this.onReply(
                    msg.id,
                    { value: msg.value, confirmed: msg.confirmed, cancelled: msg.cancelled },
                    "panel",
                );
            }
        });

        panel.onDidDispose(() => {
            this.panel = undefined;
            if (this.closingByUs) {
                this.closingByUs = false; // ★ 复位：下次还是同一个实例 ✓
                return;
            }
            // ★★ 用户手动关 = 取消全部未答请求 ✗（意图明显 ✓）
            const ids = this.pending.map((r) => r.id);
            this.pending = [];
            for (const id of ids) this.onReply(id, { cancelled: true }, "panel");
            this.onStateChange();
        });
    }

    /** 推队列给前端 + 更新标题 + 通知侧栏 ✓ */
    private sync(): void {
        this.panel?.webview.postMessage({ kind: "queue", payload: this.pending });
        if (this.panel) this.panel.title = this.title();
        this.onStateChange();
    }

    private title(): string {
        const n = this.pending.length;
        return n > 1 ? `Pi 交互（${n}）` : "Pi 交互";
    }
}

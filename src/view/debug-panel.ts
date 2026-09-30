/**
 * DebugPanel —— 调试板（第一步的主角）
 *
 * 【职责】
 * 1. 后台静默收集：所有后端数据都进环形缓冲（不管面板开没开）
 * 2. 命令/快捷键打开面板：把缓冲里的历史 + 之后的新数据都推给前端
 * 3. 面板关闭后继续收集（数据不丢），下次打开能看到最近的历史
 *
 * 【为什么用独立 panel 而不是侧边栏视图？】
 * - 调试板是"按需弹出"的观察窗口，不该常驻占用侧边栏
 * - 关闭后零干扰，但缓冲继续工作（内存里就一个数组）
 */
import * as vscode from "vscode";
import { loadWebviewHtml } from "./html-loader.js";

/** 环形缓冲：容量固定，满了丢最旧的 */
class RingBuffer<T> {
    private items: T[] = [];

    constructor(private readonly capacity: number) {}

    push(item: T): void {
        this.items.push(item);
        if (this.items.length > this.capacity) {
            this.items.shift(); // 丢掉最旧的
        }
    }

    /** 快照（拷贝一份，避免外部修改内部数组） */
    snapshot(): T[] {
        return [...this.items];
    }

    clear(): void {
        this.items = [];
    }

    get size(): number {
        return this.items.length;
    }
}

export class DebugPanel {
    /** 面板实例（undefined = 当前没打开） */
    private panel: vscode.WebviewPanel | undefined;

    /** 后台缓冲：容量 500 条，够调试用 */
    private readonly buffer = new RingBuffer<unknown>(500);

    /** @param extensionUri 扩展根目录（用于读取 media/debug.html） */
    constructor(private readonly extensionUri: vscode.Uri) {}

    /**
     * 记录一条数据（由 main.ts 的数据流调用）
     * - 黑名单过滤：配置里列出的类型不显示（已实现 UI 的类型可以屏蔽）
     * - 无论面板是否打开都进缓冲
     * - 面板打开时，实时推给前端
     */
    log(payload: unknown): void {
        // 读配置：在调试板中隐藏的类型（每次读取 → 改设置立即生效）
        const hidden = vscode.workspace
            .getConfiguration("pi-bridge.debug")
            .get<string[]>("hiddenTypes", []);
        const type = (payload as { type?: string } | null)?.type;
        if (type && hidden.includes(type)) {
            return; // 在黑名单里 → 不显示
        }

        this.buffer.push(payload);
        this.panel?.webview.postMessage({ kind: "debug", payload });
    }

    /** 命令入口：打开（或聚焦）调试板 */
    show(): void {
        // 已打开 → 只聚焦，不重复创建
        if (this.panel) {
            this.panel.reveal();
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            "pi-bridge.debug",      // viewType：同类面板的唯一标识
            "Pi 调试板",             // 标题
            vscode.ViewColumn.Beside, // 显示位置：当前编辑器旁边
            { enableScripts: true }, // 允许 webview 里跑 JS
        );

        this.panel.webview.html = loadWebviewHtml(this.extensionUri, "debug.html", this.panel.webview);

        // 接收前端（调试板 HTML）发来的消息
        this.panel.webview.onDidReceiveMessage((msg) => {
            if (msg.kind === "debug-ready") {
                // 前端刚打开：把缓冲里的历史刷给它
                for (const payload of this.buffer.snapshot()) {
                    this.panel?.webview.postMessage({ kind: "debug", payload });
                }
            }
            if (msg.kind === "clear") {
                this.buffer.clear();
            }
        });

        // 面板被用户关闭：标记为 undefined（缓冲继续收集）
        this.panel.onDidDispose(() => {
            this.panel = undefined;
        });
    }
}

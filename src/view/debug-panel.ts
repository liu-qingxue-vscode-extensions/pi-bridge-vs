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
import path from "node:path";
import os from "node:os";
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

    /** 最后一条（折叠计数用：判断是否与上一条同类型） */
    last(): T | undefined {
        return this.items[this.items.length - 1];
    }

    clear(): void {
        this.items = [];
    }

    get size(): number {
        return this.items.length;
    }
}

/**
 * 折叠载荷 —— 命中“忽略列表”的数据用计数代替
 *
 * 【为什么不是直接丢弃？】
 * 丢弃会让调试板的时序语义错乱：中间整段消失，看不出“这里发生过什么”。
 * 折叠保留了【位置】和【数量】两个关键信息，只是不存详情。
 */
interface FoldedPayload {
    type: string;
    folded: true;
    count: number;
}

/** 类型守卫：是不是折叠载荷 */
function isFoldedPayload(x: unknown): x is FoldedPayload {
    return !!x && typeof x === "object" && (x as { folded?: unknown }).folded === true;
}

/**
 * 缓冲条目 = 数据 + 【宿主记录的】时间戳
 *
 * 时间戳必须在宿主侧记录：前端渲染时刻 ≠ 事件发生时刻
 * （尤其是打开面板刷历史时，所有旧数据都会被打上“现在”的时间）
 */
interface LogEntry {
    ts: number;
    payload: unknown;
}

/**
 * 时间戳（文件名用）：20261002-151915
 * ★ 用可读格式而不是毫秒数 —— 导出一堆数据时便于一眼分辨先后 ✓
 */
function formatStamp(d: Date): string {
    const p = (n: number) => String(n).padStart(2, "0");
    return (
        `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
        `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
    );
}

export class DebugPanel {
    /** 面板实例（undefined = 当前没打开） */
    private panel: vscode.WebviewPanel | undefined;

    /** 后台缓冲：容量 500 条，够调试用（每条带宿主记录的时间戳） */
    private readonly buffer = new RingBuffer<LogEntry>(500);

    /**
     * @param extensionUri 扩展根目录（用于读取 media/debug.html）
     * @param context 扩展上下文（用 globalState 记住上次的导出路径）
     */
    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly context: vscode.ExtensionContext,
    ) {}

    /**
     * 记录一条数据（由 main.ts 的数据流调用）
     * - 命中忽略列表 → 【折叠计数】（保住时序，不存详情）
     * - 无论面板是否打开都进缓冲
     * - 面板打开时，实时推给前端
     */
    log(payload: unknown): void {
        const type = (payload as { type?: string } | null)?.type;
        const ts = Date.now(); // ★ 宿主侧记录时间（前端渲染时刻不准）

        // 命中忽略列表 → 折叠（而不是丢弃）
        if (type && this.isHidden(type)) {
            const last = this.buffer.last();
            if (last && isFoldedPayload(last.payload) && last.payload.type === type) {
                // 与上一条同类型 → 累加到同一个折叠段（时间戳保持段开始的时刻）
                last.payload.count++;
                this.panel?.webview.postMessage({
                    kind: "debug-fold", type, count: last.payload.count, ts: last.ts,
                });
            } else {
                // 开一个新的折叠段（位置就在数据流当前处 ✓ 时序不乱）
                const folded: FoldedPayload = { type, folded: true, count: 1 };
                this.buffer.push({ ts, payload: folded });
                this.panel?.webview.postMessage({ kind: "debug-fold", type, count: 1, ts });
            }
            return;
        }

        this.buffer.push({ ts, payload });
        this.panel?.webview.postMessage({ kind: "debug", payload, ts });
    }

    /** 是否命中忽略列表（每次都读配置 → 改设置立即生效） */
    private isHidden(type: string): boolean {
        const hidden = vscode.workspace
            .getConfiguration("pi-bridge.debug")
            .get<string[]>("hiddenTypes", []);
        return hidden.includes(type);
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
                // （折叠条目要还原成 debug-fold 协议，而不是当普通数据发）
                for (const entry of this.buffer.snapshot()) {
                    if (isFoldedPayload(entry.payload)) {
                        this.panel?.webview.postMessage({
                            kind: "debug-fold",
                            type: entry.payload.type,
                            count: entry.payload.count,
                            ts: entry.ts,
                        });
                    } else {
                        this.panel?.webview.postMessage({
                            kind: "debug",
                            payload: entry.payload,
                            ts: entry.ts,
                        });
                    }
                }
            }
            if (msg.kind === "clear") {
                this.buffer.clear();
            }
            if (msg.kind === "export") {
                void this.exportBuffer();
            }
        });

        // 面板被用户关闭：标记为 undefined（缓冲继续收集）
        this.panel.onDidDispose(() => {
            this.panel = undefined;
        });
    }

    /**
     * 导出环形缓冲为 JSON 文件
     *
     * 【默认路径】优先用上次导出过的路径（存在 globalState），
     * 这样用户改一次之后就固定下来，不用每次都选。
     * 首次导出时，默认放在工作区根目录（无工作区则 HOME），文件名带时间戳。
     */
    private async exportBuffer(): Promise<void> {
        // 解包成裸数据（导出格式保持简单：就是数据数组）
        const items = this.buffer.snapshot().map((entry) => entry.payload);
        if (items.length === 0) {
            void vscode.window.showInformationMessage("调试板缓冲是空的，没有可导出的数据");
            return;
        }

        // 默认路径：★ 时间戳必须是【新的】（否则连续导出会覆盖同一个文件 ✗）
        //   只记住【目录】，文件名每次都重新生成 ✓
        const lastPath = this.context.globalState.get<string>("pi-bridge.debug.exportPath");
        const fallbackDir =
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
        const dir = lastPath ? path.dirname(lastPath) : fallbackDir;
        const defaultUri = vscode.Uri.file(
            path.join(dir, `pi-debug-${formatStamp(new Date())}.json`),
        );

        const uri = await vscode.window.showSaveDialog({
            defaultUri,
            filters: { JSON: ["json"] },
            title: "导出调试数据",
        });
        if (!uri) return; // 用户取消

        // 记住这个路径（下次作为默认值）
        await this.context.globalState.update("pi-bridge.debug.exportPath", uri.fsPath);

        const content = JSON.stringify(items, null, 2);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
        void vscode.window.showInformationMessage(
            `已导出 ${items.length} 条 → ${uri.fsPath}`,
        );
    }
}

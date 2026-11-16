/**
 * DebugPanel - 调试板(第一步的主角)
 *
 * [职责]
 * 1. 后台静默收集:所有后端数据都进环形缓冲(不管面板开没开)
 * 2. 命令/快捷键打开面板:把缓冲里的历史 + 之后的新数据都推给前端
 * 3. 面板关闭后继续收集(数据不丢),下次打开能看到最近的历史
 *
 */
import * as vscode from "vscode";
import path from "node:path";
import os from "node:os";

import { RingBuffer } from "../../util/ring-buffer.js";
import { vsSettings } from "../../external-data/vs-settings.js";
import { loadWebviewHtml } from "../../external-data/html-loader.js";
import { formatStamp } from "../../util/format-stamp.js";
import { CollapseRule } from "./rule.js";
import { PiAllEvent } from "../../types/pi-type.js";
import { createVSLogger } from "../../logger.js";
const log = createVSLogger("debug")
/**
 * 缓冲条目 = 数据 + [宿主记录的]时间戳
 *
 * 时间戳必须在宿主侧记录:前端渲染时刻 ≠ 事件发生时刻
 * (尤其是打开面板刷历史时,所有旧数据都会被打上“现在”的时间)
 */
interface DebugItem {
    ts: number;
    payload: PiAllEvent;
}
let rule: CollapseRule;

export class DebugPanel {
    // ========== 监听句柄 ==========
    private configSub: () => void | undefined;
    dispose(): void {
        this.configSub();
    }

    /**
     * @param extensionUri 扩展根目录(用于读取 debug.html)
     * @param context 扩展上下文(用 globalState 记住上次的导出路径)
     */
    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly context: vscode.ExtensionContext,
    ) {
        rule = new CollapseRule()
        // 更新缓存区大小
        this.refreshBufferSize();
        this.configSub = vsSettings.onSomeSC(
            ["pi-bridge.debug.bufferSize", "pi-bridge.debug.enabled"], () => { this.refreshBufferSize() }
        );
    }
    // ========== 配置更新 ==========
    /**
     *   正整数 → 那个值
     *   "max"  → Infinity (不限制)
     *   缓冲区长度设定为零的时候，则判定为开关。无论是数值为零，还是开关打开，都通过这开关就由这个零来实现。
     */
    private refreshBufferSize(): void {
        // 开关
        if (!vsSettings.get("pi-bridge.debug.enabled")) {
            this.buffer.capacity = 0
        } else {
            const raw = vsSettings.get("pi-bridge.debug.bufferSize");
            let s = 0
            if (raw === "max") {
                s = Number.POSITIVE_INFINITY;
            } else {
                s = Number.parseInt(raw, 10);
            };
            this.buffer.capacity = s
        }
        this.replayHistory()
    }
    /** 后台缓冲:真实数据仓库 */
    private readonly buffer = new RingBuffer<DebugItem>(500);

    /** 记录一条数据(由 main.ts 的数据流调用) */
    log(payload: PiAllEvent): void {
        const time = Date.now(); // 宿主侧记录时间(前端渲染时刻不准)
        this.buffer.add({ ts: time, payload }); // 完整入库(无关折叠 )

        if (!this.panel) {
            return
        };
        const m = this.buffer.items.at(-1)
        if (!m) return
        this.rulePost(m)
    }

    // ==========  折叠工具函数  =========
    private foldType = "";
    private foldTs = 0;
    private foldCount = 0;

    /** 连续折叠检验标准状态 */
    private resetFold(label = "", ts = 0): void {
        this.foldType = label;
        this.foldCount = label ? 1 : 0;
        this.foldTs = ts;
    }

    /** 路由事件的折叠与否，并发给前端 */
    private rulePost(debugItem: DebugItem) {
        if (!this.panel) {
            return
        };
        const label = rule.check(debugItem.payload);
        if (label !== undefined) {
            // 命中规则!
            if (this.foldType === label) {
                // 连续了!
                // 累加同段 → 只更新计数(时间戳保持段开始时刻 )
                this.foldCount++;
                this.panel.webview.postMessage({
                    kind: "debug-fold", label, count: this.foldCount, ts: this.foldTs,
                });
            } else {
                // 未连续-->开启新的折叠尝试
                this.resetFold(label, debugItem.ts)
                this.panel.webview.postMessage({
                    kind: "debug-fold", label, count: 1, ts: debugItem.ts,
                });
            }
        } else {
            this.resetFold();
            this.panel.webview.postMessage({ kind: "debug", payload: debugItem.payload, ts: debugItem.ts });
        }
    }
    // ==========  打开面板  =========
    private panel: vscode.WebviewPanel | undefined;
    /**
     *   固定用 ViewColumn.Beside 会在[每次关掉再开]时又新开一个组
     *   1. 记住列之后:用户拖到哪,下次就去哪
     *   2. 默认用 ViewColumn.One(第一个组 )
     */
    private lastColumn: vscode.ViewColumn = vscode.ViewColumn.One;
    /** 命令入口:打开(或聚焦)调试板 */
    show(): void {
        // 已打开 → 只聚焦,不重复创建
        if (this.panel) {
            this.panel.reveal(this.panel.viewColumn ?? this.lastColumn);
            return;
        }
        // 打开1/2
        this.panel = vscode.window.createWebviewPanel(
            "pi-bridge.debug",      // viewType:同类面板的唯一标识
            "pi-bridge:debug调试板",             // 标题
            this.lastColumn,
            { enableScripts: true }, // 允许 webview 里跑 JS
        );
        // 记住用户拖动面板换列
        this.panel.onDidChangeViewState(() => {
            if (this.panel?.viewColumn) this.lastColumn = this.panel.viewColumn;
        });
        //打开 2/2
        this.panel.webview.html = loadWebviewHtml(this.extensionUri, "debug.html", this.panel.webview);
        // 接收前端发来的消息
        this.panel.webview.onDidReceiveMessage((msg) => {
            if (msg.kind === "debug-ready") {
                // 前端刚打开:把缓冲里的历史刷给它(统一走 replayHistory )
                this.replayHistory();
            }
            if (msg.kind === "clear") {
                this.buffer.clear();
            }
            if (msg.kind === "export") {
                void this.exportBuffer();
            }
        });
        // 面板被用户关闭:标记为 undefined(缓冲继续收集)
        this.panel.onDidDispose(() => {
            this.panel = undefined;
        });
    }

    /** 重新推一遍历史(配置变化 / 前端刚打开时调用)*/
    private replayHistory(): void {
        if (!this.panel) return;
        const webview = this.panel.webview;
        webview.postMessage({ kind: "debug-clear" });

        rule.refresh(); // 重放前重新解析规则(配置可能刚被改过)
        this.resetFold(); // 重算折叠段

        for (const item of this.buffer.items) {
            this.rulePost(item)
        }
    }

    /**
     * 导出环形缓冲为 JSON 文件
     *
     * [默认路径]优先用上次导出过的路径(存在 globalState),
     * 这样用户改一次之后就固定下来,不用每次都选.
     * 首次导出时,默认放在工作区根目录(无工作区则 HOME),文件名带时间戳.
     */
    private async exportBuffer(): Promise<void> {
        // 解包成裸数据(导出格式保持简单:就是数据数组)
        const items = this.buffer.items.map((entry) => entry.payload);
        if (items.length === 0) {
            void vscode.window.showInformationMessage("调试板缓冲是空的,没有可导出的数据");
            return;
        }

        // 默认路径:时间戳必须是[新的](否则连续导出会覆盖同一个文件 )
        //   只记住[目录],文件名每次都重新生成
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

        // 记住这个路径(下次作为默认值)
        await this.context.globalState.update("pi-bridge.debug.exportPath", uri.fsPath);

        const content = JSON.stringify(items, null, 2);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
        void vscode.window.showInformationMessage(
            `已导出 ${items.length} 条 → ${uri.fsPath}`,
        );
    }
}

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
import { CollapseRuleType, rule } from "./rule.js";
import { PiAllEvent, PiAllEventHandler } from "../../types/pi-type.js";
import { SettingName } from "../../types/settings-type.js";

/**
 * 缓冲条目 = 数据 + [宿主记录的]时间戳
 *
 * 时间戳必须在宿主侧记录:前端渲染时刻 ≠ 事件发生时刻
 * (尤其是打开面板刷历史时,所有旧数据都会被打上“现在”的时间)
 */
interface debugItem {
    ts: number;
    payload: PiAllEvent;
}

export class DebugPanel {
    /** 面板实例(undefined = 当前没打开) */
    private panel: vscode.WebviewPanel | undefined;

    /** 配置监听 */
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
        const myConfig: SettingName[] = ["pi-bridge.debug.enabled", "pi-bridge.debug.bufferSize"]
        this.configSub = vsSettings.onSettingChangeBatch(
            myConfig,
            () => {
                // 更新缓冲区的大小
                const cap = this.refleshBufferCfg();
                if (!this.isEnabled()) {
                    this.buffer.clear();
                } else {
                    this.buffer.capacity = cap;
                }
                this.replayHistory();
            },
        );
        // 启动时按配置初始化一次(默认 500 可能被配成 max / 其他 )
        this.buffer.capacity = this.refleshBufferCfg();
    }

    /** 后台缓冲:真实数据仓库 */
    private readonly buffer = new RingBuffer<debugItem>(500);

    /**
     * 记录一条数据(由 main.ts 的数据流调用)
     * 
     * 数据入缓存;忽略列表只影响前端显示
     * 改忽略单[立即生效](重放时重新计算折叠)
     *
     * [总开关 pi-bridge.debug.enabled]
     * 关掉后[直接不接数据](缓冲不涨,不推前端)→ 开发结束省内存
     */
    log(payload: PiAllEvent): void {
        if (!vsSettings.get("pi-bridge.debug.enabled")) return; // 总开关:关掉就不再接收任何数据

        const time = Date.now(); // 宿主侧记录时间(前端渲染时刻不准)
        this.buffer.add({ ts: time, payload }); // 完整入库(无关折叠 )

        if (!this.panel) return;

        // 出口折叠:命中规则 → 只发“标签 × 条数”(同一个折叠段原地累加 )
        const label = rule.check(payload);
        if (label !== undefined) {
            if (this.foldType === label) {
                this.foldCount++;
                this.panel.webview.postMessage({
                    kind: "debug-fold", label, count: this.foldCount, ts: this.foldTs,
                });
            } else {
                this.resetFold(label, time);
                this.panel.webview.postMessage({ kind: "debug-fold", label, count: 1, ts: time });
            }
        }

        this.resetFold(); // 普通数据到达 → 折叠段结束
        this.panel.webview.postMessage({ kind: "debug", payload, ts: time });
    }

    /** 当前折叠段(出口折叠用;与缓冲无关 ) */
    private foldType = "";
    private foldTs = 0;
    private foldCount = 0;

    /** 重置折叠段(label 为空 = 关闭当前段) */
    private resetFold(label = "", ts = 0): void {
        this.foldType = label;
        this.foldCount = label ? 1 : 0;
        this.foldTs = ts;
    }

    /**
     * 读取缓冲容量配置(B25)
     *   正整数 → 那个值
     *   "max"  → Infinity (不限制)
     *   "0"    → 0 (语义 = 关闭调试板 )
     *   非法值 → 回退 500
     */
    private refleshBufferCfg(): number {
        const raw = vsSettings.get("pi-bridge.debug.bufferSize");
        if (raw === "max") return Number.POSITIVE_INFINITY;
        if (raw === "0") return 0;
        const n = Number.parseInt(raw, 10);
        return Number.isFinite(n) && n > 0 ? n : 500;
    }

    /**
     * 调试板总开关(默认开)- 关掉 = 不接收任何数据
     *
     * B25:缓冲配成 "0" 也是关 (用户:“零的话板子也已经关了,
     *   板子关掉比较干净一点”)
     *   → 这样只有一个“关闭”语义 不会出现“收到又扔掉”的怪状态
     */
    private isEnabled(): boolean {
        if (!vsSettings.get("pi-bridge.debug.enabled")) return false;
        return this.refleshBufferCfg() !== 0; // 0 = 关
    }

    /**
     * 重新推一遍历史(配置变化 / 前端刚打开时调用)
     *
     * 要[重新计算折叠]:因为缓冲里存的是完整数据,
     *   忽略列表可能刚被改过 → 哪些该折叠要重算 (这就是“实时生效”的关键 )
     *
     * 为什么不增量补?过滤/折叠是有状态的(隐藏项变了可能要撤回已推的)
     * 全量重推最简单也最不会错 (调试板数据量小,成本可忽略)
     */
    private replayHistory(): void {
        if (!this.panel) return;
        const webview = this.panel.webview;
        webview.postMessage({ kind: "debug-clear" });

        rule.refresh(); // 重放前重新解析规则(配置可能刚被改过)
        this.resetFold(); // 重算折叠段

        for (const item of this.buffer.items) {
            const label = rule.check(item.payload);
            if (label !== undefined) {
                // 折叠:连续同标签合并成一段(与 log() 的实时行为一致 )
                if (this.foldType === label) {
                    this.foldCount++;
                } else {
                    this.foldType = label;
                    this.foldCount = 1;
                    this.foldTs = item.ts;
                    webview.postMessage({
                        kind: "debug-fold", label, count: 1, ts: item.ts,
                    });
                    continue;
                }
                // 累加同段 → 只更新计数(时间戳保持段开始时刻 )
                webview.postMessage({
                    kind: "debug-fold", label, count: this.foldCount, ts: this.foldTs,
                });
            } else {
                this.resetFold();
                webview.postMessage({ kind: "debug", payload: item.payload, ts: item.ts });
            }
        }
    }

    /**
     *   固定用 ViewColumn.Beside 会在[每次关掉再开]时又新开一个组
     *   1. 记住列之后:用户拖到哪,下次就去哪
     *   2. 改成默认用 ViewColumn.One(第一个组 )
     */
    private lastColumn: vscode.ViewColumn = vscode.ViewColumn.One;

    /** 命令入口:打开(或聚焦)调试板 */
    show(): void {
        // 已打开 → 只聚焦,不重复创建
        if (this.panel) {
            this.panel.reveal(this.panel.viewColumn ?? this.lastColumn);
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            "pi-bridge.debug",      // viewType:同类面板的唯一标识
            "pi-bridge:debug调试板",             // 标题
            this.lastColumn,
            { enableScripts: true }, // 允许 webview 里跑 JS
        );

        // 用户拖动面板换列 → 记住它(下次“就近”去那里 )
        this.panel.onDidChangeViewState(() => {
            if (this.panel?.viewColumn) this.lastColumn = this.panel.viewColumn;
        });

        this.panel.webview.html = loadWebviewHtml(this.extensionUri, "debug.html", this.panel.webview);

        // 接收前端(调试板 HTML)发来的消息
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

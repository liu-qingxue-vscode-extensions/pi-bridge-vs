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

/**
 * 环形缓冲：容量固定，满了丢最旧的
 *
 * ★ 容量 = 0 时【不接受任何数据】✗（B25 用户要求：
 *   “缓冲为零有点莫名其妙了，收到又扔掉；零的话板子也已经关了，
 *    板子关掉比较干净一点”✓）
 *   → 0 的语义对外是“关掉调试板”✗（见 isEnabled ✓）
 *     这里只是【保险】：真的传 0 也别存东西 ✓
 * ★ 容量 = Infinity → 无上限（用户配 "max" ✓）
 */
class RingBuffer<T> {
    private items: T[] = [];

    constructor(private capacity: number) {}

    /** ★ 调整容量（配置实时生效用 ✓ 缩小时立即裁掉多余的 ✓）*/
    setCapacity(n: number): void {
        this.capacity = n;
        if (Number.isFinite(n) && this.items.length > n) {
            this.items.splice(0, this.items.length - n);
        }
    }

    /** 清空（切换容量时用 ✗ 避免留下旧容量的数据 ✓）*/
    clear(): void {
        this.items = [];
    }

    push(item: T): void {
        if (this.capacity <= 0) return; // ★ 容量 0 → 直接不收 ✗
        this.items.push(item);
        if (Number.isFinite(this.capacity) && this.items.length > this.capacity) {
            this.items.shift(); // 丢掉最旧的
        }
    }

    /** 快照（拷贝一份，避免外部修改内部数组） */
    snapshot(): T[] {
        return [...this.items];
    }

    /** 最后一条（
     *  注：旧版本用它做“折叠累加”（已废弃 ✗）—— 现在折叠发生在出口，
     *  缓冲里永远是完整数据 ✓）*/
    last(): T | undefined {
        return this.items[this.items.length - 1];
    }

    get size(): number {
        return this.items.length;
    }
}

/**
 * 取事件的 type（非对象/无 type 返回空串）
 */
function typeOf(payload: unknown): string {
    const t = (payload as { type?: unknown } | null)?.type;
    return typeof t === "string" ? t : "";
}

/**
 * ★ 折叠规则 —— 把高频事件【按子字段分段计数】
 *
 * 【它解决什么？】
 *   一个 type 内部常常还有子类型：
 *     message_update 里带 assistantMessageEvent.type = text_delta / thinking_delta / …
 *   不折叠：刷得飞快，淹没其它事件 ✗
 *   只按 type 折：message_update ×444 —— 看不出里面是啥 ✗
 *   按子字段分段：
 *     message_update › type=text_delta      ×300  ✓
 *     message_update › type=thinking_delta  × 80  ✓
 *
 * 【数学上看】
 *   限定（type = X）→ 得到一个【子集】
 *   再按 by 字段分段 → 在子集上做【等价类划分】（= SQL 的 GROUP BY ✓）
 *
 * 【三种写法】（字符串形式【能在 VS Code 设置界面直接编辑】✓）
 *   "turn_start"                                   → 整个 type 折一段
 *   "message_update:assistantMessageEvent.type"    → 按该字段的值分段（type : 字段路径）
 *   { type: "…", by: "…" }                         → 对象形式（程序生成时好用 ✓）
 *
 * ★ 为什么推荐字符串？
 *   对象数组在 VS Code 设置界面里【编不了】✗（只能手改 JSON）
 *   字符串数组可以在设置界面里一条一条加 ✓
 *
 * 【相邻判定】两条数据归为同一段，当且仅当：
 *   ① 它们都被【同一条规则】命中
 *   ② 按 by 取出的【值串】相等（无 by 时恒等 ✓）
 */
interface CollapseRule {
    /** 锚点1：事件类型（必填） */
    type: string;
    /**
     * 锚点2-a：字段路径（点号，如 "assistantMessageEvent.type"）
     * ★ 路径本身表达嵌套，不需要“数组套数组”✗
     */
    path?: string;
    /**
     * 锚点2-b：要求 path 的值【等于】它
     * ★ 只写 path 不写 value → 只要取得到值就算命中（范围更宽 ✓）
     */
    value?: string;
}

/** 规则在设置里的原始形状（用户可能写错，要宽容处理 ✓） */
type RawRule = string | { type?: unknown; path?: unknown; value?: unknown; by?: unknown };

/**
 * 把设置里的原始项解析成规则
 *
 * 【字符串形式语法】type[:路径[=值]]
 *   "turn_start"
 *   "message_update:assistantMessageEvent.type=text_delta"
 *   "tool_execution_start:toolName"
 *
 * 【对象形式】{ type, path, value }（by 是过渡期别名，一并接受 ✓）
 *
 * 解析不了就返回 undefined（跳过而不是报错 ✓）
 */
function parseRule(raw: RawRule): CollapseRule | undefined {
    if (typeof raw === "string") {
        const s = raw.trim();
        if (!s) return undefined;

        // ① 切出 type（冒号前）
        const colon = s.indexOf(":");
        if (colon < 0) return { type: s };
        const type = s.slice(0, colon).trim();
        if (!type) return undefined;

        // ② 切出 路径[=值]（冒号后）
        const rest = s.slice(colon + 1).trim();
        if (!rest) return { type };
        const eq = rest.indexOf("=");
        if (eq < 0) return { type, path: rest };
        const path = rest.slice(0, eq).trim();
        const value = rest.slice(eq + 1).trim();
        if (!path) return { type };
        return value ? { type, path, value } : { type, path };
    }

    if (!raw || typeof raw !== "object") return undefined;
    const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
    const type = str(raw.type);
    if (!type) return undefined;
    // by 是过渡期别名（已改为更准的 path ✓）
    const path = str(raw.path) || str(raw.by);
    if (!path) return { type };
    const value = str(raw.value);
    return value ? { type, path, value } : { type, path };
}

/**
 * 取值：按点号路径深入 payload
 * @returns 取到的标量值（字符串化）；取不到/不是标量 → undefined
 *
 * 特点：不调工具函数、不抛错；中途遇到非对象就返回 undefined ✓
 */
function valueAtPath(payload: unknown, path: string): string | undefined {
    let cur: unknown = payload;
    for (const seg of path.split(".")) {
        if (!cur || typeof cur !== "object") return undefined;
        cur = (cur as Record<string, unknown>)[seg];
    }
    // 对象/数组不做串化（会出现难读的 [object Object] ✗）
    if (cur === undefined || cur === null || typeof cur === "object") return undefined;
    return String(cur);
}

/**
 * 判断一条数据是否被规则命中；命中则返回【折叠段标签】
 *
 * 【为什么返回标签而不是 bool？】
 *   相邻数据的“同一段”判定靠它：标签相等 = 同一段 ✓
 *
 * 【两个锚点】
 *   锚点1：type 必须相等（不等 → 不命中 ✓）
 *   锚点2：若写了 path，则先取值；写了 value 还得相等 ✓
 *          取不到值 → 【不命中】（宁可多显示，也不要变成一坨 ? ✗）
 *
 * @returns 命中的标签；不命中返回 undefined
 */
function labelOf(payload: unknown, rule: CollapseRule): string | undefined {
    if (typeOf(payload) !== rule.type) return undefined;

    // 只写了锚点1 → 整个 type 折一段（标签就是 type ✓）
    if (!rule.path) return rule.type;

    const got = valueAtPath(payload, rule.path);
    if (got === undefined) return undefined;
    if (rule.value !== undefined && got !== rule.value) return undefined;

    // 标签用【字段末段】而不是全路径（短一点好读 ✓）
    const leaf = rule.path.split(".").pop() ?? rule.path;
    return `${rule.type} › ${leaf}=${got}`;
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

    /**
     * ★ 面板【上次所在的列】—— 让“靠近打开”真的靠近
     *   固定用 ViewColumn.Beside 会在【每次关掉再开】时又新开一个组 ✗
     *   记住列之后：用户拖到哪、下次就去哪 ✓
     *
     * ★★ B25 调整（用户要求 ✓）：
     *   “我发现在你打开调试板，它都新创建一个组。
     *    最好是用它第一个组”✓
     *   → 改成默认用 ViewColumn.One（第一个组 ✓）
     *   ★ 仍然记住用户拖动（如果用户把它拖到第二组 ✓ 下次还去那里 ✓）
     *     但【不要】默认新开 ✗（Beside 会新开 ✗ 这是用户不喜欢的地方 ✓）
     */
    private lastColumn: vscode.ViewColumn = vscode.ViewColumn.One;

    /**
     * 后台缓冲：★ 容量可配（B25 ✓）
     *   · 正整数 → 保留最近 N 条 ✓
     *   · "max"  → ★ 不限制 ✗（内存换完整数据 ✓ 32G 内存随便存 ✓）
     *   · "0"    → ★ 关闭调试板 ✗（等价于 debug.enabled=false ✓）
     */
    private readonly buffer = new RingBuffer<LogEntry>(500);

    /**
     * @param extensionUri 扩展根目录（用于读取 media/debug.html）
     * @param context 扩展上下文（用 globalState 记住上次的导出路径）
     */
    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly context: vscode.ExtensionContext,
    ) {
        // ★ 监听设置变化 → 重新计算折叠并重推
        //   这样改 collapse（或 enabled）立即生效 ✓
        //   （和 styleVars 同一套路；之前就是缺了这一步 ✗）
        this.configSub = vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("pi-bridge.debug")) {
                // ★ 容量可配（B25）：配置一变就同步 ✓
                //   ★ 缩小时【立即裁掉】多余的部分 ✗（setCapacity 里做了 ✓）
                //   ★ 0 / 关掉总开关 → 清空缓冲（“空空的”✓ 不再占内存 ✓）
                const cap = this.bufferCapacity();
                if (!this.isEnabled()) {
                    this.buffer.clear();
                } else {
                    this.buffer.setCapacity(cap);
                }
                this.replayHistory();
            }
        });
        // ★ 启动时按配置初始化一次（默认 500 ✓ 可能被配成 max / 其他 ✓）
        this.buffer.setCapacity(this.bufferCapacity());
    }

    /** 配置监听（需外部 dispose；main.ts 会塞进 subscriptions ✓） */
    private configSub: vscode.Disposable | undefined;

    dispose(): void {
        this.configSub?.dispose();
    }

    /**
     * 记录一条数据（由 main.ts 的数据流调用）
     *
     * 【★ 本轮的架构修正】
     *   旧：命中忽略列表 → 【折叠】（详情丢掉 ✗）→ 改配置无法复活历史 ✗
     *   新：数据【永远完整入库】✓；忽略列表只在【出口】折叠（保住时序位置 ✓）
     *       → 改黑名单【立即生效】（重放时重新计算折叠）✓
     *
     * 【总开关 pi-bridge.debug.enabled】
     *   关掉后【直接不接】（缓冲不涨、不推前端）→ 开发结束省内存 ✓
     */
    log(payload: unknown): void {
        if (!this.isEnabled()) return; // ★ 总开关：关掉就不再接收任何数据 ✓

        const ts = Date.now(); // ★ 宿主侧记录时间（前端渲染时刻不准）
        this.buffer.push({ ts, payload }); // ★ 完整入库（永远不折叠详情 ✓）

        if (!this.panel) return;

        // ★ 出口折叠：命中规则 → 只发“标签 × 条数”（同一个折叠段原地累加 ✓）
        const label = this.foldLabelOf(payload);
        if (label !== undefined) {
            if (this.foldType === label) {
                this.foldCount++;
                this.panel.webview.postMessage({
                    kind: "debug-fold", label, count: this.foldCount, ts: this.foldTs,
                });
            } else {
                this.resetFold(label, ts);
                this.panel.webview.postMessage({ kind: "debug-fold", label, count: 1, ts });
            }
            return;
        }

        this.resetFold(); // 普通数据到达 → 折叠段结束 ✓
        this.panel.webview.postMessage({ kind: "debug", payload, ts });
    }

    /** 当前折叠段（出口折叠用；与缓冲无关 ✓） */
    private foldType = "";
    private foldCount = 0;
    private foldTs = 0;

    /** 重置折叠段（label 为空 = 关闭当前段） */
    private resetFold(label = "", ts = 0): void {
        this.foldType = label;
        this.foldCount = label ? 1 : 0;
        this.foldTs = ts;
    }

    /**
     * ★ 读取缓冲容量配置（B25）
     *
     *   正整数 → 那个值 ✓
     *   "max"  → Infinity ✓（不限制）
     *   "0"    → 0 ✓（语义 = 关闭调试板 ✓）
     *   非法值 → 回退 500 ✓
     */
    private bufferCapacity(): number {
        const v = vscode.workspace
            .getConfiguration("pi-bridge.debug")
            .get<string>("bufferSize", "500");
        const s = String(v ?? "").trim().toLowerCase();
        if (s === "max" || s === "inf" || s === "infinity") return Number.POSITIVE_INFINITY;
        if (s === "0" || s === "off") return 0;
        const n = Number.parseInt(s, 10);
        return Number.isFinite(n) && n > 0 ? n : 500;
    }

    /**
     * 调试板总开关（默认开）—— 关掉 = 不接收任何数据 ✓
     *
     * ★★ B25：缓冲配成 "0" 也是关 ✗（用户：“零的话板子也已经关了，
     *   板子关掉比较干净一点”✓）
     *   → 这样只有一个“关闭”语义 ✗ 不会出现“收到又扔掉”的怪状态 ✓
     */
    private isEnabled(): boolean {
        const enabled = vscode.workspace
            .getConfiguration("pi-bridge.debug")
            .get<boolean>("enabled", true);
        if (!enabled) return false;
        return this.bufferCapacity() !== 0; // ★ 0 = 关 ✓
    }

    /**
     * 重新推一遍历史（配置变化 / 前端刚打开时调用）
     *
     * ★ 要【重新计算折叠】：因为缓冲里存的是完整数据，
     *   忽略列表可能刚被改过 → 哪些该折叠要重算 ✓（这就是“实时生效”的关键 ✓）
     *
     * 为什么不增量补？过滤/折叠是有状态的（隐藏项变了可能要撤回已推的）✗
     * 全量重推最简单也最不会错 ✓（调试板数据量小，成本可忽略）
     */
    private replayHistory(): void {
        if (!this.panel) return;
        const webview = this.panel.webview;
        webview.postMessage({ kind: "debug-clear" });

        const rules = this.readRules();
        this.resetFold(); // 重算折叠段 ✓

        for (const entry of this.buffer.snapshot()) {
            const label = this.foldLabelOf(entry.payload, rules);
            if (label !== undefined) {
                // 折叠：连续同标签合并成一段（与 log() 的实时行为一致 ✓）
                if (this.foldType === label) {
                    this.foldCount++;
                } else {
                    this.foldType = label;
                    this.foldCount = 1;
                    this.foldTs = entry.ts;
                    webview.postMessage({
                        kind: "debug-fold", label, count: 1, ts: entry.ts,
                    });
                    continue;
                }
                // 累加同段 → 只更新计数（时间戳保持段开始时刻 ✓）
                webview.postMessage({
                    kind: "debug-fold", label, count: this.foldCount, ts: this.foldTs,
                });
            } else {
                this.resetFold();
                webview.postMessage({ kind: "debug", payload: entry.payload, ts: entry.ts });
            }
        }
    }

    /**
     * 读取并解析折叠规则（每次现读配置 → 改设置立即生效 ✓）
     *
     * 【配置名】pi-bridge.debug.collapse（字符串数组，设置界面可直接编辑 ✓）
     *
     * ★ 不做【自动排序写回】—— 那会边编辑边重写用户的设置，风险大于收益 ✗
     */
    private readRules(): CollapseRule[] {
        const raw = vscode.workspace
            .getConfiguration("pi-bridge.debug")
            .get<RawRule[]>("collapse", []);
        const out: CollapseRule[] = [];
        const seen = new Set<string>();
        for (const item of raw ?? []) {
            const rule = parseRule(item);
            if (!rule) continue;
            // 去重（完全相同的规则写两次没意义 ✓）
            const key = rule.type + "|" + (rule.path ?? "") + "=" + (rule.value ?? "");
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(rule);
        }
        return out;
    }

    /**
     * 这条数据该折叠吗？该则返回折叠段标签
     * @param rules 可选用已解析的规则（重放时避免重复解析 ✓）
     */
    private foldLabelOf(payload: unknown, rules?: CollapseRule[]): string | undefined {
        for (const rule of rules ?? this.readRules()) {
            const label = labelOf(payload, rule);
            if (label !== undefined) return label; // 先匹配到的先生效 ✓
        }
        return undefined;
    }

    /** 命令入口：打开（或聚焦）调试板 */
    show(): void {
        // 已打开 → 只聚焦，不重复创建
        if (this.panel) {
            this.panel.reveal(this.panel.viewColumn ?? this.lastColumn);
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            "pi-bridge.debug",      // viewType：同类面板的唯一标识
            "Pi 调试板",             // 标题
            // ★ 用【上次所在的列】（用户拖到哪就去哪 ✓）
            //   原来固定 ViewColumn.Beside → 关掉再开就会又新开一个组 ✗
            this.lastColumn,
            { enableScripts: true }, // 允许 webview 里跑 JS
        );

        // ★ 用户拖动面板换列 → 记住它（下次“就近”去那里 ✓）
        this.panel.onDidChangeViewState(() => {
            if (this.panel?.viewColumn) this.lastColumn = this.panel.viewColumn;
        });

        this.panel.webview.html = loadWebviewHtml(this.extensionUri, "debug.html", this.panel.webview);

        // 接收前端（调试板 HTML）发来的消息
        this.panel.webview.onDidReceiveMessage((msg) => {
            if (msg.kind === "debug-ready") {
                // 前端刚打开：把缓冲里的历史刷给它（统一走 replayHistory ✓）
                this.replayHistory();
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

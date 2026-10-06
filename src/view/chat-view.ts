/**
 * ChatView —— 聊天视图（侧边栏里的 webview）
 *
 * 【第一步的定位】
 * 只提供"空 UI + 输入框"：把用户输入变成一条 prompt 消息交给上层，
 * 不做任何渲染（数据都在调试板里看）。
 *
 * 【迭代方向】
 * 随着调试板里的数据被逐个"消灭"，这里会逐步长出真正的 UI 渲染。
 */
import { logInfo } from "../logger.js";
import { openToolInEditor } from "../panels/editor-open.js";
import * as vscode from "vscode";
import { loadWebviewHtml } from "./html-loader.js";
import { readStyleVars, styleVarsToCss, classNamesFromVars, onStyleChange } from "./style-config.js";
import { getModelContextWindowsObject } from "../pi/model-limits.js";
import { getCurrentTheme } from "../pi/theme-loader.js";
// ★ B32 图标排查要用日志
import { logDebug, logWarn } from "../logger.js";
import type { FrontendMessage } from "../bridge/format-frontend.js";
import type { ChatState } from "./chat-state.js";

export class ChatView implements vscode.WebviewViewProvider {
    /** 视图 id：必须和 package.json 的 contributes.views 里声明的一致 */
    static readonly viewId = "pi-bridge.chatView";

    /** 当前视图实例（用户切走/关闭时为 undefined） */
    private view: vscode.WebviewView | undefined;

    /**
     * @param extensionUri 扩展根目录（用于读取 media/chat.html）
     * @param chatState 插件端权威聊天状态（本视图订阅它，把变化推给 webview）
     * @param onMessage 前端消息的【统一出口】
     *
     * 【为什么传“整个消息”而不是“text”？】
     * 这样加新命令时不用改本类的签名 —— 扩展点在 format 层的 formatMap：
     *   chat 页面发 {kind:"abort"} → 这里照原样转交 → format 层负责翻译
     * 视图类保持“哑”：只转发，不做业务路由（职责单一）。
     */
    constructor(
        private readonly extensionUri: vscode.Uri,
        /**
         * ★★ 扩展的持久存储目录（B32 图标 ✓）
         *   图标会复制到 <globalStorage>/icons/ ✓
         *   ★ 必须加进 webview 的 localResourceRoots ✗
         *     否则 asWebviewUri 生成的地址会被拒 ✗ 图片加载不出来 ✓
         */
        private readonly globalStorageUri: vscode.Uri,
        private readonly chatState: ChatState,
        private readonly onMessage: (msg: FrontendMessage) => void | Promise<void>,
        /** pi 的工作目录（= VS Code 工作区目录）→ 显示在输入区下方的极简栏 ✓ */
        private readonly cwd: string,
    ) {
        // 状态变化 → 增量推给 webview
        // （view 不存在时 post() 静默丢弃；重建时会在 resolveWebviewView 里重放全量）
        chatState.onChange((patch) => {
            this.post("patch", patch);
        });

        // 样式设置变化 → 实时推给 webview（不重建 DOM，只改 CSS 变量）
        this.styleChangeSub = onStyleChange(() => {
            this.post("styleVars", readStyleVars());
        });
    }

    /** 设置变化订阅（需要外部 dispose；也可由调用方把它塞进 context.subscriptions） */
    private styleChangeSub: vscode.Disposable | undefined;

    dispose(): void {
        this.styleChangeSub?.dispose();
    }

    /** VS Code 在视图第一次显示时调用 */
    /** ★ webview 就绪时的补充回调（B23：推模型 / 思考深度 ✓）*/
    onReady?: () => void;

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this.extensionUri,
                vscode.Uri.joinPath(this.extensionUri, "media"),
                this.globalStorageUri,
            ],
        };
        // ★★ B32 图标排查：打印【实际生效的】白名单 ✓
        //   ★ 为什么需要？
        //     我们确实设了 ✗ 而图片仍然加载失败 ✓
        //     那就得看“设上了没有”✗ 而不是继续猜 ✓
        //     （原话：“你说你设了 ✗ 设上了吗？”✓）
        try {
            const roots = webviewView.webview.options.localResourceRoots ?? [];
            logDebug(
                `webview 白名单（${roots.length} 个）：\n` +
                    roots.map((u) => `  · ${u.fsPath}`).join("\n"),
            );
            logDebug(`globalStorage 应该是：${this.globalStorageUri.fsPath}`);
            logDebug(`★ webview.cspSource = ${webviewView.webview.cspSource}`);
        } catch (err) {
            logWarn(`读白名单失败：${String(err)}`);
        }
        // 从 media/chat.html 读取 + 注入 CSP nonce + 注入样式变量
        // ★★ B32：把开关类也【静态写好】✗ 否则首屏居中/折叠全部失效 ✓
        //   （原来只靠 JS 切类 ✗ 而 JS 那次调用在首次加载时根本不会发生 ✓）
        const vars = readStyleVars();
        webviewView.webview.html = loadWebviewHtml(
            this.extensionUri,
            "chat.html",
            webviewView.webview,
            styleVarsToCss(vars),
            classNamesFromVars(vars).join(" "),
        );

        // 接收 webview 页面发来的消息
        webviewView.webview.onDidReceiveMessage((msg: unknown) => {
            // webview 发来的是任意 JSON，先做最小校验
            if (!msg || typeof msg !== "object") return;
            const kind = (msg as { kind?: unknown }).kind;
            if (typeof kind !== "string") return;

            // webview 就绪 → 重放全量快照
            // （webview 被销毁重建后靠这个恢复画面 —— “显示器”没脑子，状态都在插件端）
            if (kind === "ready") {
                // ★ 先推样式变量：布尔开关（如 centerColumn）需要在 webview 里切 CSS 类，
                //   否则重建后“设置里有、但视觉没生效” ✗
                this.post("styleVars", readStyleVars());
                // ★ 模型上下文窗口表（顶部状态栏的电池分母；查不到则前端显示 "?"）
                this.post("modelLimits", getModelContextWindowsObject());
                // ★ 工作目录（输入区下方极简栏）
                this.post("cwd", this.cwd);
                this.post("snapshot", this.chatState.snapshot());
                // ★ 模型 / 思考深度（B23）：由 main.ts 的 onReady 回调补 ✓
                //   为什么放回调而不是这里？→ 它要读 settings.json / 问 pi ✓
                //   这两个都是【main.ts 的职责】✗（chat-view 只该管显示 ✓）
                this.onReady?.();
                return;
            }

            // ★★ B41：前端要把某个工具块"送去编辑器"（按钮 / 右键触发）
            //   按 callId 从 chatState 取原始块 ✗ 再交给 editor-open 分派
            //   （★ 数据从宿主取而不是从 webview DOM 抠 —— 宿主的数据更完整：
            //     details.patch / resultParts 都在 ✓ 而且不必解析 HTML ✗）
            if (kind === "openInEditor") {
                const callId = (msg as { callId?: unknown }).callId;
                logInfo(`★ 宿主收到 openInEditor：callId=${String(callId)}`);
                if (typeof callId === "string") {
                    const blk = this.chatState.findToolBlock(callId);
                    logInfo(`  找到块：${blk ? `${blk.toolName}（args=${JSON.stringify(blk.args)?.slice(0, 60)}）` : "★没找到"}`);
                    void openToolInEditor(blk);
                }
                return;
            }

            // ★ B29：前端要 VS Code 当前主题 ✗（异步读文件 ✓ 不走 format 白名单 ✓）
            //   为什么放这里？→ 它要访问 vscode API ✗ 而 chat-view 已经有 ✓
            if (kind === "getTheme") {
                void getCurrentTheme().then((t) => {
                    // ★ theme 可能很大（几十 KB ✗）但一次就够 ✓
                    this.post("theme", t);
                });
                return;
            }

            // 其余消息交给业务出口（main.ts → format 层白名单）
            void this.onMessage(msg as FrontendMessage);
        });
    }

    /**
     * ★ 焦点回到输入框（B26）
     *   交互面板关闭 / 答完问题后调用 ✓
     *
     * 【为什么两步？】
     *   ① view.show(true) ✗ —— 侧栏可能被折叠或切到别的视图了 ✓
     *      传 preserveFocus=true → 把侧栏【显示出来】但不抢编辑器区的焦点 ✓
     *   ② 通知 webview 里把 textarea 聚焦（真正让光标落在输入框 ✓）
     */
    focusInput(): void {
        this.view?.show?.(true);
        this.post("focusInput", null);
    }

    /** 扩展宿主 → 前端（view 不存在时静默丢弃） */
    post(kind: string, payload: unknown): void {
        this.view?.webview.postMessage({ kind, payload });
    }

    /**
     * ★★ 把磁盘路径转成 webview 能加载的 URI（B32 图标 ✓）
     *
     * 【为什么必须转？】
     *   webview 里【不能】直接加载 file:// 路径 ✗（CSP 同理也过不了 ✓）
     *   必须走 asWebviewUri ✗ 它会生成一个带 nonce 的 vscode-webview-resource 地址 ✓
     *
     * ★ 没准备好时返回空串 ✗ 调用方自行处理（别当图片源 ✓）
     */
    toWebviewUri(absPath: string): string {
        if (!this.view) return "";
        return this.view.webview.asWebviewUri(vscode.Uri.file(absPath)).toString();
    }
}

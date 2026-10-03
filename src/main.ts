/**
 * main.ts —— 扩展入口（activate / deactivate）
 *
 * 【这是整个框架的"组装现场"】
 * 把各个零件接成两条数据流：
 *
 *   ① 后端 → 前端（一个事件源【扇出】给两个独立订阅者）：
 *      原始数据   → DebugPanel.log          （诊断用，不翻译）
 *      翻译后指令 → toChatPatch → ChatState → ChatView.post（渲染）
 *
 *   ② 前端 → 后端：
 *      ChatView 的消息 → toRpcCommand(表驱动) → PiClient.send → pi
 *
 * 【pi 的启动时机】
 * 懒启动：扩展激活【不】启动 pi，只在收到第一条前端消息时才启动
 * （见 PiClient.ensureStarted —— 幂等 + 就绪探针）。
 * 好处：用户只打开视图、不发消息 → 零资源消耗。
 *
 * 【数据分发模型】
 * 扇出：一个事件源 → 多个独立订阅者（调试板 / 未来的聊天渲染 / …）。
 * 订阅者之间互不依赖，调试板不是中转站。
 *
 * 【日志】
 * 本地日志走 LogOutputChannel（输出面板，VS Code 自动落盘）；
 * 调试板只接收 pi 的真数据 —— 两者不混，避免污染后端数据的类型空间。
 */
import * as vscode from "vscode";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { initLogger, logInfo, logError, logDebug } from "./logger.js";
import { PiClient } from "./pi/client.js";
import { DebugPanel } from "./view/debug-panel.js";
import { ChatView } from "./view/chat-view.js";
import { toRpcCommand, type FrontendMessage } from "./bridge/format-frontend.js";
import { toChatPatch } from "./bridge/format-backend.js";
import { SessionStore } from "./pi/session-store.js";
import { ChatState } from "./view/chat-state.js";
import { toErrorMessage } from "./utils.js";

export function activate(context: vscode.ExtensionContext): void {
    // 0. 日志（LogOutputChannel：VS Code 自动落盘 + 分级 + 轮转）
    context.subscriptions.push(initLogger());
    logInfo("pi-bridge-vs 激活");

    // 1. 确定 pi 的工作目录
    //    没有打开工作区时用 HOME（而不是 process.cwd()，后者不可靠）
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const cwd = workspaceFolder ?? os.homedir();
    if (!workspaceFolder) {
        logInfo(`未打开工作区，pi 将以 HOME 目录作为工作目录：${cwd}`);
    } else {
        logInfo(`pi 工作目录：${cwd}`);
    }

    // 2. 创建零件
    const debugPanel = new DebugPanel(context.extensionUri, context);

    // pi 的额外启动参数（设置项 pi-bridge.launchArgs）
    // 用途：临时禁用扩展（--no-extensions）等 —— 比如守卫扩展会拦住工具执行，
    //       而我们还没做 extension_ui_request 的响应桥时，工具会卡在审批上。
    //
    // ★ 关键：用【回调】而不是“现在读一次”✗
    //   启动参数只能影响 spawn 时刻 → 改完设置必须重启 pi ✓
    //   现读后，改完设置点一下 reload 按钮就能用新参数启动 ✓
    const pi = new PiClient(cwd, {
        readArgs: () => {
            const args = vscode.workspace
                .getConfiguration("pi-bridge")
                .get<string[]>("launchArgs", []);
            return Array.isArray(args) ? args.filter((a) => typeof a === "string") : [];
        },
    });
    const chatState = new ChatState(); // 插件端权威聊天状态（webview 只是显示器）
    // ★ 会话发现层（读 sessions/ 目录 + 维护 cwd 映射表 ✓）
    const sessionStore = new SessionStore(context);
    // ★ 通知环形缓冲上限（配置可调；改设置时实时生效 ✓）
    const applyNoticeLimit = (): void => {
        chatState.setNoticeLimit(
            vscode.workspace.getConfiguration("pi-bridge.notice").get<number>("bufferSize", 50),
        );
    };
    applyNoticeLimit();
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("pi-bridge.notice")) applyNoticeLimit();
        }),
    );

    // 3. 数据流 ①：pi 事件 → 两个【独立】订阅者（扇出）
    //    订阅者 1（调试板）：收【原始数据】—— 诊断用，保持原样不翻译
    //    订阅者 2（ChatState）：收【翻译后的渲染指令】—— 只关心聊天需要的事件
    //    两者互不影响：调试板看不到翻译结果，聊天也拿不到原始事件
    pi.onEvent((event) => {
        debugPanel.log(event);
        const patch = toChatPatch(event);
        if (!patch) return;
        // 任务级状态不进 ChatState（它不是气泡），直接推给视图
        if (patch.kind === "agentState") {
            chatView.post("agentState", patch.state);
        } else {
            chatState.apply(patch);
        }
    });

    // 3b. 数据流 ①-补充：pi 的 stderr（错误 / 诊断）→ 调试板
    //     官方 RpcClient 把 stderr 转发到 process.stderr（开发者控制台），界面上看不见——
    //     所以必须主动捕获送到前端，否则“用着用着突然报错”用户无法感知。
    pi.onStderr((text) => {
        for (const line of text.split("\n")) {
            if (line.trim()) {
                debugPanel.log({ type: "stderr", text: line });
            }
        }
    });

    // 4. 数据流 ②：聊天视图的消息 → format 表（白名单）→ pi
    const chatView = new ChatView(
        context.extensionUri,
        chatState,
        async (msg: FrontendMessage) => {
            // ★ 通知板的【本地消息】—— 不发给 pi，直接作用于权威状态（先拦下来 ✓）
            if (msg.kind === "noticeRemove") {
                chatState.removeNotice(msg.id);
                return;
            }
            if (msg.kind === "noticeClearAll") {
                chatState.clearNotices();
                chatView.post("noticesCleared", true); // 让前端清空自己那份镜像 ✓
                return;
            }
            // ★ 会话管理（B15）—— 本轮只跑通链路（真的新建在下一轮 ✓）
            if (msg.kind === "newSession") {
                logInfo("用户点了新建会话（下一轮接入 pi 的 new_session）");
                return;
            }

            // ★ 列出会话（★ 打开面板时按需拉取 —— 不预先扫描 ✗）
            //   ★ 这是【第一级】IO：只扫文件名（零内容 IO ✓）名字/异常状态从缓存取 ✓
            if (msg.kind === "listSessions") {
                const list = await sessionStore.listEntries();
                chatView.post("sessions", list);
                return;
            }

            // ★ 刷新会话信息（★ 第二级 IO：读文件补名字 / 标异常 ✓）
            //   维护边界 = 用户点【刷新】的那一刻 ✓
            if (msg.kind === "refreshSessions") {
                const stat = await sessionStore.refresh();
                const list = await sessionStore.listEntries();
                chatView.post("sessions", list);
                logInfo(
                    `会话刷新完成：${stat.total} 个（${stat.named} 有名字 / ${stat.broken} 异常）`,
                );
                return;
            }

            // ★ 切换会话
            //
            // 【交互约定（用户定的 ✓）】
            //   · 同 cwd → 直接 switch_session（不重载 ✓）
            //   · 跨 cwd → ★ 先改 cwd + reload，再 switch_session ✓
            //     （cwd 是启动参数 → 必须重启子进程才能变 ✓）
            if (msg.kind === "switchSession") {
                const list = await sessionStore.listEntries();
                const info = list.find((s) => s.path === msg.path);
                if (!info) {
                    void vscode.window.showErrorMessage("找不到该会话文件");
                    return;
                }
                if (info.broken) {
                    void vscode.window.showErrorMessage(`该会话文件有问题：${info.broken}`);
                    return;
                }

                try {
                    if (info.cwd && info.cwd !== pi.getCwd()) {
                        logInfo(`跨目录切会话：${pi.getCwd()} → ${info.cwd}`);
                        pi.setCwd(info.cwd);
                        await pi.reload(); // 用新 cwd 重启
                    }
                    logInfo(`切换会话：${msg.path}`);
                    await pi.sendRaw({
                        type: "switch_session",
                        sessionPath: msg.path,
                    });

                    // ★ 清空当前界面（新会话的内容）
                    //   注：历史消息的【重放】是下一步 —— 需要把 pi 的 message
                    //       转成我们的气泡结构（新转换器 ✓）
                    chatState.reset();
                    chatState.clearNotices();
                    chatView.post("cwd", pi.getCwd());
                    chatView.post("noticesCleared", true);
                    chatView.post("snapshot", chatState.snapshot());
                    void vscode.window.showInformationMessage(
                        `已切换到会话 ${info.name ?? info.id.slice(0, 8)}`,
                    );
                } catch (err) {
                    logError(`切换会话失败: ${toErrorMessage(err)}`);
                    void vscode.window.showErrorMessage(`切换会话失败：${toErrorMessage(err)}`);
                }
                return;
            }

            // ★ 改工作目录（cwd 是启动参数 → 必须重启子进程才生效 ✓）
            //
            // 【为什么用宿主弹原生输入框？】
            //   · 有校验 / 历史 / 取消 ✓ 体验比自建浮层好 ✓
            //   · 而且 cwd 是本机路径 → 宿主侧更自然 ✓
            //
            // 【交互约定（用户定的 ✓）】
            //   ★ 这是【唯一】切 cwd 的入口（会话面板里点 cwd 分组只是展开 ✗）
            //   ★ 切 cwd → 必须 reload（旧的还挂着就是错的 ✗）→ 进空会话 ✓
            if (msg.kind === "changeCwd") {
                const next = await vscode.window.showInputBox({
                    title: "修改工作目录",
                    prompt: "pi 子进程的工作目录（改了会重启 pi，当前对话会清空）。可用 ~ 开头。",
                    value: compactHome(pi.getCwd()),
                    valueSelection: [0, compactHome(pi.getCwd()).length],
                    // ★ 校验：展开 ~ → 必须【绝对路径】+ 必须【已存在的目录】✓
                    //   ★ 不存在的目录【直接报错】✗ 绝不能替用户创建 ✗
                    //     （创建目录是用户的决定，我们偷偷做就是欺骗 ✗）
                    validateInput: (raw) => {
                        const t = raw.trim();
                        if (!t) return "不能为空";
                        const abs = expandHome(t);
                        if (!path.isAbsolute(abs)) return "请输入绝对路径（可用 ~ 开头，如 ~/Projects）";
                        let stat: import("node:fs").Stats;
                        try {
                            stat = fs.statSync(abs);
                        } catch {
                            return `目录不存在：${abs}`;
                        }
                        if (!stat.isDirectory()) return `这不是一个目录：${abs}`;
                        return undefined;
                    },
                });
                if (!next) return; // 用户取消 ✓

                // 展开 ~ 后再设（★ 不创建任何东西 ✓）
                const abs = expandHome(next.trim());
                if (!pi.setCwd(abs)) {
                    void vscode.window.showInformationMessage("工作目录没有变化");
                    return;
                }
                // ★ 重启（用新 cwd）+ 清空界面（新目录 = 新会话 ✓）
                await pi.reload();
                chatState.reset();
                chatState.clearNotices();
                chatView.post("cwd", pi.getCwd());
                chatView.post("noticesCleared", true);
                chatView.post("snapshot", chatState.snapshot());
                void vscode.window.showInformationMessage(
                    `工作目录已切到 ${compactHome(pi.getCwd())}`,
                );
                return;
            }
            // ★ 重启 pi（应用最新启动参数）—— 也是本地消息 ✓
            if (msg.kind === "reloadPi") {
                logInfo("用户请求重启 pi（应用最新启动参数）");
                await pi.reload();
                // ★ pi 换了新进程 → 它不认识旧对话了 ✗ → 前端也必须清空 ✓
                //   （否则上下文对不上，接着聊会得到错误结果）
                chatState.reset();
                // ★ 通知也清掉：那都是【上一个 pi 进程】生命周期里的事 ✓
                //   （用户拍板：刷了就行，不用加“旧”标记）
                chatState.clearNotices();
                chatView.post("noticesCleared", true);
                chatView.post("snapshot", chatState.snapshot()); // 空快照 → 前端重放=清空 ✓
                return;
            }
            logDebug(`前端消息: ${JSON.stringify(msg)}`);
            try {
                const cmd = toRpcCommand(msg); // 表驱动：前端消息 → RpcCommand
                await pi.send(cmd);            // send 内部 ensureStarted()：懒启动 + 幂等
            } catch (err) {
                logError(`处理前端消息失败: ${toErrorMessage(err)}`);
            }
        },
        cwd, // ★ 输入区下方极简栏要显示它 ✓
    );

    // 5. 注册 VS Code 的贡献点（命令 / 视图）

    // ★ 开发模式（F5 调试）下自动打开调试板：
    //   写扩展时第一步就是“看数据”，每次手动开太麻烦 ✗
    //   发布后的正式安装【不】自动开（不能干扰用户 ✓）
    if (context.extensionMode === vscode.ExtensionMode.Development) {
        debugPanel.show();
    }
    context.subscriptions.push(
        // 侧边栏聊天视图
        vscode.window.registerWebviewViewProvider(ChatView.viewId, chatView),

        // ctrl+alt+d / 命令面板 → 打开调试板
        vscode.commands.registerCommand("pi-bridge.showDebug", () => {
            debugPanel.show();
        }),

        // ★ ctrl+alt+n → 展开/收起通知板
        //   （只把消息转给 webview，具体动画/状态由前端处理 ✓ 插件端不操心 UI）
        vscode.commands.registerCommand("pi-bridge.toggleNotices", () => {
            chatView.post("toggleNotices", true);
        }),

        // 测试命令（验证扩展是否激活）
        vscode.commands.registerCommand("pi-bridge.test", () => {
            void vscode.window.showInformationMessage("pi-bridge-vs 已激活 ✓");
        }),

        // 扩展停用时杀掉 pi 子进程（避免孤儿进程）
        {
            dispose: () => {
                void pi.stop();
            },
        },

        // 调试板的配置监听（改 hiddenTypes / enabled 时重推历史 ✓）
        debugPanel,
    );

    logInfo("pi-bridge-vs 激活完成（pi 将在首条消息时启动）");
}

export function deactivate(): void {
    // 清理工作主要由上面的 subscriptions 完成
}

/**
 * 把 ~ 展开成家目录（用户输入路径时最自然的写法 ✓）
 *   "~/Projects" → "/home/xxx/Projects"
 *   "~"          → "/home/xxx"
 *   其他          → 原样返回
 */
function expandHome(p: string): string {
    if (p === "~") return os.homedir();
    if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
    return p;
}

/**
 * 反向美化：家目录下的路径 → ~/xxx（显示用，短且好读 ✓）
 *   ★ 只用于展示，不参与任何文件操作 ✓
 */
function compactHome(p: string): string {
    const home = os.homedir();
    if (p === home) return "~";
    return p.startsWith(home + path.sep) ? "~" + p.slice(home.length) : p;
}

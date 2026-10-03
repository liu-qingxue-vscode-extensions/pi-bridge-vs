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
import { initLogger, logInfo, logError, logDebug, logWarn } from "./logger.js";
import { PiClient } from "./pi/client.js";
import { DebugPanel } from "./view/debug-panel.js";
import { ChatView } from "./view/chat-view.js";
import { toRpcCommand, type FrontendMessage } from "./bridge/format-frontend.js";
import { toChatPatch } from "./bridge/format-backend.js";
import { messagesToPatches, type ReplayMessage } from "./bridge/replay.js";
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

    // 3b. 数据流 ①-补充：pi 的 stderr（错误 / 诊断）
    //
    // 【两个去处（都是必须的）】
    //   ① 调试板：收原始行（诊断用 ✓）
    //   ② ★ 聊天侧：转成 notice → 走通知面板 ✓
    //     之前只喂了 ① ✗ → stderr 的通知【永远不出现】✗（用户报的 bug ✓）
    pi.onStderr((text) => {
        for (const line of text.split("\n")) {
            if (!line.trim()) continue;
            debugPanel.log({ type: "stderr", text: line });
            // ★ 转渲染指令 → 进通知板
            const patch = toChatPatch({ type: "stderr", text: line });
            if (patch) chatState.apply(patch);
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
            // ★ 新建会话（点 ＋）
            //
            // 【★ 这是“伪新建”】（实测确认 ✓ 用户点出来的）
            //   pi 的行为：new_session 只是换一个【预定路径】✓
            //   ★ 文件【不在磁盘上创建】✗ —— 真正发第一句话才落盘 ✓
            //   → 所以我们【不刷新会话列表】（文件还没建，列表里本来就不该有 ✓）
            //     它会在你发第一句话之后，下次刷新时才出现 ✓
            if (msg.kind === "newSession") {
                try {
                    const r = (await pi.sendRaw({ type: "new_session" })) as {
                        success?: boolean;
                        error?: string;
                        data?: { cancelled?: boolean };
                    };
                    logInfo(
                        `新建会话：success=${r.success} cancelled=${r.data?.cancelled}` +
                            (r.error ? ` error=${r.error}` : ""),
                    );
                    if (!r.success || r.data?.cancelled) {
                        void vscode.window.showErrorMessage(
                            `新建会话未成功：${r.error ?? "已取消"}`,
                        );
                        return;
                    }

                    // ★ 清空界面（新会话是空的 ✓）+ 清通知（旧进程周期的事 ✓）
                    chatState.reset();
                    chatState.clearNotices();
                    chatView.post("noticesCleared", true);
                    chatView.post("snapshot", chatState.snapshot());
                    // ★ 标题更新：新会话还没名字 ✓
                    void pushCurrentSessionTitle("");
                    logInfo("新建会话完成（文件将在首条消息时创建 ✓）");
                } catch (err) {
                    logError(`新建会话失败: ${toErrorMessage(err)}`);
                    void vscode.window.showErrorMessage(`新建会话失败：${toErrorMessage(err)}`);
                }
                return;
            }

            // ★ webview 的日志 → 写进输出面板（★ 不要写进调试板 ✗）
            //   level 由前端指定：debug / info / warn / error ✓
            if (msg.kind === "webviewLog") {
                const m = msg as { level?: string; text?: unknown };
                const text = `[webview] ${String(m.text ?? "")}`;
                if (m.level === "error") logError(text);
                else if (m.level === "warn") logWarn(text);
                else if (m.level === "debug") logDebug(text);
                else logInfo(text);
                return;
            }

            // ★ 拉取会话列表（打开面板时按需请求 ✓）
            //   ★ 这是【第一级】IO：只扫文件名（零内容 IO ✓）名字/异常状态从缓存取 ✓
            if (msg.kind === "listSessions") {
                await postSessionList();
                void pushCurrentSessionTitle();
                return;
            }

            // ★ 给【当前会话】改名（点按钮行中间的标题区 ✓）
            if (msg.kind === "renameSession") {
                try {
                    const st = (await pi.sendRaw({ type: "get_state" })) as {
                        data?: { sessionFile?: unknown };
                    };
                    const file = st?.data?.sessionFile;
                    if (typeof file !== "string" || !file) {
                        throw new Error("拿不到当前会话文件（pi 还没启动？）");
                    }
                    const old = await sessionStore.findName(file);
                    const name = await vscode.window.showInputBox({
                        title: "修改会话名",
                        prompt: "给这个会话起个名字（留空或取消 = 不改）",
                        value: old ?? "",
                    });
                    if (name === undefined) return; // 取消 ✓
                    const trimmed = name.trim();
                    if (!trimmed) return; // 空 → 不改 ✓

                    await pi.sendRaw({ type: "set_session_name", name: trimmed });

                    // ★ 只更新缓存（不重读文件 ✓ 用户定的 ✓）
                    await sessionStore.setName(file, trimmed);
                    const list = await sessionStore.listEntries();
                    chatView.post("sessions", list);
                    void pushCurrentSessionTitle(trimmed);
                    logInfo(`会话已改名：${trimmed}`);
                } catch (err) {
                    logError(`改名失败: ${toErrorMessage(err)}`);
                    void vscode.window.showErrorMessage(`改名失败：${toErrorMessage(err)}`);
                }
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

                    // ★ 清空当前界面 + ★ 重放该会话的历史消息 ✓
                    //   （否则切过去是一片空白 ✗）
                    chatState.reset();
                    await replaySessionMessages();
                    // ★ 通知【跟着会话走】：切了会话就是另一个上下文了 ✓
                    //   （用户定的：切换会话应该清通知 ✓）
                    chatState.clearNotices();
                    chatView.post("cwd", pi.getCwd());
                    chatView.post("noticesCleared", true);
                    chatView.post("snapshot", chatState.snapshot());
                    chatView.post("sessions", await sessionStore.listEntries());
                    // ★ 标题也要更新（用户报的 bug ✓）
                    void pushCurrentSessionTitle();
                    void vscode.window.showInformationMessage(
                        `已切换到会话 ${info.name ?? info.id.slice(0, 8)}`,
                    );
                } catch (err) {
                    logError(`切换会话失败: ${toErrorMessage(err)}`);
                    void vscode.window.showErrorMessage(`切换会话失败：${toErrorMessage(err)}`);
                }
                return;
            }

            // ★ 克隆 / 分叉（B19）—— 都是本地处理（不走 formatMap ✓）
            //
            // 【为什么要在宿主侧做而不是前端直接发？】
            //   ① 分叉需要【先取 get_fork_messages】拿到 entryId ✗
            //      → 前端不知道 entryId ✓（get_messages 不返回 id ✓ 实测确认 ✓）
            //   ② 切完会话要【重放历史 + 刷新列表 + 改标题】✗ 这些都是宿主能力 ✓
            if (msg.kind === "cloneSession" || msg.kind === "forkSession") {
                await doSessionBranch(msg);
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
            //
            // 【关键：reload 要【携带会话】✓（用户早就提的）】
            //   reload 前是哪个会话，reload 之后还得是它 ✓
            //   否则得重新去面板里找一遍 ✗
            if (msg.kind === "reloadPi") {
                logInfo("=== 用户请求重启 pi ===");

                // ① 先问 pi：现在是哪个会话文件（★ 必须在 stop 之前问 ✗）
                let prevSession: string | null = null;
                const wasStarted = pi.isStarted();
                logInfo(`  reload 前：pi ${wasStarted ? "已启动" : "★ 未启动（无会话可携带）"}`);
                if (wasStarted) {
                    try {
                        const st = (await pi.sendRaw({ type: "get_state" })) as {
                            data?: { sessionFile?: unknown; messageCount?: unknown };
                        };
                        const f = st?.data?.sessionFile;
                        if (typeof f === "string" && f) {
                            prevSession = f;
                            logInfo(`  reload 前会话：${f}（${st.data?.messageCount} 条消息）`);
                        } else {
                            logInfo("  ★ reload 前拿不到 sessionFile");
                        }
                    } catch (err) {
                        logError(`  ★ reload 前取 sessionFile 失败: ${toErrorMessage(err)}`);
                    }
                }

                // ② 重启（新参数生效）
                await pi.reload();
                chatState.reset();
                logInfo("  重启完成");

                // ③ ★ 切回原会话 + 重放历史 ✓
                if (prevSession) {
                    try {
                        const r = (await pi.sendRaw({
                            type: "switch_session",
                            sessionPath: prevSession,
                        })) as {
                            success?: boolean;
                            error?: string;
                            data?: { cancelled?: boolean };
                        };
                        logInfo(
                            `  切回：success=${r.success} cancelled=${r.data?.cancelled}` +
                                (r.error ? ` error=${r.error}` : ""),
                        );
                        if (r.success && !r.data?.cancelled) {
                            await replaySessionMessages();
                            // ★ 再确认一次（防“切了但没生效”✗）
                            const after = (await pi.sendRaw({ type: "get_state" })) as {
                                data?: { sessionFile?: unknown; messageCount?: unknown };
                            };
                            logInfo(
                                `  ★ 校验：现在 = ${after.data?.sessionFile}（${after.data?.messageCount} 条）`,
                            );
                        } else {
                            logError("  ★ 切回没成功 → 退回空会话");
                        }
                    } catch (err) {
                        logError(`  ★ 切回会话异常（退回空会话）: ${toErrorMessage(err)}`);
                    }
                }

                // ★ 通知清掉（那是上一个进程生命周期的事 ✓）
                chatState.clearNotices();
                chatView.post("noticesCleared", true);
                chatView.post("cwd", pi.getCwd());
                chatView.post("snapshot", chatState.snapshot());
                chatView.post("sessions", await sessionStore.listEntries());
                logInfo("=== 重启流程结束 ===");
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

    // ★ 把【当前会话的历史消息】重放进 ChatState（切换会话 / 重开后用 ✓）
    //
    // 数据源：pi 的 get_messages ✓
    //   ★ 它返回的 message 结构与事件流里的一致 → 直接复用我们的气泡逻辑 ✓
    /**
     * ★ 克隆 / 分叉会话（B19）
     *
     * 【clone】无参数 ✓ 整会话复制成一个新文件 ✓ pi 会【自动切过去】✓
     * 【fork】 需要一个 entryId ✓ 但它是【用户消息】的 id ✗ 不是气泡的 ✗
     *
     *   ★ 用户的比喻：气泡底下那把按钮“就像一把刀，切一刀，前面的保留”✓
     *   → 刀挂在【某个 AI 气泡】下面（该 AI 组的末尾 ✓）
     *   → 要保留到它为止 → 需要【它后面那条用户消息】作锚点 ✓
     *   → 而前端的 userIndex 就是“这个气泡前面有几个用户气泡”✓
     *     = 那个锚点的下标 ✓（0-based ✓ 正好就是 get_fork_messages 的下标 ✓）
     *
     *   ★ 最后一组【没有下一个用户气泡】→ 前端不会给它加按钮 ✓（正好 ✓）
     *
     * 【为什么每次都重新取 get_fork_messages？】
     *   fork 之后【旧 entryId 会失效】✗（实测确认 ✓）
     *   → 不能缓存，每次现取 ✓
     */
    async function doSessionBranch(
        msg: { kind: "cloneSession" } | { kind: "forkSession"; payload: { userIndex: number } },
    ): Promise<void> {
        const isFork = msg.kind === "forkSession";
        const label = isFork ? "分叉" : "克隆";
        try {
            const cmd: Record<string, unknown> = { type: isFork ? "fork" : "clone" };
            if (isFork) {
                const fm = (await pi.sendRaw({ type: "get_fork_messages" })) as {
                    data?: { messages?: { entryId: string; text: string }[] };
                };
                const list = fm?.data?.messages ?? [];
                const target = list[msg.payload.userIndex];
                if (!target) {
                    logWarn(`分叉失败：没有下标为 ${msg.payload.userIndex} 的用户消息（共 ${list.length} 条）`);
                    void vscode.window.showWarningMessage("分叉失败：找不到对应的分界点");
                    return;
                }
                logInfo(`分叉锚点 [${msg.payload.userIndex}]：${target.text.slice(0, 40)}`);
                cmd.entryId = target.entryId;
            }

            const res = (await pi.sendRaw(cmd as never)) as {
                success?: boolean;
                data?: { cancelled?: boolean };
                error?: string;
            };
            if (res?.success === false) throw new Error(res.error ?? "未知错误");
            if (res?.data?.cancelled) {
                logInfo(`${label}被取消`);
                return;
            }

            // ★ 切到了新会话（自动的 ✓）→ 和 switchSession 一样收尾 ✓
            chatState.reset();
            await replaySessionMessages();
            chatState.clearNotices();
            chatView.post("cwd", pi.getCwd());
            chatView.post("noticesCleared", true);
            chatView.post("snapshot", chatState.snapshot());
            // ★ 列表要重扫：新文件刚生成 ✓
            await postSessionList();
            void pushCurrentSessionTitle();
            logInfo(`${label}完成`);
            void vscode.window.showInformationMessage(`已${label}为新会话`);
        } catch (err) {
            logError(`${label}失败: ${toErrorMessage(err)}`);
            void vscode.window.showErrorMessage(`${label}失败：${toErrorMessage(err)}`);
        }
    }

    async function replaySessionMessages(): Promise<void> {        const resp = (await pi.sendRaw({ type: "get_messages" })) as {
            data?: { messages?: ReplayMessage[] };
        };
        const messages = resp?.data?.messages;
        if (!Array.isArray(messages) || messages.length === 0) {
            logDebug("会话没有历史消息");
            return;
        }
        logInfo(`重放历史消息 ${messages.length} 条`);
        for (const patch of messagesToPatches(messages)) {
            // ★ 走 ChatState.apply：与实时流同一条渲染路径 ✓
            chatState.apply(patch as never);
        }
    }

    // ★ 把【当前会话的名字】推给前端标题区（按钮行中间 ✓）
    //
    // 【怎么知道“当前”是哪个会话？】
    //   问 pi 的 get_state（sessionFile ✓）
    //   ★ 但 get_state 会【触发懒启动】✗ → 所以先判断 isStarted ✓
    //     （用户还没发过消息就不该因为“打开面板”而启动 pi ✓）
    async function pushCurrentSessionTitle(overrideName?: string): Promise<void> {
        if (overrideName !== undefined) {
            chatView.post("sessionTitle", overrideName);
            return;
        }
        if (!pi.isStarted()) {
            chatView.post("sessionTitle", "");
            return;
        }
        try {
            const st = (await pi.sendRaw({ type: "get_state" })) as {
                data?: { sessionFile?: unknown };
            };
            const file = st?.data?.sessionFile;
            if (typeof file === "string" && file) {
                // ★ 有名字就用名字；★ 没名字就用【短 id】
                //   （用户定的：ID 是独特的 ✓ 看着烦自然会去改名 ✓）
                const nm = await sessionStore.findName(file);
                chatView.post("sessionTitle", nm || shortIdOf(file));
                return;
            }
        } catch (err) {
            logDebug(`取当前会话名失败（忽略）: ${toErrorMessage(err)}`);
        }
        chatView.post("sessionTitle", "");
    }

    /** 从会话文件路径里取【短 id】（文件名 2026-…Z_<uuid>.jsonl ✓）*/
    function shortIdOf(file: string): string {
        const base = file.split(/[/\\]/).pop() ?? "";
        const m = /_([0-9a-f-]{6,})\.jsonl$/i.exec(base);
        return m ? m[1].slice(0, 8) : base.replace(/\.jsonl$/i, "").slice(0, 12);
    }

    /**
     * ★ 推【会话列表】给前端（scope 过滤在这里做 ✓）
     *
     * 【为什么抽成函数？】
     *   它被【两处】调用：
     *     ① 前端请求（打开面板 ✓）
     *     ② ★ 配置变化（scope 改了要【立刻重新过滤】✓ 用户要求的 ✓）
     *   scope 本质上是“前端显示范围”→ 应该【实时生效】✗ 不是等重开面板 ✓
     */
    async function postSessionList(): Promise<void> {
        const all = await sessionStore.listEntries();
        // ★ scope（用户定的 ✓）：
        //   "current" = 只看当前 cwd 的会话（受限模式 ✓）
        //   "all"     = 所有 cwd（前端按 cwd 分组显示 ✓）
        const scope = vscode.workspace
            .getConfiguration("pi-bridge.sessions")
            .get<string>("scope", "all");
        const cur = pi.getCwd();
        const list = scope === "current" ? all.filter((s) => s.cwd === cur || !s.cwd) : all;
        logInfo(
            `会话列表：scope=${scope} → ${list.length}/${all.length} 条` +
                (scope === "current" ? `（当前 cwd=${cur}）` : ""),
        );
        chatView.post("sessions", list);
    }

    // ★ scope 改了 → 立刻重新推列表（不用重开面板 ✓）
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("pi-bridge.sessions")) {
                void postSessionList();
            }
        }),
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

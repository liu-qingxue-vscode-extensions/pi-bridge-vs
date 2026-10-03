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
import fs, { existsSync } from "node:fs";
import { resolve } from "node:path";
import { initLogger, logInfo, logError, logDebug, logWarn } from "./logger.js";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { PiClient } from "./pi/client.js";
import { DebugPanel } from "./view/debug-panel.js";
import { ChatView } from "./view/chat-view.js";
import { toRpcCommand, type FrontendMessage } from "./bridge/format-frontend.js";
import {
    readSettings,
    patchSettings,
    resolveSessionRoot,
    settingsPath,
} from "./pi/settings.js";
import { SETTINGS_GROUPS, getByPath, setByPath } from "./pi/settings-schema.js";
import { toChatPatch } from "./bridge/format-backend.js";
import { messagesToPatches, type ReplayMessage } from "./bridge/replay.js";
import { SessionStore, deleteSessionFile, sessionDirForCwd, validateSessionFile } from "./pi/session-store.js";
import { ChatState } from "./view/chat-state.js";
import { toErrorMessage } from "./utils.js";

/** ★ 启用模型列表的存储键（B23）*/
const MODEL_STORE_KEY = "pi-bridge.modelStore.enabled";

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
        readArgs: () => readLaunchArgs(),
    });

    /** ★ 我们给 pi 的启动参数（设置项 pi-bridge.launchArgs ✓）*/
    function readLaunchArgs(): string[] {
        const args = vscode.workspace.getConfiguration("pi-bridge").get<string[]>("launchArgs", []);
        return Array.isArray(args) ? args.filter((a) => typeof a === "string") : [];
    }
    const chatState = new ChatState(); // 插件端权威聊天状态（webview 只是显示器）
    // ★ 会话发现层（读 sessions/ 目录 + 维护 cwd 映射表 ✓）
    const sessionStore = new SessionStore(context);

    // ★★ sessionDir 变量化（B24 用户要求的第二步 ✓）
    //
    //   原来 session-store 硬编码 <agentDir>/sessions ✗
    //   而 pi 的 settings.json 里有 sessionDir ✓ 改了它 pi 就把会话写别处 ✗
    //   → 我们若不变 → 【会话列表全空】✗（用户：“一定会出错”✓ 完全正确）
    //   优先级：CLI --session-dir > settings.sessionDir > 默认 ✓
    //   ★ 改这个值要在【设置面板保存】和【激活时】都重新算一次 ✓
    sessionStore.setRoot(resolveSessionRoot(readLaunchArgs()));
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
    //
    // ★ 订阅者 3（只有一行）：piBusy —— “agent 在不在跑”
    //   为什么需要它？（B20 实测发现的问题 ✓）
    //      pi 在 streaming 时收到【普通 prompt】→ 【回执正常】✗ 但【消息静默丢失】✗✗
    //      实测：用户消息条数不增 ✓ 前端【完全不会察觉】✓
    //      → 必须【自己判断】→ busy 时改用 steer ✓（用户定的 ✓）
    //   ★ 为什么不在前端判断？前端那份【有网络延迟】✗ → 会有竞态 ✓
    //     而事件【直接从这里流过】✓ → 零延迟 ✓
    let piBusy = false;
    /** ★ 是否已推过初始状态（惰启动后只推一次 ✓）*/
    let pushedInitialState = false;

    /**
     * ★ get_available_models 的缓存（B23 用户要求 ✓）
     *
     * 【为什么可以缓存？】（用户的原话 ✓）
     *   “好像是个死数据，不用维护就可以缓存”
     *   模型目录在【一个 pi 进程的生命周期内】不会变 ✗
     *   （它只受 models.json / --models 影响，都是【启动时】读的 ✓）
     *
     * 【什么时候必须清？】
     *   · pi.reload() 之后 → 那是【新进程】✗ 目录可能不同 ✓
     *   · 用户在别处改了 models.json → 需要重启 pi（我们顺带就清了 ✓）
     * ★ 所以维护成本就是【reload 时置 null】✓ 一行 ✓
     */
    let cachedModels: { id?: string; name?: string; provider?: string }[] | null = null;
    pi.onEvent((event) => {
        // ★ 状态维护（在调试板之前，确保不漏 ✓）
        //
        // 【只用这两个事件，为什么不用 agent_end？】
        //   · agent_end 的语义是“这一轮任务生产完毕”✗ 但它【后面还可能有尾巴】✗
        //     （重试 / 队列投递 / 续写 ✓）
        //   · agent_settled 才是“彻底空闲（重试/队列都空了）”✓
        //   → 若用 agent_end 置 idle，会在【尾巴还没跑完】时就误判空闲 ✗
        //     → 用户这时发消息会退化成 prompt ✗ → 【又被静默丢弃】✗
        if (event.type === "agent_start") piBusy = true;
        else if (event.type === "agent_settled") piBusy = false;

        // ★ 模型 / 思考等级的变化【没有专门的会话事件】✗（model_select 只发给扩展 ✓）
        //   但这两个能反映它 ✓（B23 实测确认）：
        //     · thinking_level_changed → 直接就是它 ✓
        //     · entry_appended 里 entry.type === "model_change" → 模型换了 ✓
        //   （为什么不每條 entry_appended 都刷？流式时它会很频繁 ✗ 没必要 ✓）
        if (event.type === "thinking_level_changed") {
            void pushPiState();
        } else if (event.type === "entry_appended") {
            const e = event as { entry?: { type?: string } };
            if (e.entry?.type === "model_change") void pushPiState();
        }

        debugPanel.log(event);
        const patch = toChatPatch(event);
        if (!patch) return;
        // 任务级状态不进 ChatState（它不是气泡），直接推给视图
        if (patch.kind === "agentState") {
            chatView.post("agentState", patch.state);
        } else if (patch.kind === "queueUpdate") {
            // ★ 队列也不进 ChatState（它不是历史消息 ✗ 只是当前排队状态 ✓）
            //   理由：它【会被重放污染】✗ —— 重放时队列必然是空的 ✓
            chatView.post("queueUpdate", { steering: patch.steering });
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

            // ★ 删除会话（B21）
            //
            // 【为什么【没有】走 pi 的 RPC？】
            //   查过官方源码：不存在 delete_session 命令 ✗
            //   而 TUI 里能删 ✓ → 它是【前端自己删文件】✓
            //   （dist/modes/interactive/components/session-selector.js:541 ✓）
            //
            // 【为什么照拄它而不是直接 unlink？】
            //   ① ★ 先试 `trash` CLI → 文件夹进回收站 ✓【可恢复】✓
            //      失败（没装 trash）才回落 unlink（永删 ⚠）
            //   ② 屏幕报回方法（trash / unlink ✓）让用户知道能不能找回 ✓
            //
            // 【两个保护（官方也有 ✓）】
            //   · 不能删【当前会话】✗（删了 pi 进程还抱着它 ✓ 会出怪事 ✓）
            //   · 必须二次确认 ✗（用原生 modal ✗ 而不是自绘 ✓ 更不容错 ✓）
            if (msg.kind === "deleteSession") {
                await doDeleteSession(msg.path, msg.name);
                return;
            }

            // ★ 导出会话（B21）：把文件复制到用户选定的位置 ✓
            //   注意：导出【不动】原文件 ✓ 只是复制 ✓
            if (msg.kind === "exportSession") {
                await doExportSession(msg.path, msg.name);
                return;
            }

            // ★ 导入会话（B21）：外部 .jsonl → 当前 cwd 的会话目录 ✓
            if (msg.kind === "importSession") {
                await doImportSession();
                return;
            }

            // ★ 拉模型候选（B23）—— 本地处理 ✓
            //
            // 【范围 = 启用列表】（用户定的 ✓）
            //   · 启用列表存 globalState ✓（不是 VS Code 配置 ✗ 见 B23 文档）
            //   · ★ 空 = 不限制 → 用全部可用模型 ✓
            //   · 编辑入口在 B24 的设置面板 ✓（这里只读 ✓）
            if (msg.kind === "listModels") {
                await postModelList();
                return;
            }

            // ★ 拉思考等级候选（B23）—— 直接问 pi ✓
            if (msg.kind === "listThinkingLevels") {
                try {
                    const r = (await pi.sendRaw({ type: "get_available_thinking_levels" })) as {
                        data?: { levels?: string[] };
                    };
                    const st = (await pi.sendRaw({ type: "get_state" })) as {
                        data?: { thinkingLevel?: string };
                    };
                    chatView.post("thinkingLevels", {
                        levels: r?.data?.levels ?? [],
                        current: st?.data?.thinkingLevel,
                    });
                } catch (err) {
                    logError(`拉思考等级失败: ${toErrorMessage(err)}`);
                }
                return;
            }

            // ★ 设置面板（B24）：打开 / 重新读取（本地文件操作 ✓）
            if (msg.kind === "openSettings") {
                postSettings();
                return;
            }

            // ★ 保存设置（B24）：★ 读-改-写 ✗ 只动我们改过的字段 ✓
            if (msg.kind === "saveSettings") {
                try {
                    const patch: Record<string, unknown> = {};
                    for (const [k, v] of Object.entries(msg.values ?? {})) {
                        // ★ 空字符串 → 删除该字段 ✗（pi 会回到默认 ✓）
                        //   （而不是写一个空值进去 ✗ 那样 pi 会当成“显式设为空”✓）
                        setByPath(patch, k, v === "" || v === undefined ? undefined : v);
                    }
                    patchSettings(patch);

                    // ★ 改了 sessionDir → 我们的会话扫目录要跟着改 ✗
                    //   （否则列表全空 ✓ 用户预言的“一定会出错”✓）
                    if ("sessionDir" in msg.values) {
                        sessionStore.setRoot(resolveSessionRoot(readLaunchArgs()));
                        await postSessionList();
                    }

                    // ★ 重新读一遍回给前端（确认真的写进去了 ✓）
                    postSettings();
                    void vscode.window.showInformationMessage(
                        "设置已保存 ✓" +
                            (needsRestartHint(msg.values) ? "（部分项需重启 pi 生效 ✗ 点输入区的 ⟳）" : ""),
                    );
                } catch (err) {
                    logError(`保存设置失败: ${toErrorMessage(err)}`);
                    void vscode.window.showErrorMessage(`保存设置失败：${toErrorMessage(err)}`);
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
                cachedModels = null; // ★ 新进程 → 模型目录可能不同 ✗ 必须清 ✓
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
                            //   顺便：这一次 get_state 也是【模型的唯一来源】✗
                            //   （刚 reload 完没有 message_end → 不推模型的话
                            //     界面会显示【上一次的旧模型】✗ 用户报过的 bug ✓）
                            const after = (await pi.sendRaw({ type: "get_state" })) as {
                                data?: { sessionFile?: unknown; messageCount?: unknown };
                            };
                            logInfo(
                                `  ★ 校验：现在 = ${after.data?.sessionFile}（${after.data?.messageCount} 条）`,
                            );
                            await pushPiState();
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

                // ★★ 核心修正（B20）：agent 跑着时【prompt 会被静默丢弃】✗
                //   实测证据（scripts/probe-steer-followup.mjs ✓）：
                //     跑着时发 prompt → 回执 success ✓ 但【用户消息只有 1 条】✗
                //     steer       → queue_update 入队 ✓ 下一 turn 投递 ✓ 消息 2 条 ✓
                //   所以：busy 时自动改发 steer（用户：“自动判断是不是插话即可”✓）
                let toSend = cmd;
                if (cmd.type === "prompt" && piBusy) {
                    logInfo(`agent 正在跑 → prompt 自动转为 steer（避免静默丢失 ✓）`);
                    toSend = { type: "steer", message: cmd.message };
                    // ★ 告诉前端：这条是“插话”✗ 让它先渲染成【待插入】气泡 ✓
                    //   （queue_update 里 steering 消失 = 真被吃进去了 ✓）
                    chatView.post("inserting", { text: cmd.message });
                }

                // ★ 发完【记一笔回执】—— steer 的成败就在这一行看 ✓
                //   （B20 踩过的坑：send 的白名单把 steer 拒了 ✗
                //     而报错只在日志里 ✓ 用户看到的就是“没效果”✓）
                const resp = (await pi.send(toSend)) as
                    | { success?: boolean; error?: string; data?: unknown }
                    | undefined;
                if (toSend.type === "steer") {
                    logInfo(
                        `steer 回执: success=${resp?.success ?? "无回执"}` +
                            (resp?.error ? ` error=${resp.error}` : ""),
                    );
                }

                // ★★ 改模型的命令成功后【立刻刷新状态】✗（B23 用户实测报的 ✓）
                //
                // 【为什么不等事件？】
                //   · set_model 的回执里【确实有完整 model】✓（data: Model ✓）
                //     → 但它【没有 thinkingLevel】✗
                //   · 而 thinkingLevel 是【跟模型走的】✗（不同模型可用等级不同 ✓）
                //     实测：ollama/qwen2.5:3b → ["off"]；deepseek/deepseek-flash → 4 档且自动变 high ✓
                //   · 事件（entry_appended / thinking_level_changed）【会来】✓
                //     但【时机不定】✗ → 回执一到就补一次 get_state 最稳 ✓
                //     （一次 get_state 同时拿到 model + provider + thinkingLevel ✓）
                if (toSend.type === "set_model" || toSend.type === "cycle_model") {
                    logInfo(`模型命令回执：success=${resp?.success ?? "?"} → 立刻刷新状态 ✓`);
                    await pushPiState();
                }
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
            // ★ 不再弹“已激活 ✓”（B21 顺手清理 ✗）
            //   理由：它【每次重载窗口都弹】✗ 而且【没有信息量】✓（用户早就知道它活着了 ✓）
            //   开发模式下调试板会自动打开 ✓ 那才是真正的“已就绪”信号 ✓
            logInfo("pi-bridge-vs 已激活（首条消息时惰启动 pi）");
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

    /**
     * ★ 删除一个会话文件（B21）
     *
     * 【流程（照拄官方 TUI ✓ 见 B21 文档）】
     *   ① 保护：它是不是【当前会话】？→ 是就拒 ✓
     *   ② 保护：它存不存在 / 是不是会话文件？✓
     *   ③ 二次确认（原生 modal ✓）
     *   ④ 执行：trash ✓ → 回落 unlink ✓
     *   ⑤ 刷新列表（后端直接扫 ✓ 不等前端 ⟳）
     */
    async function doDeleteSession(filePath: string, name?: string): Promise<void> {
        const label = name ?? filePath.split("/").pop() ?? filePath;
        try {
            // ① 不能删当前会话 ✗
            //   （pi 还拿着它的句柄 ✓ 删掉之后切回/重放会出怪事 ✓）
            if (pi.isStarted()) {
                const st = (await pi.sendRaw({ type: "get_state" })) as {
                    data?: { sessionFile?: unknown };
                };
                const cur = st?.data?.sessionFile;
                if (typeof cur === "string" && cur && resolve(cur) === resolve(filePath)) {
                    void vscode.window.showWarningMessage(
                        "不能删除当前正在使用的会话（先切到别的会话再删 ✓）",
                    );
                    return;
                }
            }

            // ② 存在性 + ③ 二次确认
            if (!existsSync(filePath)) {
                void vscode.window.showErrorMessage("找不到该会话文件（可能已经被删了）");
                await postSessionList();
                return;
            }
            const pick = await vscode.window.showWarningMessage(
                `确定删除会话「${label}」？`,
                {
                    modal: true,
                    detail: `${filePath}\n\n会先尝试移到回收站（trash / gio ✓）；如果都没有才会永久删除 ⚠`,
                },
                "删除",
            );
            if (pick !== "删除") {
                logInfo("删除会话：用户取消");
                return;
            }

            // ④ 执行（trash 优先 → unlink 回落 ✓）
            const result = await deleteSessionFile(filePath);
            if (!result.ok) {
                logError(`删除会话失败: ${result.error}`);
                void vscode.window.showErrorMessage(`删除失败：${result.error}`);
                return;
            }
            logInfo(`已删除会话（${result.method}）：${filePath}`);
            void vscode.window.showInformationMessage(
                result.method === "unlink"
                    ? "会话已永久删除（系统没有可用的回收站命令 ⚠）"
                    : `会话已移到回收站 ✓（${result.method}）`,
            );

            // ⑤ 列表刷新（后端自己扫 ✓）
            await postSessionList();
        } catch (err) {
            logError(`删除会话异常: ${toErrorMessage(err)}`);
            void vscode.window.showErrorMessage(`删除失败：${toErrorMessage(err)}`);
        }
    }

    /**
     * ★ 导出会话（B21）
     *
     * 【为什么是“格式选择 + 保存路径”两步？】
     *   · jsonl 与 html 【不是平权的】✗：
     *       jsonl → 任意会话都能导 ✓（纯文件复制 ✓）
     *       html  → ★ 只能导【当前会话】✗（export_html 不接受 sessionPath ✗）
     *   · 而这个差别【必须说清楚】✗ → 自绘菜单写不下 ✓
     *   → 用原生 QuickPick（能带描述文字 ✓）而不是两个菜单项 ✓
     */
    async function doExportSession(filePath: string, name?: string): Promise<void> {
        if (!existsSync(filePath)) {
            void vscode.window.showErrorMessage("找不到该会话文件");
            await postSessionList();
            return;
        }

        // ★ 它是不是当前会话？（决定 html 那条路能不能走 ✓）
        const cur = await currentSessionFile();
        const isCurrent = !!cur && resolve(cur) === resolve(filePath);
        const base = (name ?? filePath.split("/").pop() ?? "session").replace(/[\\/:*?"<>|]/g, "_");

        const pick = await vscode.window.showQuickPick(
            [
                {
                    label: "$(json) 导出为 JSONL",
                    detail: "原始记录，可以再导入回 pi（任意会话都可导 ✓）",
                    fmt: "jsonl" as const,
                },
                {
                    label: "$(file-media) 导出为 HTML",
                    detail: isCurrent
                        ? "可读、可分享的单页（带当前主题 ✓）"
                        : "★ 只能导出【当前正在使用的会话】✗ 这一条现在不可用",
                    fmt: "html" as const,
                    disabled: !isCurrent,
                },
            ],
            { title: `导出会话「${base}」`, placeHolder: "选择格式" },
        );
        if (!pick) return;

        if (pick.fmt === "jsonl") {
            const target = await vscode.window.showSaveDialog({
                title: "导出会话（JSONL）",
                defaultUri: vscode.Uri.file(`${base}.jsonl`),
                filters: { "pi 会话": ["jsonl"] },
            });
            if (!target) return;
            await fs.promises.copyFile(filePath, target.fsPath);
            logInfo(`导出会话（jsonl）：${filePath} → ${target.fsPath}`);
            void vscode.window.showInformationMessage(`已导出到 ${target.fsPath}`, "打开所在目录").then(
                (p) => {
                    if (p) void vscode.commands.executeCommand("revealFileInOS", target);
                },
            );
            return;
        }

        // html（只能用 pi 的命令 ✓ 且只限当前会话 ✓）
        //
        // ★★ 这里必须【自己再拦一次】✗（不能只靠 QuickPick 的 disabled ✗）
        //   实测：disabled 只影响视觉 ✓ 用户【依然能点进去】✗
        //     → 于是弹了保存框 → 选完路径 → 导出的是【当前会话】而不是右键那条 ✗
        //       （用户看到的就是“流程走完了但文件没出现/不对”✗）
        //   ★ 教训：UI 的禁用【永远不可信】✗ 真正的约束必须在逻辑层 ✓
        if (!isCurrent) {
            logWarn("导出 HTML 被拒：不是当前会话");
            void vscode.window.showWarningMessage(
                "HTML 只能导出【当前正在使用的会话】✗\n先切到它，再导出 ✓",
            );
            return;
        }
        const target = await vscode.window.showSaveDialog({
            title: "导出会话（HTML）",
            defaultUri: vscode.Uri.file(`${base}.html`),
            filters: { HTML: ["html"] },
        });
        if (!target) return;
        // ★ pi 需要【懒启动】✗ —— export_html 得会话在跑才行 ✓
        const r = (await pi.sendRaw({
            type: "export_html",
            outputPath: target.fsPath,
        })) as { success?: boolean; error?: string };
        if (r?.success === false) {
            void vscode.window.showErrorMessage(`导出失败：${r.error ?? "未知错误"}`);
            return;
        }
        logInfo(`导出会话（html）：${target.fsPath}`);
        void vscode.window.showInformationMessage(`已导出到 ${target.fsPath}`);
    }

    /**
     * ★ 导入会话（B21）
     *
     * 【pi 完全没这个接口】✗（实测：无 import_session ✗）→ 只能自己做 ✓
     *
     * 【为什么要校验？】（用户：“不检验一下，不拦一下吗？”✓）
     *   · 导入的是【外部文件】✗ 可能是别的东西（普通 jsonl / 日志 / 导出错的 ✓）
     *   · 不拦的话，它会成为一个进不去又删不掉的【垃圾条目】✗
     *     （切过去会报 Session file is not a valid pi session ✓）
     *   → ★ 入库前先验明：它到底是不是 pi 的会话文件 ✓
     *
     * 【放哪个目录？】
     *   当前 cwd 对应的会话目录 ✓（理由见 format-frontend.ts 的注释 ✓）
     */
    async function doImportSession(): Promise<void> {
        const picks = await vscode.window.showOpenDialog({
            title: "导入会话（选择一个 pi 会话 .jsonl）",
            canSelectMany: false,
            filters: { "pi 会话": ["jsonl"] },
        });
        if (!picks?.length) return;
        const src = picks[0].fsPath;

        // ★ 入库前校验（不做的话会造出“垃圾会话”✗）
        const check = await validateSessionFile(src);
        if (!check.ok) {
            logWarn(`导入被拒：${check.reason}`);
            void vscode.window.showErrorMessage(`这不是一个可用的 pi 会话文件：${check.reason}`);
            return;
        }

        // 目标：当前 cwd 的会话目录 ✓
        const dir = sessionDirForCwd(pi.getCwd());
        await fs.promises.mkdir(dir, { recursive: true });
        let target = path.join(dir, path.basename(src));
        // ★ 同名不覆盖 ✗（避免把已有会话干掉 ✓）→ 加后缀 ✓
        if (existsSync(target)) {
            const short = `${Date.now().toString(36)}`;
            target = path.join(dir, path.basename(src).replace(/\.jsonl$/, `-${short}.jsonl`));
        }
        await fs.promises.copyFile(src, target);
        logInfo(`导入会话：${src} → ${target}`);

        await postSessionList();
        void vscode.window.showInformationMessage(`已导入到当前工作目录的会话列表 ✓`);
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
    /**
     * ★ 当前会话文件路径（没有则 undefined）
     *
     * 【为什么单独抽一个？】
     *   两个地方要用：
     *     · pushCurrentSessionTitle（取名字 ✓）
     *     · doExportSession（判断 html 那条路能不能走 ✓能不能删除 ✓）
     *   ★ 关键：若 pi 【未启动】就直接返回 undefined ✗
     *     不能为了问路而【懒启动】✗（用户还没发消息就不该把 pi 拉起来 ✓）
     */
    /**
     * ★ 读 pi 的 settings.json 里的默认模型（B23）
     *
     * 【为什么要读它？】
     *   刚打开视图时 pi 【还没启动】（惰启动 ✗）→ 拿不到 get_state ✓
     *   → 模型/思考那两格是【空的】✗（用户报的 ✓）
     *   → 而 pi 的 settings.json 里【本来就有】defaultModel / defaultThinkingLevel ✓
     *     实测字段：defaultProvider / defaultModel / defaultThinkingLevel / enabledModels ✓
     *
     * ★ 等 pi 起来后，探针会用【真实值】覆盖它 ✓（所以只是"先占位"✓）
     */
    function readPiDefaults(): {
        model?: string;
        provider?: string;
        thinkingLevel?: string;
    } {
        try {
            const p = path.join(getAgentDir(), "settings.json");
            const d = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
            return {
                model: typeof d.defaultModel === "string" ? d.defaultModel : undefined,
                provider: typeof d.defaultProvider === "string" ? d.defaultProvider : undefined,
                thinkingLevel:
                    typeof d.defaultThinkingLevel === "string" ? d.defaultThinkingLevel : undefined,
            };
        } catch (err) {
            logDebug(`读 settings.json 默认值失败（忽略）: ${toErrorMessage(err)}`);
            return {};
        }
    }

    /** ★ webview 就绪 → 推模型信息（已启动用真实值 ✓ 未启动用默认值占位 ✓）*/
    chatView.onReady = () => {
        if (pi.isStarted()) {
            void pushPiState();
            return;
        }
        const d = readPiDefaults();
        if (d.model || d.thinkingLevel) {
            chatView.post("modelInfo", {
                model: d.model ?? "",
                provider: d.provider ?? "",
                thinkingLevel: d.thinkingLevel ?? "",
            });
            logInfo(
                `未启动 → 显示 settings.json 默认值：${d.provider ?? ""}/${d.model ?? "?"}` +
                    ` thinking=${d.thinkingLevel ?? "?"}`,
            );
        }
    };

    /**
     * ★ 把设置内容推给前端（B24）
     *
     * ★ 每次【现读磁盘】✗ 不用缓存 ✓ 理由：
     *   pi 进程也会写这个文件 ✗（lastChangelogVersion 等 ✓）
     *   缓存的话用户会看到【旧值】✗ 而文件很小 ✓ 读它几乎免费 ✓
     */
    function postSettings(): void {
        const all = readSettings();
        // ★ 模型目录（给下拉框用 ✓）
        const catalog = readModelCatalog();
        const providers = [...new Set(catalog.map((m) => m.provider))].sort();

        const groups = SETTINGS_GROUPS.map((g) => ({
            title: g.title,
            items: g.items.map((f) => {
                // ★ 动态注入选项（B24 用户要求：这些字段改成“有限字段”下拉 ✓）
                let options = f.options;
                if (f.key === "defaultProvider") {
                    options = providers.map((p) => ({ value: p, label: p }));
                } else if (f.key === "defaultModel") {
                    // ★ 只显示 provider/id ✗（B24 用户反馈：加名字太乱 ✓）
                    //   名字放 title 里（悬停能看 ✓）—— 选项本身就是“选哪个模型”✓
                    //   而 provider/id 【已经是唯一标识】✗ 不用再带一遍名字 ✓
                    options = catalog.map((m) => ({
                        value: m.id,
                        label: `${m.provider}/${m.id}`,
                    }));
                } else if (f.kind === "extlist") {
                    // ★ 已装扩展：选项 = 全部已装 ✓ 值 = 当前启用的 ✓
                    //   前端用复选框列表渲染 ✓
                    options = readInstalledExtensions().map((x) => ({
                        value: x.source,
                        label: x.source + (x.enabled ? "" : "（已停用）"),
                    }));
                } else if (f.key === "enabledModels") {
                    // ★ 列表控件也用它：下拉“选一个添加”✗ 不用手敲 ✓
                    //   （用户：“都可以改成类似的设计”✓）
                    options = catalog.map((m) => ({
                        value: `${m.provider}/${m.id}`,
                        label: `${m.provider}/${m.id}`,
                    }));
                }
                return {
                    key: f.key,
                    label: f.label,
                    desc: f.desc,
                    kind: f.kind,
                    options,
                    min: f.min,
                    max: f.max,
                    needsRestart: f.needsRestart,
                    value: getByPath(all, f.key) ?? f.fallback ?? defaultForKind(f.kind),
                    exists: getByPath(all, f.key) !== undefined,
                };
            }),
        }));
        chatView.post("settings", { path: settingsPath(), groups });
    }

    /**
     * ★ 已装的【扩展】列表（B24 —— 拓展组用 ✓）
     *
     * 【怎么区分“扩展”和“依赖的依赖”？】（实测确认 ✓）
     *   npm 目录里有 159 个包 ✗ 但只有 9 个是真扩展 ✓
     *   而【扩展【必须有 `pi` 字段】✗（声明它提供什么 ✓）：
     *     @mammothb/pi-mermaid  → "pi": { "skills": [...] }       ✓ 扩展
     *     @jamesjfoong/pi-ollama → "pi": { "extensions": [...] }   ✓ 扩展
     *     ajv                    → 只有 "main" ✗                      ✓ 依赖
     *   → 读每个包的 package.json，有 pi 字段才算 ✓
     *
     * 【代价】读 ~159 个小 JSON ✗（几十毫秒 ✓ 且只在打开设置面板时读一次 ✓）
     *
     * 【启用/停用【是什么意思】？
     *   启用 = 在 settings.packages 里 ✓（pi 会加载它 ✓）
     *   停用 = 从 packages 里移掉 ✗（包还在磁盘上 ✓ 只是不加载 ✓）
     */
    function readInstalledExtensions(): { source: string; enabled: boolean }[] {
        const nm = path.join(getAgentDir(), "npm", "node_modules");
        const enabledSet = new Set(
            (readSettings().packages as string[] | undefined)?.filter(
                (x) => typeof x === "string",
            ) ?? [],
        );
        const out: { source: string; enabled: boolean }[] = [];

        const check = (pkgName: string, dir: string) => {
            try {
                const pj = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as {
                    pi?: unknown;
                };
                if (!pj.pi) return; // ★ 没有 pi 字段 → 不是扩展 ✗
                const src = `npm:${pkgName}`;
                out.push({ source: src, enabled: enabledSet.has(src) });
            } catch {
                /* 读不到就当不是 ✓ */
            }
        };

        try {
            for (const e of fs.readdirSync(nm, { withFileTypes: true })) {
                if (!e.isDirectory()) continue;
                if (e.name.startsWith("@")) {
                    // ★ scope 包（@xxx/yyy ✓）多一层 ✓
                    const scopeDir = path.join(nm, e.name);
                    for (const s of fs.readdirSync(scopeDir, { withFileTypes: true })) {
                        if (s.isDirectory()) check(`${e.name}/${s.name}`, path.join(scopeDir, s.name));
                    }
                } else if (!e.name.startsWith(".")) {
                    check(e.name, path.join(nm, e.name));
                }
            }
        } catch (err) {
            logDebug(`读已装扩展失败: ${toErrorMessage(err)}`);
        }

        // ★ git: 开头的包（settings 里声明但不在 npm 目录 ✓）也一并列出 ✓
        for (const src of enabledSet) {
            if (src.startsWith("git:")) out.push({ source: src, enabled: true });
        }
        out.sort((a, b) => a.source.localeCompare(b.source));
        logInfo(`已装扩展：${out.length} 个（启用 ${out.filter((x) => x.enabled).length} ✓）`);
        return out;
    }

    /**
     * ★ 拉一次模型目录（给设置面板的下拉框用 ✓ B24）
     *
     * 【为什么不用 cachedModels？】
     *   它要【惰启动 pi】✗（get_available_models 是 pi 的命令 ✓）
     *   而打开设置面板不应该把 pi 拉起来 ✗
     *   → 设置面板用【磁盘上的目录】✓ 反正它不是热数据 ✓
     *
     * ★★ 两个文件【是互补的】✗（B24 实测踩到 ✓）
     *   · models.json       = 用户手写的供应商（ollama / mock / deepseek … ✓）
     *                         格式：{ providers: { <prov>: { models: [...] } } }
     *   · models-store.json = ★ pi 生成的内置供应商目录 ✗
     *                         （github-copilot 34 个、deepseek 2 个 ✓）
     *                         格式：{ <prov>: { models: [...] } }  ← 没有 providers 包装
     *   只读一个的话：ollama 不全 · GitHub 完全没有 ✓（用户报的 ✓）
     *   → ★ 两个都读，按 provider/id 去重 ✓
     */
    function readModelCatalog(): { provider: string; id: string; name?: string }[] {
        const out: { provider: string; id: string; name?: string }[] = [];
        const seen = new Set<string>();

        const addFrom = (prov: string, models: { id?: string; name?: string }[] | undefined) => {
            for (const m of models ?? []) {
                if (!m?.id) continue;
                const key = `${prov}/${m.id}`;
                if (seen.has(key)) continue;
                seen.add(key);
                out.push({ provider: prov, id: m.id, name: m.name });
            }
        };

        // ① models.json（用户自定义 ✓ 有 providers 包装）
        try {
            const p = path.join(getAgentDir(), "models.json");
            const d = JSON.parse(fs.readFileSync(p, "utf8")) as {
                providers?: Record<string, { models?: { id?: string; name?: string }[] }>;
            };
            for (const [prov, v] of Object.entries(d.providers ?? {})) addFrom(prov, v.models);
        } catch (err) {
            logDebug(`读 models.json 失败: ${toErrorMessage(err)}`);
        }

        // ② models-store.json（pi 的内置目录 ✓ 没有 providers 包装）
        try {
            const p = path.join(getAgentDir(), "models-store.json");
            const d = JSON.parse(fs.readFileSync(p, "utf8")) as Record<
                string,
                { models?: { id?: string; name?: string }[] }
            >;
            for (const [prov, v] of Object.entries(d)) {
                if (v && typeof v === "object" && !Array.isArray(v)) addFrom(prov, v.models);
            }
        } catch (err) {
            logDebug(`读 models-store.json 失败: ${toErrorMessage(err)}`);
        }

        logDebug(`模型目录（合并两个文件）：${out.length} 个 · ${[...new Set(out.map((m) => m.provider))].length} 个供应商`);
        return out;
    }

    /** 控件类型对应的“空值”（未配置时展示用 ✓）*/
    function defaultForKind(kind: string): unknown {
        if (kind === "boolean") return false;
        if (kind === "number") return 0;
        if (kind === "list") return [];
        return "";
    }

    /** ★ 改动里有没有“需要重启 pi”的项（给用户提示 ✓）*/
    function needsRestartHint(values: Record<string, unknown>): boolean {
        return SETTINGS_GROUPS.some((g) =>
            g.items.some((f) => f.needsRestart && f.key in values),
        );
    }

    /**
     * ★ 启用模型列表（B23）
     *
     * 【为什么存 globalState 而不是 VS Code 配置？】（用户定的 ✓）
     *   · 它该由【我们自己的设置面板】管 ✗（B24 ✓）
     *   · 放两处会分叉 ✗（Ctrl+, 改一个、面板改一个 → 谁赢？）
     *
     * 【格式】`provider/id` ✓
     * 【空数组】= 不限制 ✓ 用全部可用模型 ✓
     */
    function getEnabledModels(): string[] {
        const v = context.globalState.get<string[]>(MODEL_STORE_KEY, []);
        return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    }

    /** ★ 把模型候选推给前端（带 current 标记 ✓）*/
    async function postModelList(): Promise<void> {
        try {
            if (!cachedModels) {
                const r = (await pi.sendRaw({ type: "get_available_models" })) as {
                    data?: { models?: { id?: string; name?: string; provider?: string }[] };
                };
                cachedModels = r?.data?.models ?? [];
                logInfo(`模型目录已缓存：${cachedModels.length} 个（死数据 ✓ reload 时才清 ✓）`);
            }
            const all = cachedModels;
            const enabled = getEnabledModels();
            const st = (await pi.sendRaw({ type: "get_state" })) as {
                data?: { model?: { id?: string; provider?: string } };
            };
            const curId = st?.data?.model?.id;
            const curProv = st?.data?.model?.provider;

            const list = all
                .filter((m) => m.id && m.provider)
                .filter((m) => !enabled.length || enabled.includes(`${m.provider}/${m.id}`))
                .map((m) => ({
                    provider: m.provider as string,
                    id: m.id as string,
                    name: m.name,
                    current: m.id === curId && m.provider === curProv,
                }));
            logInfo(
                `模型候选：${list.length} 个（启用列表 ${enabled.length ? `${enabled.length} 项` : "空 → 全部"}）`,
            );
            chatView.post("modelList", list);
        } catch (err) {
            logError(`拉模型列表失败: ${toErrorMessage(err)}`);
        }
    }

    /**
     * ★★ 探针 + 取状态（一个动作两个用途 ✓ B23）
     *
     * 【为什么把它们放一起？】（用户提的架构问题 ✓）
     *   “检测子进程是否启动成功” = 发个命令看有没有回执 ✓
     *   “拿当前状态”             = 发 get_state 看它的 data ✓
     *   → 而 get_state 【本身就是一个完美的探针】✗
     *     所以这不是“把两件事绑在一起”✗ 而是“一个动作满足两个需求”✓
     *
     * 【什么时候调？】三个场合完全重合 ✓
     *   · 惰启动完成时✓
     *   · reload 后✓
     *   · 切会话后✓
     * 【平时靠事件增量】✗（entry_appended / thinking_level_changed ✓）
     *
     * @returns 探活结论（true = pi 确实活着并能应答 ✓）
     */
    async function pushPiState(): Promise<boolean> {
        if (!pi.isStarted()) return false;
        try {
            const st = (await pi.sendRaw({ type: "get_state" })) as {
                data?: {
                    model?: { id?: string; provider?: string };
                    thinkingLevel?: string;
                    sessionFile?: unknown;
                };
            };
            const d = st?.data;
            if (!d) return false; // 应答了但没 data（罕异 ✓）

            // ① ★ 模型 + 供应商 + 思考等级（修“模型没正确显示”✗）
            const m = d.model;
            chatView.post("modelInfo", {
                model: m?.id ?? "",
                provider: m?.provider ?? "",
                thinkingLevel: d.thinkingLevel ?? "",
            });

            // ② 会话名（顺便 ✓ 原本就要问 get_state ✓）
            const file = d.sessionFile;
            if (typeof file === "string" && file) {
                const nm = await sessionStore.findName(file);
                chatView.post("sessionTitle", nm || shortIdOf(file));
            } else {
                chatView.post("sessionTitle", "");
            }
            return true;
        } catch (err) {
            logError(`探针失败（pi 可能没起来）: ${toErrorMessage(err)}`);
            return false;
        }
    }

    async function currentSessionFile(): Promise<string | undefined> {
        if (!pi.isStarted()) return undefined;
        try {
            const st = (await pi.sendRaw({ type: "get_state" })) as {
                data?: { sessionFile?: unknown };
            };
            const file = st?.data?.sessionFile;
            return typeof file === "string" && file ? file : undefined;
        } catch (err) {
            logDebug(`取当前会话文件失败（忽略）: ${toErrorMessage(err)}`);
            return undefined;
        }
    }

    async function pushCurrentSessionTitle(overrideName?: string): Promise<void> {
        // ★ 改名后前端要【立刻】看到新名字 ✓ → 走 override 直推 ✓
        if (overrideName !== undefined) {
            chatView.post("sessionTitle", overrideName);
            return;
        }
        // ★ 否则直接走统一探针（它会一并把模型 / 供应商 / 思考等级也推了 ✓）
        await pushPiState();
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

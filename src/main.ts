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
import { getAgentDir, getPackageDir, VERSION } from "@earendil-works/pi-coding-agent";
import { PiClient } from "./pi/client.js";
import { DebugPanel } from "./view/debug-panel.js";
import { ChatView } from "./view/chat-view.js";
import { InteractionPanel } from "./view/interaction-panel.js";
import { toRpcCommand, type FrontendMessage } from "./bridge/format-frontend.js";
import {
    readSettings,
    patchSettings,
    resolveSessionRoot,
    settingsPath,
} from "./pi/settings.js";
import { listAuth, removeAuth, setApiKey } from "./pi/auth.js";
import { checkPiVersion } from "./pi/version-check.js";
import { SETTINGS_GROUPS, getByPath, setByPath } from "./pi/settings-schema.js";
import { toChatPatch } from "./bridge/format-backend.js";
import { messagesToPatches, type ReplayMessage } from "./bridge/replay.js";
import { SessionStore, deleteSessionFile, sessionDirForCwd, validateSessionFile } from "./pi/session-store.js";
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

        // ★★ 函数【出口】不参与侧效应 ✗ —— 调试板必须【无遗漏】
        //   无论这个包后面怎么处理，它都得先进调试板 ✓
        //   （B25 踩到：我把分流写在 log 之前 ✗ → 需要回复的 4 个请求
        //     【调试板完全看不到】✓ 导出数据里也没有 ✓）
        debugPanel.log(event);

        // ★★ 扩展交互【回复桥】（B25）
        //
        // 【分流规则】✗
        //   需要回复的 4 个 method（select / confirm / input / editor）
        //     → ★ 不进 ChatPatch ✗ 而是【直接推给前端】✦（临时交互 ✓）
        //   其余的（notify / setStatus / setWidget / setTitle …）
        //     → ★ 继续走 toChatPatch ✗（已实现 ✓）
        //
        // 【为什么这 4 个不走 ChatPatch？】
        //   它们不是【消息】/【气泡】✗ 而是【一次问答】✓
        //   问完就没 ✓ 不该进历史 ✓（像 queueUpdate 一样 ✓）
        // ★ 运行时确实会来 ✗ 但 onEvent 的【静态类型】只声明了 session 事件 ✓
        //   （extension_ui_request 是另一个联合成员 ✓ 类型上没合并 ✓）
        //   → 用 type 字段做收窄 ✓ 不用 as any 敷衍整个对象 ✓
        if ((event as { type?: string }).type === "extension_ui_request") {
            const ev = event as {
                id?: string;
                method?: string;
                title?: string;
                message?: string;
                options?: string[];
                placeholder?: string;
                prefill?: string;
                timeout?: number;
            };
            const needReply = ["select", "confirm", "input", "editor"];
            if (ev.method && needReply.includes(ev.method) && ev.id) {
                logInfo(`扩展交互请求：${ev.method} ← ${ev.title ?? ""}`);
                // ★★ B26：问答【搬到编辑器面板】✗（侧栏天然逼仄 ✓ 面板宽得多 ✓）
                interactionPanel.push({
                    id: ev.id,
                    method: ev.method as "select" | "confirm" | "input" | "editor",
                    title: ev.title ?? "",
                    message: ev.message,
                    options: ev.options,
                    placeholder: ev.placeholder,
                    prefill: ev.prefill,
                    timeout: ev.timeout,
                });
                pushHint(); // ★ 侧栏只留一条临时提示（带 [前往][取消] ✓）
                return; // ★ 不再往下走（它没有被 toChatPatch 处理 ✓）
            }
        }
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

    // ★★ 交互面板（B26）：pi 扩展提问 → 【独立编辑器页面】✗
    //   为什么放 chatView 之前？→ 它们只通过闭包互相引用 ✓ 顺序无所谓 ✓
    //   （onEvent 里的 uiRequest 分流会用它 ✓ 那时它已赋值 ✓）
    const interactionPanel = new InteractionPanel(
        context.extensionUri,
        (id, res) => handleUiResponse(id, res, "panel"),
        () => pushHint(),
        () =>
            vscode.workspace
                .getConfiguration("pi-bridge")
                .get<boolean>("interaction.autoClose", true),
        // ★ 关闭延迟（毫秒 ✗ 0 = 立刻关 ✓ 默认 600 ✓）
        //   用来【吸收串行连问】的下一个请求 ✗（否则面板会闪 N 次 ✓）
        () =>
            vscode.workspace
                .getConfiguration("pi-bridge")
                .get<number>("interaction.closeDelay", 600),
        () => chatView.focusInput(),
    );

    /** ★ 侧栏提示条内容（B26）：只报告“有没有待答 + 当前问题标题” ✓ */
    const pushHint = (): void => {
        const cur = interactionPanel.current();
        chatView.post("interactionHint", {
            active: !!cur,
            id: cur?.id,
            title: cur?.title ?? "",
        });
    };

    /**
     * ★ 扩展交互回复的【唯一出口】（B26）
     *   来源可能是编辑器面板 ✗ 也可能是侧栏的[取消]按钮 ✓
     *   不管哪种都：写 stdin → 从面板队列移除 → 刷新侧栏提示 ✓
     */
    const handleUiResponse = (
        id: string,
        r: { value?: string; confirmed?: boolean; cancelled?: boolean },
        from: "panel" | "sidebar",
    ): void => {
        const res: { id: string; value?: string; confirmed?: boolean; cancelled?: boolean } = { id };
        if (r.cancelled) {
            res.cancelled = true;
        } else if (typeof r.confirmed === "boolean") {
            res.confirmed = r.confirmed;
        } else {
            res.value = r.value ?? "";
        }
        logInfo(`回诉扩展交互（${from}）：${id.slice(0, 8)} → ${JSON.stringify(res)}`);
        // ★ 为什么不走 send()？→ pi 对 extension_ui_response 【不发回执】✗
        //   走 send() 会挂到 30s 超时 ✓ 还会报一个无意义的错 ✓
        pi.replyExtensionUi({ type: "extension_ui_response", ...res } as never);
        // ★ 面板侧同步移除（侧栏取消时，面板也得把那个问题拿掉 ✓）
        interactionPanel.resolved(id);
    };

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

            // ★★ 扩展交互回复（B25）：把用户的选择回给 pi ✓
            //
            // 【为什么要单独一条路径？】
            //   pi 对 extension_ui_response 【不发回执】✗
            //   → 走 send() 会挂到 30s 超时 ✓ 还会报一个无意义的错 ✓
            //   → 用 replyExtensionUi（直接写 stdin ✓）
            if (msg.kind === "uiResponse") {
                // ★ B26：答复来源可能是【编辑器面板】✗ 也可能是【侧栏的[取消]】✓
                //   不管哪种，都走同一个出口 ✓
                handleUiResponse(
                    msg.id,
                    { value: msg.value, confirmed: msg.confirmed, cancelled: msg.cancelled },
                    "sidebar",
                );
                return;
            }

            // ★ B27：拉取命令列表（斜杠补全用 ✓）
            //
            // 【数据源】pi 的 RPC `get_commands` ✗ 返回：
            //   { name, description?, source: "extension"|"prompt"|"skill", sourceInfo }
            //   ★ 不包括内置 TUI 命令（/settings /hotkeys 之类 ✗ 它们在 RPC 下不执行 ✓）
            if (msg.kind === "listCommands") {
                try {
                    const r = (await pi.sendRaw({ type: "get_commands" })) as {
                        success?: boolean;
                        data?: { commands?: unknown[] };
                        error?: string;
                    };
                    if (r.success && Array.isArray(r.data?.commands)) {
                        logInfo(`命令列表：${r.data.commands.length} 个`);
                        chatView.post("commands", { commands: r.data.commands });
                    } else {
                        logWarn(`拉命令列表失败：${r.error ?? "未知"}`);
                    }
                } catch (err) {
                    logError(`拉命令列表异常：${toErrorMessage(err)}`);
                }
                return;
            }

            // ★ B26：侧栏[前往] → 把编辑器面板弹到前面 ✓
            if (msg.kind === "interactionFocus") {
                interactionPanel.show();
                return;
            }

            // ★ 技能面板（B25）：扫描技能 → 推给前端 ✓
            if (msg.kind === "openSkills") {
                try {
                    chatView.post("skills", readSkills());
                } catch (err) {
                    logError(`扫技能失败: ${toErrorMessage(err)}`);
                }
                return;
            }

            // ★ 看某个技能的详情（B25）：读 SKILL.md 正文 → 推给前端 ✓
            if (msg.kind === "skillDetail") {
                const all = readSkills().skills;
                const hit = all.find((x) => x.name === msg.name);
                if (!hit?.path) {
                    logWarn(`技能详情：找不到 ${msg.name}`);
                    return;
                }
                try {
                    const text = fs.readFileSync(hit.path, "utf8");
                    chatView.post("skillDetail", {
                        name: hit.name,
                        source: hit.source,
                        path: hit.path,
                        content: text,
                    });
                } catch (err) {
                    logError(`读技能内容失败: ${toErrorMessage(err)}`);
                }
                return;
            }

            // ★ 技能 → 填入输入框（B25）：推给前端让它自己塞 ✓
            //   （为什么不直接改 textarea？→ 那是 webview 的 DOM ✗ 宿主碰不到 ✓）
            if (msg.kind === "skillToInput") {
                chatView.post("insertToInput", { text: msg.content });
                return;
            }

            // ★ 技能 → 作为命令发送（B25）：发 `skill:<name>` ✓
            //   ★ pi 原生支持 skill 命令 ✗（我们之前 get_commands 看到过 ✓）
            //   → 走正常 prompt 通道即可 ✓（busy 时会自动转 steer ✓）
            if (msg.kind === "skillAsCommand") {
                const text = `skill:${msg.name}`;
                logInfo(`技能作为命令发送：${text}`);
                chatView.post("sendText", { text });
                return;
            }

            // ★ 供应商凭据（B24）：增加 api key / 删除凭据 ✓
            //
            // 【为什么走这里而不是 settings 保存？】
            //   它们写的是【另一个文件】auth.json ✗（不是 settings.json ✓）
            //   → 单独的消息 ✓ 不混进 saveSettings 的批量提交流 ✓
            if (msg.kind === "addApiKey") {
                try {
                    setApiKey(msg.provider, msg.key);
                    postSettings(); // ★ 回读重绘 ✓
                    void vscode.window.showInformationMessage(
                        `已保存 ${msg.provider} 的 API key ✓` +
                            "（如果 pi 已在运行，需要重启 pi 才生效 ✗）",
                    );
                } catch (err) {
                    logError(`保存 API key 失败: ${toErrorMessage(err)}`);
                    void vscode.window.showErrorMessage(`保存失败：${toErrorMessage(err)}`);
                }
                return;
            }
            if (msg.kind === "removeAuth") {
                try {
                    // ★ 二次确认（不可逆 ✗）
                    const pick = await vscode.window.showWarningMessage(
                        `确定删除「${msg.provider}」的凭据？（= 登出 ✗）`,
                        { modal: true, detail: "删掉后 pi 就不能再用这个供应商了 ✓" },
                        "删除",
                    );
                    if (pick !== "删除") return;
                    removeAuth(msg.provider);
                    postSettings();
                    void vscode.window.showInformationMessage(`已删除 ${msg.provider} 的凭据 ✓`);
                } catch (err) {
                    logError(`删除凭据失败: ${toErrorMessage(err)}`);
                    void vscode.window.showErrorMessage(`删除失败：${toErrorMessage(err)}`);
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
                        // ★★ defaultModel 是【合成字段】✗（界面上的值是 "provider/id" ✓）
                        //   要拆回 pi 认的【两个】字段 ✓（B24 合并决定 ✓）
                        //
                        // 【之前这段没生效的教训】✗
                        //   我用 python 的 str.replace 改的 ✗ 没匹配上也不报错 ✓
                        //   → 看起来“改完了”✗ 实际没改 ✓ 结果保存时把 "mock/mock"
                        //     直接写进了 defaultModel ✓ 而 defaultProvider 没动 ✓
                        //     → 文件里成了 provider=ollama + model=mock/mock（错配 ✗）
                        //     → 前端拼出 "ollama/mock/mock" → 下拉里没这个选项 → 显示空 ✓
                        //   ★ 教训：改代码用 edit 工具 ✗（不匹配会报错 ✓）
                        //
                        // 【拆法】不能用 split("/") ✗ —— 模型 id 自己可能带 / ✓
                        //   （如 openrouter 的 moonshotai/kimi-k2.6 ✓）
                        //   → 从【模型目录里反查】哪个条目完全匹配 ✓
                        if (k === "defaultModel" && typeof v === "string" && v) {
                            const hit = readModelCatalog().find(
                                (m) => `${m.provider}/${m.id}` === v,
                            );
                            if (hit) {
                                patch.defaultProvider = hit.provider;
                                patch.defaultModel = hit.id;
                            } else if (!v.includes("/")) {
                                // 只给了 id（无 provider）→ 只写模型 ✓
                                patch.defaultModel = v;
                            } else {
                                logWarn(`默认模型：目录里找不到 "${v}" ✗ 本次不写入 ✓`);
                            }
                            continue;
                        }
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

    // ★ 版本检测（B24）：异步跑 ✗ 不阻塞激活 ✓
    //   （每次激活都查 ✓ 只有真的有新版才提示 ✓ 失败静默 ✓）
    void runVersionCheck();
    // ★ 更新日志检测（B24）：本地比较版本号 ✓ 不联网 ✓
    void checkChangelog();
    context.subscriptions.push(
        // 侧边栏聊天视图
        vscode.window.registerWebviewViewProvider(ChatView.viewId, chatView),

        // ctrl+alt+d / 命令面板 → 打开调试板
        vscode.commands.registerCommand("pi-bridge.showDebug", () => {
            debugPanel.show();
        }),

        // ★ 命令面板 → 打开交互面板（B26 ✓ 没有待答请求时是空操作 ✓）
        vscode.commands.registerCommand("pi-bridge.showInteraction", () => {
            interactionPanel.show();
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

        // ★ 手动打开更新日志（B24）—— 随时都能看 ✗
        //   为什么需要它？
        //     · 自动提示只在【版本变化时】弹一次 ✓
        //     · 想看历史变更 / 想验证功能时，需要一个入口 ✓
        //     · 下测试也方便 ✓（不用真的等升级 ✓）
        vscode.commands.registerCommand("pi-bridge.showChangelog", () => {
            void openChangelog();
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

    /**
     * ★ 版本检测（B24）—— 启动时异步跑一次 ✓
     *
     * 【用户定的 ✓】
     *   “自动检测，检测到有差异就提醒更新了，并且告知差异，
     *     发个通知就好”✓
     *
     * 【几个约束 ✗】
     *   · 必须【异步、不阻塞激活】✗（要网络 ✓ 可能几秒 ✓）
     *   · 失败要【静默】✗（离线 / 代理挂了是常态 ✓）
     *   · 一天最多查一次 ✗（缓存到 globalState ✓ 别每次启动都打网络 ✓）
     */
    async function runVersionCheck(): Promise<void> {
        // ★★ 每次都查 ✗（B24 用户要求 ✓）
        //   用户原话：“通知频率你是二十四小时最多一次，我希望每次都有，
        //             反正它可以每次清理”✓
        //   ★ 两点保证它不会变成“刷屏”✗：
        //     ① 只有【真的有新版】才发 ✓（已是最新就什么都不做 ✓）
        //     ② npm 自己【有缓存】✗（npm view 第二次很快 ✓）
        //   而重复的通知在通知板里可以一键清空 ✓
        const r = await checkPiVersion("@earendil-works/pi-coding-agent", VERSION);
        if (!r.latest) return; // 查不到（离线 / 代理挂了 ✓）→ 静默 ✓
        if (!r.hasUpdate) return;

        logInfo(`★ pi 有新版本：${r.current} → ${r.latest}`);

        // ★★ 两个都发 ✗（B24 用户要求 ✓）
        //   ① 我们自己的通知板（chatState → 前端 ✓）
        //      ★ 为什么通知板也要？
        //        VS Code 原生通知【会消失】✗ 而且不归我们管 ✓
        //        版信息是“需要记住、过会再处理”的东西 ✓ → 通知板更合适 ✓
        //   ② VS Code 原生通知（带按钮，能立刻操作 ✓）
        chatState.apply({
            kind: "notice",
            text: `pi 有新版本：${r.current} → ${r.latest}（终端跑 pi update ✓）`,
            level: "info",
        } as never);

        const pick = await vscode.window.showInformationMessage(
            `pi 有新版本：${r.current} → ${r.latest}`,
            "看更新命令",
            "忽略",
        );
        if (pick === "看更新命令") {
            void vscode.window.showInformationMessage(
                "在终端运行：pi update（或 pi update self / pi update pi ✓）",
                { modal: true, detail: "pi 自己的升级命令会处理全局安装与模型目录刷新 ✓" },
            );
        }
    }

    /**
     * ★ 更新日志检测（B24）
     *
     * 【怎么做？】（用户定的 ✓）
     *   “我们不是有个数据文件嘛，维护一下版本号。
     *    进来的时候发现不一样，然后就去找日志，发个通知，点一下就渲染”✓
     *
     * 【★★ 用我们自己的 key ✗】
     *   pi 的 settings.lastChangelogVersion 会被【 TUI 【自己【改 ✗
     *   （用户在 TUI 里能看更新日志 ✓ 它就会写那个字段 ✓）
     *   → 我们用 pi-bridge.changelog.lastSeen ✓ 互不干扰 ✓
     *
     * 【★★★ 初始值照拄 pi 的 ✓】（用户：“初始值照拄过来”✓）
     *   → 首次运行【不会误报 ✓】（两边都是 0.85.1 ✓）
     */
    async function checkChangelog(): Promise<void> {
        const KEY = "pi-bridge.changelog.lastSeen";
        let last = context.globalState.get<string>(KEY);

        if (!last) {
            // ★ 首次：照拄 pi 已有的值 ✗（它可能是 TUI 写过的 ✓）
            const piLast = readSettings().lastChangelogVersion;
            last = typeof piLast === "string" && piLast ? piLast : "0.0.0";
            await context.globalState.update(KEY, last);
            logInfo(`更新日志：初始化 lastSeen = ${last}（照拄 pi 的值 ✓）`);
        }

        if (last === VERSION) {
            logDebug(`更新日志：版本未变（${VERSION}）✓`);
            return;
        }

        logInfo(`★ 检测到 pi 版本变化：${last} → ${VERSION}（有新更新日志 ✓）`);
        const msg = `pi 已更新：${last} → ${VERSION}（有更新日志 ✓）`;

        // ★ 两个都发（同版本检测那里 ✓）
        chatState.apply({ kind: "notice", text: msg, level: "info" } as never);

        const pick = await vscode.window.showInformationMessage(msg, "查看更新日志", "忽略");
        if (pick === "查看更新日志") void openChangelog();

        // ★ 记下看过（下次不再提示 ✓）
        //   ★ 放在最后 ✗ —— 先提醒再改，不然用户连看都没看过就再也不提了 ✓
        await context.globalState.update(KEY, VERSION);
    }

    /**
     * ★ 打开更新日志（B24）
     *
     * 【为什么直接开 MD 而不自己渲染？】（用户定的 ✓）
     *   “MD 好像没必要解析嘛，MD 直接打到 VS Code 里，Ctrl V 不就渲染了？”✓
     *   → 用 markdown.showPreview ✗（VS Code 自己渲染 ✓ 比我们写得好 ✓）
     */
    async function openChangelog(): Promise<void> {
        try {
            const p = path.join(getPackageDir(), "CHANGELOG.md");
            if (!existsSync(p)) {
                void vscode.window.showWarningMessage(`找不到更新日志：${p}`);
                return;
            }
            const doc = await vscode.workspace.openTextDocument(p);
            // ★ 直接开【预览】✗（不是源码视图 ✓）
            await vscode.commands.executeCommand("markdown.showPreview", doc.uri);
        } catch (err) {
            logError(`打开更新日志失败: ${toErrorMessage(err)}`);
            void vscode.window.showErrorMessage(`打开更新日志失败：${toErrorMessage(err)}`);
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
                if (f.key === "defaultModel") {
                    // ★ 选项与值【都用 `provider/id`】✗（B24 合并决定 ✓）
                    //   为什么值也用全名？→ 保存时能拆成两个字段 ✓
                    //   （另外：只有 id 的话，同名模型在不同供应商下会歧义 ✓）
                    options = sortCatalog(catalog).map((m) => ({
                        value: `${m.provider}/${m.id}`,
                        label: `${m.provider}/${m.id}`,
                    }));
                } else if (f.kind === "extlist") {                    // ★ 已装扩展：选项 = 全部已装 ✓ 值 = 当前启用的 ✓
                    //   前端用复选框列表渲染 ✓
                    options = readInstalledExtensions().map((x) => ({
                        value: x.source,
                        label: x.source + (x.enabled ? "" : "（已停用）"),
                    }));
                } else if (f.key === "enabledModels") {
                    // ★ 列表控件也用它：下拉“选一个添加”✗ 不用手敲 ✓
                    //   ★ 同样的排序 ✓（用户看下拉时体验一致 ✓）
                    options = sortCatalog(catalog).map((m) => ({
                        value: `${m.provider}/${m.id}`,
                        label: `${m.provider}/${m.id}`,
                    }));
                }
                // ★ defaultModel 要【合成】provider/id 显示 ✗（B24 合并 ✓）
                //   因为文件里是分开存的（provider + model 两个字段 ✓）
                let value = getByPath(all, f.key) ?? f.fallback ?? defaultForKind(f.kind);
                if (f.key === "defaultModel") {
                    const prov = typeof all.defaultProvider === "string" ? all.defaultProvider : "";
                    const id = typeof all.defaultModel === "string" ? all.defaultModel : "";
                    value = id ? (prov ? `${prov}/${id}` : id) : "";
                }
                // ★ 供应商凭据（B24）：值直接给【凭据列表】✗（不是 settings 字段 ✓）
                //   ★ 注意：listAuth 已经做过【脱敏】✗ 不含原始 key ✓
                if (f.kind === "providers") {
                    return {
                        key: f.key,
                        label: f.label,
                        desc: f.desc,
                        kind: f.kind,
                        value: listAuth(),
                        exists: true,
                    };
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
                    value,
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
     * ★ 扫描技能（B25）
     *
     * 【技能【来自【两个地方】✗（实测确认 ✓）
     *   ① 用户自己的：<agentDir>/skills/<name>/SKILL.md ✓
     *   ② 扩展包提供的：包的 package.json 里 `pi.skills: ["./skills"]` ✓
     *      （例：@mammothb/pi-mermaid → mermaid 技能 ✓）
     *
     * 【怎么读描述？】
     *   SKILL.md 开头有 YAML frontmatter ✓：
     *     ---
     *     name: debugging
     *     description: 诊断反常现象…
     *     ---
     *   ★ 只读前 30 行 ✗（避开大文件 ✓ 而且 frontmatter 必定在开头 ✓）
     */
    function readSkills(): {
        dir: string;
        skills: { name: string; description?: string; source?: string; path?: string }[];
    } {
        const out: { name: string; description?: string; source?: string; path?: string }[] = [];

        /** 从一个 SKILL.md 提取 name/description ✓ */
        const parse = (file: string): { name?: string; description?: string } => {
            try {
                const head = fs.readFileSync(file, "utf8").split("\n").slice(0, 30).join("\n");
                const m = /^---\s*\n([\s\S]*?)\n---/.exec(head);
                if (!m) return {};
                const body = m[1];
                const name = /^name:\s*(.+)$/m.exec(body)?.[1]?.trim();
                // ★ description 可能很长 / 含中文 ✓ 直接取到行尾 ✓
                const description = /^description:\s*(.+)$/m.exec(body)?.[1]?.trim();
                return { name, description };
            } catch {
                return {};
            }
        };

        /** 扫一个 skills 目录（里面是 <name>/SKILL.md ✓）*/
        const scanDir = (dir: string, source: string) => {
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const e of entries) {
                if (!e.isDirectory()) continue;
                const file = path.join(dir, e.name, "SKILL.md");
                if (!existsSync(file)) continue;
                const meta = parse(file);
                out.push({
                    name: meta.name ?? e.name,
                    description: meta.description,
                    source,
                    path: file,
                });
            }
        };

        // ① 用户自己的技能 ✓
        const userDir = path.join(getAgentDir(), "skills");
        scanDir(userDir, "用户技能");

        // ② 扩展包提供的技能 ✓
        const nm = path.join(getAgentDir(), "npm", "node_modules");
        const scanExt = (dir: string) => {
            try {
                const pj = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as {
                    name?: string;
                    pi?: { skills?: string[] };
                };
                for (const rel of pj.pi?.skills ?? []) {
                    scanDir(path.join(dir, rel), pj.name ?? "扩展");
                }
            } catch {
                /* ignore */
            }
        };
        try {
            for (const e of fs.readdirSync(nm, { withFileTypes: true })) {
                if (!e.isDirectory()) continue;
                if (e.name.startsWith("@")) {
                    const sd = path.join(nm, e.name);
                    for (const s of fs.readdirSync(sd, { withFileTypes: true })) {
                        if (s.isDirectory()) scanExt(path.join(sd, s.name));
                    }
                } else if (!e.name.startsWith(".")) {
                    scanExt(path.join(nm, e.name));
                }
            }
        } catch (err) {
            logDebug(`扫扩展技能失败: ${toErrorMessage(err)}`);
        }

        out.sort((a, b) => a.name.localeCompare(b.name));
        logInfo(`技能：${out.length} 个（` + out.map((s) => s.name).join(", ") + `）`);
        return { dir: userDir, skills: out };
    }

    /**
     * ★ 模型目录的【展示排序】✗（B24 用户要求 ✓）
     *
     * 用户原话：
     *   “按供应商排序，然后供应商相同的放到一起，
     *    然后供应商之间怎么排的？按数量排，少的放前面，多的放后面。”✓
     *
     * 例（按你现在装的）：
     *   mock(1) → deepseek(2) → ollama(5) → github-copilot(34) ✓
     *
     * 为什么这样舒服？
     *   · 少的在前面 → 常用的小供应商【不用滑到底】✗
     *   · 同供应商连在一起 → 一眼能看出“这是谁家的模型”✓
     *   · GitHub 那种 34 个的沉到最底 ✓ 不挡路 ✓
     *
     * ★ 相同数量时按供应商名排 ✗（保证顺序稳定 ✓ 不随扫目录顺序变 ✓）
     */
    function sortCatalog(
        list: { provider: string; id: string; name?: string }[],
    ): { provider: string; id: string; name?: string }[] {
        const byProv = new Map<string, { provider: string; id: string; name?: string }[]>();
        for (const m of list) {
            const arr = byProv.get(m.provider) ?? [];
            arr.push(m);
            byProv.set(m.provider, arr);
        }
        return [...byProv.entries()]
            .sort((a, b) => a[1].length - b[1].length || a[0].localeCompare(b[0]))
            .flatMap(([, arr]) => arr.sort((x, y) => x.id.localeCompare(y.id)));
    }

    /**
     * ★ 拉一次模型目录（磁盘上的 ✓）
     *
     * 【谁在用？】
     *   · 设置面板的下拉（默认模型 / 启用列表 ✓）
     *   · ★ 模型切换菜单（输入区那个 ✓）
     *
     * 【为什么不问 pi（get_available_models）？】
     *   那是 pi 的命令 → 会【惰启动 pi】✗
     *   而点一个下拉框不该把 pi 拉起来 ✓
     *   → 读磁盘上的目录 ✓ 两个文件合并后结果一样 ✓
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
     * ★ 启用模型列表（B24）
     *
     * ★★ 数据源 = pi 的 `settings.json` 的 `enabledModels` ✗
     *   （B24 实测：pi 本来就有这个字段 ✓ 我们自己造的 globalState 是多余的 ✓）
     *   用户原话：“你点击模型应该是启用列表，而不是所有列表啊
     *             要不然那个列表还有啥用啊？那个列表还是我们自己维护的”✓
     *
     * 【格式】`provider/id` ✓
     * 【空数组】= 不限制 ✓ 用全部可用模型 ✓
     */
    function getEnabledModels(): string[] {
        const v = readSettings().enabledModels;
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    }

    /**
     * ★ 把【模型切换菜单】的候选推给前端（带 current 标记 ✓）
     *
     * ★★ 范围 = 【启用列表】✗（= settings.json 的 enabledModels ✓）
     *   用户原话：“你点击模型应该是启用列表，而不是所有列表啊，
     *              要不然那个列表还有啥用啊？”✓
     *
     * ★ 为什么不用 get_available_models？✗
     *   那是 pi 的命令 → 会【惰启动 pi】✗
     *   而点一个下拉框不该把 pi 拉起来 ✓
     *   → 用磁盘上的目录（models.json + models-store.json ✓ 结果一样 ✓）
     */
    async function postModelList(): Promise<void> {
        try {
            const all = readModelCatalog();
            const enabled = getEnabledModels();
            // ★ 当前模型（用来高亮 ✓）—— 只有 pi 已启动才问得到 ✗
            let curKey = "";
            if (pi.isStarted()) {
                const st = (await pi.sendRaw({ type: "get_state" })) as {
                    data?: { model?: { id?: string; provider?: string } };
                };
                const m = st?.data?.model;
                if (m?.id && m.provider) curKey = `${m.provider}/${m.id}`;
            }

            let list = all;
            if (enabled.length) {
                list = all.filter((m) => enabled.includes(`${m.provider}/${m.id}`));
                // ★ 当前模型若【不在启用列表里】也补上 ✗
                //   （比如你刚把默认模型切到别处 ✓ 否则菜单里看不到自己在用哪个 ✓）
                if (curKey && !list.some((m) => `${m.provider}/${m.id}` === curKey)) {
                    const cur = all.find((m) => `${m.provider}/${m.id}` === curKey);
                    if (cur) list = [cur, ...list];
                }
            }
            const out = sortCatalog(list).map((m) => ({
                provider: m.provider,
                id: m.id,
                name: m.name,
                current: `${m.provider}/${m.id}` === curKey,
            }));
            logInfo(
                `模型切换菜单：${out.length} 个` +
                    `（启用列表 ${enabled.length ? `${enabled.length} 项` : "空 → 全部"}）`,
            );
            chatView.post("modelList", out);
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

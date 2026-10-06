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
import { createVirtualDocProvider } from "./view/virtual-docs.js";
import * as vscode from "vscode";
import os from "node:os";
import path from "node:path";
import fs, { existsSync } from "node:fs";
import { initLogger, logInfo, logError, logDebug, logWarn } from "./logger.js";
import { getPackageDir, VERSION } from "@earendil-works/pi-coding-agent";
import { PiClient } from "./pi/client.js";
import { DebugPanel } from "./view/debug-panel.js";
// ★★ B38：命令主体提取（宿主侧用 bash-parser 出 AST ✗ 不占前端包）
import { extractCommands } from "./panels/cmd-summary.js";
import { ChatView } from "./view/chat-view.js";
import { SessionPanel } from "./view/session-panel.js";
import { SettingsPanel } from "./view/settings-panel.js";
import { InteractionPanel, type UiReq } from "./view/interaction-panel.js";
import { SkillsPanel } from "./view/skills-panel.js";
// ★★ B32：自由按钮的配置页面（编辑器区独立面板 ✓）
import { CommandPanel } from "./view/command-panel.js";
import { toRpcCommand, type FrontendMessage } from "./bridge/format-frontend.js";
import { readSettings, resolveSessionRoot } from "./pi/settings.js";
import { checkPiVersion } from "./pi/version-check.js";
import { toChatPatch } from "./bridge/format-backend.js";
import { messagesToPatches, type ReplayMessage } from "./bridge/replay.js";
import { SessionStore } from "./pi/session-store.js";
import { ChatState } from "./view/chat-state.js";
import { toErrorMessage } from "./utils.js";
import { compactHome, expandHome } from "./util/paths.js";
import { getEnabledModels, readModelCatalog, sortCatalog } from "./panels/model-catalog.js";
import { readInstalledExtensions } from "./panels/extensions-scan.js";
// ★★ B32：自由按钮容器的数据层
import {
    readCommands,
    writeCommands,
    normalizeItem,
    buildCommandLine,
    needsInput,
    isImageIcon,
    isManagedIcon,
    newId,
    findCommand,
    removeCommand,
    collectIcons,
    moveCommand,
    type CmdItem,
} from "./panels/command-store.js";
import { createSettingsPoster } from "./panels/settings-post.js";
// ★★ B36：面板的消息路由 + 动作（从 main.ts 搬出 ✓）
import { createCommandHost } from "./panels/command-host.js";
import { createSessionActions } from "./panels/session-actions.js";
import { createSessionHost } from "./panels/session-host.js";
import { createSettingsActions } from "./panels/settings-actions.js";
import { createSettingsHost } from "./panels/settings-host.js";
import { createSkillsActions } from "./panels/skills-actions.js";
import { createSkillsHost } from "./panels/skills-host.js";
import { readPiDefaults, shortIdOf } from "./panels/misc-utils.js";

export function activate(context: vscode.ExtensionContext): void {
    // 0. 日志（LogOutputChannel：VS Code 自动落盘 + 分级 + 轮转）
    // ★★ B41：虚拟文档（"送去编辑器"用 —— 不落盘的内容也能在编辑器里显示/做 diff）
    context.subscriptions.push(createVirtualDocProvider());
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

        // ★★ B38：bash 一开跑 → 解析出主体命令 ✗ 推给前端填摘要行
        //   （宿主侧做：解析器不进前端包 ✓ 失败也不影响渲染 ✓）
        if (event.type === "tool_execution_start") {
            const ev = event as {
                toolName?: string;
                toolCallId?: string;
                args?: { command?: unknown };
            };
            if (ev.toolName === "bash" && ev.toolCallId && typeof ev.args?.command === "string") {
                void extractCommands(ev.args.command).then((commands) => {
                    logInfo(`★ bash 命令主体：${JSON.stringify(commands)}（callId=${ev.toolCallId}）`);
                    if (commands.length) chatView.post("cmdSummary", { callId: ev.toolCallId, commands });
                });
            }
        }

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
        // ★★ B37：pi 侧的【非协议】消息（pi_stdout_raw / pi_exit / pi_spawn_error ✓）
        //   ★ 它们【只给调试板看】✗ 没有任何对应的 UI ✓
        //     （用户定的：调试板是“防漏表”✗ 但“看见”不等于“要渲染”✓）
        //   ★ 注意位置：必须在 debugPanel.log(event) 【之后】✗
        //     否则调试板就看不到它们了 ✓（B25 踩过同样的坑 ✓）
        if (
            event.type === "pi_stdout_raw" ||
            event.type === "pi_exit" ||
            event.type === "pi_spawn_error"
        ) {
            return;
        }

        // ★ 上面已经拦掉了 pi_* ✗ 但 TS 窄化不了（JsonAgentSessionEvent 的
        //   type 是 string ✗ 不是字面量联合 ⇒ 判别式窄化失效 ✓）→ 断言一下 ✓
        const patch = toChatPatch(event as never);
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

    /**
     * ★★ 技能面板（B31）：从侧栏搬到编辑器区 ✓
     *
     * 【为什么要 onMessage 回调？】
     *   面板前端只管画 ✗ 读写磁盘是宿主的活 ✓
     *   （和前端的 postMessage 通道不同 ✗ 这是 webviewPanel 自己的 ✓）
     */
    /**
     * ★★ 自由按钮的配置页面（B32 ②）
     *
     * ★ 它的消息走【自己的私有通道】✗ 不经过 chatView ✓
     *   （跟 skillsPanel 一样 ✓ 因为它们是编辑器区的独立面板 ✓）
     */
    /**
     * ★★ B36：命令配置页的【保存】动作（从那个匿名回调里抽出来的 ✓）
     *
     * 【★ 为什么抽成具名函数？】
     *   匿名回调里出异常时栈里只有 "(anonymous)" ✗ 很难查 ✓
     *   而且"路由"（哪个 kind 调什么）和"动作"（怎么存）混在一起 ✓
     *   ⇒ B36：路由归 panels/command-host.ts ✗
     *     动作留在这儿（它要用图标系统 ✗ 那是另一摊事 ✓）
     *
     * 【★ 父亲带来的两条硬约束】（B33 ✓）
     *   ① 收纳器里不能套收纳器 ✗ type 锁成 button ✓
     *   ② 父亲勾了"强制"→ 子按钮的 command 被锁死 ✓
     *   ★ 为什么配置页已经做了还要再查一遍？
     *     FACTS #5 / #12：UI 的禁用【永远不可信】✗ 逻辑层必须再查 ✓
     */
    const saveCommandDraft = async (
        item: Record<string, unknown>,
        parentId?: string,
    ): Promise<void> => {
        const items = readCommands();
        const id = typeof item.id === "string" ? item.id : "";
        const parent = parentId ? findCommand(items, parentId) : undefined;

        if (parent) {
            item.type = "button"; // ① 收纳器里不能套收纳器 ✓
            if (parent.lockCommand && parent.command) {
                item.command = parent.command; // ② 命令被锁死 ✓
            }
        }

        // ★ 用 command-store 的 normalize 走一遍（不信前端传来的形状 ✓）
        // ★ 图标先收进标准位置（B32 ✓）
        //   ★ 要带上【旧图标】✗ 才能把上一张清掉 ✓
        const oldIcon = id ? findCommand(items, id)?.icon : undefined;
        const raw = item as { icon?: string };
        if (typeof raw.icon === "string") {
            item.icon = materializeIcon(raw.icon, oldIcon) ?? "";
        }
        const clean = normalizeItem(item as never);

        if (parent) {
            // ★★ B33：塞进父亲的 children ✗（不是顶层 ✓）
            const kids = [...(parent.children ?? [])];
            const ki = id ? kids.findIndex((x) => x.id === id) : -1;
            if (ki >= 0) kids[ki] = clean;
            else kids.push(clean);
            parent.children = kids;
            await writeCommands(items);
            logInfo(`保存子按钮：${clean.label} → 收纳器「${parent.label}」`);
        } else {
            const idx = id ? items.findIndex((x) => x.id === id) : -1;
            if (idx >= 0) {
                items[idx] = clean;
                logInfo(`修改按钮：${clean.label}`);
            } else {
                items.push(clean);
                logInfo(`新增按钮：${clean.label}`);
            }
            await writeCommands(items);
        }
        pushCommands();
        commandPanel.close();
    };

    const commandPanel = new CommandPanel(
        context.extensionUri,
        createCommandHost({
            closePanel: () => commandPanel.close(),
            save: saveCommandDraft,
        }),
    );

    /**
     * ★★ B36：技能面板的【消息路由】+【动作】都搬去模块了 ✗
     *
     * 【搬去哪了】
     *   src/panels/skills-host.ts     消息 → 动作（7 个 kind ✓）
     *   src/panels/skills-actions.ts  动作的实现（读盘 / 写盘 / 弹窗 ✓）
     *
     * 【★★ 为什么必须搬】
     *   这个回调曾经是"技能面板消息的唯一入口"✓ 但它和
     *   handleFrontendMessage 的区别【只写在注释里】✗
     *   ⇒ B35 我把"动作后关面板"加错了地方 ✗ 静默失效 ✓
     *   ⇒ 现在技能面板的消息只可能在 skills-host.ts 里被接 ✓
     *     结构上不会再踩那个坑 ✓
     *
     * 【★ 顺序说明】
     *   下面 skillsActions 里用箭头【延迟取】skillsPanel / chatView ✓
     *   它们都在后面才创建 ✗ 而箭头体只在真正收到消息时才执行 ✓
     */
    const skillsActions = createSkillsActions({
        post: (kind, payload) => skillsPanel.post(kind, payload),
        postChat: (kind, payload) => chatView.post(kind, payload),
    });

    const skillsPanel = new SkillsPanel(
        context.extensionUri,
        createSkillsHost({
            actions: skillsActions,
            closePanelAfterAction: () => closeSkillsPanelAfterAction(),
        }),
    );

    /**
     * ★★ B36：技能领域的那 6 个动作函数【全搬走了】✗
     *
     * 【原来在这里】refreshSkills / pushSkillDetail / openSkillFile /
     *   deleteSkill / hideSkill / createSkill —— 共约 180 行 ✓
     * 【现在在】src/panels/skills-actions.ts ✓
     * 【为什么搬】main.ts 只该管【接线】✗
     *   不该管"怎么删一个技能 / 怎么写模板"✓
     *
     * ★ 顺带删掉的死代码：pushSkillDetail
     *   （面板前端【从不发】skillDetail ✗ 它一直没人调 ✓）
     */

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
    /**
     * ★★ 本地参数收集任务（B33 ✓）
     *
     * 【它是什么】
     *   用户点了一个“需要填参数、且选了独立窗口”的按钮 ✗
     *   我们把它的【每个参数】转成一个 UiReq 推给交互面板 ✓
     *   用户在面板里填完 ✗ 我们拼成命令行发出去 ✓
     *
     * 【★ 为什么复用交互面板？】（用户的想法 ✗ 已存档 ✓）
     *   面板已经有 select / input 控件 ✓ 而参数只需要这两种 ✓
     *   而且面板的“答卷模式”本来就是“一次填多题、一次性提交”✗
     *   跟“一次填完所有参数”是【同一个形状】✓✓✓
     *   ⇒ 差别只有一处：答复后是【回复 pi】还是【拼命令发了】✗
     *      → 用 taskId 分流就够了 ✓
     */
    interface LocalTask {
        item: CmdItem;
        /** 已收集到的值（按 field.id ✓）*/
        values: Record<string, string>;
        /** ★ 还没答的 field.id */
        need: Set<string>;
        /** ★ 这次推出去的 request id（取消时要一并清 ✓）*/
        reqIds: string[];
        /**
         * ★★ request id → field.id
         *   ★ 为什么要这个映射？
         *     请求 id 加了 task 前缀（防撞 ✗ 见 collectViaPanel ✓）
         *     而 values / need 里用的是【干净的 field.id】✓
         */
        idToField: Map<string, string>;
    }
    const localTasks = new Map<string, LocalTask>();
    /** ★ request id → taskId（答复回来时反查 ✓）*/
    const reqToTask = new Map<string, string>();

    /**
     * ★★ 参数收集：独立窗口模式（B33 ✓）
     *
     * 【与串行模式的差别】
     *   串行  → VS Code 原生 QuickPick / InputBox ✗ N 个参数弹 N 次 ✓
     *   独立  → 面板里一目了然 ✗ 可切页、可回改 ✓ 最后统一提交 ✓
     *   ★ 两者的【拼装】完全一致（都走 buildCommandLine ✓）
     */
    const collectViaPanel = (item: CmdItem): void => {
        const values: Record<string, string> = {};
        const reqs: UiReq[] = [];
        const idToField = new Map<string, string>();
        const taskId = `local-${newId()}`;

        for (const f of item.fields ?? []) {
            // ★ 固定值不问 ✗ 直接填（与串行模式一致 ✓）
            if (f.kind === "fixed") {
                values[f.id] = f.value ?? "";
                continue;
            }
            // ★★ 请求 id 加 task 前缀 ✗
            //   【为什么？】field.id 在配置里是稳定的 ✗
            //     同一按钮点两次 → 两个请求同 id ✓
            //     → 前端的 answers Map 会串（一份答案填两题 ✓）
            const rid = `${taskId}:${f.id}`;
            idToField.set(rid, f.id);
            reqs.push({
                id: rid,
                method: f.kind === "select" ? "select" : "input",
                title: f.label || "参数",
                options: f.kind === "select" ? (f.options ?? []) : undefined,
                placeholder: f.subType === "number" ? "（要数字 ✗ 可带负号/小数点）" : "",
                prefill: "",
                source: "local",
                taskId,
            });
        }

        // ★ 所有参数都是固定值 → 没什么可问的 ✗ 直接执行 ✓
        if (reqs.length === 0) {
            const line = buildCommandLine(item, values);
            logInfo(`执行按钮（全固定值 ✓）：${item.label} → ${line}`);
            chatView.post("sendText", { text: line });
            return;
        }

        localTasks.set(taskId, {
            item,
            values,
            need: new Set(idToField.values()),
            reqIds: [...idToField.keys()],
            idToField,
        });
        for (const rid of idToField.keys()) reqToTask.set(rid, taskId);
        logInfo(`参数收集（独立窗口）：${item.label} 共 ${reqs.length} 项`);
        interactionPanel.pushMany(reqs);
    };

    /**
     * ★★ 本地参数收集的答复处理（B33 ✗ 不走 pi ✓）
     *
     * ★★ 为什么不能走 pi？
     *   extension_ui_response 是【回应 pi 的提问】✗
     *   而我们这是【我们自己的表单】✗ 两者只是形状像 ✓
     *   → 所以要在 handleUiResponse 最前面分流 ✓
     */
    const handleLocalAnswer = (
        taskId: string,
        id: string,
        r: { value?: string; confirmed?: boolean; cancelled?: boolean },
    ): void => {
        const task = localTasks.get(taskId);

        // ★ 取消 = 整条命令不发 ✗ 并撒掉该任务剩余的请求 ✓
        if (r.cancelled) {
            localTasks.delete(taskId);
            if (task) for (const rid of task.reqIds) reqToTask.delete(rid);
            interactionPanel.dropTask(taskId);
            logInfo(`参数收集取消：${task?.item.label ?? taskId}`);
            return;
        }

        if (!task) {
            reqToTask.delete(id); // 任务已作废 ✗ 忽略这条迟到答复 ✓
            interactionPanel.resolved(id);
            return;
        }

        const fieldId = task.idToField.get(id);
        if (!fieldId) {
            interactionPanel.resolved(id); // 对不上任何参数 ✗ 忽略 ✓
            return;
        }

        task.values[fieldId] = (r.value ?? "").trim();
        task.need.delete(fieldId);
        interactionPanel.resolved(id);
        if (task.need.size > 0) return; // ★ 还没填完 ✓

        // ★★ 齐了 → 拼装并发送 ✓
        localTasks.delete(taskId);
        for (const rid of task.reqIds) reqToTask.delete(rid);
        const line = buildCommandLine(task.item, task.values);
        logInfo(`执行按钮（独立窗口）：${task.item.label} → ${line}`);
        chatView.post("sendText", { text: line });
    };

    const handleUiResponse = (
        id: string,
        r: { value?: string; confirmed?: boolean; cancelled?: boolean },
        from: "panel" | "sidebar",
    ): void => {
        // ★★ B33：先分流 ✗ 本地参数收集的答复不归 pi ✓
        const taskId = reqToTask.get(id);
        if (taskId) {
            handleLocalAnswer(taskId, id, r);
            return;
        }

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
    /**
     * ★★ 前端消息的【统一入口】（B35 抽出来的 ✗）
     *
     * 【为什么抽出来？】
     *   现在有【两个来源】会发同类消息：
     *     ① 侧栏聊天页（chatView ✓）
     *     ② ★ 会话面板（sessionPanel ✗ B35 从侧栏搬走的 ✓）
     *   ⇒ 抽成具名函数 ✗ 两边共用一套分支逻辑 ✓
     *     （原来它只是 ChatView 构造函数里的一个匿名参数 ✓）
     *
     * 【★ 关于顺序】
     *   函数体里会用到 chatView ✗ 而它在下面才建 ✓
     *   但这里是【闭包】✗ 调用时才解析 ✓（只有 webview 发消息才会跑 ✓）
     *   与 interactionPanel 同一情况 ✓ 安全 ✓
     */
    const handleFrontendMessage = async (msg: FrontendMessage): Promise<void> => {
            // ★★ B32：自由按钮容器的三个动作
            //
            // 【★ 为什么放在最前面？】
            //   它们完全属于【我们扩展自己的界面】✗ 跟 pi 无关 ✓
            //   早拦早走 ✗ 也不会浪费后面那大堆 pi 相关的分支判断 ✓
            if (msg.kind === "commandNew") {
                // ★★ B33：可能是【在收纳器里新建】（带 parentId ✓）
                //   ★ 为什么要告诉配置页“父亲是谁”？
                //     ① type 要锁死成 button（不能再套收纳 ✓）
                //     ② 父亲勾了“强制”✗ 子按钮的 command 要锁死 ✓
                const parentId = typeof msg.parentId === "string" ? msg.parentId : undefined;
                const parent = parentId ? findCommand(readCommands(), parentId) : undefined;
                commandPanel.open(
                    parent
                        ? {
                              parent: {
                                  id: parent.id,
                                  label: parent.label,
                                  command: parent.command,
                                  lockCommand: parent.lockCommand === true,
                              },
                          }
                        : {},
                    true,
                );
                return;
            }
            if (msg.kind === "commandEdit") {
                // ★★ B33：递归搜（子按钮也要能编辑 ✓）
                const item = findCommand(readCommands(), msg.id);
                if (!item) {
                    logWarn(`编辑按钮：找不到 ${msg.id}`);
                    return;
                }
                commandPanel.open({ ...item }, false);
                return;
            }
            if (msg.kind === "commandDelete") {
                const all = readCommands();
                // ★ 删按钮时把它的图标文件也清掉（B32 ✓ 不留垃圾）
                //   ★★ B33：递归收 ✗ 子按钮的图标也要清 ✓
                const hit = findCommand(all, msg.id);
                if (hit) for (const ic of collectIcons(hit)) removeIconFile(ic);
                await writeCommands(removeCommand(all, msg.id));
                pushCommands();
                logInfo(`删除按钮：${hit?.label ?? msg.id}`);
                return;
            }
            // ★★ B34：拖拽重排（同容器内 ✓ 跨容器是后面的事 ✓）
            if (msg.kind === "commandMove") {
                const items = readCommands();
                const ok = moveCommand(items, msg.id, msg.targetId, msg.before === true);
                if (!ok) {
                    // ★ 不同容器 / 找不到 → 什么都不写 ✓（前端已经会回弹 ✓）
                    logWarn(`拖拽重排未生效：${msg.id} → ${msg.targetId}（第一步只允许同容器 ✓）`);
                    return;
                }
                await writeCommands(items);
                pushCommands();
                logInfo(`拖拽重排：${msg.id} → ${msg.before ? "前" : "后"}插到 ${msg.targetId}`);
                return;
            }
            if (msg.kind === "commandRun") {
                // ★★ B33：递归搜（子按钮就靠这个 ✓）
                const item = findCommand(readCommands(), msg.id);
                if (!item) {
                    logWarn(`执行按钮：找不到 ${msg.id}`);
                    return;
                }
                if (item.type === "group") return; // 收纳器不是用来执行的 ✓

                // ★★ 有参数 → 先收集（B32 ③ ✗ B33 补上独立窗口 ✓）
                if (needsInput(item)) {
                    // ★ 两条路：串行原生弹窗 / 独立窗口面板 ✓
                    if (item.inputMode === "panel") {
                        collectViaPanel(item); // ★ B33：真的走面板了 ✓
                        return;
                    }
                    const line = await collectSerial(item);
                    if (!line) return; // ★ 用户取消 ✗ 什么都不发 ✓
                    logInfo(`执行按钮：${item.label} → ${line}`);
                    chatView.post("sendText", { text: line });
                    return;
                }

                const line = buildCommandLine(item);
                logInfo(`执行按钮：${item.label} → ${line}`);
                chatView.post("sendText", { text: line });
                return;
            }

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
            // ★★ B36：动作搬去了 src/panels/session-actions.ts（newSession ✓）
            //   （"这是伪新建 / 不发列表"那几条说明也跟着搬了 ✓）
            //   ★ 侧栏的「＋」也会发这个 kind ✗ 两边落到【同一个动作】✓
            if (msg.kind === "newSession") {
                void sessionActions.newSession();
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

            // ★★ B35：原 listSessions 分支已删 ✗
            //   它原来由【侧栏展开】触发 ✓ 而列表改为面板自己的 sessionReady 拉 ✓

            // ★ 给【当前会话】改名（点按钮行中间的标题区 ✓）
            //   ★★ B36：动作搬去了 src/panels/session-actions.ts（rename ✓）
            if (msg.kind === "renameSession") {
                void sessionActions.rename();
                return;
            }

            // ★★ B35：侧栏「☰ 会话」→ 打开独立面板 ✓
            //   ★★ B36：它现在只是一句转发 ✗ 实现在 session-actions.open()
            //     （= 走三面板互斥协调器 + 顺带刷一下顶栏的会话名 ✓）
            if (msg.kind === "openSessions") {
                sessionActions.open();
                return;
            }

            // ★★ B36：refreshSessions / switchSession 搬去 session-host ✓
            //   （两组注释也一起搬进了 session-actions.ts ✓）

            // ★ 克隆 / 分叉（B19）—— 都是本地处理（不走 formatMap ✓）
            //
            // ★★ B36：动作搬去了 src/panels/session-actions.ts（branch ✓）
            //   （"为什么要宿主做"的两条理由也跟着去了 ✓）
            //   ★ 这是【聊天页气泡下那把"刀"】发的 ✗ 会话面板不发它 ✓
            if (msg.kind === "cloneSession" || msg.kind === "forkSession") {
                const isFork = msg.kind === "forkSession";
                void sessionActions.branch({
                    isFork,
                    userIndex: isFork ? msg.payload.userIndex : undefined,
                });
                return;
            }

            // ★★ B36：会话面板专属的五个消息【搬去 session-host 了】✗
            //
            //   refreshSessions / switchSession / deleteSession /
            //   exportSession / importSession
            //   ⇒ src/panels/session-host.ts     消息路由 ✓
            //   ⇒ src/panels/session-actions.ts  动作实现 ✓
            //
            // 【★ 为什么它们不该在这里】
            //   它们【只有会话面板会发】✗ 聊天页从不发 ✓
            //   ⇒ 长在聊天页那个大函数里是错位 ✓
            //
            // 【★ 现在"会话消息"的两条路】（B36 的成果 ✓）
            //   聊天页发的（＋新建 / 改名 / 打开面板 / 克隆分叉 4 个）
            //     → 还在下面几行 ✗ 但只剩【转发到 actions】一句 ✓
            //   面板发的（上面那 5 个 + sessionReady）
            //     → src/panels/session-host.ts ✓
            //   ★ 两条路【都落到同一个 sessionActions】✗ 实现只有一份 ✓

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

            // ★ 技能面板（B31）：打开【编辑器区面板】✗ 不再是侧栏那块 ✓
            if (msg.kind === "openSkills") {
                // ★★ B35：走互斥协调器 ✓
                // ★★ B37：带 toggle ✗ 再点一次就关掉（侧栏技能按钮 ✓）
                showExclusive("skills", true);
                await skillsActions.refresh();
                return;
            }

            // ★★ B35：这里原本有四个【技能面板】的分支 ✗ 已删 ✓
            //   （skillDetail / skillInsert / skillToInput / skillAsCommand ✓）
            //
            // 【为什么删？】
            //   它们【永远进不来】✗ —— 技能面板是编辑器区的独立页面 ✓
            //   它的消息走 SkillsPanel 自己的回调（见上面那个构造 ✓）
            //   【不转给】handleFrontendMessage ✓
            //
            // ★★ 留着最坑的地方：它会让人把新逻辑加在这里 ✗
            //   ⇒ 静默失效 ✓（我自己就这么踩了一次 ✗ 用户实测“注入 / 发送都不关”✓）
            //   消息类型也一并从 format-frontend.ts 删了 ✗ 更不容易踩 ✓

            // ★★ B36：设置领域的四个消息【搬去模块了】✗
            //
            //   addApiKey / removeAuth / reloadSettings / saveSettings
            //   ⇒ src/panels/settings-host.ts     消息路由 ✓
            //   ⇒ src/panels/settings-actions.ts  动作实现 ✓
            //
            // 【★ 为什么它们能搬走？】
            //   它们【不是聊天页专属】✗ 设置面板自己也发同样这几个 ✓
            //   ⇒ 两边都落到【同一份实现】✗ 才不会出现两套保存逻辑 ✓
            //   （搬走之前是靠"设置面板把消息转交给这个大函数"凑合的 ✓
            //     那是隐式的 ✗ 现在显式成 actions ✓）
            //
            // 【★ 顺带删掉的东西】
            //   原来这四段里有注释解释"为什么走这里而不是 settings 保存"✗
            //   那些解释已经跟着代码去了 settings-actions.ts ✓

            // ★ 设置面板（B24）：打开 / 切到面板（本地文件操作 ✓）
            if (msg.kind === "openSettings") {
                // ★★ B35：侧栏的 ⚙ 只是【入口】✗ 真正显示交回宿主 ✓
                //   ★ 走互斥协调器 ✗ 打开它 = 关掉会话 / 技能 ✓
                //   ★ 面板【新开】时会自己发 settingsReady → 再拉一次数据 ✓
                //     所以这里【不需要】推数据 ✓
                settingsActions.open();
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
                chatView.post("cwd", { path: pi.getCwd(), short: compactHome(pi.getCwd()) });
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
                chatView.post("cwd", { path: pi.getCwd(), short: compactHome(pi.getCwd()) });
                chatView.post("snapshot", chatState.snapshot());
                // ★★ B35：会话列表走独立面板 ✗
                void sessionActions.list();
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
    };

    // ★★ B35：侧栏聊天视图（消息回调换成具名函数 ✗ 好让会话面板共用 ✓）
    const chatView = new ChatView(
        context.extensionUri,
        // ★★ B32 图标：图标存储目录（要进 webview 白名单 ✓）
        context.globalStorageUri,
        chatState,
        handleFrontendMessage,
        cwd, // ★ 输入区下方极简栏要显示它 ✓
    );

    /**
     * ★★ B36：会话（"绘画"）领域的【消息路由】+【动作】都搬去模块了 ✗
     *
     * 【搬去哪了】
     *   src/panels/session-host.ts     面板的消息 → 动作（7 个 kind ✓）
     *   src/panels/session-actions.ts  动作实现（新建/切换/分叉/删除/导出/导入 ✓）
     *
     * 【★★ 为什么要搬】
     *   这十来个动作【两边都会触发】✗
     *     · 侧栏「＋」和面板「＋」→ 都是 newSession ✓
     *     · 聊天页气泡下那把"刀"和面板 → 都要 branch ✓
     *     · 侧栏标题 和 面板右键 → 改名 / 删除 / 导出 ✓
     *   ⇒ 必须落到【同一份实现】✗ 否则就是两套逻辑 ✓
     *     （B36 之前全靠"面板把消息转交给聊天页那个大函数"凑合 ✓
     *       隐式 ✗ 现在显式成 sessionActions ✓）
     *
     * 【★ 顺序说明】
     *   下面用箭头【延迟取】sessionPanel / chatView ✓
     *   它们都在后面才定义 ✗ 而箭头体只在真正用到时才执行 ✓
     */
    const sessionActions = createSessionActions({
        pi,
        sessionStore,
        chatState,
        postChat: (kind, payload) => chatView.post(kind, payload),
        postPanel: (kind, payload) => sessionPanel.post(kind, payload),
        // ★★ B37：侧栏 ☰ 带 toggle ✗ 再点一次就关 ✓
        showPanel: () => showExclusive("session", true),
        closePanelAfterAction: () => closeSessionPanelAfterAction(),
        replay: () => replaySessionMessages(),
        pushTitle: (overrideName) => pushCurrentSessionTitle(overrideName),
    });

    const sessionPanel = new SessionPanel(
        context.extensionUri,
        createSessionHost({ actions: sessionActions }),
    );

    /**
     * ★★ B36：设置面板的【消息路由】+【动作】都搬去模块了 ✗
     *
     * 【搬去哪了】
     *   src/panels/settings-host.ts     消息 → 动作（5 个 kind ✓）
     *   src/panels/settings-actions.ts  动作的实现（读改写 / 弹窗 ✓）
     *
     * 【★ 它的两个"消息来源"】（B36 想根治的就是这个 ✗）
     *   ① 侧栏 ⚙ → openSettings → 走 handleFrontendMessage（聊天页那条 ✓）
     *   ② 面板自己 → settingsReady / reloadSettings / saveSettings /
     *                addApiKey / removeAuth ✓
     *   ⇒ 两条路【都落到同一个 settingsActions】✗ 实现只有一份 ✓
     *
     * 【★ 顺序说明】
     *   下面用箭头【延迟取】postSettings / showExclusive / sessionStore ✓
     *   它们都在后面才定义 ✗ 而箭头体只在真正用到时才执行 ✓
     */
    const settingsActions = createSettingsActions({
        postSettings: () => postSettings(),
        // ★★ B37：侧栏 ⚙ 带 toggle ✗ 再点一次就关 ✓
        showPanel: () => showExclusive("settings", true),
        onSessionDirChanged: async () => {
            // ★ 改了 sessionDir → 我们的会话扫目录要跟着改 ✓
            //   （否则列表全空 ✗ 用户预言的"一定会出错"✓）
            sessionStore.setRoot(resolveSessionRoot(readLaunchArgs()));
            await sessionActions.list();
        },
    });

    const settingsPanel = new SettingsPanel(
        context.extensionUri,
        createSettingsHost({
            actions: settingsActions,
            onReady: () => postSettings(),
        }),
    );

    /**
     * ★★ B35：编辑器区【三面板互斥】（用户定的 ✓）
     *
     * 【哪三个？】
     *   绘画（= 会话）/ 设置 / 技能 —— 用户主动打开的"工作页面"✓
     *
     * 【谁【不】参与？】（用户定的 ✓）
     *   · 交互面板 ✗ —— 它是 pi 提问时【自动弹出来抢焦点】的 ✓
     *     若参与 ⇒ 你正读着设置，pi 一问，设置就没了 ✗ 不合理 ✓
     *   · 调试板 ✗ —— 开发时的观察窗 ✗ 想一直看着 ✓
     *   · 自由按钮配置页 ✗ —— 用户没把它算进"板子"里 ✓
     *
     * 【语义】（用户原话："开启的情况下点击另一个板子就互斥，
     *        关掉前一个渲染当前的"✓）
     *   ① 先把【别的两个】关掉 ✓
     *   ② 再把目标叫起来 ✗ 它自己渲染自己 ✓
     *
     * 【★ 被关掉的面板里没保存的改动？】
     *   设置面板直接丢 ✗（用户定的："直接关，丢弃改动"✓）
     */
    type ExclusivePanel = "session" | "settings" | "skills";
    /**
     * ★★ B35：编辑器区【三面板互斥】✓
     *
     * 【★★ B37 加的第二件事：toggle】
     *   `toggle = true` 时：如果目标面板【正显示着】→ 就关掉它 ✗ 而不是显示 ✓
     *   用户原话：“我打开绘画面板 ✗ 再点击绘画按钮 ✗ 关闭不了它”✓
     *
     * 【谁用 toggle？】
     *   ✅ 侧栏那三个按钮（☰ 会话 / ⚙ 设置 / 技能 ✓）—— 它们是"同一个开关"✓
     *   ❌ 命令面板入口（Pi: 打开会话面板 ✓）—— 那是"我要用它"的明确意图 ✗
     *      点了它再把面板关掉会很怪 ✓
     *
     * 【★ 判断用 isVisible() ✗ 不是 isOpen()】
     *   面板存在但被别的 tab 盖住时 ✗ 点按钮应该【把它露出来】✓
     *   （直接关掉一个用户看不见的面板 ✗ 等于什么都没发生却丢了它 ✓）
     */
    const showExclusive = (which: ExclusivePanel, toggle = false): void => {
        const target =
            which === "session" ? sessionPanel : which === "settings" ? settingsPanel : skillsPanel;

        // ★ 再点一次 → 关掉（只对侧栏按钮生效 ✗ 见上 ✓）
        if (toggle && target.isVisible()) {
            target.hide();
            logInfo(`再点一次 → 关掉「${which}」面板 ✓`);
            return;
        }

        if (which !== "session") sessionPanel.hide();
        if (which !== "settings") settingsPanel.hide();
        if (which !== "skills") skillsPanel.hide();

        if (which === "session") sessionPanel.show();
        else if (which === "settings") settingsPanel.show();
        else skillsPanel.show();
    };

    /**
     * ★★ B35：绘画面板（= 会话）的「动作后自动关闭」
     *
     * 【开关】pi-bridge.sessions.closeAfterAction（默认 true ✓ 用户定的 ✓）
     * 【触发】切换会话 / 新建会话 ✓（其它动作【不】关 ✗
     *         导出 / 导入 / 删除 / 改名 都不算 ✓）
     * 【时机】★ 点击即关 ✗ 不等 RPC 结果 ✓（用户选中 ✓）
     *   ⇒ 代价：切换失败时你已经看不到面板了 ✗
     *     但侧栏会弹错误提示 + 焦点已经回到输入框 ✓ 不至于找不着北 ✓
     * 【焦点】关完把焦点还给聊天输入框 ✓
     *   （"新建会话"之后本来就要打字发第一条 ✓）
     *
     * ★ 侧栏的「＋ 新建」也发同一个 newSession ✗
     *   那时面板根本没开 ✗ 所以先看 isOpen() ✓ 不会误触发 ✓
     */
    const closeSessionPanelAfterAction = (): void => {
        if (!sessionPanel.isOpen()) return;
        const on = vscode.workspace
            .getConfiguration("pi-bridge")
            .get<boolean>("sessions.closeAfterAction", true);
        if (!on) return;
        sessionPanel.hide();
        chatView.focusInput();
    };

    /**
     * ★★ B35：技能面板的「动作后自动关闭」
     *
     * 【开关】pi-bridge.skills.closeAfterAction（默认 true ✓）
     * 【触发】单击技能（= 注入 / 直接发送 ✓）
     *         或点右侧反向按钮 ✓
     *         → 落到宿主这里就是 skillInsert / skillAsCommand 两条消息 ✓
     * 【★ 不触发】右键"查看内容 / 定位 / 隐藏" ✗ 删除 ✗
     *   那些是"管理"动作 ✗ 用户还要接着管别的 ✓
     */
    const closeSkillsPanelAfterAction = (): void => {
        if (!skillsPanel.isOpen()) return;
        const on = vscode.workspace
            .getConfiguration("pi-bridge")
            .get<boolean>("skills.closeAfterAction", true);
        if (!on) return;
        skillsPanel.hide();
        chatView.focusInput();
    };

    // 5. 注册 VS Code 的贡献点（命令 / 视图）

    // ★ 开发模式（F5 调试）下自动打开调试板：
    //   写扩展时第一步就是“看数据”，每次手动开太麻烦 ✗
    //   发布后的正式安装【不】自动开（不能干扰用户 ✓）
    if (context.extensionMode === vscode.ExtensionMode.Development) {
        debugPanel.show();
    }

    // ★ B31：技能相关配置变了 → 刷新技能面板（单击行为 / 隐藏清单 ✓）
    //   ★ 不刷新的话：用户在设置面板改了"单击行为"✗ 面板里的按钮语义不变 ✓
    //     （实测就是这个 bug ✓）
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("pi-bridge.skills") && skillsPanel.isOpen()) {
                void skillsActions.refresh();
            }
            // ★★ B35：样式配置变了 → 【设置面板自己的】字号 / 内边距要实时生效
            //   （原来靠侧栏 chatView 推 styleVars ✗ 独立面板得自己收 ✓
            //    见 src/settings/index.ts 的 "styleVars" 分支 ✓）
            if (e.affectsConfiguration("pi-bridge.style") && settingsPanel.isOpen()) {
                settingsPanel.refreshStyle();
            }
        }),
    );

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

        // ★ 命令面板 → 打开技能面板（B31 ✓）
        vscode.commands.registerCommand("pi-bridge.showSkills", () => {
            showExclusive("skills");
            void skillsActions.refresh();
        }),

        // ★ 命令面板 → 打开交互面板（B26 ✓ 没有待答请求时是空操作 ✓）
        vscode.commands.registerCommand("pi-bridge.showInteraction", () => {
            interactionPanel.show();
        }),

        // ★★ B35：命令面板 / 侧栏「☰ 会话」→ 打开会话面板
        //   （它从侧栏搬到编辑器区了 ✗ 侧栏只留一个入口按钮 ✓）
        vscode.commands.registerCommand("pi-bridge.showSessions", () => {
            showExclusive("session");
        }),

        // ★★ B35：命令面板 → 打开设置面板
        //   ★ 原来 package.json 里声明了这个命令 ✗ 但【宿主从没注册过】✓
        //     所以之前点它会报"命令未找到"✗（设置面板没完全独立出来的最后一环 ✓）
        vscode.commands.registerCommand("pi-bridge.showSettings", () => {
            showExclusive("settings");
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
    // ★★ B36：会话的六个实现（doSessionBranch / doDeleteSession /
    //   doExportSession / doImportSession / currentSessionFile /
    //   postSessionList）【整块搬去】src/panels/session-actions.ts ✓
    //   ★ 它们全都【只被会话相关逻辑】用 ✗ 所以整体搬走最干净 ✓

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
        // ★ B39 诊断：确认 get_messages 返回的 toolResult 带 details（edit 的 patch）
        //   发现：pi 确实原样返回（会话文件里什么样就是什么样 ✓）
        const trDiag = messages.find((m) => m.role === "toolResult");
        logDebug(
            trDiag
                ? `重放诊断：toolResult 键=[${Object.keys(trDiag).join(",")}] ` +
                      `details=${trDiag.details ? "有" : "无"}`
                : "重放诊断：这批消息里没有 toolResult",
        );
        for (const patch of messagesToPatches(messages)) {
            // ★ 走 ChatState.apply：与实时流同一条渲染路径 ✓
            chatState.apply(patch as never);
        }
        // ★★ B38：历史里的 bash 命令也要解析（不需要缓存 ✗ 重算一遍即可 ✓
        //   bash-parser 一条 1~5ms ✗ 几十个工具块也就百毫秒级 ✗ 可忽 ✓）
        void repushCmdSummaries(messages);
    }

    /**
     * ★★ B38：把历史里每条 bash 调用的【命令主体】算出来推给前端
     * ★ 命令原文就在会话消息里（toolCall.arguments.command）✗ 所以重算可行 ✓
     * ★ 不写会话文件 ✗ 不建缓存库 ✗ 每次重算（成本可忽略 ✓）
     */
    async function repushCmdSummaries(messages: ReplayMessage[]): Promise<void> {
        let found = 0;
        for (const m of messages) {
            const content = m.content;
            if (!Array.isArray(content)) continue;
            for (const part of content) {
                const p = part as {
                    type?: string;
                    name?: string;
                    id?: string;
                    arguments?: { command?: unknown };
                };
                if (p?.type !== "toolCall" || p.name !== "bash" || !p.id) continue;
                const cmd = p.arguments?.command;
                if (typeof cmd !== "string") continue;
                const commands = await extractCommands(cmd);
                found++;
                logInfo(`★ 重放命令摘要：${JSON.stringify(commands)}（cmd=${cmd.slice(0, 40)}…）`);
                if (commands.length) {
                    chatView.post("cmdSummary", { callId: p.id, commands });
                }
            }
        }
        logInfo(`★ 重放命令摘要：共找到 ${found} 个 bash 工具调用`);
    }

    // ★ 把【当前会话的名字】推给前端标题区（按钮行中间 ✓）
    //
    // 【怎么知道“当前”是哪个会话？】
    //   问 pi 的 get_state（sessionFile ✓）
    //   ★ 但 get_state 会【触发懒启动】✗ → 所以先判断 isStarted ✓
    //     （用户还没发过消息就不该因为“打开面板”而启动 pi ✓）
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

    // ★ B30：设置内容的推送逻辑已搬到 src/panels/settings-post.ts ✗
    //   用工厂把 chatView.post 依赖传进去 ✓
    const postSettings = createSettingsPoster({ post: (k, p) => settingsPanel.post(k, p) });

    /** ★ webview 就绪 → 推模型信息（已启动用真实值 ✓ 未启动用默认值占位 ✓）*/
    /**
     * ★★ 收集参数：串行弹窗（B32 ③）
     *
     * 【★ 重要认识（用户纠正的 ✓）】
     *   参数就是【命令行里的一串文本】✗ 不是跟 pi 的交互 ✓
     *     /test-args add write 42
     *                  ↑   ↑   ↑
     *   ⇒ 所以收集完全是我们【本地的事】✗
     *     循环调 VS Code 原生控件填空 ✗ 拼成一行 ✗ 完事 ✓
     *
     * 【固定值不弹窗】
     *   它每次都一样 ✗ 弹了也没意义 ✓ 直接拼进去 ✓
     *
     * @returns 拼好的命令行 ✗ 用户中途取消则 undefined ✓
     */
    const collectSerial = async (item: CmdItem): Promise<string | undefined> => {
        const values: Record<string, string> = {};
        for (const f of item.fields ?? []) {
            if (f.kind === "fixed") {
                values[f.id] = f.value ?? "";
                continue;
            }
            if (f.kind === "select") {
                const pick = await vscode.window.showQuickPick(f.options ?? [], {
                    title: item.label,
                    placeHolder: f.label,
                    ignoreFocusOut: true,
                });
                if (pick === undefined) return undefined; // ★ 取消 → 整条不发 ✓
                values[f.id] = pick;
                continue;
            }
            // any
            const val = await vscode.window.showInputBox({
                title: item.label,
                prompt: f.label,
                placeHolder: f.subType === "number" ? "例如 42" : "",
                ignoreFocusOut: true,
                validateInput:
                    f.subType === "number"
                        ? (s) =>
                              /^-?\d+(\.\d+)?$/.test(s.trim())
                                  ? undefined
                                  : "这里要数字（可带负号 / 小数点 ✓）"
                        : undefined,
            });
            if (val === undefined) return undefined;
            values[f.id] = val.trim();
        }
        return buildCommandLine(item, values);
    };

    /**
     * ★★ 把图标路径【收进标准位置】（B32 图标 ✓）
     *
     * 【用户原话】
     *   “图标这里是可以来个本地图标 ✗ 只给个路径的，这应该很轻松吧？
     *    路径的话 ✗ 那得复制进来 ✗ 把这个图标复制一个到某个地方存起来”
     *
     * 【存哪】VS Code 标准位置：context.globalStorageUri（扩展自己的持久目录 ✓）
     *   → 好处：跟着扩展走 ✗ 不会因为用户移动原文件而失效 ✓
     *   → 配置里只存 `icons/xxx.png` 这种相对名 ✗ 不存用户那个原始路径 ✓
     *
     * ★ 不是图片（emoji / codicon）→ 原样返回 ✓
     * ★ 找不到文件 → 原样存着（用户在配置里能看到自己填错什么 ✓）
     */
    const materializeIcon = (icon?: string, oldIcon?: string): string | undefined => {
        if (!icon) return undefined;
        const v = icon.trim();
        if (!isImageIcon(v)) return v;
        if (isManagedIcon(v)) return v; // 已经在标准位置 ✓
        try {
            const src = v.startsWith("~") ? path.join(os.homedir(), v.slice(1)) : v;
            if (!fs.existsSync(src)) {
                logWarn(`图标文件不存在，原样保留：${v}`);
                return v;
            }
            const ext = (path.extname(src) || ".png").toLowerCase();
            const name = `icons/${Date.now().toString(36)}${ext}`;
            logDebug(`图标源：${src} → 存到 ${path.join(context.globalStorageUri.fsPath, name)}`);
            const dst = path.join(context.globalStorageUri.fsPath, name);
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            fs.copyFileSync(src, dst);
            logDebug(`图标已收进标准位置：${name}`);
            // ★★ 删掉【上一张】（B32 用户指出 ✓）
            //   原话：“每保存一次就复制一个文件 ✗ 你保存的时候肯定要对比一下呀。
            //          原本有图片 ✗ 现在来了张新图片 ✗ 当然要把旧图片给删了呀”✓
            //   ★ 只删我们管的（icons/ 开头 ✓）✗ 用户的原始文件绝不能碰 ✓
            removeIconFile(oldIcon, name);
            return name;
        } catch (err) {
            logError(`图标复制失败：${toErrorMessage(err)}`);
            return v;
        }
    };

    /**
     * ★★ 删掉一个存放在标准位置的图标（B32 ✓）
     *
     * 【安全边界】只删 `icons/` 开头的 ✗
     *   用户填的原始路径（/home/…/pi.svg 之类）【绝对不动】✓
     *   万一它和别的按钮共用呢 ✓
     *
     * @param keep 新图标名（一样就不删 ✓）
     */
    const removeIconFile = (icon?: string, keep?: string): void => {
        if (!icon || !isManagedIcon(icon)) return;
        const name = icon.trim();
        if (name === keep) return;
        try {
            const abs = path.join(context.globalStorageUri.fsPath, name);
            if (fs.existsSync(abs)) {
                fs.unlinkSync(abs);
                logDebug(`已清理旧图标：${name}`);
            }
        } catch (err) {
            logWarn(`清理旧图标失败：${toErrorMessage(err)}`);
        }
    };

    /** ★ 推给前端前：把 icons/xxx 变成 webview 能加载的 URI ✓ */
    /**
     * ★★ 图标 → 前端能用的两个地址（B33 ✗ 从 B32 的 401 演化来 ✓）
     *
     * 【两条路都给 ✗】
     *   ① icon     = asWebviewUri 生成的标准地址 ✓
     *   ② iconData = data URI（★ 兜底 ✗ 不走网络 ✗ 不经授权链 ✓）
     *
     * 【★ 为什么要兜底？】（B32 实测 ✗）
     *   <img> 加载 webview 地址时返回 401 Unauthorized（from service worker ✓）
     *   已排除：文件不存在 / 白名单 / URL 格式 / CSP / SVG 本身 ✓
     *   ⇒ 前端失败时自动改用 iconData ✗ 图标照样出来 ✓
     *   ★ 主路径仍然是标准做法 ✗ 万一哪天环境修好 ✗ 自动回到正轨 ✓
     */
    const MAX_ICON_BYTES = 128 * 1024; // ★ 上限（防用户塞大图 ✓）
    const iconMime = (p: string): string => {
        const m: Record<string, string> = {
            svg: "image/svg+xml",
            png: "image/png",
            jpg: "image/jpeg",
            jpeg: "image/jpeg",
            gif: "image/gif",
            webp: "image/webp",
            bmp: "image/bmp",
            ico: "image/x-icon",
        };
        return m[(p.split(".").pop() ?? "").toLowerCase()] ?? "application/octet-stream";
    };
    const iconForWeb = (icon?: string): { icon?: string; iconData?: string } => {
        if (!icon || !isManagedIcon(icon)) return { icon }; // emoji / codicon 原样 ✓
        const abs = path.join(context.globalStorageUri.fsPath, icon);
        const uri = chatView.toWebviewUri(abs);
        let iconData: string | undefined;
        try {
            const size = fs.statSync(abs).size;
            if (size <= MAX_ICON_BYTES) {
                const b64 = fs.readFileSync(abs).toString("base64");
                iconData = `data:${iconMime(icon)};base64,${b64}`;
            } else {
                logWarn(`图标 ${size} 字节 > 上限 ${MAX_ICON_BYTES} ✗ 不做兜底：${icon}`);
            }
        } catch (err) {
            // ★ 文件不在 / 读不动 → 没得兜 ✗ 主路径也会失败 ✓ 先记一笔 ✓
            logWarn(`图标读不出 ✗ 无法兜底：${icon}（${String(err)}）`);
        }
        logDebug(
            `图标 ${icon}\n  uri  = ${uri ? uri.slice(0, 120) : "（空 ✗ view 未就绪）"}` +
                `\n  data = ${iconData ? `${iconData.length} 字符 ✓` : "（无）"}`,
        );
        return { icon: uri || icon, iconData };
    };

    /**
     * ★★ 把自由按钮列表推给容器（B32 ✓）
     *
     * ★ 每次【现读配置】✗ 不用缓存 ✓（跟设置面板同一套路 ✓）
     *   理由：用户可能在 VS Code 原生设置里手改那个 JSON ✗
     *         缓存了就会跟实际不一致 ✓
     */
    const pushCommands = (): void => {
        // ★★ 消息名用 railCommands ✗ 【不是 commands】✓
        //   commands 被 slash-menu 的命令补全列表占了 ✗ 同名会互相覆盖 ✓
        // ★ 推之前把图标路径转成 webview 地址（B32 ✓）+ 附上 data URI 兜底（B33 ✓）
        type CmdItemView = CmdItem & { iconData?: string };
        const mapItem = (x: CmdItem): CmdItemView => {
            const { icon, iconData } = iconForWeb(x.icon);
            return {
                ...x,
                ...(icon ? { icon } : {}),
                ...(iconData ? { iconData } : {}),
                children: x.children?.map(mapItem),
            };
        };
        chatView.post("railCommands", readCommands().map(mapItem));
    };

    chatView.onReady = () => {
        // ★ B32：把自由按钮推给容器（它只读 VS Code 配置 ✗ 不依赖 pi ✓）
        pushCommands();
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

    /** 控件类型对应的“空值”（未配置时展示用 ✓）*/

    /** ★ 改动里有没有“需要重启 pi”的项（给用户提示 ✓）*/

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

    // ★ scope 改了 → 立刻重新推列表（不用重开面板 ✓）
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("pi-bridge.sessions")) {
                void sessionActions.list();
            }
        }),
    );

    logInfo("pi-bridge-vs 激活完成（pi 将在首条消息时启动）");
}

export function deactivate(): void {
    // 清理工作主要由上面的 subscriptions 完成
}

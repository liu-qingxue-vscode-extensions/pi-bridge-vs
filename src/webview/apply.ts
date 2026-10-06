/**
 * apply.ts —— 【宿主消息分发】：收到扩展宿主推来的消息 → 调用对应渲染
 *
 * 【它收到什么？】（全部来自 src/view/chat-view.ts 的 post()）
 *   styleVars   设置 → CSS 变量（含折叠/居中开关）
 *   modelLimits 模型 → contextWindow（电池分母）
 *   cwd         工作目录（极简栏）
 *   agentState  working / idle（按钮形态 + 占位三点）
 *   snapshot    全量重放（webview 重建 / 视图重开）★ 载荷 { bubbles, notices }
 *   patch       增量渲染指令（ChatPatch）
 *   toggleNotices / noticesCleared  通知板相关的宿主指令
 *
 * 【为什么单独一个文件？】
 *   这是"唯一的入口分发点"，集中后各渲染模块不需要知道消息协议 ✓
 */
import { inputEl, messagesEl } from "./dom.js";
import { ui } from "./state.js";
import { log, vscode } from "./vscode-api.js";
import { createBubble, refreshForkButtons, removePending, showPending } from "./bubbles.js";
import { setQueueing, showInserting } from "./inserting.js";
import { appendSegment, endSegment } from "./segments.js";
import { appendMarkdown, finishMarkdown, setHighlightTheme } from "./markdown.js";
import { createThinkingBubble, markThinkDone } from "./thinking.js";
// ★★ B39：fillToolBubble = 工具气泡的【唯一】填充入口（实时流 / snapshot 都走它）
import type { ToolBlockFields } from "../view/chat-types.js";
import { createToolBubble, fillToolBubble, fillToolBubbleSnapshot } from "./tool.js";
import { appendStopNote, showRetryNotice } from "./notices.js";
import { showCompactionEnd, showCompactionStart } from "./compact.js";
import { setModelInfo, showModelPicker, showThinkingPicker } from "./model-picker.js";
import { showInteractionHint } from "./ui-request.js";
import { setCommands } from "./slash-menu.js";
import { updateStatusBar } from "./topbar.js";
import { appendNotice, clearNotices, removeNotice, renderNotices, resetNotices, setExpanded } from "./noticeboard.js";
import { applyStyleVars, autoGrow, setAgentState, showCwd, syncPadding } from "./input.js";
import { setSessionTitle } from "./sessions.js";
// ★★ B32：自由按钮容器
import { setRailCommands } from "./cmdrail.js";
import { setFoldRules } from "./tool-fold.js";

/**
 * 气泡快照的形状（对应插件端 Bubble ✓）
 * ★ B40：工具字段【继承共享定义 ToolBlockFields】✗ 不再手写一份
 *   （B39 就是这里和 ToolData 两份手写 ⇒ 漏传 details ⇒ diff 画不出来）
 */
interface SnapBlock extends ToolBlockFields {
    type: string;
    text?: string;
}

interface SnapBubble {
    role: string;
    blocks: SnapBlock[];
    usage?: unknown;
    model?: string;
}

/** 最近一次快照（★ 改配置要重画时用 ✓） */
let lastSnapshot: unknown = null;

/** 重放待办：正在流式输出时改配置 → 延到空闲再重放 ✓ */
let replayPending = false;

/** 任务是否在跑（流式输出中）*/
let agentBusy = false;

/**
 * ★ 按【最新配置】重画已渲染内容
 *
 * 【为什么要它？】配置项分三类 ——
 *   ① 纯样式（颜色/尺寸）→ 天生实时 ✓（CSS 变量是“活的”✓）
 *   ② 影响 DOM 结构（toolPeekLines / 默认折叠）→ 已建的气泡不会变 ✗ → 需要重画 ✓
 *   ③ 影响数据流（调试板折叠）→ 调试板自己已用“重放”解决 ✓
 *
 * 重放不是新机制：它是 B1 就做好的能力（webview 重建时一直用它 ✓）
 * 这里只是把【同一个模式】接到“配置变化”上 ✓
 *
 * 【为什么延后？】
 *   重放会重建气泡 → 打断正在流式的输出 ✗
 *   所以忙的时候记住“待重放”，等 agent_settled（彻底空闲）再做 ✓
 */
function replayForConfig(): void {
    if (lastSnapshot === null) return;
    if (agentBusy) {
        replayPending = true;
        return;
    }
    // ★ keepNotices：配置变化不该把通知清掉（那是数据，不是渲染 ✓）
    replaySnapshot(lastSnapshot, { keepNotices: true });
}

/**
 * 全量重放（webview 重建 / 视图重开时）
 *
 * @param opts.keepNotices 保留现有通知（改配置重画时用 ✓）
 *                         不传 = 用快照里的通知重建（webview 重建时 ✓）
 */
function replaySnapshot(payload: unknown, opts?: { keepNotices?: boolean }): void {
    lastSnapshot = payload; // ★ 记住它：改配置时要靠它重画 ✓
    const snap = (payload ?? {}) as { bubbles?: SnapBubble[]; notices?: unknown[] };
    const bubbles = Array.isArray(snap.bubbles) ? snap.bubbles : [];

    messagesEl.innerHTML = "";
    ui.bubble = null;
    ui.pendingEl = null; // ★ 重建后不保留旧占位引用
    ui.lastThinkBubble = null;
    // ★ 通知（默认从快照重建；改配置重画时保留现有 ✓）
    if (opts?.keepNotices) {
        renderNotices();
    } else {
        resetNotices((snap.notices ?? []) as never);
    }

    for (const b of bubbles) {
        ui.role = b.role;
        // ★ 用户消息：整条消息就是一个 user 气泡（不走 segment 逻辑）
        if (b.role === "user") {
            const el = createBubble("user");
            el.textContent = b.blocks.map((x) => x.text ?? "").join("");
            ui.bubble = null;
            continue;
        }
        let last: HTMLElement | null = null;
        for (const blk of b.blocks) {
            if (blk.type === "tool") {
                last = createToolBubble(blk.toolCallId || "", blk.toolName);
                // ★★★ B39：跟实时路径【同一个填充入口】
                //   （以前这里自己写了一套 ✗ cmdCache / details 都漏在这条路上）
                // ★ B40：走【必填】入口 ⇒ 以后漏字段会直接编译失败（不用等用户发现）
                fillToolBubbleSnapshot(last, {
                    args: blk.args,
                    resultParts: blk.resultParts,
                    partialParts: blk.partialParts,
                    details: blk.details,
                    resultIsError: blk.resultIsError,
                    executing: blk.executing,
                    commands: cmdCache.get(blk.toolCallId || ""),
                });
            } else if (blk.type === "thinking") {
                // 历史里的思考：也是可折叠气泡（已完成，无时长可显示）
                if (!last || !last.classList.contains("thinking")) {
                    last = createThinkingBubble("已思考");
                }
                last.querySelector(".think-body")!.textContent += blk.text ?? "";
            } else {
                if (!last || !last.classList.contains("text")) {
                    last = createBubble("text");
                }
                // ★ B29：历史重建也走 MD 渲染 ✗（与流式同一条路 ✓）
                appendMarkdown(last, blk.text ?? "");
            }
            ui.bubble = last;
        }
    }

    // ★★ B29：历史重放后把所有 text 气泡“封尾”✗
    //   不封的话它们会一直停在“尾块”状态 ✗ 而尾块用 plainParser
    //   （不带 KaTeX ✓）→ ★ 用户实测的：“会话文件直接渲染时公式泄露”✓
    //   封尾时会用 richParser 重渲染一次 ✗ 公式这时才真的排出来 ✓
    for (const el of messagesEl.querySelectorAll<HTMLElement>(".bubble.text")) {
        finishMarkdown(el);
    }

    // ★ 顶栏也从快照恢复（取最后一条带 usage 的气泡）
    for (let i = bubbles.length - 1; i >= 0; i--) {
        if (bubbles[i].usage) {
            updateStatusBar(bubbles[i].usage as never, bubbles[i].model);
            break;
        }
    }
}

/** 增量补丁分发（ChatPatch 的各种 kind ✓） */
function applyPatch(p: Record<string, unknown>): void {
    const kind = p.kind as string;

    switch (kind) {
        case "startBubble": {
            ui.role = p.role as string;
            ui.bubble = null; // 等第一个段到来时再建
            if (p.role === "user" && p.text) {
                // ★ 你的消息：直接建一个 user 气泡（样式、对齐、宽度都靠 .bubble.user）
                const el = createBubble("user");
                el.textContent = p.text as string;
                ui.bubble = el;
                // ★ 占位三点要始终跟在最后 → 用户气泡插进来后把它挪回末尾 ✓
                //   （否则三点会跑到用户消息【上方】，看着很奇怪 ✗）
                if (ui.pendingEl) messagesEl.appendChild(ui.pendingEl);
            }
            return;
        }

        case "append":
            appendSegment(p.block as "thinking" | "text", p.text as string);
            return;

        case "endBubble": {
            // ★ B29：这条消息的正文段结束 → 把 MD 尾块“封”掉 ✗
            //   （否则后面的新段会继续改它 ✗ 而它内容其实已定了 ✓）
            endSegment();
            // ★ 异常结束（截断/中断/出错）→ 在最后一条 AI 气泡底部补一行提示
            //   但"中断"且已有重试气泡时：由重试气泡负责显示"已中断"✓（不重复挂 ✗）
            const stopReason = p.stopReason as string | undefined;
            if (stopReason === "aborted" && ui.retryNoticeEl?.dataset.final !== "true") {
                // 重试气泡已经在讲了 → 什么都不做 ✓
            } else if (stopReason) {
                appendStopNote(stopReason);
            }
            // ★ 注意：【不在这里】清 userAborted
            //   实测时序：aborted 先到，auto_retry_end 后到 ✗
            //   若在这里清，auto_retry_end 就会误判成"成功"✗✗✗
            //   清标志的时机 → agent_settled（任务彻底结束，必然晚于 auto_retry_end ✓）
            if (p.usage || p.model) {
                updateStatusBar(p.usage as never, p.model as string | undefined);
            }
            ui.bubble = null;
            return;
        }

        case "retryNotice":
            showRetryNotice(p as never);
            return;

        // ★ 压缩（B22）：开始/结束共用一种 patch，原地更新同一个气泡 ✓
        case "compaction":
            if (p.phase === "start") showCompactionStart(p as never);
            else showCompactionEnd(p as never);
            return;

        case "toolStart": {
            removePending();
            const b = createToolBubble(p.callId as string, p.name as string);
            // ★★ B39：命令摘要是先到的（重放时）→ 从常驻表补填
            //   常驻表：气泡会因配置变化【重画】✗ 摘要必须能补回来
            fillToolBubble(b, {
                executing: true,
                commands: cmdCache.get(String(p.callId)),
            });
            return;
        }

        case "thinkStart":
            removePending();
            ui.thinkStartAt = Date.now();
            return;

        case "thinkEnd":
            markThinkDone();
            ui.thinkStartAt = 0;
            return;

        case "toolArgs": {
            // 流式拼装中：先原样显示（拼完后再美化成键值对）
            const host = ui.bubble?.querySelector(".tool-args") as HTMLElement | null;
            if (host) {
                host.dataset.raw = (host.dataset.raw || "") + (p.text as string);
                host.textContent = host.dataset.raw;
            }
            return;
        }

        case "toolEnd":
            // ★ 参数拼完 → 统一走填充入口
            if (ui.bubble) fillToolBubble(ui.bubble, { args: p.args });
            return;

        case "toolResult": {
            // 结果在另一条消息里 → 按 callId 找回工具气泡
            const bubble = findTool(p.callId as string);
            if (bubble) {
                fillToolBubble(bubble, {
                    resultParts: p.parts as unknown[],
                    resultIsError: p.isError === true,
                    executing: false,
                    commands: cmdCache.get(String(p.callId)),
                });
            }
            return;
        }

        case "toolExecStart": {
            // ★ 工具开始执行
            const bubble = findTool(p.callId as string);
            if (bubble) {
                fillToolBubble(bubble, {
                    executing: true,
                    commands: cmdCache.get(String(p.callId)),
                });
            }
            return;
        }

        case "toolExecUpdate": {
            // ★ 执行中的实时输出（累积全文 → 整块替换 ✓）
            const bubble = findTool(p.callId as string);
            if (bubble) {
                fillToolBubble(bubble, {
                    partialParts: p.parts as unknown[],
                    executing: true,
                    commands: cmdCache.get(String(p.callId)),
                });
            }
            return;
        }

        case "toolExecEnd": {
            const bubble = findTool(p.callId as string);
            if (bubble) {
                // ★★ B39：details（edit 的 patch）+ 状态 ⇒ 一次填完
                fillToolBubble(bubble, {
                    details: p.details,
                    resultIsError: p.isError === true,
                    executing: false,
                    commands: cmdCache.get(String(p.callId)),
                });
            }
            return;
        }

        case "notice":
            // ★ 新通知（extension_ui_request.notify / stderr）
            appendNotice({
                id: p.id as number,
                text: p.text as string,
                level: p.level as string,
                time: p.time as number,
            });
            return;

        case "noticeRemove":
            // ★ 插件端确认移除（回显）
            removeNotice(p.id as number);
            return;
    }
}

/** 按 callId 找工具气泡 */
function findTool(callId: string): HTMLElement | null {
    return messagesEl.querySelector(
        '.bubble.tool[data-call-id="' + callId + '"]',
    ) as HTMLElement | null;
}

/** 绑定宿主消息监听（入口调用一次 ✓） */
/**
 * ★★ B38：命令摘要的【暂存表】
 *   重放时宿主先推 cmdSummary（异步算的）✗ 而气泡是收到 snapshot 后才建的 ✓
 *   ⇒ 顺序不定 ✗ 找不到气泡就先存着 ✗ 建气泡时再填 ✓
 */
const cmdCache = new Map<string, string[]>();

export function setupHostBridge(): void {
    window.addEventListener("message", (event) => {
        const data = (event.data ?? {}) as { kind?: string; payload?: unknown };

        switch (data.kind) {
            // ★★ B32：宿主推来整份自由按钮列表
            //   ★★ 消息名【故意不叫 commands】✗（踩过 ✓）
            //     slash-menu 的命令补全列表才叫 commands ✗
            //     switch 遇到第一个匹配就执行 ✗ 同名会把斜杠菜单那个 case 挡死 ✓
            case "railCommands":
                setRailCommands(data.payload);
                return;
            case "styleVars":
                applyStyleVars(data.payload as Record<string, string>);
                setFoldRules((data.payload as Record<string, string>)?.["--pi-tool-fold"] ?? "");
                autoGrow(); // ★ 配置变了（如行数/字号）→ 重新算高度与留白
                // ★ 再按新配置重画已渲染内容（否则行为类参数改了不起作用 ✗）
                //   空闲时立即生效；流式中会延后到 agent_settled ✓
                replayForConfig();
                return;
            case "modelLimits":
                ui.modelLimits = (data.payload ?? {}) as Record<string, number>;
                return;
            // ★★ B38：宿主解析好的命令主体 → 填摘要行
            case "cmdSummary": {
                const p = (data.payload ?? {}) as { callId?: string; commands?: string[] };
                const id = String(p.callId ?? "");
                if (Array.isArray(p.commands) && p.commands.length) {
                    if (cmdCache.size > 800) cmdCache.clear(); // 防无限增长
                    cmdCache.set(id, p.commands);
                    // ★★ B39：气泡在就填；不在也没关系（下次建/重画气泡时会从常驻表补）
                    const b = id ? findTool(id) : null;
                    if (b) fillToolBubble(b, { commands: p.commands });
                }
                return;
            }
            case "cwd":
                showCwd(data.payload as never);
                // ★★ B35：不再 setCurrentCwd ✗
                //   会话面板已搬到编辑器区 ✓ 它自己有 currentCwd
                //   （宿主在 sessionList 消息里一起给 ✓）
                return;
            case "agentState": {
                setAgentState(String(data.payload));
                agentBusy = data.payload === "working";
                if (data.payload === "working") {
                    // 任务开始 → 立刻显示占位三点（不要空荡荡地等第一个数据包）
                    // 注：【不】移除重连提示 ✓（用户要求：留着，别挤掉）
                    showPending();
                } else {
                    // ★ 任务彻底结束（settled 一定晚于 auto_retry_end ✓）→ 清中断标志
                    ui.userAborted = false;
                    removePending();
                    // ★ 流式期间积压的“配置重放”现在可以做了 ✓
                    if (replayPending) {
                        replayPending = false;
                        replayForConfig();
                    }
                }
                return;
            }
            case "snapshot":
                replaySnapshot(data.payload);
                // ★ 重建完后补上“分叉刀”（每条 AI 组的末尾一把 ✓）
                refreshForkButtons();
                // ★ 重放时队列必然是空的 ✗ → 清掉可能残留的“待插话”气泡 ✓
                setQueueing([]);
                // ★ 动作区刚加上去 → 底部留白要重算 ✗（否则滚到底时按钮被盖住 ✓）
                syncPadding();
                return;
            case "patch":
                applyPatch((data.payload ?? {}) as Record<string, unknown>);
                // ★ 每批增量后扫一次（幂等 ✓ 新到的用户消息会把上一组的刀补上 ✓）
                //   ★ 只有真的新增了才重算留白 ✗（否则流式时每帧强制回流 ✓）
                if (refreshForkButtons()) syncPadding();
                return;
            // ★ 模型 / 思考等级状态（B23）—— 探针 + 事件增量推来的 ✓
            case "modelInfo": {
                // ★ 加一条日志（B25 调试：模型/思考按钮不显示时排查用 ✓）
                //   → 日志会走到 VS Code 的输出面板 ✓
                const mi = (data.payload ?? {}) as {
                    model?: string;
                    provider?: string;
                    thinkingLevel?: string;
                };
                log.info(
                    `[modelInfo] model=${mi.model ?? ""} provider=${mi.provider ?? ""} thinking=${mi.thinkingLevel ?? ""}`,
                );
                setModelInfo(mi as never);
                return;
            }
            // ★★ B35：删掉 case "settings" ✗
            //   设置面板已搬到编辑器区 ✓ 它有自己的 post 通道
            //   （原来是 chatView.post("settings", …) → 现在 settingsPanel.post ✓）
            // ★ 技能列表（B25）
            // ★ B29：VS Code 主题（代码高亮用 ✗ 逐色统一 ✓）
            case "theme":
                setHighlightTheme((data.payload ?? {}) as never);
                return;
            // ★ B27：斜杠补全的命令列表 ✓
            case "commands":
                setCommands(((data.payload ?? {}) as { commands?: unknown }).commands as never);
                return;
            // ★ 侧栏交互提示（B26）：完整问答已搬到编辑器面板 ✓
            case "interactionHint":
                showInteractionHint((data.payload ?? {}) as never);
                return;
            // ★ B26：交互面板关闭后，焦点回到输入框 ✓
            case "focusInput":
                inputEl.focus();
                return;
            // ★ 宿主让前端做的两个动作（B25）
            case "insertToInput": {
                const t = (data.payload as { text?: string })?.text ?? "";
                inputEl.value = inputEl.value ? inputEl.value + "\n" + t : t;
                autoGrow();
                inputEl.focus();
                return;
            }
            case "sendText": {
                const t = (data.payload as { text?: string })?.text ?? "";
                if (!t) return;
                vscode.postMessage({ kind: "prompt", text: t });
                return;
            }
            case "modelList":
                showModelPicker((data.payload ?? []) as never);
                return;
            case "thinkingLevels": {
                const pl = (data.payload ?? {}) as { levels?: string[]; current?: string };
                showThinkingPicker(pl.levels ?? [], pl.current);
                return;
            }
            case "queueUpdate": {
                // ★ 队列变化（B20）：steering 里还有我的文本 = 还没被 AI 吃进去 ✓
                setQueueing((data.payload as { steering?: string[] })?.steering ?? []);
                return;
            }
            case "inserting": {
                // ★ 后端说“这条被转成了 steer”→ 先画一个【待插入】气泡 ✓
                showInserting(String((data.payload as { text?: string })?.text ?? ""));
                return;
            }
            case "toggleNotices":
                setExpanded();
                return;
            case "sessionTitle": {
                // ★ 按钮行中间的当前会话名（含动态字号 ✓）
                const nm = String(data.payload ?? "");
                setSessionTitle(nm);
                return;
            }
            case "noticesCleared":
                clearNotices();
                return;
        }
    });
}

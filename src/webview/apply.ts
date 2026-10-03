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
import { messagesEl } from "./dom.js";
import { ui } from "./state.js";
import { createBubble, refreshForkButtons, removePending, showPending } from "./bubbles.js";import { appendSegment } from "./segments.js";
import { createThinkingBubble, markThinkDone } from "./thinking.js";
import { createToolBubble, ensureResultHost, markStreamingDone, renderArgs, renderResultParts, setToolState } from "./tool.js";
import { appendStopNote, showRetryNotice } from "./notices.js";
import { updateStatusBar } from "./topbar.js";
import { appendNotice, clearNotices, removeNotice, renderNotices, resetNotices, setExpanded } from "./noticeboard.js";
import { applyStyleVars, autoGrow, setAgentState, showCwd } from "./input.js";
import { setupSessions, setCurrentCwd, renderSessions, setSessionTitle } from "./sessions.js";

/** 气泡快照的形状（对应插件端 Bubble ✓） */
interface SnapBlock {
    type: string;
    text?: string;
    toolName?: string;
    toolCallId?: string;
    args?: unknown;
    resultParts?: unknown[];
    resultIsError?: boolean;
    partialParts?: unknown[];
    executing?: boolean;
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
                renderArgs(last, blk.args);
                // 优先显示最终结果，其次显示执行中的实时内容
                if (blk.resultParts !== undefined) {
                    renderResultParts(last, blk.resultParts, blk.resultIsError === true, false);
                    setToolState(last, blk.resultIsError ? "error" : "ok");
                } else if (blk.partialParts !== undefined) {
                    renderResultParts(last, blk.partialParts, false, blk.executing === true);
                    setToolState(last, blk.executing ? "running" : "ok");
                    if (blk.executing) ensureResultHost(last).dataset.streaming = "true";
                } else {
                    setToolState(last, blk.executing ? "running" : "ok");
                }
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
                last.textContent += blk.text ?? "";
            }
            ui.bubble = last;
        }
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

        case "toolStart":
            removePending();
            setToolState(createToolBubble(p.callId as string, p.name as string), "running");
            return;

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
            // ★ 参数拼完 → 渲染成键值对
            if (ui.bubble) renderArgs(ui.bubble, p.args);
            return;

        case "toolResult": {
            // 结果在另一条消息里 → 按 callId 找回工具气泡
            const bubble = findTool(p.callId as string);
            if (bubble) {
                renderResultParts(bubble, p.parts as unknown[], p.isError === true, false);
                setToolState(bubble, p.isError ? "error" : "ok");
                markStreamingDone(bubble);
            }
            return;
        }

        case "toolExecStart": {
            // ★ 工具开始执行 → 结果区先建好，头部显示"执行中…"
            const bubble = findTool(p.callId as string);
            if (bubble) {
                setToolState(bubble, "running");
                ensureResultHost(bubble).dataset.streaming = "true";
            }
            return;
        }

        case "toolExecUpdate": {
            // ★ 执行中的实时输出（累积全文 → 整块替换 ✓）
            const bubble = findTool(p.callId as string);
            if (bubble) {
                ensureResultHost(bubble).dataset.streaming = "true";
                renderResultParts(bubble, p.parts as unknown[], false, true);
            }
            return;
        }

        case "toolExecEnd": {
            const bubble = findTool(p.callId as string);
            if (bubble) {
                markStreamingDone(bubble);
                // 状态先按 exec 的 isError 定；若随后 toolResult 到达会再覆盖一次 ✓
                setToolState(bubble, p.isError ? "error" : "ok");
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
export function setupHostBridge(): void {
    window.addEventListener("message", (event) => {
        const data = (event.data ?? {}) as { kind?: string; payload?: unknown };

        switch (data.kind) {
            case "styleVars":
                applyStyleVars(data.payload as Record<string, string>);
                autoGrow(); // ★ 配置变了（如行数/字号）→ 重新算高度与留白
                // ★ 再按新配置重画已渲染内容（否则行为类参数改了不起作用 ✗）
                //   空闲时立即生效；流式中会延后到 agent_settled ✓
                replayForConfig();
                return;
            case "modelLimits":
                ui.modelLimits = (data.payload ?? {}) as Record<string, number>;
                return;
            case "cwd":
                showCwd(String(data.payload ?? ""));
                // ★ 会话面板也要知道当前 cwd（决定哪个分组默认展开 ✓）
                setCurrentCwd(String(data.payload ?? ""));
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
                return;
            case "patch":
                applyPatch((data.payload ?? {}) as Record<string, unknown>);
                // ★ 每批增量后扫一次（幂等 ✓ 新到的用户消息会把上一组的刀补上 ✓）
                refreshForkButtons();
                return;
            case "toggleNotices":
                setExpanded();
                return;
            case "sessions":
                // ★ 会话列表（按 cwd 分组渲染 ✓）
                renderSessions((data.payload ?? []) as never);
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

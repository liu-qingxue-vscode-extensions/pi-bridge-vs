/**
 * ChatState —— 插件端的聊天状态（**权威状态**）
 *
 * 【为什么权威状态在插件端，而不是 webview？】
 * VS Code 的 webview 在切走 tab 时可能被【销毁】（默认行为，省内存）。
 * 若状态放在 webview，一旦销毁就丢失（切回来是空白）。
 * 所以 webview 只是"完全不长脑子的显示器"：
 *   状态在这里维护，webview 重建时从这里【重放快照】。
 *
 * 【数据流】
 *   pi 事件 → format-backend 翻译 → ChatPatch → ChatState.apply()
 *        → 通知订阅者（ChatView）→ 增量推送 → webview 渲染
 *   webview 重建 → 发 "ready" → ChatView 用 snapshot() 重放全量
 */

import type { Block, Bubble, ChatPatch, ChatRole, Notice } from "./chat-types.js";

// 对外保持兼容：旧的 `from "./chat-state.js"` 导入仍然可用
export type { Block, BlockType, Bubble, ChatPatch, ChatRole, Notice, NoticeLevel } from "./chat-types.js";

export class ChatState {
    /** 所有气泡（权威状态） */
    private readonly bubbles: Bubble[] = [];

    /**
     * ★ 通知环形缓冲（★ 不进会话文件 → 独立于 bubbles ✓）
     *   为什么单独存？因为通知是“过程状态”，无法从 pi 重放（它就不在文件里 ✗）
     *   但视图重开时要能恢复 → 所以放进 snapshot ✓（插件重启才清除 ✓）
     */
    private readonly notices: Notice[] = [];
    /** 通知序号（自增；用于关闭单条 / 前端渲染 key）*/
    private noticeSeq = 1;
    /** 环形缓冲上限（由配置 pi-bridge.notice.bufferSize 决定 ✓）*/
    private noticeLimit = 50;

    /** 状态变化的订阅者（ChatView 订阅它，把变化推给 webview） */
    private readonly listeners = new Set<(patch: ChatPatch) => void>();

    /** 订阅状态变化，返回取消订阅函数 */
    onChange(listener: (patch: ChatPatch) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /** 全量快照（webview 重建时重放用）★ 通知一起带出去 ✓ */
    snapshot(): { bubbles: readonly Bubble[]; notices: readonly Notice[] } {
        return { bubbles: this.bubbles, notices: this.notices };
    }

    /** ★ 清空全部气泡（pi 重启后调用）
     *  为什么？pi 换了新进程 → 它【已经不认识】旧对话了 ✗
     *  前端若还挂着旧气泡，接着聊会得出错误结果（上下文对不上）✓ */
    reset(): void {
        this.bubbles.length = 0;
    }

    /** ★ 设置通知容量（环形缓冲上限）；超出部分【丢最旧的】✓ */
    setNoticeLimit(n: number): void {
        if (!Number.isFinite(n) || n <= 0) return;
        this.noticeLimit = Math.floor(n);
        this.trimNotices();
    }

    /** ★ 移除单条通知（前端点 ✕ 时由 main.ts 调用）
     *  ★ 必须【广播】给前端：前端只负责发指令、不自己做乐观删除
     *    （否则前后端两份镜像会不一致 ✗ —— 这正是“点了没反应”的原因）*/
    removeNotice(id: number): void {
        const i = this.notices.findIndex((n) => n.id === id);
        if (i < 0) return;
        this.notices.splice(i, 1);
        this.emit({ kind: "noticeRemove", id });
    }

    /** ★ 清空全部通知（面板头部的“清空”按钮）*/
    clearNotices(): void {
        this.notices.length = 0;
    }

    /** 环形缓冲裁剪：超过上限就丢最早的 */
    private trimNotices(): void {
        while (this.notices.length > this.noticeLimit) this.notices.shift();
    }

    /**
     * 统一入口：应用一条渲染指令
     * （由 main.ts 把 pi 事件交给 format 层翻译后调用）
     */
    apply(patch: ChatPatch): void {
        // 任务级状态不进气泡列表（由 main.ts 分流直接送给视图）
        if (patch.kind === "agentState") return;

        switch (patch.kind) {
            case "startBubble":
                // 用户消息可能自带内容（非流式，内容在 message_start 里）→ 包成一个 text 块；
                // AI 消息这里一般是空串，靠后续 append 累积。
                this.bubbles.push({
                    role: patch.role,
                    blocks: patch.text ? [{ type: "text", text: patch.text }] : [],
                    done: false,
                });
                break;

            case "append": {
                const last = this.bubbles.at(-1);
                // 防御：没有打开的气泡（或已封口）就忽略 —— 数据异常时不崩
                if (!last || last.done) return;
                const lastBlock = last.blocks.at(-1);
                if (lastBlock && lastBlock.type === patch.block) {
                    lastBlock.text += patch.text; // 同一块 → 追加
                } else {
                    last.blocks.push({ type: patch.block, text: patch.text }); // 新块
                }
                break;
            }

            case "endBubble": {
                const last = this.bubbles.at(-1);
                // ★ 用 break 而不是 return ✗
                //   原因：return 会跳过函数末尾的 this.emit(patch) → 前端【收不到】这个 patch ✗
                if (!last) break;
                // ★ token 用量 + 模型名【不受封口判断影响】✓
                //   实测：重试时多条 assistant message_end 连续到达，
                //   只有第一条能封口气泡 ✓ 后续的 last.done === true ✗
                //   而【成功】那条往往就是后面的 → 若把它丢掉，状态栏就永远显示 0 ✗✗✗
                if (patch.usage) last.usage = patch.usage;
                if (patch.model) last.model = patch.model;
                // 封口：只有“角色匹配且未封口”才封
                //   （原因：pi 的 toolResult 消息也会发 message_end，不能误封 assistant 气泡）
                if (!last.done && last.role === patch.role) {
                    last.done = true;
                    // ★ 异常结束原因（length / aborted）→ 前端在气泡底部补一行提示
                    if (patch.stopReason) last.stopReason = patch.stopReason;
                }
                break;
            }

            // ===== 工具气泡的生命周期（toolcall_* + toolResult）=====
            case "toolStart": {
                const last = this.bubbles.at(-1);
                if (!last || last.done) return;
                last.blocks.push({
                    type: "tool",
                    text: "",
                    toolName: patch.name,
                    toolCallId: patch.callId,
                    toolDone: false,
                    argsText: "",
                });
                break;
            }

            case "toolArgs": {
                const blk = this.bubbles.at(-1)?.blocks.at(-1);
                if (blk?.type !== "tool") return;
                blk.argsText = (blk.argsText ?? "") + patch.text; // 流式拼装（备查）
                break;
            }

            case "toolEnd": {
                const blk = this.bubbles.at(-1)?.blocks.at(-1);
                if (blk?.type !== "tool") return;
                blk.toolDone = true;
                blk.args = patch.args; // ★ 解析好的对象 → 前端渲染成键值对
                break;
            }

            // 思考边界包：不改数据，只为让前端能计时/切换折叠头（下方 emit 会转发出去）
            case "thinkStart":
            case "thinkEnd":
                break;

            case "toolResult": {
                // ★ 结果可能来自【另一条消息】→ 按 callId 在所有气泡里找回那个工具块
                const blk = this.findToolBlock(patch.callId);
                if (!blk) return; // 关联不上就忽略（不崩）
                blk.resultParts = patch.parts;
                blk.resultIsError = patch.isError;
                // ★ B39：会话文件里 toolResult 顶层就带 details（edit 的 patch ✓）
                //   不存下来 ⇒ webview 重建 / 切会话后 diff 就没了 ✓
                if (patch.details !== undefined) blk.details = patch.details;
                break;
            }

            // ===== 工具【执行】阶段（tool_execution_*）=====
            case "toolExecStart": {
                const blk = this.findToolBlock(patch.callId);
                if (!blk) return;
                blk.executing = true;
                break;
            }

            case "toolExecUpdate": {
                const blk = this.findToolBlock(patch.callId);
                if (!blk) return;
                // ★ 累积全文 → 【直接替换】（追加会重复一万遍 ✗）
                blk.partialParts = patch.parts;
                break;
            }

            case "toolExecEnd": {
                const blk = this.findToolBlock(patch.callId);
                if (!blk) return;
                blk.executing = false;
                // ★ B39：实时路径的 details 在这条事件上（会话重放那条在 toolResult 上 ✓）
                if (patch.details !== undefined) blk.details = patch.details;
                break;
            }

            // ★ 重连提示：【不改状态】—— 仅透传给前端
            //   （原因：auto_retry_start 不进会话文件 → 不应该进 bubbles/snapshot ✓
            //    这样 webview 重建后它自然消失，和语义一致 ✓）
            case "retryNotice":
            // ★ 压缩（B22）：同理【不改状态】✗ —— 它是过程事件 ✓
            //   实测：compaction_start / compaction_end【都不进会话文件】✗
            //   → 不该进 bubbles/snapshot ✓ webview 重建后自然消失 ✓ 语义一致 ✓
            case "compaction":
                break;

            // ★ 通知：分配 id + 时间，入环形缓冲，然后【带 id 广播】✓
            case "notice": {
                const notice: Notice = {
                    id: this.noticeSeq++,
                    text: patch.text,
                    level: patch.level,
                    time: Date.now(),
                };
                this.notices.push(notice);
                this.trimNotices();
                // ★ 用带 id 的版本广播（前端靠它做“关闭单条” ✓）
                //   → 必须 return：否则末尾还会 emit 一次【没 id 的】原 patch ✗
                this.emit({
                    kind: "notice",
                    text: notice.text,
                    level: notice.level,
                    id: notice.id,
                    time: notice.time,
                });
                return;
            }

            // ★ 关闭单条通知（前端点 ✕）
            case "noticeRemove": {
                const i = this.notices.findIndex((n) => n.id === patch.id);
                if (i >= 0) this.notices.splice(i, 1);
                break;
            }
        }
        this.emit(patch);
    }

    /** 按 callId 在所有气泡的内容块里找工具块 */
    private findToolBlock(callId: string): Block | undefined {
        for (const bubble of this.bubbles) {
            for (const blk of bubble.blocks) {
                if (blk.type === "tool" && blk.toolCallId === callId) return blk;
            }
        }
        return undefined;
    }

    private emit(patch: ChatPatch): void {
        for (const listener of this.listeners) {
            listener(patch);
        }
    }
}

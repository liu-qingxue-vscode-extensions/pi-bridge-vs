/**
 * session-file —— ★★ B42：直接读 pi 的会话文件（jsonl），不经子进程
 *
 * 【为什么要它】
 *   原先渲染历史要问 pi（get_messages ✗ RPC ⇒ 拉起子进程）
 *   但实测发现：**pi 也只是把会话文件里的东西传一遍** ✓
 *     · 会话文件是 append-only 的事件流（每行一个 JSON）
 *     · 里面的 type="message" 记录，其 `.message` 字段与 get_messages 的返回【同构】
 *   ⇒ 那我们自己读就行 ✗ 打开/切会话不必启动 pi ✓（真懒加载）
 *
 * 【会话文件长什么样】（实测 1516 行的事件流）
 *   type=message                ← ★ 消息本体（.message 里是 role/content/...）
 *   type=model_change           ← 模型切换点（顶栏用）
 *   type=session_info           ← 会话名（顶栏用）
 *   type=thinking_level_change  ← 思考级别变化
 *   type=custom / custom_message / context_edit / compaction / session
 *   ★ 每条都有 parentId ⇒ 是棵树（分叉功能的数据源 ✗ 暂未用）
 *
 * 【为什么不直接读 pi 的 SDK】
 *   本文件【零依赖】（只有 node:fs）⇒ 可以被 Node 脚本直接测（见 scripts/check-session-file.mjs）
 */

import { readFileSync } from "node:fs";
import type { CompactionInfo, ReplayMessage } from "./replay.js";

/** 从会话文件里抽取的"当前状态"（事件流里最后一处变化生效）*/
export interface SessionLiveState {
    /** 模型（来自最后一条 assistant 消息或 model_change）*/
    model?: string;
    provider?: string;
    /** 思考级别 */
    thinkingLevel?: string;
    /** 会话显示名（session_info）*/
    name?: string;
    /** 工作目录（文件头 session 记录里）*/
    cwd?: string;
    /** 记录条数（诊断用）*/
    records: number;
}

export interface SessionFileData {
    /** ★ 消息数组 —— 与 get_messages 的返回【同构】✗ 可直接喂 messagesToPatches */
    messages: ReplayMessage[];
    live: SessionLiveState;
}

/** 一条已读入的条目（裁剪需要按 id 定位 ✗ 所以不能边读边丢）*/
interface Entry {
    id?: string;
    kind: "message" | "compaction";
    /** kind=message */
    msg?: ReplayMessage;
    /** kind=compaction */
    comp?: CompactionInfo;
    /** kind=compaction：保留起点（第一条不压的条目 id）*/
    firstKeptEntryId?: string;
}

/**
 * ★★ B46：压缩裁剪
 *
 * 【pi 怎么做的】（源码 session-manager.js 的 buildContextEntries）
 *   · 压缩条目【自己变成一条消息】（即那条摘要）
 *   · 只看【最新那个】compaction（老的贡献为空 ✗ 等于不存在）
 *   · 保留范围 = [firstKeptEntryId … 末尾] ✗ 它之前的统统丢弃
 *   ★ 每次压缩的输入 = 上一次的摘要 + 新增对话 ⇒ 老摘要【已被吸收】进新摘要 ✓
 *      （这就是用户说的"嵌套"✗ 消费时它塌缩成一层 ✓）
 *
 * 【我们照着做】：渲染时也只显示【最新】的压缩气泡 ✗ 它之前的消息不渲染 ✓
 *   （用户明确要求：与其显示一堆内容重复的摘要 ✗ 不如只显示一个 ✓）
 *
 * ★ 安全原则：指针找不到 ⇒ 【从 0 开始】⇒ 宁可多显示也不丢内容 ✓
 */
function applyCompaction(entries: Entry[]): ReplayMessage[] {
    let last: Entry | null = null;
    for (const e of entries) {
        if (e.kind === "compaction" && e.comp) last = e;
    }

    const out: ReplayMessage[] = [];
    if (!last) {
        for (const e of entries) if (e.kind === "message" && e.msg) out.push(e.msg);
        return out;
    }

    // ★ 压缩气泡排在最前（它代表"这之前的一切"✓）
    out.push({ role: "__compaction", compaction: last.comp });

    const at = last.firstKeptEntryId ? entries.findIndex((e) => e.id === last!.firstKeptEntryId) : -1;
    for (let i = at >= 0 ? at : 0; i < entries.length; i++) {
        const e = entries[i];
        if (e.kind === "message" && e.msg) out.push(e.msg);
    }
    return out;
}

/**
 * 读一个会话文件 ⇒ 可直接喂 messagesToPatches 的消息列表
 * ★ 宽松：坏行跳过（会话文件是 append-only ✗ 进程被杀时可能留半行）
 */
export interface ReadOptions {
    /**
     * ★★ B47：不裁剪压缩 ⇒ 返回【全部】消息（含已被压缩掉的部分）
     *
     * 【默认 false（裁剪）】渲染的是"pi 实际看到的上下文"✓
     * 【true（raw）】给"完整历史"面板用 —— 那里要看【全部发生过的事】✓
     */
    raw?: boolean;
}

export function readSessionFile(filePath: string, opts?: ReadOptions): SessionFileData {
    const live: SessionLiveState = { records: 0 };
    /** ★ 先按【文件顺序】收下条目（裁剪要看 id ✗ 所以不能边读边丢） */
    const entries: Entry[] = [];

    let raw: string;
    try {
        raw = readFileSync(filePath, "utf-8");
    } catch {
        return { messages: [], live };
    }

    for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        let rec: Record<string, unknown>;
        try {
            rec = JSON.parse(t) as Record<string, unknown>;
        } catch {
            continue; // 半行 / 坏行 ⇒ 跳过
        }
        live.records++;
        const type = rec.type;
        const id = typeof rec.id === "string" ? rec.id : undefined;

        if (type === "message") {
            const m = rec.message;
            if (m && typeof m === "object") {
                entries.push({ id, kind: "message", msg: m as ReplayMessage });
                // 顺手更新"活状态"（assistant 消息自带 model / thinkingLevel）
                const mm = m as { role?: unknown; model?: unknown; provider?: unknown; thinkingLevel?: unknown };
                if (mm.role === "assistant") {
                    if (typeof mm.model === "string") live.model = mm.model;
                    if (typeof mm.provider === "string") live.provider = mm.provider;
                    if (typeof mm.thinkingLevel === "string") live.thinkingLevel = mm.thinkingLevel;
                }
            }
            continue;
        }

        // ── 压缩条目（★ B46）：摘要 + 保留起点 ✗ 它决定"哪些历史不渲染" */
        if (type === "compaction") {
            if (typeof rec.summary === "string" && rec.summary) {
                entries.push({
                    id,
                    kind: "compaction",
                    firstKeptEntryId: typeof rec.firstKeptEntryId === "string" ? rec.firstKeptEntryId : undefined,
                    comp: {
                        summary: rec.summary,
                        tokensBefore: typeof rec.tokensBefore === "number" ? rec.tokensBefore : undefined,
                        time: typeof rec.timestamp === "string" ? rec.timestamp : undefined,
                    },
                });
            }
            continue;
        }

        // ── 其余事件型：只挑我们关心的几个 ──
        if (type === "model_change") {
            if (typeof rec.modelId === "string") live.model = rec.modelId;
            if (typeof rec.provider === "string") live.provider = rec.provider;
        } else if (type === "thinking_level_change") {
            if (typeof rec.thinkingLevel === "string") live.thinkingLevel = rec.thinkingLevel;
        } else if (type === "session_info") {
            if (typeof rec.name === "string") live.name = rec.name;
        } else if (type === "session") {
            if (typeof rec.cwd === "string") live.cwd = rec.cwd;
        }
    }

    if (opts?.raw) {
        // ★★ B45：raw 模式 —— 全都放出来 ✗ 但标注"哪些已经被压掉了" ✓
        //
        // 【怎么算】跟 pi 的语义对齐（见 applyCompaction 的注释）：
        //   最后一个 compaction 的 firstKeptEntryId ⇒ 它【之前】的消息都已被压缩 ✓
        //   之前的那些老 compaction 事件本身【也算】（它们的内容已被新摘要吸收 ✓）
        //
        // ★ 为什么要标：完整历史面板是"看档案"✗ 得让用户一眼看出
        //   "从哪儿开始，pi 已经不记得原文了"（那之后才是它真读得到的 ✓）
        let boundary = entries.length; // 未压缩起点（默认：全都算已压缩）
        for (let i = entries.length - 1; i >= 0; i--) {
            const e = entries[i];
            if (e.kind === "compaction" && e.firstKeptEntryId) {
                const at = entries.findIndex((x) => x.id === e.firstKeptEntryId);
                boundary = at >= 0 ? at : 0;
                break;
            }
        }

        const all: ReplayMessage[] = [];
        for (let i = 0; i < entries.length; i++) {
            const e = entries[i];
            const compacted = i < boundary;
            if (e.kind === "compaction" && e.comp) {
                all.push({ role: "__compaction", compaction: e.comp, compacted });
            } else if (e.kind === "message" && e.msg) {
                // ★ 不污染原对象（它可能被别处引用 ✓）⇒ 浅拷贝加标记 ✓
                all.push(compacted ? { ...e.msg, compacted: true } : e.msg);
            }
        }
        return { messages: all, live };
    }
    return { messages: applyCompaction(entries), live };
}

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
import type { ReplayMessage } from "./replay.js";

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

/**
 * 读一个会话文件
 * ★ 宽松：坏行跳过（会话文件是 append-only ✗ 进程被杀时可能留半行）
 */
export function readSessionFile(filePath: string): SessionFileData {
    const messages: ReplayMessage[] = [];
    const live: SessionLiveState = { records: 0 };

    let raw: string;
    try {
        raw = readFileSync(filePath, "utf-8");
    } catch {
        return { messages, live };
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

        if (type === "message") {
            const m = rec.message;
            // ★ 原样收下（ReplayMessage 是宽松形状 ✗ 多出来的字段无害）
            if (m && typeof m === "object") messages.push(m as ReplayMessage);
            // 顺手更新"活状态"（assistant 消息自带 model / thinkingLevel）
            const mm = m as { role?: unknown; model?: unknown; provider?: unknown; thinkingLevel?: unknown };
            if (mm.role === "assistant") {
                if (typeof mm.model === "string") live.model = mm.model;
                if (typeof mm.provider === "string") live.provider = mm.provider;
                if (typeof mm.thinkingLevel === "string") live.thinkingLevel = mm.thinkingLevel;
            }
            continue;
        }

        // ── 事件型：只挑我们关心的几个 ──
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

    return { messages, live };
}

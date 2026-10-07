/**
 * pi-selfcheck —— ★★ B42：启动期自检（两个前提）
 *
 * 【为什么需要】
 *   用户装完扩展，什么都没配 ⇒ 我们需要知道两件事：
 *     ① pi 本体能不能启动   ← 不能 ⇒ 一切免谈（连会话都读不了）
 *     ② 数据目录能不能用     ← 不能用 ⇒ 会话列表空 ✗ 设置会写到错地方（危险）
 *   而【默默失败】是最糟的体验（用户：输出面板里啥都看不到 ⇒ 不知道哪儿错了）
 *
 * 【为什么这里跑 `pi -v`】
 *   用户提的办法 ✗ 一举两得：
 *     · 它证明"我们真能启动这个 pi"（比检查文件存在可靠 ✗ 还能发现权限/运行时问题）
 *     · 顺便拿到版本号（替代原先从 SDK 读 VERSION 的做法 ✓）
 *   ★ 用 `node <cliPath> -v` 而不是 `pi -v`：
 *     因为扩展实际就是用 `node <cliPath>` 启动它的（见 rpc-client.ts ✗ 保持一致 ✓）
 *
 * 【检测结果的含义】（哪个失败该做什么）
 *   pi 失败     ⇒ ★ 通知（醒目 ✗ 带"去设置"）+ pi 相关功能不可用
 *   agentDir 失败 ⇒ 通知（不阻断 ✗ 仍可用默认路径新建会话）
 *   ★ 注意：agentDir【不存在不算错】✗ pi 自己会创建 ✗
 *     我们只是不该在错误的地方创建配置 ✗ 所以这里只报告，不擅自创建 ✓
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SelfCheck {
    /** pi 本体 */
    pi: {
        ok: boolean;
        cliPath: string;
        version?: string;
        error?: string;
    };
    /** 数据目录 */
    agent: {
        ok: boolean;
        dir: string;
        settingsPath: string;
        /** settings.json 是否存在（不存在不代表错 ✗ 只是"用户还没配过"）*/
        hasSettings: boolean;
        /** 不 ok 时的原因（给用户看的）*/
        reason?: string;
    };
    /**
     * ★★ B43：能不能发 prompt（= 能不能让 pi 干真活）
     *
     * 【为什么单独一个字段】用户定的规则：
     *   "只要 setting 读不了 / 派本体找不到 ⇒ 锁住 prompt 口 ✗ 不让它做任何与 pi 有关的操作。
     *    其他它能做的操作就是看 ✗ 可以看 ✗ 随便它看 ✓"
     *   ★ 因为 prompt 是唯一【让 pi 真的动手】的操作（读文件 / 改代码 / 跑命令 ✓）
     *     前提不对时动手 ⇒ 可能造成真实损害 ✓
     */
    canPrompt: boolean;
    /** 不能 prompt 的原因（前端要显示）*/
    blockReason?: string;
    /** 检测时间（缓存用）*/
    at: number;
}

export interface SelfCheckInput {
    /** pi CLI 的绝对路径（来自 resolvePiCliPath ✗ 空串 = 找不到）*/
    cliPath: string;
    /** 数据目录（来自 resolvePiAgentDir）*/
    agentDir: string;
}

/**
 * 跑一次自检
 * ★ 全程不抛错（失败都变成结果里的字段 ✗ 让调用方决定怎么说）
 */
export async function runSelfCheck(input: SelfCheckInput): Promise<SelfCheck> {
    const { cliPath, agentDir } = input;
    const result: SelfCheck = {
        pi: { ok: false, cliPath },
        agent: {
            ok: false,
            dir: agentDir,
            settingsPath: path.join(agentDir, "settings.json"),
            hasSettings: false,
        },
        canPrompt: false,
        at: Date.now(),
    };

    // ── ① pi 本体：跑 `node <cli.js> -v` ──
    if (!cliPath) {
        result.pi.error = "没找到 pi（未配置 piCliPath ✗ 自动探测也没找到）";
    } else if (!existsSync(cliPath)) {
        result.pi.error = `配置的路径不存在：${cliPath}`;
    } else {
        try {
            const { stdout } = await execFileAsync(process.execPath, [cliPath, "-v"], {
                timeout: 10_000,
                windowsHide: true,
            });
            const v = stdout.trim().split("\n")[0]?.trim();
            // ★ 版本形如 "1.0.4"（实测）✗ 拿不到也照样算启动成功（能跑就是好的）
            result.pi.ok = true;
            result.pi.version = v || undefined;
        } catch (err) {
            const e = err as { message?: string; stderr?: string; code?: number };
            result.pi.error = (e.stderr?.trim() || e.message || "启动失败").slice(0, 200);
        }
    }

    // ── ② 数据目录：能不能【安全地动它】──
    //   ★ 目录不存在【不算错】（pi 首次启动会创建 ✓）
    //   ★ 但 settings.json【存在却读不出来】是错的（文件坏了 ✗ 我们再写下去会毁数据 ✓）
    const settingsPath = path.join(agentDir, "settings.json");
    result.agent.hasSettings = existsSync(settingsPath);
    if (result.agent.hasSettings) {
        try {
            const raw = readFileSync(settingsPath, "utf-8");
            const obj = JSON.parse(raw) as unknown;
            if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
                result.agent.ok = false;
                result.agent.reason = `settings.json 不是一个对象（格式不对）：${settingsPath}`;
            } else {
                result.agent.ok = true;
            }
        } catch (e) {
            result.agent.ok = false;
            result.agent.reason = `settings.json 读不了 / 解析失败：${
                e instanceof Error ? e.message : String(e)
            }`;
        }
    } else {
        result.agent.ok = true; // 还没配过 ⇒ 正常（pi 会创建）
    }

    // ── ③ 汇总：能不能发 prompt ──
    //   ★ 用户规则：pi 本体找不到 / setting 读不了 ⇒ 锁 prompt（不让它干真活 ✓）
    //     其余操作（看会话 / 看设置 / 看技能）都无害 ✗ 不锁 ✓
    if (!result.pi.ok) {
        result.canPrompt = false;
        result.blockReason = `pi 不可用：${result.pi.error ?? "未知原因"}`;
    } else if (!result.agent.ok) {
        result.canPrompt = false;
        result.blockReason = result.agent.reason ?? "pi 的配置读不了";
    } else {
        result.canPrompt = true;
    }

    return result;
}

/** 人话版摘要（通知 / 日志用）*/
export function describeSelfCheck(r: SelfCheck): string {
    const lines: string[] = [];
    if (r.pi.ok) {
        lines.push(`✓ pi 可用（${r.pi.version ?? "版本未知"}）`);
    } else {
        lines.push(`✗ pi 不可用：${r.pi.error ?? "未知原因"}`);
    }
    if (!r.agent.ok) {
        lines.push(`✗ 数据目录不可用：${r.agent.dir}`);
    } else if (!r.agent.hasSettings) {
        lines.push(`· 数据目录还没有 settings.json（首次使用 ✗ 正常）`);
    } else {
        lines.push(`✓ 数据目录 ${r.agent.dir}`);
    }
    return lines.join("\n");
}

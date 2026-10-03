/**
 * settings.ts —— pi 的 settings.json 读写（B24）
 *
 * 【为什么需要它？】
 *   · RPC 【完全没有】settings 接口 ✗（实测 grep 过 ✓）
 *   · 但 pi 的 settings.json 里有很多【与我们直接相关】的配置 ✓：
 *       defaultModel / defaultThinkingLevel / enabledModels
 *       compaction / steeringMode / retry / sessionDir / httpProxy …
 *   · 而且 ★ sessionDir 会改变【会话文件的位置】✗
 *     → 我们还硬编码 ~/.pi/agent/sessions 的话【读不到任何会话】✗
 *       （用户原话："我有概率会出错，不是有概率是一定会出错"✓ 完全正确 ✓）
 *
 * 【并发问题（重要 ✗）】
 *   pi 进程自己也会写这个文件 ✗（比如 lastChangelogVersion ✓）
 *   pi 内部用 SettingsManager.withLock(...) 做保护 ✓
 *   我们的对策：★ 只在【写入瞬间】重新读一次 → 只改自己的字段 → 原子写 ✓
 *     ① 读-改-写（不能拿旧快照覆盖 ✓）
 *     ② temp 文件 + rename（避免写一半崩了毁文件 ✓）
 *     ③ 未知字段【原样保留】✓（不能把 pi 的字段吃掉 ✓）
 *
 * 【优先级（照抄 pi 的语义 ✓）】
 *   CLI --session-dir  >  settings.sessionDir  >  默认 <agentDir>/sessions
 */
import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { logInfo, logWarn, logDebug } from "../logger.js";

/** settings.json 的路径（global scope ✓ 我们只碰 global ✗ 不碰 project ✓）*/
export function settingsPath(): string {
    return path.join(getAgentDir(), "settings.json");
}

/** pi 的 settings 是一大坨自由字段 ✓ 我们不做严格建模 ✗（免得 pi 加字段就崩 ✓）*/
export type PiSettings = Record<string, unknown>;

/** ★ 读一次（每次从磁盘读 ✓ 简单且永远最新 ✓ 文件不大 ✓）*/
export function readSettings(): PiSettings {
    try {
        const raw = fs.readFileSync(settingsPath(), "utf8");
        const obj = JSON.parse(raw) as unknown;
        if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj as PiSettings;
        logWarn(`settings.json 不是一个对象（忽略）`);
        return {};
    } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== "ENOENT") logWarn(`读 settings.json 失败: ${e.message}`);
        return {};
    }
}

/**
 * ★ 原子写入（读-改-写 ✓）
 *
 * @param patch 要改的字段（会【合并】进最新内容 ✓ 不是整文件覆盖 ✗）
 * @returns 写入后的完整设置
 *
 * 【为什么必须"现读现改"？】
 *   如果拿【启动时读的快照】去写 → 会把期间 pi 写的字段【抹掉】✗
 *   （比如 pi 更新了 lastChangelogVersion ✓ 我们一写就没了 ✓）
 */
export function patchSettings(patch: PiSettings): PiSettings {
    const file = settingsPath();
    const current = readSettings();
    const next: PiSettings = { ...current, ...patch };
    const tmp = `${file}.pi-bridge.tmp`;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(next, null, 4) + "\n", "utf8");
        fs.renameSync(tmp, file); // ★ 原子替换 ✓
        logInfo(`settings.json 已更新：${Object.keys(patch).join(", ")}`);
        return next;
    } catch (err) {
        logWarn(`写 settings.json 失败: ${(err as Error).message}`);
        try {
            fs.unlinkSync(tmp);
        } catch {
            /* ignore */
        }
        throw err;
    }
}

/**
 * ★ 会话根目录（sessionDir 变量化的落点 ✓）
 *
 * 优先级：CLI --session-dir > settings.sessionDir > <agentDir>/sessions
 *
 * ★ 为什么要检查 launchArgs？因为用户可能用启动参数指定 ✓
 *   （那样 settings 里的值会被 CLI 覆盖 ✗ 我们不能看错 ✓）
 *
 * @param launchArgs 我们的 launchArgs 设置（用于提取 --session-dir ✓）
 */
export function resolveSessionRoot(launchArgs: readonly string[] = []): string {
    // ① CLI 优先 ✓
    const i = launchArgs.indexOf("--session-dir");
    if (i >= 0 && launchArgs[i + 1]) {
        const v = launchArgs[i + 1];
        return v.startsWith("~") ? path.join(process.env.HOME ?? "", v.slice(1)) : path.resolve(v);
    }
    // ② settings ✓
    const s = readSettings().sessionDir;
    if (typeof s === "string" && s.trim()) {
        const v = s.trim();
        const abs = v.startsWith("~") ? path.join(process.env.HOME ?? "", v.slice(1)) : v;
        logDebug(`会话根目录来自 settings.sessionDir: ${abs}`);
        return path.resolve(abs);
    }
    // ③ 默认 ✓
    return path.join(getAgentDir(), "sessions");
}

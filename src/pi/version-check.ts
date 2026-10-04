/**
 * version-check.ts —— 版本检测（B24）
 *
 * 【要做什么？】（用户定的 ✓）
 *   “做版本检测，自动检测，检测到有差异就提醒更新了，
 *    并且告知差异，发个通知就好”
 *
 * 【两层】
 *   ① 有没有新版可升级 → 查 npm registry ✓（要网络 ✓）
 *   ② 变更日志是什么 → 读包里的 CHANGELOG.md ✓（本地 ✓ 不用网络 ✓）
 *
 * 【为什么用 pi 自己的 changelog 工具？】
 *   pi 已经提供了 parseChangelog / getNewEntries ✗（utils/changelog.js ✓）
 *   → 一行就能拿到“比 lastVersion 新的条目”✓ 不用自己写 parser ✓
 *   ★ 而且 settings.json 里有 lastChangelogVersion ✓（我们已经在读它 ✓）
 *     它记录“用户上次看过到哪个版本”✓
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logInfo, logWarn } from "../logger.js";

const execFileAsync = promisify(execFile);

/** npm 上的最新版本（失败返回 undefined ✓ 不抛 ✗）*/
export async function fetchLatestVersion(pkg: string, timeoutMs = 20000): Promise<string | undefined> {
    try {
        const { stdout } = await execFileAsync("npm", ["view", pkg, "version"], {
            timeout: timeoutMs,
            // ★ 不要 npm 的彩色/进度输出 ✓ 只要那一行版本号 ✓
            env: { ...process.env, NO_COLOR: "1", npm_config_update_notifier: "false" },
        });
        const v = stdout.trim().split("\n").pop()?.trim();
        return v || undefined;
    } catch (err) {
        // ★ 失败是【正常】的 ✗（离线 / 代理挂了 ✓）不打扰用户 ✓
        logWarn(`版本检测失败（忽略）: ${(err as Error).message.split("\n")[0]}`);
        return undefined;
    }
}

/**
 * ★ 版本比较（只比数字段 ✓ 支持 "1.0.2" 这种简单形式 ✓）
 *
 * @returns 负数 = a < b · 0 = 相等 · 正数 = a > b
 */
export function compareVersion(a: string, b: string): number {
    const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
    const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0) return d;
    }
    return 0;
}

/** ★ 检测结果（给调用方决定怎么提示 ✓）*/
export interface VersionCheckResult {
    current: string;
    latest?: string;
    hasUpdate: boolean;
}

export async function checkPiVersion(
    pkg: string,
    current: string,
): Promise<VersionCheckResult> {
    const latest = await fetchLatestVersion(pkg);
    if (!latest) return { current, hasUpdate: false };
    const hasUpdate = compareVersion(latest, current) > 0;
    logInfo(`版本检测：本地 ${current} · npm 最新 ${latest} · ${hasUpdate ? "★ 有新版 ✓" : "已是最新 ✓"}`);
    return { current, latest, hasUpdate };
}

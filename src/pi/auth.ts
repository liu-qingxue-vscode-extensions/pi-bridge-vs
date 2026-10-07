/**
 * auth.ts —— pi 的凭据文件读写（B24）
 *
 * 【为什么从这里入手？】（用户定的边界 ✓）
 *   “OAUTH 完全不动 ✗ 只管 API ✓ 增删 API ✓”
 *
 * 【auth.json 的实测结构】
 *   {
 *     "deepseek":       { type: "api_key", key: "sk-xxx" },          ← ★ 简单 ✓ 我们能管 ✓
 *     "github-copilot": { type: "oauth", refresh, access, expires,   ← ★ 复杂 ✗ 只读 ✓
 *                         availableModelIds: [...] }
 *   }
 *
 * 【RPC 有没有接口？】★ 没有 ✗（grep login/logout/auth 零命中 ✓）
 *   → 自己读写文件 ✓（和 settings.json 同一套纪律 ✓）
 *
 * ⚠ 这个文件【含密钥】✗：
 *   · 读写都要【原样保留】其他条目 ✓（不能因为改了 A 把 B 弄丢 ✓）
 *   · 日志【绝不打印 key 的值】✗（只打印 provider 名 ✓）
 *   · 原子写（temp + rename ✓）—— 参照 settings.ts ✓
 */
import fs from "node:fs";
import path from "node:path";
import { resolveAgentDir } from "./pi-env.js";
import { logInfo, logWarn } from "../logger.js";

export function authPath(): string {
    return path.join(resolveAgentDir(), "auth.json");
}

/** 一条凭据（只暴露【类型】和【是否有 key】✗ 不暴露 key 本身 ✓）*/
export interface AuthEntry {
    provider: string;
    /** "api_key" | "oauth" | 其他 ✓ */
    type: string;
    /** ★ 能否在 UI 里改 ✗（只有 api_key 能 ✓ oauth 不能 ✓）*/
    editable: boolean;
    /** api_key 的话：key 的【掩码】（sk-…abcd ✓ 用于确认"是哪个 key"）*/
    masked?: string;
    /** oauth 的话：过期时间（人可读 ✓）*/
    expiresAt?: string;
}

function readRaw(): Record<string, unknown> {
    try {
        const raw = fs.readFileSync(authPath(), "utf8");
        const obj = JSON.parse(raw) as unknown;
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
            return obj as Record<string, unknown>;
        }
        return {};
    } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== "ENOENT") logWarn(`读 auth.json 失败: ${e.message}`);
        return {};
    }
}

/** ★ key 掩码（只露头尾 ✗ 中间打码 ✓）*/
function maskKey(v: unknown): string | undefined {
    if (typeof v !== "string" || !v) return undefined;
    if (v.length <= 10) return "…";
    return `${v.slice(0, 4)}…${v.slice(-4)}`;
}

/** 列出所有凭据（★ 不含原始 key ✗）*/
export function listAuth(): AuthEntry[] {
    const raw = readRaw();
    const out: AuthEntry[] = [];
    for (const [provider, v] of Object.entries(raw)) {
        if (!v || typeof v !== "object" || Array.isArray(v)) continue;
        const o = v as Record<string, unknown>;
        const type = typeof o.type === "string" ? o.type : "unknown";
        const editable = type === "api_key"; // ★ 只有它我们能安全地改 ✓
        let expiresAt: string | undefined;
        if (typeof o.expires === "number") {
            try {
                expiresAt = new Date(o.expires).toLocaleString();
            } catch {
                /* ignore */
            }
        }
        out.push({
            provider,
            type,
            editable,
            masked: editable ? maskKey(o.key) : undefined,
            expiresAt,
        });
    }
    out.sort((a, b) => a.provider.localeCompare(b.provider));
    return out;
}

/**
 * ★ 写入 / 更新一个 api_key（= 登录 ✓）
 *
 * 【为什么只允许 api_key？】
 *   oauth 需要【设备码 / 浏览器授权】的完整流程 ✗
 *   我们无法复现 ✓ 硬写进去也可能是坏的 ✓
 *   → 只做 api_key ✓ oauth 引导用户去终端（`pi auth login <provider>` ✓）
 */
export function setApiKey(provider: string, key: string): void {
    const p = provider.trim();
    const k = key.trim();
    if (!p || !k) throw new Error("provider 和 key 都不能为空");
    const raw = readRaw();
    const cur = raw[p];
    if (cur && typeof cur === "object" && !Array.isArray(cur)) {
        const type = (cur as Record<string, unknown>).type;
        // ★ 不覆盖 oauth（会把用户的登录状态搞坏 ✗）
        if (type !== "api_key") {
            throw new Error(`「${p}」不是 api_key 类型（是 ${String(type)} ✗）不能在此修改`);
        }
    }
    raw[p] = { ...(typeof cur === "object" && cur ? cur : {}), type: "api_key", key: k };
    writeRaw(raw);
    // ★ 只记 provider ✗ 绝不记 key ✓
    logInfo(`auth.json 已写入 api_key：${p}`);
}

/**
 * ★ 删除一个凭据（= 登出 ✓）
 *
 * ★★ 只允许删 api_key ✗（B24 用户定的 ✓）
 *   用户原话：“OAUTH 可以看，但是增删的话就碰不了了，
 *              给它做成某种灰色的不可改的项目”✓
 *   → oauth 连删都不行 ✓ 完全只读 ✓（避免把用户的 GitHub 登录搞坏 ✓）
 */
export function removeAuth(provider: string): void {
    const raw = readRaw();
    const cur = raw[provider];
    if (!cur) return;
    const type =
        cur && typeof cur === "object" && !Array.isArray(cur)
            ? (cur as Record<string, unknown>).type
            : undefined;
    if (type !== "api_key") {
        throw new Error(`「${provider}」不是 api_key 类型（是 ${String(type)} ✗）不能在这里删除`);
    }
    delete raw[provider];
    writeRaw(raw);
    logInfo(`auth.json 已删除凭据：${provider}（= 登出 ✓）`);
}

/** 原子写（和 settings.ts 同一套 ✓）*/
function writeRaw(data: Record<string, unknown>): void {
    const file = authPath();
    const tmp = `${file}.pi-bridge.tmp`;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(data, null, 4) + "\n", "utf8");
        // ★ 权限收紧（密钥文件 ✓ 已有的话保留原权限 ✓）
        try {
            fs.chmodSync(tmp, 0o600);
        } catch {
            /* 某些文件系统不支持 ✓ 忽略 */
        }
        fs.renameSync(tmp, file);
    } catch (err) {
        logWarn(`写 auth.json 失败: ${(err as Error).message}`);
        try {
            fs.unlinkSync(tmp);
        } catch {
            /* ignore */
        }
        throw err;
    }
}

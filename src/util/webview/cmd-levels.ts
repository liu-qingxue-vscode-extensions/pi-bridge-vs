/**
 * cmd-levels.ts —— 命令的【危险等级表】（B38）
 *
 * 【表从哪来】
 *   内置一张常用默认表 ✗ 以后可由 ~/.pi/agent/cmd-levels.json 覆盖
 *   （那个文件交给别的小 AI 维护 ✓ 形状见下）
 *
 * 【形状】
 *   { "ls": { "level": "safe", "emoji": "📂" }, "rm": { "level": "danger", "emoji": "☠️" } }
 *   level ∈ safe | warn | danger ✗ 表里没写的 → unknown
 *
 * ★ 这只是【提示】✗ 不是安全机制（命令已经执行了）
 */
export type CmdLevel = "safe" | "warn" | "danger" | "unknown";

export const LEVEL_COLOR: Record<CmdLevel, string> = {
    safe: "#4caf50",
    warn: "#d7a600",
    danger: "#f44336",
    unknown: "#8b949e",
};

interface Entry {
    level?: string;
    emoji?: string;
}

const DEFAULTS: Record<string, Entry> = {
    // 读 / 看
    ls: { level: "safe", emoji: "📂" }, cat: { level: "safe", emoji: "📄" },
    head: { level: "safe", emoji: "📄" }, tail: { level: "safe", emoji: "📄" },
    grep: { level: "safe", emoji: "🔍" }, rg: { level: "safe", emoji: "🔍" },
    find: { level: "safe", emoji: "🔍" }, wc: { level: "safe", emoji: "🔢" },
    pwd: { level: "safe", emoji: "📍" }, echo: { level: "safe", emoji: "💬" },
    tree: { level: "safe", emoji: "🌲" }, file: { level: "safe", emoji: "📎" },
    // 改
    mkdir: { level: "warn", emoji: "📁" }, touch: { level: "warn", emoji: "📄" },
    cp: { level: "warn", emoji: "📋" }, mv: { level: "warn", emoji: "🚚" },
    rm: { level: "warn", emoji: "🗑️" }, chmod: { level: "warn", emoji: "🔧" },
    chown: { level: "warn", emoji: "🔧" }, ln: { level: "warn", emoji: "🔗" },
    kill: { level: "warn", emoji: "💀" }, pkill: { level: "warn", emoji: "💀" },
    git: { level: "warn", emoji: "🌿" }, npm: { level: "warn", emoji: "📦" },
    pnpm: { level: "warn", emoji: "📦" }, yarn: { level: "warn", emoji: "📦" },
    python: { level: "warn", emoji: "🐍" }, python3: { level: "warn", emoji: "🐍" },
    node: { level: "warn", emoji: "🟢" }, docker: { level: "warn", emoji: "🐳" },
    // 危险
    sudo: { level: "danger", emoji: "🔑" }, doas: { level: "danger", emoji: "🔑" },
    rm_rf: { level: "danger", emoji: "☠️" }, dd: { level: "danger", emoji: "☠️" },
    mkfs: { level: "danger", emoji: "☠️" }, fdisk: { level: "danger", emoji: "☠️" },
    shutdown: { level: "danger", emoji: "⛔" }, reboot: { level: "danger", emoji: "⛔" },
    systemctl: { level: "danger", emoji: "⚙️" }, pacman: { level: "danger", emoji: "📦" },
    curl: { level: "danger", emoji: "🌐" }, wget: { level: "danger", emoji: "🌐" },
};

let table: Record<string, Entry> = DEFAULTS;

/** 宿主推来新表（外部文件）→ 整个替换；推空 → 退回默认 */
export function setCmdLevels(obj: unknown): void {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
        table = DEFAULTS;
        return;
    }
    table = { ...DEFAULTS, ...(obj as Record<string, Entry>) };
}

/** 查一条命令的等级（`rm -rf /` 这种只看主体 rm ✗ 用户定的）*/
export function levelOf(cmd: string): { level: CmdLevel; emoji: string } {
    const e = table[cmd];
    const lv = e?.level;
    const level: CmdLevel =
        lv === "safe" || lv === "warn" || lv === "danger" ? lv : "unknown";
    return { level, emoji: e?.emoji ?? "❔" };
}

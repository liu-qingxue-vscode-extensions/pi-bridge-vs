/**
 * pi-env —— ★★ B42：pi 的"环境信息"（它在哪 / 数据在哪 / 什么版本）
 *
 * 【为什么要单独一个模块】
 *   原先这些信息来自 pi SDK 的三个值导入（getAgentDir / getPackageDir / VERSION）
 *   ⇒ 整个 pi SDK（8.37MB）被打进扩展 ✗ 而且那本身是【本体依赖本体】的错定位
 *   （详见 docs/batches/B42.md 第三节）
 *
 * 【实测出来的约定】（不是猜的 ✗ 是 `pi --help` + pi 源码 + 实际运行验证的）
 *   agentDir   = PI_CODING_AGENT_DIR ?? ~/.pi/agent
 *   sessions   = PI_CODING_AGENT_SESSION_DIR ?? <agentDir>/sessions
 *                （--session-dir 参数优先级最高）
 *   packageDir = PI_PACKAGE_DIR ?? 从 pi CLI 的真实路径往上找 package.json
 *   VERSION    = 读 <packageDir>/package.json 的 version
 *   CHANGELOG  = <packageDir>/CHANGELOG.md
 *   settings   = <agentDir>/settings.json   ← ★ 死路径（读它就能拿到 sessionDir）
 *
 * 【为什么是"纯逻辑"】
 *   ★ 这个文件【不 import vscode】⇒ 可以被 Node 脚本直接测（见 scripts/check-pi-env.mjs）
 *   "用户设置项"由调用方（main.ts）传进来 ✗ 这里只管约定 ✓
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/* ───────────── 环境变量名（来自 pi --help 的原文）───────────── */

export const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";
export const ENV_SESSION_DIR = "PI_CODING_AGENT_SESSION_DIR";
export const ENV_PACKAGE_DIR = "PI_PACKAGE_DIR";

/** pi 包在 npm 全局 node_modules 里的相对路径（探测用）*/
const PI_PKG_REL = "node_modules/@earendil-works/pi-coding-agent";

/* ───────────── 路径解析 ───────────── */

/** 展开开头的 `~`（pi 自己也这么干 ✗ 见其 normalizePath）*/
export function expandTilde(p: string): string {
    const t = p.trim();
    if (t === "~") return os.homedir();
    if (t.startsWith("~/")) return path.join(os.homedir(), t.slice(2));
    return t;
}

/**
 * pi 的数据目录（settings.json / models.json / auth.json / sessions 都在这之下）
 * ★ 语义对齐 pi 的 getAgentDir()：环境变量优先 ✗ 否则 ~/.pi/agent
 */
export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
    const fromEnv = env[ENV_AGENT_DIR];
    if (fromEnv && fromEnv.trim()) return path.resolve(expandTilde(fromEnv));
    return path.join(os.homedir(), ".pi", "agent");
}

/**
 * 会话目录
 * ★ 优先级对齐 pi：--session-dir 参数 > 环境变量 > <agentDir>/sessions
 *   （pi 的 --session-dir 原文："Directory for session storage and lookup" —— 存和找是同一个值）
 */
export function resolveSessionsDir(
    agentDir: string,
    launchArgs: readonly string[] = [],
    env: NodeJS.ProcessEnv = process.env,
): string {
    const i = launchArgs.indexOf("--session-dir");
    if (i >= 0 && launchArgs[i + 1]) return path.resolve(expandTilde(launchArgs[i + 1]));

    const fromEnv = env[ENV_SESSION_DIR];
    if (fromEnv && fromEnv.trim()) return path.resolve(expandTilde(fromEnv));

    return path.join(agentDir, "sessions");
}

/**
 * ★ 从 pi CLI 的可执行文件位置，反推"pi 包根目录"
 *
 * 分两步：
 *   ① 解析真实路径（`pi` 常常是软链 ✗ realpath 才能拿到包里的真实文件）
 *   ② 从该文件往上找第一个含 package.json 的目录
 *      （注意：pi 的 cli 在 <pkg>/dist/cli.js ⇒ 往上第 2 层才是包根 ✗
 *        但中间 dist/ 下也可能有 package.json ⇒ 所以"看到 dist 就再上一层"）
 */
export function packageDirFromCli(cliPath: string): string | undefined {
    let real: string;
    try {
        real = realpathSync(cliPath);
    } catch {
        return undefined;
    }
    let dir = path.dirname(real);
    while (dir !== path.dirname(dir)) {
        if (existsSync(path.join(dir, "package.json"))) {
            // 与 pi 自己的 findNodePackageDir 同样处理：若这一层叫 dist 且父层也有
            // package.json ⇒ 包根在父层（否则 assets 路径会变成 dist/dist/）
            const parent = path.dirname(dir);
            if (path.basename(dir) === "dist" && existsSync(path.join(parent, "package.json"))) {
                return parent;
            }
            return dir;
        }
        dir = path.dirname(dir);
    }
    return undefined;
}

/** 常见全局安装位置（探测兜底 ✗ 顺序即优先级）*/
export function candidateGlobalPaths(env: NodeJS.ProcessEnv = process.env): string[] {
    const home = os.homedir();
    const out = [
        path.join(home, ".npm-global", "lib", PI_PKG_REL),
        path.join(home, ".bun", "install", "global", PI_PKG_REL),
        path.join("/usr", "lib", PI_PKG_REL),
        path.join("/usr", "local", "lib", PI_PKG_REL),
    ];
    // npm 的全局前缀（若用户配过）
    const prefix = env.npm_config_prefix;
    if (prefix) out.unshift(path.join(expandTilde(prefix), "lib", PI_PKG_REL));
    return out.map((p) => path.join(p, "dist", "cli.js"));
}

/** pi 包目录（环境变量 → 用户指定 → 常见路径探测）*/
export function resolvePackageDir(
    override?: string,
    env: NodeJS.ProcessEnv = process.env,
): { dir: string; source: string } | undefined {
    const fromEnv = env[ENV_PACKAGE_DIR];
    if (fromEnv && fromEnv.trim()) {
        return { dir: path.resolve(expandTilde(fromEnv)), source: "env" };
    }
    if (override && override.trim()) {
        // ★ 用户明确指定了路径 ⇒ 找不到就是找不到【不回退探测】✓
        //   否则"填错了也能跑"会让用户以为设置生效了（而实际用的是别处的 pi ✗ 极难排查）
        const d = packageDirFromCli(expandTilde(override));
        return d ? { dir: d, source: "setting" } : undefined;
    }
    for (const cli of candidateGlobalPaths(env)) {
        if (existsSync(cli)) {
            const d = packageDirFromCli(cli);
            if (d) return { dir: d, source: "probe" };
        }
    }
    return undefined;
}

/** pi CLI 的绝对路径（从包目录推）*/
export function cliPathFromPackageDir(packageDir: string): string {
    return path.join(packageDir, "dist", "cli.js");
}

/** 从包目录读版本号（读 package.json ✗ 不用跑进程）*/
export function versionFromPackageDir(packageDir: string): string | undefined {
    try {
        const pkg = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf-8")) as {
            version?: unknown;
        };
        return typeof pkg.version === "string" ? pkg.version : undefined;
    } catch {
        return undefined;
    }
}

/** 更新日志路径（硬路径：挂在 pi 包根下）*/
export function changelogPath(packageDir: string): string {
    return path.join(packageDir, "CHANGELOG.md");
}

/* ───────────── settings.json ───────────── */

/** 读 pi 的 settings.json（不存在 / 坏了都返回空对象 ✗ 不抛）*/
export function readPiSettings(agentDir: string): Record<string, unknown> {
    try {
        const raw = readFileSync(path.join(agentDir, "settings.json"), "utf-8");
        const d = JSON.parse(raw) as unknown;
        return d && typeof d === "object" && !Array.isArray(d) ? (d as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

/**
 * ★ 会话目录（完整链：--session-dir > 环境变量 > settings.sessionDir > 默认）
 *   ★ 读的是【死路径】<agentDir>/settings.json ✗ 所以一条链就能确定主路径 ✓
 */
export function resolveSessionRoot(
    agentDir: string,
    launchArgs: readonly string[] = [],
    env: NodeJS.ProcessEnv = process.env,
): { dir: string; source: string } {
    const i = launchArgs.indexOf("--session-dir");
    if (i >= 0 && launchArgs[i + 1]) {
        return { dir: path.resolve(expandTilde(launchArgs[i + 1])), source: "launchArgs" };
    }
    const fromEnv = env[ENV_SESSION_DIR];
    if (fromEnv && fromEnv.trim()) {
        return { dir: path.resolve(expandTilde(fromEnv)), source: "env" };
    }
    const s = readPiSettings(agentDir).sessionDir;
    if (typeof s === "string" && s.trim()) {
        return { dir: path.resolve(agentDir, expandTilde(s.trim())), source: "settings" };
    }
    return { dir: path.join(agentDir, "sessions"), source: "default" };
}

/* ───────────── 便捷入口 ───────────── */

/**
 * pi 包根目录（探测失败返回 undefined）
 * ★ 【不缓存】：读几个路径的存在性而已 ✗ 而缓存会导致"用户改了设置却不生效"
 *   （B42 的教训：缓存后重置设置仍指向旧路径 ✗ 重载按钮也没用 ✓）
 */
export function piPackageDir(override?: string): string | undefined {
    return resolvePackageDir(override)?.dir;
}

/** pi 版本（读包里的 package.json ✗ 同样不缓存）*/
export function piVersion(override?: string): string | undefined {
    const dir = piPackageDir(override);
    return dir ? versionFromPackageDir(dir) : undefined;
}

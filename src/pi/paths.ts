/**
 * paths —— ★ B42：设置项覆盖层（真正的解析逻辑全在 pi-env.ts）
 *
 * 【分工】
 *   pi-env.ts   纯逻辑（不 import vscode ✓ 可被脚本测 ✓）—— 环境变量 + 约定 + 探测
 *   本文件      只负责"用户设置项优先"这一层 ✓
 *
 * 【用户可覆盖的两项】
 *   pi-bridge.piCliPath     pi 的 CLI 入口（dist/cli.js）✗ 留空 = 自动探测
 *   pi-bridge.piAgentDir    pi 的数据目录 ✗ 留空 = 自动探测
 *   ★ 留空时不是"猜"✗ 是按约定算（见 docs/batches/B42.md 第二节）✓
 */
import * as vscode from "vscode";
import {
    cliPathFromPackageDir,
    expandTilde,
    piPackageDir,
    resolveAgentDir,
    piVersion as piVersionRaw,
} from "./pi-env.js";

/** 读设置（去空白；空串视为"未设置" ✓） */
function readOverride(key: string): string | undefined {
    const v = vscode.workspace.getConfiguration("pi-bridge").get<string>(key);
    const t = typeof v === "string" ? v.trim() : "";
    return t === "" ? undefined : t;
}

/**
 * 解析 pi CLI（dist/cli.js）的绝对路径 —— 返回空串表示"找不到"
 *
 * 【为什么不能直接用相对路径？】
 * 官方 RpcClient 的默认 cliPath 是 "dist/cli.js"，而 spawn 的相对路径
 * 是相对【cwd】解析的 —— 我们的 cwd 是用户工作区，那里没有 dist/cli.js ✗
 *
 * 【★ B42：为什么不再用 import.meta.resolve？】
 *   这条路依赖"pi 包能被 Node 解析到"✗ 而扩展的加载方式一变（ESM→CJS）它就废
 *   ⇒ 改成【按约定探测】：PI_PACKAGE_DIR → 设置项 → 常见全局路径 → realpath 反推
 *   ⇒ 找不到就返回空串 ✗ 由启动期自检去通知用户（见 B42.md 第四节）
 */
export function resolvePiCliPath(): string {
    const override = readOverride("piCliPath");
    if (override) return expandTilde(override);
    const pkgDir = piPackageDir();
    return pkgDir ? cliPathFromPackageDir(pkgDir) : "";
}

/** 解析 pi 配置目录（models.json 所在）；默认走 pi 自己的 resolveAgentDir() */
export function resolvePiAgentDir(): string {
    return readOverride("piAgentDir") ?? resolveAgentDir();
}

/**
 * ★ B42：当前生效的 pi 包目录（含用户的 piCliPath 覆盖）
 * ★ 每次现读设置 ✗ 不缓存 ⇒ 用户改完设置立刻生效 ✓
 */
export function currentPiPackageDir(): string | undefined {
    return piPackageDir(readOverride("piCliPath"));
}

/** ★ B42：当前生效的 pi 版本（同上一处 ✗ 走覆盖）*/
export function currentPiVersion(): string | undefined {
    return piVersionRaw(readOverride("piCliPath"));
}

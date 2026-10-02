/**
 * paths —— pi 相关路径的统一解析（带用户覆盖）
 *
 * 【为什么需要】
 * 默认值都是"自动探测"（动态解析 ✓），但它们依赖：
 *   · pi 包还能被 ESM 解析到（import.meta.resolve）
 *   · pi 包还导出 getAgentDir()
 *   · 环境变量（PI_CONFIG_DIR 等）的当前取值
 * 一旦环境变化（换安装方式 / 换机器 / 包升级删 API / 用非标准目录），
 * 探测就可能失败 → 整套功能崩 ✗
 *
 * 所以：探测 + 【设置项覆盖】。留空 = 探测 ✓
 *   pi-bridge.piCliPath     pi 的 CLI 入口（dist/cli.js）
 *   pi-bridge.piAgentDir    pi 的配置目录（models.json 所在）
 */
import * as vscode from "vscode";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** 读设置（去空白；空串视为"未设置" ✓） */
function readOverride(key: string): string | undefined {
    const v = vscode.workspace.getConfiguration("pi-bridge").get<string>(key);
    const t = typeof v === "string" ? v.trim() : "";
    return t === "" ? undefined : t;
}

/**
 * 解析 pi CLI（dist/cli.js）的绝对路径
 *
 * 【为什么不能直接用相对路径？】
 * 官方 RpcClient 的默认 cliPath 是 "dist/cli.js"，而 spawn 的相对路径
 * 是相对【cwd】解析的 —— 我们的 cwd 是用户工作区，那里没有 dist/cli.js ✗
 *
 * 【为什么用 import.meta.resolve 而不是 require.resolve？】
 * pi 包是 ESM-only（没有 CJS 入口），CJS 的 require.resolve 会报
 * ERR_PACKAGE_PATH_NOT_EXPORTED ✗
 */
export function resolvePiCliPath(): string {
    const override = readOverride("piCliPath");
    if (override) return override;

    const entryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    const entryPath = fileURLToPath(entryUrl); // file:///... → /...（Windows 也正确 ✓）
    return path.join(path.dirname(entryPath), "cli.js");
}

/** 解析 pi 配置目录（models.json 所在）；默认走 pi 自己的 getAgentDir() */
export function resolvePiAgentDir(): string {
    return readOverride("piAgentDir") ?? getAgentDir();
}

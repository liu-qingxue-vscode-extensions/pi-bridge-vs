/**
 * paths - B42:设置项覆盖层(真正的解析逻辑全在 pi-env.ts)
 *
 * [分工]
 *   pi-env.ts   纯逻辑(不 import vscode 可被脚本测 )- 环境变量 + 约定 + 探测
 *   本文件      只负责"用户设置项优先"这一层
 *
 * [用户可覆盖的两项]
 *   pi-bridge.piCliPath     pi 的 CLI 入口(dist/cli.js)留空 = 自动探测
 *   pi-bridge.piAgentDir    pi 的数据目录 留空 = 自动探测
 *   留空时不是"猜"是按约定算(见 docs/batches/B42.md 第二节)
 */
import * as vscode from "vscode";
import {
    cliPathFromPackageDir,
    expandTilde,
    piPackageDir,
    resolveAgentDir,
    piVersion as piVersionRaw,
} from "./pi-env.js";

/** 读设置(去空白;空串视为"未设置" ) */
function readOverride(key: string): string | undefined {
    const v = vscode.workspace.getConfiguration("pi-bridge").get<string>(key);
    const t = typeof v === "string" ? v.trim() : "";
    return t === "" ? undefined : t;
}

/**
 * B42:当前生效的 pi 包目录(含用户的 piCliPath 覆盖)
 * 每次现读设置 不缓存 ⇒ 用户改完设置立刻生效
 */
export function currentPiPackageDir(): string | undefined {
    return piPackageDir(readOverride("piCliPath"));
}

/** B42:当前生效的 pi 版本(同上一处 走覆盖)*/
export function currentPiVersion(): string | undefined {
    return piVersionRaw(readOverride("piCliPath"));
}

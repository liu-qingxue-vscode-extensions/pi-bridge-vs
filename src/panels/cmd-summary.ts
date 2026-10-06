/**
 * cmd-summary.ts —— 从 bash 命令里提取【主体命令】（B38）
 *
 * 【为什么在宿主侧做？】
 *   真解析要用库（bash-parser 出 bash 的 AST）✗ 六百多 KB ✗
 *   放宿主 = 不增加前端包体积 ✓ 解析失败也不影响渲染 ✓
 *   前端只收到一个字符串数组 ✗ 它不碰语法 ✓
 *
 * 【为什么不用 shell-quote 自己啃？】
 *   实测下来那是无底洞：for/do/done、if/case、函数、heredoc、$(...)…
 *   修一个冒一个 ✓ 用 AST 一次到位 ✓
 */
import { createRequire } from "node:module";
import { logWarn } from "../logger.js";

const require = createRequire(import.meta.url);
/** bash-parser：解析成 AST（异步）*/
const parseBash = require("bash-parser") as (src: string) => Promise<unknown>;

/** 只是前缀 ✗ 真正干活的是它后面那个词 */
const PREFIX = new Set([
    "sudo", "doas", "env", "time", "nohup", "nice", "ionice",
    "stdbuf", "xargs", "exec", "builtin", "command",
]);

/** 显示名修正（`[` 其实就是 test 命令）*/
const RENAME: Record<string, string> = { "[": "test", "[[" : "test" };

interface Node {
    type?: string;
    name?: unknown;
    suffix?: unknown[];
    [k: string]: unknown;
}

const wordText = (w: unknown): string => {
    if (typeof w === "string") return w;
    const t = (w as { text?: unknown } | null)?.text;
    return typeof t === "string" ? t : "";
};

/** 命令名可能是单个 Word ✗ 也可能是一串（`sudo cat` 里 cat 落在 suffix）*/
function pickName(node: Node): string {
    const first = wordText(node.name);
    if (first && !PREFIX.has(first)) return first;
    // 前缀词 → 到 suffix 里找第一个"像命令"的词
    for (const s of node.suffix ?? []) {
        const t = wordText(s);
        if (!t) continue;
        if (t.startsWith("-")) continue; // 选项
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue; // 赋值
        if (t.startsWith("$")) continue; // 变量
        return t;
    }
    return first; // 实在找不到就返回前缀词本身（至少有信息）
}

/** 深度遍历整棵 AST ✗ 只收 Command 节点（子命令天然也会被走到 ✓）*/
function walk(node: unknown, out: string[]): void {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
        for (const n of node) walk(n, out);
        return;
    }
    const n = node as Node;
    if (n.type === "Command") {
        const name = pickName(n);
        if (name) out.push(RENAME[name] ?? name);
    }
    for (const k of Object.keys(n)) {
        if (k === "loc" || k === "type") continue;
        walk(n[k], out);
    }
}

/** 提取主体命令（去重保序 ✗ 出错就返回空 ✗ 不抛）*/
export async function extractCommands(cmd: string): Promise<string[]> {
    try {
        const ast = await parseBash(cmd);
        const out: string[] = [];
        walk(ast, out);
        return [...new Set(out.filter(Boolean))];
    } catch (err) {
        logWarn(`命令解析失败（忽略）: ${err instanceof Error ? err.message : String(err)}`);
        return [];
    }
}

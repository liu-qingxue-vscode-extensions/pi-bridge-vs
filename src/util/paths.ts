/**
 * paths.ts —— 路径的小工具（B30 ✗ 从 main.ts 搬出来）
 *
 * 【为什么要独立？】
 *   main.ts 一度到 2000+ 行 ✗ 这类【无依赖的纯函数】混在里面
 *   找起来很累 ✓ 搬出来之后：
 *     · 它们可以被任何模块引用 ✗ 不用从 main.ts 导 ✓
 *     · 单独读 / 单独测 ✓
 *
 * ★ 判断"能不能安全搬"的标准 ✗：
 *   函数体内【没有引用任何闭包变量】（pi / chatView / context … ✓）
 *   → 这种搬走是零风险的 ✓（tsc 会兜底 ✓）
 */
import os from "node:os";
import path from "node:path";

/**
 * 把 ~ 展开成家目录（用户输入路径时最自然的写法 ✓）
 *   "~/Projects" → "/home/xxx/Projects"
 *   "~"          → "/home/xxx"
 *   其他          → 原样返回
 */
export function expandHome(p: string): string {
    if (p === "~") return os.homedir();
    if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
    return p;
}

/**
 * 反向美化：家目录下的路径 → ~/xxx（显示用 ✓ 短且好读）
 *   ★ 只用于展示 ✗ 不参与任何文件操作 ✓
 */
export function compactHome(p: string): string {
    const home = os.homedir();
    if (p === home) return "~";
    return p.startsWith(home + path.sep) ? "~" + p.slice(home.length) : p;
}

/**
 * format.ts —— 纯格式化工具（无副作用、不碰 DOM 之外的状态）
 *
 * 【为什么单独？】它们被顶栏、输入区多处复用，且和渲染逻辑无关 ✓
 * 全部是【纯函数】：同输入同输出，方便单独验证 ✓
 */

/** 数字缩写：12345 → 12.3k */
export function fmtNum(n: unknown): string {
    const v = Number(n) || 0;
    if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
    if (v >= 1e3) return (v / 1e3).toFixed(1) + "k";
    return String(v);
}

/** 花费：小额多给几位小数（否则 deepseek 这种会全显示 0 ✗） */
export function fmtCost(c: unknown): string {
    const v = Number(c) || 0;
    if (v === 0) return "0";
    if (v < 0.001) return v.toFixed(6);
    if (v < 1) return v.toFixed(4);
    return v.toFixed(2);
}

/**
 * 路径太长 → 保留【尾部】（前面的目录省略 ✓ 像终端那样）
 * ★ 不用 CSS 的 direction:rtl —— 那会让路径里的 / 显示位置错乱 ✗
 */
export function shortenPath(p: string, max?: number): string {
    const n = max || 40;
    return p.length <= n ? p : "…" + p.slice(-(n - 1));
}

/** 从计算样式里取一个【数值型】CSS 变量（如 --pi-input-max-rows） */
export function cssNum(name: string, fallback: number): number {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
}

/** 单行高度（从 textarea 的计算样式拿，跟随字号变化 ✓） */
export function lineHeightOf(el: HTMLElement): number {
    const cs = getComputedStyle(el);
    return parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.45;
}

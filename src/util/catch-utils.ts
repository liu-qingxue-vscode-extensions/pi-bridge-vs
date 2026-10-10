/**
 * 通用小工具
 */

/**
 * 把任意 catch 到的东西转成可读的错误消息
 *
 * 为什么需要它？JS 允许 `throw` 任何东西（Error、字符串、数字、对象），
 * 所以 catch 到的类型是 `unknown`。这里按优先级尝试取出可读文本：
 *   1. Error  → .message（最标准的错误）
 *   2. string → 直接用它
 *   3. 其他   → JSON.stringify（保留结构信息）
 *   4. 兜底   → String()
 */
export function toErrorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === "string") return err;
    try {
        return JSON.stringify(err);
    } catch {
        return String(err);
    }
}

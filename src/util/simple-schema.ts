/**
 * 默认值的形状和实际值是否同型。
 *
 * 数组要单独判：typeof [] === "object"，光比 typeof 会把对象也当成合法数组。
 */
export function schema(def: unknown, v: unknown): boolean {
    if (Array.isArray(def)) {
        if (Array.isArray(v)) {
            if (!def[0] || !v[0]) { return true }
            else if (typeof def[0] === typeof v[0]) {
                return true
            } else return false
        } else return false
    };
    return typeof v === typeof def;
}
/**
 * settings-utils.ts —— 设置面板的小工具（B30 ✗ 从 main.ts 搬出）
 */
import { SETTINGS_GROUPS } from "../pi/settings-schema.js";

export function defaultForKind(kind: string): unknown {
    if (kind === "boolean") return false;
    if (kind === "number") return 0;
    if (kind === "list") return [];
    return "";
}

export function needsRestartHint(values: Record<string, unknown>): boolean {
    return SETTINGS_GROUPS.some((g) =>
        g.items.some((f) => f.needsRestart && f.key in values),
    );
}

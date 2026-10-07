/**
 * misc-utils.ts —— 一些零散的工具（B30 ✗ 从 main.ts 搬出）
 */
import fs from "node:fs";
import path from "node:path";
import { resolveAgentDir } from "../pi/pi-env.js";
import { readSettings } from "../pi/settings.js";
import { logDebug, logWarn } from "../logger.js";
import { toErrorMessage } from "../utils.js";

export function readPiDefaults(): {
    model?: string;
    provider?: string;
    thinkingLevel?: string;
} {
    try {
        const p = path.join(resolveAgentDir(), "settings.json");
        const d = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
        return {
            model: typeof d.defaultModel === "string" ? d.defaultModel : undefined,
            provider: typeof d.defaultProvider === "string" ? d.defaultProvider : undefined,
            thinkingLevel:
                typeof d.defaultThinkingLevel === "string" ? d.defaultThinkingLevel : undefined,
        };
    } catch (err) {
        logDebug(`读 settings.json 默认值失败（忽略）: ${toErrorMessage(err)}`);
        return {};
    }
}

export function shortIdOf(file: string): string {
    const base = file.split(/[/\\]/).pop() ?? "";
    const m = /_([0-9a-f-]{6,})\.jsonl$/i.exec(base);
    return m ? m[1].slice(0, 8) : base.replace(/\.jsonl$/i, "").slice(0, 12);
}

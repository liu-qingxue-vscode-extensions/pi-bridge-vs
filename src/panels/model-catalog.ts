/**
 * model-catalog.ts —— 模型目录 / 启用列表（B30 ✗ 从 main.ts 搬出）
 *
 * ★ 搬运原则：函数体内【没有引用任何闭包变量】✗ 零风险 ✓
 *   （唯一的例外是 readInstalledExtensions 里的 `pj.pi` ✗ 那是字段名不是闭包 ✓）
 */
import fs from "node:fs";
import path from "node:path";
import { resolveAgentDir } from "../pi/pi-env.js";
import { readSettings } from "../pi/settings.js";
import { logDebug } from "../logger.js";
import { toErrorMessage } from "../utils.js";

/** 模型目录里的一项 ✓ */
export interface ModelEntry {
    provider: string;
    id: string;
    name?: string;
}

export function sortCatalog(
    list: { provider: string; id: string; name?: string }[],
): { provider: string; id: string; name?: string }[] {
    const byProv = new Map<string, { provider: string; id: string; name?: string }[]>();
    for (const m of list) {
        const arr = byProv.get(m.provider) ?? [];
        arr.push(m);
        byProv.set(m.provider, arr);
    }
    return [...byProv.entries()]
        .sort((a, b) => a[1].length - b[1].length || a[0].localeCompare(b[0]))
        .flatMap(([, arr]) => arr.sort((x, y) => x.id.localeCompare(y.id)));
}

export function readModelCatalog(): { provider: string; id: string; name?: string }[] {
    const out: { provider: string; id: string; name?: string }[] = [];
    const seen = new Set<string>();

    const addFrom = (prov: string, models: { id?: string; name?: string }[] | undefined) => {
        for (const m of models ?? []) {
            if (!m?.id) continue;
            const key = `${prov}/${m.id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ provider: prov, id: m.id, name: m.name });
        }
    };

    // ① models.json（用户自定义 ✓ 有 providers 包装）
    try {
        const p = path.join(resolveAgentDir(), "models.json");
        const d = JSON.parse(fs.readFileSync(p, "utf8")) as {
            providers?: Record<string, { models?: { id?: string; name?: string }[] }>;
        };
        for (const [prov, v] of Object.entries(d.providers ?? {})) addFrom(prov, v.models);
    } catch (err) {
        logDebug(`读 models.json 失败: ${toErrorMessage(err)}`);
    }

    // ② models-store.json（pi 的内置目录 ✓ 没有 providers 包装）
    try {
        const p = path.join(resolveAgentDir(), "models-store.json");
        const d = JSON.parse(fs.readFileSync(p, "utf8")) as Record<
            string,
            { models?: { id?: string; name?: string }[] }
        >;
        for (const [prov, v] of Object.entries(d)) {
            if (v && typeof v === "object" && !Array.isArray(v)) addFrom(prov, v.models);
        }
    } catch (err) {
        logDebug(`读 models-store.json 失败: ${toErrorMessage(err)}`);
    }

    logDebug(`模型目录（合并两个文件）：${out.length} 个 · ${[...new Set(out.map((m) => m.provider))].length} 个供应商`);
    return out;
}

export function getEnabledModels(): string[] {
    const v = readSettings().enabledModels;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

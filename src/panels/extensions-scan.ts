/**
 * extensions-scan.ts —— 扫描已装的 pi 扩展（B30 ✗ 从 main.ts 搬出）
 */
import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readSettings } from "../pi/settings.js";
import { logDebug, logInfo } from "../logger.js";
import { toErrorMessage } from "../utils.js";

export function readInstalledExtensions(): { source: string; enabled: boolean }[] {
    const nm = path.join(getAgentDir(), "npm", "node_modules");
    const enabledSet = new Set(
        (readSettings().packages as string[] | undefined)?.filter(
            (x) => typeof x === "string",
        ) ?? [],
    );
    const out: { source: string; enabled: boolean }[] = [];

    const check = (pkgName: string, dir: string) => {
        try {
            const pj = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as {
                pi?: unknown;
            };
            if (!pj.pi) return; // ★ 没有 pi 字段 → 不是扩展 ✗
            const src = `npm:${pkgName}`;
            out.push({ source: src, enabled: enabledSet.has(src) });
        } catch {
            /* 读不到就当不是 ✓ */
        }
    };

    try {
        for (const e of fs.readdirSync(nm, { withFileTypes: true })) {
            if (!e.isDirectory()) continue;
            if (e.name.startsWith("@")) {
                // ★ scope 包（@xxx/yyy ✓）多一层 ✓
                const scopeDir = path.join(nm, e.name);
                for (const s of fs.readdirSync(scopeDir, { withFileTypes: true })) {
                    if (s.isDirectory()) check(`${e.name}/${s.name}`, path.join(scopeDir, s.name));
                }
            } else if (!e.name.startsWith(".")) {
                check(e.name, path.join(nm, e.name));
            }
        }
    } catch (err) {
        logDebug(`读已装扩展失败: ${toErrorMessage(err)}`);
    }

    // ★ git: 开头的包（settings 里声明但不在 npm 目录 ✓）也一并列出 ✓
    for (const src of enabledSet) {
        if (src.startsWith("git:")) out.push({ source: src, enabled: true });
    }
    out.sort((a, b) => a.source.localeCompare(b.source));
    logInfo(`已装扩展：${out.length} 个（启用 ${out.filter((x) => x.enabled).length} ✓）`);
    return out;
}

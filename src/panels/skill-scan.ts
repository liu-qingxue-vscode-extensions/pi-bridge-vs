/**
 * skill-scan.ts —— 扫描技能目录（B30 ✗ 从 main.ts 搬出）
 *
 * 【数据源】两处 ✗
 *   ① 用户技能：~/.pi/agent/skills/<name>/SKILL.md
 *   ② 扩展包的 pi.skills 字段 → 同样扫 SKILL.md
 */
import fs, { existsSync } from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { logDebug, logInfo } from "../logger.js";
import { toErrorMessage } from "../utils.js";

export function readSkills(): {
    dir: string;
    skills: { name: string; description?: string; source?: string; path?: string }[];
} {
    const out: { name: string; description?: string; source?: string; path?: string }[] = [];

    /** 从一个 SKILL.md 提取 name/description ✓ */
    const parse = (file: string): { name?: string; description?: string } => {
        try {
            const head = fs.readFileSync(file, "utf8").split("\n").slice(0, 30).join("\n");
            const m = /^---\s*\n([\s\S]*?)\n---/.exec(head);
            if (!m) return {};
            const body = m[1];
            const name = /^name:\s*(.+)$/m.exec(body)?.[1]?.trim();
            // ★ description 可能很长 / 含中文 ✓ 直接取到行尾 ✓
            const description = /^description:\s*(.+)$/m.exec(body)?.[1]?.trim();
            return { name, description };
        } catch {
            return {};
        }
    };

    /** 扫一个 skills 目录（里面是 <name>/SKILL.md ✓）*/
    const scanDir = (dir: string, source: string) => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            if (!e.isDirectory()) continue;
            const file = path.join(dir, e.name, "SKILL.md");
            if (!existsSync(file)) continue;
            const meta = parse(file);
            out.push({
                name: meta.name ?? e.name,
                description: meta.description,
                source,
                path: file,
            });
        }
    };

    // ① 用户自己的技能 ✓
    const userDir = path.join(getAgentDir(), "skills");
    scanDir(userDir, "用户技能");

    // ② 扩展包提供的技能 ✓
    const nm = path.join(getAgentDir(), "npm", "node_modules");
    const scanExt = (dir: string) => {
        try {
            const pj = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as {
                name?: string;
                pi?: { skills?: string[] };
            };
            for (const rel of pj.pi?.skills ?? []) {
                scanDir(path.join(dir, rel), pj.name ?? "扩展");
            }
        } catch {
            /* ignore */
        }
    };
    try {
        for (const e of fs.readdirSync(nm, { withFileTypes: true })) {
            if (!e.isDirectory()) continue;
            if (e.name.startsWith("@")) {
                const sd = path.join(nm, e.name);
                for (const s of fs.readdirSync(sd, { withFileTypes: true })) {
                    if (s.isDirectory()) scanExt(path.join(sd, s.name));
                }
            } else if (!e.name.startsWith(".")) {
                scanExt(path.join(nm, e.name));
            }
        }
    } catch (err) {
        logDebug(`扫扩展技能失败: ${toErrorMessage(err)}`);
    }

    out.sort((a, b) => a.name.localeCompare(b.name));
    logInfo(`技能：${out.length} 个（` + out.map((s) => s.name).join(", ") + `）`);
    return { dir: userDir, skills: out };
}

/**
 * theme-loader.ts —— 读取 VS Code 当前主题 ✗ 交给前端当 shiki 主题（B29 P3 ✓）
 *
 * 【★ 解决什么问题？】
 *   shiki 要用一套主题才知道"什么 token 上什么色"✗
 *   我之前写死了 dark-plus ✗ → 用户用的是别的主题 → 配色对不上 ✓
 *
 * 【★ 怎么做到"逐色一致"？】
 *   ① 读 workbench.colorTheme ✗ 拿到主题名（如 "Catppuccin Mocha" ✓）
 *   ② ★ 遍历 vscode.extensions.all ✗ 找 contributes.themes 里 label 匹配的 ✓
 *      每个主题有一个 JSON 路径 ✓ 读它 ✓
 *   ③ 把整个 JSON 原样发给前端 ✗ 喂给 shiki ✓✓✓
 *      VS Code 主题的 JSON 结构与 shiki 的 ThemeRegistration 【兼容】✓
 *      （都是 { name, type, colors, tokenColors } ✓）
 *
 * 【★ 兜底链】（任何一步失败都不能让高亮挂掉 ✓）
 *   主题没找到 → 用内置 dark-plus / light-plus ✓
 *   （前端会用 GET_THEME 消息来取 ✗ 或者直接用兜底 ✓）
 */
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";

export interface ThemePayload {
    /** shiki 主题对象（或 undefined = 前端用内置 ✓）*/
    theme?: unknown;
    /** 主题名（日志用 ✓）*/
    name: string;
    /** 亮 / 暗（给前端挑兜底主题用 ✓）*/
    kind: vscode.ColorThemeKind;
}

/** 从扩展贡献里找主题文件 ✓ */
function findThemeFile(themeLabel: string): string | undefined {
    for (const ext of vscode.extensions.all) {
        const themes = (
            ext.packageJSON as { contributes?: { themes?: Array<{ label?: string; path?: string }> } }
        )?.contributes?.themes;
        if (!Array.isArray(themes)) continue;
        for (const t of themes) {
            if (t.label === themeLabel && t.path) {
                return path.join(ext.extensionPath, t.path);
            }
        }
    }
    return undefined;
}

/**
 * ★ VS Code 内置主题不在 extensions.all 里 ✗ 在安装目录 ✓
 *   比如 `dark-plus` 对应 `resources/.../dark_plus.json` ✓
 *   → 兜底：试几个常见路径 ✗ 找不到就算了（前端用 shiki 自带的同名主题 ✓）
 */
function findBuiltinTheme(): string | undefined {
    const vscodeRoot = path.dirname(vscode.env.appRoot);
    const candidates = [
        path.join(vscode.env.appRoot, "extensions", "theme-defaults", "themes"),
        path.join(vscodeRoot, "resources", "app", "extensions", "theme-defaults", "themes"),
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    return undefined;
}

/** ★ 内置主题名 → 文件名 的映射（VS Code 内置的那几套 ✓）*/
const BUILTIN_FILE: Record<string, string> = {
    "Dark+ (default dark)": "dark_plus.json",
    "Dark (Visual Studio)": "dark_vs.json",
    "Dark High Contrast": "hc_black.json",
    "Light+ (default light)": "light_plus.json",
    "Light (Visual Studio)": "light_vs.json",
    "Light High Contrast": "hc_light.json",
};

export async function getCurrentTheme(): Promise<ThemePayload> {
    const kind = vscode.window.activeColorTheme.kind;
    const label = vscode.workspace.getConfiguration("workbench").get<string>("colorTheme") ?? "";
    const fallback: ThemePayload = { name: label || "(内置)", kind };

    if (!label) return fallback;

    // ① 扩展贡献的主题 ✓
    let file = findThemeFile(label);
    // ② 内置主题 ✓
    if (!file) {
        const dir = findBuiltinTheme();
        const name = BUILTIN_FILE[label];
        if (dir && name) {
            const p = path.join(dir, name);
            if (fs.existsSync(p)) file = p;
        }
    }
    if (!file || !fs.existsSync(file)) return fallback;

    try {
        const raw = fs.readFileSync(file, "utf8");
        const json = JSON.parse(stripJsonComments(raw)) as Record<string, unknown>;
        // ★ shiki 需要 name / type / colors / tokenColors ✓
        //   某些主题文件没有 name ✗ 补一个 ✓
        if (!json.name) json.name = label;
        if (!json.type) json.type = kind === vscode.ColorThemeKind.Light ? "light" : "dark";
        return { theme: json, name: label, kind };
    } catch {
        return fallback;
    }
}

/**
 * ★ 去掉 JSON 里的注释和尾逗号（VS Code 的主题 JSON 允许注释 ✗ JSON.parse 不允许 ✓）
 *   仅用于这个场景 ✗ 不做通用实现 ✓
 */
function stripJsonComments(s: string): string {
    let out = "";
    let inStr = false;
    let inLine = false;
    let inBlock = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        const n = s[i + 1];
        if (inLine) {
            if (c === "\n") {
                inLine = false;
                out += c;
            }
            continue;
        }
        if (inBlock) {
            if (c === "*" && n === "/") {
                inBlock = false;
                i++;
            }
            continue;
        }
        if (inStr) {
            out += c;
            if (c === "\\") {
                out += n ?? "";
                i++;
            } else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') {
            inStr = true;
            out += c;
            continue;
        }
        if (c === "/" && n === "/") {
            inLine = true;
            i++;
            continue;
        }
        if (c === "/" && n === "*") {
            inBlock = true;
            i++;
            continue;
        }
        out += c;
    }
    // ★ 去掉尾逗号 ✗ [1,2,] / {"a":1,} ✓
    return out.replace(/,(\s*[}\]])/g, "$1");
}

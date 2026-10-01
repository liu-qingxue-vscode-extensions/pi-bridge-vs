/**
 * html-loader —— 读取 media/ 下的 HTML 文件并注入 CSP 所需的占位符
 *
 * 【为什么要外置 HTML 文件？】
 * 之前把 HTML 写成 TS 模板字符串，编辑器里没有语法高亮、难维护。
 * 外置成真正的 .html 文件后：有高亮、可格式化、可单独预览。
 *
 * 【为什么用 extensionUri 而不是 __dirname？】
 * tsc 只把 .ts 编译到 dist/，.html 不会被复制过去。
 * 所以必须从【扩展根目录】读（打包成 .vsix 后 media/ 依然在扩展根）。
 */
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";

/** 生成 32 位随机 nonce（每次加载都不同 → 注入的脚本无法执行） */
function getNonce(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let text = "";
    for (let i = 0; i < 32; i++) {
        text += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return text;
}

/**
 * 读取 media/<fileName>，把占位符替换成实际值：
 *   {{nonce}}     → 本次加载的随机 nonce
 *   {{cspSource}} → VS Code 的资源源标识（webview.cspSource）
 *   {{styleVars}} → 从设置生成的 CSS 变量覆盖（见 style-config.ts）
 */
export function loadWebviewHtml(
    extensionUri: vscode.Uri,
    fileName: string,
    webview: vscode.Webview,
    extraCss = "",
): string {
    const filePath = path.join(extensionUri.fsPath, "media", fileName);
    const raw = fs.readFileSync(filePath, "utf8");
    return raw
        .replace(/\{\{nonce\}\}/g, getNonce())
        .replace(/\{\{cspSource\}\}/g, webview.cspSource)
        .replace(/\{\{styleVars\}\}/g, extraCss);
}

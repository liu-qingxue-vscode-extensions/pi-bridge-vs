/**
 * html-loader —— 读取 media/ 下的 HTML 并注入 CSP 占位符与资源 URI
 *
 * 【为什么要外置 HTML / CSS / JS？】
 * 1. 编辑器里语法高亮 + 格式化都正确（不再是一大坨模板字符串）
 * 2. 结构（HTML）和代码（CSS/JS）分离 —— 改结构用工具，改样式/逻辑用编辑器 ✓
 * 3. 单文件变小 → 后续用编辑器/工具改动时匹配范围小、不易出错 ✓
 *
 * 【为什么用 extensionUri 而不是 __dirname？】
 * tsc 只编译 .ts 到 dist/，.html/.css/.js 不会被复制。
 * 所以必须从【扩展根目录】读（打包成 .vsix 后 media/ 仍在扩展根）。
 *
 * 【占位符】
 *   {{nonce}}     本次加载的随机 nonce（给 <script> 用）
 *   {{cspSource}} VS Code 的资源源标识（webview.cspSource）
 *   {{styleVars}} 从设置生成的 CSS 变量覆盖（见 style-config.ts）
 *   {{css}}       同名 CSS 文件的可加载 URI（如 chat.html → chat.css）
 *   {{js}}        同名 JS 文件的可加载 URI（如 chat.html → chat.js）
 */
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";

/** 生成 32 位随机 nonce（每次加载都不同） */
function getNonce(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let text = "";
    for (let i = 0; i < 32; i++) {
        text += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return text;
}

/** 读取 media/<fileName>，替换占位符 */
export function loadWebviewHtml(
    extensionUri: vscode.Uri,
    fileName: string,
    webview: vscode.Webview,
    extraCss = "",
): string {
    const filePath = path.join(extensionUri.fsPath, "media", fileName);
    const raw = fs.readFileSync(filePath, "utf8");

    /** 把 media/ 下的资源转成 webview 能加载的 URI */
    const mediaUri = (name: string): string =>
        webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", name)).toString();

    const base = fileName.replace(/\.[^.]*$/, ""); // chat.html → chat

    return raw
        .replace(/\{\{nonce\}\}/g, getNonce())
        .replace(/\{\{cspSource\}\}/g, webview.cspSource)
        .replace(/\{\{styleVars\}\}/g, extraCss)
        .replace(/\{\{css\}\}/g, mediaUri(`${base}.css`))
        .replace(/\{\{js\}\}/g, mediaUri(`${base}.js`));
}

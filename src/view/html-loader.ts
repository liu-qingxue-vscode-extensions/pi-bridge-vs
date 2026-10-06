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
 *   {{htmlClass}} 从设置生成的 <html> 类名（★ B32 加 ✗ 开关类靠它 ✓）
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
    /**
     * ★★ 写到 <html> 上的类名（B32 ✓）
     *
     * 【为什么必须在服务端就写上？】
     *   开关类（centered / no-arg-scroll …）原本只由 JS 的 applyStyleVars 切 ✗
     *   而它在【首次加载时不会被调用】✗（只有宿主推 styleVars 消息才调 ✓
     *   而宿主从来不推 ✓）
     *   ⇒ 首屏所有开关都失效 ✗ 用户实测：“居中模式竟然没生效”✓
     *
     *   写在这里 = 首屏就是对的 ✗ 而且不闪（不用等 JS 跑完才变样 ✓）
     */
    extraClasses = "",
): string {
    const filePath = path.join(extensionUri.fsPath, "media", fileName);
    const raw = fs.readFileSync(filePath, "utf8");

    /**
     * 把 media/ 下的资源转成 webview 能加载的 URI
     *
     * ★★ 为什么后面要拼一个 `?v=<mtime>`？（B27 踩的坑 ✗）
     *   VS Code 的 webview 是【真的浏览器】✗ 它会对 css/js 做 HTTP 缓存 ✓
     *   而 asWebviewUri 出来的 URL 【每次都一样】✗
     *   → 改了 media/css/*.css 后重开面板【样式纹丝不动】✗（用户报的 ✓）
     *     现象：“JS 是新的（文案变了 ✓）但 CSS 是旧的（布局没变 ✗）”
     *   → 拼上文件修改时间 ✗ 文件一变 URL 就变 → 缓存自动失效 ✓
     *
     * ★ 为什么不用 package.json 的 version？
     *   开发时改 CSS 不会动 version ✗ 而 mtime 【每次存盘都变】✓
     */
    const mediaUri = (rel: string): string => {
        const uri = webview
            .asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", rel))
            .toString();
        let stamp = "0";
        try {
            stamp = String(fs.statSync(path.join(extensionUri.fsPath, "media", rel)).mtimeMs);
        } catch {
            // 文件不存在（比如某页没有同名 css ✗）→ 不加时间戳即可 ✓
        }
        return `${uri}?v=${stamp}`;
    };

    const base = fileName.replace(/\.[^.]*$/, ""); // chat.html → chat

    return raw
        .replace(/\{\{nonce\}\}/g, getNonce())
        .replace(/\{\{cspSource\}\}/g, webview.cspSource)
        .replace(/\{\{styleVars\}\}/g, extraCss)
        .replace(/\{\{htmlClass\}\}/g, extraClasses)
        // ★★ B32：CSS 指向【构建期展开的 bundle】✗ 见 scripts/bundle-css.mjs
        //   原因：@import 的子文件 URL 写死在 CSS 里 ✗ 带不上 `?v=mtime`
        //    ⇒ 主文件是新的、子文件却是缓存旧版 ⇒ 表现像“只改了一半”✓
        //   bundle 后只剩一个 URL ✗ 版本号一拼 ✗ 整包同步失效 ✓
        .replace(/\{\{css\}\}/g, mediaUri(`out/${base}.bundle.css`))
        .replace(/\{\{js\}\}/g, mediaUri(`out/${base}.js`))
        // ★ B29：mermaid 的 URI（它是独立打包的 ✗ 主程序按需注入 ✓）
        .replace(/\{\{mermaidJs\}\}/g, mediaUri("out/mermaid.js"));
}

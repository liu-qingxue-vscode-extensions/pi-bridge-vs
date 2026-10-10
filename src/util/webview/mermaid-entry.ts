/**
 * mermaid-entry.ts —— Mermaid 的独立打包入口（B29 P2）
 *
 * 【★ 为什么要单独打包？】
 *   mermaid 打包后约 1.5~2MB ✗ 如果塞进 chat.js ✗
 *     那【所有人、所有会话】都要为少数几条图付这个代价 ✓
 *   → 单独产出 media/mermaid.js ✗ 只有消息里真出现 ```mermaid 时才注入 ✓✓✓
 *
 * 【★ 怎么被加载？】
 *   主程序（markdown.ts）动态创建一个 <script src="media/mermaid.js"> ✓
 *   CSP 的 script-src 里已经有 {{cspSource}} ✗ 所以同源脚本能装载 ✓
 *   （不需要 nonce ✗ 那是给内联脚本的 ✓）
 *
 * 【★ 为什么挂到 window？】
 *   主程序要拿到的就是这个实例 ✓
 *   注入脚本后读 window.mermaid 即可 ✓
 */
import mermaid from "mermaid";

/** ★ 跟随 VS Code 主题 ✗（body 上有 vscode-dark / vscode-light 类 ✓）*/
function isDarkTheme(): boolean {
    const c = document.body.classList;
    return c.contains("vscode-dark") || c.contains("vscode-high-contrast");
}

mermaid.initialize({
    startOnLoad: false, // ★ 我们自己控制何时渲染 ✓
    theme: isDarkTheme() ? "dark" : "default",
    // ★ strict：禁掉点击事件/脚本/外链 ✗ 只画图 ✓（安全 ✓）
    securityLevel: "strict",
    fontFamily: "var(--vscode-font-family)",
    // ★★ B47：语法错误时【别往 DOM 里插错误图】
    //
    // 【用户报的 bug】消息里有个语法错的 mermaid 块 ⇒ 页面上多出
    //   一个浮动的错误层（"mermaid version 12.1.0" + "Parse error on line 8"）
    //   它叠在正文上面 ⇒ 用户看到的就是"左上角闪一块别人的样式"✓
    // 【为什么】mermaid.render() 失败时会把错误图插到【它临时建的容器】里
    //   并在某些路径下【不清理】⇒ 留在了 document 里 ✓
    // ⇒ 关掉它：我们自己 catch 异常 + 回退成普通代码块（用户要的行为 ✓）
    suppressErrorRendering: true,
});

// ★ 暴露给主程序 ✓
(window as unknown as { mermaid: typeof mermaid }).mermaid = mermaid;

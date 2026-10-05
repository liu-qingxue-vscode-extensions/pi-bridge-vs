/**
 * build-webview —— 把 src/webview/*.ts 和 src/interaction/*.ts 打包成 media/*.js
 *
 * 【两个入口】（B26 起 ✓）
 *   src/webview/index.ts     → media/out/chat.js        侧栏聊天页
 *   src/interaction/index.ts → media/out/interaction.js 交互面板页
 *
 * 【它们是分开打包的 ✗】
 *   聊天页依赖一大堆 DOM 元素（messages / input / 顶栏 … ✓）
 *   交互页只有 #list 一个容器 ✓ 打包在一起会互相折腾 ✓
 *
 * 【为什么要打包？】
 * webview 里没有模块系统（不能用 import/export）✗
 * 但我们需要：
 *   · 用 TS 写（类型检查 + 复用插件端的类型 ✓）
 *   · 拆成多个模块（700 行单文件没法维护 ✗）
 * → 所以用 esbuild 打成【一个 IIFE】交给 webview ✓
 *
 * 【esbuild 不做类型检查】
 * 类型检查由 `tsc -p tsconfig.webview.json --noEmit` 负责（见 npm run compile）✓
 * esbuild 只负责"编译 + 打包"，所以它很快 ✓
 */
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const options = {
    entryPoints: [
        { in: "src/webview/index.ts", out: "chat" },
        { in: "src/interaction/index.ts", out: "interaction" },
        // ★ mermaid 单独打包变开关：它约 2MB ✗ 不能拖累主包 ✓
        //   （只有消息里真出现 ```mermaid 时才由主程序动态注入 ✓）
        { in: "src/webview/mermaid-entry.ts", out: "mermaid" },
    ],
    outdir: "media/out",
    bundle: true,          // 把 import 的全部打进一个文件 ✓
    format: "iife",        // webview 里就是普通脚本 —— 不能是 ESM ✗
    target: "es2022",
    platform: "browser",
    // ★★ 开压缩（B29 P2 ✗）：mermaid 不压是 11.7MB ✗ 压完小一个数量级 ✓
    //   （webview 直接加载本地文件 ✗ 没有 gzip ✗ 所以必须预压缩 ✓）
    minify: true,
    sourcemap: false,
    logLevel: "info",
    // 注意：不改 out 的扩展名（html 里写死了 chat.js / interaction.js ✓）
};

if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log("esbuild: 监听中（src/webview + src/interaction → media/）");
} else {
    await esbuild.build(options);
}

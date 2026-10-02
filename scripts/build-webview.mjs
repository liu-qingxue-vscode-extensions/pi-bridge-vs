/**
 * build-webview —— 把 src/webview/*.ts 打包成 media/chat.js
 *
 * 【为什么要打包？】
 * webview 里没有模块系统（不能用 import/export）✗
 * 但我们需要：
 *   · 用 TS 写（类型检查 + 复用插件端的 ChatPatch 类型 ✓）
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
    entryPoints: ["src/webview/index.ts"],
    outfile: "media/chat.js",
    bundle: true,          // 把 import 的全部打进一个文件 ✓
    format: "iife",        // webview 里就是普通脚本 —— 不能是 ESM ✗
    target: "es2022",
    platform: "browser",
    sourcemap: false,
    logLevel: "info",
    // 注意：不改 outfile 的扩展名（chat.html 里写死了 chat.js ✓）
};

if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log("esbuild: 监听中（src/webview → media/chat.js）");
} else {
    await esbuild.build(options);
}

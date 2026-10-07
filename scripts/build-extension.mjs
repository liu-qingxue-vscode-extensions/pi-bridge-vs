/**
 * build-extension —— 把扩展宿主（src/ 里非 webview 的部分）打包成 dist/main.js
 *
 * 【为什么宿主也要打包？】
 *   原先 tsc 直出多文件 ⇒ 运行时靠 node_modules（如 bash-parser）
 *   ⇒ 打 vsix 时就得把 node_modules 一起塞进去
 *      而 node_modules 里有个【开发用的软链】
 *      （@earendil-works/pi-coding-agent → 全局安装的 pi ✗ 供类型检查用）
 *      vsce 会顺着软链跑进 pi 的目录做依赖检查 ⇒ 报一堆 extraneous ⇒ 打不了包
 *   ⇒ 改成 bundle：依赖直接进 dist/ ✗ 打包时 --no-dependencies 就行 ✓
 *
 * 【external: vscode】
 *   vscode 模块由 VS Code 宿主注入 ✗ 不打包（也没法打包）✓
 *
 * 【sourcemap 留着】
 *   F5 调试时断点能对上行号 ✓ 而打包时被 .vscodeignore 排除 ✗ 不进 vsix ✓
 */
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

/** 主入口：扩展宿主 */
const main = {
    entryPoints: ["src/main.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    external: ["vscode"], // ★ 只此一个（宿主注入的）
    // ★ 必须是 .cjs：package.json 里有 "type": "module"
    //   ⇒ 叫 .js 会被 Node 当 ESM 加载 ⇒ 而这是 CJS 产物 ⇒ "module is not defined" ✗
    outfile: "dist/main.cjs",
    sourcemap: true,
    logLevel: "warning",
};

/**
 * 附带产物：patch 反推的纯函数
 * ★ 它被 scripts/check-patch-reverse.mjs 用 Node 直接 import 做单测
 *   ⇒ 单独产出一份（ESM 格式 ✗ 好让 .mjs 脚本 import ✓）
 */
const testable = {
    entryPoints: ["src/bridge/patch-reverse.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: "dist/bridge/patch-reverse.js",
    logLevel: "warning",
};

if (watch) {
    const ctx = await esbuild.context(main);
    await ctx.watch();
    console.log("⚡ build-extension: watching…");
} else {
    await esbuild.build(main);
    await esbuild.build(testable);
    console.log("⚡ build-extension: dist/main.cjs（含 bash-parser）+ dist/bridge/patch-reverse.js");
}

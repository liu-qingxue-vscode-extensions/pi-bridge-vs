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
 * ★★ 附带产物：那些"零 vscode 依赖的纯逻辑模块"
 *
 * 【为什么要单独产出一份】
 *   主产物是 bundle 过的 main.cjs ✗ 里面没有独立的模块文件
 *   而守门脚本（scripts/check-*.mjs）要用 Node 直接 import 它们做单测 ✓
 *   ⇒ 这些模块必须【单独再 build 一次】（ESM 格式 ✗ 好让 .mjs import ✓）
 *   ★ 前提：它们不能 import vscode（否则 Node 加载不了 ✗ 见 B42 的分层约定 ✓）
 */
const TESTABLE = [
    ["src/bridge/patch-reverse.ts", "dist/bridge/patch-reverse.js"],
    ["src/bridge/session-file.ts", "dist/bridge/session-file.js"],
    // ★ replay.ts 本身也被脚本用（check-session-file.mjs 要 messagesToPatches ✓）
    ["src/bridge/replay.ts", "dist/bridge/replay.js"],
    ["src/pi/pi-env.ts", "dist/pi/pi-env.js"],
    ["src/pi/pi-selfcheck.ts", "dist/pi/pi-selfcheck.js"],
];

const testableBuilds = TESTABLE.map(([inFile, outFile]) => ({
    entryPoints: [inFile],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: outFile,
    external: ["vscode"], // ★ 万一哪天误 import 了 vscode ✗ 让它显式报错而不是静默 ✓
    logLevel: "warning",
}));

if (watch) {
    const ctx = await esbuild.context(main);
    await ctx.watch();
    console.log("⚡ build-extension: watching…");
} else {
    await esbuild.build(main);
    await Promise.all(testableBuilds.map((o) => esbuild.build(o)));
    console.log(
        `⚡ build-extension: dist/main.cjs（含 bash-parser）+ ${TESTABLE.length} 个可测模块`,
    );
}

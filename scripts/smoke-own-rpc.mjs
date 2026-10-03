/**
 * smoke-own-rpc —— 冒烟测试【自持传输层】（src/pi/rpc-client.ts）
 *
 * 【测什么】
 *   1. spawn + getState 回执（请求-回执链路通 ✓）
 *   2. onStderr 事件式回调（★ 官方没有的能力）
 *   3. onEvent 事件分发
 *   4. stop 干净退出
 *
 * 【用法】node scripts/smoke-own-rpc.mjs [--ext]
 *   --ext  不禁扩展（会产生启动期 stderr，用来验证 onStderr ✓）
 *   需要先 npm run compile（本脚本用 dist/ ✓）
 */
import { OwnRpcClient } from "../dist/pi/rpc-client.js";
import os from "node:os";
import path from "node:path";

const CLI = path.join(
    os.homedir(),
    ".npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
);

const withExt = process.argv.includes("--ext");

const client = new OwnRpcClient({
    cliPath: CLI,
    cwd: process.cwd(),
    // ★ 默认禁扩展（避免守卫拦工具 ✓）；--ext 时不加，用来产出 stderr ✓
    args: withExt ? ["--no-session"] : ["--no-session", "--no-extensions"],
});

let stderrCalls = 0;
let stderrChars = 0;
client.onStderr((t) => {
    stderrCalls++;
    stderrChars += t.length;
});

const eventTypes = new Set();
client.onEvent((e) => eventTypes.add(e.type));

await client.start();
console.log("✓ start");

const state = await client.getState();
console.log("✓ getState 回执:", JSON.stringify(state).slice(0, 100));

await new Promise((r) => setTimeout(r, 400));
console.log(`✓ onStderr 回调 ${stderrCalls} 次 / ${stderrChars} 字符（事件式 ✓）`);
console.log("✓ 事件类型:", [...eventTypes].join(", ") || "(无)");

await client.stop();
console.log("✓ stop 完成");

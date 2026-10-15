/**
 * 冒烟测试：验证官方 RpcClient 能拉起 pi 并收到事件流
 *
 * 用途：F5 调试扩展之前，先在命令行确认"协议层"没问题。
 * 跑法：node scripts/smoke-rpc.mjs
 */
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import path from "node:path";

const cwd = process.cwd();
console.log("cwd:", cwd);

// 关键：官方默认 cliPath 是相对路径，spawn 时按 cwd 解析会找不到，
// 必须用 ESM 模块解析拿到绝对路径
const entryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
const cliPath = path.join(path.dirname(fileURLToPath(entryUrl)), "cli.js");
console.log("cliPath:", cliPath);

// 用本地 ollama 模型，避免调用云端 API
const client = new RpcClient({ cwd, cliPath, model: "ollama/ornstein:latest" });

let eventCount = 0;
client.onEvent((ev) => {
    eventCount++;
    if (eventCount <= 30) {
        console.log("[event]", ev.type, JSON.stringify(ev).slice(0, 130));
    }
});

await client.start();
console.log("✓ pi 已启动（start() 返回）");

await client.prompt("只回复两个字：你好");

// 等模型回答完（本地模型可能慢）
await new Promise((r) => setTimeout(r, 30000));

console.log("总事件数:", eventCount);
console.log("stderr:", client.getStderr().slice(0, 300) || "(空)");

await client.stop();
process.exit(0);

/**
 * 冒烟测试 v2：验证「补历史 + 事件驱动」的组合
 *
 * 模拟我们扩展的真实时序：
 *   启动 → 等探针 → 【先拉历史】→ 【再挂监听】
 *
 * 验证：历史能否捕到启动期输出（扩展日志/警告），监听能否收到后续数据
 *
 * 跑法：node scripts/smoke-stderr.mjs
 */
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const cwd = "/tmp/pi-stderr-test";
fs.mkdirSync(cwd, { recursive: true });   // 必须存在，否则 spawn 报 ENOENT
const entryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
const cliPath = path.join(path.dirname(fileURLToPath(entryUrl)), "cli.js");

const client = new RpcClient({ cwd, cliPath, model: "ollama/ornstein:latest" });
await client.start();
await client.getState();

// 故意等一会儿 —— 模拟"探针耗时"，让启动期输出都产生完（此时我们还没挂监听）
await new Promise((r) => setTimeout(r, 2000));

// ============ 我们的实现方式 ============
// ① 先拉历史（补上启动期那批）
const history = client.getStderr();
console.log(`① 补历史拿到 ${history.length} 字符`);
if (history) {
    console.log("   内容预览:", JSON.stringify(history.slice(0, 130)));
}

// ② 再挂监听（收之后的新数据）
const proc = client.process;
const captured = [];
proc?.stderr?.on("data", (chunk) => captured.push(chunk.toString()));

// 触发一点运行期输出来验证监听（发个 prompt 让扩展活动起来）
await client.prompt("回复一个字");
await new Promise((r) => setTimeout(r, 12000));

console.log(`② 挂监听后收到 ${captured.length} 个片段`);
if (captured.length) {
    console.log("   片段预览:", JSON.stringify(captured[0].slice(0, 130)));
}
console.log(history.length > 0 ? "\n✓ 补历史生效（启动期输出没漏）" : "\n✗ 历史为空");

await client.stop();
process.exit(0);

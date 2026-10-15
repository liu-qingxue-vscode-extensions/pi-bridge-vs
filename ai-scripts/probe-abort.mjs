/**
 * 探测：abort（用户中断）时 pi 的事件序列
 *
 * 要回答的问题（设计"以 turn 为颗粒度"的前提）：
 *   1. abort 触发的是 `message_update › error (reason=aborted)` 吗？
 *   2. 之后还会不会收到 message_end / turn_end / agent_end / agent_settled？
 *      → 即：中断后"收尾信号"是否完整（决定 UI 能否安全收口）
 *   3. 事件顺序是什么？
 *
 * 跑法：node scripts/probe-abort.mjs
 */
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const cwd = "/tmp/pi-probe";
fs.mkdirSync(cwd, { recursive: true }); // spawn 的 cwd 必须存在
const entryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
const cliPath = path.join(path.dirname(fileURLToPath(entryUrl)), "cli.js");

const client = new RpcClient({ cwd, cliPath, args: ["--no-session", "--no-extensions"] });

/** 收集事件序列（嵌套的 assistantMessageEvent.type 也展开） */
const seq = [];
client.onEvent((e) => {
    const inner = e.assistantMessageEvent?.type;
    const reason = e.assistantMessageEvent?.reason;
    const label = e.type + (inner ? ` › ${inner}` : "") + (reason ? ` (${reason})` : "");
    seq.push(label);
    // 只实时打印"非高频增量"事件（delta 太多了）
    if (!label.includes("_delta")) {
        console.log(`[${String(seq.length).padStart(3)}] ${label}`);
    }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await client.start();
console.log("--- 发送 prompt ---");
await client.prompt("从 1 数到 300，慢慢数，每个数字之间停顿一下");

await sleep(900); // ★ 提前中断（此时模型应该还在输出）
console.log("--- 发送 abort ---");
await client.abort();

await sleep(2500); // 等收尾
console.log(`\n--- 结束：共 ${seq.length} 个事件 ---`);
console.log("\n最终序列（关键事件）：");
console.log(seq.filter((s) => !s.includes("_delta")).join("\n"));

await client.stop();
process.exit(0);

/**
 * 探测：工具结果消息（role=toolResult）的完整结构
 *
 * 目的：确认能否用它里面的字段，把「工具调用」和「工具结果」关联起来
 *       （视觉上要拼成一个"工具气泡"）
 *
 * 跑法：node scripts/probe-toolresult.mjs
 */
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { startMockLlmServer } from "@truly-private/omdsh-llm-mock-server";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const cwd = "/tmp/pi-probe-toolresult";
fs.mkdirSync(cwd, { recursive: true });
const entryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
const cliPath = path.join(path.dirname(fileURLToPath(entryUrl)), "cli.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mock = await startMockLlmServer({
    port: 8123,
    apiKey: "mock-key",
    sequence: ["tool_call_success", "success"],
    repeatLast: true,
    successText: "工具跑完了。",
    toolName: "read",
    toolArguments: '{"path":"demo.txt"}',
    chunkSize: 4,
    chunkDelayMs: 20,
});

const client = new RpcClient({
    cwd, cliPath, provider: "mock", model: "mock",
    args: ["--no-session", "--no-extensions"],
});

client.onEvent((e) => {
    // 工具调用开始（看有没有 id）
    const ae = e.assistantMessageEvent;
    if (ae?.type === "toolcall_start") {
        console.log("=== toolcall_start ===");
        console.log(JSON.stringify(ae, null, 2).slice(0, 400));
    }
    // 工具结果消息（★关键：看结构）
    if (e.type === "message_start" && e.message?.role === "toolResult") {
        console.log("\n=== message_start (role=toolResult) 完整结构 ===");
        console.log(JSON.stringify(e.message, null, 2).slice(0, 900));
    }
    if (e.type === "message_end" && e.message?.role === "toolResult") {
        console.log("\n=== message_end (role=toolResult) 的字段名 ===");
        console.log(Object.keys(e.message).join(", "));
    }
});

await client.start();
await client.prompt("读一下 demo.txt");
await sleep(10000);
try { await client.stop(); } catch { /* ignore */ }
await mock.close();
console.log("\n（完）");
process.exit(0);

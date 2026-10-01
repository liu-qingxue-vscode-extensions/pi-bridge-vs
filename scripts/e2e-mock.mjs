/**
 * 端到端测试：pi（RpcClient）↔ mock LLM server
 *
 * 自己起 server + 自己关闭，全自动（不需要手动起 mock-server.mjs）。
 *
 * 【用法】
 *   node scripts/e2e-mock.mjs [behavior] [--port=8123] [--chunk-delay=80] [--chunk-size=3]
 *
 * 【常用】
 *   node scripts/e2e-mock.mjs success             正常流式 → 看 message_* 事件
 *   node scripts/e2e-mock.mjs reasoning_success   先思考后正文 → 看 thinking_* 事件
 *   node scripts/e2e-mock.mjs tool_call_success   工具调用 → 看 toolcall_* / tool_execution_*
 *   node scripts/e2e-mock.mjs max_tokens          以 length 结束 → 看 done(reason=length)
 *   node scripts/e2e-mock.mjs partial_disconnect  中途断连 → 看错误路径的收尾
 *
 * 【为什么要它？】
 * 环境依赖：pi 的 models.json 里要有 mock provider（指向 127.0.0.1:8123/v1）。
 */
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { startMockLlmServer } from "@truly-private/omdsh-llm-mock-server";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

// ===== 参数 =====
const args = process.argv.slice(2);
const behavior = args.find((a) => !a.startsWith("--")) ?? "success";
const opt = (name, fallback) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
};
const port = Number(opt("port", 8123));
const chunkDelayMs = Number(opt("chunk-delay", 80));
const chunkSize = Number(opt("chunk-size", 3));

const cwd = "/tmp/pi-e2e-mock";
fs.mkdirSync(cwd, { recursive: true });
const entryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
const cliPath = path.join(path.dirname(fileURLToPath(entryUrl)), "cli.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===== 1. 起 mock server =====
const mock = await startMockLlmServer({
    port,
    apiKey: "mock-key",
    // tool_call_success 场景：第一次返回工具调用，第二次给正常回复
    // （否则 repeatLast 会让每轮 LLM 都返回工具调用 → 无限循环）
    sequence: behavior === "tool_call_success" ? [behavior, "success"] : [behavior],
    repeatLast: true,
    successText: opt("text", "这是 mock 模型的输出。用于端到端测试流式渲染。"),
    reasoningText: opt("reasoning", "用户想验证端到端链路，我先确认一下指令。"),
    toolName: opt("tool-name", "read"),
    toolArguments: opt("tool-args", '{"path":"demo.txt"}'),
    chunkSize,
    chunkDelayMs,
    onEvent: (e) => {
        if (e.type === "result") {
            console.log(`  [mock] #${e.attempt} ${e.behavior} → ${e.outcome} (${e.chunksSent} chunks)`);
        }
    },
});
console.log(`mock server: ${mock.baseURL} (behavior=${behavior}, chunkDelay=${chunkDelayMs}ms)`);

// ===== 2. pi 指向 mock =====
const client = new RpcClient({
    cwd,
    cliPath,
    provider: "mock",
    model: "mock",
    args: ["--no-session", "--no-extensions"],
});

const seq = [];
client.onEvent((e) => {
    const inner = e.assistantMessageEvent?.type;
    const reason = e.assistantMessageEvent?.reason;
    const label = e.type + (inner ? ` › ${inner}` : "") + (reason ? ` (${reason})` : "");
    seq.push(label);
    if (label.includes("_delta")) return; // delta 太多，不逐个打印

    // 关键字段摘要（比只打印类型名有信息量）
    let extra = "";
    if (e.type === "message_end") {
        const m = e.message ?? {};
        const text = JSON.stringify(m.content ?? "").slice(0, 50);
        extra = ` role=${m.role} stopReason=${m.stopReason} content=${text}`;
    } else if (e.type === "message_start") {
        extra = ` role=${e.message?.role}`;
    } else if (e.type === "auto_retry_start") {
        extra = " " + JSON.stringify(e).slice(0, 120);
    } else if (e.type === "turn_end") {
        extra = ` toolResults=${e.toolResults?.length ?? 0}`;
    } else if (inner === "toolcall_start" || inner === "toolcall_end") {
        extra = " " + JSON.stringify(e.assistantMessageEvent).slice(0, 120);
    } else if (e.type === "tool_execution_start" || e.type === "tool_execution_end") {
        extra = ` tool=${e.toolName} id=${e.toolCallId?.slice(0, 8)}`;
    }
    console.log(`  [pi] ${label}${extra}`);
});

// ===== 3. 跑 =====
try {
    await client.start();
    console.log("--- prompt ---");
    await client.prompt("测试一下");
} catch (err) {
    console.error("!! 出错:", err.message);
}

await sleep(Number(opt("wait", 3500)));

// ===== 4. 收尾 + 报告 =====
console.log("");
console.log(`事件总数: ${seq.length}`);
console.log("完整序列（去重后计数）：");
const counts = new Map();
for (const s of seq) counts.set(s, (counts.get(s) ?? 0) + 1);
for (const [k, v] of counts) console.log(`  ${String(v).padStart(3)} × ${k}`);

const captured = mock.requests[0]?.body;
if (captured) {
    console.log("\npi 实际发出的请求体（关键字段）：");
    const b = captured;
    console.log(`  model=${b.model} stream=${b.stream} messages=${b.messages?.length} 条`);
}

try { await client.stop(); } catch { /* 忽略 */ }
await mock.close();
process.exit(0);

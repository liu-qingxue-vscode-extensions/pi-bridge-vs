/**
 * 验证 format-backend + ChatState 的翻译/状态逻辑（不需要 UI）
 *
 * 做法：用 mock 造事件 → 每个事件依次过 toChatPatch → ChatState.apply
 *       → 最后打印 ChatState 里的气泡结构，检查是否符合预期。
 *
 * 跑法：node scripts/test-chat-state.mjs [behavior]      （默认 tool_call_success）
 * 前置：需要先 npm run compile（脚本 import 的是 dist/ 里的编译产物）
 */
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { startMockLlmServer } from "@truly-private/omdsh-llm-mock-server";
import { toChatPatch } from "../dist/bridge/format-backend.js";
import { ChatState } from "../dist/view/chat-state.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const args = process.argv.slice(2);
const behavior = args.find((a) => !a.startsWith("--")) ?? "tool_call_success";

const cwd = "/tmp/pi-chat-state-test";
fs.mkdirSync(cwd, { recursive: true });
const entryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
const cliPath = path.join(path.dirname(fileURLToPath(entryUrl)), "cli.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===== mock =====
const mock = await startMockLlmServer({
    port: 8123,
    apiKey: "mock-key",
    // tool_call_success 场景：第一次返回工具调用，第二次给正常回复
    // （否则 repeatLast 会让每轮 LLM 都返回工具调用 → 无限循环）
    sequence: behavior === "tool_call_success" ? [behavior, "success"] : [behavior],
    repeatLast: true,
    successText: "好的，我来读取文件。",
    reasoningText: "先看看用户要什么。",
    toolName: "read",
    toolArguments: '{"path":"demo.txt"}',
    chunkSize: 4,
    chunkDelayMs: 30,
});

// ===== pi + 翻译层 + ChatState =====
const client = new RpcClient({ cwd, cliPath, provider: "mock", model: "mock", args: ["--no-session", "--no-extensions"] });
const chat = new ChatState();

let patches = 0;
client.onEvent((e) => {
    const patch = toChatPatch(e);
    if (patch) {
        patches++;
        chat.apply(patch);
    }
});

await client.start();
await client.prompt("读一下 demo.txt");
await sleep(Number(args.find((a) => a.startsWith("--wait="))?.slice(7) ?? 6000));
try { await client.stop(); } catch { /* ignore */ }
await mock.close();

// ===== 报告 =====
console.log(`\nbehavior=${behavior} · 产生 ${patches} 个 patch\n`);
console.log("=== ChatState 里的气泡结构 ===");
for (const [i, b] of chat.snapshot().entries()) {
    console.log(`\n气泡[${i}] role=${b.role} done=${b.done} blocks=${b.blocks.length}`);
    for (const blk of b.blocks) {
        if (blk.type === "tool") {
            const res = blk.result === undefined
                ? "(无结果)"
                : JSON.stringify(blk.result).slice(0, 60);
            console.log(
                `   ├─ [tool] ${blk.toolName} callId=${(blk.toolCallId || "?").slice(0, 12)}` +
                ` done=${blk.toolDone} args=${JSON.stringify(blk.text)}`,
            );
            console.log(`   │        result=${res} isError=${blk.resultIsError}`);
        } else {
            const t = blk.text.replace(/\n/g, "\\n");
            console.log(`   ├─ [${blk.type}] "${t.slice(0, 70)}${t.length > 70 ? "…" : ""}"`);
        }
    }
}
process.exit(0);

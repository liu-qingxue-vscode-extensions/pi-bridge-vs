/**
 * 探测：pi 的会话文件里到底记了什么？
 *
 * 重点回答：
 *   1. 工具调用失败、主动中断、自动重试这些"过程信息"进不进文件？
 *   2. 对话内容（user / assistant / toolResult）进文件吗？
 *
 * 做法：用 mock 的 slow_success 慢速流式 → 中途 abort → 检查会话文件
 * 注意：这里【不传】--no-session，故意让 pi 写会话文件。
 *
 * 跑法：node scripts/probe-session-persist.mjs
 */
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { startMockLlmServer } from "@truly-private/omdsh-llm-mock-server";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const cwd = "/tmp/pi-probe-persist";
fs.mkdirSync(cwd, { recursive: true });
const entryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
const cliPath = path.join(path.dirname(fileURLToPath(entryUrl)), "cli.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mock = await startMockLlmServer({
    port: 8123,
    apiKey: "mock-key",
    sequence: ["slow_success"],
    repeatLast: true,
    successText: "一、二、三、四、五、六、七、八、九、十、十一、十二、十三、十四、十五、十六、十七、十八、十九、二十",
    chunkSize: 2,
    chunkDelayMs: 250, // 慢速 → 保证 abort 时还在流式
});

// ★ 不传 --no-session，让 pi 写会话文件
const client = new RpcClient({ cwd, cliPath, provider: "mock", model: "mock" });

const seq = [];
client.onEvent((e) => {
    const inner = e.assistantMessageEvent?.type;
    const label = e.type + (inner ? ` › ${inner}` : "");
    seq.push(label);
    if (!label.includes("_delta")) console.log(`  [pi] ${label}`);
});

await client.start();
console.log("--- prompt ---");
await client.prompt("把数字念一遍");
await sleep(1200);
console.log("--- abort ---");
await client.abort();
await sleep(2000);
try { await client.stop(); } catch { /* ignore */ }
await mock.close();

console.log("\n事件序列（去重计数）：");
const counts = new Map();
for (const s of seq) counts.set(s, (counts.get(s) ?? 0) + 1);
for (const [k, v] of counts) console.log(`  ${String(v).padStart(3)} × ${k}`);

// ===== 检查会话文件 =====
const dirName = "--" + cwd.replace(/^\//, "").replace(/\//g, "-") + "--";
const dir = path.join(os.homedir(), ".pi/agent/sessions", dirName);
console.log(`\n会话目录: ${dir}`);

if (!fs.existsSync(dir)) {
    console.log("✗ 目录不存在（pi 可能没写会话文件）");
} else {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
    const latest = files[files.length - 1];
    const full = path.join(dir, latest);
    console.log(`最新文件: ${latest}`);
    const lines = fs.readFileSync(full, "utf8").trim().split("\n");
    console.log(`行数: ${lines.length}\n`);
    console.log("=== 文件内容（逐行摘要）===");
    for (const [i, line] of lines.entries()) {
        try {
            const d = JSON.parse(line);
            const t = d.type;
            let extra = "";
            if (t === "message") {
                const m = d.message ?? {};
                const kinds = Array.isArray(m.content)
                    ? m.content.map((c) => c.type).join("+")
                    : typeof m.content;
                const text = Array.isArray(m.content)
                    ? (m.content.find((c) => c.type === "text")?.text ?? "").slice(0, 40)
                    : "";
                extra = ` role=${m.role} stopReason=${m.stopReason} blocks=[${kinds}] "${text}"`;
            } else if (t === "session") {
                extra = ` id=${String(d.id).slice(0, 8)}`;
            } else {
                extra = " " + JSON.stringify(d).slice(0, 90);
            }
            console.log(`[${String(i).padStart(2)}] ${t}${extra}`);
        } catch {
            console.log(`[${String(i).padStart(2)}] (非JSON) ${line.slice(0, 60)}`);
        }
    }
}
process.exit(0);

/**
 * 复现测试：纯官方 RpcClient（不经过我们的扩展）连续启动两次，
 * 检查它写出的会话文件结构是否符合 session-format.md 的约定。
 *
 * 会话写到 /tmp 下的独立目录，不污染 ~/.pi/agent/sessions/
 *
 * 跑法：node scripts/repro-session-structure.mjs
 */
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const cwd = "/tmp/pi-session-repro";
const sessionDir = "/tmp/pi-session-repro/sessions";
fs.mkdirSync(cwd, { recursive: true });

const entryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
const cliPath = path.join(path.dirname(fileURLToPath(entryUrl)), "cli.js");

/** 跑一次"启动 → 提问 → 停止"的完整循环 */
async function runOnce(tag) {
    console.log(`--- 第 ${tag} 次启动 ---`);
    const client = new RpcClient({
        cwd,
        cliPath,
        model: "ollama/ornstein:latest",
        args: ["--session-dir", sessionDir], // 会话写到测试目录
    });
    await client.start();
    await client.getState();
    await client.prompt(`回复一个字：${tag}`);
    await new Promise((r) => setTimeout(r, 15000)); // 等模型回应
    await client.stop();
    console.log(`--- 第 ${tag} 次结束 ---`);
}

await runOnce("A");
await runOnce("B");

// 检查生成的会话文件结构
console.log("\n===== 生成的会话文件结构 =====");
const files = fs.readdirSync(sessionDir, { recursive: true }).filter((f) => String(f).endsWith(".jsonl"));
for (const rel of files) {
    const f = path.join(sessionDir, String(rel));
    console.log(`\n文件: ${rel}`);
    const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
    let roots = 0;
    let missingId = 0;
    for (let i = 0; i < lines.length; i++) {
        const e = JSON.parse(lines[i]);
        const pid = e.parentId;
        if (pid === null && e.type !== "session") roots++;
        if (e.type !== "session" && !e.id) missingId++;
        console.log(`  ${String(i + 1).padStart(2)} ${String(e.type).padEnd(22)} id=${String(e.id ?? "NONE").slice(0, 8).padEnd(9)} parent=${String(pid ?? "NONE").slice(0, 8)}`);
    }
    console.log(`  >>> parentId=null 的非 session 条目: ${roots} 个（约定应只有第 1 个条目）`);
    console.log(`  >>> 缺 id 的条目: ${missingId} 个`);
}

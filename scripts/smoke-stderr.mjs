/**
 * 冒烟测试：验证方案 A（hook 官方私有字段 client.process.stderr）是否可行
 *
 * 验证三件事：
 *   ① 运行时能否访问官方的 private 字段 `process`
 *   ② 能否给 childProcess.stderr 挂自己的监听器（与官方共存）
 *   ③ 事件驱动能否真的收到 stderr 数据
 *
 * 跑法：node scripts/smoke-stderr.mjs
 */
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const cwd = "/tmp/pi-stderr-test";
fs.mkdirSync(cwd, { recursive: true });   // ← 必须存在，否则 spawn 报 ENOENT
const entryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
const cliPath = path.join(path.dirname(fileURLToPath(entryUrl)), "cli.js");

const client = new RpcClient({ cwd, cliPath, model: "ollama/ornstein:latest" });
await client.start();

// ★ 关键验证 ①：私有字段在运行时是否可访问
const proc = client.process;
console.log("① client.process 可访问:", proc ? "✓" : "✗");
console.log("② client.process.stderr 可访问:", proc?.stderr ? "✓" : "✗");

// ★ 关键验证 ②：挂自己的监听器（事件驱动）
const captured = [];
proc?.stderr?.on("data", (chunk) => {
    const text = chunk.toString();
    captured.push(text);
    process.stdout.write("[stderr 事件] " + text.trim().slice(0, 110) + "\n");
});

// 等一会儿，让 pi 的启动期输出（扩展日志、警告）流过来
await new Promise((r) => setTimeout(r, 6000));

console.log("③ 通过事件驱动捕获到", captured.length, "个 stderr 片段");
console.log(captured.length > 0 ? "✓ 方案 A 可行（事件驱动生效）" : "✗ 没收到数据");

await client.stop();
process.exit(0);

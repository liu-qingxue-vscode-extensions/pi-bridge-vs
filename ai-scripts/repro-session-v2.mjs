/**
 * 复现 v2：去掉上次测试的干扰因素（不传 --session-dir、不显式传 model）
 * 完全模拟扩展的行为：RpcClient 默认参数 + 独立 cwd
 *
 * 跑法：node scripts/repro-session-v2.mjs
 */
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const cwd = "/tmp/pi-repro-v2";
fs.mkdirSync(cwd, { recursive: true });

const entryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
const cliPath = path.join(path.dirname(fileURLToPath(entryUrl)), "cli.js");

async function runOnce(tag) {
    console.log(`--- 第 ${tag} 次启动（无 model / 无 args）---`);
    const client = new RpcClient({ cwd, cliPath }); // ← 和扩展完全一致
    await client.start();
    await client.getState();
    await client.prompt(`回复一个字：${tag}`);
    // 等久一点，让"自动标题"之类的后台功能有机会运行
    await new Promise((r) => setTimeout(r, 40000));
    await client.stop();
    console.log(`--- 第 ${tag} 次结束 ---`);
}

await runOnce("A");
await runOnce("B");

// 检查会话目录
const sessionDir = path.join(process.env.HOME, ".pi/agent/sessions", "--tmp-pi-repro-v2--");
console.log(`\n===== 会话目录: ${sessionDir}`);
if (!fs.existsSync(sessionDir)) {
    console.log("(目录不存在 —— pi 没写会话)");
    process.exit(0);
}
for (const name of fs.readdirSync(sessionDir)) {
    if (!name.endsWith(".jsonl")) continue;
    const f = path.join(sessionDir, name);
    console.log(`\n文件: ${name}`);
    const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
    let roots = 0;
    for (let i = 0; i < lines.length; i++) {
        const e = JSON.parse(lines[i]);
        if (e.parentId === null && e.type !== "session") roots++;
        const mark = e.parentId === null && e.type !== "session" ? "  ← 根" : "";
        console.log(`  ${String(i + 1).padStart(2)} ${String(e.type).padEnd(20)} id=${String(e.id ?? "NONE").slice(0, 8).padEnd(9)} parent=${String(e.parentId ?? "NONE").slice(0, 8)}${e.autoTitle ? "  [autoTitle]" : ""}${mark}`);
    }
    console.log(`  >>> 根的数量: ${roots}（正常应为 1）`);
}

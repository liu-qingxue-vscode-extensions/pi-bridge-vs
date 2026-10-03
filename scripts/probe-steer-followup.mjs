#!/usr/bin/env node
/**
 * ★ 实测：agent 正在跑时，三种发消息方式分别发生什么
 *
 * 用户的问题（原话）：
 *   "agent 正在跑，我给他发信息，它能不能追加？能不能排队是个问题嘞？做了吗？"
 *
 * 【怎么造出"正在跑"】
 *   mock 的 slow_success + 大 chunkDelay → 流式持续好几秒 ✓ 我们趁这空隙插话 ✓
 *
 * 【测什么】
 *   A. prompt（无 streamingBehavior）→ 报错？排队？丢弃？
 *   B. steer      → 何时投递？
 *   C. follow_up  → 何时投递？
 */
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { startMockLlmServer } from "@truly-private/omdsh-llm-mock-server";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const PORT = 8145;
const CWD = "/tmp/pi-probe-queue";
fs.mkdirSync(CWD, { recursive: true });
const entryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
const cliPath = path.join(path.dirname(fileURLToPath(entryUrl)), "cli.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mock = await startMockLlmServer({
    port: PORT,
    apiKey: "mock-key",
    sequence: ["slow_success"],
    repeatLast: true,
    successText: "这是一段很长的输出，用来把流式拖久一点。" .repeat(4),
    chunkDelayMs: 350, // ★ 慢 → 一条要跑好几秒 ✓
    chunkSize: 5,
    onEvent: (e) => {
        if (e.type === "result") console.log(`    [mock] #${e.attempt} → ${e.outcome}`);
    },
});
console.log(`mock: ${mock.baseURL}`);

let seq = [];
async function scenario(name, second) {
    console.log(`\n════════ ${name} ════════`);
    const client = new RpcClient({
        cwd: CWD,
        cliPath,
        provider: "mock",
        model: "mock",
        args: ["--no-session", "--no-extensions"],
    });
    const events = [];
    client.onEvent((e) => {
        events.push(e);
        const t = e.type;
        if (t === "queue_update" || t === "message_start" || t === "message_end" ||
            t === "turn_start" || t === "turn_end" || t === "agent_start" || t === "agent_settled" ||
            t === "compaction_start" || t === "compaction_end") {
            const who = e.message?.role ? ` role=${e.message.role}` : "";
            const q = t === "queue_update" ? ` steering=[${e.steering}] followUp=[${e.followUp}]` : "";
            console.log(`  · ${t}${who}${q}`);
        }
    });
    await client.start?.();
    await sleep(1400);

    console.log("  → 发第 1 条（会开始慢速流式 ✓）");
    const p1 = client.prompt("第一条：请输出长文本").catch((e) => console.log(`     第1条失败: ${e.message}`));

    await sleep(1500); // 等它真的在跑
    console.log("  → ★ 现在插第 2 条");
    const p2 = await Promise.race([
        second(client).then(() => ({ r: "回执到了" })).catch((e) => ({ r: "抛错: " + e.message })),
        sleep(5000).then(() => ({ r: "★ 5 秒无回执" })),
    ]);
    console.log(`  → 第 2 条结果: ${p2.r}`);

    await Promise.race([p1, sleep(30000)]);
    await sleep(3000);

    // 分析：第 2 条的内容有没有出现在消息里？
    const texts = events
        .filter((e) => e.type === "message_start" && e.message?.role === "user")
        .map((e) => JSON.stringify(e.message?.content ?? "").slice(0, 50));
    console.log(`  ★ 用户消息的条数: ${texts.length}`);
    texts.forEach((t, i) => console.log(`      user[${i}] ${t}`));
    const qUp = events.filter((e) => e.type === "queue_update");
    console.log(`  ★ queue_update 次数: ${qUp.length}`);
    qUp.slice(0, 4).forEach((e) => console.log(`      steering=[${e.steering}] followUp=[${e.followUp}]`));
    try {
        await client.stop();
    } catch {}
}

async function main() {
    await scenario("A. 跑着时【直接发 prompt】", (c) => c.prompt("第二条：直接 prompt 插进去"));
    await scenario("B. 跑着时发 steer", (c) => c.steer("第二条：steer 插话"));
    await scenario("C. 跑着时发 follow_up", (c) => c.followUp("第二条：followUp 排队"));
    console.log("\n全部完成 ✓");
    await mock.close?.();
    process.exit(0);
}

void main();

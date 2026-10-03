#!/usr/bin/env node
/**
 * ★ 实测 clone / fork 行为（用真的 pi ✓）
 *
 * 用户点名的会话：~/.pi/agent/sessions/--home-liuqingxue--/…（名字 = test，两轮 ✓）
 *
 * 要回答的问题：
 *   1. clone 和 fork 的参数分别是什么？
 *   2. 它们的返回值里有什么？（cancelled / text / sessionFile ✗）
 *   3. 它们会不会【自动切换】会话？（B17 源码里看到 result.cancelled || await rebindSession() ✓）
 *   4. get_fork_messages 返回什么？（entryId + text ✓）
 *   5. ★ 关键：clone/fork 之后【新会话的文件】在哪？（fork 出来的会话是独立文件吗？）
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";

const TEST_SESSION =
    "/home/liuqingxue/.pi/agent/sessions/--home-liuqingxue--/2026-09-30T07-57-10-757Z_01a0f151-46e4-7604-8876-4f8846432a99.jsonl";
const CWD = "/home/liuqingxue";
const CLI = "/home/liuqingxue/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";

const log = (tag, msg) => console.log(`[${tag}] ${msg}`);

const child = spawn("node", [CLI, "--mode", "rpc", "--no-extensions"], {
    cwd: CWD,
    stdio: ["pipe", "pipe", "pipe"],
});

const rl = createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 1;

child.stderr.on("data", (b) => {
    const s = String(b).trim();
    if (s) log("stderr", s.slice(0, 160));
});

rl.on("line", (line) => {
    let msg;
    try {
        msg = JSON.parse(line);
    } catch {
        return;
    }
    if (msg.type === "response" && msg.id && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
    }
});

function send(command) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify({ id, ...command }) + "\n");
        setTimeout(() => {
            if (pending.has(id)) {
                pending.delete(id);
                reject(new Error(`超时: ${command.type}`));
            }
        }, 15000);
    });
}

const ok = (r) => (r.success ? "✓" : `✗ ${r.error}`);

async function state() {
    const r = await send({ type: "get_state" });
    return r.data;
}

async function main() {
    await new Promise((r) => setTimeout(r, 1200));

    // ── 0. 先切到 test 会话 ──
    let r = await send({ type: "switch_session", sessionPath: TEST_SESSION });
    log("switch", ok(r));
    let s = await state();
    log("基准", `file=${path.basename(s.sessionFile ?? "")} msgs=${s.messageCount}`);

    // ── 1. clone ──
    log("", "──── clone ────");
    r = await send({ type: "clone" });
    log("clone 返回", `${ok(r)}  ${JSON.stringify(r.data ?? {})}`.slice(0, 200));
    s = await state();
    log("clone 后状态", `file=${path.basename(s.sessionFile ?? "")} msgs=${s.messageCount}`);

    // ── 2. get_fork_messages ──
    log("", "──── get_fork_messages ────");
    r = await send({ type: "get_fork_messages" });
    log("返回", ok(r));
    const fms = r.data?.messages ?? [];
    log("可 fork 的消息", `${fms.length} 条`);
    for (const m of fms.slice(0, 6)) {
        log("  ·", `entryId=${m.entryId?.slice(0, 12)}… text=${JSON.stringify((m.text ?? "").slice(0, 40))}`);
    }

    // ── 3. fork 最后一条（= 最新用户消息 ✓）──
    if (fms.length) {
        const last = fms[fms.length - 1];
        log("", `──── fork(最后一条 entryId=${last.entryId?.slice(0, 12)}…) ────`);
        r = await send({ type: "fork", entryId: last.entryId });
        log("fork 返回", `${ok(r)}  ${JSON.stringify(r.data ?? {})}`.slice(0, 200));
        s = await state();
        log("fork 后状态", `file=${path.basename(s.sessionFile ?? "")} msgs=${s.messageCount}`);
    }

    // ── 4. fork 第一条（看是不是能回到早期 ✓）──
    if (fms.length > 1) {
        const first = fms[0];
        log("", `──── fork(第一条 entryId=${first.entryId?.slice(0, 12)}…) ────`);
        r = await send({ type: "fork", entryId: first.entryId });
        log("fork 返回", `${ok(r)}  ${JSON.stringify(r.data ?? {})}`.slice(0, 200));
        s = await state();
        log("fork 后状态", `file=${path.basename(s.sessionFile ?? "")} msgs=${s.messageCount}`);
        const gm = await send({ type: "get_messages" });
        log("新会话消息数", String(gm.data?.messages?.length ?? "?"));
    }

    child.stdin.end();
    setTimeout(() => process.exit(0), 400);
}

main().catch((e) => {
    console.error("失败:", e.message);
    process.exit(1);
});

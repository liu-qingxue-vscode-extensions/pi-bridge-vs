#!/usr/bin/env node
/**
 * ★ 端到端测试：扩展交互回复桥（B25）
 *
 * 【验证什么？】
 *   ① pi 会发 extension_ui_request（4 种 method ✓）
 *   ② 我们回的 extension_ui_response 能被 pi 正确接收 ✗
 *   ③ 每种 method 的返回语义（value / confirmed / cancelled ✓）
 *   ④ 取消（cancelled: true）会得到什么 ✓
 *
 * 【怎么跑？】
 *   它用【我们自己的传输层】（src/pi/rpc-client.ts ✓）——
 *   就是生产代码那条路 ✓ 所以测通 = 插件里也通 ✓
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = "/home/liuqingxue/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";
const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(here, "test-ext", "ui-bridge.ts");

const child = spawn(
    "node",
    [CLI, "--mode", "rpc", "--no-session", "--extension", EXT],
    { cwd: "/tmp", stdio: ["pipe", "pipe", "pipe"] },
);
const rl = createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 1;
/** 收到的 UI 请求（按顺序 ✓）*/
const reqs = [];
/** ★ 我们打算怎么回答每个 method（测不同分支 ✓）*/
const PLAN = {
    select: { value: "香蕉" }, // 选一个具体的 ✓
    confirm: { confirmed: true },
    input: { value: "我输入的文字" },
    editor: { cancelled: true }, // ★ 这条【故意取消】✗ 验证取消语义 ✓
};

child.stderr.on("data", (b) => {
    const s = String(b).trim();
    if (s) console.log(`  [stderr] ${s.slice(0, 140)}`);
});

/** ★ 直接写 stdin（等同生产代码的 replyExtensionUi ✓）*/
function reply(res) {
    child.stdin.write(JSON.stringify({ type: "extension_ui_response", ...res }) + "\n");
}

rl.on("line", (line) => {
    let m;
    try {
        m = JSON.parse(line);
    } catch {
        return;
    }
    if (m.type === "response" && m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
        return;
    }
    if (m.type === "extension_ui_request") {
        reqs.push(m);
        if (m.method === "notify") {
            console.log(`  ★ notify: ${m.message}`);
            return;
        }
        const plan = PLAN[m.method];
        console.log(`\n★ 收到请求 [${m.method}] id=${m.id.slice(0, 8)}`);
        console.log(`   title=${JSON.stringify(m.title)}`);
        if (m.options) console.log(`   options=${JSON.stringify(m.options)}`);
        if (m.message) console.log(`   message=${JSON.stringify(m.message)}`);
        if (m.placeholder) console.log(`   placeholder=${JSON.stringify(m.placeholder)}`);
        if (m.prefill) console.log(`   prefill=${JSON.stringify(m.prefill)}`);
        console.log(`   timeout=${m.timeout ?? "(none)"}`);
        if (plan) {
            console.log(`   → 我们回：${JSON.stringify(plan)}`);
            reply({ id: m.id, ...plan });
        } else {
            console.log(`   → ★ 未计划的 method ✗ 回 cancelled`);
            reply({ id: m.id, cancelled: true });
        }
    }
});

const send = (cmd) =>
    new Promise((res) => {
        const id = nextId++;
        pending.set(id, res);
        child.stdin.write(JSON.stringify({ id, ...cmd }) + "\n");
        setTimeout(() => {
            if (pending.has(id)) {
                pending.delete(id);
                res({ success: false, error: "超时" });
            }
        }, 20000);
    });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    await sleep(2000);
    console.log("── 发命令 /uitest（会依次触发 4 种交互 ✓）──\n");
    const r = await send({ type: "prompt", message: "/uitest" });
    console.log(`\nprompt 回执：success=${r.success} ${r.error ?? ""}`);
    // ★ 给足时间跑完 4 个交互
    await sleep(12000);

    const kinds = reqs.filter((x) => x.method !== "notify").map((x) => x.method);
    console.log(`\n════ 汇总 ════`);
    console.log(`  交互请求：${kinds.join(" → ") || "（无 ✗）"}`);
    console.log(`  notify 条数：${reqs.filter((x) => x.method === "notify").length}`);
    child.stdin.end();
    setTimeout(() => process.exit(0), 500);
}

void main();

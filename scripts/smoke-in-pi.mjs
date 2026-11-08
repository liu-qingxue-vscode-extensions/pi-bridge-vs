#!/usr/bin/env node
/**
 * smoke-in-pi.mjs —— 验证我们自己的 pi 扩展（src/in-pi）能不能真的跑起来
 *
 * 【为什么需要它】
 *   in-pi 扩展的核心行为（工具注册 / appendEntry / turn_end 里 abort）
 *   只有"真跑一次模型"才能验证 ✗ 用 tsc 检查不出来。
 *
 * 【它做什么】
 *   起一个 RPC 模式的 pi，带着我们的扩展，发一句让它调 vs_write 的话，
 *   然后把关键事件按顺序打出来：tool_execution_* / entry_appended / abort 迹象。
 *
 * 跑法：node scripts/smoke-in-pi.mjs
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const ROOT = path.resolve(import.meta.dirname, "..");
const EXT = path.join(ROOT, "dist", "in-pi", "index.mjs");

if (!existsSync(EXT)) {
    console.error(`找不到 ${EXT} ⇒ 先跑 npm run build:in-pi`);
    process.exit(1);
}

const CANDIDATES = [
    process.env.PI_BIN,
    path.join(os.homedir(), ".npm-global", "bin", "pi"),
    "/usr/local/bin/pi",
    "/usr/bin/pi",
].filter(Boolean);

const piBin = CANDIDATES.find((p) => existsSync(p));
if (!piBin) {
    console.error("找不到 pi 可执行文件（设 PI_BIN 指定）");
    process.exit(1);
}

console.log(`pi   = ${piBin}`);
console.log(`ext  = ${EXT}\n`);

const child = spawn(piBin, ["--mode", "rpc", "--no-session", "-e", EXT], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
});

let settled = false;
let sawTool = false;
let sawAppend = false;

const timer = setTimeout(() => {
    console.log("\n★ 超时（120s）——强制结束");
    child.kill("SIGKILL");
    process.exit(2);
}, 120_000);

child.stderr.on("data", (b) => {
    const t = b.toString();
    // 只显示跟我们扩展有关的部分（其他扩展的警告是噪音）
    for (const line of t.split("\n")) {
        if (/in-pi|vs-proposal|vs_write|error|Error/.test(line) && line.trim()) {
            console.log(`[stderr] ${line.trim()}`);
        }
    }
});

let buf = "";
child.stdout.on("data", (b) => {
    buf += b.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) handle(line);
    }
});

function handle(line) {
    let d;
    try {
        d = JSON.parse(line);
    } catch {
        return;
    }
    const t = d.type;

    if (t === "tool_execution_start") {
        sawTool = true;
        console.log(`[tool_start ] ${d.toolName} ${JSON.stringify(d.args ?? {}).slice(0, 160)}`);
    } else if (t === "tool_execution_end") {
        console.log(`[tool_end   ] ${d.toolName} isError=${d.isError}`);
    } else if (t === "entry_appended") {
        const e = d.entry ?? {};
        console.log(`[entry      ] ${e.type}${e.customType ? `/${e.customType}` : ""}`);
        if (e.customType === "vs-proposal") {
            sawAppend = true;
            console.log(`             data=${JSON.stringify(e.data).slice(0, 220)}`);
        }
    } else if (t === "turn_end") {
        console.log(`[turn_end   ] toolResults=${(d.toolResults ?? []).length}`);
    } else if (t === "agent_settled") {
        settled = true;
        console.log(`[settled    ] aborted=${d.aborted}`);
        finish();
    } else if (t === "message_end") {
        const m = d.message ?? {};
        if (m.role === "assistant") {
            for (const c of m.content ?? []) {
                if (c.type === "text" && c.text?.trim()) {
                    console.log(`[assistant  ] ${c.text.trim().slice(0, 200)}`);
                }
            }
        }
    }
}

function finish() {
    clearTimeout(timer);
    child.stdin.end();
    setTimeout(() => child.kill("SIGKILL"), 500);

    console.log("\n===== 判定 =====");
    const ok1 = sawTool;
    const ok2 = sawAppend;
    const ok3 = settled;
    console.log(`${ok1 ? "✓" : "✗"} 模型真的调用了工具`);
    console.log(`${ok2 ? "✓" : "✗"} vs-proposal 条目真的写进了会话`);
    console.log(`${ok3 ? "✓" : "✗"} 跑完之后 agent 停下来了（settled）`);
    process.exit(ok1 && ok2 && ok3 ? 0 : 1);
}

child.stdin.write(
    JSON.stringify({
        type: "prompt",
        id: "p1",
        message:
            "调用 vs_write 工具提交一个提案，参数：file=a.txt, startLine=1, endLine=1, " +
            "newText=hello, explanation=这是冒烟测试。直接调用，不要解释。",
    }) + "\n",
);

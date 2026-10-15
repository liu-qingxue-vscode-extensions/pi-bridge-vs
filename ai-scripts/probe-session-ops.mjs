/**
 * probe-session-ops —— 真跑一遍【会话相关命令】，看它们到底通不通
 *
 * 【测什么】
 *   ① 删掉 --no-session 后，pi 是否真的会写会话文件（get_state.sessionFile）
 *   ② switch_session 能不能切过去
 *   ③ get_messages 返回的 messages 结构长什么样（这是历史重放的数据源 ✓）
 *
 * 【为什么用临时 cwd？】
 *   我们会在里面产生新会话文件 ✗ → 不能污染你真实的工作目录 ✓
 *
 * 【用法】node scripts/probe-session-ops.mjs [--keep]
 *   --keep  保留临时目录（默认会删 ✓）
 *
 * 【输出】摘要打到终端 + 完整结构导出到 test_date/session-ops.json ✓
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { OwnRpcClient } from "../dist/pi/rpc-client.js";

const CLI = path.join(
    os.homedir(),
    ".npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pi-probe-sess-"));
const OUT_DIR = path.join(import.meta.dirname, "..", "test_date");

/** 收集所有 response 的摘要（不打印全文 ✓） */
const responses = [];

const client = new OwnRpcClient({ cliPath: CLI, cwd: TMP });

// ★ 现在回执也会广播 → 这里能收到 ✓
client.onEvent((e) => {
    if (e.type === "response") {
        responses.push({
            command: e.command,
            success: e.success,
            error: e.error,
            // data 只留结构摘要（不然会很大 ✗）
            dataKeys: e.data && typeof e.data === "object" ? Object.keys(e.data) : undefined,
            dataType: Array.isArray(e.data) ? "array" : typeof e.data,
        });
    }
});

console.log("临时 cwd:", TMP);

await client.start();
console.log("✓ start");

// ① 看 sessionFile（★ 删掉 --no-session 后应该【有】✓）
const state = await client.getState();
const st = state;
console.log("① get_state:");
console.log("   sessionFile:", st?.sessionFile ?? "(null ✗)");
console.log("   sessionId:  ", st?.sessionId ?? "(null)");
console.log("   messageCount:", st?.messageCount);

// ② 看现在有几个会话文件（应该有 1 个：刚建的这个 ✓）
const sessionsRoot = path.join(os.homedir(), ".pi/agent/sessions");
const dirForTmp = fs
    .readdirSync(sessionsRoot)
    .filter((d) => d.includes(TMP.replace(/\//g, "-").replace(/^-/, "")))
    .map((d) => path.join(sessionsRoot, d))[0];

let files = [];
if (dirForTmp && fs.existsSync(dirForTmp)) {
    files = fs.readdirSync(dirForTmp).filter((f) => f.endsWith(".jsonl"));
}
console.log("\n② 临时 cwd 的会话文件:", files.length, "个");
files.slice(0, 3).forEach((f) => console.log("   ", f));

// ③ get_messages（空会话 —— 先看结构是否可用 ✓）
console.log("\n③ get_messages（当前空会话）:");
const msgs = await client.send({ type: "get_messages" });
const msgArr = msgs?.data?.messages;
console.log("   success:", msgs.success, "messages 是数组:", Array.isArray(msgArr), "长度:", msgArr?.length);

// ④ 拿一个【已有会话】试着切过去（用真实的旧会话 ✓）
let switched = null;
let oldMsgs = null;
if (files.length === 0) {
    // 没产生新文件 → 找任意一个已有会话
}
const anyOther = findAnyOldSession(sessionsRoot);
if (anyOther) {
    console.log("\n④ switch_session →", path.basename(anyOther));
    try {
        const r = await client.send({ type: "switch_session", sessionPath: anyOther });
        switched = { success: r.success, error: r.error };
        console.log("   success:", r.success, r.error ? `error: ${r.error}` : "");

        if (r.success) {
            const after = await client.send({ type: "get_messages" });
            oldMsgs = after?.data?.messages;
            console.log("   切换后 messages:", Array.isArray(oldMsgs) ? oldMsgs.length + " 条" : typeof oldMsgs);
            if (Array.isArray(oldMsgs) && oldMsgs.length) {
                const roles = {};
                for (const m of oldMsgs) roles[m.role] = (roles[m.role] ?? 0) + 1;
                console.log("   角色分布:", JSON.stringify(roles));
                // 看第一条 assistant 的 content 块类型
                const asst = oldMsgs.find((m) => m.role === "assistant");
                if (asst) {
                    const types = (Array.isArray(asst.content) ? asst.content : []).map((c) => c.type);
                    console.log("   首条 assistant 的块类型:", JSON.stringify(types));
                }
            }
        }
    } catch (err) {
        switched = { success: false, error: String(err) };
        console.log("   ✗ 异常:", String(err).slice(0, 200));
    }
} else {
    console.log("\n④ 没有找到可切换的旧会话（跳过）");
}

await client.stop();
console.log("\n✓ stop");

// ── 导出摘要 ──
fs.mkdirSync(OUT_DIR, { recursive: true });
const report = {
    tmpCwd: TMP,
    sessionFile: st?.sessionFile ?? null,
    sessionFilesInTmp: files,
    responses,
    switchResult: switched,
    oldSessionMessages: {
        count: Array.isArray(oldMsgs) ? oldMsgs.length : null,
        sample: Array.isArray(oldMsgs) ? oldMsgs.slice(0, 3) : null,
    },
};
fs.writeFileSync(path.join(OUT_DIR, "session-ops.json"), JSON.stringify(report, null, 2));

console.log("\n══ 收到的回执（★ 验证广播是否生效）══");
for (const r of responses) console.log(`  ${r.command}: success=${r.success} data=${r.dataType ?? "-"}${r.error ? " err=" + r.error : ""}`);
console.log("\n✓ 摘要已导出: test_date/session-ops.json");

if (!process.argv.includes("--keep")) {
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log("✓ 已清理临时目录");
} else {
    console.log("（保留临时目录）", TMP);
}

/** 找任意一个【有效的】旧会话文件（首行必须是 session 元数据 ✓）
 *  ★ 为什么要校验？实测 pi 会拒绝无效文件：
 *    “Session file is not a valid pi session” ✓
 *    （这正好印证了我们的 broken 检测与 pi 一致 ✓）*/
function findAnyOldSession(root) {
    const out = [];
    for (const dir of fs.readdirSync(root)) {
        const p = path.join(root, dir);
        if (!fs.statSync(p).isDirectory()) continue;
        if (dir.includes("pi-probe-sess")) continue; // 跳过自己刚建的 ✓
        for (const f of fs.readdirSync(p)) {
            if (!f.endsWith(".jsonl")) continue;
            const full = path.join(p, f);
            // ★ 校验首行（与 pi 同口径 ✓）
            try {
                const fd = fs.openSync(full, "r");
                const buf = Buffer.alloc(512);
                const n = fs.readSync(fd, buf, 0, 512, 0);
                fs.closeSync(fd);
                const first = buf.subarray(0, n).toString("utf8").split("\n", 1)[0];
                const o = JSON.parse(first);
                if (o?.type !== "session" || !o.cwd) continue;
            } catch {
                continue;
            }
            out.push({ full, size: fs.statSync(full).size });
        }
    }
    out.sort((a, b) => a.size - b.size); // 小的快 ✓
    return out[0]?.full;
}

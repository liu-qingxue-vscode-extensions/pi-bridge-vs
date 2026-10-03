/**
 * probe-new-session —— 查 new_session 的【实际行为】
 *
 * 【要回答的问题】（用户问的 ✓）
 *   点"新建会话"时：
 *     · 会话文件是【立刻创建】✗ 还是【等到第一句话才创建】✓？
 *     · get_state 给的 sessionFile 到底存不存在？
 *     · new_session 之后 sessionFile 会变吗？
 *
 * 【为什么必须实测】pi 官方没有文档说明这个 ✗ 猜不得 ✓
 *
 * 【用法】node scripts/probe-new-session.mjs
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { OwnRpcClient } from "../dist/pi/rpc-client.js";

const CLI = path.join(
    os.homedir(),
    ".npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pi-probe-new-"));
const client = new OwnRpcClient({ cliPath: CLI, cwd: TMP });

/** 看某个 sessionFile 在磁盘上到底有没有 */
function exists(p) {
    if (!p) return "（无路径）";
    try {
        const st = fs.statSync(p);
        return `★ 存在（${st.size}B）`;
    } catch {
        return "✗ 不存在";
    }
}

/** 简短的 state 摘要 */
function brief(s) {
    return {
        file: s?.sessionFile ? path.basename(s.sessionFile) : "(null)",
        id: s?.sessionId?.slice(0, 8) ?? "(null)",
        msgCount: s?.messageCount,
    };
}

async function state(label) {
    const r = await client.send({ type: "get_state" });
    const d = r?.data;
    const b = brief(d);
    console.log(`\n── ${label} ──`);
    console.log(`   sessionId:   ${b.id}`);
    console.log(`   messageCount:${b.msgCount}`);
    console.log(`   sessionFile: ${b.file}`);
    console.log(`   磁盘上:      ${exists(d?.sessionFile)}`);
    return d;
}

await client.start();
console.log("临时 cwd:", TMP);

// ① 刚启动
const s1 = await state("① 刚启动（还没说话）");

// ② 发一句话
console.log("\n发一句 prompt（mock 不需要 —— 这里只看文件行为，直接 abort 掉也行）");
await client.send({ type: "prompt", message: "你好" }).catch(() => {});
// 不等它跑完，稍等即可（文件应该在 prompt 开始时立刻建 ✓）
await new Promise((r) => setTimeout(r, 1500));
const s2 = await state("② 发了一句话之后");

// ③ new_session
console.log("\n发 new_session");
const nr = await client.send({ type: "new_session" });
console.log("   new_session 返回:", JSON.stringify(nr).slice(0, 120));
const s3 = await state("③ new_session 之后");

// ④ 等一会儿，看文件会不会自己冒出来
await new Promise((r) => setTimeout(r, 800));
const s4 = await state("④ 又等了 800ms");

// ⑤ 再发一句话（新会话里）
await client.send({ type: "prompt", message: "第二句" }).catch(() => {});
await new Promise((r) => setTimeout(r, 1500));
const s5 = await state("⑤ 新会话里发了一句话之后");

await client.stop();
fs.rmSync(TMP, { recursive: true, force: true });

console.log("\n═══ 结论 ═══");
console.log("① 启动时 sessionFile 存在吗:", exists(s1?.sessionFile));
console.log("② 说话之后:", exists(s2?.sessionFile));
console.log("③ new_session 之后:", exists(s3?.sessionFile));
console.log("⑤ 再说话之后:", exists(s5?.sessionFile));
console.log("\n★ sessionFile 是否变化:");
console.log("   ①→② :", s1?.sessionFile === s2?.sessionFile ? "不变" : "★ 变了");
console.log("   ②→③ :", s2?.sessionFile === s3?.sessionFile ? "不变" : "★ 变了（new_session 换了路径）");
console.log("   ③→⑤ :", s3?.sessionFile === s5?.sessionFile ? "不变" : "★ 变了");

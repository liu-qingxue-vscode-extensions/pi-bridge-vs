/**
 * check-session-file —— 验证"直接读会话文件"能拿到渲染所需的一切
 *
 * 为什么值得：
 *   ★ 这一步是【零子进程渲染】的地基（打开/切会话不再启动 pi）
 *   · 如果消息抽漏了 ✗ 渲染就少东西 ⇒ 而且表现为"偶发少一段"✗ 极难发现
 *   · 如果 live 状态（模型/会话名）抽错了 ✗ 顶栏显示就错
 *   ⇒ 用真实会话文件对照 ✓
 *
 * 跑法：node scripts/check-session-file.mjs [会话文件路径]
 */

import { readSessionFile } from "../dist/bridge/session-file.js";
import { messagesToPatches } from "../dist/bridge/replay.js";
import { existsSync, readdirSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let failed = 0;
let passed = 0;
function check(name, cond, detail = "") {
    if (cond) {
        passed++;
        console.log(`  ✓ ${name}`);
    } else {
        failed++;
        console.log(`  ✗ ${name} ${detail}`);
    }
}

/** 找一个真实会话文件（取最近的）*/
function findLatestSession() {
    const root = path.join(os.homedir(), ".pi", "agent", "sessions");
    if (!existsSync(root)) return undefined;
    let best;
    let bestAt = 0;
    for (const dir of readdirSync(root)) {
        const full = path.join(root, dir);
        try {
            if (!statSync(full).isDirectory()) continue;
        } catch {
            continue;
        }
        for (const f of readdirSync(full)) {
            if (!f.endsWith(".jsonl")) continue;
            const p = path.join(full, f);
            const at = statSync(p).mtimeMs;
            if (at > bestAt) {
                bestAt = at;
                best = p;
            }
        }
    }
    return best;
}

const target = process.argv[2] ?? findLatestSession();
console.log("=== readSessionFile ===\n");
if (!target) {
    console.log("  没找到会话文件 —— 跳过（不影响通过）");
    process.exit(0);
}
console.log(`  文件: ${target.replace(os.homedir(), "~")}\n`);

const data = readSessionFile(target);

check("读到了消息", data.messages.length > 0, `(得到 ${data.messages.length} 条)`);
check("live.records 有值（说明真的解析了）", data.live.records > 0, `(${data.live.records})`);

// ── 消息内容检查（渲染需要的都在）──
const roles = {};
const blocks = {};
for (const m of data.messages) {
    const r = m.role ?? "(无)";
    roles[r] = (roles[r] ?? 0) + 1;
    if (Array.isArray(m.content)) {
        for (const p of m.content) {
            if (p && typeof p === "object" && "type" in p) {
                const k = `${r}:${p.type}`;
                blocks[k] = (blocks[k] ?? 0) + 1;
            }
        }
    }
}
console.log("\n  角色分布:", JSON.stringify(roles));
console.log("  内容块:", JSON.stringify(blocks));

check("有 assistant 消息", (roles.assistant ?? 0) > 0);
check("有 user 消息", (roles.user ?? 0) > 0);
check(
    "assistant 里有 thinking 或 text 或 toolCall",
    Object.keys(blocks).some((k) => k.startsWith("assistant:")),
);

// ── 关键：能不能直接喂 messagesToPatches（说明与 get_messages 同构）──
let patches;
try {
    patches = messagesToPatches(data.messages);
    check("★ 能直接喂 messagesToPatches（与 get_messages 同构）", patches.length > 0, `(${patches.length} 个 patch)`);
} catch (e) {
    check("★ 能直接喂 messagesToPatches", false, String(e));
}

// ── 工具结果里有没有 details（edit 的 diff 靠它）──
const toolResults = data.messages.filter((m) => m.role === "toolResult");
const withDetails = toolResults.filter((m) => m.details !== undefined);
console.log(
    `\n  toolResult: ${toolResults.length} 条 ✗ 其中带 details 的 ${withDetails.length} 条`,
);
if (toolResults.length) {
    check("toolResult 结构可用（有 toolCallId）", toolResults.some((m) => typeof m.toolCallId === "string"));
}

// ── ★★ B46：压缩裁剪 ──
//   【为什么必须测】裁剪是"赌上一半历史不渲染"的开关 ✗ 错了就是整段内容消失 ✓
//   三条不变量：① 压缩伪消息最多一个（只显示最新的 ✓）
//              ② 它必须排在【最前】（它代表"此前的一切"✓）
//              ③ 能产出 compactionBubble 指令（前端才画得出气泡 ✓）
const comps = data.messages.filter((m) => m.role === "__compaction");
console.log(`\n  压缩条目: ${comps.length} 个`);
if (comps.length) {
    check("★ 压缩伪消息最多一个（只显示最新的）", comps.length === 1, `(得到 ${comps.length})`);
    check("★ 压缩伪消息排在最前", data.messages[0]?.role === "__compaction");
    check("★ 摘要非空", typeof comps[0].compaction?.summary === "string" && comps[0].compaction.summary.length > 0);
    check("★ token 数可用（显示 此前 ≈N tokens）", typeof comps[0].compaction?.tokensBefore === "number");
    const cb = (patches ?? []).filter((x) => x.kind === "compactionBubble");
    check("★ 能产出 compactionBubble 指令", cb.length === 1, `(得到 ${cb.length})`);
} else {
    console.log("  （这个会话没压缩过 ⇒ 跳过压缩检查 ✓）");
}

// ── live 状态 ──
console.log("\n  live:", JSON.stringify(data.live));

console.log(`\n=== ${passed} 通过 ✗ ${failed} 失败 ===`);
if (failed) {
    console.error("★ 会话文件解析有问题 ⇒ 零子进程渲染会少东西");
    process.exit(1);
}

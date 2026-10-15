#!/usr/bin/env node
/**
 * ★ 实测：launchArgs 指定模型 + 切换到"会话里记录过模型"的会话 → 谁赢？
 *
 * 用户的疑问（原话）：
 *   "我尝试用 load 参数启动一个模型，结果它显示错误……
 *    它的状态里应该记录的是一个模型，但是我启用的就是另一个模型，
 *    而且同时还传了绘画（=会话），这会发生什么化学反应？"
 *
 * 即：优先级到底是
 *   ① CLI 的 --model ？
 *   ② 会话文件里的 model_change ？
 *   ③ 会话里最后一条消息用的 model ？
 *
 * 【测法】
 *   起 pi 用 --model A → 看 get_state
 *   → switch_session 到一个"记录过模型 B"的会话 → 再看 get_state
 *   → set_model C → 再看
 *   → 顺便每步都试一次 prompt（看会不会报错 ✓ 因为用户说"显示错误"✗）
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";

const CLI = "/home/liuqingxue/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";
const CWD = "/home/liuqingxue";
const SESS_DIR = "/home/liuqingxue/.pi/agent/sessions/--home-liuqingxue--";

/** 找一个含 model_change 的会话文件 ✓ */
const target = fs
    .readdirSync(SESS_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => `${SESS_DIR}/${f}`)
    .find((p) => fs.readFileSync(p, "utf8").includes('"model_change"'));

/** 看看那个会话里记录了什么模型 */
const lines = fs.readFileSync(target, "utf8").split("\n").filter(Boolean);
const changes = lines
    .map((l) => {
        try {
            return JSON.parse(l);
        } catch {
            return null;
        }
    })
    .filter((o) => o?.type === "model_change")
    .map((o) => `${o.provider}/${o.modelId}`);
console.log(`目标会话：${target.split("/").pop()}`);
console.log(`它记录过的模型：${changes.join(" → ")}`);

// ★ 用 launchArgs 指定另一个模型（本地 ollama ✓ 便宜）
const START_MODEL = "ollama/qwen2.5:3b";
console.log(`\n启动参数指定：${START_MODEL}\n`);

const child = spawn("node", [CLI, "--mode", "rpc", "--no-extensions", "--model", START_MODEL], {
    cwd: CWD,
    stdio: ["pipe", "pipe", "pipe"],
});
const rl = createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 1;
const stderrLines = [];
child.stderr.on("data", (b) => stderrLines.push(String(b).trim()));

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
    }
});
const send = (c) =>
    new Promise((res) => {
        const id = nextId++;
        pending.set(id, res);
        child.stdin.write(JSON.stringify({ id, ...c }) + "\n");
        setTimeout(() => {
            if (pending.has(id)) {
                pending.delete(id);
                res({ success: false, error: "超时" });
            }
        }, 20000);
    });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const show = async (tag) => {
    const r = await send({ type: "get_state" });
    const m = r.data?.model;
    const model = m ? `${m.provider}/${m.id}` : JSON.stringify(m);
    console.log(
        `  [${tag}] model=${model}  thinkingLevel=${r.data?.thinkingLevel}  msgs=${r.data?.messageCount}`,
    );
    return model;
};

async function main() {
    await sleep(1500);
    console.log("① 刚启动（CLI 给了 --model）：");
    await show("启动后");

    console.log("\n② switch_session 到那个会话（它记录过别的模型）：");
    const r = await send({ type: "switch_session", sessionPath: target });
    console.log(`  切换回执：success=${r.success} ${r.error ?? ""}`);
    await sleep(500);
    await show("切换后");

    console.log("\n③ 试发一句（看会不会报错 ✗ 用户说会显示错误）：");
    const p = await send({ type: "prompt", message: "说一个字：好" });
    console.log(`  prompt 回执：success=${p.success} ${p.error ?? ""}`);
    await sleep(6000);
    const st = await send({ type: "get_state" });
    console.log(`  after prompt: model=${st.data?.model?.provider}/${st.data?.model?.id}`);
    const gm = await send({ type: "get_messages" });
    const last = (gm.data?.messages ?? []).slice(-1)[0];
    console.log(`  最后一条消息 role=${last?.role} stopReason=${last?.stopReason ?? "-"}`);

    console.log("\n④ set_model 到一个【不在启动参数里的】模型：");
    const sm = await send({
        type: "set_model",
        provider: "ollama",
        modelId: "deepseek-r1:14b",
    });
    console.log(`  set_model 回执：success=${sm.success} ${sm.error ?? ""}`);
    if (sm.data) console.log(`  返回的模型：${sm.data?.provider}/${sm.data?.id}`);
    await show("set_model 后");

    console.log("\n⑤ stderr 摘要（错误都在这 ✗）：");
    const uniq = [...new Set(stderrLines.filter(Boolean))].slice(0, 6);
    uniq.forEach((l) => console.log(`  · ${l.slice(0, 160)}`));
    if (!uniq.length) console.log("  （无 stderr ✓）");

    child.stdin.end();
    setTimeout(() => process.exit(0), 400);
}

main().catch((e) => {
    console.error("失败:", e.message);
    process.exit(1);
});

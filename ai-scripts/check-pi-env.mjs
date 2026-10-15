/**
 * check-pi-env —— 验证 pi-env.ts 的路径解析与【真实环境】一致
 *
 * 为什么值得一个脚本：
 *   · 这套路径是【约定】（环境变量 + 默认值）✗ 算错了会让整个扩展指向错地方
 *   · 而且它决定了"会话面板显示什么 / 设置写到哪"✗ 错了很危险（在错误路径创建配置）
 *   · ★ 它是纯逻辑（不 import vscode）⇒ 可以直接用 Node 喂真实路径来对照
 *
 * 跑法：node scripts/check-pi-env.mjs
 */

import {
    resolveAgentDir,
    resolvePackageDir,
    resolveSessionRoot,
    versionFromPackageDir,
    cliPathFromPackageDir,
    changelogPath,
    ENV_AGENT_DIR,
    ENV_SESSION_DIR,
} from "../dist/pi/pi-env.js";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let failed = 0;
let passed = 0;
function check(name, got, want) {
    const ok = got === want;
    if (ok) passed++;
    else failed++;
    console.log(`  ${ok ? "✓" : "✗"} ${name}`);
    if (!ok) {
        console.log(`      期望: ${JSON.stringify(want)}`);
        console.log(`      实际: ${JSON.stringify(got)}`);
    }
}

console.log("=== pi-env 路径解析 ===\n");

// ── ① 默认 agentDir（无环境变量时 = ~/.pi/agent ✗ 和 pi 的 getAgentDir 一致）──
const MOCK_NO_ENV = { HOME: os.homedir() };
check(
    "默认 agentDir = ~/.pi/agent",
    resolveAgentDir(MOCK_NO_ENV),
    path.join(os.homedir(), ".pi", "agent"),
);

// ── ② 环境变量覆盖（PI_CODING_AGENT_DIR ✗ 注意不是 PI_CONFIG_DIR）──
check(
    "PI_CODING_AGENT_DIR 覆盖生效",
    resolveAgentDir({ ...MOCK_NO_ENV, [ENV_AGENT_DIR]: "/tmp/custom-agent" }),
    "/tmp/custom-agent",
);
check(
    "带 ~ 的环境变量会展开",
    resolveAgentDir({ ...MOCK_NO_ENV, [ENV_AGENT_DIR]: "~/my-pi" }),
    path.join(os.homedir(), "my-pi"),
);

// ── ③ 真实环境：包目录探测（应该能找到全局装的 pi）──
const real = resolvePackageDir(undefined, process.env);
console.log(`\n  [实测] resolvePackageDir() = ${real ? real.dir : "(没找到)"}  来源=${real?.source}`);
if (real) {
    console.log(`  [实测] 版本 = ${versionFromPackageDir(real.dir)}`);
    console.log(`  [实测] CLI  = ${cliPathFromPackageDir(real.dir)}`);
    console.log(`  [实测] 日志 = ${changelogPath(real.dir)}`);
    check("探测到的包目录里有 package.json", existsSync(path.join(real.dir, "package.json")), true);
    check("探测到的 CLI 文件存在", existsSync(cliPathFromPackageDir(real.dir)), true);
    check("探测到的 CHANGELOG 存在", existsSync(changelogPath(real.dir)), true);
}

// ── ④ 会话目录的完整优先级链 ──
const agent = resolveAgentDir(MOCK_NO_ENV);
check(
    "无任何覆盖 ⇒ <agentDir>/sessions",
    resolveSessionRoot(agent, [], MOCK_NO_ENV).dir,
    path.join(agent, "sessions"),
);
check(
    "环境变量覆盖会话目录",
    resolveSessionRoot(agent, [], { ...MOCK_NO_ENV, [ENV_SESSION_DIR]: "/tmp/s1" }).dir,
    "/tmp/s1",
);
check(
    "★ --session-dir 优先级最高（压过环境变量）",
    resolveSessionRoot(agent, ["--session-dir", "/tmp/s2"], { ...MOCK_NO_ENV, [ENV_SESSION_DIR]: "/tmp/s1" }).dir,
    "/tmp/s2",
);

// ── ⑤ 真实环境：会话目录应该真的存在 ──
const realRoot = resolveSessionRoot(agent, [], process.env);
console.log(`\n  [实测] 会话根 = ${realRoot.dir}  来源=${realRoot.source}`);
console.log(`  [实测] 会话根存在: ${existsSync(realRoot.dir)}`);
console.log(`  [实测] settings.json = ${path.join(agent, "settings.json")} 存在: ${existsSync(path.join(agent, "settings.json"))}`);

console.log(`\n=== ${passed} 通过 ✗ ${failed} 失败 ===`);
if (failed) {
    console.error("★ pi-env 的路径约定与预期不符 ⇒ 会导致整个扩展指向错误位置");
    process.exit(1);
}

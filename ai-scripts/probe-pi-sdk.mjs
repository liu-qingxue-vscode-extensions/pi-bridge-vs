/**
 * probe-pi-sdk —— 探测 pi SDK 那三个【值导出】的真实取值
 *
 * 【为什么要这个脚本】
 *   扩展里用了 pi SDK 的三个值导入：getAgentDir / getPackageDir / VERSION
 *   而它们让整个 pi SDK（8MB ✗ 含 AWS SDK 等）被打进扩展包 ⇒ 不可接受
 *   （★ 而且"本体依赖本体"在信息论上就是错的 —— 扩展该问运行时，不该背 SDK）
 *
 *   所以要把这三个换成本地实现 ✗ 那首先得知道【它们的真实取值】是什么
 *   ⇒ 直接问 SDK 本身（比翻源码可靠 ✗ 也比猜强 ✓）
 *
 * 跑法：node scripts/probe-pi-sdk.mjs
 */
import { getAgentDir, getPackageDir, VERSION } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

const log = (k, v) => console.log(`  ${k.padEnd(18)} ${v}`);

console.log("=== pi SDK 三个值导出的真实取值 ===\n");

log("VERSION =", JSON.stringify(VERSION));

let agentDir = "(调用失败)";
try {
    agentDir = getAgentDir();
} catch (e) {
    agentDir = `(抛错: ${e.message})`;
}
log("getAgentDir() =", JSON.stringify(agentDir));

let pkgDir = "(调用失败)";
try {
    pkgDir = getPackageDir();
} catch (e) {
    pkgDir = `(抛错: ${e.message})`;
}
log("getPackageDir() =", JSON.stringify(pkgDir));

console.log("\n=== 验证：这些路径真的存在吗 ===");
for (const [name, p] of [
    ["agentDir", agentDir],
    ["packageDir", pkgDir],
]) {
    if (typeof p !== "string" || p.startsWith("(")) continue;
    console.log(`  ${name}: ${existsSync(p) ? "✓ 存在" : "✗ 不存在"}`);
}

console.log("\n=== getPackageDir() 下有什么（判断它的语义）===");
if (typeof pkgDir === "string" && existsSync(pkgDir)) {
    const names = readdirSync(pkgDir).slice(0, 12);
    console.log("  " + names.join("  "));
    console.log(`  有 CHANGELOG.md? ${existsSync(path.join(pkgDir, "CHANGELOG.md")) ? "✓" : "✗"}`);
    console.log(`  有 package.json? ${existsSync(path.join(pkgDir, "package.json")) ? "✓" : "✗"}`);
}

console.log("\n=== 环境变量线索 ===");
for (const k of ["PI_CONFIG_DIR", "PI_AGENT_DIR", "PI_CODING_AGENT", "HOME"]) {
    console.log(`  ${k.padEnd(18)} ${process.env[k] ?? "(未设置)"}`);
}

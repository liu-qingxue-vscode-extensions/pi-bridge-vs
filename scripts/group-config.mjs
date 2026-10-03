#!/usr/bin/env node
/**
 * group-config —— 把设置项按【纯对象】分层分组
 *
 * 【分类原则：纯对象】（用户定的，唯一原则 ✓）
 *   不要混"维度"（间距/边框/颜色 是维度 ✗）—— 那些都是【为对象服务】的 ✓
 *   → 一律归到它服务的那个对象下 ✓
 *
 * 【分层】VS Code 只支持一级分组 ✗ → 用标题里的 "：" 模拟第二层 ✓
 *   例："pi-bridge：气泡：工具气泡"
 *
 * 【气泡为什么要再分一层？】
 *   它 26 项，平铺太长了 ✗
 *   按【气泡类型】分：工具 / 思考 / 正文 / 用户 / 其他 ✓
 *
 * 【跨对象的项（如"思考↔工具"的间距）归谁？】
 *   → ★ 归【前面那个对象】（思考↔工具 → 思考 ✓）保持一致 ✓
 *
 * 可重复运行：输入无论扁平对象还是已分组数组都能处理 ✓
 */
import { readFileSync, writeFileSync } from "node:fs";

const path = new URL("../package.json", import.meta.url);
const pkg = JSON.parse(readFileSync(path, "utf8"));

/** 拍平成 键→定义（保留键序 ✓） */
function flatten() {
    const cfg = pkg.contributes.configuration;
    const flat = {};
    if (Array.isArray(cfg)) for (const g of cfg) Object.assign(flat, g.properties ?? {});
    else if (cfg?.properties) Object.assign(flat, cfg.properties);
    else throw new Error("contributes.configuration 结构不认识 ✗");
    return flat;
}

const flat = flatten();

/**
 * ★ 间距项【单独先提出来】（用户定的原则 ✓）
 *
 * 规则：gapA_ToB → 归【A】（前面的那个对象 ✓）
 *   例：gapThinkingToTool → 思考气泡 ✓ / gapTextToTool → 正文气泡 ✓
 *
 * 【为什么不能混在下面的正则里？】
 *   下面用 /tool/ 判断时会【把 ToTool 也匹配进去】✗
 *   → gapThinkingToTool 会被错误地归到工具气泡 ✓（实际踩过 ✗）
 */
const GAP_GROUPS = [
    { title: "气泡：思考气泡", test: /gapThinking/ },
    { title: "气泡：工具气泡", test: /gapTool/ },
    { title: "气泡：正文气泡", test: /gapText|gapTurn/ },
    { title: "气泡：用户气泡", test: /gapUser/ },
];

/**
 * 分组规则（★ 顺序敏感：具体在前 ✓）
 * 只在【pi-bridge.style.*】里再分层；非 style 的按用途分 ✓
 */
const GROUPS = [
    // ── 非 style ──
    { title: "启动", test: /^pi-bridge\.(piCliPath|piAgentDir|launchArgs)$/ },
    // ★ 注意顺序：通知要放会话【前面】（否则 notice 会被会话抢走 ✗）
    { title: "通知", test: /notice/i },
    { title: "顶栏与按钮行", test: /topBarHeight|appToolbarHeight|sessionTitleWidth/ },
    { title: "输入区", test: /input/i },
    // ★ 会话显示范围（用户要求 ✓）
    { title: "会话", test: /^pi-bridge\.sessions\.|sessionPanel/ },
    { title: "调试板", test: /^pi-bridge\.debug\./ },

    // ── 外观（style.*）→ 按【气泡类型】分 ──
    // 工具气泡（含 tool/result/arg 相关的视觉、间距、颜色）
    { title: "气泡：工具气泡", test: /tool|resultLabel|railColorResult|bgTool/i },
    // 思考气泡（含 thinking 相关的间距、颜色）
    { title: "气泡：思考气泡", test: /think|railColorThinking|bgThinking/i },
    // 用户气泡
    { title: "气泡：用户气泡", test: /user/i },
    // 正文气泡（气泡本身的形状 + 正文相关 + 与用户的间距 + 左侧竖线宽度）
    {
        title: "气泡：正文气泡",
        test: /bubbleWidth|bubbleRadius|bubblePadding|sideGap|centerColumn|bgText|borderBubble|railWidth|^pi-bridge\.style\.gap/i,
    },
    // 栏高 / 输入区 已在上方分组（不重复 ✓）

    // ── 剩下的 style 项 → 其他 ──
    { title: "气泡：其他", test: /^pi-bridge\.style\./ },
];

const buckets = GROUPS.map((g) => ({ title: g.title, test: g.test, properties: {} }));
const unassigned = [];

for (const [key, value] of Object.entries(flat)) {
    // ★ 先处理间距（按前缀归到“前面那个对象”✓）
    const gapGroup = GAP_GROUPS.find((g) => g.test.test(key));
    if (gapGroup) {
        const b = buckets.find((x) => x.title === gapGroup.title);
        if (b) {
            b.properties[key] = value;
            continue;
        }
    }
    const g = buckets.find((b) => b.test.test(key));
    if (g) g.properties[key] = value;
    else unassigned.push(key);
}

if (unassigned.length) throw new Error(`有配置项没被分组: ${unassigned.join(", ")}`);

pkg.contributes.configuration = buckets
    .filter((b) => Object.keys(b.properties).length > 0)
    .map((b) => ({ title: `pi-bridge：${b.title}`, properties: b.properties }));

writeFileSync(path, JSON.stringify(pkg, null, 4) + "\n");

console.log("✓ 重新分组：");
for (const g of pkg.contributes.configuration) {
    console.log(`  ${g.title.padEnd(30)} ${String(Object.keys(g.properties).length).padStart(2)} 项`);
}

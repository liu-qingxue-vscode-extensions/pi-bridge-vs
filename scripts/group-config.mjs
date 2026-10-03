#!/usr/bin/env node
/**
 * group-config —— 把 package.json 里的设置项按【对象】重新分组
 *
 * 【为什么是"对象"而不是"维度"？】（用户定的 ✓）
 *   两种分法都能自洽，但【不能混用】✗：
 *     · 按【维度】：启动 / 布局与栏高 / 间距 / 边框 / 左侧竖线 …
 *     · 按【对象】：通知 / 调试板 / 输入区 / 气泡 …
 *   混着来最糟（一会儿按用途、一会儿按尺寸 ✗）
 *
 *   ★ 选【对象】的理由：用户改设置时，脑子里想的是"我要调通知面板",
 *     而不是"我要调间距"✓  —— 以"调哪个东西"为入口，找得最快 ✓
 *
 * 【气泡为什么是一大类？】
 *   气泡、间距、边框、左侧竖线……这些【全都是在为"气泡"服务】✓
 *   → 收纳成同一组 ✓（用户的原话）
 *
 * 【行为组是什么？】
 *   那些"开关某个渲染行为"的项（默认收起 / 露几行 / 标题文字）✓
 *   它们不描述"长什么样"，而是"怎么表现"→ 单独一组 ✓
 *
 * 【VS Code 的限制】只支持一级分组 ✗ → 就用 8 个平级分类 ✓
 *
 * 可重复运行：输入无论【旧的扁平对象】还是【已分组的数组】都能处理 ✓
 */
import { readFileSync, writeFileSync } from "node:fs";

const path = new URL("../package.json", import.meta.url);
const pkg = JSON.parse(readFileSync(path, "utf8"));

/** ── 读：不管当前是什么形状，都拍平成一张 键→定义 的表（保留键序 ✓）── */
function flattenConfiguration() {
    const cfg = pkg.contributes.configuration;
    const flat = {};
    if (Array.isArray(cfg)) {
        for (const group of cfg) Object.assign(flat, group.properties ?? {});
    } else if (cfg?.properties) {
        Object.assign(flat, cfg.properties);
    } else {
        throw new Error("contributes.configuration 结构不认识 —— 手动检查一下 ✗");
    }
    return flat;
}

const flat = flattenConfiguration();

/**
 * ★ 按对象分组（顺序 = 在设置界面里的显示顺序 ✓）
 *
 * 【顺序注意】匹配是从上往下、命中即停 ✓
 *   → 更具体的规则要放前面（如 sessionPanel 不能被 notice 抢走 ✗）
 */
const GROUPS = [
    { title: "启动", test: /^pi-bridge\.(piCliPath|piAgentDir|launchArgs)$/ },

    // ★ 气泡：所有"为气泡服务"的项（形状 / 间距 / 边框 / 竖线 / 背景 / 宽度）
    {
        title: "气泡",
        test: /bubble|sideGap|centerColumn|userMinWidth|^pi-bridge\.style\.(bg|border|rail|gap)/,
    },

    { title: "顶栏与按钮行", test: /topBarHeight|appToolbarHeight/ },
    { title: "输入区", test: /input/i },
    { title: "会话面板", test: /sessionPanel/ },
    { title: "通知", test: /notice/i },
    { title: "调试板", test: /^pi-bridge\.debug\./ },

    // ★ 行为：不是"长什么样"，而是"怎么表现"（开关某个渲染行为 ✓）
    { title: "行为", test: /thinkCollapsed|toolCollapsed|resultLabel|toolPeekLines/ },
];

const buckets = GROUPS.map((g) => ({ title: g.title, test: g.test, properties: {} }));
const unassigned = [];

for (const [key, value] of Object.entries(flat)) {
    const group = buckets.find((b) => b.test.test(key));
    if (group) group.properties[key] = value;
    else unassigned.push(key);
}

// 有漏网的说明分组规则不全 → 报案，不要静默丢配置 ✗
if (unassigned.length) throw new Error(`有配置项没被分到组: ${unassigned.join(", ")}`);

pkg.contributes.configuration = buckets
    .filter((b) => Object.keys(b.properties).length > 0)
    .map((b) => ({ title: `pi-bridge：${b.title}`, properties: b.properties }));

writeFileSync(path, JSON.stringify(pkg, null, 4) + "\n");

console.log("✓ 已按【对象】重新分组：");
for (const g of pkg.contributes.configuration) {
    console.log(`  ${g.title.padEnd(24)} ${String(Object.keys(g.properties).length).padStart(2)} 项`);
}

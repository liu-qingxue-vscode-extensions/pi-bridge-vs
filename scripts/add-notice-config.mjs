/**
 * add-notice-config —— 把 B8（通知板）需要的配置项写进 package.json
 *
 * 【为什么用脚本而不是手改 / 命令行？】
 *   · package.json 是结构文件 → 手改括号容易改坏（本项目已经踩过两次 ✗）
 *   · `npm pkg set` 命令行写 JSON 又会很长（TUI 里看不到底 ✗）
 *   → 用脚本程序化读写最稳 ✓
 *
 * 幂等：重复运行只会覆盖这几项，不影响其他设置 ✓
 */
import { readFileSync, writeFileSync } from "node:fs";

const path = new URL("../package.json", import.meta.url);
const pkg = JSON.parse(readFileSync(path, "utf8"));

const props = pkg.contributes.configuration.properties;
/** 原有的配置分组顺序：把新项插到合适位置（这里直接追加，顺序不影响功能） */
Object.assign(props, {
    "pi-bridge.notice.bufferSize": {
        type: "number",
        default: 50,
        minimum: 1,
        description:
            "通知列表的环形缓冲上限（超出丢最旧的）。通知不进会话文件，窗口重载即清空。",
    },
    "pi-bridge.style.noticePanelHeight": {
        type: "number",
        default: 40,
        minimum: 5,
        maximum: 95,
        description:
            "通知面板的【高度】（占聊天视图高度的百分比，vh）。拉下来就是固定这么高，通知多了出滚动条。",
    },
    "pi-bridge.style.topBarHeight": {
        type: "number",
        default: 26,
        minimum: 16,
        maximum: 64,
        description: "顶栏（显示 花费 / out / cache / 电池 的那一条）的高度（px）。",
    },
    "pi-bridge.style.noticeFontSize": {
        type: "number",
        default: 12,
        minimum: 9,
        maximum: 20,
        description: "通知列表的字号（px）。",
    },
    "pi-bridge.style.noticeItemPadding": {
        type: "string",
        default: "6px 8px 6px 10px",
        description: "通知条目的内边距（CSS 简写，如 6px 8px）。",
    },
});

// ★ 快捷键：ctrl+alt+n → 展开/收起通知板
//   （只在聊天视图聚焦时生效，避免和别的扩展抢键 ✓）
//   ★【追加】而不是覆盖 —— 原来已经有 ctrl+alt+d（调试板）✗
const kbs = pkg.contributes.keybindings;
if (!kbs.some((k) => k.command === "pi-bridge.toggleNotices")) {
    kbs.push({
        command: "pi-bridge.toggleNotices",
        key: "ctrl+alt+n",
        when: "view == pi-bridge.chatView",
    });
}

// 命令要同时登记到命令面板（keybinding 指向的命令必须存在 ✓）
// ★ title 不写 “pi-bridge:” 前缀 —— VS Code 会用 category 自动拼 ✓
const commands = pkg.contributes.commands;
if (!commands.some((c) => c.command === "pi-bridge.toggleNotices")) {
    commands.push({
        command: "pi-bridge.toggleNotices",
        title: "展开/收起通知板",
        category: "pi-bridge",
    });
}

// ★ 缩进必须和原文件一致（4 空格）
//   否则 JSON.stringify 会把【整个文件】重排 → diff 变成几百行噪音 ✗
writeFileSync(path, JSON.stringify(pkg, null, 4) + "\n");
console.log("✓ 已写入 2 个配置项");
for (const k of ["pi-bridge.notice.bufferSize", "pi-bridge.style.noticePanelHeight"]) {
    console.log(`  ${k} = ${props[k].default}`);
}
console.log("✓ 已写入 keybinding: ctrl+alt+n → pi-bridge.toggleNotices");

/**
 * history.ts —— ★★ B47：完整历史面板的前端入口
 *
 * 【它有多薄】
 *   就两件事：握手要数据 ✗ 收到 snapshot 就渲染 ✓
 *   ★ 渲染【完全复用】apply.ts 的 replaySnapshot（聊天页重建时走的同一条路 ✓）
 *   ⇒ 所以这里【没有任何渲染代码】✗ 未来渲染改进它自动受益 ✓
 *
 * 【为什么能直接复用】
 *   我们的渲染器本来就是"一份消息列表 → 一次全量渲染"的形状
 *   （B39 的 fillToolBubble / B40 的 snapshot 路径 ✓）
 *   实时流那条路需要 postMessage 推送 ✗ 而这条路【只吃一次快照】✓
 *
 * 【它渲染什么】
 *   宿主读【raw 模式】的会话文件 ⇒ 包含已被压缩掉的全部历史 ✓
 *   ⇒ 这是在"看档案"✗ 不是在"看 pi 的上下文"✓
 */
import { replaySnapshot } from "./apply.js";
import { log } from "./vscode-api.js";
import { applyStyleVars } from "./input.js";
import { ui } from "./state.js";
import { vscode } from "./vscode-api.js";

// ★★ 关键：标记"我是历史面板" ⇒ 默认折叠行为与聊天页不同（见 input.ts ✓）
//   ★ 必须在 applyStyleVars 之前设好（它读这个标志 ✓）
ui.historyMode = true;

// ★★ 吃外面的那套配置（B47）
//   【为什么必须显式做】聊天页是 input.ts 在【初始化时】调的 applyStyleVars ✓
//     而历史面板【不加载聊天页的 index.ts】⇒ 没人调 ⇒
//     ui.defaultToolCollapsed 永远是 false ⇒ ★ "收不起来"（用户报的 ✓）
//   ⇒ 宿主会在 ready 后推 styleVars ✗ 这里收到就应用（同一套规则 ✓）
//   ★ 不能无参调 applyStyleVars()：那会【先清空所有】--pi-* 变量 ⇒ 样式全丢 ✓

window.addEventListener("message", (e: MessageEvent) => {
    const msg = e.data as { kind?: string; payload?: unknown };
    if (msg?.kind === "fullHistory") {
        // ★★ B47：渲染期间先藏起来（防"左上角闪一下"✓）
        //   【为什么闪】渲染是【逐个插入】的 ✗ 第一个元素（压缩气泡）
        //     插入时还没排好版 ⇒ 在左上角露一下脸 ✓
        //   ⇒ 全部渲染完再显示 ⇒ 用户只看到"啪"一下出现完整页面 ✓
        const host = document.getElementById("messages");
        if (host) host.style.visibility = "hidden";
        const t0 = performance.now();

        // ★ 走聊天页【同一条】全量渲染路径 ✓
        replaySnapshot(msg.payload);

        const t1 = performance.now();
        if (host) host.style.visibility = "";
        // ★ 分段计时：卡的时候直接看日志就知道是哪一段（别再猜了 ✓）
        log.info(
            `⏱ 完整历史渲染：总计 ${(t1 - t0).toFixed(0)}ms` +
                `（节点 ${document.querySelectorAll("#messages *").length} 个）`,
        );
        return;
    }
    if (msg?.kind === "styleVars") {
        // ★ 同一套配置（含 toolFold 规则 / 默认折叠开关 ✓）
        applyStyleVars((msg.payload ?? {}) as Record<string, string>);
        return;
    }
    if (msg?.kind === "historyMeta") {
        // ★ 只更新顶部横幅（会话名 / 消息数 ✗ 让用户知道在看哪个档案 ✓）
        const m = (msg.payload ?? {}) as { name?: string; path?: string; messages?: number };
        const el = document.getElementById("history-sub");
        if (el) {
            const parts = [
                m.name ? `「${m.name}」` : "",
                typeof m.messages === "number" ? `${m.messages} 条消息` : "",
                "含已压缩部分 · 只读",
            ].filter(Boolean);
            el.textContent = parts.join(" · ");
        }
    }
});

// ★ 握手：告诉宿主"我加载好了，把历史给我"（宿主读文件 ⇒ 零子进程 ✓）
log.info(`⏱ 完整历史：脚本执行到 ready 用了 ${performance.now().toFixed(0)}ms`);
vscode.postMessage({ kind: "ready" });

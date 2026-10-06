/**
 * debug/index.js —— 调试板的前端（B37 恢复 ✓）
 *
 * 【★★ 它是怎么坏掉又怎么回来的】
 *   它原来是手写的 media/debug.js ✗
 *   在 B32（"自由按钮容器 + 交接文档"）那次提交里【被删掉了】
 *   而 media/debug.html 里那句 `<script src="{{js}}">` 留着 ✗
 *   ⇒ 前端 404 ✗ 页面一行脚本都没有 ✓
 *   ⇒ 症状：调试板【永远空白】+ "清空/导出"两个按钮全死 ✓
 *
 *   ★ 为什么一直没被发现？
 *     它【不报错】✗ 只是安静地什么都收不到 ✓
 *     守门员 check-html.mjs 只查标签平衡 ✗ 不查 {{js}} 指向的文件在不在 ✓
 *     ⇒ 本轮顺手把这条检查加进了脚本 ✓
 *
 *   ★ 为什么是 .js 不是 .ts？
 *     它是纯 DOM 脚本（没有类型需求 ✓）
 *     而且恢复时要【逐字保真】✗ 改成 TS 会引入没必要的改动 ✓
 *     esbuild 两者都吃 ✓ tsconfig.webview.json 只查 .ts ✓ 不冲突 ✓
 *
 * 【★ 它和宿主的分工】（宿主 = src/view/debug-panel.ts）
 *   宿主：环形缓冲（500 条可配 ✓）+ 出口折叠（忽略列表命中只发计数 ✓）
 *   前端：只负责画 ✓ 不维护任何状态（刷新即从缓冲重放 ✓）
 *
 * 【★ 消息协议】
 *   宿主 → 前端：{ kind:"debug", payload, ts }        普通条目（原始数据包 ✓）
 *                { kind:"debug-fold", label, count, ts } 折叠条目（被忽略的，只计数 ✓）
 *                { kind:"debug-clear" }                  清空（改设置后重放前先清 ✓）
 *   前端 → 宿主：debug-ready（我刚打开，把缓冲刷给我 ✓）
 *                clear（清空你的环形缓冲 ✓）
 *                export（导出成 JSON ✓）
 *
 * 【★ 这一层的定位】（用户定的 ✓）
 *   "它的出口一定要独立，而且全面，所有数据包都要往它那里发一份。
 *    它是整个项目的主心骨。"
 *   ⇒ 所以这里画的是【原始数据包】✗ 不做任何翻译 ✓
 *     翻译是别的模块的事 ✗ 调试板是事实来源 ✓
 */

const vscode = acquireVsCodeApi();
const logEl = document.getElementById("log");
const countEl = document.getElementById("count");
let count = 0;

function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ===== 分类：决定色条颜色（一眼看出这是哪类事件）=====
function categorize(type) {
    if (!type) return "other";
    if (type === "stderr") return "error";
    if (type.startsWith("message_update")) return "stream"; // 流式增量（高频）
    if (type.startsWith("message_")) return "message"; // 消息边界
    if (type.startsWith("extension_")) return "extension"; // pi 扩展请求
    if (type.startsWith("tool")) return "tools"; // 工具调用
    if (type.startsWith("agent_") || type.startsWith("turn_")) return "lifecycle";
    return "other";
}

// ===== JSON 语法高亮 =====
// 一次正则扫描所有 token（多次 replace 会互相破坏，这里一次搞定）
function highlightJson(obj) {
    const s = escapeHtml(JSON.stringify(obj, null, 2));
    return s.replace(
        /("(?:\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
        (m) => {
            let cls = "n"; // 数字
            if (m.startsWith('"')) {
                cls = m.trim().endsWith(":") ? "k" : "s"; // key / 字符串
            } else if (m === "true" || m === "false") {
                cls = "b";
            } else if (m === "null") {
                cls = "x";
            }
            return '<span class="' + cls + '">' + m + "</span>";
        },
    );
}

function bumpCount() {
    count++;
    countEl.textContent = count + " 条";
}

/** 普通条目：一节完整车厢（时间戳 + 类型 + JSON 内容） */
function renderEntry(payload, ts) {
    const type = payload && payload.type ? payload.type : "?";
    const div = document.createElement("div");
    div.className = "entry";
    div.dataset.cat = categorize(type);
    div.innerHTML =
        '<div class="meta"><span class="ts">' +
        new Date(ts).toLocaleTimeString() +
        "</span>" +
        '<span class="kind">' +
        escapeHtml(type) +
        "</span></div>" +
        '<div class="j">' +
        highlightJson(payload) +
        "</div>";
    return div;
}

/**
 * 折叠条目：【同样是一节完整车厢】—— 有自己的时间戳，不搭别人的车头
 *
 * label 可能是：【type】 或更细的 【type › 字段=值】✓
 * （后者来自 ignored 列表里的"路径=值"规则 —— 这就是"更细的颗粒度" ✓）
 */
function renderFolded(label, n, ts) {
    const div = document.createElement("div");
    div.className = "entry folded";
    div.dataset.cat = categorize(String(label).split(" › ")[0]); // ★ 用 type 部分取色
    div.dataset.fold = label;
    div.innerHTML =
        '<div class="meta"><span class="ts">' +
        new Date(ts).toLocaleTimeString() +
        "</span>" +
        '<span class="kind">' +
        escapeHtml(label) +
        "</span>" +
        '<span class="fold-count">×' +
        n +
        "</span>" +
        '<span class="fold-hint">（已忽略，仅计数）</span></div>';
    return div;
}

// ===== 接收宿主消息 =====
window.addEventListener("message", (event) => {
    const msg = event.data;

    if (msg.kind === "debug") {
        bumpCount();
        logEl.appendChild(renderEntry(msg.payload, msg.ts));
        logEl.scrollTop = logEl.scrollHeight;
        return;
    }

    if (msg.kind === "debug-fold") {
        bumpCount();
        const last = logEl.lastElementChild;
        if (last && last.dataset.fold === msg.label) {
            // 同一折叠段 → 只更新计数（时间戳保持段开始的时刻）
            last.querySelector(".fold-count").textContent = "×" + msg.count;
        } else {
            logEl.appendChild(renderFolded(msg.label, msg.count, msg.ts));
        }
        logEl.scrollTop = logEl.scrollHeight;
        return;
    }

    // ★ 宿主要求清空（改设置后重放历史时先清 → 避免重复累计 ✓）
    if (msg.kind === "debug-clear") {
        logEl.innerHTML = "";
        count = 0;
        countEl.textContent = "0 条";
    }
});

document.getElementById("clear").addEventListener("click", () => {
    logEl.innerHTML = "";
    count = 0;
    countEl.textContent = "0 条";
    // 通知宿主清空它的环形缓冲（否则关掉面板重开会把旧数据刷回来）
    vscode.postMessage({ kind: "clear" });
});

// 导出：把宿主【环形缓冲】里的数据导出成 JSON 文件
document.getElementById("export").addEventListener("click", () => {
    vscode.postMessage({ kind: "export" });
});

// 通知扩展：调试板已打开，请把缓冲刷过来
vscode.postMessage({ kind: "debug-ready" });

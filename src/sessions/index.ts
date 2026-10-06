/**
 * sessions/index.ts —— 会话面板的前端（B35 ✗ 从侧栏搬到编辑器区 ✓）
 *
 * 【★ 为什么搬？】（用户定的 ✓）
 *   侧栏天然逼仄 ✗ 会话多了根本看不过来 ✓
 *   编辑器区能把【路径 / 轮次 / 时间】排得更舒服 ✓
 *
 * 【★ 与侧栏版的区别】
 *   ① 没有「收起」概念（面板本身就是窗口 ✓）
 *   ② 没有「点外面关闭」（那是弹层逻辑 ✗ 不适用 ✓）
 *   ③ ★ 数据是【宿主推全量】✗ 前端不维护增量 ✓
 *   ④ 点会话后【不收起】（留着方便连着切 ✓）
 *
 * 【消息】（★ 面板私有通道 ✗ 两边都用 payload 包 ✓）
 *   宿主 → 这里：sessionList { list, currentCwd } / sessionToast { text, err }
 *   这里 → 宿主：refreshSessions / newSession / switchSession /
 *                exportSession / importSession / deleteSession
 */
import { showContextMenu } from "../webview/context-menu.js";
import { fmtTime, prettyPath, treeify, type SessionInfo } from "./session-util.js";

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();

const listEl = document.getElementById("list")!;
const emptyEl = document.getElementById("empty")!;
const countEl = document.getElementById("count")!;
const refreshBtn = document.getElementById("refresh") as HTMLButtonElement;
const newBtn = document.getElementById("new") as HTMLButtonElement;
const toastEl = document.getElementById("toast")!;

/** 当前列表（宿主推来的 ✓）*/
let sessions: SessionInfo[] = [];
/** ★ 当前会话所在的目录（用来把它那组排最前 + 标「当前」✓）*/
let currentCwd = "";

// ── toast ──
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(text: string, err = false): void {
    toastEl.textContent = text;
    toastEl.dataset.show = "1";
    toastEl.dataset.kind = err ? "err" : "ok";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        toastEl.dataset.show = "0";
    }, 2400);
}

/**
 * ★ 用户手动展开过的分组（B35 ✓）
 *
 * 【为什么要有它？】
 *   宿主每次推全量 → 我们整表重画 ✓
 *   如果展开状态只存在 DOM 上 ✗ 重画后就全收回去了 ✓
 *   ★ 所以把它提到模块级 ✗ 重画时能复原 ✓
 */
const openGroups = new Set<string>();

// ── 渲染 ──

function render(): void {
    listEl.innerHTML = "";
    emptyEl.style.display = sessions.length ? "none" : "";
    countEl.textContent = `${sessions.length} 个会话`;

    // ① 按 cwd 分组（保持宿主给的顺序：组内已按时间倒序 ✓）
    const groups = new Map<string, SessionInfo[]>();
    for (const s of sessions) {
        const key = s.cwd || "";
        const arr = groups.get(key);
        if (arr) arr.push(s);
        else groups.set(key, [s]);
    }

    // ② 当前 cwd 的组排最前（其他按时间序 ✓）
    const keys = [...groups.keys()].sort((a, b) => {
        if (a === currentCwd) return -1;
        if (b === currentCwd) return 1;
        const ta = groups.get(a)![0]?.createdAt ?? 0;
        const tb = groups.get(b)![0]?.createdAt ?? 0;
        return tb - ta;
    });

    for (const key of keys) listEl.appendChild(buildGroup(key, groups.get(key)!));
}

/** 造一个分组（标题 + 里面的会话树 ✓）*/
function buildGroup(key: string, items: SessionInfo[]): HTMLElement {
    const isCurrent = key === currentCwd;

    const g = document.createElement("div");
    g.className = "session-group";
    g.dataset.cwd = key;
    // ★ 当前组默认展开 ✗ 其他记住用户的选择 ✓
    g.dataset.open = isCurrent || openGroups.has(key) ? "true" : "false";

    // 分组标题（★ 点击只切换展开 ✗ 不切 cwd ✓）
    const head = document.createElement("button");
    head.className = "sg-head";
    head.innerHTML = '<span class="sg-caret"></span>';
    const label = document.createElement("span");
    label.className = "sg-path";
    label.textContent = prettyPath(key);
    label.title = key || "（未知目录）";
    const count = document.createElement("span");
    count.className = "sg-count";
    count.textContent = String(items.length);
    head.append(label, count);
    if (isCurrent) {
        const tag = document.createElement("span");
        tag.className = "sg-tag";
        tag.textContent = "当前";
        head.appendChild(tag);
    }
    head.addEventListener("click", () => {
        const open = g.dataset.open === "true";
        g.dataset.open = open ? "false" : "true";
        if (open) openGroups.delete(key);
        else openGroups.add(key);
    });
    g.appendChild(head);

    // 里面的会话（★ 排成树 ✗ fork / clone 缩进到父下面 ✓）
    const body = document.createElement("div");
    body.className = "sg-body";
    for (const { s, depth } of treeify(items)) body.appendChild(buildRow(s, depth, key));
    g.appendChild(body);
    return g;
}

/** 造一行会话 ✓ */
function buildRow(s: SessionInfo, depth: number, cwd: string): HTMLButtonElement {
    const row = document.createElement("button");
    row.className = "session-item";
    row.dataset.path = s.path;

    // ★★ 缩进用 paddingLeft ✗ 不用 marginLeft
    //   （margin 会把元素推出父容器 → 出横向滚动条 ✓ 用户报过 ✓）
    if (depth > 0) {
        row.classList.add("is-branch");
        const left = 24 + depth * 14;
        row.style.paddingLeft = `${left}px`;
        row.style.setProperty("--indent", `${left}px`);
    }

    // ★ 异常文件：标红 + 显示原因 + 【不可点】（防切过去出错 ✗）
    if (s.broken) {
        row.classList.add("broken");
        row.disabled = true;
        const warn = document.createElement("span");
        warn.className = "si-warn";
        warn.textContent = "⚠";
        const why = document.createElement("span");
        why.className = "si-name";
        why.textContent = s.broken;
        const f = document.createElement("span");
        f.className = "si-id";
        f.textContent = s.id.slice(0, 12);
        row.append(warn, why, f);
        row.title = `${s.broken}\n${s.path}`;
        return row;
    }

    // ★ 名字 → 轮次 → 时间（用户定的顺序 ✓）
    const main = document.createElement("span");
    main.className = "si-name";
    main.textContent = s.name || s.id.slice(0, 8);
    main.title = s.name ? s.name : `（没有名字）会话 id: ${s.id}`;
    if (!s.name) main.classList.add("si-idname");

    const turns = document.createElement("span");
    turns.className = "si-turns";
    turns.textContent = s.turns === undefined ? "?" : `${s.turns} 轮`;
    turns.title = s.turns === undefined ? "点上方 ⟳ 刷新后可获得轮次" : `用户消息 ${s.turns} 条`;

    const time = document.createElement("span");
    time.className = "si-time";
    time.textContent = fmtTime(s.createdAt);

    row.append(main, turns, time);
    row.title =
        `${s.name ?? "（无名字）"}\n` +
        `轮次：${s.turns ?? "?（未刷新）"}\n` +
        `创建：${fmtTime(s.createdAt)}\n${s.path}`;

    row.addEventListener("click", () => {
        // ★ 切会话 ✓ 面板【不收起】（这里不是弹层 ✗ 留着方便连着切 ✓）
        vscode.postMessage({ kind: "switchSession", path: s.path, cwd });
        toast(`已切换到：${s.name || s.id.slice(0, 8)}`);
    });

    row.addEventListener("contextmenu", (ev) => {
        showContextMenu(ev, [
            {
                label: "导出会话…",
                onClick: () =>
                    vscode.postMessage({ kind: "exportSession", path: s.path, name: s.name }),
            },
            // ★ 导入其实是"对目录"的操作 ✗ 不依赖具体哪条会话 ✓
            {
                label: "导入会话…",
                onClick: () => vscode.postMessage({ kind: "importSession" }),
            },
            {
                label: "复制路径",
                onClick: () => void navigator.clipboard.writeText(s.path),
            },
            {
                label: "删除会话",
                danger: true,
                onClick: () =>
                    vscode.postMessage({ kind: "deleteSession", path: s.path, name: s.name }),
            },
        ]);
    });

    return row;
}

// ── 交互 ──

refreshBtn.addEventListener("click", () => {
    // ★ 唯一会【读文件】的操作（平时只扫文件名 ✗ 零内容 IO ✓）
    refreshBtn.classList.add("spinning");
    vscode.postMessage({ kind: "refreshSessions" });
    setTimeout(() => refreshBtn.classList.remove("spinning"), 600);
});

newBtn.addEventListener("click", () => {
    vscode.postMessage({ kind: "newSession" });
    toast("已请求新建会话（★ 发第一条消息才落盘 ✓）");
});

// ── 宿主 → 前端 ──
window.addEventListener("message", (e: MessageEvent) => {
    const msg = e.data as { kind?: string; payload?: unknown };
    if (msg?.kind === "sessionList") {
        const p = (msg.payload ?? {}) as { list?: SessionInfo[]; currentCwd?: string };
        sessions = Array.isArray(p.list) ? p.list : [];
        currentCwd = typeof p.currentCwd === "string" ? p.currentCwd : "";
        render();
        return;
    }
    if (msg?.kind === "sessionToast") {
        const p = (msg.payload ?? {}) as { text?: string; err?: boolean };
        toast(p.text ?? "", p.err === true);
        return;
    }
});

// ★ 告诉宿主：我准备好了 → 请求推列表
//   ★★ B35：名字叫 sessionReady ✗ 不叫 ready
//     聊天页已经占用 ready 了 ✗ 而语义不同（那边是“重放快照”✓）
vscode.postMessage({ kind: "sessionReady" });

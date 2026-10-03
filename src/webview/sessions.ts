/**
 * sessions.ts —— 会话面板（B15）
 *
 * 【本轮的定位：先跑通"按钮 → 弹窗"这条链路】
 *   面板内容【先空着】✗ —— 先在按钮行上加两个按钮，点开一个空面板 ✓
 *   里面的内容（会话列表 / 新建 / 切换 / 删除 / 改名）下一轮再填 ✓
 *
 * 【为什么先做壳？】
 *   用户的原则：先把【确定性的东西】做了 ✓
 *   "按钮能弹出窗口"是确定的 ✓ "窗口里放什么"取决于会话管理怎么设计 ✗
 *   → 先拿到这条链路，后面的讨论才有东西可调 ✓
 *
 * 【面板形态】
 *   和通知面板同一套机制：从按钮行下方滑出（固定高度 + 列表滚动 ✓）
 *   展开/收起：点 [☰ 会话] / 点面板空白 / 点底部 ⌃ ✓
 *
 * 【列表内容（B15 第二步）】
 *   ★ 按【cwd】分组（当前 cwd 默认展开、其他折叠 ✓）
 *   ★ 数据从哪来？打开面板时向宿主要（listSessions ✓）—— 不预先扫描 ✗
 */
import { vscode } from "./vscode-api.js";
import {
    btnSessions,
    btnNewSession,
    sessionPanel,
    sessionList,
    sessionEmpty,
    sessionPanelClose,
    btnRefreshSessions,
} from "./dom.js";

/** 宿主推来的会话元数据（与 src/pi/session-store.ts 的 SessionInfo 同构 ✓） */
export interface SessionInfo {
    path: string;
    id: string;
    cwd: string;
    cwdKey: string;
    createdAt: number;
    /** ★ 会话名（~69% 有 ✓ 没有是正常的 → 退回显示时间 ✓）*/
    name?: string;
    /** ★ 异常原因（有值 = 文件坏了 → 标红且禁止切换 ✗）*/
    broken?: string;
}

let expanded = false;

/** 当前 cwd（宿主推送；用来决定哪个分组默认展开 ✓） */
let currentCwd = "";

/** 展开 / 收起会话面板（next 可强制指定） */
export function setSessionsExpanded(next?: boolean): void {
    expanded = typeof next === "boolean" ? next : !expanded;
    sessionPanel.classList.toggle("collapsed", !expanded);
    // ★ 展开时才去拉列表（按需 ✓ 不在插件激活时扫盘 ✗）
    if (expanded) vscode.postMessage({ kind: "listSessions" });
}

/** 记录当前工作目录（host 推送 cwd 时调 ✓） */
export function setCurrentCwd(p: string): void {
    currentCwd = p;
}

/** 时间显示：MM-DD HH:MM（列表里足够 ✓） */
function fmtTime(ts: number): string {
    if (!ts) return "?";
    const d = new Date(ts);
    const p = (x: number): string => String(x).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 家目录美化：/home/x/foo → ~/foo（标题短好读 ✓） */
function prettyPath(p: string): string {
    if (!p) return "（未知目录）";
    // 注：前端不知道家目录是什么 → ★ 交给宿主传？✗
    //     简单做法：只去掉公共前缀的重复感，保持原样 ✓（路径本身不深 ✓）
    return p;
}

/**
 * 渲染会话列表（按 cwd 分组 ✓）
 *
 * 【分组交互（用户定的 ✓）】
 *   ★ 点分组标题 = 【只展开/折叠】（纯前端 ✓ 绝不切 cwd ✗ 不重载 ✗）
 *   点会话条目   = 切换会话（同 cwd → 不重载 ✓；跨 cwd → 重载 ✓ 下一步做）
 */
export function renderSessions(list: SessionInfo[]): void {
    sessionList.innerHTML = "";
    sessionEmpty.style.display = list.length ? "none" : "";

    // ① 按 cwd 分组（保持宿主给的顺序：组内已按时间倒序 ✓）
    const groups = new Map<string, SessionInfo[]>();
    for (const s of list) {
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

    for (const key of keys) {
        const items = groups.get(key)!;
        const isCurrent = key === currentCwd;

        const g = document.createElement("div");
        g.className = "session-group";
        g.dataset.cwd = key;
        // ★ 当前 cwd 默认展开，其他折叠 ✓
        g.dataset.open = isCurrent ? "true" : "false";

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
            g.dataset.open = g.dataset.open === "true" ? "false" : "true";
        });
        g.appendChild(head);

        // 条目列表（会话 ✓）
        const body = document.createElement("div");
        body.className = "sg-body";
        for (const s of items) {
            const row = document.createElement("button");
            row.className = "session-item";
            row.dataset.path = s.path;

            if (s.broken) {
                // ★ 异常文件：标红 + 显示原因 + 【不可点】（防切过去出错 ✗）
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
                body.appendChild(row);
                continue;
            }

            // ★ 名字优先（没有则用时间 —— 31% 没名字是正常的 ✓）
            const main = document.createElement("span");
            main.className = "si-name";
            main.textContent = s.name || fmtTime(s.createdAt);
            main.title = s.name ? s.name : "（该会话没有名字）";

            // 副标（有名字时才再显示时间，避免重复 ✓）
            const sub = document.createElement("span");
            sub.className = "si-time";
            sub.textContent = s.name ? fmtTime(s.createdAt) : s.id.slice(0, 8);

            row.append(main, sub);
            row.title = `${s.name ?? "（无名字）"}\n${fmtTime(s.createdAt)}\n${s.path}`;
            row.addEventListener("click", () => {
                // ★ 切会话（下一步接 switch_session ✓）
                vscode.postMessage({ kind: "switchSession", path: s.path, cwd: key });
            });
            body.appendChild(row);
        }
        g.appendChild(body);
        sessionList.appendChild(g);
    }
}

/** 绑定交互（入口调用一次 ✓） */
export function setupSessions(): void {
    // ① [☰ 会话] → 展开/收起 ✓（展开时会自动去拉列表 ✓）
    btnSessions.addEventListener("click", () => setSessionsExpanded());

    // ② [＋ 新建] → 通知宿主新建会话
    //   ★ 宿主目前只记日志（下一轮接 pi 的 new_session ✓）
    //     为什么现在就发？先把【前端 → 宿主】这条线接通（不然按钮是死的 ✗）
    btnNewSession.addEventListener("click", () => {
        vscode.postMessage({ kind: "newSession" });
    });

    // ③ 底部 ⌃ → 收起 ✓
    sessionPanelClose.addEventListener("click", () => setSessionsExpanded(false));

    // ④ ★ 刷新（面板内左侧竖栏的 ⟳）—— 唯一会读文件的操作 ✓
    //   平时列表只扫文件名（零内容 IO ✓）；点这里才去读会话名 + 检异常 ✓
    btnRefreshSessions.addEventListener("click", () => {
        btnRefreshSessions.classList.add("spinning");
        vscode.postMessage({ kind: "refreshSessions" });
        setTimeout(() => btnRefreshSessions.classList.remove("spinning"), 600);
    });

    // ④ 点面板空白处 → 收起 ✓（与通知面板一致 ✓）
    sessionPanel.addEventListener("click", (e) => {
        const target = e.target as HTMLElement | null;
        // ★ 条目 / 分组标题 / 按钮 都不收起 ✗
        //   （分组标题自己要处理“展开/折叠”—— 如果它冒泡到这里，
        //     就会【刚展开就被收起】✗ 这正是用户报的那个 bug ✓）
        if (target?.closest(".session-item, .sg-head, .session-group")) return;
        setSessionsExpanded(false);
    });
}

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
import { vscode, log } from "./vscode-api.js";
import { showContextMenu } from "./context-menu.js";
import { activatePanel, deactivatePanel, registerPanel } from "./panels.js";
import {
    btnSessions,
    btnNewSession,
    sessionPanel,
    sessionList,
    sessionEmpty,
    sessionPanelClose,
    btnRefreshSessions,
    sessionTitle,
} from "./dom.js";

/** 宿主推来的会话元数据（与 src/pi/session-store.ts 的 SessionInfo 同构 ✓） */
export interface SessionInfo {
    path: string;
    id: string;
    cwd: string;
    cwdKey: string;
    createdAt: number;
    /** ★ 会话名（~69% 有 ✓ 没有则退回显示短 id ✓）*/
    name?: string;
    /** ★ 异常原因（有值 = 文件坏了 → 标红且禁止切换 ✗）*/
    broken?: string;
    /** ★ 轮次（用户消息数 —— 只有刷新过才有 ✓ 否则显示 "?"）*/
    turns?: number;
}

let expanded = false;

/** 当前 cwd（宿主推送；用来决定哪个分组默认展开 ✓） */
let currentCwd = "";

/** 展开 / 收起会话面板（next 可强制指定） */
export function setSessionsExpanded(next?: boolean): void {
    expanded = typeof next === "boolean" ? next : !expanded;
    sessionPanel.classList.toggle("collapsed", !expanded);
    if (expanded) {
        // ★ 互斥（B25）：打开自己 → 自动收起其他面板 ✓
        activatePanel("sessions");
        // ★ 展开时才去拉列表（按需 ✓ 不在插件激活时扫盘 ✗）
        vscode.postMessage({ kind: "listSessions" });
    } else {
        deactivatePanel("sessions");
    }
}

/** 记录当前工作目录（host 推送 cwd 时调 ✓） */
export function setCurrentCwd(p: string): void {
    currentCwd = p;
}

/**
 * ★ 设置/刷新【标题栏的会话名】（按钮行中间那个 ✓）
 *
 * 【为什么要动态调字号？】（用户的要求 ✓）
 *   标题区宽度【固定】✗ 但会话名长度【各不相同】✗
 *   "pi-bridge" 很短 ✓ / "这个是我 你之前的指引下我去学习…" 很长 ✗
 *   → ★ 名字长就自动缩字号，尽量把名字完整显示出来 ✓
 *   → 缩到最小（9px）还放不下 → 交给 CSS 的 ellipsis 省略 ✓
 *
 * 【为什么用 JS 而不是 CSS？】
 *   CSS 没有"字号自适应容器"的能力 ✗
 *   （SVG 有 textLength ✓ transform:scale 会把字压扁 ✗）
 *   → JS 测量一次、按比例算出来 ✓（不试探、不循环 ✓）
 */
export function setSessionTitle(name: string | undefined): void {
    const el = sessionTitle;
    const text = (name ?? "").trim();
    log.info(`标题：收到会话名「${text || "（空）"}」`);

    el.textContent = text || "（无名字）";
    el.classList.toggle("empty", !text);
    el.title = text ? `会话名：${text}（点击修改）` : "这个会话还没有名字（点击给它命名）";

    // ★ 字号自适应（先重置再量 ✓ 否则会越缩越小 ✗）
    const BASE = 13;
    const MIN = 9;
    el.style.fontSize = `${BASE}px`;
    const w = el.clientWidth;
    const sw = el.scrollWidth;
    if (w > 0 && sw > w) {
        const ratio = w / sw;
        const size = Math.max(MIN, BASE * ratio);
        el.style.fontSize = `${size}px`;
        log.debug(`标题：字号 ${BASE}→${size.toFixed(1)}px（容器 ${w}px / 文本 ${sw}px）`);
    } else {
        log.debug(`标题：字号保持 ${BASE}px（容器 ${w}px / 文本 ${sw}px）`);
    }
}

/** 时间显示：MM-DD HH:MM（列表里足够 ✓） */
function fmtTime(ts: number): string {
    if (!ts) return "?";
    const d = new Date(ts);
    const p = (x: number): string => String(x).padStart(2, "0");
    // ★ 两位年份：2026 → 26（用户定的：两位就够 ✓ 省空间 ✓）
    const yy = String(d.getFullYear()).slice(-2);
    return `${yy}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
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
    log.info(`会话列表：收到 ${list.length} 条`);
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

            // ★ 列表行：名字 → 轮次 → 时间（用户定的顺序 ✓）
            const main = document.createElement("span");
            main.className = "si-name";
            // ★ 名字优先；没有则用【短 id】（用户定的：ID 独特好区分 ✓）
            main.textContent = s.name || s.id.slice(0, 8);
            main.title = s.name ? s.name : `（没有名字）会话 id: ${s.id}`;
            if (!s.name) main.classList.add("si-idname");

            // ★ 轮次（只有刷新过才有 ✓ 否则显示 "?"）
            const turns = document.createElement("span");
            turns.className = "si-turns";
            turns.textContent = s.turns === undefined ? "?" : `${s.turns} 轮`;
            turns.title =
                s.turns === undefined ? "点左侧 ⟳ 刷新后可获得轮次" : `用户消息 ${s.turns} 条`;

            // ★ 时间（带年 ✓）
            const time = document.createElement("span");
            time.className = "si-time";
            time.textContent = fmtTime(s.createdAt);

            row.append(main, turns, time);
            row.title =
                `${s.name ?? "（无名字）"}\n` +
                `轮次：${s.turns ?? "?（未刷新）"}\n` +
                `创建：${fmtTime(s.createdAt)}\n${s.path}`;
            row.addEventListener("click", () => {
                // ★ 切会话（下一步接 switch_session ✓）
                vscode.postMessage({ kind: "switchSession", path: s.path, cwd: key });
                // ★ 切换后【立刻收起面板】（用户要求 ✓）
                setSessionsExpanded(false);
            });
            // ★ 右键菜单（B21）：删除 / 重命名 / 复制路径
            //
            // 【注意：注意不要和【click】打架 ✗】
            //   · contextmenu 不会触发 click ✓（右键与左键是不同事件 ✓）
            //   · 但【右键后点菜单项】会先触发 document 的 click ✓（用来关菜单 ✓）
            //     → 菜单项自己的 handler 已经 stopPropagation 了 ✓ 不会重复 ✓
            //
            // 【为什么要有【重命名】？】
            //   · 它原本在按钮行上（改【当前】会话 ✓）
            //   · 而右键的是【任意一条】✓ → 后端必须支持“改指定会话”✓
            //     （set_session_name 只能改当前的 ✗ → 见 main.ts 的说明 ✓）
            //   · ★ 第一版先只上【删除】+【复制路径】✗
            //     重命名还是放按钮行（改当前的 ✓ 语义清楚 ✓）
            row.addEventListener("contextmenu", (ev) => {
                showContextMenu(ev, [
                    {
                        label: "导出会话…",
                        onClick: () =>
                            vscode.postMessage({ kind: "exportSession", path: s.path, name: s.name }),
                    },
                    {
                        // ★ 导入其实是“对目录”的操作 ✗ 不依赖具体哪条会话 ✓
                        //   放在右键单里只是因为这里最顺手 ✓（用户定的 ✓）
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
            body.appendChild(row);
        }
        g.appendChild(body);
        sessionList.appendChild(g);
    }
}

/** 绑定交互（入口调用一次 ✓） */
export function setupSessions(): void {
    // ★ 注册进面板协调器（B25）：别人打开时会调这个把自己收起来 ✓
    registerPanel("sessions", () => setSessionsExpanded(false));
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
        log.info("点了【刷新会话】→ 请宿主全量重读会话文件");
        btnRefreshSessions.classList.add("spinning");
        vscode.postMessage({ kind: "refreshSessions" });
        setTimeout(() => btnRefreshSessions.classList.remove("spinning"), 600);
    });

    // ⑤ 点【标题区】（按钮行中间）→ 改名 ✓
    //   语义：它既是展示（当前会话名）也是按钮（点它改 ✓）
    sessionTitle.addEventListener("click", () => {
        log.info("点了【会话名】→ 请宿主弹输入框改名");
        vscode.postMessage({ kind: "renameSession" });
    });

    // ⑥ ★ 点【面板外面】任何地方 → 收起 ✓
    //
    // 【为什么要在 document 上监听？】
    //   以前是“点面板内的空白 → 收起”（监听在 panel 自己身上 ✗）
    //   → 导致两个问题：
    //     ① 面板内的【按钮】也被当成空白 ✗ → 点刷新就把面板弹回去了 ✓
    //     ② 点【面板外面】反而没反应 ✗
    //
    // 【标准弹层模式】
    //   document 上监听 → 判断点击位置：
    //     · 面板内     → 不动 ✓（包含里面的按钮：按钮先执行自己的动作 ✓）
    //     · 触发按钮上 → 不动 ✓（否则“刚展开就被收起”✗）
    //     · 其余任何地方 → 收起 ✓
    document.addEventListener("click", (e) => {
        const t = e.target as Node | null;
        if (!expanded || !t) return;
        if (sessionPanel.contains(t)) return; // 面板内 ✓
        if (btnSessions.contains(t)) return; // 触发按钮 ✓
        setSessionsExpanded(false);
    });

    // ★ 点面板内【空白】→ 收起 ✓（用户要保留这个习惯 ✓）
    //
    // 【判定】只排除【交互元素】（条目 / 按钮 / 分组标题）✗
    //   · 点按钮（含刷新 ⟳）→ 不收起 ✓（否则按钮没法用 ✗）
    //   · 点条目 → 不收起 ✓
    //   · 其余（背景 / 空隙 / 空列表区）→ 收起 ✓
    sessionPanel.addEventListener("click", (e) => {
        const t = e.target as HTMLElement | null;
        if (t?.closest("button, .session-item, .sg-head")) return;
        setSessionsExpanded(false);
    });
}

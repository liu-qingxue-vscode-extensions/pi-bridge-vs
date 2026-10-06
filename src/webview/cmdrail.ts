/**
 * cmdrail.ts —— 自由按钮容器的前端（B32 ✓）
 *
 * 【它管什么】
 *   气泡区左侧那根竖条里按钮的【渲染 + 交互】✓
 *
 * 【消息方向】
 *   宿主 → 这里：commands（整份按钮列表 ✓）
 *   这里 → 宿主：commandRun / commandAdd / commandDelete ✓
 *
 * 【★ 图标的三级兜底】（用户提的"文字转图标"✓）
 *   ① 填了 emoji      → 直接用 ✓
 *   ② 填了 codicon 名 → <i class="codicon codicon-xxx"></i> ✓
 *   ③ 都没填           → 用 label 首字（像头像一样 ✓）
 *
 * 【★ 为什么不用虚拟列表？】
 *   按钮是用户手配的 ✗ 几十个到头了 ✓
 *   直接全量重建 DOM ✗ 简单可靠 ✓
 *   （真到几百个再说 ✓ 那时也是"换实现"而不是"打补丁" ✓）
 */
import { post, log, vscode } from "./vscode-api.js";
import { showContextMenu } from "./context-menu.js";

/** ★ 与宿主端 command-store.ts 的结构保持一致（见那个文件 ✓）*/
interface CmdField {
    id: string;
    label: string;
    kind: "fixed" | "select" | "any";
    value?: string;
    options?: string[];
    subType?: "text" | "number";
}
interface CmdItem {
    id: string;
    label: string;
    hint?: string;
    icon?: string;
    /** ★ B33：data URI 兜底（宿主给的 ✗ 不走网络 ✓）*/
    iconData?: string;
    type: "button" | "group";
    command?: string;
    lockCommand?: boolean;
    fields?: CmdField[];
    inputMode?: "serial" | "panel";
    children?: CmdItem[];
}

/**
 * ★★ 已知“主路径坏掉”的 item（B33 ✗）
 *
 * 【为什么记它？】
 *   主路径（asWebviewUri）会 401 ✗ 失败一次后没必要每次都再试 ✓
 *   → 第一次让它去碰✗ 确认坏掉 ✗ 以后直接走兜底 ✗ 不再闪 ✓
 *   ★ 这也保留了【诊断能力】✗ 日志里会有一条 warn ✓
 *     （若哪天真好了 ✗ 重新加载页面就清空了 ✓）
 */
const useFallback = new Set<string>();

const railEl = document.getElementById("cmd-rail-list");

/** ★ 当前列表（宿主推来的 ✓）*/
let items: CmdItem[] = [];

// ────────── ★★ B33：横向弹层（收纳器）──────────

/**
 * 【它是什么】
 *   点收纳器 → 在它右边横排弹出一排子按钮 ✗ 最后一项永远是「＋」✓
 *
 * 【★ 为什么用浮层而不是插进布局？】
 *   插进布局会【挤压气泡区】✗ 每次展开都要重排 ✓
 *   浮层不影响布局 ✗ 点外面就关 ✓（跟右键菜单同一套路 ✓）
 *
 * 【★ 为什么挂在 document.body 而不是 #cmd-rail 里？】
 *   #cmd-rail 写了 overflow: hidden ✗（B32 为了隐滚动条 ✓）
 *   → 挂里面会被裁掉 ✓✓✓
 *   → 挂 body + position: fixed ✓ 才能飘在外面 ✓
 */
let popover: HTMLElement | null = null;
/** 哪个收纳器开着（用于点同一个时收起 ✓）*/
let popoverFor: string | null = null;

function closePopover(): void {
    popover?.remove();
    popover = null;
    popoverFor = null;
}

function openPopover(group: CmdItem, anchor: HTMLElement): void {
    // ★ 点同一个 → 收起（toggle ✓）
    if (popoverFor === group.id) {
        closePopover();
        return;
    }
    closePopover();

    const el = document.createElement("div");
    el.className = "rail-pop";

    for (const child of group.children ?? []) {
        el.appendChild(makeBtn(child, group));
    }

    // ★★ 最后一项永远是「＋」（用户定的 ✓）
    //   ★ 它新建出来的子按钮：type 锁死 button ✗ 命令可能被父亲锁死 ✓
    //     —— 这两条由【配置页】根据 parent 信息执行 ✓
    const add = document.createElement("button");
    add.className = "cmd-btn add";
    add.textContent = "＋";
    add.title = `在「${displayName(group)}」里新建一个按钮`;
    add.addEventListener("click", () => {
        vscode.postMessage({ kind: "commandNew", parentId: group.id });
        closePopover();
    });
    el.appendChild(add);

    // ★ 空收纳器也给一句提示（否则只有个＋不知道是啥 ✓）
    if ((group.children ?? []).length === 0) {
        const hint = document.createElement("span");
        hint.className = "rail-pop-hint";
        hint.textContent = "空收纳器";
        el.insertBefore(hint, add);
    }

    document.body.appendChild(el);

    // ★★ 定位：跟竖条【自然衔接】✗（B33 用户要求 ✓）
    //
    //   ★★ 水平：【从竖条右边缘开始】不覆盖 ✗
    //     踩过：我先写成 r.right - 1（想盖住那条分隔线 ✓）
    //     → 用户报：“横向容器的上下边界线【穿进了容器里面】”✗✓
    //     ⇒ 因为左移 1px 后 ✗ 弹层的【上/下两条横线】越过了竖条边缘 ✓
    //     ⇒ 正解：不越界 ✗ 而是【弹层自己不画左边】✓（见 CSS ✓）
    //
    //   ★★ 垂直：【中心对齐】✗（用户报的：
    //     “由于需要边框 ✗ 你那个高度就会比它高 ✗ 首先它就没有对齐”✓
    //     顶部对齐的话 ✗ 弹层比按钮高出来的部分全落在下面 ✗ 看着歪 ✓
    //     居中则上下均匀 ✓ 自然 ✓）
    const r = anchor.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    const fitsRight = r.right + box.width <= window.innerWidth - 4;
    const left = fitsRight ? r.right : Math.max(4, r.left - box.width);
    const centered = r.top + r.height / 2 - box.height / 2;
    const top = Math.max(4, Math.min(centered, window.innerHeight - box.height - 4));
    el.style.left = `${Math.max(4, left)}px`;
    el.style.top = `${top}px`;
    // ★ 翻到左边时，圆角方向也要跟着翻 ✗（否则圆角跑到衔接处 ✓）
    el.classList.toggle("flip", !fitsRight);

    popover = el;
    popoverFor = group.id;
}

// ── 渲染 ──

/** ★ codicon 名长这样：add / gear / star ✗ 纯小写字母数字减号 ✓ */
function isCodicon(s: string): boolean {
    return /^[a-z][a-z0-9-]*$/.test(s);
}

/**
 * ★★ 这个 icon 是不是【图片源】（B32 图标 ✓）
 *
 * 【为什么不像主机端那样看路径？】
 *   主机推过来之前已经把 `icons/xxx` 转成了 webview URI ✓
 *   ⇒ 前端看到的是 `vscode-webview://…` ✗ 而不是磁盘路径 ✓
 *   ★ 前端【不碰磁盘】✗ 只认得“这是个能当 src 的地址”✓
 */
function isImageSrc(icon: string): boolean {
    return /^(vscode-webview:|https?:|data:image\/)/.test(icon);
}

/**
 * ★★ 按钮显示名（B32 ③）
 *
 * 【用户原话】
 *   “你实在不行 ✗ 你直接拿命令拿去渲染不就完事儿了？”✓
 * ⇒ 没填名字就退回命令（形如 `/mode` ✓）
 *   ★ 这样“名字”就真的不必填了 ✗ 而且还能一眼看出是哪个命令 ✓
 */
function displayName(item: CmdItem): string {
    if (item.label.trim()) return item.label.trim();
    // ★ 不带斜杠（踩过 ✗ 带了的话首字兜底会取到 "/" ✓）
    if (item.command) return item.command;
    return "（未命名）";
}

/**
 * ★ 造一个按钮（图标四级兜底 ✓）+ ★★ 把事件一起挂上 ✗
 *
 * 【★ 为什么要在这里挂事件？】（B33 踩过 ✗）
 *   原来 makeBtn 只造元素 ✗ 事件由调用方分别 wire ✓
 *   结果【弹层里忘了 wire】✗ → 子按钮点了没反应 ✗
 *   而且【不报错】✓ 日志里也什么都没有 ✓ 极难排查 ✓
 *   ⇒ ★ 改结构而不是写注释 ✗：事件就在造按钮时一起挂 ✓
 *     这样调用方【没机会漏】✓（FACTS #26 的思路 ✓）
 *
 * @param group 所属收纳器（只有弹层里的子按钮才传 ✗ 影响提示文案 ✓）
 */
function makeBtn(item: CmdItem, group?: CmdItem): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = "cmd-btn";
    if (item.type === "group") b.classList.add("group");

    const name = displayName(item);
    const icon = item.icon?.trim() ?? "";

    // ★★ B33：决定图标走哪条路 ✗
    //   ① 主路径不可用（空 / 不是地址 ✓）或之前失败过 → 直接用 data 兜底 ✓
    //   ② 否则先用主路径 ✓ 失败时降级（★ 保留诊断能力：日志里看得到 401 ✓）
    const primary = icon && isImageSrc(icon) ? icon : "";
    const useData = !!item.iconData && (!primary || useFallback.has(item.id));
    const src = useData ? item.iconData! : primary;

    if (src) {
        const img = document.createElement("img");
        img.className = "cmd-ico";
        img.src = src;
        // ★ alt 留空：图片加载不出来时不要蹦出一行文字（踩过 ✗）
        img.alt = "";
        img.addEventListener("error", () => {
            // ★★ B33：主路径 401 时自动降级成 data URI ✓
            const who = item.label || item.command || "?";
            if (!useFallback.has(item.id) && item.iconData) {
                useFallback.add(item.id);
                log.warn(
                    `图标主路径失败 → 改用 data 兜底：${who}\n` +
                        `  src = ${img.src.slice(0, 120)}`,
                );
                img.src = item.iconData;
                return;
            }
            log.error(
                `图标加载失败（无可用兜底）：${who}\n` +
                    `  src = ${img.src.slice(0, 160)}\n` +
                    `  （常见原因：文件不在 / 白名单没设 / 401 ✓）`,
            );
        });
        b.appendChild(img);
    } else if (icon && !isCodicon(icon)) {
        // ② emoji / 任意字符 ✓
        b.textContent = icon;
    } else if (icon) {
        // ③ codicon 名 ✓
        const i = document.createElement("i");
        i.className = `codicon codicon-${icon}`;
        b.appendChild(i);
    } else {
        // ④ 文字兜底（★★ B33：规则由用户明确 ✓）
        //
        //   【规则】
        //     第一个字符是【中文】→ 只渲染这一个字 ✓（“目录” → “目” ✓）
        //     否则（英文 / 数字 / 符号开头）→ ★ 通通【全量渲染】✓
        //
        //   【为什么这样分？】（用户讲清楚了 ✓）
        //     中文一个方块字就够认 ✓
        //     而 “a-w” “苹-红” 这种【本身就是缩写】✗
        //       只取一个字就完全没信息了 ✓
        //     而且我们这批名字是【变量名拼出来的】✗ 几乎不会是中文 ✓
        //       ⇒ 连字符、减号什么的都要原样渲染 ✓
        b.classList.add("text");
        const first = [...name][0] ?? "?";
        // ★ 汉字范围：基本区 + 扩展A + 兼容表意 ✓
        const isCJK = /[\u3400-\u9fff\uf900-\ufaff]/.test(first);
        if (isCJK) {
            b.textContent = first;
        } else {
            b.textContent = name;
            // ★ 太长就自动缩字号（三档 ✓）而不是截断 ✓
            const len = [...name].length;
            if (len >= 5) b.classList.add("tiny");
            else if (len >= 3) b.classList.add("sm");
        }
    }

    // ★ 悬停提示：说明 + 命令（让人一眼知道会注入什么 ✓）
    const parts: string[] = [name];
    if (item.hint) parts.push(item.hint);
    if (item.type === "group") {
        parts.push(`收纳器：点开有 ${(item.children ?? []).length} 个按钮`);
    } else if (item.command) {
        const n = (item.fields ?? []).length;
        parts.push(`注入 /${item.command}${n ? `（需要填 ${n} 个参数）` : ""}`);
    }
    if (group) parts.push(`属于「${displayName(group)}」`);
    // ★★ 父亲的“强制”提示（B33 ✗ 让用户一眼知道命令被锁了 ✓）
    if (group?.lockCommand && group.command) {
        parts.push(`★ 命令被收纳器锁死：/${group.command}`);
    }
    parts.push("右键：删除 / 编辑");
    b.title = parts.join("\n");

    // ★★ 事件一起挂上 ✗ 调用方就不会漏（B33 ✓）
    wireClick(b, item);
    wireMenu(b, item);

    return b;
}

/** ★ 挂点击（顶层收纳=展开 ✗ 其余=执行 ✓）*/
function wireClick(btn: HTMLButtonElement, item: CmdItem): void {
    btn.addEventListener("click", () => {
        if (item.type === "group") {
            openPopover(item, btn); // ★ B33：横向弹层 ✓
            return;
        }
        // ★★ 用直接 postMessage（扁平 ✗ 不要套 payload ✓）
        //   为什么？→ 宿主的类型定义是 { kind, id } ✗
        //     用 post(kind, {id}) 会变成 { kind, payload:{id} } ✗
        //     宿主读 msg.id 就是 undefined ⇒ 静默什么也不做 ✓
        //   （踩过 ✗ 日志里只有一句“删除按钮：undefined”✓）
        // ★ B33：记一笔（排查“点了没反应”时它是第一手证据 ✓）
        log.info(`点击自由按钮：${item.label || item.command || item.id}`);
        vscode.postMessage({ kind: "commandRun", id: item.id });
        closePopover();
    });
}

/** ★ 挂右键菜单（顶层 / 子按钮一样 ✓）*/
function wireMenu(btn: HTMLButtonElement, item: CmdItem): void {
    btn.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showContextMenu(e, [
            {
                // ★★ B32 ②：右键直接进配置页面 ✓
                label: item.type === "group" ? "编辑收纳器…" : "编辑按钮…",
                onClick: () => vscode.postMessage({ kind: "commandEdit", id: item.id }),
            },
            {
                label: "删除…",
                danger: true,
                onClick: () => vscode.postMessage({ kind: "commandDelete", id: item.id }),
            },
        ]);
    });
}

function render(): void {
    if (!railEl) return;
    // ★ 重建列表 → 弹层的锚点没了 ✗ 必须先关 ✓（B33）
    closePopover();
    railEl.textContent = "";

    for (const item of items) {
        // ★ makeBtn 已经把事件一起挂好了（B33 ✓）
        railEl.appendChild(makeBtn(item));
    }

    // ★★ 列表最后一项永远是「＋」（用户定的 ✓）
    const add = document.createElement("button");
    add.className = "cmd-btn add";
    add.textContent = "＋";
    add.title = "新建一个自由按钮（先起名字 ✗ 命令后面再补 ✓）";
    add.addEventListener("click", () => void addByPrompt());
    railEl.appendChild(add);
}

// ── 新建（B32 ① 先用输入框顶上 ✗ 完整的配置页在 ② ✓）──

/**
 * ★ 点「＋」→ 告诉宿主去弹输入框
 *
 * 【为什么不在这里画表单？】
 *   ① 这一步的目标是“能用”✗ 不是“好用” ✓
 *   ② VS Code 原生输入框自带校验 / 取消 / 键盘操作 ✗ 零 UI 成本 ✓
 *   ③ 完整的配置页面（图标 / 参数 / 收纳器）是 B32 的下一步 ✓
 */
function addByPrompt(): void {
    vscode.postMessage({ kind: "commandNew" });
}

// ── 宿主 → 前端 ──

/**
 * ★ 宿主推来整份按钮列表（B32 ✓）
 *
 * ★ 为什么用导出函数而不是自己监听 window message？
 *   apply.ts 已经是【所有宿主消息的统一入口】✗
 *   其他模块（通知 / 会话 / 设置 …）都这么走 ✓
 *   自己再挂一个监听会多一条平行路径 ✗ 以后排查时分不清谁先谁后 ✓
 */
export function setRailCommands(list: unknown): void {
    items = Array.isArray(list) ? (list as CmdItem[]) : [];
    render();
}

/** ★ 初始化（index.ts 调 ✓）*/
export function setupCmdRail(): void {
    if (!railEl) return;

    // ★★ 弹层的三个关闭时机（B33 ✓）
    //   ① 点外面 ✗（点弹层里 / 点收纳器按钮本身 → 不关 ✓
    //              后者由它自己的 click 处理器 toggle ✓）
    //   ② Esc
    //   ③ ★ 滚动 / 缩放 —— 因为弹层是 position: fixed ✗
    //     它不随内容滚动走 ✓ 不关就会“浮”在原地错位 ✓
    document.addEventListener("click", (e) => {
        if (!popover) return;
        const t = e.target;
        if (t instanceof HTMLElement && (popover.contains(t) || t.closest(".cmd-btn.group"))) {
            return;
        }
        closePopover();
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && popover) closePopover();
    });
    // ★ 捕获阶段 ✗ 任何滚动容器都能触发 ✓
    window.addEventListener("scroll", closePopover, true);
    window.addEventListener("resize", closePopover);

    render(); // 先画一个空态（免得竖条里空荡荡 ✓）
}

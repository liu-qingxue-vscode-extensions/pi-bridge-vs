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
    type: "button" | "group";
    command?: string;
    lockCommand?: boolean;
    fields?: CmdField[];
    inputMode?: "serial" | "panel";
    children?: CmdItem[];
}

const railEl = document.getElementById("cmd-rail-list");

/** ★ 当前列表（宿主推来的 ✓）*/
let items: CmdItem[] = [];

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

/** ★ 造一个按钮（图标四级兜底 ✓）*/
function makeBtn(item: CmdItem): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = "cmd-btn";
    if (item.type === "group") b.classList.add("group");

    const name = displayName(item);
    const icon = item.icon?.trim() ?? "";
    if (icon && isImageSrc(icon)) {
        // ① 本地图片（主机已经收进标准位置并转了 URI ✓）
        const img = document.createElement("img");
        img.className = "cmd-ico";
        img.src = icon;
        // ★ alt 留空：图片加载不出来时不要蹦出一行文字（踩过 ✗）
        img.alt = "";
        // ★★ B32 排查：把浏览器给的具体报错打出来 ✓
        //   ★ 为什么需要？
        //     宿主侧显示“文件存在 / URI 生成了”✗ 但图还是不显示 ✓
        //     光看 URI 看不出问题 ✗ 得让浏览器自己说 ✓
        img.addEventListener("error", () => {
            log.error(
                `图标加载失败：${item.label || item.command || "?"}\n` +
                    `  src = ${img.src.slice(0, 160)}\n` +
                    `  （常见原因：没在 localResourceRoots 里 / CSP 拦了 ✓）`,
            );
        });
        img.addEventListener("load", () => {
            log.info(`图标已加载：${img.naturalWidth}x${img.naturalHeight}`);
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
        // ④ 文字兜底（用户定的规则 ✓）
        //   ★ 纯英文/数字 → 全部渲染（字号缩小一点 ✓）
        //   ★ 其他（中文等）→ 只取首字
        b.classList.add("text");
        const isLatin = /^[A-Za-z0-9._-]+$/.test(name);
        if (isLatin) {
            b.classList.add("wide");
            b.textContent = name;
        } else {
            b.textContent = [...name][0] ?? "?";
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
    parts.push("右键：删除 / 编辑");
    b.title = parts.join("\n");

    return b;
}

function render(): void {
    if (!railEl) return;
    railEl.textContent = "";

    for (const item of items) {
        const btn = makeBtn(item);

        btn.addEventListener("click", () => {
            if (item.type === "group") {
                // ★ 收纳器（B32 后面做 ✗ 先提示 ✓）
                log.info(`点了收纳器：${item.label}（展开还没做）`);
                return;
            }
            // ★★ 用直接 postMessage（扁平 ✗ 不要套 payload ✓）
            //   为什么？→ 宿主的类型定义是 { kind, id } ✗
            //     用 post(kind, {id}) 会变成 { kind, payload:{id} } ✗
            //     宿主读 msg.id 就是 undefined ⇒ 静默什么也不做 ✓
            //   （踩过 ✗ 日志里只有一句“删除按钮：undefined”✓）
            vscode.postMessage({ kind: "commandRun", id: item.id });
        });

        btn.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            showContextMenu(e, [
                {
                    // ★★ B32 ②：右键直接进配置页面 ✓
                    //   ★ 名称按类型分：收纳器改的是它自己的设置 ✗
                    //     按钮改的是命令与参数 ✓
                    label: item.type === "group" ? "编辑收纳器…" : "编辑按钮…",
                    onClick: () =>
                        vscode.postMessage({ kind: "commandEdit", id: item.id }),
                },
                {
                    label: "删除…",
                    danger: true,
                    onClick: () => vscode.postMessage({ kind: "commandDelete", id: item.id }),
                },
            ]);
        });

        railEl.appendChild(btn);
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
    render(); // 先画一个空态（免得竖条里空荡荡 ✓）
}

/**
 * slash-menu.ts —— 斜杠命令补全（B27）
 *
 * 【用户要的】
 *   “按下斜杠就应该列出所有命令 ✗ 随着输入内容逐渐收敛 ✓
 *    上下键可以在里面自由切换 ✗ 自动选中第一项没有问题 ✓”
 *
 * 【★ 触发条件】
 *   只在【光标在行首】且【内容以 / 开头】时激活 ✓
 *   · 前缀 = `/` 之后到光标的字符 ✗ 用来过滤 ✓
 *   · 命令名 startsWith(前缀) ✓（也允许子串匹配 ✗ 更好找 ✓）
 *
 * 【★ 交互】
 *   ↑ ↓   在候选里移动 ✓
 *   Enter ★ 只【填入】不发送 ✓（再按一次才发 ✓）
 *   Tab   同 Enter ✓
 *   Esc   关闭候选（输入内容不动 ✓）
 *
 * 【★ 数据从哪来？】
 *   宿主收到 listCommands → 问 pi 的 get_commands → 推给我们 ✓
 *   我们缓存一份 ✗ 不重复问 ✓
 */
import { inputEl } from "./dom.js";
import { syncPadding } from "./input.js";
import { vscode } from "./vscode-api.js";

/** pi 返回的命令对象（见 rpc-commands.md 的 get_commands ✓）*/
export interface PiCommand {
    name: string;
    description?: string;
    /** extension = pi.registerCommand / prompt = 模板 / skill = 技能 ✓ */
    source?: string;
}

const menuEl = document.getElementById("slash-menu") as HTMLElement | null;

let commands: PiCommand[] = [];
/** ★ 当前过滤后的候选 ✓ */
let matches: PiCommand[] = [];
/** 键盘选中的下标 ✓（-1 = 没有 ✓）*/
let selected = 0;
/** 菜单是不是开着 ✓ */
let open = false;

/**
 * ★ 从输入框内容里提取“斜杠前缀”✗
 *   返回 null = 不该激活 ✓
 */
function currentPrefix(): string | null {
    const v = inputEl.value;
    const pos = inputEl.selectionStart ?? 0;
    // ★ 只认【从第一个字符开始】的 /command ✓（中间出现的不算 ✓）
    if (!v.startsWith("/")) return null;
    // 光标必须还在第一行 ✓（否则是在写参数 ✓）
    const before = v.slice(0, pos);
    if (before.includes("\n")) return null;
    const prefix = before.slice(1);
    // ★ 已经打了空格 = 开始写参数 ✗ 不再补全 ✓
    if (/\s/.test(prefix)) return null;
    return prefix;
}

function filterByPrefix(prefix: string): PiCommand[] {
    const p = prefix.toLowerCase();
    if (!p) return commands;
    // 前缀命中优先 ✓ 子串命中次之 ✓（好找 ✓）
    const starts = commands.filter((c) => c.name.toLowerCase().startsWith(p));
    const contains = commands.filter(
        (c) => !c.name.toLowerCase().startsWith(p) && c.name.toLowerCase().includes(p),
    );
    return [...starts, ...contains];
}

function render(): void {
    if (!menuEl) return;
    menuEl.textContent = "";
    if (!open || matches.length === 0) {
        menuEl.dataset.empty = "true";
    } else {
        menuEl.dataset.empty = "false";

        // ★★ 显示【全部】候选 ✗ 不再截断到 12 条 ✓
        //   用户报：“你这数目有点太少了 ✗ 下面明明有东西但前端就是不给”✓
        //   → 高度用 CSS 的 max-height + 滚动条控制 ✓
        matches.forEach((c, i) => {
            const row = document.createElement("button");
            row.className = "slash-item" + (i === selected ? " active" : "");
            const name = document.createElement("span");
            name.className = "slash-name";
            name.textContent = "/" + c.name;
            const src = document.createElement("span");
            src.className = "slash-src";
            src.textContent = c.source ?? "";
            const desc = document.createElement("span");
            desc.className = "slash-desc";
            desc.textContent = c.description ?? "";
            row.append(name, src, desc);
            // ★ 鼠标点也算选中并填入 ✓
            row.addEventListener("mousedown", (e) => {
                e.preventDefault(); // 别让输入框失焦 ✓
                selected = i;
                apply();
            });
            menuEl.appendChild(row);
        });
    }

    // ★★ 菜单高度会改变输入区高度 ✗ → 消息区留白要重算 ✓
    //   （用户报的：“UI 遮挡 ✗ 无法把上面的气泡往上滑”✓）
    // ★★ 选中项要滚进可视区 ✗（上下键走到下面时看不到 ✓）
    requestAnimationFrame(() => {
        menuEl.querySelector(".slash-item.active")?.scrollIntoView({ block: "nearest" });
        syncPadding();
    });
}

/** ★ 把选中的命令【填进输入框】✗ 不发送 ✓ */
function apply(): void {
    const cmd = matches[selected];
    if (!cmd) return;
    inputEl.value = "/" + cmd.name + " ";
    // 光标放到末尾 ✓
    inputEl.selectionStart = inputEl.selectionEnd = inputEl.value.length;
    close();
    inputEl.focus();
}

function close(): void {
    open = false;
    matches = [];
    selected = 0;
    render();
}

/**
 * 输入变化时重算候选 ✓
 *
 * @param keepSelection ★ 保留当前选中项 ✗
 *   用户报：“长按才能选到下面 ✗ 手一松又弹回去”✓
 *   根因：keydown 里 selected++ ✗ 紧接着 keyup 又调本函数 → 重置为 0 ✓
 *   → 所以 Arrow 键的 keyup 必须【保留选中】✓
 */
export function refreshSlashMenu(keepSelection = false): void {
    if (!menuEl) return;

    // ★★ B42：只有用户【真的在打斜杠命令】时才去要列表
    //   【为什么改】原来"命令列表为空就主动要一次"✗ 而这个函数由【任何输入】触发
    //     ⇒ 用户随便打个字就拉起了 pi 子进程（"打开扩展就启动"的真凶之一 ✓）
    //   ⇒ 现在：先看输入像不像斜杠命令 ✗ 不像就直接关掉候选 ✓ 一个请求都不发 ✓
    const prefix = currentPrefix();
    if (prefix === null) {
        close();
        return;
    }
    if (commands.length === 0) {
        // ★ 到这一步说明【确实在打斜杠】⇒ 这才值得去问一次 ✓
        vscode.postMessage({ kind: "listCommands" });
        return;
    }
    matches = filterByPrefix(prefix);
    if (!keepSelection) selected = 0; // ★ 自动选中第一项 ✓（用户定的 ✓）
    if (selected >= matches.length) selected = 0;
    open = matches.length > 0;
    render();
}

/**
 * ★ 键盘处理 ✗ 返回 true = 已消费（调用方不要再处理 Enter 发送 ✓）
 */
export function slashMenuKey(e: KeyboardEvent): boolean {
    if (!open) return false;
    // ★★ 在【全部】候选里循环 ✗（旧版写死了 12 ✗ 所以到底部会弹回第一项 ✓）
    const n = matches.length;
    if (n === 0) return false;
    if (e.key === "ArrowDown") {
        e.preventDefault();
        selected = (selected + 1) % n;
        render();
        return true;
    }
    if (e.key === "ArrowUp") {
        e.preventDefault();
        selected = (selected - 1 + n) % n;
        render();
        return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        apply();
        return true;
    }
    if (e.key === "Escape") {
        e.preventDefault();
        close();
        return true;
    }
    return false;
}

/** 宿主推来命令列表 ✓ */
export function setCommands(list: PiCommand[]): void {
    commands = list;
    // ★ 拿到之后再刷新一次 ✗（用户可能已经打了 /xxx ✓）
    refreshSlashMenu(true);
}

export function setupSlashMenu(): void {
    // 输入变化 ✓
    inputEl.addEventListener("input", () => refreshSlashMenu());
    // ★ 光标左右移动时刷新 ✗ 但【Arrow 上下不刷新】✓
    //   用户报的：“长按才能选下面 ✗ 手一松弹回第一项”✗
    //   根因：keydown 里 selected++ ✗ 紧接着 keyup 又调 → 重置为 0 ✓
    inputEl.addEventListener("keyup", (e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") refreshSlashMenu(true);
    });
    // 失焦就关 ✓
    inputEl.addEventListener("blur", () => setTimeout(close, 120));
    // ★★ B42：【删掉】原来的"首次进入主动拉一次"
    //   它让"打开扩展"就 spawn pi（只为让按 / 立刻有候选 ✗ 代价太大 ✓）
    //   ⇒ 现在按 / 时才拉 ✗ 最多多等一次往返（本地进程 ✗ 几十毫秒 ✓）
}

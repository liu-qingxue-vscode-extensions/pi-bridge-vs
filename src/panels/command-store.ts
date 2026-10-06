/**
 * command-store.ts —— 自由按钮容器的数据层（B32 ①）
 *
 * 【它是什么】
 *   气泡区左侧那根竖条里装的东西 ✗ 用户自己配的快捷命令 ✓
 *
 * 【★ 为什么单独一个文件？】
 *   ① 数据结构（下面那两个 interface）是【我们和配置之间的契约】✓
 *   ② 读写 VS Code 配置 ✓
 *   ③ 拼装命令行（把参数填进去 ✓）
 *   三件事都不该塞进 main.ts ✓ 那里已经够长了 ✓
 *
 * 【★ 存在哪？】
 *   vsCode 配置 `pi-bridge.commands.buttons`（一个对象数组 ✓）
 *   ★ 为什么不存 pi 的 settings.json？
 *     这不是 pi 的配置 ✗ 是我们扩展自己的界面配置 ✓
 *     （跟 skills.clickAction 同一套路 ✓ 见 B31）
 */
import * as vscode from "vscode";

/** ★ 一个参数位（按钮需要填的东西 ✓） */
export interface CmdField {
    /** 稳定标识（拼装顺序靠数组下标 ✗ 不靠它 ✓ 它只用来定位 ✓）*/
    id: string;
    /** 界面上显示的标签（"操作" / "路径" ✓）*/
    label: string;
    /**
     * ★ 三种类型（用户定的 ✓）
     *   fixed  = 固定值（这个位置恒等于某段文本 ✓）
     *   select = 有限值可选（下拉框 ✓）
     *   any    = 任意值（输入框 ✓）
     */
    kind: "fixed" | "select" | "any";
    /** fixed 用：那个固定值 */
    value?: string;
    /** select 用：可选清单 */
    options?: string[];
    /** any 用：子类型（先只做校验提示 ✓ 不做强校验 ✓）*/
    subType?: "text" | "number";
}

/** ★ 容器里的一个条目（按钮 或 收纳器 ✓） */
export interface CmdItem {
    /** 稳定标识（删除 / 更新时用它定位 ✓）*/
    id: string;
    /** 按钮上显示的名字（也是首字图标的来源 ✓）*/
    label: string;
    /** 悬停提示（说明这个按钮干什么 ✓）*/
    hint?: string;
    /** ★ 图标：emoji 或 codicon 名 ✗ 留空则用 label 首字 ✓ */
    icon?: string;

    /**
     * ★ 类型：button = 按钮 ✗ group = 收纳器 ✓
     *   收纳器点开会在气泡区上方弹出一横排按钮 ✓
     */
    type: "button" | "group";

    /** 要注入的斜杠命令（不带 / ✓） */
    command?: string;
    /**
     * ★ 只有收纳器才有：预设命令 + 是否强制
     *   true  = 强制 ✗ 里面加进来的按钮命令被锁死必须是它 ✓
     *   false = 软 ✗ 只是预填 ✗ 可以改 ✓
     */
    lockCommand?: boolean;

    /** ★ 只有按钮才有：参数列表（0..N ✓ 见设计文档 ✓）*/
    fields?: CmdField[];

    /**
     * ★ 有参数时的收集方式
     *   serial = 串行弹窗（VS Code 原生 QuickPick / InputBox ✓）
     *   panel  = 独立窗口一次填完 ✓
     */
    inputMode?: "serial" | "panel";

    /** ★ 只有收纳器才有：子项 */
    children?: CmdItem[];
}

/** 配置键（集中一处 ✗ 免得字符串散落 ✓）*/
const CFG_KEY = "commands.buttons";

/** ★ 生成一个稳定 id（时间戳 + 随机 ✗ 够用了 ✓）*/
export function newId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** ★ 读按钮列表（配置坏了就当空的 ✗ 不让它炸 ✓）*/
export function readCommands(): CmdItem[] {
    const raw = vscode.workspace.getConfiguration("pi-bridge").get<unknown>(CFG_KEY, []);
    if (!Array.isArray(raw)) return [];
    return raw.filter(isCmdItem).map(normalize);
}

/** ★ 写回配置（全局 ✓ 跨项目共享 ✓）*/
export async function writeCommands(items: CmdItem[]): Promise<void> {
    await vscode.workspace
        .getConfiguration("pi-bridge")
        .update(CFG_KEY, items, vscode.ConfigurationTarget.Global);
}

/**
 * ★ 把一条按钮拼成命令行（B32 ✗ 参数收集完调它 ✓）
 *
 *   /dir add write /tmp/x
 *    ↑command ↑f0  ↑f1    ↑f2
 *   ⇒ 空格拼接 ✗ 就这么简单 ✓（TUI 就是这么吃的 ✓）
 *
 * @param values 按 field.id 给的值（没给的用默认值 ✓）
 */
export function buildCommandLine(item: CmdItem, values: Record<string, string> = {}): string {
    const parts: string[] = [];
    if (item.command) parts.push(`/${item.command}`);
    for (const f of item.fields ?? []) {
        const v = values[f.id] ?? defaultOf(f);
        if (v !== undefined && v !== "") parts.push(v);
    }
    return parts.join(" ");
}

/** 一个参数位的默认值（fixed 恒等于 value ✗ select 取第一项 ✓）*/
export function defaultOf(f: CmdField): string {
    if (f.kind === "fixed") return f.value ?? "";
    if (f.kind === "select") return f.options?.[0] ?? "";
    return "";
}

/** ★ 这个按钮需不需要收集参数？ */
export function needsInput(item: CmdItem): boolean {
    return (item.fields ?? []).length > 0;
}

// ── 下面是最小校验（配置是用户手改得动的 ✗ 不能信 ✓）──

function isCmdItem(x: unknown): x is CmdItem {
    return !!x && typeof x === "object" && typeof (x as CmdItem).label === "string";
}

/**
 * ★ 把外部传来的对象规范化成合法的 CmdItem（B32 ②）
 *
 * ★ 为什么导出？→ 配置页面保存时要用它 ✓（不信前端传来的形状 ✓）
 *   而且没有 id 的会自动补一个 ✗ 新建时正好省事 ✓
 */
export function normalizeItem(x: CmdItem): CmdItem {
    return normalize(x);
}

function normalize(x: CmdItem): CmdItem {
    const item: CmdItem = {
        id: typeof x.id === "string" && x.id ? x.id : newId(),
        label: x.label,
        type: x.type === "group" ? "group" : "button",
    };
    if (typeof x.hint === "string") item.hint = x.hint;
    if (typeof x.icon === "string") item.icon = x.icon;
    if (typeof x.command === "string") item.command = x.command;
    if (x.lockCommand === true) item.lockCommand = true;
    if (x.inputMode === "panel") item.inputMode = "panel";
    if (Array.isArray(x.fields)) item.fields = x.fields.filter(isField).map(normalizeField);
    if (Array.isArray(x.children)) item.children = x.children.filter(isCmdItem).map(normalize);
    return item;
}

function isField(x: unknown): x is CmdField {
    return !!x && typeof x === "object" && typeof (x as CmdField).label === "string";
}

function normalizeField(x: CmdField): CmdField {
    const kind: CmdField["kind"] =
        x.kind === "select" || x.kind === "any" ? x.kind : "fixed";
    const f: CmdField = {
        id: typeof x.id === "string" && x.id ? x.id : newId(),
        label: x.label,
        kind,
    };
    if (typeof x.value === "string") f.value = x.value;
    if (Array.isArray(x.options)) f.options = x.options.filter((o) => typeof o === "string");
    if (x.subType === "number") f.subType = "number";
    return f;
}

/**
 * ★★ 这个 icon 是不是【图片】（B32 图标 ✓）
 *
 * 【三种 icon 形态】
 *   ① emoji      如 🎛          → 直接当字符渲染 ✓
 *   ② codicon 名 如 gear        → <i class="codicon codicon-gear"> ✓
 *   ③ 图片       路径 / icons/xxx → <img src=...> ✓
 *
 * ★ 这里只判断"像不像图片"✗ 不检查文件真的在不在 ✓
 *   （文件不存在时原样留着 ✗ 用户还能看到自己填的路径去改 ✓）
 */
export function isImageIcon(icon: string): boolean {
    const s = icon.trim();
    if (!s) return false;
    // ① 已经被我们收进标准位置的 ✓
    if (s.startsWith("icons/")) return true;
    // ② 绝对路径 / 家目录 开头 ✓
    if (s.startsWith("~") || s.startsWith("/") || /^[A-Za-z]:[\\/]/.test(s)) return true;
    // ③ 认扩展名 ✓
    return /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(s);
}

/** ★ 是不是已经在【标准位置】了（= 我们自己的存储里 ✓）*/
export function isManagedIcon(icon: string): boolean {
    return icon.trim().startsWith("icons/");
}

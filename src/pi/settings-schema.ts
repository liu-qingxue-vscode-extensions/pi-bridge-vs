/**
 * settings-schema.ts —— 设置面板要暴露哪些字段（B24）
 *
 * 【为什么单独一个文件？】
 *   它是【我们和 pi 之间的一份契约】✗（哪些字段我们愿意管 ✓ 用什么控件 ✓）
 *   而读写逻辑在 settings.ts ✓ 渲染在前端 ✓ 三者分开好改 ✓
 *
 * 【设计原则】
 *   · ★ 只列【我们真正在意】的字段 ✗（TUI 专用的不列 ✓ 用户确认过清单 ✓）
 *   · ★ 每一项带【控件类型】✗（前端照做即可，不用自己判断 ✓）
 *   · ★ 未知字段【原样保留】✗（写入时不碰它们 ✓）
 *   · ★ 值可能【不存在】（用户没配过 ✓）→ 给默认值展示 ✓
 */

/** 控件类型（模仿 VS Code 的设置页 ✓）*/
export type FieldKind =
    | "text" // 单行文本
    | "number" // 数字
    | "boolean" // 复选框
    | "select" // 下拉（有限选项 ✓）
    | "list" // 字符串列表（添加 / 删除项 ✓）
    | "extlist" // ★ 已装扩展的启用/停用（复选框列表 ✓）
    | "providers"; // ★ 供应商凭据（看 / 增 / 删 ✓ oauth 只读 ✓）

export interface FieldDef {
    /** settings.json 里的键（支持 "a.b" 这种嵌套 ✗ 见 getByPath ✓）*/
    key: string;
    /**
     * ★ 这个配置存在哪（B31 ✓）
     *   "pi"     = pi 的 settings.json（默认 ✓ 绝大多数都是这个 ✓）
     *   "vscode" = VS Code 的工作区配置（pi-bridge.* ✗ 我们自己的设置 ✓）
     *
     * 【为什么要区分？】
     *   这个面板本来只渲染 pi 的字段 ✗
     *   但用户要求"技能单击行为"也放进来（放「行为」组 ✓）
     *   → 它是我们扩展自己的配置 ✗ 不是 pi 的 ✓
     *   → 读 / 写要分流：走 workspace.getConfiguration 而不是那个 json 文件 ✓
     */
    scope?: "pi" | "vscode";
    label: string;
    desc?: string;
    kind: FieldKind;
    /** select 用 ✓ */
    options?: { value: string; label: string }[];
    /** number 用 ✓ */
    min?: number;
    max?: number;
    /** 未配置时展示的默认值（不会写进文件 ✓ 只影响显示 ✓）*/
    fallback?: unknown;
    /** ★ 改了它需要重启 pi 才生效（前端会提示 ✓）*/
    needsRestart?: boolean;
}

export interface GroupDef {
    title: string;
    items: FieldDef[];
}

/**
 * ★ 我们愿意管的字段（用户拍过的清单 ✓）
 *
 * 【分组按"用户心智"分 ✗ 不按 pi 的类型分 ✓】
 *   模型 → 最常改 ✓
 *   行为 → 影响 pi 怎么干活 ✓
 *   环境 → 路径 / 网络 ✓
 *   技能 → 扩展能力 ✓
 */
export const SETTINGS_GROUPS: GroupDef[] = [
    {
        title: "模型",
        items: [
            {
                key: "defaultModel",
                // ★ 下拉（B24 用户要求：改成“有限字段”输入 ✓）
                //   选项由【宿主从 models.json + models-store.json 读】✗
                //
                // ★★ 值用 `provider/id` 格式 ✗（B24 合并决定 ✓）
                //   为什么？（用户发现的问题 ✓）
                //     pi 的 settings 里【两个字段】defaultProvider + defaultModel
                //     但它们是【一对】✗ 单独改一个 → 组合查不到 → 失效 ✓
                //     （model-resolver.js:502：两个都有才生效 ✓）
                //   → UI 上【只暴露这一个】✓ 选完我们【同时写两个字段】✓
                //     默认供应商那个字段【已删】✗
                label: "默认模型",
                desc: "pi 启动时用的模型（只影响启动 ✗ 不影响当前会话 ✓）选完会自动写 provider 字段 ✓",
                kind: "select",
                needsRestart: true,
            },
            {
                key: "defaultThinkingLevel",
                label: "默认思考深度",
                desc: "支持 off / minimal / low / medium / high / xhigh / max",
                kind: "select",
                options: ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((v) => ({
                    value: v,
                    label: v,
                })),
                needsRestart: true,
            },
            {
                key: "enabledModels",
                label: "启用模型列表",
                desc: "★ 模型切换菜单只在这里面循环（留空 = 全部可用 ✓）格式 provider/id",
                kind: "list",
            },
            {
                // ★ 供应商凭据（B24 ✓）
                //   ★ 为什么放在“模型”组？
                //     因为凭据就是“能不能用某家模型”的前提 ✓ 同属一类 ✓
                //   ★ 只做 api_key ✗（OAuth 完全只读 ✓ 用户定的 ✓）
                key: "__providers", // ★ 伪键 ✗ 不是 settings 字段（只用于渲染 ✓）
                label: "供应商凭据",
                desc: "★ api_key 可以在这里增删 ✓；OAuth（如 github-copilot）只能看 ✗ " +
                    "要登录/登出走终端：pi auth login <provider>",
                kind: "providers",
            },
        ],
    },
    {
        title: "行为",
        items: [
            {
                key: "compaction.enabled",
                label: "自动压缩",
                desc: "★ 上下文快到上限时自动压缩（和我们那个手动压缩按钮是两个东西 ✓）",
                kind: "boolean",
            },
            {
                key: "compaction.reserveTokens",
                label: "压缩预留 token",
                desc: "留多少 token 不参与压缩（越大越早压 ✓）",
                kind: "number",
                min: 0,
            },
            {
                key: "compaction.keepRecentTokens",
                label: "压缩后保留 token",
                desc: "压缩完保留最近多少内容 ✓",
                kind: "number",
                min: 0,
            },
            {
                key: "steeringMode",
                label: "插话投递模式",
                desc: "排了多条插话时：all = 一次全给 / one-at-a-time = 一条条来",
                kind: "select",
                options: [
                    { value: "all", label: "all（一次全给）" },
                    { value: "one-at-a-time", label: "one-at-a-time（一条条来）" },
                ],
            },
            {
                key: "retry.enabled",
                label: "自动重试",
                desc: "出错时 pi 自己重试（重连提示气泡就是它 ✓）",
                kind: "boolean",
            },
            {
                key: "retry.maxRetries",
                label: "重试次数",
                kind: "number",
                min: 0,
                max: 20,
            },
            {
                key: "retry.baseDelayMs",
                label: "重试基础延迟（ms）",
                kind: "number",
                min: 0,
            },
            {
                // ★ scope:"vscode" → 它不在 settings.json 里 ✗ 是 VS Code 配置 ✓
                key: "pi-bridge.skills.clickAction",
                scope: "vscode",
                label: "技能：单击行为",
                desc:
                    "技能面板里单击一条技能做什么 ✗ " +
                    "列表每项右侧的反向按钮语义会跟着翻转（选“填入”就显示“发送”✓）",
                kind: "select",
                options: [
                    { value: "insert", label: "填入输入框（默认 ✓ 不会误发 ✓）" },
                    { value: "send", label: "直接作为命令发送" },
                ],
                fallback: "insert",
            },
            {
                // ★ 隐藏清单（B31 ✓）：有些技能是包里带的 ✗ 删不掉 ✓ 但可以不显示 ✓
                key: "pi-bridge.skills.hidden",
                scope: "vscode",
                label: "技能：隐藏清单",
                desc: "列在这里的技能名不再显示（清空就恢复 ✓）",
                kind: "list",
                fallback: [],
            },
        ],
    },
    {
        title: "环境",
        items: [
            {
                key: "sessionDir",
                label: "会话目录",
                desc: "★ 改这里会话文件就搬家（留空 = 默认 <agentDir>/sessions ✓）改完需要重启 pi ✓",
                kind: "text",
                needsRestart: true,
            },
            {
                key: "httpProxy",
                label: "HTTP 代理",
                desc: "pi 请求模型 API 走的代理（你的 clash 是 127.0.0.1:7897 ✓）",
                kind: "text",
                needsRestart: true,
            },
        ],
    },
    {
        // ★ “拓展”（用户定的 ✓）：列出【已装】的扩展 ✗ + 复选框启用/停用 ✓
        //
        // 【用户原话】：“添加包？难道不是添加现有的包，
        //   来表达现有包的启用与否吗？现有的拓展的启用与否？”✓
        //   → 完全对 ✗ 所以不是“手动加包”✗ 而是【勾选启用】✓
        //
        // ★ 没有“其他”龙底组（用户：“本身就是来查错的”✓）
        title: "拓展",
        items: [
            {
                key: "packages",
                label: "扩展包",
                desc: "勾选 = 启用（写进 packages ✓）；取消 = 停用（包还在磁盘上 ✗ 只是不加载 ✓）\n改后需重启 pi ✓",
                kind: "extlist",
                needsRestart: true,
            },
        ],
    },
];

/** ★ 按 "a.b" 路径取值（compaction.enabled 这种 ✓）*/
export function getByPath(obj: unknown, key: string): unknown {
    let cur: unknown = obj;
    for (const seg of key.split(".")) {
        if (!cur || typeof cur !== "object") return undefined;
        cur = (cur as Record<string, unknown>)[seg];
    }
    return cur;
}

/** ★ 按 "a.b" 路径设置（会【就地展开】中间层 ✓ 其他字段不动 ✓）*/
export function setByPath(obj: Record<string, unknown>, key: string, value: unknown): void {
    const segs = key.split(".");
    let cur: Record<string, unknown> = obj;
    for (let i = 0; i < segs.length - 1; i++) {
        const s = segs[i];
        const nxt = cur[s];
        if (!nxt || typeof nxt !== "object" || Array.isArray(nxt)) {
            cur[s] = {};
        }
        cur = cur[s] as Record<string, unknown>;
    }
    cur[segs[segs.length - 1]] = value;
}

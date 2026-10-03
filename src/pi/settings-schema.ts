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
    | "extlist"; // ★ 已装扩展的启用/停用（复选框列表 ✓）

export interface FieldDef {
    /** settings.json 里的键（支持 "a.b" 这种嵌套 ✗ 见 getByPath ✓）*/
    key: string;
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
                //   选项由【宿主从 models.json 读】✗（不是写死的 ✓）
                label: "默认模型",
                desc: "pi 启动时用的模型（只影响启动 ✗ 不影响当前会话 ✓）",
                kind: "select",
                needsRestart: true,
            },
            {
                key: "defaultProvider",
                label: "默认供应商",
                desc: "与默认模型配套 ✓（选项从 models.json 读 ✓）",
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

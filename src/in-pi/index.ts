/**
 * in-pi —— 跑在 pi 进程【内部】的扩展（我们自己人）
 *
 * 【它为什么必须存在】
 *   有几个能力只有"在 pi 身体里"才拿得到：
 *     · 注册工具（AI 才能调用 vs_write / vs_answer）
 *     · 监听 turn_end 并 abort（让 pi 停在那里等审核）
 *     · appendEntry（把结构化数据写进会话，宿主从 RPC 事件流拿到）
 *   宿主侧（VS Code 扩展）无论如何都做不到这三件事。
 *
 * 【它只做三件事，别的都不做】
 *   1. 注册 vs_write / vs_answer 两个工具，两者【都不真正执行】
 *      · vs_write 只把提案记进会话条目
 *      · vs_answer 只把回答内容记进会话条目
 *      ⇒ 真正落盘由宿主在用户点"接受"时做（扩展侧不碰文件 ✓）
 *   2. 我们的工具跑完之后，立刻 abort
 *      · 时机必须是 turn_end —— 那时候工具结果【已经落盘】
 *      · 如果在工具 execute 里 abort，结果还没写进会话就断了
 *   3. 其他一切照旧（普通工具不拦、不 abort）
 *
 * 【宿主怎么拿到数据】
 *   appendEntry 会触发 RPC 事件 entry_appended，payload 里带完整 entry
 *   ⇒ 宿主不需要轮询、不需要私有通道（见 docs/json.md）
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * 只有这些工具跑完才急停。
 *
 * 【为什么不做成"所有工具都停"】
 *   AI 读文件、搜代码这些要保留流畅度；
 *   全程单步会让人等到崩溃，而且那些动作本来也不需要审核。
 */
const OUR_TOOLS = new Set(["vs_write", "vs_answer"]);

/** 会话条目的 customType（宿主按它识别我们的数据） */
const PROPOSAL = "vs-proposal";
const ANSWER = "vs-answer";
const TOUR = "vs-tour";

/**
 * 校验 text 模式：oldText 必须在这份文件里恰好出现一次。
 *
 * 在工具里做（而不是等宿主渲染时）有两个好处：
 *   1. 失败可以当场返回给模型，它自己就知道要补上下文，不用人转达
 *   2. 提案根本不会创建，不会在界面上闪一下再消失
 */
function checkUnique(
    cwd: string,
    file: string,
    oldText: string,
): { ok: true } | { ok: false; error: string } {
    if (!oldText.trim()) return { ok: false, error: "oldText 不能为空" };

    const abs = path.resolve(cwd, file);
    let raw: string;
    try {
        raw = readFileSync(abs, "utf8");
    } catch {
        return { ok: false, error: `读不到文件：${file}（注意路径要相对于工作区根目录）` };
    }

    const eol = raw.includes("\r\n") ? "\r\n" : "\n";
    const needle = oldText.replace(/\r\n/g, "\n").replace(/\n/g, eol);

    let hits = 0;
    let i = raw.indexOf(needle);
    while (i >= 0) {
        hits++;
        i = raw.indexOf(needle, i + 1);
    }

    if (hits === 0) {
        return {
            ok: false,
            error:
                "在文件里找不到 oldText。请确认内容（包括缩进、空行）与文件完全一致，" +
                "或者先用 read 工具看一下真实内容。",
        };
    }
    if (hits > 1) {
        return {
            ok: false,
            error: `oldText 在文件里匹配到 ${hits} 处，无法确定改哪一处。请带上更多上下文使其唯一。`,
        };
    }
    return { ok: true };
}

export default function (pi: ExtensionAPI): void {
    /** 这一轮里有没有跑过我们的工具（turn_end 里判断） */
    let ourToolRan = false;

    /**
     * 提案 id 序号。
     *
     * 只用 Date.now() 会撞车：模型常在一轮里并行调三次工具，
     * 三次都落在同一毫秒，id 相同，宿主的 Map 会把前两个覆盖掉。
     */
    let proposalSeq = 0;

    pi.on("tool_execution_end", (event) => {
        if (OUR_TOOLS.has(event.toolName)) ourToolRan = true;
    });

    /**
     * ★★ 急停的唯一正确落点
     *
     * turn_end 的语义（见 docs/extensions.md 第 746 行）：
     *   "runs after the assistant and tool-result messages have been persisted"
     * ⇒ 此处 abort 只会掐掉"下一轮的模型请求"，不会丢任何已写的内容
     */
    pi.on("turn_end", (_event, ctx) => {
        if (!ourToolRan) return;
        ourToolRan = false;
        ctx.abort();
    });

    pi.registerTool({
        name: "vs_write",
        label: "VS Write (needs review)",
        description:
            "向用户在 VS Code 里提交一份代码修改提案，由用户审核后才真正写入。" +
            "一次修改多处时，可以在同一轮里连续调用多次（每处一个提案），它们会并行等待审核。" +
            "提交后不要再重复提交同一处修改，等用户处理。",
        parameters: Type.Object({
            file: Type.String({ description: "相对于工作区根目录的文件路径" }),
            mode: Type.String({
                description:
                    '定位方式。目前只支持 "text"：按 oldText 精确匹配。' +
                    "（symbol / range 尚未实现）",
            }),
            oldText: Type.String({
                description:
                    "要被替换的原文，必须和文件内容完全一致（包括缩进和空行），" +
                    "并且在整个文件里唯一。上下文太少会匹配到多处而被拒绝。",
            }),
            newText: Type.String({ description: "替换成什么" }),
            explanation: Type.String({ description: "为什么这么改，写给用户看" }),
        }),
        async execute(
            _toolCallId: string,
            params: {
                file: string;
                mode: string;
                oldText: string;
                newText: string;
                explanation: string;
            },
        ): Promise<{
            content: { type: "text"; text: string }[];
            details: { proposalId?: string };
            isError?: boolean;
        }> {
            const mode = (params.mode ?? "text").trim();
            if (mode !== "text") {
                return {
                    content: [
                        {
                            type: "text",
                            text: `mode="${mode}" 还没有实现，请改用 mode="text"。`,
                        },
                    ],
                    details: {},
                    isError: true,
                };
            }

            const checked = checkUnique(process.cwd(), params.file, params.oldText);
            if (!checked.ok) {
                // 直接失败：提案不创建，模型收到原因后会自己调整
                return {
                    content: [{ type: "text", text: `提案未创建：${checked.error}` }],
                    details: {},
                    isError: true,
                };
            }

            const proposalId = `p-${Date.now().toString(36)}-${(proposalSeq++).toString(36)}`;
            pi.appendEntry(PROPOSAL, {
                proposalId,
                kind: "write",
                file: params.file,
                mode: params.mode,
                oldText: params.oldText,
                newText: params.newText,
                explanation: params.explanation,
                at: Date.now(),
            });
            return {
                content: [
                    {
                        type: "text",
                        text:
                            `提案 ${proposalId} 已提交，等待用户在 VS Code 里审核。` +
                            `不要重复提交；用户在讨论区提问时用 vs_answer 回答。`,
                    },
                ],
                details: { proposalId },
            };
        },
    });

    /**
     * 向宿主发一个内部请求，拿回字符串结果。
     *
     * 通道是 ctx.ui.input：在 RPC 模式下它会变成 extension_ui_request，
     * 宿主识别到 "pi-bridge:" 前缀就自己算完，把结果塞回 extension_ui_response。
     * 所以这个 await 会一直等到宿主算完 —— 和调用 bash 等编译是一个模型。
     */
    type UiInputCtx = {
        ui: { input(title: string, placeholder?: string): Promise<string | undefined> };
    };

    async function askHost(ctx: UiInputCtx, req: Record<string, unknown>): Promise<string> {
        const raw = await ctx.ui.input(`pi-bridge:${JSON.stringify(req)}`, "");
        return raw ?? JSON.stringify({ ok: false, error: "宿主没有响应" });
    }

    /**
     * LSP 查询工具暂时停用。
     *
     * 原因：VS Code 的符号 API 只给二十几个粗枚举的 kind，嵌套结构还经常丢，
     * 拿到的信息质量不足以支撑"先查再改"。等换成直接解析（typescript / tree-sitter）
     * 再开。代码留着，改这里一个开关就能恢复。
     */
    const ENABLE_LSP_TOOLS = false;
    if (ENABLE_LSP_TOOLS) {
        /**
         * 查询工具：让 AI 知道一个文件里有哪些函数/类，各自在哪几行。
         *
         * 实现是靠 ctx.ui.input 把请求转给宿主（宿主有语言服务），
         * 宿主算完把 JSON 塞进返回值，这里的 await 就拿到结果了 ——
         * 跟调用 bash 等编译是一个模式，一步到位，不需要两趟。
         *
         * 注意它【不在 OUR_TOOLS 里】：查询不该触发 abort。
         */
        pi.registerTool({
            name: "vs_symbols",
            label: "VS Symbols",
            description:
                "列出某个文件里的函数、类、方法（名字、类型、起止行号、声明行原文）。" +
                "改代码前先查一下，比猜行号可靠。" +
                "注意 kind 是 VS Code 的粗粒度枚举，跨语言经常不准（type alias 可能报成 Variable），" +
                "以 head（声明行原文）为准。返回 JSON：" +
                '{ok:true, count, symbols:[{name,kind,startLine,endLine,parent?,head?}]}',
            parameters: Type.Object({
                file: Type.String({ description: "相对于工作区根目录的文件路径" }),
            }),
            async execute(
                _toolCallId: string,
                params: { file: string },
                _signal: unknown,
                _onUpdate: unknown,
                ctx: { ui: { input(title: string, placeholder?: string): Promise<string | undefined> } },
            ): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }> {
                const raw = await askHost(ctx, { cmd: "symbols", file: params.file });
                return { content: [{ type: "text", text: raw }], details: {} };
            },
        });

        pi.registerTool({
            name: "vs_hover",
            label: "VS Hover",
            description:
                "查某个位置的悬停信息：真实类型、完整签名、文档注释。" +
                "vs_symbols 的 kind 是粗枚举会失真（type alias 报成 Variable 之类），" +
                "要精确类型就用这个。参数的行列都是 1-based，指到标识符上即可。",
            parameters: Type.Object({
                file: Type.String({ description: "相对于工作区根目录的文件路径" }),
                line: Type.Number({ description: "行号（1-based）" }),
                character: Type.Number({ description: "列号（1-based），指到名字上" }),
            }),
            async execute(
                _toolCallId: string,
                params: { file: string; line: number; character: number },
                _signal: unknown,
                _onUpdate: unknown,
                ctx: UiInputCtx,
            ): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }> {
                const raw = await askHost(ctx, {
                    cmd: "hover",
                    file: params.file,
                    line: params.line,
                    char: params.character,
                });
                return { content: [{ type: "text", text: raw }], details: {} };
            },
        });

        pi.registerTool({
            name: "vs_definition",
            label: "VS Definition",
            description:
                "跳到某个位置的定义（相当于在编辑器里按 F12）。" +
                "返回定义所在的文件与行号，用来确认这个东西到底是哪来的。",
            parameters: Type.Object({
                file: Type.String({ description: "相对于工作区根目录的文件路径" }),
                line: Type.Number({ description: "行号（1-based）" }),
                character: Type.Number({ description: "列号（1-based）" }),
            }),
            async execute(
                _toolCallId: string,
                params: { file: string; line: number; character: number },
                _signal: unknown,
                _onUpdate: unknown,
                ctx: UiInputCtx,
            ): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }> {
                const raw = await askHost(ctx, {
                    cmd: "definition",
                    file: params.file,
                    line: params.line,
                    char: params.character,
                });
                return { content: [{ type: "text", text: raw }], details: {} };
            },
        });

        pi.registerTool({
            name: "vs_references",
            label: "VS References",
            description:
                "找某个符号的所有引用位置（相当于 Shift+F12）。" +
                "改签名、改名字之前先查一遍，能避免漏掉调用点。",
            parameters: Type.Object({
                file: Type.String({ description: "相对于工作区根目录的文件路径" }),
                line: Type.Number({ description: "行号（1-based）" }),
                character: Type.Number({ description: "列号（1-based）" }),
            }),
            async execute(
                _toolCallId: string,
                params: { file: string; line: number; character: number },
                _signal: unknown,
                _onUpdate: unknown,
                ctx: UiInputCtx,
            ): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }> {
                const raw = await askHost(ctx, {
                    cmd: "references",
                    file: params.file,
                    line: params.line,
                    char: params.character,
                });
                return { content: [{ type: "text", text: raw }], details: {} };
            },
        });
    }

    pi.registerTool({
        name: "vs_answer",
        label: "VS Answer (discussion only)",
        description:
            "在提案的讨论区里回答用户。用于讨论阶段，不会进入正文。" +
            "每次回答后等待用户继续提问或做出决定。",
        parameters: Type.Object({
            proposalId: Type.String({ description: "正在讨论的提案 ID（宿主会在提示里给你）" }),
            text: Type.String({ description: "回答内容（支持 markdown）" }),
        }),
        async execute(_toolCallId, params) {
            pi.appendEntry(ANSWER, {
                proposalId: params.proposalId,
                text: params.text,
                at: Date.now(),
            });
            return {
                content: [{ type: "text", text: "回答已送到讨论区，等待用户继续。" }],
                details: {},
            };
        },
    });
    /**
     * 讲解工具：把要说的内容变成编辑器里逐帧播放的剧本。
     *
     * 播放器用现成的 CodeTour（已经实现了帧队列、快捷键、进度条、跨文件跳转），
     * 我们只负责把 AI 给的帧写成 tour 文件再叫它播放，不重写播放器。
     *
     * 它不触发 abort：讲完 AI 可以接着说，用户也可以马上追问。
     */
    pi.registerTool({
        name: "vs_show",
        label: "VS Show (walkthrough)",
        description:
            "把讲解内容以逐帧剧本的形式显示在编辑器里：每一帧定位到某个文件的某一行，" +
            "旁边显示你的说明。用户可以用快捷键一帧一帧往下走。" +
            "适合讲解一段代码是怎么运转的、某个 bug 出在哪、一次改动影响哪些地方。" +
            "每一帧可以指向不同的文件，一份剧本就能顺着一条链路跨好几个文件讲下去。" +
            "每帧的说明要短（一两句），长了旁边栏放不下。",
        parameters: Type.Object({
            title: Type.String({ description: "剧本标题（简短）" }),
            file: Type.String({
                description: "默认文件（相对工作区根目录）。某帧不填 file 时用它",
            }),
            steps: Type.Array(
                Type.Object({
                    file: Type.Optional(
                        Type.String({
                            description: "这一帧所在文件（相对工作区根目录），不填就用默认 file",
                        }),
                    ),
                    line: Type.Number({
                        description: "文件里的绝对行号（1-based），就是你读文件看到的那个行号",
                    }),
                    endLine: Type.Optional(
                        Type.Number({ description: "选中范围结束行（1-based），不填就是单行" }),
                    ),
                    description: Type.String({ description: "这一帧要讲什么，一两句话" }),
                }),
                { description: "帧列表，按播放顺序" },
            ),
        }),
        async execute(
            _toolCallId: string,
            params: {
                title: string;
                file: string;
                steps: Array<{
                    file?: string;
                    line: number;
                    endLine?: number;
                    description: string;
                }>;
            },
        ): Promise<{
            content: { type: "text"; text: string }[];
            details: Record<string, unknown>;
        }> {
            const steps = params.steps ?? [];
            if (steps.length === 0) {
                return {
                    content: [{ type: "text", text: "剧本没有任何帧，未创建。" }],
                    details: {},
                };
            }
            const tourId = `t-${Date.now().toString(36)}-${(proposalSeq++).toString(36)}`;
            pi.appendEntry(TOUR, {
                tourId,
                title: params.title,
                file: params.file,
                steps,
                at: Date.now(),
            });
            return {
                content: [
                    {
                        type: "text",
                        text: `剧本「${params.title}」已发送（${steps.length} 帧），用户正在编辑器里查看。`,
                    },
                ],
                details: { tourId, steps: steps.length },
            };
        },
    });

}

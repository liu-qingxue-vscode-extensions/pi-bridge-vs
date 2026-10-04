/**
 * ★ 测试扩展：依次触发回复桥的 4 种交互（B25）
 *
 * 用途：验证【我们发出的 extension_ui_response 能被 pi 正确接收】✗
 *   （这是整条桥里唯一有风险的一环 ✓ 形状对不代表 runtime 通 ✓）
 *
 * 用法：pi --ext <此文件> --mode rpc
 *       然后发命令 /uitest
 */
export default function (pi: {
    registerCommand: (
        name: string,
        def: {
            description?: string;
            handler: (
                args: string | undefined,
                ctx: {
                    ui: {
                        select: (t: string, o: string[]) => Promise<string | undefined>;
                        confirm: (t: string, m: string) => Promise<boolean>;
                        input: (t: string, p?: string) => Promise<string | undefined>;
                        editor: (t: string, pre?: string) => Promise<string | undefined>;
                        notify: (m: string, type?: string) => void;
                    };
                },
            ) => Promise<void>;
        },
    ) => void;
}) {
    pi.registerCommand("uitest", {
        description: "测试回复桥（select / confirm / input / editor）",
        handler: async (_args, ctx) => {
            const pick = await ctx.ui.select("① 选一个水果", ["苹果", "香蕉", "橘子"]);
            ctx.ui.notify(`select → ${pick ?? "(取消/超时)"}`, "info");

            const ok = await ctx.ui.confirm("② 确认一下", "要继续往下走吗？");
            ctx.ui.notify(`confirm → ${ok}`, "info");

            const text = await ctx.ui.input("③ 输入点什么", "随便写");
            ctx.ui.notify(`input → ${text ?? "(取消/超时)"}`, "info");

            const body = await ctx.ui.editor("④ 编辑一段", "预填的内容");
            ctx.ui.notify(`editor → ${body ? body.slice(0, 40) : "(取消/超时)"}`, "info");

            ctx.ui.notify("★ 四种交互都走完了 ✓", "success");
        },
    });
}

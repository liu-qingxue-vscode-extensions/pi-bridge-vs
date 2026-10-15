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

    /**
     * ★★ B26：并发版本（用来测【答卷模式】✗）
     *
     * 【为什么要它？】
     *   上面那个是【串行】✓ 只能测“单题模式”✗
     *   答卷模式（多页 + 确认页 + 一次性提交）必须靠【并发】触发 ✓
     *   Promise.all → 3 个请求会在【毫秒内一起到】✗
     *   → 队列 >= 2 → 前端判定为答卷 ✓
     */
    pi.registerCommand("uitest-batch", {
        description: "★ 并发发起 3 个交互（测答卷模式）",
        handler: async (_args, ctx) => {
            const [pick, ok, text] = await Promise.all([
                ctx.ui.select("① 并发：选一个水果", ["苹果", "香蕉", "橘子"]),
                ctx.ui.confirm("② 并发：继续吗？", "点确定或取消"),
                ctx.ui.input("③ 并发：写点什么", "随便写"),
            ]);
            ctx.ui.notify(
                `并发答案 → ${pick ?? "(取消)"} / ${ok} / ${text ?? "(取消)"}`,
                "success",
            );
        },
    });

    /**
     * ★★ B27 测试 1：串行 + 间隔（测“面板不关 ✗ 一页一页接着来 ✓”）
     *
     * 【它测什么？】
     *   用户要的：“先来一个是否允许的，等 3 秒，再来一个，循环 4 回”✓
     *   → 每个问题都【答完就发】✗（串行语义 ✓）
     *   → 但面板【不应该闪】✗ 600ms 窗口会吸收下一个请求 ✓
     *   → 页签应该从 [1] 长到 [1][2][3][4] ✗ 前几个变历史（只读）✓
     */
    pi.registerCommand("uitest-slow", {
        description: "★ 串行 + 每问间隔 3 秒 × 4 回（测累积多页）",
        handler: async (_args, ctx) => {
            const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
            for (let i = 1; i <= 4; i++) {
                const ok = await ctx.ui.confirm(
                    `第 ${i}/4 回：允许继续吗？`,
                    `这是第 ${i} 个问题（串行 ✗ 答完才发下一个 ✓）`,
                );
                ctx.ui.notify(`第 ${i} 回 → ${ok}`, "info");
                if (i < 4) await sleep(3000); // ★ 空 3 秒再问 ✓
            }
            ctx.ui.notify("★ 串行（带间隔）测试走完了 ✓", "success");
        },
    });

    /**
     * ★★ B27 测试 2：纯并发（5 个包一口气发出 ✓）
     *
     * 【与 /uitest-batch 的区别】
     *   那个是 3 个 ✗ 这个是 5 个 + 各种 method 混在一起 ✓
     *   更能看清【答卷模式的页签条】✗ 也更能测【确认页校验】✓
     *
     * 【★ 关键：它们都是【独立的数据包】✗】
     *   Promise.all 会让 5 个 output() 背靠背写 stdout ✓
     *   → 我们的 pending 一次性变 5 ✓ → 队列 >= 2 → 答卷模式 ✓
     */
    pi.registerCommand("uitest-parallel", {
        description: "★ 并发 5 个交互（测答卷模式 + 确认页）",
        handler: async (_args, ctx) => {
            const [fruit, ok1, text, ok2, fruit2] = await Promise.all([
                ctx.ui.select("① 并发：选一个水果", ["苹果", "香蕉", "橘子"]),
                ctx.ui.confirm("② 并发：允许吗？", "第一个是否题"),
                ctx.ui.input("③ 并发：输入点什么", "随便写"),
                ctx.ui.confirm("④ 并发：再来一次？", "第二个是否题"),
                ctx.ui.select("⑤ 并发：再选一个", ["苹果", "香蕉", "橘子"]),
            ]);
            ctx.ui.notify(
                `5 个并发答案 → ${fruit}/${ok1}/${text}/${ok2}/${fruit2}`,
                "success",
            );
        },
    });

    // ═══════════════════════════════════════════════════════════
    // ★★ B32：自由按钮容器的参数测试
    //
    // 【★★ 先澄清一个我搞错的事】
    //   我一开始以为：命令会“主动发起交互”来要参数 ✗（像 ctx.ui.select ✓）
    //   实际上：参数【直接写在命令行里】——
    //
    //     /dir add write /tmp/
    //          ↑   ↑     ↑
    //        参数1 参数2 参数3
    //
    //   ⇒ 所以“参数收集”就是【本地把字符串拼起来】✗
    //     跟 pi 的交互桥【完全无关】✓✓✓
    //   ⇒ ctx.ui.select 那种是极少数（ask 类）
    //     ✗ 不是我们要服务的主流协议 ✓
    //
    // 【⇒ 所以测试只需要一个命令】
    //   它把收到的参数原样回报 ✗ 正好验证：“拼出来的命令行对不对”✓
    //   ★ 一个命令就覆盖了：无参 / 1 个 / 2 个 / 3 个 …（都是同一个 handler ✓）
    // ═══════════════════════════════════════════════════════════

    pi.registerCommand("test-args", {
        description: "★ 把收到的参数原样回报（测自由按钮拼得很对不对）",
        handler: async (args, ctx) => {
            const raw = (args ?? "").trim();
            if (!raw) {
                ctx.ui.notify("test-args 收到：【无参数】（就传了个命令名 ✓）", "info");
                return;
            }
            // ★ 按空白拆开 ✗ 顺便把“第几个是什么”列出来 ✓
            const parts = raw.split(/\s+/);
            const lines = parts.map((p, i) => `  参数${i + 1} = ${p}`);
            ctx.ui.notify(
                `test-args 收到 ${parts.length} 个参数：\n${lines.join("\n")}\n原样：${raw}`,
                "success",
            );
        },
    });
}

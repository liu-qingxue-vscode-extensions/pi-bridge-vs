/**
 * command-host.ts —— 自由按钮配置页的【消息路由】（B36 ✓）
 *
 * 【★ 它在哪里用？】
 *   main.ts：new CommandPanel(uri, createCommandHost({ closePanel, save }))
 *
 * 【★ 和 skills-host.ts 同一套路】
 *   它们都是【编辑器区的独立面板】✗
 *   ⇒ 消息不走 handleFrontendMessage ✓ 走 WebviewPanel 自己的回调 ✓
 *   ⇒ B36 把这类面板的路由统一收进 panels/xxx-host.ts ✓
 *     （这样"面板的消息在哪被接"永远只有一处答案 ✓
 *       不会重演 B35 那个"加错通道 ⇒ 静默失效"的坑 ✓）
 *
 * 【★ 前端发的 kind 清单】（src/command/index.ts ✓）
 *   commandSave   ← 点「保存」
 *   commandCancel ← 点「取消」
 *   ★ 还有一个 ready ✗ 那个由 CommandPanel 类【自己】处理（要补发草稿 ✓）
 *     不会走到这个回调里 ✓
 *   ★ 另外：commandNew / commandEdit / commandRun / commandDelete / commandMove
 *     那五个是【侧栏聊天页的自由按钮竖条】发的 ✗ 不是配置页发的 ✓
 *     它们走 handleFrontendMessage ✓（别搞混 ✓）
 */
import { logWarn } from "../logger.js";

export interface CommandHostDeps {
    /** 关掉配置页（取消 / 保存完成后 ✓）*/
    closePanel: () => void;
    /** 保存草稿（含父约束二次校验 + 图标物化 ✓ 实现仍在 main.ts ✓）*/
    save: (item: Record<string, unknown>, parentId?: string) => Promise<void>;
}

/** 造一个配置页的消息处理器（塞给 CommandPanel 的 onMessage ✓）*/
export function createCommandHost(
    deps: CommandHostDeps,
): (kind: string, payload?: unknown) => void {
    return (kind, payload) => {
        switch (kind) {
            case "commandCancel":
                deps.closePanel();
                return;

            case "commandSave": {
                const p = payload as
                    | { item?: Record<string, unknown>; parentId?: string }
                    | undefined;
                const item = p?.item;
                // ★ 形状不对就直接丢 ✗（真校验在 save 里 ✓ 那儿会 normalize ✓）
                if (!item || typeof item.label !== "string") {
                    logWarn("命令配置页：保存请求缺少 label ✗ 已忽略");
                    return;
                }
                void deps.save(item, typeof p?.parentId === "string" ? p.parentId : undefined);
                return;
            }

            default:
                // ★ 不静默吞 ✓（前端加了新消息忘在宿主接 → 输出面板能立刻看见 ✓）
                logWarn(`命令配置页：宿主没接的消息 kind=${kind}`);
                return;
        }
    };
}

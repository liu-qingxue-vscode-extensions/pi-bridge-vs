/**
 * history-host.ts —— ★★ B47：完整历史面板的消息路由
 *
 * 【前端的 kind 清单】（src/webview/history.ts ✓ 一共 1 种）
 *   ready ← 面板加载完了 ⇒ 把该会话的完整历史推过去 ✓
 *
 * ★ 就这一个 ✗ 因为它是纯只读的（没有输入 / 没有动作 ✓）
 */
import { logInfo, logWarn } from "../logger.js";

export interface HistoryHostDeps {
    /** ★ 推样式变量（面板首次 ready 时要 ✓ 否则默认折叠开关是死的 ✓）*/
    postStyleVars: () => void;
    /**
     * 把某个会话的【完整历史】渲染出来（含已被压缩的部分 ✓）
     * ★ 实现见 main.ts：读 raw 模式的会话文件 ⇒ messagesToPatches ⇒ 推快照 ✓
     */
    renderFullHistory: () => void;
}

export function createHistoryHost(
    deps: HistoryHostDeps,
): (kind: string, payload?: unknown) => void {
    return (kind) => {
        if (kind === "ready") {
            logInfo("完整历史面板：收到 ready ⇒ 推配置 + 全量历史");
            // ★ 先推配置（默认折叠 / 折叠规则都在里面 ✓）
            deps.postStyleVars();
            deps.renderFullHistory();
            return;
        }
        logWarn(`完整历史面板：宿主没接的消息 kind=${kind}`);
    };
}

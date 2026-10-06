/**
 * session-host.ts —— 会话（"绘画"）面板的【消息路由】（B36 ✓）
 *
 * 【★ 它在哪里用？】
 *   main.ts：new SessionPanel(uri, createSessionHost({ actions }))
 *
 * 【★ 前端发的 kind 清单】（src/sessions/index.ts ✓ 一共 7 种）
 *   sessionReady    ← ★ 面板刚加载完（握手 ✗ 要列表 ✓）
 *   refreshSessions ← 点「⟳ 刷新」（只补名字 / 标异常 ✓ 不重扫文件内容 ✓）
 *   newSession      ← 点「＋ 新建」
 *   switchSession   ← 点某一条会话
 *   deleteSession   ← 右键「删除会话」
 *   exportSession   ← 右键「导出会话…」
 *   importSession   ← 右键「导入会话…」
 *
 * 【★ 不在这个清单里的三个】（它们是【侧栏 / 聊天页】发的 ✓）
 *   openSessions   ← 侧栏「☰ 会话」（打开面板 ✓ 走 chat-host）
 *   renameSession  ← 侧栏标题区点击（给当前会话改名 ✓ 走 chat-host）
 *   cloneSession / forkSession ← 聊天页气泡下那把"刀"✓ 走 chat-host
 *   ★ 但注意：它们最终都调【同一个 actions】✗ 实现只有一份 ✓
 */
import { logWarn } from "../logger.js";
import type { SessionActions } from "./session-actions.js";

export interface SessionHostDeps {
    /** 会话领域的动作集（见 session-actions.ts ✓）*/
    actions: SessionActions;
}

/** 造一个会话面板的消息处理器（塞给 SessionPanel 的 onMessage ✓）*/
export function createSessionHost(
    deps: SessionHostDeps,
): (kind: string, payload?: unknown) => void {
    return (kind, payload) => {
        switch (kind) {
            // ★ 握手：面板刚创建 / 被重建（互斥关掉再开也会重建 ✓）
            case "sessionReady":
                void deps.actions.list();
                return;

            case "refreshSessions":
                void deps.actions.refresh();
                return;

            case "newSession":
                void deps.actions.newSession();
                return;

            case "switchSession": {
                const p = payload as { path?: string } | undefined;
                if (typeof p?.path !== "string") {
                    logWarn("会话面板：切会话的请求缺 path ✗ 已忽略");
                    return;
                }
                void deps.actions.switchTo(p.path);
                return;
            }

            case "deleteSession": {
                const p = payload as { path?: string; name?: string } | undefined;
                if (typeof p?.path !== "string") {
                    logWarn("会话面板：删除请求缺 path ✗ 已忽略");
                    return;
                }
                void deps.actions.remove(p.path, typeof p.name === "string" ? p.name : undefined);
                return;
            }

            case "exportSession": {
                const p = payload as { path?: string; name?: string } | undefined;
                if (typeof p?.path !== "string") {
                    logWarn("会话面板：导出请求缺 path ✗ 已忽略");
                    return;
                }
                void deps.actions.exportOne(
                    p.path,
                    typeof p.name === "string" ? p.name : undefined,
                );
                return;
            }

            case "importSession":
                void deps.actions.importOne();
                return;

            default:
                // ★ 不静默吞 ✓（前端加了新消息忘在宿主接 → 输出面板能立刻看见 ✓）
                logWarn(`会话面板：宿主没接的消息 kind=${kind}`);
                return;
        }
    };
}

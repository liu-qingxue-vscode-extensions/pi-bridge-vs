/**
 * settings-host.ts —— 设置面板的【消息路由】（B36 ✓）
 *
 * 【★ 它在哪里用？】
 *   main.ts：new SettingsPanel(uri, createSettingsHost({ actions, onReady }))
 *
 * 【★ 前端发的 kind 清单】（src/settings/index.ts ✓）
 *   settingsReady  ← 面板刚加载完（握手 ✓ 要推数据 ✓）
 *   reloadSettings ← 点「重新读取」
 *   saveSettings   ← 点「保存」（只带【改过的】字段 ✓）
 *   addApiKey      ← 给某个供应商加 key
 *   removeAuth     ← 删某个供应商的凭据
 *
 * 【★ 不在这个清单里的两个】
 *   openSettings   ← 那是【侧栏 ⚙】发的 ✗ 走 chat-host ✓
 *                    （它要的是"打开面板"，不是"面板自己要数据" ✓）
 *   styleVars      ← 那是【宿主 → 前端】的方向 ✗ 不是前端发来的 ✓
 */
import { logWarn } from "../logger.js";
import type { SettingsActions } from "./settings-actions.js";

export interface SettingsHostDeps {
    /** 设置领域的动作集（见 settings-actions.ts ✓）*/
    actions: SettingsActions;
    /** ★ 面板就绪 → 推数据（= postSettings ✓）*/
    onReady: () => void;
}

/** 造一个设置面板的消息处理器（塞给 SettingsPanel 的 onMessage ✓）*/
export function createSettingsHost(
    deps: SettingsHostDeps,
): (kind: string, payload?: unknown) => void {
    return (kind, payload) => {
        switch (kind) {
            // ★ 握手：面板刚创建 / 被重建（互斥关掉再开也会重建 ✓）
            //   → 现读磁盘推一份 ✓（pi 自己也会写这个文件 ✗ 不能缓存 ✓）
            case "settingsReady":
                deps.onReady();
                return;

            // 「重新读取」→ 重读磁盘 + 重推 ✓
            //   ★ 本地改动由【前端自己】清掉（dirty.clear ✓）✗ 宿主不掺和 ✓
            case "reloadSettings":
                deps.actions.reload();
                return;

            case "saveSettings": {
                const p = payload as { values?: Record<string, unknown> } | undefined;
                void deps.actions.save(p?.values ?? {});
                return;
            }

            case "addApiKey": {
                const p = payload as { provider?: string; key?: string } | undefined;
                if (typeof p?.provider !== "string" || typeof p?.key !== "string") {
                    logWarn("设置面板：加 key 的请求形状不对 ✗ 已忽略");
                    return;
                }
                void deps.actions.addKey(p.provider, p.key);
                return;
            }

            case "removeAuth": {
                const p = payload as { provider?: string } | undefined;
                if (typeof p?.provider !== "string") {
                    logWarn("设置面板：删凭据的请求形状不对 ✗ 已忽略");
                    return;
                }
                void deps.actions.removeKey(p.provider);
                return;
            }

            default:
                // ★ 不静默吞 ✓（前端加了新消息忘在宿主接 → 输出面板能立刻看见 ✓）
                logWarn(`设置面板：宿主没接的消息 kind=${kind}`);
                return;
        }
    };
}

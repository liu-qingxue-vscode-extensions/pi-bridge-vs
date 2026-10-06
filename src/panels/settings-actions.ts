/**
 * settings-actions.ts —— 设置领域的【动作】（B36 ✓）
 *
 * 【★ 它管的是 pi 的 settings.json】✗（不是 VS Code 的配置 ✓）
 *   RPC 没有 settings 接口 ✗ → 宿主自己读写文件 ✓
 *
 * 【★ 和 settings-host 的分工】
 *   settings-host.ts   消息 → 动作的【映射】（哪个 kind 调哪个动作 ✓）
 *   settings-actions.ts 动作的【实现】（读-改-写 / 弹窗 / 推数据 ✓）
 *
 * 【★★ 为什么必须搬出来？】（B36 的核心目的 ✓）
 *   这些分支原来长在 handleFrontendMessage 里（聊天页那个大函数 ✓）
 *   但它们【不是聊天页专属的】✗
 *     · 侧栏的 ⚙ 和设置面板的「重新读取」都要能打开 / 刷新 ✓
 *     · 侧栏的 ⚙ 打开面板时走 chat-host ✗ 面板自己请求时走 settings-host ✓
 *   ⇒ 两条路都要落到【同一份实现】✗ 不然就会出现"两套保存逻辑"✓
 *   （B36 前是靠"面板把消息转交给 handleFrontendMessage"凑合的 ✓
 *     那是隐式的 ✗ 现在显式了 ✓）
 */
import * as vscode from "vscode";
import { patchSettings } from "../pi/settings.js";
import { setByPath } from "../pi/settings-schema.js";
import { removeAuth as removeAuthEntry, setApiKey } from "../pi/auth.js";
import { readModelCatalog } from "./model-catalog.js";
import { needsRestartHint } from "./settings-utils.js";
import { logError, logWarn } from "../logger.js";
import { toErrorMessage } from "../utils.js";

export interface SettingsActionsDeps {
    /** 重读磁盘 + 重推（= createSettingsPoster 的产物 ✓）*/
    postSettings: () => void;
    /** 打开 / 切到设置面板（走三面板互斥协调器 ✓）*/
    showPanel: () => void;
    /**
     * ★ 用户改了 sessionDir → 会话扫描根目录要跟着换 ✓
     *   （否则列表全空 ✗ 用户预言的"一定会出错"✓）
     *   由 main.ts 提供实现（它才拿得到 sessionStore ✓）
     */
    onSessionDirChanged: () => Promise<void>;
}

export interface SettingsActions {
    /** 打开 / 切到面板（侧栏 ⚙ · 命令入口 · 面板自己也用它刷新前先露面 ✓）*/
    open(): void;
    /** 「重新读取」：丢弃本地改动 + 重读磁盘（前端自己丢 ✗ 这里只重推 ✓）*/
    reload(): void;
    /** 保存（★ 读-改-写 ✗ 只动传进来的字段 ✓）*/
    save(values: Record<string, unknown>): Promise<void>;
    /** 保存某个供应商的 API key（写的是 auth.json ✗ 不是 settings.json ✓）*/
    addKey(provider: string, key: string): Promise<void>;
    /** 删除凭据（二次确认 → 登出 ✓）*/
    removeKey(provider: string): Promise<void>;
}

/** 造一份设置动作集（闭包持有 deps ✓）*/
export function createSettingsActions(deps: SettingsActionsDeps): SettingsActions {
    const open = (): void => deps.showPanel();

    const reload = (): void => deps.postSettings();

    /**
     * ★ 保存设置（B24）：★ 读-改-写 ✗ 只动我们改过的字段 ✓
     */
    const save = async (values: Record<string, unknown>): Promise<void> => {
        try {
            const patch: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(values)) {
                // ★★ 分流（B31 ✓）：`pi-bridge.*` 是【我们扩展自己的 VS Code 配置】✗
                //   不能写进 pi 的 settings.json ✓
                //   （用前缀判断就够 ✗ pi 的字段不可能以 pi-bridge. 开头 ✓）
                //   ★ 例如 pi-bridge.skills.clickAction（技能单击行为 ✓）
                if (k.startsWith("pi-bridge.")) {
                    await vscode.workspace
                        .getConfiguration()
                        .update(k, v, vscode.ConfigurationTarget.Global);
                    continue;
                }
                // ★★ defaultModel 是【合成字段】✗（界面上的值是 "provider/id" ✓）
                //   要拆回 pi 认的【两个】字段 ✓（B24 合并决定 ✓）
                //
                // 【之前这段没生效的教训】✗
                //   用 python 的 str.replace 改的 ✗ 没匹配上也不报错 ✓
                //   → 看起来"改完了"✗ 实际没改 ✓ 结果保存时把 "mock/mock"
                //     直接写进了 defaultModel ✓ 而 defaultProvider 没动 ✓
                //     → 文件里成了 provider=ollama + model=mock/mock（错配 ✗）
                //     → 前端拼出 "ollama/mock/mock" → 下拉里没这个选项 → 显示空 ✓
                //   ★ 教训：改代码用 edit 工具 ✗（不匹配会报错 ✓）
                //
                // 【拆法】不能用 split("/") ✗ —— 模型 id 自己可能带 / ✓
                //   （如 openrouter 的 moonshotai/kimi-k2.6 ✓）
                //   → 从【模型目录里反查】哪个条目完全匹配 ✓
                if (k === "defaultModel" && typeof v === "string" && v) {
                    const hit = readModelCatalog().find((m) => `${m.provider}/${m.id}` === v);
                    if (hit) {
                        patch.defaultProvider = hit.provider;
                        patch.defaultModel = hit.id;
                    } else if (!v.includes("/")) {
                        // 只给了 id（无 provider）→ 只写模型 ✓
                        patch.defaultModel = v;
                    } else {
                        logWarn(`默认模型：目录里找不到 "${v}" ✗ 本次不写入 ✓`);
                    }
                    continue;
                }
                // ★ 空字符串 → 删除该字段 ✗（pi 会回到默认 ✓）
                //   （而不是写一个空值进去 ✗ 那样 pi 会当成"显式设为空"✓）
                setByPath(patch, k, v === "" || v === undefined ? undefined : v);
            }
            patchSettings(patch);

            // ★ 改了 sessionDir → 会话扫描根目录要跟着换 ✓
            if ("sessionDir" in values) {
                await deps.onSessionDirChanged();
            }

            // ★ 重新读一遍回给前端（确认真的写进去了 ✓）
            deps.postSettings();
            void vscode.window.showInformationMessage(
                "设置已保存 ✓" +
                    (needsRestartHint(values)
                        ? "（部分项需重启 pi 生效 ✗ 点输入区的 ⟳）"
                        : ""),
            );
        } catch (err) {
            logError(`保存设置失败: ${toErrorMessage(err)}`);
            void vscode.window.showErrorMessage(`保存设置失败：${toErrorMessage(err)}`);
        }
    };

    /**
     * ★ 供应商凭据（B24）：写的是【另一个文件】auth.json ✗
     *   → 不混进 save 的批量提交流 ✓ 单独两个动作 ✓
     */
    const addKey = async (provider: string, key: string): Promise<void> => {
        try {
            setApiKey(provider, key);
            deps.postSettings(); // ★ 回读重绘 ✓
            void vscode.window.showInformationMessage(
                `已保存 ${provider} 的 API key ✓` +
                    "（如果 pi 已在运行，需要重启 pi 才生效 ✗）",
            );
        } catch (err) {
            logError(`保存 API key 失败: ${toErrorMessage(err)}`);
            void vscode.window.showErrorMessage(`保存失败：${toErrorMessage(err)}`);
        }
    };

    const removeKey = async (provider: string): Promise<void> => {
        try {
            // ★ 二次确认（不可逆 ✗）
            const pick = await vscode.window.showWarningMessage(
                `确定删除「${provider}」的凭据？（= 登出 ✗）`,
                { modal: true, detail: "删掉后 pi 就不能再用这个供应商了 ✓" },
                "删除",
            );
            if (pick !== "删除") return;
            removeAuthEntry(provider);
            deps.postSettings();
            void vscode.window.showInformationMessage(`已删除 ${provider} 的凭据 ✓`);
        } catch (err) {
            logError(`删除凭据失败: ${toErrorMessage(err)}`);
            void vscode.window.showErrorMessage(`删除失败：${toErrorMessage(err)}`);
        }
    };

    return { open, reload, save, addKey, removeKey };
}

/**
 * skills-host.ts —— 技能面板的【消息路由】（B36 ✓）
 *
 * 【★ 它在哪里用？】
 *   main.ts：new SkillsPanel(uri, createSkillsHost({ actions, closePanelAfterAction }))
 *
 * 【★★ 为什么要有这个文件？】（B35 踩的坑 ✗ 直接催生了它）
 *   技能面板是【编辑器区的独立页面】✗
 *   它的消息走 SkillsPanel 自己的回调 ✓ 【不经过】handleFrontendMessage ✓
 *   ⇒ 这两条路的区别以前【只写在注释里】✗ 结果：
 *     我把"动作后关面板"加进了 handleFrontendMessage ✗ 静默失效 ✓
 *     （用户实测："注入 / 直接发送都没关闭"✓ 见 B35 第七节 ✓）
 *   ⇒ B36 把技能面板的消息【全部收进这一个文件】✗
 *     以后"技能面板发了什么 / 宿主怎么回"只有一个答案 ✓
 *
 * 【★ 前端发的 kind 清单】（src/skills/index.ts ✓ 一共 7 种）
 *   openSkills     ← ★ 它同时是【握手】+「⟳ 刷新」✓
 *   skillOpenFile  ← 单击 / 右键「查看内容」「在磁盘上定位」
 *   skillDelete    ← 右键「删除」
 *   skillHide      ← 右键「隐藏」
 *   skillCreate    ← 列表最后的「＋ 新建技能」
 *   skillInsert    ← 单击（当单击行为 = insert）/ 右侧反向按钮
 *   skillAsCommand ← 单击（当单击行为 = send）/ 右侧反向按钮
 *   ★ 原来还有个 skillDetail ✗ 前端【根本没有发送方】✓ 已删（B36 ✓）
 */
import { logWarn } from "../logger.js";
import type { SkillsActions } from "./skills-actions.js";

export interface SkillsHostDeps {
    /** 技能领域的动作集（见 skills-actions.ts ✓）*/
    actions: SkillsActions;
    /**
     * ★ B35：动作完成后关掉技能面板（配置 pi-bridge.skills.closeAfterAction ✓）
     *   由 main.ts 提供 ✗ 因为"关面板 + 焦点回输入框"是宿主接线的事 ✓
     */
    closePanelAfterAction: () => void;
}

/** 造一个技能面板的消息处理器（塞给 SkillsPanel 的 onMessage ✓）*/
export function createSkillsHost(deps: SkillsHostDeps): (kind: string, payload?: unknown) => void {
    return (kind, payload) => {
        // ★ 五个带 name 的分支共用一个取值 ✗（payload 形状一致 ✓）
        const name = (payload as { name?: string } | undefined)?.name;

        switch (kind) {
            // 打开 / 刷新 → 扫盘 + 推列表 ✓
            case "openSkills":
                void deps.actions.refresh();
                return;

            case "skillOpenFile": {
                const p = payload as { name?: string; reveal?: boolean } | undefined;
                void deps.actions.openFile(p?.name ?? "", p?.reveal === true);
                return;
            }

            case "skillDelete":
                if (name) void deps.actions.remove(name);
                return;

            case "skillHide":
                if (name) void deps.actions.hide(name);
                return;

            case "skillCreate":
                void deps.actions.create();
                return;

            // ★★ 两个"用了就走"的动作 ✗ 先关面板再干活 ✓
            //   （用户定的：点击即关 ✗ 不等结果 ✓ 见 B35 ✓）
            case "skillInsert":
                deps.closePanelAfterAction();
                if (name) deps.actions.insertToChat(name);
                return;

            case "skillAsCommand":
                deps.closePanelAfterAction();
                if (name) deps.actions.sendAsCommand(name);
                return;

            default:
                // ★★ 不认识的消息【不静默吞掉】✗ 记一笔 ✓
                //   为什么？→ 前端加了新消息但宿主忘了接 ✗
                //   症状是"点了没反应"✗ 极难查 ✓ 输出面板留一句就能立刻定位 ✓
                logWarn(`技能面板：宿主没接的消息 kind=${kind}`);
                return;
        }
    };
}

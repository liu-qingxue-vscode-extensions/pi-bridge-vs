/**
 * settings-panel.ts —— 侧栏的【⚙ 设置入口】（B35 瘦身版 ✓）
 *
 * 【★ 它现在只干一件事】
 *   点 ⚙ → 请求宿主打开【独立的设置面板】✓
 *   （宿主收到 openSettings → settingsPanel.show() ✓）
 *
 * 【★ 为什么只剩这么少？】（用户定的：面板搬编辑器区 ✓）
 *   原来这里是个 448 行的完整表单实现 ✗
 *   → 表单渲染 / 分组折叠 / 保存 / 重新读取
 *     全部搬去了 src/settings/index.ts ✓
 *   → 侧栏只留"那个按钮"✓
 *
 * 【★ 搬走的东西都在哪】
 *   src/settings/index.ts          面板前端（渲染 + 保存 + 重读 ✓）
 *   src/view/settings-panel.ts     面板宿主（WebviewPanel ✓）
 *   media/settings.html + .css     页面与样式 ✓
 */
import { btnSettings } from "./dom.js";
import { vscode } from "./vscode-api.js";

/** ★ 绑定 ⚙ 按钮（入口调用一次 ✓）*/
export function setupSettingsPanel(): void {
    // ★★ 不再需要在 click 里 stopPropagation ✗
    //   原来侧栏有"点面板外面收起"的 document 监听 ✗ 会误伤这个按钮 ✓
    //   现在面板独立了 ✗ 那个监听也没了 ✓
    btnSettings.addEventListener("click", () => {
        vscode.postMessage({ kind: "openSettings" });
    });
}

/**
 * index.ts —— webview 的【入口】
 *
 * 【它只做三件事】
 *   ① 绑定交互（输入区 / 通知板的点击与手势）
 *   ② 绑定宿主消息监听
 *   ③ 告诉宿主"我准备好了" → 请求重放快照
 *
 * 【模块依赖（单向，无循环 ✓）】
 *   index → apply ─┬→ bubbles → (thinking / segments / tool / notices)
 *                  ├→ topbar / noticeboard / input
 *                  └→ dom · state · format（叶子模块）
 *
 * 【为什么 index.ts 必须存在？】
 *   构建工具（esbuild）需要一个人口文件；而且"启动顺序"本身就是一种信息 ✓
 */
import { post, log } from "./vscode-api.js";
import { setupInput } from "./input.js";
import { setupNoticeBoard } from "./noticeboard.js";
import { setupSessions } from "./sessions.js";
import { setupCompact } from "./compact.js";
import { setupModelPicker } from "./model-picker.js";
import { setupSettingsPanel } from "./settings-panel.js";
import { btnSkills } from "./dom.js";
import { setupMarkdown } from "./markdown.js";
import { setupSlashMenu } from "./slash-menu.js";
import { setupUiRequest } from "./ui-request.js";
// ★★ B32：自由按钮容器
import { setupCmdRail } from "./cmdrail.js";
import { setupHostBridge } from "./apply.js";
// ★ B32：布局自检（只在排查时看 ✗ 却很有用 ✓）
import { diagLayoutSoon } from "./diag.js";

/**
 * ★ 每个 setup 都独立 try/catch —— 【一处出错不能搞崩整个界面】✓
 *
 * 【为什么要这样？】（真实教训 ✗）
 *   之前 setupSessions() 里有个 null.addEventListener → 抛错
 *   → 它【后面】的 setupHostBridge() 就不会执行 ✗
 *   → 宿主推什么都收不到 → OCR“界面啥也没有”✗（非常难排查 ✓）
 *   → 现在：谁崩谁自己记一笔，其他照常工作 ✓
 */
function safe(name: string, fn: () => void): void {
    try {
        fn();
    } catch (err) {
        // ★ 双写：console（devtools 能看到完整堆栈 ✓）+ 输出面板（随手可见 ✓）
        console.error(`[pi-bridge] ★ ${name} 初始化失败:`, err);
        log.error(
            `★ ${name} 初始化失败（其余功能继续）: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
}

// ① 交互绑定（幂等，只会绑一次 ✓）
safe("input", setupInput);
safe("noticeBoard", setupNoticeBoard);
safe("sessions", setupSessions);
safe("compact", setupCompact);
safe("modelPicker", setupModelPicker);
safe("settings", setupSettingsPanel);

safe("uiRequest", setupUiRequest);
// ★★ B32：自由按钮容器（气泡区左侧那根竖条 ✓）
safe("cmdRail", setupCmdRail);
safe("slashMenu", setupSlashMenu);
// ★ B31：技能面板搬到编辑器区 ✗ 侧栏这个按钮只负责【打开面板】✓
btnSkills.addEventListener("click", () => post("openSkills"));
safe("markdown", setupMarkdown);

// ② 宿主消息监听（★ 最关键：无论前面谁崩，它必须挂上 ✓）
safe("hostBridge", setupHostBridge);

// ③ 通知宿主：webview 已就绪 → 请求重放快照
//    （webview 被销毁重建后靠这个恢复画面 —— "显示器"没脑子，状态都在插件端）
post("ready");
// ★ B29：主动要一次 VS Code 主题 ✗（代码高亮用 ✓）
post("getTheme");

// ④ ★★ B32：布局自检 ✗ 延迟两帧（等布局稳定）后量一遍 → 输出面板 ✓
//   为什么留在正式代码里？
//     布局问题（气泡怼进容器 / 宽度不对）几乎全从“某个变量没生效”冒出来 ✗
//     而猜是猜不出来的 ✗ 量一次就清楚了 ✓
//   默认走 log.info ✗ 用户在输出面板随手就能看到 ✓
diagLayoutSoon();

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
import { post } from "./vscode-api.js";
import { setupInput } from "./input.js";
import { setupNoticeBoard } from "./noticeboard.js";
import { setupSessions } from "./sessions.js";
import { setupHostBridge } from "./apply.js";

// ① 交互绑定（幂等，只会绑一次 ✓）
setupInput();
setupNoticeBoard();
setupSessions();

// ② 宿主消息监听
setupHostBridge();

// ③ 通知宿主：webview 已就绪 → 请求重放快照
//    （webview 被销毁重建后靠这个恢复画面 —— "显示器"没脑子，状态都在插件端）
post("ready");

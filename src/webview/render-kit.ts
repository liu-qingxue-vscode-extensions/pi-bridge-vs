/**
 * render-kit.ts —— 公共渲染能力（谁都可以用）
 *
 * 【为什么要有这一层？】
 *   正文气泡、工具气泡、以后的面板，都会需要"把一段内容渲染成 DOM"：
 *     · Markdown → DOM
 *     · 代码 → 高亮 + 行号
 *   这些能力本来就该是【中立的基础设施】✗ 而不是"正文模块的私有函数被借用"✓
 *   ⇒ 想用的人从这个门面进 ✓ 不用去猜"那个模块能不能给别人用" ✓
 *
 * ★ 语义约定：这里只有【纯渲染】✗ 不含任何"当前气泡是谁"之类的状态
 */
export { renderMarkdown } from "./markdown.js";
export { scheduleHighlight } from "./markdown.js";
export { highlightBlock, highlightShellInto, LANG_ALIAS } from "./highlight.js";

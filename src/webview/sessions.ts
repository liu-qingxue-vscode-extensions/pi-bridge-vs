/**
 * sessions.ts —— 侧栏的【会话入口 + 顶栏会话名】（B35 瘦身版 ✓）
 *
 * 【★ 它现在只剩三件事】
 *   ① 顶栏的【会话名】（含动态字号 ✓）
 *   ② ☰ 会话按钮 → 打开【独立的会话面板】
 *   ③ ＋ 新建 / 点标题改名
 *
 * 【★ 为什么瘦成这样？】（用户定的：侧栏【完全移走】✓）
 *   会话面板整块搬到编辑器区了 ✗
 *   → 列表渲染 / 分组 / fork 树 / 右键菜单 / 刷新
 *     全部去了 src/sessions/ ✓
 *   → 这里只留"侧栏还必须知道的那点东西"✓
 *
 * 【★ 不在这里维护了】
 *   · expanded / 展开收起   —— 独立面板没有这个概念 ✓
 *   · currentCwd            —— 面板自己有（宿主在 sessionList 里带 ✓）
 *   · renderSessions        —— 见 src/sessions/index.ts ✓
 *   · 面板互斥协调器         —— 面板不在侧栏里 ✗ 不需要互斥 ✓
 *   · treeify / fmtTime / prettyPath / SessionInfo → src/sessions/session-util.ts ✓
 */
import { log, vscode } from "./vscode-api.js";
import { btnNewSession, btnSessions, sessionTitle } from "./dom.js";

/**
 * ★ 设置/刷新【顶栏的会话名】（按钮行中间那个 ✓）
 *
 * 【为什么要动态调字号？】（用户的要求 ✓）
 *   标题区宽度【固定】✗ 但会话名长度【各不相同】✗
 *   "pi-bridge" 很短 ✓ / "这个是我 你之前的指引下我去学习…" 很长 ✗
 *   → ★ 名字长就自动缩字号，尽量把名字完整显示出来 ✓
 *   → 缩到最小（9px）还放不下 → 交给 CSS 的 ellipsis 省略 ✓
 *
 * 【为什么用 JS 而不是 CSS？】
 *   CSS 没有"字号自适应容器"的能力 ✗
 *   （SVG 有 textLength ✓ transform:scale 会把字压扁 ✗）
 *   → JS 测量一次、按比例算出来 ✓（不试探、不循环 ✓）
 */
export function setSessionTitle(name: string | undefined): void {
    const el = sessionTitle;
    const text = (name ?? "").trim();
    log.info(`标题：收到会话名「${text || "（空）"}」`);

    el.textContent = text || "（无名字）";
    el.classList.toggle("empty", !text);
    el.title = text ? `会话名：${text}（点击修改）` : "这个会话还没有名字（点击给它命名）";

    // ★ 字号自适应（先重置再量 ✓ 否则会越缩越小 ✗）
    const BASE = 13;
    const MIN = 9;
    el.style.fontSize = `${BASE}px`;
    const w = el.clientWidth;
    const sw = el.scrollWidth;
    if (w > 0 && sw > w) {
        const ratio = w / sw;
        const size = Math.max(MIN, BASE * ratio);
        el.style.fontSize = `${size}px`;
        log.debug(`标题：字号 ${BASE}→${size.toFixed(1)}px（容器 ${w}px / 文本 ${sw}px）`);
    } else {
        log.debug(`标题：字号保持 ${BASE}px（容器 ${w}px / 文本 ${sw}px）`);
    }
}

/** ★ 绑定侧栏的三个入口（入口调用一次 ✓）*/
export function setupSessions(): void {
    // ① ☰ 会话 → ★ 打开【独立会话面板】（B35 ✗ 不再在侧栏展开 ✓）
    //     宿主收到 openSessions → sessionPanel.show() ✓
    btnSessions.addEventListener("click", () => {
        log.info("点了【会话】→ 请宿主打开独立面板");
        vscode.postMessage({ kind: "openSessions" });
    });

    // ② ＋ 新建 → 通知宿主新建会话 ✓
    //     ★ 那是"伪新建"✗ 发第一条消息才落盘 ✓
    btnNewSession.addEventListener("click", () => {
        vscode.postMessage({ kind: "newSession" });
    });

    // ③ 点【标题区】→ 改名（改的是【当前】会话 ✓ 不是列表里任意一条 ✓）
    sessionTitle.addEventListener("click", () => {
        log.info("点了【会话名】→ 请宿主弹输入框改名");
        vscode.postMessage({ kind: "renameSession" });
    });
}

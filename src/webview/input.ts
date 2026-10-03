/**
 * input.ts —— 输入区：发送 / 中断 / 高度自适应 / 样式变量应用
 *
 * 【高度自适应】最小/最大【行数】可配 → 逐行爬高 → 超上限出滚动条 ✓
 * 【发送按钮双重身份】空闲 = 发送（↑）；工作中 = 转圈，点击 = 中断 ✓
 *   （转圈本身就表示"正在跑"，点击它天然对应"中断" ✓）
 */
import { vscode } from "./vscode-api.js";
import { inputEl, sendBtn, messagesEl, inputAreaEl, footCwd, btnReload } from "./dom.js";
import { ui } from "./state.js";
import { cssNum, lineHeightOf, shortenPath } from "./format.js";

function send(): void {
    const text = inputEl.value.trim();
    if (!text) return;
    ui.userAborted = false; // ★ 新任务开始 → 清中断标志 ✓
    vscode.postMessage({ kind: "prompt", text });
    inputEl.value = "";
    autoGrow();
}

/**
 * ★ 把消息区的底部留白同步为【输入区实际高度】
 * 否则固定留白会在"滚到底"时露出一块多余空白（用户看到的那条"缝" ✗）
 */
function syncPadding(): void {
    messagesEl.style.paddingBottom = inputAreaEl.offsetHeight + 8 + "px";
}

/** 输入框高度自适应 */
export function autoGrow(): void {
    const lineH = lineHeightOf(inputEl);
    const minH = cssNum("--pi-input-min-rows", 1) * lineH;
    const maxH = Math.max(cssNum("--pi-input-max-rows", 8) * lineH, minH);
    inputEl.style.height = "auto"; // 先重置才能量到真实高度
    inputEl.style.height = Math.min(Math.max(inputEl.scrollHeight, minH), maxH) + "px";
    inputEl.style.overflowY = inputEl.scrollHeight > maxH ? "auto" : "hidden";
    syncPadding();
}

/**
 * 任务状态（agent_start / agent_settled 驱动）
 * 注：不用中文状态文字 —— 按钮形态本身就是指示 ✓
 */
export function setAgentState(state: string): void {
    const busy = state === "working";
    sendBtn.classList.toggle("busy", busy);
    sendBtn.title = busy ? "点击中断" : "发送 (Enter)";
}

/** 工作目录（输入区下方极简栏；完整路径放 title ✓） */
export function showCwd(p: string): void {
    footCwd.textContent = shortenPath(p, 40);
    footCwd.title = p;
}

/**
 * 应用样式变量（设置变化时由宿主推送）
 * ★ 先清掉所有旧 --pi-* 再写新的：否则用户把某项改回"空"时，残留的旧值会继续生效 ✗
 */
export function applyStyleVars(vars?: Record<string, string>): void {
    const root = document.documentElement;
    const names: string[] = [];
    for (let i = 0; i < root.style.length; i++) names.push(root.style[i]);
    for (const n of names) {
        if (n.startsWith("--pi-")) root.style.removeProperty(n);
    }
    for (const [k, v] of Object.entries(vars ?? {})) {
        root.style.setProperty(k, v);
    }
    // ★ 居中内容列开关 + 默认折叠开关（布尔不能当 CSS 变量用 → 切类 / 存状态）
    root.classList.toggle("centered", !!vars && vars["--pi-centered-mode"] === "on");
    ui.defaultThinkCollapsed = !!vars && vars["--pi-think-collapsed"] === "on";
    ui.defaultToolCollapsed = !!vars && vars["--pi-tool-collapsed"] === "on";
    ui.noticeAutoOpen = !!vars && vars["--pi-notice-auto-open"] === "on";

    // ★ 工具结果“洏几行”：格式 "头:尾"（如 "3:2"）；解析失败 → 置空（不启用 ✓）
    ui.toolPeek = parsePeek(vars?.["--pi-tool-peek-lines"]);
}

/**
 * 解析 "3:2" → { head: 3, tail: 2 }
 * 宽容处理："3" → { head: 3, tail: 0 }；空/非法 → null ✓
 */
function parsePeek(raw?: string): { head: number; tail: number } | null {
    if (!raw) return null;
    const [h, t] = String(raw).split(":");
    const head = Math.max(0, Math.floor(Number(h) || 0));
    const tail = Math.max(0, Math.floor(Number(t) || 0));
    if (head === 0 && tail === 0) return null; // 都是 0 → 不启用 ✓
    return { head, tail };
}

/** 绑定输入区交互（入口调用一次 ✓） */
export function setupInput(): void {
    // ★ 点击发送按钮：工作中 → 中断；空闲 → 发送
    sendBtn.addEventListener("click", () => {
        if (sendBtn.classList.contains("busy")) {
            ui.userAborted = true; // ★ 记住：这次是【我们主动中断】的（用于区分重连"成功"和"被中断"✓）
            vscode.postMessage({ kind: "abort" });
        } else {
            send();
        }
    });

    inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
        }
    });

    inputEl.addEventListener("input", autoGrow);
    window.addEventListener("resize", autoGrow);
    autoGrow();

    // ★ 重启 pi：应用最新启动参数（改了 pi-bridge.launchArgs 后点它 ✓）
    //   为什么需要？启动参数只影响 spawn 时刻 ✗ → 必须重启进程才能生效 ✓
    btnReload.addEventListener("click", () => {
        vscode.postMessage({ kind: "reloadPi" });
    });
}

/**
 * input.ts —— 输入区：发送 / 中断 / 高度自适应 / 样式变量应用
 *
 * 【高度自适应】最小/最大【行数】可配 → 逐行爬高 → 超上限出滚动条 ✓
 * 【发送按钮双重身份】空闲 = 发送（↑）；工作中 = 转圈，点击 = 中断 ✓
 *   （转圈本身就表示"正在跑"，点击它天然对应"中断" ✓）
 */
import { setCodeAutoFit } from "./code-fit.js";
import { vscode } from "./vscode-api.js";
import { inputEl, sendBtn, messagesEl, inputAreaEl, footCwd, btnReload } from "./dom.js";
import { ui } from "./state.js";
import { cssNum, lineHeightOf, shortenPath } from "./format.js";
import { slashMenuKey } from "./slash-menu.js";

function send(): void {
    const text = inputEl.value.trim();
    if (!text) return;
    ui.userAborted = false; // ★ 新任务开始 → 清中断标志 ✓
    vscode.postMessage({ kind: "prompt", text });
    inputEl.value = "";
    autoGrow();
}

/**
 * ★ 把消息区的底部留白同步为【输入区实际高度 + 动作区高度】
 *
 * 【两个组成部分】（少一个就会出问题 ✗）
 *   ① 输入区高度：否则固定留白会在“滚到底”时露出一块多余空白 ✓
 *   ② ★ 最后一条气泡的【动作区】高度（复制/克隆/分叉 ✓）
 *      少这一部分 → 滚到底时动作区落在输入区后面被盖住 ✗
 *      （用户实测报的：内容高度正确，但下面的按钮点不到 ✓）
 *
 * 【为什么用“最后一条气泡”的实测高度？】
 *   · 空动作区是 display:none ✓ → offsetHeight = 0 ✓ 自动不预留 ✓
 *   · 用户改了字号/内边距 → 高度会变 ✓ 实测比写常量更能自适应 ✓
 */
export function syncPadding(): void {
    const last = messagesEl.lastElementChild as HTMLElement | null;
    const actions = last?.querySelector<HTMLElement>(".bubble-actions");
    const actionsH = actions?.offsetHeight ?? 0;
    messagesEl.style.paddingBottom = inputAreaEl.offsetHeight + actionsH + 8 + "px";
    // ★★ B32：同时写进 CSS 变量 ✗ 让【输入区高度】有两个消费方 ✓
    //   ① #messages 的 padding-bottom（上面那行 ✓）
    //   ② #cmd-rail 的 bottom（命令条到输入区上方截断 ✓）
    //   ★ 两者必须一致 ✗ 分开算迟早会忘掉一处 ✓
    document.documentElement.style.setProperty(
        "--pi-input-reserve",
        inputAreaEl.offsetHeight + actionsH + 8 + "px",
    );
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
export function showCwd(p: string | { path?: string; short?: string }): void {
    const path = typeof p === "string" ? p : (p.path ?? "");
    const short = typeof p === "string" ? p : (p.short ?? path);
    footCwd.textContent = shortenPath(path, 40);
    footCwd.title = path;
    // ★★ B38：存一份给 bash 终端提示符用
    ui.cwd = path;
    ui.cwdShort = short;
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
    // ★ B41：代码过宽自动缩放（默认开 ✗ 只有显式 "0" 才关）
    setCodeAutoFit(!vars || vars["--pi-code-autofit"] !== "0");

    // ★★ B38：工具气泡的两个滚动开关已删（现在没有内滚动 ✗ 长内容交给折叠 ✓）

    // ★★ B38：toolPeekLines 已删（行级折叠改由 toolFold 管 ✓）
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
        // ★ B27：先给斜杠补全一次机会 ✗
        //   （它开着时 ↑↓/Enter/Tab/Esc 都归它 ✓）
        if (slashMenuKey(e)) return;
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

    // ★ 点工作目录显示区 → 改 cwd
    //   （★ 这是【唯一】改 cwd 的入口；改完宿主会重启 pi 并清空对话 ✓）
    footCwd.addEventListener("click", () => {
        vscode.postMessage({ kind: "changeCwd" });
    });
}

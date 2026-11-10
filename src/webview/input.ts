/**
 * input.ts - 输入区:发送 / 中断 / 高度自适应 / 样式变量应用
 *
 * [高度自适应]最小/最大[行数]可配 → 逐行爬高 → 超上限出滚动条
 * [发送按钮双重身份]空闲 = 发送(↑);工作中 = 转圈,点击 = 中断
 *   (转圈本身就表示"正在跑",点击它天然对应"中断" )
 */
import { setCodeAutoFit } from "./code-fit.js";
import { vscode, log } from "./vscode-api.js";
import { inputEl, sendBtn, messagesEl, inputAreaEl, footCwd, btnReload } from "./dom.js";
import { ui } from "./state.js";
import { cssNum, lineHeightOf, shortenPath } from "./format.js";
import { slashMenuKey } from "./slash-menu.js";

function send(): void {
    const text = inputEl.value.trim();
    if (!text) return;
    ui.userAborted = false; // 新任务开始 → 清中断标志
    vscode.postMessage({ kind: "prompt", text });
    inputEl.value = "";
    autoGrow();
    // 发消息是明确的"我要看最新":不管之前翻到哪,直接拉回底部并恢复跟随
    ui.autoScroll = true;
    messagesEl.scrollTop = messagesEl.scrollHeight;
}

/**
 * 把消息区的底部留白同步为[输入区实际高度 + 动作区高度]
 *
 * [两个组成部分](少一个就会出问题 )
 *   ① 输入区高度:否则固定留白会在“滚到底”时露出一块多余空白
 *   ② 最后一条气泡的[动作区]高度(复制/克隆/分叉 )
 *      少这一部分 → 滚到底时动作区落在输入区后面被盖住
 *      (用户实测报的:内容高度正确,但下面的按钮点不到 )
 *
 * [为什么用“最后一条气泡”的实测高度?]
 *   · 空动作区是 display:none → offsetHeight = 0 自动不预留
 *   · 用户改了字号/内边距 → 高度会变 实测比写常量更能自适应
 */
export function syncPadding(): void {
    const last = messagesEl.lastElementChild as HTMLElement | null;
    const actions = last?.querySelector<HTMLElement>(".bubble-actions");
    const actionsH = actions?.offsetHeight ?? 0;
    messagesEl.style.paddingBottom = inputAreaEl.offsetHeight + actionsH + 8 + "px";
    // B32:同时写进 CSS 变量 让[输入区高度]有两个消费方
    //   ① #messages 的 padding-bottom(上面那行 )
    //   ② #cmd-rail 的 bottom(命令条到输入区上方截断 )
    //   两者必须一致 分开算迟早会忘掉一处
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
 * 任务状态(agent_start / agent_settled 驱动)
 * 注:不用中文状态文字 - 按钮形态本身就是指示
 */
/**
 * B43:锁 / 解锁 prompt 口(用户定的规则:"pi 找不到 / setting 读不了 ⇒ 不让发消息")
 *
 * [为什么锁的是"发送"而不是整个输入框]用户还要能看 只是不能让它动手
 *   ⇒ 这里直接把输入区置灰 + 换提示文案(最直白 用户一眼知道为什么发不出去 )
 */
export function setPromptGate(gate: { allowed?: boolean; reason?: string }): void {
    const allowed = gate.allowed !== false;
    inputEl.disabled = !allowed;
    inputEl.classList.toggle("prompt-locked", !allowed);
    if (allowed) {
        if (inputEl.dataset.lockedPlaceholder) {
            inputEl.placeholder = inputEl.dataset.lockedPlaceholder;
            delete inputEl.dataset.lockedPlaceholder;
        }
    } else {
        // 记下原 placeholder 解锁后能还原
        if (!inputEl.dataset.lockedPlaceholder) {
            inputEl.dataset.lockedPlaceholder = inputEl.placeholder;
        }
        inputEl.placeholder = `pi 暂时不可用 ${gate.reason || "无法发消息"}`;
        inputEl.title = gate.reason ?? "";
    }
}

export function setAgentState(state: string): void {
    const busy = state === "working";
    sendBtn.classList.toggle("busy", busy);
    sendBtn.title = busy ? "点击中断" : "发送 (Enter)";
}

/** 工作目录(输入区下方极简栏;完整路径放 title ) */
export function showCwd(p: string | { path?: string; short?: string }): void {
    const path = typeof p === "string" ? p : (p.path ?? "");
    const short = typeof p === "string" ? p : (p.short ?? path);
    footCwd.textContent = shortenPath(path, 40);
    footCwd.title = path;
    // B38:存一份给 bash 终端提示符用
    ui.cwd = path;
    ui.cwdShort = short;
}

/**
 * 应用样式变量(设置变化时由宿主推送)
 * 先清掉所有旧 --pi-* 再写新的:否则用户把某项改回"空"时,残留的旧值会继续生效
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
    // 居中内容列开关 + 默认折叠开关(布尔不能当 CSS 变量用 → 切类 / 存状态)
    root.classList.toggle("centered", !!vars && vars["--pi-centered-mode"] === "on");
    ui.defaultThinkCollapsed = !!vars && vars["--pi-think-collapsed"] === "on";
    ui.defaultToolCollapsed = !!vars && vars["--pi-tool-collapsed"] === "on";
    if (ui.historyMode) {
        // B45:历史面板的默认收起[独立配置](--pi-history-collapsed 默认 on )
        //   为什么独立:主区你可能想全展开 但那个面板消息成百上千条,不收没法看
        const c = !vars || vars["--pi-history-collapsed"] !== "off";
        ui.defaultThinkCollapsed = c;
        ui.defaultToolCollapsed = c;
    }
    ui.noticeAutoOpen = !!vars && vars["--pi-notice-auto-open"] === "on";
    // B41:代码过宽自动缩放(默认开 只有显式 "0" 才关)
    setCodeAutoFit(!vars || vars["--pi-code-autofit"] !== "0");

    // B38:工具气泡的两个滚动开关已删(现在没有内滚动 长内容交给折叠 )

    // B38:toolPeekLines 已删(行级折叠改由 toolFold 管 )
}

/** 绑定输入区交互(入口调用一次 ) */
export function setupInput(): void {
    // 点击发送按钮:工作中 → 中断;空闲 → 发送
    sendBtn.addEventListener("click", () => {
        if (sendBtn.classList.contains("busy")) {
            ui.userAborted = true; // 记住:这次是[我们主动中断]的(用于区分重连"成功"和"被中断")
            vscode.postMessage({ kind: "abort" });
        } else {
            send();
        }
    });

    inputEl.addEventListener("keydown", (e) => {
        // B27:先给斜杠补全一次机会
        //   (它开着时 ↑↓/Enter/Tab/Esc 都归它 )
        if (slashMenuKey(e)) return;
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
        }
    });

    inputEl.addEventListener("input", autoGrow);

    // 在正文区按下鼠标 = 准备选中文字复制,先把输入框的焦点摘掉。
    // 不摘的话 activeElement 还是 textarea,Ctrl+C 复制的是它里面的内容(空的),
    // 正文选区被忽略 —— 表现就是"选了半天复制不出来,焦点还弹回输入框"。
    messagesEl.addEventListener("mousedown", () => {
        if (document.activeElement === inputEl) inputEl.blur();
    });

    /**
     * 正文选区的复制自己接管。
     *
     * 时序是关键(日志实测):
     *   keydown(ctrl+c) → 同一毫秒内 VS Code 的 webview 宿主脚本把焦点还给 textarea
     *   → 焦点一移,正文选区就没了 → 等 copy 事件跑起来时 getSelection() 已经空了
     *   (调用栈: vscode-webview://.../index.html:1289 ← HostMessaging.onmessage)
     *
     * 所以要在 keydown 那一刻就把选区文本拍下来,到 copy 时用快照。
     */
    let pendingCopy = "";
    document.addEventListener(
        "keydown",
        (e) => {
            if (!((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c")) return;
            // 焦点本来就在输入框:那是复制输入框自己的内容,交给浏览器
            if (document.activeElement === inputEl) {
                pendingCopy = "";
                return;
            }
            pendingCopy = document.getSelection()?.toString() ?? "";
            log.info(`[copy] keydown 拍快照 长度=${pendingCopy.length}`);
        },
        true,
    );

    document.addEventListener("copy", (e) => {
        log.info(`[copy] copy 事件 快照=${pendingCopy.length} 当前选区=${document.getSelection()?.toString().length ?? 0}`);
        if (!pendingCopy) return;
        e.clipboardData?.setData("text/plain", pendingCopy);
        e.preventDefault();
        pendingCopy = "";
    });

    // ── 临时诊断（查完就删）──
    const origFocus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (this: HTMLElement, ...args: unknown[]) {
        if (this.id === "input") {
            log.info(`[diag] focus(#input) 调用栈:\n${new Error().stack ?? "?"}`);
        }
        return (origFocus as (...a: unknown[]) => void).apply(this, args);
    };

    document.addEventListener(
        "keydown",
        (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
                const t = e.target as HTMLElement | null;
                const sel = document.getSelection()?.toString() ?? "";
                log.info(
                    `[diag] ctrl+c 到达 target=${t?.tagName ?? "?"}#${t?.id ?? ""} ` +
                        `defaultPrevented=${e.defaultPrevented} 选区=${sel.length}`,
                );
            }
        },
        true,
    );
    document.addEventListener(
        "focusin",
        (e) => {
            const t = e.target as HTMLElement | null;
            log.info(`[diag] 焦点 -> ${t?.tagName ?? "?"}#${t?.id ?? ""}`);
        },
        true,
    );
    window.addEventListener("resize", autoGrow);
    autoGrow();

    // 重启 pi:应用最新启动参数(改了 pi-bridge.launchArgs 后点它 )
    //   为什么需要?启动参数只影响 spawn 时刻 → 必须重启进程才能生效
    btnReload.addEventListener("click", () => {
        vscode.postMessage({ kind: "reloadPi" });
    });

    // 点工作目录显示区 → 改 cwd
    //   (这是[唯一]改 cwd 的入口;改完宿主会重启 pi 并清空对话 )
    footCwd.addEventListener("click", () => {
        vscode.postMessage({ kind: "changeCwd" });
    });
}

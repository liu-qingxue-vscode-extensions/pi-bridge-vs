/**
 * ui-request.ts —— 侧栏的交互【提示条】（B26）
 *
 * 【B26 起它变成了什么？】
 *   完整的问答（选项按钮 / 输入框 / 编辑框 ✓）已经【搬到编辑器面板】✗
 *   侧栏这里只剩【一条提示】+ 两个按钮 ✓：
 *     ⚑ pi 需要回答：<问题标题>   [前往] [取消]
 *
 * 【为什么还要留提示？】（用户定的 ✓）
 *   ① 面板可能被关掉 / 被切到别的 tab → 侧栏还知道"有事在等" ✓
 *   ② [取消] 能随手按掉，不用跳到面板 ✓
 *   ③ [前往] 一步跳过去 ✓
 *
 * 【★ 它自己不存队列】
 *   队列在宿主端（interaction-panel.ts ✓）—— 和聊天状态同理：
 *   webview 只是显示器 ✗ 卸载重建后靠宿主重放恢复 ✓
 *   这里只保存"当前提示"（Esc 取消要用 id ✓）
 */
import { uiRequestEl } from "./dom.js";
import { vscode } from "./vscode-api.js";
import { syncPadding } from "./input.js";

interface Hint {
    active: boolean;
    id?: string;
    title?: string;
}

/** 当前提示（Esc 取消要用 ✓）*/
let hint: Hint = { active: false };

/** ★ 宿主推来的提示（唯一的渲染入口 ✓）*/
export function showInteractionHint(h: Hint): void {
    hint = h;
    uiRequestEl.textContent = "";
    uiRequestEl.dataset.empty = h.active ? "false" : "true";

    if (!h.active) {
        syncPadding();
        return;
    }

    const box = document.createElement("div");
    box.className = "hint-bar";

    const tag = document.createElement("span");
    tag.className = "hint-tag";
    tag.textContent = "⚑ pi 需要回答";

    const title = document.createElement("span");
    title.className = "hint-title";
    title.textContent = h.title || "（无标题）";
    title.title = h.title || ""; // 悬停看全文（行内是截断的 ✓）

    const go = document.createElement("button");
    go.className = "hint-btn";
    go.textContent = "前往";
    go.addEventListener("click", () => vscode.postMessage({ kind: "interactionFocus" }));

    const cancel = document.createElement("button");
    cancel.className = "hint-btn danger";
    cancel.textContent = "取消";
    cancel.addEventListener("click", () => {
        if (hint.id) vscode.postMessage({ kind: "uiResponse", id: hint.id, cancelled: true });
    });

    box.append(tag, title, go, cancel);
    uiRequestEl.appendChild(box);

    // ★ 高度变了 → 消息区留白要重算 ✗（B25 踩过：不重算会盖住最后几条消息 ✓）
    requestAnimationFrame(() => syncPadding());
}

export function setupUiRequest(): void {
    // ★ Esc 取消：现在它只是【快捷键便利】✗（面板里也有取消按钮 ✓ 用户说快捷键以后再说 ✓）
    document.addEventListener("keydown", (e) => {
        if (e.key !== "Escape" || !hint.active || !hint.id) return;
        const t = e.target as HTMLElement | null;
        // 正在输入框/编辑框里打字 → 让给控件自己 ✓
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
        vscode.postMessage({ kind: "uiResponse", id: hint.id, cancelled: true });
    });
}

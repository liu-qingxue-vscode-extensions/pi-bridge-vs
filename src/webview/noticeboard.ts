/**
 * noticeboard.ts —— 通知面板（顶栏下拉 · B8）
 *
 * 【数据来源】extension_ui_request.notify + stderr（★ 都不进会话文件 ✓）
 *   权威数据在插件端（ChatState.notices 环形缓冲）→ 这里只是【镜像】
 *   重开视图时会从 snapshot 恢复 ✓
 *
 * 【交互】三种展开/收起：点击顶栏 ✓ / 按住下拉 ✓ / 快捷键（宿主转发）✓
 *
 * 【和 notices.ts 的区别】
 *   notices.ts     = 消息流里的提示气泡（重连 / 异常）
 *   noticeboard.ts = 顶栏下拉的通知面板 ← 本文件
 */
import { vscode } from "./vscode-api.js";
import {
    topArea,
    noticeToolbar,
    noticePanel,
    noticeList,
    noticeEmpty,
    noticeCount,
    noticeBell,
    noticeCollapse,
    noticeClear,
    noticeSettings,
    statusBarEl,
} from "./dom.js";
import { ui, type UiNotice } from "./state.js";

const NOTICE_ICON: Record<string, string> = {
    info: "ⓘ",
    success: "✓",
    warn: "⚠",
    error: "✖",
};

/** 建一条通知 DOM（图标 + 文本 + ⧉ 复制 + ✕ 关闭） */
function createNoticeItem(n: UiNotice): HTMLElement {
    const el = document.createElement("div");
    el.className = "notice-item";
    el.dataset.level = n.level;
    el.dataset.id = String(n.id);

    const icon = document.createElement("span");
    icon.className = "ni-icon";
    icon.textContent = NOTICE_ICON[n.level] ?? "ⓘ";

    const text = document.createElement("span");
    text.className = "ni-text";
    text.textContent = n.text;
    // ★ 点击本体 → 【留接口】（用户要求：暂不绑行为 ✓）
    text.addEventListener("click", () => {
        /* TODO: 将来的通知点击动作（如跳到出错工具 / 打开设置页）*/
    });

    const copyBtn = document.createElement("button");
    copyBtn.className = "ni-btn";
    copyBtn.textContent = "⧉";
    copyBtn.title = "复制";
    copyBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        // ★ 走 VS Code 剪贴板（navigator.clipboard 在 webview 里被限制 ✗ → 点了没反应）
        try {
            await navigator.clipboard.writeText(n.text);
        } catch {
            vscode.postMessage({ kind: "copyText", text: n.text });
        }
    });

    const closeBtn = document.createElement("button");
    closeBtn.className = "ni-btn";
    closeBtn.textContent = "✕";
    closeBtn.title = "关闭";
    closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        // ★ 发给插件端（唯一一条 前端 → 插件 的通知指令 ✓）
        vscode.postMessage({ kind: "noticeRemove", id: n.id });
    });

    el.append(icon, text, copyBtn, closeBtn);
    return el;
}

/** 刷新头部徽标（未读 / 总数） */
function syncBadge(): void {
    noticeBell.textContent = ui.noticeUnread > 0 ? "🔔" : "🔕";
    noticeCount.textContent = String(ui.notices.length);
    noticeEmpty.style.display = ui.notices.length ? "none" : "";
}

/** 全量重绘（重放快照时用） */
export function renderNotices(): void {
    noticeList.innerHTML = "";
    for (const n of ui.notices) noticeList.appendChild(createNoticeItem(n));
    syncBadge();
}

/** 追加一条（增量 ✓ 避免全量重绘） */
export function appendNotice(n: UiNotice): void {
    ui.notices.push(n);
    noticeList.appendChild(createNoticeItem(n));
    if (!ui.panelExpanded) ui.noticeUnread++;
    syncBadge();
}

/** 从列表移除一条 */
export function removeNotice(id: number): void {
    ui.notices = ui.notices.filter((n) => n.id !== id);
    noticeList.querySelector('.notice-item[data-id="' + id + '"]')?.remove();
    syncBadge();
}

/** 用快照里的通知全量替换（webview 重建时 ✓） */
export function resetNotices(list: UiNotice[]): void {
    ui.notices = Array.isArray(list) ? list.slice() : [];
    ui.noticeUnread = 0;
    renderNotices();
    setExpanded(false); // 重建/重开视图后默认收起 ✓
}

/** 清空本地镜像（插件端已清空时 ✓） */
export function clearNotices(): void {
    ui.notices = [];
    renderNotices();
}

/** 设置展开 / 收起（next 可强制指定） */
export function setExpanded(next?: boolean): void {
    ui.panelExpanded = typeof next === "boolean" ? next : !ui.panelExpanded;
    topArea.classList.toggle("expanded", ui.panelExpanded);
    noticeToolbar.classList.toggle("collapsed", !ui.panelExpanded);
    noticePanel.classList.toggle("collapsed", !ui.panelExpanded);
    if (ui.panelExpanded) {
        ui.noticeUnread = 0; // 展开就视为看过 ✓（★ 不落盘 → 无需记录已读）
        syncBadge();
    }
}

/** 绑定交互（入口调用一次 ✓） */
export function setupNoticeBoard(): void {
    // ① 整栏点击 → 展开/收起 ✓
    statusBarEl.addEventListener("click", () => setExpanded());

    // ① 面板底部热区 → 收起 ✓
    noticeCollapse.addEventListener("click", () => setExpanded(false));

    // 清空全部（本地清不划算 → 直接让插件端清权威数据，再回推 noticesCleared ✓）
    noticeClear.addEventListener("click", (e) => {
        e.stopPropagation();
        vscode.postMessage({ kind: "noticeClearAll" });
    });

    // ⚙ 设置 → 留接口（暂不实现 ✓）
    noticeSettings.addEventListener("click", (e) => {
        e.stopPropagation();
        /* TODO: 打开设置页 */
    });

    // ② 鼠标按住下拉 / 上推 → 跟手拖动 + 阈值吸附 ✓
    setupDragGesture();

    syncBadge();
}

function setupDragGesture(): void {
    let dragStartY = 0;
    let dragging = false;
    const THRESHOLD = 28; // 拖过多少像素就切换状态

    statusBarEl.addEventListener("pointerdown", (e) => {
        // 只在收起时允许"下拉展开"（展开时下拉无用 ✗）
        if (ui.panelExpanded) return;
        dragging = true;
        dragStartY = e.clientY;
        statusBarEl.setPointerCapture(e.pointerId);
    });

    noticeCollapse.addEventListener("pointerdown", (e) => {
        dragging = true;
        dragStartY = e.clientY;
        noticeCollapse.setPointerCapture(e.pointerId);
    });

    statusBarEl.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        if (e.clientY - dragStartY >= THRESHOLD) {
            dragging = false;
            setExpanded(true);
        }
    });

    noticeCollapse.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        if (e.clientY - dragStartY >= THRESHOLD) {
            dragging = false;
            setExpanded(false);
        }
    });

    const stop = (): void => {
        dragging = false;
    };
    statusBarEl.addEventListener("pointerup", stop);
    noticeCollapse.addEventListener("pointerup", stop);
    statusBarEl.addEventListener("pointercancel", stop);
    noticeCollapse.addEventListener("pointercancel", stop);
}

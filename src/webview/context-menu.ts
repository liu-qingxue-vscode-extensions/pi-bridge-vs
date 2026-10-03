/**
 * context-menu.ts —— 通用右键菜单（B21）
 *
 * 【为什么自己画，而不是用 VS Code 的原生菜单？】
 *   · webview 里的原生菜单是【浏览器的】（刷新/检查元素 ✓）与业务无关 ✗
 *   · VS Code 的 QuickPick 是【顶部搜索框】✗ 不是光标处弹出 ✗
 *   · 而我们需要的是：★ 在鼠标位置弹出一个动作列表 ✓
 *   → 自绘最简单，而且样式能跟主题走 ✓
 *
 * 【它是不是又造了一套弹层？】
 *   不是 ✗ —— 它和「点外面收起」那套（会话面板 / 通知面板）是同一个模式 ✓
 *   只是这一次是【光标坐标定位】+【动作列表】✓
 *
 * 【用完的三种关闭方式】
 *   ① 点菜单里任一项 ✓（点完就关 ✓）
 *   ② 点菜单外任意处 ✓（document 上的 click 监听 ✓）
 *   ③ Esc ✓（顺手给键盘用户留条路 ✓）
 */
export interface MenuItem {
    label: string;
    onClick: () => void;
    /** ★ 危险动作（删除 ✓）→ 红色 ✓ */
    danger?: boolean;
}

let menuEl: HTMLElement | null = null;

/** 关掉当前菜单（幂等 ✓） */
export function hideContextMenu(): void {
    menuEl?.remove();
    menuEl = null;
}

/**
 * 在鼠标位置弹出菜单
 *
 * @param ev 触发它的 contextmenu 事件（用它的 clientX / clientY ✓）
 * @param items 菜单项（从上到下 ✓）
 */
export function showContextMenu(ev: MouseEvent, items: MenuItem[]): void {
    ev.preventDefault();
    // ★ 阻止冒泡：否则会触发 document 上的“点外面关闭”✗ 菜单刚显示就被关了 ✓
    ev.stopPropagation();
    hideContextMenu();

    const m = document.createElement("div");
    m.className = "ctx-menu";
    for (const it of items) {
        const b = document.createElement("button");
        b.className = "ctx-item" + (it.danger ? " danger" : "");
        b.textContent = it.label;
        b.addEventListener("click", (e) => {
            e.stopPropagation();
            hideContextMenu();
            it.onClick();
        });
        m.appendChild(b);
    }
    document.body.appendChild(m);

    // ★ 先挂上去量尺寸，再做边界翻转（否则量不到 ✗）
    const r = m.getBoundingClientRect();
    const maxX = window.innerWidth - r.width - 6;
    const maxY = window.innerHeight - r.height - 6;
    m.style.left = Math.max(4, Math.min(ev.clientX, maxX)) + "px";
    m.style.top = Math.max(4, Math.min(ev.clientY, maxY)) + "px";

    menuEl = m;
}

// ── 全局关闭钩子（只注册一次 ✓ 模块加载时执行 ✓）──
document.addEventListener("click", hideContextMenu);
document.addEventListener("contextmenu", hideContextMenu); // 右键别处 = 关掉旧菜单 ✓
window.addEventListener("blur", hideContextMenu);
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideContextMenu();
});

/**
 * session-util.ts —— 会话面板的纯工具（B35 ✓）
 *
 * 【★ 为什么单独一个文件？】
 *   这些都是【纯函数】✗ 不碰 DOM ✗ 不碰 vscode API ✓
 *   ⇒ 可以脱离界面验证 ✗ 也不会被面板生命周期影响 ✓
 *   ★ 从 src/webview/sessions.ts 搬出来的（那边要瘦身 ✓
 *     它现在只该管【顶栏会话名】和【输入区 cwd】两件事 ✓）
 */

/** 宿主推来的会话元数据（与 src/pi/session-store.ts 的 SessionInfo 同构 ✓） */
export interface SessionInfo {
    path: string;
    id: string;
    cwd: string;
    cwdKey: string;
    createdAt: number;
    /** ★ 会话名（~69% 有 ✓ 没有则退回显示短 id ✓）*/
    name?: string;
    /** ★ 异常原因（有值 = 文件坏了 → 标红且禁止切换 ✗）*/
    broken?: string;
    /** ★ 轮次（用户消息数 —— 只有刷新过才有 ✓ 否则显示 "?"）*/
    turns?: number;
    /**
     * ★ 父会话路径（B24 fork 树用 ✓）
     *
     *  来自会话文件首行的 parentSession ✓（clone / fork 会写 ✓）
     *  → 渲染时把子会话【缩进】到父下面 ✓
     */
    parent?: string;
}

/** 时间显示：YY-MM-DD HH:MM（列表里足够 ✓ 两位年省空间 ✓） */
export function fmtTime(ts: number): string {
    if (!ts) return "?";
    const d = new Date(ts);
    const p = (x: number): string => String(x).padStart(2, "0");
    const yy = String(d.getFullYear()).slice(-2);
    return `${yy}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 家目录美化（★ 目前是原样返回 ✗）
 *
 * 【为什么不真美化？】
 *   前端【不知道家目录是什么】✗ 要么问宿主要么猜 ✓
 *   而路径本身不深 ✗ 保持原样可读性也够 ✓
 *   ★ 保留这个函数是为了给以后留个口子（要美化只改这一处 ✓）
 */
export function prettyPath(p: string): string {
    if (!p) return "（未知目录）";
    return p;
}

/**
 * ★ 把一组会话排成【树】✗（B24：fork 渲染 ✓）
 *
 * 【为什么需要它？】（用户要求 ✓）
 *   “绘画面板的渲染，要把 fork 给渲染出来，要简单排一下列，
 *     把分支放到主的下面”✓
 *
 * 【返回什么？】扁平化后的 DFS 顺序 ✓
 *   [{ s, depth }] —— 父后面【紧跟】它的子 ✓ depth 即缩进层级 ✓
 *
 * 【两个边界（实测会遇到 ✓）】
 *   ① parent 指向的会话【不在同一组】（跨 cwd / 已删除 ✓）
 *      → 把它当【根】处理 ✓（否则会整条消失 ✗）
 *   ② 环（A→B→A）—— 理论上不会 ✗（父总是先创建 ✓）
 *      但加载了被改坏的文件就可能 → 用 seen 兜一下 ✓
 */
export function treeify(items: SessionInfo[]): { s: SessionInfo; depth: number }[] {
    const byPath = new Map(items.map((s) => [s.path, s]));
    const kids = new Map<string, SessionInfo[]>();
    const roots: SessionInfo[] = [];

    for (const s of items) {
        if (s.parent && byPath.has(s.parent) && s.parent !== s.path) {
            const arr = kids.get(s.parent) ?? [];
            arr.push(s);
            kids.set(s.parent, arr);
        } else {
            roots.push(s); // ★ 边界 ①：当根 ✓
        }
    }

    const out: { s: SessionInfo; depth: number }[] = [];
    const seen = new Set<string>();
    const walk = (s: SessionInfo, depth: number): void => {
        if (seen.has(s.path)) return; // ★ 边界 ②：环保护 ✓
        seen.add(s.path);
        out.push({ s, depth });
        for (const c of kids.get(s.path) ?? []) walk(c, depth + 1);
    };
    for (const r of roots) walk(r, 0);
    return out;
}

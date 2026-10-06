/**
 * diag.ts —— 布局自检（B32 ✓）
 *
 * 【为什么需要它？】
 *   用户实测报：“AI 气泡直接怼进了容器里面”✗
 *   但 CSS 文本看起来完全正确（cmdrail.css 里明明写了 #messages{left:...} ✓）
 *
 * ★ 这种"代码对、结果错"的情况，只能靠【实测几何值】定位 ✗ 猜不出来 ✓
 *
 * 【它做什么】
 *   启动后量一遍关键元素的实际位置 / 宽度 / 生效的 CSS 变量 ✗
 *   打印到【输出面板】（走 log.info ✗ 用户随手就能看到 ✓）
 *
 * 【★ 只看一眼就能判断断在哪】
 *   · 如果 rail.width 是 0            → 配置把宽度设成 0 了
 *   · 如果 messages.left 是 0         → #messages 的 left 没生效（层叠问题 ✓）
 *   · 如果 railW 变量是空             → style-config 没注入
 *   · 如果 messages.left = rail.width → 那就对了 ✗ 问题在别处 ✓
 */
import { log } from "./vscode-api.js";

const rect = (el: Element | null): string => {
    if (!el) return "（元素不存在 ✗）";
    const r = el.getBoundingClientRect();
    return `left=${Math.round(r.left)} top=${Math.round(r.top)} w=${Math.round(r.width)} h=${Math.round(r.height)}`;
};

/** ★ 量一遍并把结果写进输出面板 ✓ */
export function diagLayout(): void {
    const root = document.documentElement;
    const cs = getComputedStyle(root);
    const get = (v: string): string => (cs.getPropertyValue(v) || "（空 ✗）").trim();

    const body = document.body;
    const messages = document.getElementById("messages");
    const rail = document.getElementById("cmd-rail");
    const inputArea = document.getElementById("input-area");

    const msgCs = messages ? getComputedStyle(messages) : undefined;
    const railCs = rail ? getComputedStyle(rail) : undefined;

    log.debug(
        [
            "──── 布局自检（B32 ✗ 排查用 ✗ 默认看不见 ✓）────",
            `视口        : w=${window.innerWidth} h=${window.innerHeight}`,
            `body        : ${rect(body)}`,
            "",
            "【CSS 变量（实际生效值）】",
            `  --pi-cmd-rail-w      = ${get("--pi-cmd-rail-w")}`,
            `  --pi-left-gap        = ${get("--pi-left-gap")}`,
            `  --pi-center-width    = ${get("--pi-center-width")}`,
            `  --pi-center-pad-x    = ${get("--pi-center-pad-x")}`,
            `  --pi-bubble-width    = ${get("--pi-bubble-width")}`,
            `  --pi-input-reserve   = ${get("--pi-input-reserve")}`,
            `  --pi-centered-mode   = ${get("--pi-centered-mode")}`,
            `  （root 类名: ${root.className || "（无）"}）`,
            "",
            "【元素几何】",
            `  #messages   : ${rect(messages)}`,
            `     computed : left=${msgCs?.left} right=${msgCs?.right} paddingLeft=${msgCs?.paddingLeft} paddingRight=${msgCs?.paddingRight}`,
            `                zIndex=${msgCs?.zIndex} position=${msgCs?.position}`,
            `  #cmd-rail   : ${rect(rail)}`,
            `     computed : left=${railCs?.left} bottom=${railCs?.bottom} zIndex=${railCs?.zIndex} display=${railCs?.display} overflowY=${railCs?.overflowY}`,
            `     scrollH  : ${rail?.scrollHeight} / clientH: ${rail?.clientHeight}`,
            `  #input-area : ${rect(inputArea)}`,
            "",
            "【★ 一眼判断】",
            `  ① rail.width 应与 --pi-cmd-rail-w 一致`,
            `  ② #messages 的 left 应等于 rail 的宽度（= 42 左右）`,
            `     若 messages.left=0 → #messages 的 left 没生效 ✗（层叠/加载问题 ✓）`,
            `     若 messages.left != 0 且气泡仍怼进容器 → 问题在气泡自身的宽度计算 ✓`,
            "【★ 命令条的图片图标（B32 图标排查 ✓）】",
            "naturalWidth=0 就是【加载失败】✗ 不是没渲染 ✓",
            ...imgInfo(),
            "",
            "【样式表加载情况】",
            "（看两件事：① 加载了哪几个表 ② 各表多少条规则）",
            ...styleSheetsInfo(),
            "",
            "【★ 谁挡着命令条？（B32 用户报“下面就是被遮挡的状态”✓）】",
            "用 elementFromPoint 在几个高度各问一次，",
            "答案不是 #cmd-rail / BUTTON 的那个高度就是被挡住了 ✓",
            ...probeRail(rail, inputArea),
            "───────────────────────",
        ].join("\n"),
    );
}

/** ★★ 逐点探测：命令条那几个高度上，最顶层的元素是谁（B32 ✓）
 *
 *  ★ 为什么用这个？
 *    用户反复报“下面被遮挡”✗ 但看 CSS 又没有东西盖它 ✓
 *    ⇒ 不要猜 ✗ 直接问浏览器：“这一点最上面的是谁？”✓
 *    返回的不是命令条 → 那就是真凶 ✗ 而且直接看到它叫什么 ✓ */
function probeRail(rail: Element | null, inputArea: Element | null): string[] {
    if (!rail) return ["  （命令条不存在 ✗）"];
    const r = rail.getBoundingClientRect();
    const ir = inputArea?.getBoundingClientRect();
    const out: string[] = [];
    out.push(`  命令条范围：y ${Math.round(r.top)} → ${Math.round(r.bottom)}`);
    if (ir) out.push(`  输入区范围：y ${Math.round(ir.top)} → ${Math.round(ir.bottom)}`);

    const x = Math.max(2, Math.round(r.left + r.width / 2));
    const samples: Array<[string, number]> = [
        ["顶部", r.top + 12],
        ["中部", r.top + r.height / 2],
        ["下部", r.bottom - 60],
        ["底部", r.bottom - 6],
    ];
    for (const [name, y] of samples) {
        const el = document.elementFromPoint(x, y);
        let desc = "（无 ✗）";
        if (el) {
            const id = el.id ? `#${el.id}` : "";
            const cls = typeof el.className === "string" && el.className
                ? `.${el.className.split(" ").filter(Boolean).join(".")}`
                : "";
            desc = `${el.tagName.toLowerCase()}${id}${cls}`;
        }
        const mine = !!el && (rail.contains(el) || el === rail);
        out.push(`  y=${Math.round(y).toString().padStart(4)} → ${mine ? "✓" : "✗"} ${desc}`);
    }
    out.push("  （✗ 的行就是遮挡者 ✓）");
    return out;
}

/** ★★ 列出命令条里的 <img>（B32 图标排查 ✓）*/
function imgInfo(): string[] {
    const out: string[] = [];
    const imgs = [...document.querySelectorAll<HTMLImageElement>("#cmd-rail-list img")];
    if (!imgs.length) {
        out.push("  （没有 <img> ✗ 说明按钮没走到“图片”那个分支 ✓）");
        return out;
    }
    for (const im of imgs) {
        out.push(`  src = ${im.src.slice(0, 130)}`);
        out.push(
            `      complete=${im.complete} natural=${im.naturalWidth}x${im.naturalHeight}` +
                (im.naturalWidth === 0 ? "   ← ★ 加载失败 ✓" : "   ← ✓ 正常"),
        );
    }
    return out;
}

/** ★ 列出所有已加载的样式表（B32 ✓）
 *
 *  ★ 为什么需要？
 *    B27 踩过的坑：webview 是【真浏览器】✗ 会缓存 CSS ✓
 *    主文件靠 `?v=mtime` 绕过了 ✗
 *    但它 @import 的【子文件】URL 写在 CSS 里 ✗ 带不上版本号 → 可能是旧的 ✓
 *    ⇒ 表现就像“改了一半”✗ 列出这个才能一眼看穿 ✓ */
function styleSheetsInfo(): string[] {
    const out: string[] = [];
    for (let i = 0; i < document.styleSheets.length; i++) {
        const s = document.styleSheets[i] as CSSStyleSheet;
        let count = "？";
        try {
            count = String(s.cssRules.length);
        } catch {
            count = "✗读取失败";
        }
        const href = s.href
            ? s.href.replace(/^.*\/media\//, "media/").replace(/\?.*$/, "")
            : "<inline>";
        out.push(`  [${i}] ${href} → ${count} 条规则`);
    }
    if (!out.length) out.push("  （一个样式表都没加载 ✗ 这本身就是问题 ✓）");
    return out;
}

/** ★ 延迟一帧跑（等布局稳定 ✗ 否则量到的是初始值 ✓）*/
export function diagLayoutSoon(): void {
    requestAnimationFrame(() => requestAnimationFrame(diagLayout));
}

/**
 * style-config —— 把 VS Code 设置读成 CSS 变量映射，注入到 webview
 *
 * 【设计约定（重要）】
 * 1. 数值/尺寸类 → 直接映射为 CSS 变量 ✓
 * 2. 颜色/文本类 → **留空则不注入**，让 CSS 回退到默认值或 --vscode-* 主题变量
 *    （这样默认永远跟随主题；用户填了才覆盖 → 不会和主题"打架"）
 *
 * 【术语（与用户对齐）】
 *   气泡 bubble = 一个可见的圆角矩形（用户消息 / 思考 / 正文 / 工具各是一个气泡）
 *   工具气泡内部有两部分：上半=调用，下半=结果（合起来视觉上是【一个】气泡）
 */
import * as vscode from "vscode";

/** 读取设置 → CSS 变量映射（只包含需要覆盖的项） */
export function readStyleVars(): Record<string, string> {
    const cfg = vscode.workspace.getConfiguration("pi-bridge.style");
    const vars: Record<string, string> = {};

    /** 数值类：追加单位 */
    const num = (key: string, cssVar: string, unit = "px"): void => {
        const v = cfg.get<number>(key);
        if (typeof v === "number" && Number.isFinite(v)) {
            vars[cssVar] = `${v}${unit}`;
        }
    };

    /** 原样字符串（如 padding 的 "8px 12px"）：非空才注入 */
    const raw = (key: string, cssVar: string): void => {
        const v = cfg.get<string>(key);
        if (typeof v === "string" && v.trim() !== "") vars[cssVar] = v.trim();
    };

    // 外观
    num("bubbleWidth", "--pi-bubble-width", "%");
    num("bubbleRadius", "--pi-bubble-radius");
    raw("bubblePadding", "--pi-bubble-padding");
    num("leftGap", "--pi-left-gap", "%"); // ★★ AI 气泡的【左边距】（B32 ✓）
    //   ★ 只有左边 ✗ AI 气泡是左对齐的 ✗ 右边距对它没意义 ✓
    //   ★★ 只在 centerColumn 关闭时生效 ✓
    //   ★ 单位必须是 % ✗ 固定 px 在侧栏变宽时比例会乱 ✓
    //
    // ★★ 用户气泡的【右边距】（B32 ✗ 用户抓到的缺口 ✓）
    //   用户原话：“用户气泡的宽度是动态宽度 ✗ 但右对齐的右边距呢？”
    //   ⇒ 确实缺 ✗ 没有它就没法知道用户气泡离右边多远 ✓
    num("rightGap", "--pi-right-gap", "%");
    num("userMinWidth", "--pi-user-min-width", "%"); // 用户气泡的最小宽度（百分比 ✓）
    num("userMaxWidth", "--pi-user-max-width", "%"); // ★ 用户气泡的最大宽度（超过就换行 ✓）
    // ★ 设置面板的字号（B24）—— 面板里所有文字都跟着它缩放 ✓
    num("settingsPanelPadX", "--pi-settings-pad-x", "px");
    num("settingsFontSize", "--pi-settings-font", "px");
    // ★ 技能面板的字号（B25）

    // 居中内容列开关：布尔不能直接当 CSS 变量用 → 传一个特殊值，webview 收到后切换 CSS 类
    // ★★ B32 重构（用户指出的多余 ✓）：
    //   删掉了 centerWidth / centerPadX ✗
    //   · 宽度：一个 bubbleWidth 就够 ✗ 两种模式共用 ✓
    //   · 边距：居中时的左右边距是 (100% − 宽度)/2 【自动算】的 ✓
    //     根本不需要人配 ✗ 想窄一点就直接调小宽度 ✓
    vars["--pi-centered-mode"] = cfg.get<boolean>("centerColumn", false) ? "on" : "off";

    // ★ 通知自动下拉：通知到达时自动展开面板（默认关 ✓）
    vars["--pi-notice-auto-open"] = cfg.get<boolean>("noticeAutoOpen", false) ? "on" : "off";

    // ★★ B38：toolPeekLines 已删（收起显示多少改由 toolFold 管 ✓）

    // ★ 限高值也可以配（不想被写死在 CSS 里 ✓）

    // 默认折叠开关（同样用特殊值传，webview 自己处理）
    vars["--pi-think-collapsed"] = cfg.get<boolean>("thinkCollapsed", false) ? "on" : "off";
    vars["--pi-tool-collapsed"] = cfg.get<boolean>("toolCollapsed", false) ? "on" : "off";
    // ★★ B45：完整历史面板的默认收起（它跟主聊天页不同 ⇒ 独立一个开关 ✓）
    vars["--pi-history-collapsed"] = cfg.get<boolean>("historyCollapsed", true) ? "on" : "off";

    // ★★ B45：已压缩区段的颜色（留空 ⇒ 用 CSS 里的内置默认值 ✓）
    const compactedBg = cfg.get<string>("compactedBg", "").trim();
    if (compactedBg) vars["--pi-compacted-bg"] = compactedBg;
    const compactedSplitBg = cfg.get<string>("compactedSplitBg", "").trim();
    if (compactedSplitBg) vars["--pi-compacted-split-bg"] = compactedSplitBg;

    // ★★ B38：resultLabel 已删（结果区那个头没了 ✓）

    // ★★ 自由按钮容器（B32 ✓）—— 气泡区左侧那根竖排快捷命令条
    //
    // 【★★ 一处定义、三处消费】
    //   --pi-cmd-rail-w 这一个值同时被：
    //     ① #cmd-rail 的 width      （竖条本身多宽 ✓）
    //     ② #messages 的 left        （气泡区左边让出多少 ✓）
    //     ③ #input-area 的 left      （输入区左边让出多少 ✓）
    //   为什么必须同一个变量？
    //     分开写迟早会忘掉一处 → 三者对不齐 ✗ 看起来像 bug ✓
    num("cmdRailWidth", "--pi-cmd-rail-w");
    num("cmdRailBtnSize", "--pi-cmd-btn-size");
    num("cmdRailGap", "--pi-cmd-gap");
    // ★ 显示开关：用 CSS 变量直接传 display ✓
    //   ★★ 为什么不跟 centered 一样让 webview 切类？
    //     切类需要 JS 配合（多一处耦合 ✓）
    //     而 display 本来就是 CSS 变量能表达的值 ✗ 直传最干净 ✓✓✓
    //   ★ 同时把宽度归零（否则容器没了但气泡区还留着空位 ✓）
    const railShow = cfg.get<boolean>("cmdRailShow", true);
    vars["--pi-cmd-rail-display"] = railShow ? "flex" : "none";
    if (!railShow) vars["--pi-cmd-rail-w"] = "0px";

    // 输入框（行数类传空单位：只是数字，由 JS 读取后自己算像素）
    num("inputRadius", "--pi-input-radius");
    num("inputWidth", "--pi-input-width", "%");
    num("inputMinRows", "--pi-input-min-rows", "");
    num("inputMaxRows", "--pi-input-max-rows", "");
    num("inputBottomGap", "--pi-input-bottom-gap");

    // 顶栏（topbar）
    num("topBarHeight", "--pi-topbar-height");

    // ★ 按钮行（顶栏下方那一行）：高度可配 → 里面的方块按钮【等比】跟着变 ✓
    num("appToolbarHeight", "--pi-app-toolbar-height");

    // ★ 会话名展示区宽度（固定 ✓ 名字长时自动缩字号 ✓）
    num("sessionTitleWidth", "--pi-session-title-width");

    // ★ 工具气泡的两个滚动开关（用户要求 ✓）
    //   关掉 → 全部展开（屏幕大时舒服 ✓）

    // ★★ B35：会话面板的高度 / 底色【已删】✗
    //   面板搬到编辑器区了 ✗ 它是一整页 ✓ 没有“高度占比”这回事 ✓
    //   （对应配置项也一并从 package.json 删了 ✓ 否则守门员报断点 ② ✓）

    // 通知面板（B8）—— 展开后的最大高度
    // ★ 单位用 vh 而不是 %：面板的父元素高度由内容决定，百分数会解析失败 ✗
    //   （webview 里的 vh = 视图自身高度 ✓ 正是我们要的“占视图多少”）
    num("noticePanelHeight", "--pi-notice-panel-height", "vh");
    num("noticeFontSize", "--pi-notice-font-size");
    raw("noticeItemPadding", "--pi-notice-item-padding");

    // 间距
    num("gapTurn", "--pi-gap-turn");
    num("gapUserFirst", "--pi-gap-user-first");
    num("gapThinkingToText", "--pi-gap-thinking-text");
    num("gapThinkingToTool", "--pi-gap-thinking-tool");
    num("gapTextToTool", "--pi-gap-text-tool");
    num("gapToolToText", "--pi-gap-tool-text");
    num("gapToolToThinking", "--pi-gap-tool-thinking");
    num("gapTextToThinking", "--pi-gap-text-thinking");

    // 左侧竖线
    num("railWidth", "--pi-rail-width");
    raw("railColorThinking", "--pi-rail-color-thinking");
    raw("railColorTool", "--pi-rail-color-tool");

    // 边框
    raw("borderBubble", "--pi-border-bubble");
    raw("borderUser", "--pi-border-user");
    raw("borderTool", "--pi-border-tool");

    // 背景色
    raw("bgUser", "--pi-bg-user");
    raw("bgThinking", "--pi-bg-thinking");
    raw("bgText", "--pi-bg-text");
    // ★★ B38：bash 工具块的【终端底色】（默认纯黑 ✗ 清空则跟随主题 ✓）
    raw("bashBg", "--pi-bash-bg");
    // ★★ B38：工具折叠规则（一行字符串 → 前端自己解析）
    //   为什么用一个字符串而不是数组？→ CSS 变量只能装字符串，数组要转义，难写难调
    // ★★ B38：数组（VS Code 设置里是"添加项"UI ✓）→ 用 ; 拼成 CSS 变量
    const fold = cfg.get<string[]>("toolFold", []);
    if (Array.isArray(fold) && fold.length) // ★★ 分隔符必须用【逗号】✗ 分号在 CSS 里是声明结束符 ✗ 变量值会被截断
    vars["--pi-tool-fold"] = fold.join(",");
    // ★★ B41：代码过宽自动缩放（1/0 ✗ 前端读它决定要不要量宽度）
    vars["--pi-code-autofit"] = cfg.get<boolean>("codeAutoFit", true) ? "1" : "0";
    return vars;
}

/**
 * ★★ 哪些「开关变量」需要变成 <html> 上的类名（B32 修 ✗）
 *
 * 【发现的 bug】
 *   用户实测：“居中模式下居中居的不正确 ✗ 竟然没统一宽度”✓
 *   诊断输出：root 类名 = （无）✗ 但 --pi-centered-mode = on ✓
 *
 * 【原因】
 *   CSS 变量：【HTML 静态注入】✓（<style>{{styleVars}}</style>）
 *   类名    ：只有 applyStyleVars（JS）会切 ✗
 *               而它在【首次加载时根本不会被调用】✗
 *               （只有宿主推 styleVars 消息时才调 ✗ 而 main.ts 从不推 ✓）
 *   ⇒ 所有开关类在首屏【全部失效】✗ 只有手动改一次设置才生效 ✓
 *
 * 【修法】
 *   把“变量 → 类名”抽成纯函数 ✗ 两边共用：
 *     · html-loader 在服务端给 <html> 直接写上类（首屏就对 ✓ 不闪 ✓）
 *     · webview 的 applyStyleVars 照旧用（设置变了时热更新 ✓）
 */
export function classNamesFromVars(vars: Record<string, string>): string[] {
    const out: string[] = [];
    const has = (k: string, v: string): boolean => vars[k] === v;

    if (has("--pi-centered-mode", "on")) out.push("centered");
    // ★★ B38：no-arg-scroll / no-result-scroll 已删（没有内滚动了）
    return out;
}

/** 把变量映射拼成一段 CSS（注入到 <style> 里） */
export function styleVarsToCss(vars: Record<string, string>): string {
    const body = Object.entries(vars)
        .map(([k, v]) => `    ${k}: ${v};`)
        .join("\n");
    return body ? `  :root {\n${body}\n  }` : "";
}

/** 监听设置变化（返回取消订阅函数） */
export function onStyleChange(handler: () => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("pi-bridge.style")) {
            handler();
        }
    });
}

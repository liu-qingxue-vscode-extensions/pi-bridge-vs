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
    num("sideGap", "--pi-side-gap"); // 气泡与视图左右边界的间距
    num("userMinWidth", "--pi-user-min-width", "%"); // 用户气泡的最小宽度（百分比 ✓）
    num("userMaxWidth", "--pi-user-max-width", "%"); // ★ 用户气泡的最大宽度（超过就换行 ✓）
    // ★ 设置面板的字号（B24）—— 面板里所有文字都跟着它缩放 ✓
    num("settingsPanelPadX", "--pi-settings-pad-x", "px");
    num("settingsFontSize", "--pi-settings-font", "px");
    // ★ 技能面板的字号（B25）

    // 居中内容列开关：布尔不能直接当 CSS 变量用 → 传一个特殊值，webview 收到后切换 CSS 类
    vars["--pi-centered-mode"] = cfg.get<boolean>("centerColumn", false) ? "on" : "off";

    // ★ 通知自动下拉：通知到达时自动展开面板（默认关 ✓）
    vars["--pi-notice-auto-open"] = cfg.get<boolean>("noticeAutoOpen", false) ? "on" : "off";

    // ★ 工具结果“洏几行”：格式 "头:尾"（如 "3:2"）
    //   空 / 根头是 0 → 不启用（收起时靠 CSS line-clamp 全部折成一行 ✓）
    const peek = cfg.get<string>("toolPeekLines", "");
    if (typeof peek === "string" && peek.trim() !== "") {
        vars["--pi-tool-peek-lines"] = peek.trim();
    }

    // ★ 限高值也可以配（不想被写死在 CSS 里 ✓）
    num("toolArgMaxHeight", "--pi-tool-arg-max");
    num("toolResultMaxHeight", "--pi-tool-result-max");

    // 默认折叠开关（同样用特殊值传，webview 自己处理）
    vars["--pi-think-collapsed"] = cfg.get<boolean>("thinkCollapsed", false) ? "on" : "off";
    vars["--pi-tool-collapsed"] = cfg.get<boolean>("toolCollapsed", false) ? "on" : "off";

    // 结果区标题文字（留空则不显示）
    const resultLabel = cfg.get<string>("resultLabel");
    if (typeof resultLabel === "string" && resultLabel.trim() !== "") {
        vars["--pi-result-label"] = `"${resultLabel.trim()}"`; // CSS content 需要引号
    } else if (resultLabel === "") {
        vars["--pi-result-label"] = '""'; // 显式置空
    }

    // 输入框（行数类传空单位：只是数字，由 JS 读取后自己算像素）
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
    vars["--pi-tool-arg-scroll"] = cfg.get<boolean>("toolArgsScroll", true) ? "on" : "off";
    vars["--pi-tool-result-scroll"] = cfg.get<boolean>("toolResultScroll", true) ? "on" : "off";

    // ★ 会话面板（B15）
    num("sessionPanelHeight", "--pi-session-panel-height", "vh");
    raw("sessionPanelBg", "--pi-session-panel-bg");

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
    raw("railColorResult", "--pi-rail-color-result");

    // 边框
    raw("borderBubble", "--pi-border-bubble");
    raw("borderUser", "--pi-border-user");
    raw("borderTool", "--pi-border-tool");

    // 背景色
    raw("bgUser", "--pi-bg-user");
    raw("bgThinking", "--pi-bg-thinking");
    raw("bgText", "--pi-bg-text");
    raw("bgToolCall", "--pi-bg-tool-call");
    raw("bgToolResult", "--pi-bg-tool-result");

    return vars;
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

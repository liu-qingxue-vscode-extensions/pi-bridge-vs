/**
 * tool-fold.ts —— 工具块的折叠（B38）
 *
 * ★ 约定：渲染器把内容切成若干【折叠单元】（每个带 .fold-unit）
 *   折叠器只按数量裁 ✗ 不知道单元里是什么 ✓
 *   上层不碰语义，下层自己决定颗粒度 —— 这是整套折叠体系的接口
 *
 * ★ 顶栏那行是【唯一】的折叠按钮 ✗ 内容区里没有折叠控件
 */
import { log } from "./vscode-api.js";

/** 已经警告过的坏规则（防刷屏）*/
const badRules = new Set<string>();

/** 规则表：工具名 → [头行数, 尾行数] | "all" */
let rules: Record<string, [number, number] | "all"> = {};

/** 解析 "bash:1:0,read:3:2,*:2:1"（宿主推 styleVars 时调）*/
export function setFoldRules(s: string): void {
    rules = {};
    for (const part of s.split(",")) {
        const t = part.trim();
        if (!t) continue;
        const m = /^([^:]+):\s*(all|(\d+)\s*:\s*(\d+))$/i.exec(t);
        if (!m) {
            // ★ 只警告一次（重放会反复调 ✗ 否则刷屏）
            if (!badRules.has(t)) {
                badRules.add(t);
                log.warn(`折叠规则看不懂，已跳过：${t}`);
            }
            continue;
        }
        const name = m[1].trim().toLowerCase();
        rules[name] = m[2].toLowerCase() === "all" ? "all" : [Number(m[3]), Number(m[4])];
    }
    log.info(`折叠规则：${JSON.stringify(rules)}`);
}

/** 取某工具的规则（渲染器也要用 ✗ 所以导出）*/
export function foldRuleFor(tool: string): [number, number] | "all" | null {
    return rules[tool.toLowerCase()] ?? rules["*"] ?? null;
}

/**
 * 折叠计划：固定单元（命令行 / 参数区，算 1 个）先占名额，剩下的给文本行
 * 返回：固定单元显不显示 + 文本行留头几行/尾几行
 */
export function planFold(
    tool: string,
    lineCount: number,
    collapsed: boolean,
    /** ★ 该工具【有没有】一个固定单元占掉头 1 行（bash 的命令行 ✓ 其余没有 ✗）*/
    hasFixed = false,
): { lineHead: number; lineTail: number; hidden: number } {
    const rule = foldRuleFor(tool);
    if (!collapsed || rule === "all") {
        return { lineHead: lineCount, lineTail: 0, hidden: 0 };
    }
    // 没配规则 → 全折
    if (!rule) return { lineHead: 0, lineTail: 0, hidden: lineCount };

    const [head, tail] = rule;
    // ★ 固定单元（命令行）先占掉头 1 行 ✗ 否则规则里的"头 N 行"就该全是内容行
    const lineHead = hasFixed ? Math.max(0, head - 1) : head;
    const lineTail = Math.min(tail, lineCount);
    const hidden = Math.max(0, lineCount - lineHead - lineTail);
    return { lineHead, lineTail, hidden };
}

/** 块级折叠（通用工具用）：按规则裁 .fold-unit */
export function applyFold(container: HTMLElement, tool: string, collapsed: boolean): void {
    // ★★ B43：diff 的折叠粒度 = 【一个 hunk = 一处改动】
    //   【为什么要特判】原来统一按 .fold-unit 数 ✗ 而 diff 里
    //     · 路径行（renderPathLine）也是 .fold-unit
    //     · 每个 hunk 也是 .fold-unit
    //   ⇒ units 变成 [路径行, hunk1, hunk2…] ⇒ 规则里的"头 N"数的根本不是 hunk ✗
    //     （表现为：edit:1:0 显示的是路径行 ✗ 数字一大才"像是全展开"✓）
    //   ★ 用户的设计（明确）：一个 hunk（连续旧 + 连续新）= 一个单元 ✓
    //     按【行数】截断反而糟 ✗ 会把一处改动切一半（看起来像"只改了这一行"✗ 误导 ✓）
    //   ★ 而 diff 的单元是【改动块】（.fold-change ✗ 一组 - 行 + 一组 + 行 ✓）
    //     不是 patch 的 hunk（hunk 是算法的分组 ✗ 几处改动可能挤在一个 hunk 里 ✓）
    //   ★ 而 diff 的单元是【"一段上下文 + 一处改动"】(.fold-seg ✓)
    //     不是光秃秃的增删行 ✗ 也不是 patch 的 hunk ✓
    const segs = [...container.querySelectorAll<HTMLElement>(".fold-seg")];
    const units = segs.length ? segs : [...container.querySelectorAll<HTMLElement>(".fold-unit")];
    // ★ B43 诊断：diff 折叠出问题时把它调成 debug（tool / 单元数 / 规则一次看全）
    log.debug(
        `[fold] tool=${tool} collapsed=${collapsed} segs=${segs.length} units=${units.length} ` +
            `rules=${JSON.stringify(rules)}`,
    );
    if (!units.length) return;

    // 清掉上一次的"已折叠"提示
    container.querySelectorAll(".fold-more").forEach((e) => e.remove());

    const rule = rules[tool.toLowerCase()] ?? rules["*"];

    // 展开 ✗ 或规则 = all → 全显示
    if (!collapsed || rule === "all") {
        for (const u of units) u.classList.remove("fold-hidden");
        return;
    }

    // 没配规则 → 全折（只看顶栏）
    if (!rule) {
        for (const u of units) u.classList.add("fold-hidden");
        return;
    }

    const [head, tail] = rule;
    let hidden = 0;
    units.forEach((u, i) => {
        const show = i < head || i >= units.length - tail;
        u.classList.toggle("fold-hidden", !show);
        if (!show) hidden++;
    });

    if (hidden > 0) {
        const more = document.createElement("div");
        more.className = "fold-more";
        more.textContent = segs.length
            ? `…（已折叠 ${hidden} 处改动 · 点顶栏展开）`
            : `…（已折叠 ${hidden} 项 · 点顶栏展开）`;
        units[head]?.before(more);
    }
}

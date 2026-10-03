/**
 * topbar.ts —— 顶栏：统计栏（花费 · out · cache · 电池）
 *
 * 【数据源】message_end.message 的 usage / model（每轮对话结束更新一次 ✓）
 * 【电池语义】显示【剩余】上下文比例（reverse：越用越少 ✓）
 *   分母来自 models.json 的 contextWindow（宿主推送的 modelLimits）
 *   ★ 拿不到分母 → 整个电池区显示 "?"（不显示绝对 token ✗）
 */
import {
    sbCost,
    sbOut,
    sbCache,
    sbBattery,
    sbBatteryFill,
    sbBatteryPct,
    statusBarEl,
    footModel,
} from "./dom.js";
import { ui } from "./state.js";
import { fmtCost, fmtNum } from "./format.js";

interface UsageLike {
    input?: number;
    output?: number;
    cacheRead?: number;
    totalTokens?: number;
    cost?: { total?: number };
}

/** 刷新顶栏（四列，视觉左→右：花费 · 输出 token · 缓存命中率 · 电池） */
export function updateStatusBar(usage?: UsageLike, model?: string): void {
    const u = usage || {};

    // ★ 输入区下方的模型名【不再在这里改】✗（B23 改成单一来源 ✓）
    //
    // 【为什么移除？】两个地方都写它 → 互相覆盖 ✗ 实测踩到：
    //   · setModelInfo()  → 带供应商（gpt-5.6-luna (openai) ✓）
    //   · 这里（message_end 时）→ 只有 id ✗ 且可能是【旧模型】✗
    //   结果：供应商被抹掉 ✗ 切模型后显示不更新 ✗
    // ★ 现在：模型名只由 model-picker.ts 的 setModelInfo() 负责 ✓
    //   数据源 = 探针 / 事件（都是 get_state 的权威值 ✓）
    void model;

    // 花费
    sbCost.textContent = "¥ " + fmtCost(u.cost && u.cost.total);

    // 输出 token
    sbOut.textContent = "out " + fmtNum(u.output);

    // 缓存命中率 = cacheRead / (input + cacheRead)
    const inp = Number(u.input) || 0;
    const cr = Number(u.cacheRead) || 0;
    const hit = inp + cr > 0 ? Math.round((cr / (inp + cr)) * 100) : 0;
    sbCache.textContent = "cache " + hit + "%";

    // 电池 = 【剩余】上下文比例
    const total = Number(u.totalTokens) || 0;
    const limit = model ? ui.modelLimits[model] : undefined;
    if (typeof limit === "number" && limit > 0) {
        const usedPct = Math.max(0, Math.min(100, Math.round((total / limit) * 100)));
        const remain = 100 - usedPct; // ★ 显示剩余 ✓
        statusBarEl.classList.remove("no-limit");
        sbBatteryFill.style.width = remain + "%"; // ★ 填充 = 剩余 ✓
        sbBatteryPct.textContent = String(remain); // 数字在电池【内部】✓
        sbBattery.classList.toggle("low", remain <= 25);
        sbBattery.classList.toggle("empty", remain <= 5);
    } else {
        // 拿不到分母 → 整个电池区变成一个问号 ✓
        statusBarEl.classList.add("no-limit");
        sbBatteryPct.textContent = "?";
    }
}

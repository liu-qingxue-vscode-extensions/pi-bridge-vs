/**
 * inserting.ts —— 「待插话」条（B20）
 *
 * 【为什么挂在输入框上方，而不是消息流里？】（用户实测报的问题 ✓）
 *
 *   第一版把它 appendChild 到 #messages ✗ → 结果：
 *     · 工具调用时插话 → 出现在【工具气泡之后】✗
 *     · 思考时插话     → 出现在【思考和正文之间】✗
 *     · 正文时插话     → 出现在【正文之后】✗
 *   ★ 它是【临时状态】✗ 不是一条历史消息 ✓ 不该进消息流 ✓
 *
 *   用户定的方案（原话 ✓）：
 *     "你把它放到跟那个输入框一个层级，挂在上面，不要跟着它走 ✓
 *      然后等合适的时机才正确插话，并且正确插话，然后把这个 UI 给一删 ✓"
 *   → 挂在 #queue-bar（输入框正上方 ✓ 独立层级 ✓）
 *
 * 【怎么知道什么时候删？】
 *   steer 被真正投递时 pi 会再发一次 queue_update（steering 变空 ✓）
 *   → 那时移除本条 ✓ 紧接着正常用户气泡会出现（走正常对话流程 ✓）
 */
import { queueBarEl } from "./dom.js";

/** 当前排队中的「待插话」条 */
const pending: { id: number; text: string; el: HTMLElement }[] = [];
let seq = 0;

/** 显示一条待插话（半透明小条 + 「待插话」标 ✓） */
export function showInserting(text: string): void {
    if (!text || !queueBarEl) return;
    const el = document.createElement("div");
    el.className = "queue-item";
    const txt = document.createElement("span");
    txt.className = "queue-text";
    txt.textContent = text;
    const mark = document.createElement("span");
    mark.className = "queue-mark";
    mark.textContent = "待插话";
    el.appendChild(txt);
    el.appendChild(mark);
    queueBarEl.appendChild(el);
    queueBarEl.dataset.empty = "false";
    pending.push({ id: ++seq, text, el });
}

/**
 * ★ 用 steering 数组重建待插话列表（pi 是权威 ✓）
 *
 * 为什么按【计数】而不是"在不在"？
 *   · 同一文本可能排队两次 ✓（用户连发两句一样的 ✓）
 *   · 也可能在别处（TUI）排队 ✓ → 一起显示 ✓
 *   · steering 是 FIFO ✓ → 顺便用它重排顺序 ✓
 */
export function setQueueing(steering: string[]): void {
    const quota = new Map<string, number>();
    for (const t of steering) quota.set(t, (quota.get(t) ?? 0) + 1);

    const remain: typeof pending = [];
    for (const p of pending) {
        const n = quota.get(p.text) ?? 0;
        if (n > 0) {
            quota.set(p.text, n - 1);
            remain.push(p);
        } else {
            p.el.remove(); // ★ 已被投递 → 删掉这条 UI ✓
        }
    }
    pending.length = 0;
    pending.push(...remain);
    if (queueBarEl) queueBarEl.dataset.empty = pending.length ? "false" : "true";
}

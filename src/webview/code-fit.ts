/**
 * ★ B41：代码块过宽时【自动缩小字号】
 *
 * 【为什么只给 .code-block 用】
 *   三类内容的形态不同，处理方式就该不同：
 *
 *     bash 输出   .part-text  white-space: pre-wrap  → 折行（内容是"流水" ✗ 折了不损失结构）
 *     diff 行     .diff-lc    white-space: pre-wrap  → 折行（同上）
 *     read/write  .code-block white-space: pre       → ★ 这里不能折行
 *
 *   ★ 为什么代码不能折行：折行会把 `if (a && b) {` 拆成两行 ⇒ 看起来像两条语句
 *     （缩进层级、括号配对全乱 ✗ 代码的"结构"被破坏）
 *   ⇒ 所以这一类的溢出用【缩放】处理，而不是折行 ✓
 *   ★ 好在 .code-block 这个 class 【只有 read/write 和 markdown 代码块】在用 ✗
 *     ⇒ "只对它缩放"天然就等于"只对这类内容缩放"，不会误伤 bash/diff ✓
 *
 * 【为什么设下限】缩到看不清还不如让用户横向滚（终端里横向滚是常态 ✓）
 */

const MIN_SCALE = 0.75;

/**
 * ★★ B47：批量模式 —— 大量气泡正在被一次性渲染
 *
 * 【为什么需要】正常交互时"折叠一下 ⇒ 重算这个块的宽度"是对的 ✓
 *   但在【全量重放】时（聊天页切会话 / 完整历史面板 ✓）：
 *     每个工具块填充完都会 refold ⇒ 每个都跑一次强制布局 ✗
 *     N 个块 = N 次 ✗（主区切会话卡的原因之一 ✓）
 *   ⇒ 批量期间【只记账 ✗ 不算】末尾统一算一次 ✓
 */
let batchMode = false;

export function beginCodeFitBatch(): void {
    batchMode = true;
}

export function endCodeFitBatch(root: ParentNode): void {
    batchMode = false;
    fitCodeBlocks(root); // ★ 统一算一次 ✓
}

/** 是否启用（由配置 pi-bridge.style.codeAutoFit 控制 ✗ 默认开）*/
let enabled = true;

export function setCodeAutoFit(on: boolean): void {
    enabled = on;
}

/**
 * 给一棵子树里所有可能过宽的代码块重新定字号
 * ★ 幂等：先复位再测量（否则上次的缩放会影响这次的测量 ⇒ 越缩越小）
 *
 * ★★ B47 性能修正：改成【批量读 / 批量写】，中间只强制一次布局
 *
 * 【原来为什么慢】（用户报的："渲染之前要卡很久"✓）
 *   每个代码块里都做了一次 `void pre.offsetWidth` ✗
 *     —— 那是【强制同步布局】：浏览器必须把刚才的样式改动全部算完 ✓
 *   再读 clientWidth / scrollWidth ⇒ 又一次 ✓
 *   ⇒ 一趟循环 = 2 次强制布局 ✗ N 个代码块 = 2N 次 ✓
 *     而"完整历史"面板动辄上百个代码块（消息全体重放 ✓）
 *     ⇒ 就是它把渲染拖住的 ✓
 *
 * 【现在】① 先全部复位（纯写）② 强制一次布局 ③ 全部测量（纯读）
 *         ④ 统一写回（纯写）⇒ 强制布局【总共 1 次】✓
 *   ★ 这是浏览器渲染性能的基本功：读写分离，别交替 ✓
 */
export function fitCodeBlocks(root: ParentNode): void {
    if (!enabled) return;
    // ★ 批量期间跳过（末尾 endCodeFitBatch 会统一算一次 ✓）
    if (batchMode) return;
    const blocks = [...root.querySelectorAll<HTMLElement>(".code-block")];
    if (!blocks.length) return;

    // ① 复位（★ 必须先复位再测，不然读到的是上次缩放后的宽度 ✓）—— 纯写
    const pres: (HTMLElement | null)[] = [];
    for (const block of blocks) {
        block.style.removeProperty("--code-scale");
        pres.push(block.querySelector("pre"));
    }

    // ② 强制一次布局（之后就都是"读"了 ✗ 不会再触发重排 ✓）
    void document.body.offsetWidth;

    // ③ 全部测量 —— 纯读
    const plans: (number | null)[] = [];
    for (const pre of pres) {
        if (!pre) {
            plans.push(null);
            continue;
        }
        // pre 上有 overflow-x: auto ⇒ scrollWidth 就是内容真实宽度 ✓
        const avail = pre.clientWidth;
        const need = pre.scrollWidth;
        if (avail <= 0 || need <= avail) {
            plans.push(null);
            continue;
        }
        const scale = Math.max(MIN_SCALE, avail / need);
        plans.push(scale < 0.995 ? scale : null);
    }

    // ④ 统一写回 —— 纯写（不会再触发同步布局 ✓）
    for (let i = 0; i < blocks.length; i++) {
        const sc = plans[i];
        if (sc !== null) blocks[i].style.setProperty("--code-scale", sc.toFixed(3));
    }
}

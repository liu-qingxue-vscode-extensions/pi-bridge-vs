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

/** 是否启用（由配置 pi-bridge.style.codeAutoFit 控制 ✗ 默认开）*/
let enabled = true;

export function setCodeAutoFit(on: boolean): void {
    enabled = on;
}

/**
 * 给一棵子树里所有可能过宽的代码块重新定字号
 * ★ 幂等：先复位再测量（否则上次的缩放会影响这次的测量 ⇒ 越缩越小）
 */
export function fitCodeBlocks(root: ParentNode): void {
    if (!enabled) return;
    for (const block of root.querySelectorAll<HTMLElement>(".code-block")) {
        const pre = block.querySelector("pre");
        if (!pre) continue;

        // ① 复位（★ 必须先复位再测，不然读到的是上次缩放后的宽度）
        block.style.removeProperty("--code-scale");
        void pre.offsetWidth; // 强制重排，让复位立刻生效

        // ② 测量：内容宽 vs 可用宽
        //    pre 上有 overflow-x: auto ⇒ scrollWidth 就是内容真实宽度 ✓
        const avail = pre.clientWidth;
        const need = pre.scrollWidth;
        if (avail <= 0 || need <= avail) continue;

        // ③ 定缩放（不超过下限）
        const scale = Math.max(MIN_SCALE, avail / need);
        if (scale < 0.995) block.style.setProperty("--code-scale", scale.toFixed(3));
    }
}

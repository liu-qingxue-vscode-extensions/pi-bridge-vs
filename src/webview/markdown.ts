/**
 * markdown.ts —— 正文的 MD 渲染（B29）
 *
 * 【★ 流式的核心难点】
 *   pi 是一个字符一个字符吐的 ✗ 而 MD 解析器要【完整文本】✓
 *   全量重渲染 → 每来一个字整个气泡重建 → 闪 + 卡 ✓
 *
 * 【★ 解法：块级切分】
 *   按【空行】把已收到的原文切块 ✗
 *     · 前面的块已闭合 ✗ → 渲染一次就不再动 ✓
 *     · 最后一个块还在长 ✗ → 每次只重渲染它 ✓
 *   ⇒ 前面的内容稳定 ✗ 只有尾部在变 ✓✓✓
 *
 * 【★ 两种解析器】（见 marked-setup.ts ✓）
 *   闭合块 → richParser（带 KaTeX 数学公式 ✓）
 *   尾块   → plainParser（★ 不带 ✗ 否则 $ 还在长时会反复重排 → 闪 ✓）
 *
 * 【★ 代码块不切】
 *   ``` 之间的空行不是块边界 ✗（用 inFence 跟踪 ✓）
 *
 * 【★ 脚注要整段渲染】
 *   引用块和定义块分属两块 ✗ → 单块渲染解析不出来 ✓
 *   → 一旦文里出现 [^x]: 就切成整段渲染 ✓
 */
import { messagesEl } from "./dom.js";
import { escapeHtml, plainParser, richParser } from "./marked-setup.js";
import { applyTheme, highlightBlock } from "./highlight.js";
import { log } from "./vscode-api.js";

interface MdState {
    /** 累积的原文 ✓ */
    raw: string;
    /** 已经渲染出去的【闭合块】数量 ✓ */
    done: number;
}

/** ★ 每个气泡自己一份状态 ✗ 用 WeakMap 挂在 DOM 上 ✓ */
const states = new WeakMap<HTMLElement, MdState>();

/** 脚注定义（出现它就要整段渲染 ✓）*/
const FOOTNOTE_DEF_RE = /(^|\n)\s*\[\^[^\]]+\]:/;

/** 把原文切成【已闭合块】+【尾块】✓ */
function splitBlocks(raw: string): { closed: string[]; tail: string } {
    const lines = raw.split("\n");
    const closed: string[] = [];
    let buf: string[] = [];
    let inFence = false;

    for (const line of lines) {
        // ★ 围栏代码块的开关 ✗（``` 或 ~~~ ✓）
        if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
        // 空行 = 块边界 ✗ 但代码块里不算 ✓
        if (!inFence && line.trim() === "" && buf.length > 0) {
            closed.push(buf.join("\n"));
            buf = [];
            continue;
        }
        buf.push(line);
    }
    return { closed, tail: buf.join("\n") };
}

/** 渲染一段 MD → HTML（失败就退回纯文本 ✓ 不能让渲染错误吃掉内容 ✓）*/
function renderMd(src: string, rich: boolean): string {
    if (!src.trim()) return "";
    try {
        const parser = rich ? richParser : plainParser;
        return parser.parse(src, { async: false }) as string;
    } catch {
        return `<p>${escapeHtml(src)}</p>`;
    }
}

/**
 * ★ 追加一段流式文本并重渲染（增量 ✓）
 *
 * @param host 气泡元素（内容都塞进它里面 ✓）
 * @param delta 新到的文本片段 ✓
 */
export function appendMarkdown(host: HTMLElement, delta: string): void {
    let st = states.get(host);
    if (!st) {
        st = { raw: "", done: 0 };
        states.set(host, st);
        host.classList.add("md");
    }
    st.raw += delta;

    // ★★ 脚注模式：整段渲染 ✓
    //   引用块和定义块在不同块里 ✗ 单块渲染解析不出来 ✓
    //   代价可接受（脚注少见 ✗ 定义总在末尾 ✓）
    if (FOOTNOTE_DEF_RE.test(st.raw)) {
        renderMarkdown(host, st.raw);
        return;
    }

    const { closed, tail } = splitBlocks(st.raw);

    // ★ ① 新增的闭合块：用 richParser 渲染一次 ✗ 之后永远不动 ✓
    while (st.done < closed.length) {
        const el = document.createElement("div");
        el.className = "md-block";
        el.innerHTML = renderMd(closed[st.done], true);
        host.appendChild(el);
        st.done++;
    }

    // ★ ② 尾块：每次重渲染它 ✗ 用 plainParser（不带公式 ✗ 否则会闪 ✓）
    let tailEl = host.querySelector<HTMLElement>(".md-tail");
    if (!tailEl) {
        tailEl = document.createElement("div");
        tailEl.className = "md-block md-tail";
        host.appendChild(tailEl);
    }
    tailEl.innerHTML = renderMd(tail, false);

    // ★ 尾块里可能有 ```mermaid ✗ 交给异步渲染 ✓
    scheduleMermaid();
    scheduleHighlight();
}

/**
 * ★ 段结束：把尾块"封"成普通块 ✗
 *
 * 【为什么？】
 *   尾块会一直被重渲染 ✗ 但段结束后它内容已定 ✓
 *   → 封掉后下次续写不会串到它 ✓
 *   ★ 顺便用 richParser 重渲染一次 ✗ 让尾部的公式/图生效 ✓
 */
export function finishMarkdown(host: HTMLElement): void {
    const st = states.get(host);
    const tailEl = host.querySelector<HTMLElement>(".md-tail");
    if (!tailEl || !st) return;

    // ★ 尾部内容已定 → 用 rich 再渲染一次 ✗ 公式这时才真正排版 ✓
    const { tail } = splitBlocks(st.raw);
    tailEl.innerHTML = renderMd(tail, true);
    tailEl.classList.remove("md-tail");

    // ★ 更新状态：尾块也算“已渲染的闭合块” ✓
    st.done = splitBlocks(st.raw).closed.length + 1;
    // ★ 段结束 → 这时尾部的 mermaid / 代码块才真的完整 ✗ 处理它们 ✓
    scheduleMermaid();
    scheduleHighlight();
}

/**
 * ★ 整段渲染（脚注模式 / 历史重放 ✓）
 *
 * ★★ 必须【一次性】交给 marked ✗ 不能再切块 ✓
 *   否则脚注的引用与定义分属两块 → 解析不出来 ✓
 */
export function renderMarkdown(host: HTMLElement, raw: string): void {
    host.classList.add("md");
    host.textContent = "";
    const el = document.createElement("div");
    el.className = "md-block";
    el.innerHTML = renderMd(raw, true);
    host.appendChild(el);
    states.set(host, { raw, done: 1 });
    scheduleMermaid();
    scheduleHighlight();
}

/**
 * ★★ 初始化（入口调一次 ✓）
 *
 * 【为什么用事件委托？】
 *   代码块是 innerHTML 插进来的 ✗ 而流式会反复重建尾部 ✓
 *   → 一个个 addEventListener 会泄漏 ✓ 挂在 messagesEl 上统一接 ✓
 *
 * 【★ 关于"按钮容器" .code-actions】
 *   以后加"下载 / 折叠 / 行号"只需在 renderer 里多输出一个 data-xxx 按钮 ✓
 *   再在下面加一个分支 ✓ —— 不用改结构 ✓
 */
export function setupMarkdown(): void {
    messagesEl.addEventListener("click", (e) => {
        const target = e.target as HTMLElement | null;

        // ★★ mermaid 的「源码 ⇄ 渲染」切换（B29 P2 ✓）
        //   默认只显示图 ✗ 点一下展开源码 ✓
        const tog = target?.closest<HTMLElement>("[data-mermaid-toggle]");
        if (tog) {
            const block = tog.closest(".code-mermaid");
            if (block) {
                const showSrc = block.hasAttribute("data-show-src");
                if (showSrc) {
                    block.removeAttribute("data-show-src");
                    tog.textContent = "源码";
                } else {
                    block.setAttribute("data-show-src", "");
                    tog.textContent = "渲染";
                }
            }
            return;
        }

        const btn = target?.closest<HTMLElement>("[data-copy-code]");
        if (!btn) return;
        const code = btn.closest(".code-block")?.querySelector("code")?.textContent ?? "";
        const done = (label: string): void => {
            btn.textContent = label;
            setTimeout(() => {
                btn.textContent = "复制";
            }, 1200);
        };
        void navigator.clipboard.writeText(code).then(
            () => done("已复制"),
            () => done("失败"),
        );
    });
}

// ══════════════ ★★ 代码高亮（B29 P3 ✗ shiki ✓）══════════════

/**
 * ★ 扫描还没高亮的代码块 ✗ 异步补上 ✓
 *
 * 【★ 关键：不碰尾块】
 *   尾块在流式时每次都被重渲染 ✓ 高亮它 = 每来一个字就重新着色 → 抖 + 卡 ✓
 *   → 只处理"已经闭合"的块（即不在 .md-tail 里的 ✓）
 *
 * 【★ 去重】同步打 data-hl-done ✗
 *   （mermaid 那次踩过：标记写在异步里 → 并发重复渲染 ✓）
 */
let hlBusy = false;

async function runHighlight(): Promise<void> {
    const blocks = [
        ...messagesEl.querySelectorAll<HTMLElement>(".code-block:not([data-hl-done])"),
    ].filter((b) => !b.classList.contains("md-tail") && !b.closest(".md-tail"));
    if (blocks.length === 0) return;
    // ★ 同步标记 ✗ 防并发重复 ✓
    for (const b of blocks) b.dataset.hlDone = "1";
    if (hlBusy) return; // 有另一个在跑 ✗ 它会带上这些新的 ✓
    hlBusy = true;
    try {
        for (const b of blocks) {
            // ★ mermaid 块不高亮 ✗ 它要渲染成图 ✓
            if (b.classList.contains("code-mermaid")) continue;
            await highlightBlock(b);
        }
    } finally {
        hlBusy = false;
    }
}

/**
 * ★ 宿主推来 VS Code 主题（B29 ✗）→ 转交给 highlight ✓
 *   主题一变 → 已渲染的代码块要【重新高亮】✓
 */
export function setHighlightTheme(payload: unknown): void {
    applyTheme(payload as never);
    // ★ 清掉所有 data-hl-done ✗ 让它们重来一次 ✓
    for (const b of messagesEl.querySelectorAll<HTMLElement>(".code-block[data-hl-done]")) {
        delete b.dataset.hlDone;
    }
    scheduleHighlight();
}

/** ★ 渲染流程调这个 ✗ 异步排队 ✗ 不阻塞流式 ✓ */
export function scheduleHighlight(): void {
    queueMicrotask(() => {
        void runHighlight();
    });
}

// ══════════════ ★★ Mermaid（B29 P2 ✗ 按需加载 ✓）══════════════

/** mermaid.js 的地址（由宿主注入到 <meta> ✓）*/
function mermaidUri(): string {
    return document.querySelector('meta[name="pi-mermaid-uri"]')?.getAttribute("content") ?? "";
}

interface MermaidLike {
    render(id: string, src: string): Promise<{ svg: string }>;
}

/** ★ 懒加载：只注入一次 ✗ 之后复用同一个 Promise ✓ */
let mermaidLoad: Promise<MermaidLike> | undefined;

function loadMermaid(): Promise<MermaidLike> {
    if (!mermaidLoad) {
        const uri = mermaidUri();
        mermaidLoad = new Promise<MermaidLike>((resolve, reject) => {
            if (!uri) {
                reject(new Error("宿主没注入 mermaid 地址"));
                return;
            }
            const s = document.createElement("script");
            s.src = uri;
            // ★ CSP 的 script-src 已允许同源 ✗ 不需要 nonce ✓
            s.onload = () => resolve((window as unknown as { mermaid: MermaidLike }).mermaid);
            s.onerror = () => reject(new Error("mermaid.js 加载失败"));
            document.head.appendChild(s);
        });
    }
    return mermaidLoad;
}

let mermaidSeq = 0;
/** ★ 待渲染队列 + 串行锁（防重复渲染 ✓）*/
const pendingMermaid = new Set<HTMLElement>();
let mermaidBusy = false;

/**
 * ★★ 把还没渲染的 ```mermaid 块渲染成图 ✗
 *
 * 【去重】用 data-mermaid-done 标记 ✓
 *   （流式会反复调用 ✗ 但每个块只处理一次 ✓）
 *
 * 【失败处理】两种都保留源码 ✗ 只在下面附一行错误 ✓
 *   （用户还能看到原始 mermaid 文本 ✓ 比"白屏"好 ✓）
 */
async function renderMermaidBlocks(): Promise<void> {
    const fresh = [
        ...messagesEl.querySelectorAll<HTMLElement>(".code-mermaid:not([data-mermaid-done])"),
    ];
    // ★★ 关键：【同步】打标记 ✗ 别等 await 之后 ✓
    //   用户实测的 bug：图被渲染了 3 次 ✓
    //   根因：done 是在异步里设的 ✗ 三次调用几乎同时跑
    //        → 都拿到同一批块 → 各渲染一次 ✓✓✓
    for (const b of fresh) {
        b.dataset.mermaidDone = "1";
        pendingMermaid.add(b);
    }
    if (pendingMermaid.size === 0) return;

    // ★ 串行化 ✗ mermaid.render 并发会互相干扰（id / 内部状态 ✓）
    if (mermaidBusy) return;
    mermaidBusy = true;
    try {
        let mermaid: MermaidLike | undefined;
        try {
            mermaid = await loadMermaid();
        } catch (err) {
            for (const b of pendingMermaid) {
                b.setAttribute("data-show-src", ""); // 失败就露出源码 ✓
                const tg = b.querySelector<HTMLElement>("[data-mermaid-toggle]");
                if (tg) tg.textContent = "渲染";
                const tip = document.createElement("div");
                tip.className = "mermaid-err";
                tip.textContent = `Mermaid 未能加载：${String(err)}`;
                b.appendChild(tip);
            }
            pendingMermaid.clear();
            return;
        }
        if (!mermaid) return;

        // ★ 渲染过程中可能又有新块进来 ✗ 所以做成"边做边取"✓
        while (pendingMermaid.size > 0) {
            const b = pendingMermaid.values().next().value as HTMLElement;
            pendingMermaid.delete(b);
            const src = b.querySelector("code")?.textContent ?? "";
            try {
                const { svg } = await mermaid.render(`pi-mermaid-${++mermaidSeq}`, src);
                const out = document.createElement("div");
                out.className = "mermaid-out";
                out.innerHTML = svg;
                b.appendChild(out);
            } catch (err) {
                // ★★ B47：失败 ⇒ 【静默回退成普通代码块】（用户明确要求的 ✓）
                //
                // 【原来为什么不对】插了一个 .mermaid-err 提示块 ✗
                //   而且是"渲染不出来"的图 + 一行红字 ✗ 净是噪音 ✓
                // 【现在】语法错就语法错 ✗ 用户能看到源码就够了 ✓
                //   （源码本来就在这个块里 ✗ 只是平时被"图"盖住 ✓）
                log.debug(`mermaid 语法错误（已回退成代码块）：${String(err).slice(0, 120)}`);
                b.setAttribute("data-show-src", ""); // ★ 露出源码 ⇒ 就是个普通代码块 ✓
                const tg = b.querySelector<HTMLElement>("[data-mermaid-toggle]");
                if (tg) tg.textContent = "渲染"; // （点了会再试一次 ✓）
                // ★ 防 mermaid 留垃圾：清掉它可能插到 body 上的临时容器 ✓
                //   实测：它的临时容器 id 形如 "dpi-mermaid-N" / "mermaid-N" ✓
                for (const junk of document.querySelectorAll(
                    "body > [id^='dpi-mermaid'], body > [id^='mermaid-']",
                )) {
                    junk.remove();
                }
            }
        }
    } finally {
        mermaidBusy = false;
        // ★ 收尾时如果又攒了新的（渲染期间来的）✗ 再跑一轮 ✓
        if ([...messagesEl.querySelectorAll(".code-mermaid:not([data-mermaid-done])")].length > 0) {
            scheduleMermaid();
        }
    }
}

/** ★ 渲染流程调这个 ✗ 异步排队 ✗ 不阻塞流式 ✓ */
export function scheduleMermaid(): void {
    queueMicrotask(() => {
        void renderMermaidBlocks();
    });
}

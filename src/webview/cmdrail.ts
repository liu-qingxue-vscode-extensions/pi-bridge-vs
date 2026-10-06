/**
 * cmdrail.ts —— 自由按钮容器的前端（B32 ✓）
 *
 * 【它管什么】
 *   气泡区左侧那根竖条里按钮的【渲染 + 交互】✓
 *
 * 【消息方向】
 *   宿主 → 这里：commands（整份按钮列表 ✓）
 *   这里 → 宿主：commandRun / commandAdd / commandDelete ✓
 *
 * 【★ 图标的三级兜底】（用户提的"文字转图标"✓）
 *   ① 填了 emoji      → 直接用 ✓
 *   ② 填了 codicon 名 → <i class="codicon codicon-xxx"></i> ✓
 *   ③ 都没填           → 用 label 首字（像头像一样 ✓）
 *
 * 【★ 为什么不用虚拟列表？】
 *   按钮是用户手配的 ✗ 几十个到头了 ✓
 *   直接全量重建 DOM ✗ 简单可靠 ✓
 *   （真到几百个再说 ✓ 那时也是"换实现"而不是"打补丁" ✓）
 */
import { post, log, vscode } from "./vscode-api.js";
import { showContextMenu } from "./context-menu.js";

/** ★ 与宿主端 command-store.ts 的结构保持一致（见那个文件 ✓）*/
interface CmdField {
    id: string;
    label: string;
    kind: "fixed" | "select" | "any";
    value?: string;
    options?: string[];
    subType?: "text" | "number";
}
interface CmdItem {
    id: string;
    label: string;
    hint?: string;
    icon?: string;
    /** ★ B33：data URI 兜底（宿主给的 ✗ 不走网络 ✓）*/
    iconData?: string;
    type: "button" | "group";
    command?: string;
    lockCommand?: boolean;
    fields?: CmdField[];
    inputMode?: "serial" | "panel";
    children?: CmdItem[];
}

// ★★ B34：原来这里有一个 useFallback 集合（“主路径失败过就记住”✓）
//   用户拍了板：【直接用 data URI】✗ 所以整个降级机制不需要了 ✓
//   （★ 以后想切回“先试主路径”✗ 把 makeBtn 里的 useData 改回判断即可 ✓）

const railEl = document.getElementById("cmd-rail-list");

/** ★ 当前列表（宿主推来的 ✓）*/
let items: CmdItem[] = [];

// ────────── ★★ B33：横向弹层（收纳器）──────────

/**
 * 【它是什么】
 *   点收纳器 → 在它右边横排弹出一排子按钮 ✗ 最后一项永远是「＋」✓
 *
 * 【★ 为什么用浮层而不是插进布局？】
 *   插进布局会【挤压气泡区】✗ 每次展开都要重排 ✓
 *   浮层不影响布局 ✗ 点外面就关 ✓（跟右键菜单同一套路 ✓）
 *
 * 【★ 为什么挂在 document.body 而不是 #cmd-rail 里？】
 *   #cmd-rail 写了 overflow: hidden ✗（B32 为了隐滚动条 ✓）
 *   → 挂里面会被裁掉 ✓✓✓
 *   → 挂 body + position: fixed ✓ 才能飘在外面 ✓
 */
let popover: HTMLElement | null = null;
/** 哪个收纳器开着（用于点同一个时收起 ✓）*/
let popoverFor: string | null = null;

function closePopover(): void {
    popover?.remove();
    popover = null;
    popoverFor = null;
}

function openPopover(group: CmdItem, anchor: HTMLElement): void {
    // ★ 点同一个 → 收起（toggle ✓）
    if (popoverFor === group.id) {
        closePopover();
        return;
    }
    closePopover();

    const el = document.createElement("div");
    el.className = "rail-pop";

    for (const child of group.children ?? []) {
        el.appendChild(makeBtn(child, group));
    }

    // ★★ 最后一项永远是「＋」（用户定的 ✓）
    //   ★ 它新建出来的子按钮：type 锁死 button ✗ 命令可能被父亲锁死 ✓
    //     —— 这两条由【配置页】根据 parent 信息执行 ✓
    const add = document.createElement("button");
    add.className = "cmd-btn add";
    add.textContent = "＋";
    add.title = `在「${displayName(group)}」里新建一个按钮`;
    add.addEventListener("click", () => {
        vscode.postMessage({ kind: "commandNew", parentId: group.id });
        closePopover();
    });
    el.appendChild(add);

    // ★ 空收纳器也给一句提示（否则只有个＋不知道是啥 ✓）
    if ((group.children ?? []).length === 0) {
        const hint = document.createElement("span");
        hint.className = "rail-pop-hint";
        hint.textContent = "空收纳器";
        el.insertBefore(hint, add);
    }

    document.body.appendChild(el);
    // ★★ 弹层也是容器 ✗ 落点判定挂在它身上（横向 ✓）
    wireContainer(el, group.id, true);

    // ★★ 定位：跟竖条【自然衔接】✗（B33 用户要求 ✓）
    //
    //   ★★ 水平：【从竖条右边缘开始】不覆盖 ✗
    //     踩过：我先写成 r.right - 1（想盖住那条分隔线 ✓）
    //     → 用户报：“横向容器的上下边界线【穿进了容器里面】”✗✓
    //     ⇒ 因为左移 1px 后 ✗ 弹层的【上/下两条横线】越过了竖条边缘 ✓
    //     ⇒ 正解：不越界 ✗ 而是【弹层自己不画左边】✓（见 CSS ✓）
    //
    //   ★★ 垂直：【中心对齐】✗（用户报的：
    //     “由于需要边框 ✗ 你那个高度就会比它高 ✗ 首先它就没有对齐”✓
    //     顶部对齐的话 ✗ 弹层比按钮高出来的部分全落在下面 ✗ 看着歪 ✓
    //     居中则上下均匀 ✓ 自然 ✓）
    const r = anchor.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    const fitsRight = r.right + box.width <= window.innerWidth - 4;
    const left = fitsRight ? r.right : Math.max(4, r.left - box.width);
    const centered = r.top + r.height / 2 - box.height / 2;
    const top = Math.max(4, Math.min(centered, window.innerHeight - box.height - 4));
    el.style.left = `${Math.max(4, left)}px`;
    el.style.top = `${top}px`;
    // ★ 翻到左边时，圆角方向也要跟着翻 ✗（否则圆角跑到衔接处 ✓）
    el.classList.toggle("flip", !fitsRight);

    popover = el;
    popoverFor = group.id;
}

// ── 渲染 ──

/** ★ codicon 名长这样：add / gear / star ✗ 纯小写字母数字减号 ✓ */
function isCodicon(s: string): boolean {
    return /^[a-z][a-z0-9-]*$/.test(s);
}

/**
 * ★★ 这个 icon 是不是【图片源】（B32 图标 ✓）
 *
 * 【为什么不像主机端那样看路径？】
 *   主机推过来之前已经把 `icons/xxx` 转成了 webview URI ✓
 *   ⇒ 前端看到的是 `vscode-webview://…` ✗ 而不是磁盘路径 ✓
 *   ★ 前端【不碰磁盘】✗ 只认得“这是个能当 src 的地址”✓
 */
function isImageSrc(icon: string): boolean {
    return /^(vscode-webview:|https?:|data:image\/)/.test(icon);
}

/**
 * ★★ 按钮显示名（B32 ③）
 *
 * 【用户原话】
 *   “你实在不行 ✗ 你直接拿命令拿去渲染不就完事儿了？”✓
 * ⇒ 没填名字就退回命令（形如 `/mode` ✓）
 *   ★ 这样“名字”就真的不必填了 ✗ 而且还能一眼看出是哪个命令 ✓
 */
function displayName(item: CmdItem): string {
    if (item.label.trim()) return item.label.trim();
    // ★ 不带斜杠（踩过 ✗ 带了的话首字兜底会取到 "/" ✓）
    if (item.command) return item.command;
    return "（未命名）";
}

/**
 * ★ 造一个按钮（图标四级兜底 ✓）+ ★★ 把事件一起挂上 ✗
 *
 * 【★ 为什么要在这里挂事件？】（B33 踩过 ✗）
 *   原来 makeBtn 只造元素 ✗ 事件由调用方分别 wire ✓
 *   结果【弹层里忘了 wire】✗ → 子按钮点了没反应 ✗
 *   而且【不报错】✓ 日志里也什么都没有 ✓ 极难排查 ✓
 *   ⇒ ★ 改结构而不是写注释 ✗：事件就在造按钮时一起挂 ✓
 *     这样调用方【没机会漏】✓（FACTS #26 的思路 ✓）
 *
 * @param group 所属收纳器（只有弹层里的子按钮才传 ✗ 影响提示文案 ✓）
 */
function makeBtn(item: CmdItem, group?: CmdItem): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = "cmd-btn";
    // ★ B34：标记 id（恢复弹层时要按它找锚点 ✓）
    b.dataset.id = item.id;
    if (item.type === "group") b.classList.add("group");

    const name = displayName(item);
    const icon = item.icon?.trim() ?? "";

    // ★★ B33：决定图标走哪条路 ✗
    //   ① 主路径不可用（空 / 不是地址 ✓）或之前失败过 → 直接用 data 兜底 ✓
    //   ② 否则先用主路径 ✓ 失败时降级（★ 保留诊断能力：日志里看得到 401 ✓）
    const primary = icon && isImageSrc(icon) ? icon : "";
    // ★★ B34：用户定的 —— 【直接用兜底】✗ 不再先试主路径 ✓
    //   原话：“瞄了个咪的，别做降级了，直接做成这个实现吧。
    //          我后面最后最后我会来做一个代码框架解析与优化 ✗
    //          尝试优化 ✗ 到时候再考虑把这些东西做完美”✓
    //   ★ 环境里主路径就是 401 ✗ 试一次只是白闪 ✓
    //     留着主路径的代码 ✗ 以后环境好了改一行就能切回来 ✓
    const useData = !!item.iconData;
    const src = useData ? item.iconData! : primary;

    if (src) {
        const img = document.createElement("img");
        img.className = "cmd-ico";
        img.src = src;
        // ★ alt 留空：图片加载不出来时不要蹦出一行文字（踩过 ✗）
        img.alt = "";
        img.addEventListener("error", () => {
            // ★★ B34：现在默认就走 data ✗ 还能失败就说明兜底也没拿到 ✓
            const who = item.label || item.command || "?";
            log.error(
                `图标加载失败：${who}\n` +
                    `  src = ${img.src.slice(0, 120)}\n` +
                    `  （宿主没给出 data 兜底？看输出的 iconForWeb 日志 ✓）`,
            );
        });
        b.appendChild(img);
    } else if (icon && !isCodicon(icon)) {
        // ② emoji / 任意字符 ✓
        b.textContent = icon;
    } else if (icon) {
        // ③ codicon 名 ✓
        const i = document.createElement("i");
        i.className = `codicon codicon-${icon}`;
        b.appendChild(i);
    } else {
        // ④ 文字兜底（★★ B33：规则由用户明确 ✓）
        //
        //   【规则】
        //     第一个字符是【中文】→ 只渲染这一个字 ✓（“目录” → “目” ✓）
        //     否则（英文 / 数字 / 符号开头）→ ★ 通通【全量渲染】✓
        //
        //   【为什么这样分？】（用户讲清楚了 ✓）
        //     中文一个方块字就够认 ✓
        //     而 “a-w” “苹-红” 这种【本身就是缩写】✗
        //       只取一个字就完全没信息了 ✓
        //     而且我们这批名字是【变量名拼出来的】✗ 几乎不会是中文 ✓
        //       ⇒ 连字符、减号什么的都要原样渲染 ✓
        b.classList.add("text");
        const first = [...name][0] ?? "?";
        // ★ 汉字范围：基本区 + 扩展A + 兼容表意 ✓
        const isCJK = /[\u3400-\u9fff\uf900-\ufaff]/.test(first);
        if (isCJK) {
            b.textContent = first;
        } else {
            b.textContent = name;
            // ★ 太长就自动缩字号（三档 ✓）而不是截断 ✓
            const len = [...name].length;
            if (len >= 5) b.classList.add("tiny");
            else if (len >= 3) b.classList.add("sm");
        }
    }

    // ★ 悬停提示：说明 + 命令（让人一眼知道会注入什么 ✓）
    const parts: string[] = [name];
    if (item.hint) parts.push(item.hint);
    if (item.type === "group") {
        parts.push(`收纳器：点开有 ${(item.children ?? []).length} 个按钮`);
    } else if (item.command) {
        const n = (item.fields ?? []).length;
        parts.push(`注入 /${item.command}${n ? `（需要填 ${n} 个参数）` : ""}`);
    }
    if (group) parts.push(`属于「${displayName(group)}」`);
    // ★★ 父亲的“强制”提示（B33 ✗ 让用户一眼知道命令被锁了 ✓）
    if (group?.lockCommand && group.command) {
        parts.push(`★ 命令被收纳器锁死：/${group.command}`);
    }
    parts.push("右键：删除 / 编辑");
    b.title = parts.join("\n");

    // ★★ 事件一起挂上 ✗ 调用方就不会漏（B33 ✓）
    wireClick(b, item);
    wireMenu(b, item);
    wireDrag(b, item, group?.id ?? ""); // ★ B34：拖拽 ✓

    return b;
}

// ══════════════ ★★ B34：拖拽（分三步 ✗ 先做「同容器内重排」✓）══════════════

/**
 * 【★ 为什么要有这个全局状态？】
 *   拖拽是【跨元素】的 ✗
 *     ① dragstart 在【被拖的按钮】上
 *     ② dragover / drop 在【途经 / 目标按钮】上
 *   三件事分属不同元素的处理器 ✗ 必须有个共享的“当前在拖什么”✓
 */
interface DragState {
    /** 正在拖的条目 id ✓ */
    id: string;
    /** ★ 它的父亲（"" = 顶层竖条 ✗ 否则是收纳器 id ✓）*/
    parentId: string;
    /** ★★ 它的 DOM 元素（B34 ✗ 算“是否等于原地”要用 ✓）*/
    el: HTMLElement;
    /**
     * ★★ 同级【其他】按钮的未变换中点（dragstart 快照 ✗ 之后不再重算 ✓）
     *
     * 【★ 为什么必须快照？】（B34 用户实测报的“不一致”✓）
     *   让开动画用的是 transform ✗ 而 getBoundingClientRect() 【会反映 transform】✓
     *   → 元素一让开 ✗ 判定基准就跟着偏 ✓
     *   → 鼠标指的地方 和 系统判定的地方 就错位了 ✓✓✓
     *   ★ 症状：“明明不会进入他俩之间 ✗ 他俩仍然让开位置”✓
     *
     * 【★ 为什么排除自己？】
     *   后端 moveCommand 是【先把源珊出来 ✗ 再插进去】✓
     *   前端要从同一个语义出发 ✗ 否则又是“动画与实际不一”✓
     */
    others: { el: HTMLElement; mid: number }[];
    /** ★ 轴：竖条用 y ✗ 弹层用 x ✓ */
    horizontal: boolean;
    /** ★ 当前落点索引（在 others 里 ✗ == length 表示末尾 ✓ -1 = 还没算 ✓）*/
    slot: number;
}
let drag: DragState | null = null;
/** ★ 探针：第一条日志能出现就说明 webview 支持 HTML5 拖拽（B34 ✓）*/
let dragProbeLogged = false;
/**
 * ★★ 刚刚拖过（B34 ✓）
 *   drop 之后浏览器会再补一个 click ✗ 用它吃掉那一次 ✓
 *   ★ 为什么用标志而不是事件时间差？
 *     click 紧跟 drop ✗ 时间差极小 ✓ 标志最直接可靠 ✓
 */
let justDragged = false;

/** ★ 清掉所有落点标记（只可能有一对 ✗ 但全清最简单 ✓）*/
function clearDropMarks(): void {
    document
        .querySelectorAll(".drop-before, .drop-after, .shift-up, .shift-down")
        .forEach((e) => e.classList.remove("drop-before", "drop-after", "shift-up", "shift-down"));
}

/**
 * ★★ 画出“空位”（B34 ✓）
 *
 * 【规则】插到 others[i] 【之前】✗
 *   → others[i] 往后让（它自己就该被这东西顶开 ✓）
 *   → others[i-1] 往前让（另一侧 ✓）
 *   ★ 两边一起 ✗ 中间的空位才看得出来（用户要求“两个一起移动”✓）
 *   ★★ 末尾（i == length）→ 只让最后一个往前让 ✓
 */
function paintSlot(): void {
    clearDropMarks();
    if (!drag) return;
    const { others, slot } = drag;
    const after = others[slot]; // 插到它之前 ✓（可能 undefined = 末尾）
    const prev = others[slot - 1]; // 它前面那个 ✓

    if (after) after.el.classList.add("drop-before");
    if (prev && after) prev.el.classList.add("shift-up");
    if (!after && prev) prev.el.classList.add("drop-after");
}

/** ★★ 在快照里找落点索引（第一个 mid > pos 的就在它前面 ✓）*/
function findSlot(others: { mid: number }[], pos: number): number {
    for (let i = 0; i < others.length; i++) {
        if (pos < others[i].mid) return i;
    }
    return others.length; // 比所有中点都靠后 → 末尾 ✓
}

/**
 * ★★ 给【容器】挂拖拽落点（B34 ✗ 这一步是成败关键 ✓）
 *
 * 【★★ 为什么必须挂容器而不是按钮？】（踩过 ✗ 用户报“成功率低”✓）
 *   原来挂在每个按钮上 ✗ 而且开头对【拖动源自己】直接 return ✓
 *   但拖起来时鼠标【正下方就是源】✗
 *   → 那个位置既不 preventDefault ✗ 也不接 drop ✓
 *   → 必须“挪到别的按钮上”才能落 ✗ 成功率当然低 ✓✓✓
 *   ⇒ 挂容器：只要在容器范围内 ✗ 哪都能落 ✓
 *
 * 【判定算法（不动 ✓）】
 *   快照里每个中点就是分割线 ✗ 第一个 mid > 鼠标位置的就是落点 ✓
 *   用户说的“半个按钮 + 半个间距”✗ 数学上就是这个中点分界 ✓
 *   而且它是【动态的】✗ 但基准是【快照】✗ 不被自己的动画带偏 ✓
 */
function wireContainer(el: HTMLElement, parentId: string, horizontal: boolean): void {
    el.addEventListener("dragover", (e) => {
        if (!drag || drag.parentId !== parentId) return;
        e.preventDefault(); // ★ 容器级：整个区域都能落 ✓
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";

        const pos = horizontal ? e.clientX : e.clientY;
        const slot = findSlot(drag.others, pos);
        if (slot === drag.slot) return; // ★ 没变就不重画（不抖 ✓）
        drag.slot = slot;
        paintSlot();
    });

    el.addEventListener("drop", (e) => {
        if (!drag || drag.parentId !== parentId) return;
        e.preventDefault();
        e.stopPropagation();

        // ★★ 从【快照索引】换算成宿主认识的 (targetId, before) ✗
        //   ★ 消息格式不变 ✗ 后端 moveCommand 已经是“先珊后插”✓
        const { others, slot } = drag;
        const i = slot < 0 ? others.length : slot;
        const at = others[i]; // 插到它之前 ✓
        const prev = others[i - 1]; // 末尾时用最后一个 + before=false ✓
        const src = drag;

        clearDropMarks();
        drag = null;
        justDragged = true; // ★ 吃掉紧接着的那次 click ✓

        const targetId = at ? at.el.dataset.id : prev?.el.dataset.id;
        if (!targetId) return; // 同级只剩自己 ✗ 没得排 ✓
        const before = !!at;
        log.info(`拖拽重排：${src.id} → ${before ? "前" : "后"}插到 ${targetId}`);
        vscode.postMessage({ kind: "commandMove", id: src.id, targetId, before });
    });
}

/** ★★ 给按钮挂拖拽（B34 ✗ 只负责“起拖 / 收拖”✓）*/
function wireDrag(b: HTMLButtonElement, item: CmdItem, parentId: string): void {
    b.draggable = true;

    b.addEventListener("dragstart", (e) => {
        // ★★ B34：先快照（此时还没任何 transform ✗ 位置是干净的 ✓）
        const horizontal = parentId !== "";
        const sibs = [...(b.parentElement?.children ?? [])] as HTMLElement[];
        const others = sibs
            .filter((x) => x.classList.contains("cmd-btn") && x !== b)
            .map((x) => {
                const r = x.getBoundingClientRect();
                return { el: x, mid: horizontal ? r.left + r.width / 2 : r.top + r.height / 2 };
            });
        drag = { id: item.id, parentId, el: b, others, horizontal, slot: -1 };

        b.classList.add("dragging");
        if (e.dataTransfer) {
            e.dataTransfer.setData("text/plain", item.id);
            e.dataTransfer.effectAllowed = "move";
            // ★★ 换成【缩小的拖拽图像】（用户要的“拖动出来的图标变小”✓）
            //   ★ 必须在这个时机同步 append ✗ 之后才能移除 ✓
            const ghost = b.cloneNode(true) as HTMLElement;
            ghost.className = "cmd-btn cmd-ghost";
            document.body.appendChild(ghost);
            const gr = ghost.getBoundingClientRect();
            e.dataTransfer.setDragImage(ghost, gr.width / 2, gr.height / 2);
            setTimeout(() => ghost.remove(), 0);
        }
        if (!dragProbeLogged) {
            dragProbeLogged = true;
            log.info("★ 拖拽探针：dragstart 触发了 ✓（webview 支持 HTML5 DnD ✓）");
        }
    });

    b.addEventListener("dragend", () => {
        b.classList.remove("dragging");
        clearDropMarks();
        drag = null;
        // ★ 没触发 drop（拖到空白处）也要吃掉随后的 click ✓
        if (!justDragged) {
            justDragged = true;
            setTimeout(() => {
                justDragged = false;
            }, 0);
        }
    });
}

/** ★ 挂点击（顶层收纳=展开 ✗ 其余=执行 ✓）*/
function wireClick(btn: HTMLButtonElement, item: CmdItem): void {
    btn.addEventListener("click", () => {
        // ★★ B34：拖拽结束后的那一次 click 要忽略 ✗
        //   症状（用户报的）：“拖拽完结束之后 ✗ 它会收起来 ✗
        //     自动 ✗ 也就是似乎完成了一次点击事件的意味了”✓
        //   ★ 原因：浏览器在 drop 后还会补一个 click ✓
        if (justDragged) {
            justDragged = false;
            return;
        }
        if (item.type === "group") {
            openPopover(item, btn); // ★ B33：横向弹层 ✓
            return;
        }
        // ★★ 用直接 postMessage（扁平 ✗ 不要套 payload ✓）
        //   为什么？→ 宿主的类型定义是 { kind, id } ✗
        //     用 post(kind, {id}) 会变成 { kind, payload:{id} } ✗
        //     宿主读 msg.id 就是 undefined ⇒ 静默什么也不做 ✓
        //   （踩过 ✗ 日志里只有一句“删除按钮：undefined”✓）
        // ★ B33：记一笔（排查“点了没反应”时它是第一手证据 ✓）
        log.info(`点击自由按钮：${item.label || item.command || item.id}`);
        vscode.postMessage({ kind: "commandRun", id: item.id });
        closePopover();
    });
}

/** ★ 挂右键菜单（顶层 / 子按钮一样 ✓）*/
function wireMenu(btn: HTMLButtonElement, item: CmdItem): void {
    btn.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showContextMenu(e, [
            {
                // ★★ B32 ②：右键直接进配置页面 ✓
                label: item.type === "group" ? "编辑收纳器…" : "编辑按钮…",
                onClick: () => vscode.postMessage({ kind: "commandEdit", id: item.id }),
            },
            {
                label: "删除…",
                danger: true,
                onClick: () => vscode.postMessage({ kind: "commandDelete", id: item.id }),
            },
        ]);
    });
}

function render(): void {
    if (!railEl) return;
    // ★★ B34：重绘后要【恢复】之前打开的弹层 ✗
    //
    //   【为什么？】拖拽会触发宿主 pushCommands → 前端 setRailCommands → render ✓
    //     而 render 原来第一件事就是 closePopover ✗✗✗
    //     → 用户看到的就是：“拖拽完结束之后 ✗ 它会收起来”✓
    //     （他归因为“似乎完成了一次点击”✗ 其实点击也有一份 ✓ 两个 bug 叠了）
    //   ⇒ 先把“之前开着谁”记下来 ✗ 重绘完再展开 ✓
    const reopen = popoverFor;
    closePopover();
    railEl.textContent = "";

    for (const item of items) {
        // ★ makeBtn 已经把事件一起挂好了（B33 ✓）
        railEl.appendChild(makeBtn(item));
    }

    // ★★ 列表最后一项永远是「＋」（用户定的 ✓）
    const add = document.createElement("button");
    add.className = "cmd-btn add";
    add.textContent = "＋";
    add.title = "新建一个自由按钮（先起名字 ✗ 命令后面再补 ✓）";
    add.addEventListener("click", () => void addByPrompt());
    railEl.appendChild(add);

    // ★ 恢复弹层（找新的那个按钮当锚点 ✓）
    if (reopen) {
        const g = items.find((x) => x.id === reopen);
        const anchor = railEl.querySelector<HTMLButtonElement>(`[data-id="${reopen}"]`);
        if (g && g.type === "group" && anchor) openPopover(g, anchor);
    }
}

// ── 新建（B32 ① 先用输入框顶上 ✗ 完整的配置页在 ② ✓）──

/**
 * ★ 点「＋」→ 告诉宿主去弹输入框
 *
 * 【为什么不在这里画表单？】
 *   ① 这一步的目标是“能用”✗ 不是“好用” ✓
 *   ② VS Code 原生输入框自带校验 / 取消 / 键盘操作 ✗ 零 UI 成本 ✓
 *   ③ 完整的配置页面（图标 / 参数 / 收纳器）是 B32 的下一步 ✓
 */
function addByPrompt(): void {
    vscode.postMessage({ kind: "commandNew" });
}

// ── 宿主 → 前端 ──

/**
 * ★ 宿主推来整份按钮列表（B32 ✓）
 *
 * ★ 为什么用导出函数而不是自己监听 window message？
 *   apply.ts 已经是【所有宿主消息的统一入口】✗
 *   其他模块（通知 / 会话 / 设置 …）都这么走 ✓
 *   自己再挂一个监听会多一条平行路径 ✗ 以后排查时分不清谁先谁后 ✓
 */
export function setRailCommands(list: unknown): void {
    items = Array.isArray(list) ? (list as CmdItem[]) : [];
    render();
}

/** ★ 初始化（index.ts 调 ✓）*/
export function setupCmdRail(): void {
    if (!railEl) return;

    // ★★ 弹层的三个关闭时机（B33 ✓）
    //   ① 点外面 ✗（点弹层里 / 点收纳器按钮本身 → 不关 ✓
    //              后者由它自己的 click 处理器 toggle ✓）
    //   ② Esc
    //   ③ ★ 滚动 / 缩放 —— 因为弹层是 position: fixed ✗
    //     它不随内容滚动走 ✓ 不关就会“浮”在原地错位 ✓
    document.addEventListener("click", (e) => {
        if (!popover) return;
        const t = e.target;
        if (t instanceof HTMLElement && (popover.contains(t) || t.closest(".cmd-btn.group"))) {
            return;
        }
        closePopover();
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && popover) closePopover();
    });
    // ★ 捕获阶段 ✗ 任何滚动容器都能触发 ✓
    window.addEventListener("scroll", closePopover, true);
    window.addEventListener("resize", closePopover);

    // ★★ B34：竖条是顶层容器 ✗ 落点判定挂在它身上（纵向 ✓）
    wireContainer(railEl, "", false);

    render(); // 先画一个空态（免得竖条里空荡荡 ✓）
}

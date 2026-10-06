/**
 * command/index.ts —— 自由按钮配置页面的前端（B32 ②）
 *
 * 【★ 为什么表单是程序化生成的？】
 *   选「按钮」还是「收纳器」会让表单【变形状】✗
 *   静态 HTML 写死就得两套来回藏 ✓ 还是生成清楚 ✓
 *
 * 【★★ 一个必须注意的点】
 *   切换类型时要重渲染 ✗ 但【不能把用户填过的东西弄丢】✓
 *   所以顺序永远是：
 *     ① 先从 DOM 读回当前值（collect）✗
 *     ② 再按新类型重画（render）✓
 *   直接 render 就会丢 ✓（这是表单类 UI 的经典坑 ✓）
 *
 * 【消息】（★ 面板自己的私有通道 ✗ 两边都用 payload 包 ✓）
 *   宿主 → 这里：commandDraft { draft, isNew }
 *   这里 → 宿主：commandSave { item } / commandCancel
 */
declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();

const formEl = document.getElementById("form")!;
const saveBtn = document.getElementById("save") as HTMLButtonElement;
const cancelBtn = document.getElementById("cancel") as HTMLButtonElement;
const tipEl = document.getElementById("tip")!;
const toastEl = document.getElementById("toast")!;

/** ★ 一个参数位（跟宿主端 command-store.ts 的 CmdField 一致 ✓）*/
interface CmdField {
    id: string;
    label: string;
    kind: "fixed" | "select" | "any";
    value?: string;
    options?: string[];
    subType?: "text" | "number";
}

/**
 * ★★ 一个按钮 / 收纳器（B33 ✗ 只保留生成时会用到的字段 ✓）
 *
 * ★ 完整版在宿主端 command-store.ts ✗ 这里只是为了让 children
 *   能读进来 / 写出去（保存时宿主会自己 normalize 一遍 ✓）
 */
interface CmdItem {
    id: string;
    label: string;
    hint?: string;
    icon?: string;
    type: "button" | "group";
    command?: string;
    lockCommand?: boolean;
    fields?: CmdField[];
    inputMode?: "serial" | "panel";
    children?: CmdItem[];
}

/** ★ 本地 id（★ 宿主保存时会 normalize ✗ 但生成时必须先有 id ✓）*/
function newId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** ★ 表单状态（唯一数据源 ✗ 控件只是它的投影 ✓）*/
interface Draft {
    id?: string;
    label: string;
    hint: string;
    icon: string;
    type: "button" | "group";
    command: string;
    lockCommand: boolean;
    /** ★★ 参数列表（B32 ③ ✗ 按钮才有 ✓）*/
    fields: CmdField[];
    /** ★ 有参数时的收集方式 */
    inputMode: "serial" | "panel";
    /**
     * ★★ B33：父亲是谁（只有“在收纳器里新建”才有 ✓）
     *
     * 【它带来两条硬约束】
     *   ① type 锁死 button（不能再套收纳 ✓）
     *   ② 父亲 lockCommand=true 时 command 锁死成父亲的 ✓
     * ★ 这两条【保存时宿主还会再校验一遍】✗
     *   （FACTS #5：UI 的禁用永远不可信 ✗）
     */
    parent?: { id: string; label: string; command?: string; lockCommand: boolean };
    /**
     * ★★ B33：已经是它的子按钮（编辑收纳器时读进来 ✓）
     *   ★ 模板生成的结果就直接写在这里 ✗ 保存时一起交给宿主 ✓
     */
    children?: CmdItem[];
}

let draft: Draft = {
    label: "",
    hint: "",
    icon: "",
    type: "button",
    command: "",
    lockCommand: false,
    fields: [],
    inputMode: "serial",
};

let isNew = true;

/** ★★ 正在编辑的参数（null = 没在编辑 ✗ 这时才显示「＋」✓）*/
let editing: CmdField | null = null;
/** -1 = 新增 ✗ >=0 = 改第几个 ✓ */
let editingIndex = -1;

// ── 小工具 ──

function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    cls?: string,
    text?: string,
): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
}

/** ★ 一行：标题 + 说明 + 控件 ✓ */
function row(label: string, desc: string, control: HTMLElement): HTMLElement {
    const r = el("div", "row");
    r.appendChild(el("label", undefined, label));
    if (desc) r.appendChild(el("div", "desc", desc));
    r.appendChild(control);
    return r;
}

function textInput(value: string, placeholder: string, onInput: (v: string) => void): HTMLInputElement {
    const i = el("input") as HTMLInputElement;
    i.type = "text";
    i.value = value;
    i.placeholder = placeholder;
    i.spellcheck = false;
    i.addEventListener("input", () => onInput(i.value));
    return i;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(text: string, err = false): void {
    toastEl.textContent = text;
    toastEl.dataset.show = "1";
    toastEl.dataset.kind = err ? "err" : "ok";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        toastEl.dataset.show = "0";
    }, 2200);
}

// ── 渲染 ──

function render(): void {
    formEl.textContent = "";

    // ★★ 基本信息：一行两个（B32 ③ 用户要求 ✓）
    //   原来四个都独占一行 ✗ 四行高度白白浪费 ✓
    //   改成两行：名字+图标 ✗ 悬停+命令 ✓
    const pair = (a: HTMLElement, b: HTMLElement): HTMLElement => {
        const w = el("div", "pair");
        w.appendChild(a);
        w.appendChild(b);
        return w;
    };

    formEl.appendChild(
        pair(
            row(
                "名字",
                "可留空 ✗ 按钮的话就用命令兑底显示 ✓",
                textInput(draft.label, "（可留空）", (v) => {
                    draft.label = v;
                    validate();
                }),
            ),
            row(
                "图标",
                "emoji（🎛）/ VS Code 图标名（gear）/ 本地图片路径 ✗ 留空用首字 ✓",
                textInput(draft.icon, "🎛 / gear / /home/…/a.png", (v) => {
                    draft.icon = v;
                    renderPreview();
                }),
            ),
        ),
    );

    formEl.appendChild(
        pair(
            row(
                "悬停提示",
                "鼠标停上去时的说明（可留空 ✓）",
                textInput(draft.hint, "例如：在几种工作模式之间切换", (v) => {
                    draft.hint = v;
                }),
            ),
            // ★ 命令只在按钮类型下有意义 ✗ 收纳器的那一格用 placeholder 占位 ✓
            row(
                "命令",
                draft.type === "button"
                    ? "★ 显示时会自动补上前面的 / ✓"
                    : "（收纳器不需要命令 ✗ 只可能有个预设 ✓）",
                (() => {
                    const w = el("div", "withprefix");
                    w.appendChild(el("span", "pfx", "/"));
                    // ★★ B33：父亲勾了“强制”✗ 命令锁死成父亲的 ✓
                    const locked =
                        draft.parent?.lockCommand === true && !!draft.parent.command;
                    if (locked) draft.command = draft.parent!.command!;
                    const inp = textInput(
                        draft.command,
                        draft.type === "button" ? "mode" : "（可留空）",
                        (v) => {
                            draft.command = v.trim().replace(/^\/+/, "");
                            validate();
                        },
                    );
                    if (locked) {
                        inp.disabled = true;
                        inp.title = `命令被收纳器锁死：/${draft.parent!.command}`;
                    }
                    w.appendChild(inp);
                    return w;
                })(),
            ),
        ),
    );

    // ── 类型 ──
    const types = el("div", "types");
    const mkCard = (t: "button" | "group", title: string, desc: string): HTMLElement => {
        const c = el("div", "type-card" + (draft.type === t ? " on" : ""));
        c.appendChild(el("div", "t", title));
        c.appendChild(el("div", "d", desc));
        // ★★ B33：在收纳器里新建 → 两种类型里【只有按钮可选】✓
        if (draft.parent && t === "group") {
            c.classList.add("locked");
            c.title = "收纳器里只能放按钮 ✗ 不能再套收纳器";
        }
        c.addEventListener("click", () => {
            // ★★ B33：type 锁死（不能再套收纳 ✗ 用户定的 ✓）
            if (draft.parent) {
                if (t === "group") toast("收纳器里只能放按钮 ✗ 不能再套收纳器", true);
                return;
            }
            if (draft.type === t) return;
            // ★★ 先收集再重画（否则填过的内容会丢 ✓）
            draft.type = t;
            render();
        });
        return c;
    };
    types.appendChild(mkCard("button", "按钮", "点一下注入一条斜杠命令（可以要求填参数 ✓）"));
    types.appendChild(mkCard("group", "收纳器", "点开弹出一横排按钮 ✗ 用来装一批同类命令 ✓"));
    formEl.appendChild(row("类型", "★ 这个选择会改变下面的表单 ✓", types));

    // ── 按类型分叉 ──
    if (draft.type === "button") {
        formEl.appendChild(el("div", "sect", "按钮"));
        // ★ 命令已经在上面的两行里填了 ✗ 这里只留参数 ✓
        renderFields();
    } else {
        formEl.appendChild(el("div", "sect", "收纳器"));
        // ★★ 这里【不再放“预设命令”输入框】（B32 ③ 用户指出重复 ✓）
        //   上面的「命令」那一格就是它 ✗ 同一个字段不该有两个输入框 ✓
        //   ★ 但两边语义不同，要分清楚：
        //     按钮   → command 必填（就是要注入的那个命令 ✓）
        //     收纳器 → command 可空（只是给干子按钮的预填 ✓）

        const wrap = el("label", "check");
        const cb = el("input") as HTMLInputElement;
        cb.type = "checkbox";
        cb.checked = draft.lockCommand;
        cb.addEventListener("change", () => {
            draft.lockCommand = cb.checked;
        });
        wrap.appendChild(cb);
        const txt = el("div");
        txt.appendChild(el("div", undefined, "强制：里面的按钮只能用这个命令"));
        txt.appendChild(
            el(
                "div",
                "desc",
                draft.command
                    ? `勾上之后 ✗ 往里面加按钮时命令锁死为 /${draft.command} ✗ 不能改 ✓`
                    : "★ 先在上面填了预设命令 ✗ 这个开关才有意义 ✓",
            ),
        );
        wrap.appendChild(txt);
        formEl.appendChild(wrap);

        // ★★ B33：参数模板 + 一键穷举生成子按钮 ✓（用户的想法 ✓）
        //   ★ 复用按钮那套参数编辑 UI ✗ 只是文案叫“模板” ✓
        renderFields(true);
        renderGenerator();
    }

    renderPreview();
    validate();
}

/**
 * ★★ 参数列表（B32 ③）
 *
 * 【用户的设计（原话）】
 *   “给个加号 ✗ 点加号获得一个参数 ✗ 点加号再获得参数”✓
 *   “每个参数要携带哪些信息全分析清楚了”✓
 *
 * 【一个参数携带什么】
 *   标签（面板上显示的名字 ✓）
 *   类型：固定值 / 有限值可选 / 任意值（三种 ✓）
 *   类型相关的内容：
 *     固定值 → 那个值
 *     有限值 → 选项清单（逗号分隔 ✓）
 *     任意值 → 子类型（文本 / 数字 ✓）
 *
 * 【★ 自动识别（用户提的）】
 *   有限值只剩一个选项 → 当固定值看 ✓
 *   （渲染时降级 ✗ 不偷改用户的数据 ✓ 保存时才规范化 ✓）
 */
/**
 * ★★ 把参数模板【穷举】成一堆子按钮（B33 ✓）
 *
 * 【用户的想法】
 *   “收纳器里面加一个 map 清单 ✗ 就是告知它所有的参数的形式……
 *    添加好之后 ✗ 直接重举生成 ✗ 批量生成按钮 ✓
 *    重举到最后一个自由参数 ✗ 如果有自由参数 ✗ 那就弹窗；
 *    如果没有的话 ✗ 就是纯注入 ✓”
 *
 * 【规则】
 *   · fixed  → 写死 ✓
 *   · select → 展开（笛卡尔积 ✓）
 *   · any    → ★ 不参与穷举 ✗ 原样留给运行时弹窗 ✓
 *
 * @returns undefined = 组合数超上限（调用方要提示 ✓）
 */
const GEN_LIMIT = 12;

function enumerateButtons(
    cmd: string,
    fields: CmdField[],
    nameOf: (picks: string[]) => string,
): CmdItem[] | undefined {
    // ① 先算组合数（超限就早退 ✗ 别先展开再发现太多 ✓）
    let total = 1;
    for (const f of fields) {
        if (f.kind === "select") total *= Math.max(1, f.options?.length ?? 0);
        if (total > GEN_LIMIT) return undefined;
    }

    // ② 笛卡尔积（★ picks 与 fields 下标一一对应 ✓）
    let combos: string[][] = [[]];
    for (const f of fields) {
        if (f.kind === "select") {
            const opts = f.options?.length ? f.options : [""];
            combos = combos.flatMap((c) => opts.map((o) => [...c, o]));
        } else if (f.kind === "fixed") {
            combos = combos.map((c) => [...c, f.value ?? ""]);
        } else {
            combos = combos.map((c) => [...c, ""]); // any：占位 ✗ 不展开 ✓
        }
    }

    // ③ 每个组合 → 一个子按钮 ✓
    return combos.map((picks) => ({
        id: newId(),
        label: nameOf(picks),
        type: "button" as const,
        command: cmd,
        // ★ select/fixed → 在这个按钮上变成 fixed ✓
        //   ★★ any → 原样保留 ✗ 点它时弹窗问 ✓
        fields: fields.map((f, i) =>
            f.kind === "any"
                ? { ...f, id: newId() }
                : { id: newId(), label: f.label, kind: "fixed" as const, value: picks[i] },
        ),
    }));
}

/** ★★ 批量生成区（B33 ✗ 只在收纳器下显示 ✓）*/
function renderGenerator(): void {
    formEl.appendChild(el("div", "sect", "批量生成"));

    const info = el("div", "desc");
    const n = draft.fields.length;
    const has = (draft.children ?? []).length;
    if (n === 0) {
        info.textContent =
            "上面加几个参数 ✗ 这里就能一键穷举出一批子按钮 ✓\n" +
            "（也可以跳过这步 ✗ 直接用弹层里的「＋」手动加 ✓）";
    } else {
        let total = 1;
        for (const f of draft.fields) {
            if (f.kind === "select") total *= Math.max(1, f.options?.length ?? 0);
        }
        const anys = draft.fields.filter((f) => f.kind === "any").length;
        info.textContent =
            `将生成 ${total} 个按钮 ✓` +
            (anys
                ? `（有 ${anys} 个自由参数 ✗ 点按钮时会弹窗问 ✓）`
                : "（全是固定值 ✗ 点一下直接注入 ✓）") +
            (has ? `\n★ 已经有 ${has} 个子按钮 ✗ 生成会【整个替换】它们 ✓` : "");
    }
    formEl.appendChild(info);

    const gen = el("button", "fadd", "⚙ 生成按钮");
    gen.addEventListener("click", () => {
        if (draft.fields.length === 0) {
            toast("先在上面加参数", true);
            return;
        }
        const cmd = draft.command.trim();
        // ★★ 名字 = 各选项的【首字】用 - 连起来（B33 用户定的 ✓）
        //   “用它们的第一个字符 ✗ 然后用减号把它们连起来”
        //   苹果 + 红色 → 苹-红
        //   add  + write → a-w
        //   ★ 全部是 fixed（没有任何可选项）→ 名字会空 ✗ 由 displayName 退回 command ✓
        const made = enumerateButtons(cmd, draft.fields, (picks) =>
            picks
                .filter(Boolean)
                .map((s) => [...s][0] ?? "")
                .join("-"),
        );
        if (!made) {
            toast(`组合数超过 ${GEN_LIMIT} ✗ 减少一些选项（或手动加 ✓）`, true);
            return;
        }
        // ★ 把当前选的“输入方式”带给每个生成的按钮 ✓
        //   （只有 any 参数会在运行时弹窗 ✗ 用什么方式填就看它 ✓）
        for (const b of made) b.inputMode = draft.inputMode;
        draft.children = made;
        toast(`已生成 ${made.length} 个按钮 ✓ 记得点[保存] ✓`);
        render();
    });
    formEl.appendChild(gen);

    if (has) {
        const clr = el("button", "fmini danger", `✕ 清空这 ${has} 个子按钮`);
        clr.addEventListener("click", () => {
            draft.children = [];
            render();
        });
        formEl.appendChild(clr);
    }
}

/** @param asTemplate true = 收纳器的“参数模板”✗ 文案不同 ✓ */
function renderFields(asTemplate = false): void {
    formEl.appendChild(el("div", "sect", asTemplate ? "参数模板" : "参数"));

    // ★★ 输入方式【放到参数上面】（B32 ③ 用户要求 ✓）
    //   理由：它在下面的时候 ✗ 参数一多就要先滑下去才能看到 ✓
    //   而且用户说了：“在构造第一个参数的时候，必须完成这个选择”✓
    if (draft.fields.length > 0) {
        const modes = el("div", "types");
        const mkMode = (m: "serial" | "panel", title: string, desc: string): HTMLElement => {
            const c = el("div", "type-card" + (draft.inputMode === m ? " on" : ""));
            c.appendChild(el("div", "t", title));
            c.appendChild(el("div", "d", desc));
            c.addEventListener("click", () => {
                if (draft.inputMode === m) return;
                draft.inputMode = m;
                render();
            });
            return c;
        };
        const n = draft.fields.length;
        modes.appendChild(
            mkMode(
                "serial",
                "串行弹窗",
                n > 1 ? `★ 会连着弹 ${n} 个窗 ✗ 可能影响体验 ✓` : "一个窗就能填完（VS Code 原生 ✓）",
            ),
        );
        modes.appendChild(mkMode("panel", "独立窗口", "一次性把所有参数填完（不弹多个窗 ✓）"));
        formEl.appendChild(row("输入方式", n > 1 ? "★ 参数超过 1 个时弹窗会连弹 ✗ 建议用独立窗口 ✓" : "点按钮后怎么让你填这些参数", modes));
    }

    if (draft.fields.length === 0 && !editing) {
        const d = el("div", "desc");
        d.textContent = asTemplate
            ? "没有参数模板 → 批量生成用不上（但可以先保存 ✗ 再用弹层里的「＋」手动加子按钮 ✓）"
            : "没有参数 → 点这个按钮会直接注入命令 ✓";
        formEl.appendChild(d);
    }

    // ★★ 已添加的参数：一行一个（紧凑 ✗ 不占地方 ✓）
    draft.fields.forEach((f, idx) => {
        const line = el("div", "fline");
        line.appendChild(el("span", "fidx", String(idx + 1)));
        line.appendChild(el("span", "flabel", f.label || "（未命名）"));
        line.appendChild(el("span", "fkind", describeField(f)));
        line.appendChild(el("span", "spacer"));

        const edit = el("button", "fmini", "改");
        edit.title = "修改这个参数";
        edit.addEventListener("click", () => {
            editing = { ...f, options: f.options ? [...f.options] : undefined };
            editingIndex = idx;
            render();
        });
        line.appendChild(edit);

        const del = el("button", "fmini danger", "✕");
        del.title = "删掉这个参数";
        del.addEventListener("click", () => {
            draft.fields.splice(idx, 1);
            render();
        });
        line.appendChild(del);

        formEl.appendChild(line);
    });

    // ★★ 编辑区：要么是“正在编辑”✗ 要么是“＋ 添加参数” ✓
    //   ★ 关键：编辑期间【不显示＋】⇒ 不能同时加两个（用户要求 ✓）
    if (editing) {
        formEl.appendChild(buildFieldEditor(editing));
    } else {
        const add = el("button", "fadd", "＋ 添加参数");
        add.addEventListener("click", () => {
            editing = { id: "", label: "", kind: "fixed", value: "" };
            editingIndex = -1;
            render();
        });
        formEl.appendChild(add);
    }
}

/** ★ 一行里对参数的简短描述 ✓ */
function describeField(f: CmdField): string {
    if (f.kind === "fixed") return `固定值（${f.value || "?"}）`;
    if (f.kind === "select") return `有限值（${(f.options ?? []).join(" / ") || "?"}）`;
    return f.subType === "number" ? "任意值 · 数字" : "任意值 · 文本";
}

/**
 * ★★ 参数的编辑区（就地展开 ✗ 填完就变回一行 ✓）
 *
 * 【为什么不用弹窗？】
 *   用户原话：“添加参数出来一个小页 ✗ 这个页面就放在那儿不动了。
 *            你把字段填完就生成一行 ✗ 短行就好了”✓
 *   ⇒ 就地展开最直接 ✗ 不用跳来跳去 ✓
 */
function buildFieldEditor(f: CmdField): HTMLElement {
    const card = el("div", "fcard");
    card.appendChild(el("div", "fhead", editingIndex >= 0 ? `修改参数 ${editingIndex + 1}` : "新参数"));

    card.appendChild(
        row(
            "标签",
            "收集面板上显示的名字（如“操作” / “路径” ✓）",
            textInput(f.label, "例如：操作", (v) => {
                f.label = v;
                validate();
            }),
        ),
    );

    const kinds = el("div", "kinds");
    const mkKind = (k: CmdField["kind"], text: string, hint: string): HTMLElement => {
        const b = el("button", "kind" + (f.kind === k ? " on" : ""), text);
        b.title = hint;
        b.addEventListener("click", () => {
            if (f.kind === k) return;
            f.kind = k;
            render();
        });
        return b;
    };
    kinds.appendChild(mkKind("fixed", "固定值", "这个位置永远是同一段文本"));
    kinds.appendChild(mkKind("select", "有限值可选", "从几个选项里选一个（下拉框）"));
    kinds.appendChild(mkKind("any", "任意值", "自由输入（可限定要数字）"));
    card.appendChild(row("类型", "★ 决定收集时给用户什么控件 ✓", kinds));

    if (f.kind === "fixed") {
        card.appendChild(
            row(
                "值",
                "每次都固定拼这一串 ✓",
                textInput(f.value ?? "", "例如：add", (v) => {
                    f.value = v;
                    validate();
                }),
            ),
        );
    } else if (f.kind === "select") {
        card.appendChild(
            row(
                "选项",
                "用【正斜杠】分隔 ✗ 如 add / rm ✓（只填一个会被当成固定值 ✓）",
                textInput((f.options ?? []).join(" / "), "add / rm", (v) => {
                    f.options = v
                        .split("/")
                        .map((s) => s.trim())
                        .filter(Boolean);
                    validate();
                }),
            ),
        );
    } else {
        const subs = el("div", "types");
        const mkSub = (t: "text" | "number", text: string): HTMLElement => {
            const c = el("div", "type-card" + ((f.subType ?? "text") === t ? " on" : ""));
            c.appendChild(el("div", "t", text));
            c.addEventListener("click", () => {
                f.subType = t;
                render();
            });
            return c;
        };
        subs.appendChild(mkSub("text", "文本"));
        subs.appendChild(mkSub("number", "数字"));
        card.appendChild(row("子类型", "选数字的话 ✗ 收集时会校验必须是数字 ✓", subs));
    }

    // ★ 确定 / 取消
    const acts = el("div", "facts");
    const cancel = el("button", "fmini", "取消");
    cancel.addEventListener("click", () => {
        editing = null;
        editingIndex = -1;
        render();
    });
    const ok = el("button", "fok", editingIndex >= 0 ? "确定修改" : "确定添加");
    ok.addEventListener("click", () => {
        if (!editing) return;
        if (editingIndex >= 0) draft.fields[editingIndex] = editing;
        else draft.fields.push(editing);
        editing = null;
        editingIndex = -1;
        render();
    });
    acts.appendChild(el("span", "spacer"));
    acts.appendChild(cancel);
    acts.appendChild(ok);
    card.appendChild(acts);

    return card;
}

/** ★ 图标预览（让人立刻看到"首字兜底"长什么样 ✓）*/function renderPreview(): void {
    let host = document.getElementById("icon-preview");
    if (!host) {
        host = el("div", "row");
        host.id = "icon-preview";
        formEl.appendChild(host);
    }
    host.textContent = "";
    const icon = draft.icon.trim();
    const shown = icon || [...draft.label][0] || "?";
    host.appendChild(
        el(
            "div",
            "desc",
            icon
                ? `图标：${shown}${/^[a-z][a-z0-9-]*$/.test(icon) ? "（按 VS Code 图标名解析 ✗ 认不出就显示成空 ✓）" : "（直接当字符用 ✓）"}`
                : `图标留空 → 用名字首字：${shown}`,
        ),
    );
}

/**
 * ★ 校验（不通过就禁用保存 ✓ 并说明原因 ✓）
 *
 * 【★★ 必填项只有“命令”（用户定的 ✓）】
 *   原话：“名字和图标其实它也不应该是必填项 ✗ 包括悬停也不是必填项，
 *         命令才是必填项。你实在不行 ✗ 你直接拿命令拿去渲染不就完事儿了？”✓
 * ⇒ 按钮：命令必填 ✗ 其余可空（容器渲染时用命令兑底名字 ✓）
 * ⇒ 收纳器：它没有命令 ✗ 所以才需要名字（否则没法显示 ✓）
 */
function validate(): void {
    let err = "";
    if (draft.type === "button") {
        if (!draft.command.trim()) err = "按钮必须填命令";
        else if (draft.fields.length > 0) {
            for (let i = 0; i < draft.fields.length; i++) {
                const f = draft.fields[i];
                const at = `参数 ${i + 1}`;
                if (!f.label.trim()) {
                    err = `${at}：标签不能为空`;
                    break;
                }
                if (f.kind === "fixed" && !(f.value ?? "").trim()) {
                    err = `${at}：固定值不能为空`;
                    break;
                }
                if (f.kind === "select" && (f.options ?? []).length === 0) {
                    err = `${at}：有限值至少要有一个选项`;
                    break;
                }
            }
        }
    } else if (!draft.label.trim()) {
        // ★ 收纳器没有命令 ✗ 只能靠名字显示 ✓
        err = "收纳器必须填名字（它没有命令可用 ✓）";
    }
    tipEl.textContent = err;
    saveBtn.disabled = !!err;
}

// ── 动作 ──

saveBtn.addEventListener("click", () => {
    const label = draft.label.trim();
    if (draft.type === "button" && !draft.command.trim()) return;
    const item: Record<string, unknown> = {
        label,
        type: draft.type,
    };
    if (draft.id) item.id = draft.id;
    if (draft.hint.trim()) item.hint = draft.hint.trim();
    if (draft.icon.trim()) item.icon = draft.icon.trim();
    if (draft.command.trim()) item.command = draft.command.trim();
    if (draft.type === "group" && draft.lockCommand) item.lockCommand = true;
    // ★★ 参数（B32 ③）
    //   ★ 自动识别：有限值只剩 1 个选项 → 当固定值看（用户提的 ✓）
    if (draft.type === "button" && draft.fields.length > 0) {
        item.fields = draft.fields.map((f) => {
            if (f.kind === "select" && (f.options ?? []).length === 1) {
                return { id: f.id, label: f.label, kind: "fixed", value: f.options![0] };
            }
            return { ...f };
        });
        item.inputMode = draft.inputMode;
    }
    // ★★ B33：收纳器的子按钮（可能是模板生成出来的 ✓）
    //   ★ 读进来时必须带回来 ✗ 否则保存会把旧的 children 抹掉 ✓
    if (draft.type === "group") {
        item.children = draft.children ?? [];
    }
    // ★★ B33：带上父亲 id ✗ 宿主据此把子按钮塞进 children ✓
    //   （即使配置页被绕过 ✗ 宿主也会自己查一遍 ✓）
    vscode.postMessage({
        kind: "commandSave",
        payload: { item, parentId: draft.parent?.id },
    });
});

cancelBtn.addEventListener("click", () => {
    vscode.postMessage({ kind: "commandCancel" });
});

// ── 宿主 → 前端 ──

window.addEventListener("message", (e: MessageEvent) => {
    const msg = e.data as { kind?: string; payload?: unknown };
    if (msg?.kind === "commandDraft") {
        const p = msg.payload as { draft?: Partial<Draft>; isNew?: boolean };
        const d = p.draft ?? {};
        isNew = p.isNew === true;
        // ★★ B33：父亲信息（在收纳器里新建时才有 ✓）
        const rawParent = (d as { parent?: unknown }).parent as
            | { id?: unknown; label?: unknown; command?: unknown; lockCommand?: unknown }
            | undefined;
        const parent =
            rawParent && typeof rawParent.id === "string"
                ? {
                      id: rawParent.id,
                      label: typeof rawParent.label === "string" ? rawParent.label : "",
                      command:
                          typeof rawParent.command === "string" ? rawParent.command : undefined,
                      lockCommand: rawParent.lockCommand === true,
                  }
                : undefined;
        draft = {
            id: typeof d.id === "string" ? d.id : undefined,
            label: typeof d.label === "string" ? d.label : "",
            hint: typeof d.hint === "string" ? d.hint : "",
            icon: typeof d.icon === "string" ? d.icon : "",
            type: d.type === "group" ? "group" : "button",
            command: typeof d.command === "string" ? d.command : "",
            lockCommand: d.lockCommand === true,
            fields: Array.isArray(d.fields) ? d.fields : [],
            inputMode: d.inputMode === "panel" ? "panel" : "serial",
            parent,
            // ★★ B33：已有的子按钮（编辑收纳器时要带回来 ✗ 否则保存会抹掉 ✓）
            children: Array.isArray((d as { children?: unknown }).children)
                ? ((d as { children?: CmdItem[] }).children ?? [])
                : [],
        };
        // ★ 重置编辑状态（换了一个按钮 ✗ 不能还停在旧的编辑里 ✓）
        editing = null;
        editingIndex = -1;
        cancelBtn.textContent = isNew ? "取消" : "取消修改";
        saveBtn.textContent = isNew ? "创建" : "保存";
        render();
        return;
    }
    if (msg?.kind === "commandToast") {
        const p = msg.payload as { text?: string; err?: boolean };
        toast(p.text ?? "", p.err === true);
    }
});

// ★ 告诉宿主"我准备好了" → 它会把草稿发过来 ✓
vscode.postMessage({ kind: "ready" });

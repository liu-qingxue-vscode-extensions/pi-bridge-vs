/**
 * settings-panel.ts —— 设置面板（B24）
 *
 * 【它管的是 pi 的 settings.json】✗（不是 VS Code 的配置 ✓）
 *   RPC 没有 settings 接口 ✗ → 宿主自己读写文件 ✓
 *   （所以这里的职责很单纯：画表单 + 收集改动 + 交给宿主 ✓）
 *
 * 【交互（模仿 VS Code 的设置页 ✓ 用户定的 ✓）】
 *   · 分组显示（模型 / 行为 / 环境 / 技能 ✓）
 *   · 每项一行：左边标签 + 描述，右边控件 ✓
 *   · 控件按类型：文本框 / 数字 / 复选框 / 下拉 / 列表 ✓
 *   · ★ 改动【只记在内存】✗ 直到点保存 ✓（用户：“读一次，内存维护，保存写入”✓）
 *   · 改过的项左边一条黄线 ✓ 保存按钮亮起 ✓
 *   · 「重新读取」= 丢弃改动，重新从磁盘拉 ✓
 */
// ★★ B35：独立面板【自己取 DOM】✗ 不再走 dom.js
//   （dom.js 是【侧栏聊天页】的 DOM 表 ✗ 这个面板是另一个页面 ✓）
declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();

const settingsBody = document.getElementById("settings-body")!;
const settingsSave = document.getElementById("settings-save") as HTMLButtonElement;
const settingsReload = document.getElementById("settings-reload") as HTMLButtonElement;
const settingsPath = document.getElementById("settings-path")!;

// ★ 不再需要：
//   btnSettings      （⚙ 侧栏按钮 ✗ 留在侧栏 ✓）
//   settingsPanel    （面板容器 ✗ 独立面板就是整页 ✓）
//   activatePanel / deactivatePanel / registerPanel（侧栏互斥 ✗ 改由宿主管 ✓）

interface FieldView {
    key: string;
    label: string;
    desc?: string;
    kind: "text" | "number" | "boolean" | "select" | "list" | "extlist" | "providers";
    options?: { value: string; label: string; title?: string }[];
    min?: number;
    max?: number;
    needsRestart?: boolean;
    value: unknown;
    exists?: boolean;
}

/** ★ 内存里的编辑缓冲区（只有【改过】的项才进来 ✓）*/
const dirty = new Map<string, unknown>();
/** 原始值快照（用来判断"改回了原样"✓ 就不用提交了 ✓）*/
let original = new Map<string, unknown>();
let bodyBuilt = false;

function isEditing(): boolean {
    // ★★ B35：独立面板【没有收起状态】✗ 开着就是编辑态 ✓
    //   （原来靠 settingsPanel 上的 .collapsed 类判断 ✓）
    return true;
}

function markDirty(key: string, value: unknown, row: HTMLElement): void {
    const orig = original.get(key);
    // ★ 改回原样 → 取消 dirty ✗（不然会写一堆没意义的字段 ✓）
    if (JSON.stringify(orig) === JSON.stringify(value)) {
        dirty.delete(key);
        row.dataset.dirty = "false";
    } else {
        dirty.set(key, value);
        row.dataset.dirty = "true";
    }
    settingsSave.disabled = dirty.size === 0;
    settingsSave.textContent = dirty.size ? `保存 (${dirty.size})` : "保存";
}

/** 建一行「标签 + 控件」✓ */
function buildRow(f: FieldView): HTMLElement {
    const row = document.createElement("div");
    row.className = "s-item";
    row.dataset.dirty = "false";

    const labelBox = document.createElement("div");
    labelBox.className = "s-label";
    const name = document.createElement("span");
    name.textContent = f.label;
    labelBox.appendChild(name);
    if (f.desc) {
        const d = document.createElement("span");
        d.className = "s-desc";
        d.textContent = f.desc;
        labelBox.appendChild(d);
    }
    if (f.needsRestart) {
        const r = document.createElement("span");
        r.className = "s-desc";
        r.textContent = "⚠ 改后需重启 pi";
        labelBox.appendChild(r);
    }

    const ctl = document.createElement("div");
    ctl.className = "s-ctl";

    if (f.kind === "boolean") {
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = f.value === true;
        cb.addEventListener("change", () => markDirty(f.key, cb.checked, row));
        ctl.appendChild(cb);
    } else if (f.kind === "select") {
        const sel = document.createElement("select");
        for (const o of f.options ?? []) {
            const op = document.createElement("option");
            op.value = o.value;
            op.textContent = o.label;
            sel.appendChild(op);
        }
        sel.value = String(f.value ?? "");
        // ★★ 容错：值【不在候选里】也要能显示 ✗（B24 踩到的坑 ✓）
        //   场景：settings 里的值不在模型目录里（坏了 / 手改的 / 已卸载 ✓）
        //   → 原生的 select 会【找不到匹配项】→ 显示成空 ✓
        //     用户看到：“保存后它永远是空的”✓
        //   → 补一个选项把当前值显出来 ✓ 并标明它不在列表里 ✓
        if (!sel.value && f.value) {
            const extra = document.createElement("option");
            extra.value = String(f.value);
            extra.textContent = `${String(f.value)}（当前值 · 不在候选列表里）`;
            sel.appendChild(extra);
            sel.value = String(f.value);
        }
        sel.addEventListener("change", () => markDirty(f.key, sel.value, row));
        ctl.appendChild(sel);
    } else if (f.kind === "number") {
        const inp = document.createElement("input");
        inp.type = "number";
        if (f.min !== undefined) inp.min = String(f.min);
        if (f.max !== undefined) inp.max = String(f.max);
        inp.value = f.value === undefined || f.value === null ? "" : String(f.value);
        inp.addEventListener("input", () => {
            const v = inp.value.trim();
            markDirty(f.key, v === "" ? "" : Number(v), row);
        });
        ctl.appendChild(inp);
    } else if (f.kind === "list") {
        // ★ 列表：每项一行（值 + ✕）+ 底部一个「添加」输入 ✓
        const box = document.createElement("div");
        box.className = "s-list";
        const items: string[] = Array.isArray(f.value) ? (f.value as string[]).slice() : [];

        const renderItems = () => {
            box.textContent = "";
            items.forEach((it, i) => {
                const line = document.createElement("div");
                line.className = "s-list-item";
                const code = document.createElement("span");
                code.textContent = it;
                const del = document.createElement("button");
                del.textContent = "✕";
                del.title = "删除这一项";
                del.addEventListener("click", () => {
                    items.splice(i, 1);
                    renderItems();
                    markDirty(f.key, items.slice(), row);
                });
                line.appendChild(code);
                line.appendChild(del);
                box.appendChild(line);
            });

            // ★ 有候选列表时 → 给一个下拉“选一个添加”✗（不用手敲 ✓）
            //   没有候选（如 packages）→ 退回手输框 ✓
            if (f.options?.length) {
                const sel = document.createElement("select");
                const empty = document.createElement("option");
                empty.value = "";
                empty.textContent = "＋ 从列表选一个添加…";
                sel.appendChild(empty);
                for (const o of f.options) {
                    // ★ 已经在列表里的就不重复出现 ✓
                    if (items.includes(o.value)) continue;
                    const op = document.createElement("option");
                    op.value = o.value;
                    op.textContent = o.label;
                    sel.appendChild(op);
                }
                sel.addEventListener("change", () => {
                    if (!sel.value) return;
                    items.push(sel.value);
                    renderItems();
                    markDirty(f.key, items.slice(), row);
                });
                box.appendChild(sel);
            } else {
                const add = document.createElement("input");
                add.type = "text";
                add.placeholder = "添加一项后回车…";
                add.addEventListener("keydown", (e) => {
                    if (e.key !== "Enter") return;
                    const v = add.value.trim();
                    if (!v) return;
                    items.push(v);
                    add.value = "";
                    renderItems();
                    markDirty(f.key, items.slice(), row);
                });
                box.appendChild(add);
            }
        };
        renderItems();
        ctl.appendChild(box);
    } else if (f.kind === "providers") {
        // ★ 供应商凭据（B24）—— 看 / 增 / 删 ✓
        //   ★ oauth 完全只读 ✗（用户定的：“做成灰色的不可改项目”✓）
        const box = document.createElement("div");
        box.className = "s-providers";
        const entries = (Array.isArray(f.value) ? f.value : []) as {
            provider: string;
            type: string;
            editable: boolean;
            masked?: string;
            expiresAt?: string;
        }[];

        for (const e of entries) {
            const line = document.createElement("div");
            line.className = "sp-item" + (e.editable ? "" : " readonly");

            const name = document.createElement("span");
            name.className = "sp-name";
            name.textContent = e.provider;

            const type = document.createElement("span");
            type.className = "sp-type";
            type.textContent = e.type;

            line.appendChild(name);
            line.appendChild(type);

            if (e.editable) {
                // ★★ 不显示 key（连掩码也不 ✓ B24 用户要求 ✓）
                //   列表里只说“已配置”✗
                //   想确认是哪一把？→ 【悬停看 title】✓
                const mk = document.createElement("span");
                mk.className = "sp-masked";
                mk.textContent = "已配置";
                mk.title = e.masked
                    ? `已配置（${e.masked}）` // ★ 只在悬停时露半截 ✓
                    : "已配置";
                line.appendChild(mk);

                const del = document.createElement("button");
                del.className = "sp-del";
                del.textContent = "删除";
                del.title = "删除这个 API key（= 登出 ✓）";
                del.addEventListener("click", (ev) => {
                    ev.stopPropagation();
                    vscode.postMessage({ kind: "removeAuth", provider: e.provider });
                });
                line.appendChild(del);
            } else {
                const note = document.createElement("span");
                note.className = "sp-note";
                note.textContent = e.expiresAt ? `只会读 · 过期 ${e.expiresAt}` : "只读";
                note.title = "OAuth 凭据不能在插件里改 ✗\n要用终端：pi auth login <provider>";
                line.appendChild(note);
            }
            box.appendChild(line);
        }

        // ★ 添加 api key（一行两个输入框 + 按钮 ✓）
        const add = document.createElement("div");
        add.className = "sp-add";
        const prov = document.createElement("input");
        prov.type = "text";
        prov.placeholder = "供应商（如 deepseek）";
        const key = document.createElement("input");
        key.type = "password"; // ★ 密码框（不明文显示 ✓）
        key.placeholder = "API key";
        const btn = document.createElement("button");
        btn.textContent = "添加 / 更新";
        btn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            const p = prov.value.trim();
            const k = key.value.trim();
            if (!p || !k) return;
            vscode.postMessage({ kind: "addApiKey", provider: p, key: k });
            key.value = "";
        });
        add.append(prov, key, btn);
        box.appendChild(add);
        ctl.appendChild(box);
    } else if (f.kind === "extlist") {        // ★ 已装扩展的启用/停用（B24 ✓）
        //   值是一个字符串数组（= 已启用的 ✓）
        //   而【全部候选】在 f.options 里 ✓ 所以【每个包都能看到一个复选框】✗
        //   （而不是“已启用列表 + 添加框”✗ 那样看不出哪些装了 ✓）
        const box = document.createElement("div");
        box.className = "s-extlist";
        const enabledSet = new Set(Array.isArray(f.value) ? (f.value as string[]) : []);
        const others = (f.value as string[] | undefined)?.filter(
            (x) => !(f.options ?? []).some((o) => o.value === x),
        );
        const all = [
            ...(f.options ?? []),
            // ★ settings 里有、但磁盘上找不到的（如 git: 或已卸载 ✓）也列出来 ✗
            ...(others ?? []).map((x) => ({ value: x, label: x + "（不在本地 npm 目录）" })),
        ];
        for (const o of all) {
            const line = document.createElement("label");
            line.className = "s-ext-item";
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = enabledSet.has(o.value);
            cb.addEventListener("change", () => {
                if (cb.checked) enabledSet.add(o.value);
                else enabledSet.delete(o.value);
                // ★ 保持原有顺序 + 新启用的追加在后面 ✓（用户看不出差异 ✓）
                const arr = all.filter((x) => enabledSet.has(x.value)).map((x) => x.value);
                markDirty(f.key, arr, row);
            });
            const txt = document.createElement("span");
            txt.textContent = o.label;
            txt.title = o.value;
            line.appendChild(cb);
            line.appendChild(txt);
            box.appendChild(line);
        }
        ctl.appendChild(box);
    } else {
        const inp = document.createElement("input");
        inp.type = "text";
        inp.value = String(f.value ?? "");
        inp.addEventListener("input", () => markDirty(f.key, inp.value, row));
        ctl.appendChild(inp);
    }

    row.appendChild(labelBox);
    row.appendChild(ctl);
    return row;
}

/** 收到宿主推来的设置 → 渲染 ✓ */
export function renderSettings(p: {
    path?: string;
    groups?: { title: string; items: FieldView[] }[];
}): void {
    settingsPath.textContent = p.path ?? "";
    settingsPath.title = p.path ?? "";
    dirty.clear();
    original = new Map();
    settingsSave.disabled = true;
    settingsSave.textContent = "保存";
    settingsBody.textContent = "";

    for (const g of p.groups ?? []) {
        const t = document.createElement("div");
        t.className = "sg-title";
        t.textContent = g.title;
        t.dataset.collapsed = "false";
        // ★ 点标题 → 收缩/展开该组（B24 用户要求 ✓）
        //   ★ 状态不做持久化 ✗（重新打开就展开 ✓ 简单且不意外 ✓）
        const body = document.createElement("div");
        body.className = "sg-body";
        t.addEventListener("click", () => {
            const nowCollapsed = t.dataset.collapsed !== "true";
            t.dataset.collapsed = nowCollapsed ? "true" : "false";
            body.classList.toggle("collapsed", nowCollapsed);
        });
        settingsBody.appendChild(t);
        for (const f of g.items) {
            original.set(f.key, f.value);
            body.appendChild(buildRow(f));
        }
        settingsBody.appendChild(body);
        // ★ 标题也提供一个“折叠”的快捷？✗ 不用 ✗（点标题就行 ✓）
        void g;
    }
    bodyBuilt = true;
}

/**
 * ★★ B35：请求宿主【重新读磁盘并推数据】✗
 *
 * 【★ 为什么不再叫 setSettingsOpen？】
 *   原来它同时干两件事：
 *     ① 控制侧栏那个面板的显隐（加/去 .collapsed ✓）
 *     ② 通知宿主去读文件 ✓
 *   独立面板之后 ✗ ① 不再归前端管（开关 = WebviewPanel 的创建/销毁 ✓）
 *   ⇒ 只剩 ② ✗ 名字也就跟着改了 ✓
 *
 * 【为什么每次都重读？】
 *   pi 自己也会写这个文件（lastChangelogVersion 等 ✓）
 *   缓存一份就会显示旧值 ✗ 而文件很小 ✓ 读它几乎免费 ✓
 */
export function refreshSettings(): void {
    // ★★ B35：发 reloadSettings 而不是 openSettings ✗
    //   后者现在的语义是“把面板叫到前面来”（宿主 → showExclusive ✓）
    //   而我们要的是“重读磁盘并重推” ✗ 两者分开 ✓
    vscode.postMessage({ kind: "reloadSettings" });
}

/**
 * 绑定面板内的三个交互（入口调用一次 ✓）
 * 【★ 相比赛栏版少了什么？】
 *   ✗ registerPanel        —— 侧栏那套互斥 ✗ 现在由宿主管（B35 ④ ✓）
 *   ✗ btnSettings 的点击    —— ⚙ 按钮【留在侧栏】✗ 它发 openSettings ✓
 *   ✗ document 的“点外面/点空白收起”
 *     —— 独立面板不需要 ✗ 换成【失焦自动关闭】才合理（B35 ⑤ ✓）
 *   ✗ isEditing / dirty 检查  —— 那是“点外面”的守卫 ✗ 一起去了 ✓
 *
 * 【★ 为什么没有“关闭”按钮？】
 *   面板本身就是个 tab ✗ 关它用 VS Code 自己的叉 ✓ 不需要面板里再放一个 ✓
 */
export function bindSettingsPanel(): void {
    // ★ 重新读取：丢弃本地位改动 + 重新拉一份 ✓
    settingsReload.addEventListener("click", () => {
        dirty.clear();
        settingsSave.disabled = true;
        settingsSave.textContent = "保存";
        refreshSettings();
    });

    // ★ 保存：把【改过的】项一次性交给宿主 ✓
    //   （宿主自己读-改-写 settings.json ✗ 只改我们关心的字段 ✓）
    settingsSave.addEventListener("click", () => {
        if (!dirty.size) return;
        const values: Record<string, unknown> = {};
        for (const [k, v] of dirty) values[k] = v;
        vscode.postMessage({ kind: "saveSettings", values });
    });

    // ★★ B35：告诉宿主“我准备好了”→ 请推数据 ✓
    //   （照抄会话 / 交互 / 技能 / 命令面板的握手 ✓）
    //   ★ 名字叫 settingsReady ✗ 不用 ready（聊天页已占用 ✓）
    vscode.postMessage({ kind: "settingsReady" });
}

/**
 * ★★ B35：宿主 → 前端的消息入口
 *
 * 【★ 为什么必须补这个？】（本次接手查出来的最大一个洞 ✓）
 *   前一段把面板搬过来了 ✗ 但【忘了挂消息监听】✓
 *   ⇒ 打开面板 → 前端发 settingsReady → 宿主 postSettings() ✓
 *     → 推了 "settings" 消息 ✗ 而前端【根本没在听】✓
 *     → 面板永远是空的 ✓
 *   ★ 对照：sessions / skills / command / interaction 四个面板
 *     都有这一句 addEventListener("message"…) ✗ 就设置面板漏了 ✓
 */
window.addEventListener("message", (e: MessageEvent) => {
    const msg = e.data as { kind?: string; payload?: unknown };
    // ① 宿主推来的【设置内容】（路径 + 分组 ✓）→ 整页重画
    if (msg?.kind === "settings") {
        renderSettings((msg.payload ?? {}) as Parameters<typeof renderSettings>[0]);
        return;
    }
    // ② 宿主推来的【整份样式变量】
    //   场景：用户在 VS Code 设置里改了【设置面板的字号 / 内边距】✓
    //   ★ 不处理的话：改完要重开面板才看得到 ✓
    if (msg?.kind === "styleVars") {
        applyStyleVars((msg.payload ?? {}) as Record<string, string>);
        return;
    }
});

/**
 * 覆盖式应用整份 CSS 变量（先清掉旧的 --pi-* ✗ 再写新的 ✓）
 *
 * 【★ 为什么先清？】
 *   宿主推的是【整份】✗ 若只往上叠：用户把某项配置清空 / 删掉后
 *   旧值会残留 ✗ 表现像“改不回去”✓
 * 【★ 相比赛栏那份少了什么？】
 *   侧栏的 applyStyleVars 还要切开关类（centered / no-arg-scroll …✗
 *   那些是【工具气泡】的行为 ✗ 设置面板不需要 ✓
 */
function applyStyleVars(vars: Record<string, string>): void {
    const root = document.documentElement;
    const names: string[] = [];
    for (let i = 0; i < root.style.length; i++) names.push(root.style[i]);
    for (const n of names) {
        if (n.startsWith("--pi-")) root.style.removeProperty(n);
    }
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
}

// ★★ B35：本文件就是入口（esbuild 拿它当 entry ✗ 见 build-webview.mjs ✓）
//   ⇒ 跟会话面板一样【顶层直接启动】✗ 不需要别人来调 setup ✓
//   （前一段写了 setupSettingsPanel() 但【没有入口去调它】✗
//     所以保存 / 重读两个按钮都是死的 ✓ 本文件末尾自己叫自己 ✓）
bindSettingsPanel();


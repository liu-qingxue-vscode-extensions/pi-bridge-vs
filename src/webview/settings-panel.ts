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
import {
    btnSettings,
    settingsPanel,
    settingsBody,
    settingsSave,
    settingsReload,
    settingsPath,
} from "./dom.js";
import { vscode } from "./vscode-api.js";
import { activatePanel, deactivatePanel, registerPanel } from "./panels.js";

interface FieldView {
    key: string;
    label: string;
    desc?: string;
    kind: "text" | "number" | "boolean" | "select" | "list" | "extlist";
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
    return !settingsPanel.classList.contains("collapsed");
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
    } else if (f.kind === "extlist") {
        // ★ 已装扩展的启用/停用（B24 ✓）
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

export function setSettingsOpen(open: boolean): void {
    settingsPanel.classList.toggle("collapsed", !open);
    if (!open) {
        deactivatePanel("settings");
        return;
    }
    // ★ 互斥（B25）：打开自己 → 收起其他面板 ✓
    activatePanel("settings");
    // ★ 每次打开都重新读一遍磁盘 ✗（pi 也可能改过它 ✓）
    vscode.postMessage({ kind: "openSettings" });
}

export function setupSettingsPanel(): void {
    // ★ 注册进面板协调器（B25）
    registerPanel("settings", () => setSettingsOpen(false));
    // ★★ 关键：必须 stopPropagation ✗（B24 踩到的坑 ✓）
    //   否则同一次 click 会继续冒泡到下面的 document 监听 ✓
    //   而 ⚙ 本身不在 #settings-panel 里 → 被当成“点外面”→ 【刚打开就被关】✗
    //   （用户报的“设置按钮又没用了”✓）
    btnSettings.addEventListener("click", (e) => {
        e.stopPropagation();
        setSettingsOpen(!isEditing());
    });
    // ✕ 关闭按钮【已删】（B24 用户要求 ✓）—— 点 ⚙ 就能收起 ✓ 不需要两个关法 ✓
    settingsReload.addEventListener("click", () => {
        dirty.clear();
        settingsSave.disabled = true;
        settingsSave.textContent = "保存";
        vscode.postMessage({ kind: "openSettings" });
    });
    settingsSave.addEventListener("click", () => {
        if (!dirty.size) return;
        const values: Record<string, unknown> = {};
        for (const [k, v] of dirty) values[k] = v;
        vscode.postMessage({ kind: "saveSettings", values });
    });

    // ★ 点面板外 / 点面板内【空白】→ 收起（B24 用户要求 ✓）
    //
    // 【为什么用“排除法”而不是 stopPropagation？】
    //   和会话面板 / 通知面板同一套模式 ✓（B15 的经验 ✓）
    //
    // ★★ 只排除【真正需要点的控件】✗（B24 修正 ✓）
    //   之前把 .s-item / .sg-title 也排除了 ✗ → 而它们占满面板 ✓
    //   → 结果【点面板内任何空白都不收】✓
    //     用户：“设置面板缺少一个点击外部收起的功能”✓ 就是它 ✓
    //   → 现在只排除 button / input / select / textarea（真正在操作的东西 ✓）
    //     其余（标签、描述、分组标题的空白区）都已经会收 ✓
    document.addEventListener("click", (e) => {
        if (!isEditing()) return;
        const t = e.target as HTMLElement | null;
        if (
            t?.closest(
                "#settings-panel button, #settings-panel input, #settings-panel select, #settings-panel textarea, #btn-settings",
            )
        ) {
            return;
        }
        // ★★ 有未保存的改动 → 【不收起】✗
        //   为什么不用 window.confirm？
        //     · webview 里 confirm 行为不可靠（可能被禁 ✓），而且弹窗体验也差 ✓
        //     · 反正面板里已有【黄线 + “保存 (N)”】做视觉提醒 ✓
        //   → 直接不收 ✓ 用户只能先保存 / 重新读取 ✓ 不会丢改动 ✓
        if (dirty.size) {
            settingsSave.focus();
            return;
        }
        setSettingsOpen(false);
    });

    void bodyBuilt;
}

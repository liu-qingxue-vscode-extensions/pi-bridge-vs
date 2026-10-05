/**
 * skills/index.ts —— 技能面板的前端（B31 ✓）
 *
 * 【★ 交互设计（用户定的 ✓）】
 *   · 单击一条技能  → 行为由配置项决定（注入输入框 / 直接发送 ✓）
 *   · ★ 每项右侧两个按钮 ✗：
 *       「注入输入框」/「直接发送」—— 反向动作（语义随配置翻转 ✓ 四个字写清楚 ✓）
 *       「删除」—— ★ 只对【自定义技能】显示 ✓（别人包的删不掉 ✓）
 *   · ★ 右键 → 直接跳转打开内容 ✗ 不做内嵌下拉 ✓（用户明确要求 ✓）
 *       自定义技能 → 「查看 / 修改内容」→ VS Code 编辑器打开磁盘文件 ✓（可改可存 ✓）
 *       非自定义   → 「查看内容」→ VS Code 打开【未命名预览】✓（改不到原文件 ✓）
 *   · ★ 点击要有 toast 反馈 ✗（效果发生在侧栏 ✗ 这里看不见 ✓）
 *
 * 【★ 为什么不内嵌展开？】用户：“查看内容是下拉这个东西 ✗ 下拉这个东西不要啊 ✓”
 *   → 内容可能很长 ✗ 内嵌会把列表撑得很乱 ✓ 直接跳编辑器更舒服 ✓
 */
import { showContextMenu } from "../webview/context-menu.js";

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();

const listEl = document.getElementById("list")!;
const countEl = document.getElementById("count")!;
const reloadBtn = document.getElementById("reload") as HTMLButtonElement;
const toastEl = document.getElementById("toast")!;

interface SkillView {
    name: string;
    description?: string;
    source?: string;
    path?: string;
    /** ★ 用户自己的（可改可删 ✓）还是扩展包的（只读 ✓）*/
    mine?: boolean;
}

let skills: SkillView[] = [];
let clickAction: "insert" | "send" = "insert";

// ── toast ──
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(text: string, err = false): void {
    toastEl.textContent = text;
    toastEl.dataset.show = "1";
    toastEl.dataset.kind = err ? "err" : "ok";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        toastEl.dataset.show = "0";
    }, 2400);
}

// ── 动作 ──
function doInsert(s: SkillView): void {
    vscode.postMessage({ kind: "skillInsert", name: s.name });
    toast(`已注入聊天输入框：${s.name}（切到侧栏聊天看 ✓）`);
}
function doSend(s: SkillView): void {
    vscode.postMessage({ kind: "skillAsCommand", name: s.name });
    toast(`已作为命令发送：/skill:${s.name}`);
}
function openContent(s: SkillView): void {
    vscode.postMessage({ kind: "skillOpenFile", name: s.name });
    toast(s.mine ? `在编辑器里打开（可改可存 ✓）：${s.name}` : `只读预览：${s.name}`);
}
function delSkill(s: SkillView): void {
    vscode.postMessage({ kind: "skillDelete", name: s.name });
}

/** ★ 悬停提示 ✓ */
function hoverTip(s: SkillView): string {
    const click = clickAction === "insert" ? "注入聊天输入框" : "直接作为命令发送";
    return (
        `单击「${s.name}」→ ${click}\n` +
        `右键 → ${s.mine ? "查看 / 修改内容（可改可存 ✓）" : "查看内容（只读 ✓）"}\n` +
        (s.mine ? "右侧「删除」→ 删掉这个技能（进回收站 ✓）\n" : "") +
        `（单击行为在【设置 → 行为 → 技能：单击行为】里改 ✓）`
    );
}

function mkBtn(text: string, title: string, cls = ""): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = "sk-btn " + cls;
    b.textContent = text;
    b.title = title;
    return b;
}

function render(): void {
    listEl.textContent = "";
    countEl.textContent = skills.length ? `${skills.length} 个技能` : "";

    if (skills.length === 0) {
        const empty = document.createElement("div");
        empty.className = "sk-loading";
        empty.textContent = "还没有技能（点下面的「＋」新建一个 ✓）";
        listEl.appendChild(empty);
        // ★ 不要 return ✗ 下面还要加“＋”那一项 ✓
    }

    for (const s of skills) {
        const row = document.createElement("div");
        row.className = "sk-item " + (s.mine ? "mine" : "readonly");
        row.title = hoverTip(s);

        const main = document.createElement("div");
        main.className = "sk-main";
        const name = document.createElement("div");
        name.className = "sk-name";
        name.textContent = s.name;
        const desc = document.createElement("div");
        desc.className = "sk-desc";
        desc.textContent = s.description ?? "（没有描述）";
        main.append(name, desc);
        if (s.source) {
            const src = document.createElement("div");
            src.className = "sk-src";
            src.textContent = s.source + (s.mine ? "" : "（只读 ✗ 扩展包提供 ✓）");
            main.appendChild(src);
        }
        row.appendChild(main);

        // ★★ 反向按钮 ✗ 四个字写清楚 ✓
        const btn = mkBtn(
            clickAction === "insert" ? "直接发送" : "注入输入框",
            hoverTip(s),
        );
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            if (clickAction === "insert") doSend(s);
            else doInsert(s);
        });
        row.appendChild(btn);

        // ★ 删除按钮 ✗ 只对自定义技能显示 ✓
        if (s.mine) {
            const del = mkBtn("删除", "删除这个技能（整个目录进回收站 ✗ 会二次确认 ✓）", "danger");
            del.addEventListener("click", (e) => {
                e.stopPropagation();
                delSkill(s);
            });
            row.appendChild(del);
        }

        // ★ 单击整行 → 按配置行为 ✓
        row.addEventListener("click", () => {
            if (clickAction === "insert") doInsert(s);
            else doSend(s);
        });

        // ★★ 右键 → 【直接跳转】✗ 不做下拉 ✓
        row.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            showContextMenu(e, [
                {
                    label: s.mine ? "查看 / 修改内容…" : "查看内容（只读）…",
                    onClick: () => openContent(s),
                },
                {
                    label: "在磁盘上定位…",
                    onClick: () => {
                        vscode.postMessage({ kind: "skillOpenFile", name: s.name, reveal: true });
                    },
                },
                {
                    label: "隐藏（不显示）",
                    onClick: () => {
                        vscode.postMessage({ kind: "skillHide", name: s.name });
                    },
                },
                // ★ 删除只在【自定义技能】上出现 ✗ 别人包的删不掉 ✓
                ...(s.mine
                    ? [
                          {
                              label: "删除这个技能…",
                              danger: true,
                              onClick: () => delSkill(s),
                          },
                      ]
                    : []),
            ]);
        });

        listEl.appendChild(row);
    }

    // ★★ 列表的【最后一项永远是「＋」】✗（用户定的 ✓）
    //   为什么不做成底部独立按钮？→ 它本来就是列表的一部分 ✓
    //   列表是“一堆技能 + 一个新建入口”✗ 这样最自然 ✓
    const add = document.createElement("div");
    add.className = "sk-item add";
    add.title = "新建一个技能（会在 ~/.pi/agent/skills/ 下建目录 + SKILL.md 模板 ✓）";
    const plus = document.createElement("div");
    plus.className = "sk-add";
    plus.textContent = "＋ 新建技能";
    add.appendChild(plus);
    add.addEventListener("click", () => vscode.postMessage({ kind: "skillCreate" }));
    listEl.appendChild(add);
}

// ── 宿主 → 前端 ──
window.addEventListener("message", (e: MessageEvent) => {
    const msg = e.data as { kind?: string; payload?: unknown };
    if (msg?.kind === "skills") {
        const p = msg.payload as { skills?: SkillView[]; clickAction?: string };
        skills = p.skills ?? [];
        if (p.clickAction === "send" || p.clickAction === "insert") clickAction = p.clickAction;
        render();
        return;
    }
    if (msg?.kind === "skillToast") {
        const p = msg.payload as { text?: string; err?: boolean };
        toast(p.text ?? "", p.err === true);
        return;
    }
    // ★ 新建成功 → 刷新列表（并让新那条被看见 ✓）
    if (msg?.kind === "skillsRefresh") {
        void reloadBtn.click();
    }
});

reloadBtn.addEventListener("click", () => vscode.postMessage({ kind: "openSkills" }));

// ★ 打开时主动要一次数据 ✓
vscode.postMessage({ kind: "openSkills" });

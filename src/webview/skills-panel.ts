/**
 * skills-panel.ts —— 技能面板（B25）
 *
 * 【技能是什么？】
 *   它就是一份【可复用的指令文档】✗（Markdown ✓）
 *   放在 `~/.pi/agent/skills/<name>/SKILL.md`（用户自己的 ✓）
 *   或由扩展包提供（package.json 的 `pi.skills` ✓）
 *
 * 【面板要干什么？】（先做壳 ✓ 内容逐步填 ✓）
 *   ① 列出有哪些技能（名字 + 描述 ✓）
 *   ② 点开看它到底是什么（内容预览 ✗ 下一步 ✓）
 *   ③ 一键注入（发 `skill:<name>` 当命令 ✗ 下一步 ✓）
 *
 * 【为什么不直接做成"命令按钮"？】
 *   技能的价值在于【你记得它存在】✗
 *   而平时 TUI 里它们藏在系统提示里 ✓ 想不起来用 ✓
 *   → 面板的作用是【把能力摆在眼前】✓
 */
import { btnSkills, skillsPanel, skillsBody, skillsReload, skillsPath } from "./dom.js";
import { vscode } from "./vscode-api.js";
import { activatePanel, deactivatePanel, registerPanel } from "./panels.js";

interface SkillView {
    name: string;
    description?: string;
    /** 来源（用户目录 / 某个扩展包 ✓）*/
    source?: string;
    /** SKILL.md 的路径（悬停看 ✓）*/
    path?: string;
}

let rendered = false;
/** 当前展开的详情块（同一时刻只展开一个 ✓）*/
let detailEl: HTMLElement | null = null;

function isOpen(): boolean {
    return !skillsPanel.classList.contains("collapsed");
}

export function setSkillsOpen(open: boolean): void {
    skillsPanel.classList.toggle("collapsed", !open);
    if (!open) {
        deactivatePanel("skills");
        return;
    }
    // ★ 互斥（B25）
    activatePanel("skills");
    vscode.postMessage({ kind: "openSkills" });
}

/** 渲染技能列表 ✓ */
export function renderSkills(p: { dir?: string; skills?: SkillView[] }): void {
    skillsPath.textContent = p.dir ?? "";
    skillsPath.title = p.dir ?? "";
    skillsBody.textContent = "";
    const list = p.skills ?? [];

    if (!list.length) {
        const empty = document.createElement("div");
        empty.className = "s-loading";
        empty.textContent = "没有找到技能（技能放 <agentDir>/skills/<名字>/SKILL.md ✓）";
        skillsBody.appendChild(empty);
        rendered = true;
        return;
    }

    for (const s of list) {
        const row = document.createElement("div");
        row.className = "sk-item";
        if (s.path) row.title = s.path;

        const name = document.createElement("div");
        name.className = "sk-name";
        name.textContent = s.name;

        const desc = document.createElement("div");
        desc.className = "sk-desc";
        desc.textContent = s.description ?? "（没有描述）";

        row.appendChild(name);
        row.appendChild(desc);
        if (s.source) {
            const src = document.createElement("div");
            src.className = "sk-src";
            src.textContent = s.source;
            row.appendChild(src);
        }
        // ★ 点击展开内容（B25 ✓）
        row.addEventListener("click", () => {
            if (detailEl?.dataset.for === s.name) {
                // 再点一次 → 收起（类似折叠 ✓）
                detailEl.remove();
                detailEl = null;
                return;
            }
            vscode.postMessage({ kind: "skillDetail", name: s.name });
        });
        skillsBody.appendChild(row);
    }
    rendered = true;
    void rendered;
}

/**
 * ★ 渲染技能详情（B25）—— 原地插在这条技能下面 ✓
 *
 * 两个动作（用户要的"注入"✓）：
 *   ① 填入输入框 —— 把正文贴进 textarea ✓（你可以先改改再发 ✓）
 *   ② 作为命令发送 —— 直接发 `skill:<name>` ✓（pi 原生支持 ✓ 一行搞定 ✓）
 */
export function renderSkillDetail(p: {
    name: string;
    source?: string;
    path?: string;
    content?: string;
}): void {
    detailEl?.remove();
    // 找到那一条技能的行（按名字 ✓）
    let host: HTMLElement | null = null;
    for (const el of Array.from(skillsBody.querySelectorAll(".sk-item"))) {
        if (el.querySelector(".sk-name")?.textContent === p.name) {
            host = el as HTMLElement;
            break;
        }
    }
    if (!host) return;

    const box = document.createElement("div");
    box.className = "sk-detail";
    box.dataset.for = p.name;

    const pre = document.createElement("pre");
    pre.className = "sk-content";
    pre.textContent = p.content ?? "(空)";

    const bar = document.createElement("div");
    bar.className = "sk-actions";

    const toInput = document.createElement("button");
    toInput.textContent = "填入输入框";
    toInput.title = "把技能正文贴进输入框（你可以先改再发 ✓）";
    toInput.addEventListener("click", (e) => {
        e.stopPropagation();
        vscode.postMessage({ kind: "skillToInput", content: p.content ?? "" });
    });

    const asCmd = document.createElement("button");
    asCmd.textContent = "作为命令发送";
    asCmd.title = `直接发送 \`skill:${p.name}\`（pi 原生支持 ✓）`;
    asCmd.addEventListener("click", (e) => {
        e.stopPropagation();
        vscode.postMessage({ kind: "skillAsCommand", name: p.name });
    });

    bar.appendChild(toInput);
    bar.appendChild(asCmd);
    box.appendChild(bar);
    box.appendChild(pre);
    host.after(box);
    detailEl = box;
}

export function setupSkillsPanel(): void {
    // ★ 注册进面板协调器（B25）
    registerPanel("skills", () => setSkillsOpen(false));
    // ★ stopPropagation 必需 ✗（B24 踩过：不加的话同一次 click 会冒泡到
    //   document → 被当成"点外面" → 刚打开就被关 ✓）
    btnSkills.addEventListener("click", (e) => {
        e.stopPropagation();
        setSkillsOpen(!isOpen());
    });
    skillsReload.addEventListener("click", (e) => {
        e.stopPropagation();
        vscode.postMessage({ kind: "openSkills" });
    });

    // ★ 点外面 / 点非控件空白 → 收起（与设置面板同一套 ✓）
    document.addEventListener("click", (e) => {
        if (!isOpen()) return;
        const t = e.target as HTMLElement | null;
        // ★ 技能条目【本身是可点的】（展开详情 ✓）→ 必须保留排除 ✓
        if (t?.closest("#skills-panel button, .sk-item, .sk-detail, #btn-skills")) return;
        setSkillsOpen(false);
    });
}

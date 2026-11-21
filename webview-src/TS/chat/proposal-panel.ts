/**
 * proposal-panel - 提案调控面板(聊天流里的一个块)
 *
 * 只做三件事:显示每个提案的状态,提供单个/批量按钮,一个"自动继续"开关.
 * diff 和讨论在编辑器里的 Comment 中看,这里不重复渲染.
 *
 * 为什么没有"发送"按钮:
 *   下一条正文必然会把上一轮提案的结果带回去(宿主在发消息前会结算),
 *   所以真正需要的只是"处理完是否自动发一条继续"这个开关.
 */
import { proposalPanelEl } from "./dom.js";
import { vscode } from "./vscode-api.js";

export interface ProposalItem {
    proposalId: string;
    file: string;
    startLine?: number;
    endLine?: number;
    status: "pending" | "accepted" | "rejected";
    invalid?: string;
}

export interface ProposalListPayload {
    items: ProposalItem[];
    autoContinue: boolean;
}

let root: HTMLElement | null = null;
let listEl: HTMLElement | null = null;
let countEl: HTMLElement | null = null;
let autoEl: HTMLInputElement | null = null;
let noteEl: HTMLTextAreaElement | null = null;

/** 当前输入框里写的说明,随任何一次决策一起发出去 */
function readNote(): string {
    return noteEl?.value.trim() ?? "";
}

function ensure(): void {
    if (root) return;
    root = document.createElement("div");
    root.className = "pi-proposal";
    root.hidden = true;

    const box = document.createElement("div");
    box.className = "pi-proposal-box";

    const head = document.createElement("div");
    head.className = "pp-head";
    const title = document.createElement("span");
    title.className = "pp-title";
    title.textContent = "代码提案";
    countEl = document.createElement("span");
    countEl.className = "pp-count";
    head.append(title, countEl);

    listEl = document.createElement("div");
    listEl.className = "pp-list";

    const actions = document.createElement("div");
    actions.className = "pp-bulk";
    const acceptAll = document.createElement("button");
    acceptAll.textContent = "全部接受";
    acceptAll.addEventListener("click", () =>
        vscode.postMessage({ kind: "proposalAction", action: "acceptAll", note: readNote() }),
    );
    const rejectAll = document.createElement("button");
    rejectAll.textContent = "全部拒绝";
    rejectAll.addEventListener("click", () =>
        vscode.postMessage({ kind: "proposalAction", action: "rejectAll", note: readNote() }),
    );

    const autoWrap = document.createElement("label");
    autoWrap.className = "pp-auto";
    autoEl = document.createElement("input");
    autoEl.type = "checkbox";
    autoEl.addEventListener("change", () => {
        vscode.postMessage({
            kind: "proposalAction",
            action: "setAutoContinue",
            value: autoEl?.checked === true,
        });
    });
    const autoText = document.createElement("span");
    autoText.textContent = "处理完自动继续";
    autoWrap.append(autoEl, autoText);

    actions.append(acceptAll, rejectAll, autoWrap);

    // 决策说明。讨论区的草稿读不到(API 不暴露未提交内容),
    // 所以在这里单独给一个能读到的入口。
    const noteWrap = document.createElement("div");
    noteWrap.className = "pp-note-wrap";
    noteEl = document.createElement("textarea");
    noteEl.className = "pp-note";
    noteEl.rows = 2;
    noteEl.placeholder = "对这次决策的说明(可选,会随结果一起发给 AI)";
    noteWrap.append(noteEl);

    box.append(head, listEl, noteWrap, actions);
    root.append(box);
    // 挂在输入框上方,不进消息流(进消息流会被历史渲染盖掉)
    proposalPanelEl.appendChild(root);
}

const STATUS_TEXT: Record<ProposalItem["status"], string> = {
    pending: "待处理",
    accepted: "已接受",
    rejected: "已拒绝",
};

export function renderProposalList(payload: ProposalListPayload): void {
    ensure();
    if (!root || !listEl || !countEl || !autoEl) return;

    const items = payload.items ?? [];
    autoEl.checked = payload.autoContinue === true;

    listEl.textContent = "";
    const pending = items.filter((x) => x.status === "pending").length;
    countEl.textContent = pending > 0 ? `${pending} 个待处理 / 共 ${items.length}` : `${items.length} 个`;

    for (const it of items) {
        const row = document.createElement("div");
        row.className = "pp-row";

        const loc = document.createElement("span");
        loc.className = "pp-file";
        const line = it.startLine ? `:${it.startLine}${it.endLine && it.endLine !== it.startLine ? `-${it.endLine}` : ""}` : "";
        loc.textContent = `${it.file}${line}`;
        if (it.invalid) loc.title = `已失效:${it.invalid}`;

        const st = document.createElement("span");
        st.className = `pp-status ${it.status}${it.invalid ? " invalid" : ""}`;
        st.textContent = it.invalid ? "已失效" : STATUS_TEXT[it.status];

        row.append(loc, st);

        // 定位:不管什么状态都能点。自动跳转关掉之后,这就是唯一的路
        const go = document.createElement("button");
        go.textContent = "定位";
        go.className = "pp-mini";
        go.title = "在编辑器里打开这个提案的位置";
        go.addEventListener("click", () =>
            vscode.postMessage({
                kind: "proposalAction",
                action: "reveal",
                proposalId: it.proposalId,
            }),
        );
        row.append(go);

        if (it.status === "pending") {
            const ok = document.createElement("button");
            ok.textContent = "接受";
            ok.className = "pp-mini ok";
            ok.addEventListener("click", () =>
                vscode.postMessage({
                    kind: "proposalAction",
                    action: "accept",
                    proposalId: it.proposalId,
                    note: readNote(),
                }),
            );

            const no = document.createElement("button");
            no.textContent = "拒绝";
            no.className = "pp-mini no";
            no.addEventListener("click", () =>
                vscode.postMessage({
                    kind: "proposalAction",
                    action: "reject",
                    proposalId: it.proposalId,
                    note: readNote(),
                }),
            );
            row.append(ok, no);
        }

        listEl.appendChild(row);
    }

    // 没有提案就把整块收起来,不占位置
    root.hidden = items.length === 0;
    // 一批处理完就把说明清掉:它只对这一轮有意义
    if (items.length === 0 && noteEl) noteEl.value = "";
}

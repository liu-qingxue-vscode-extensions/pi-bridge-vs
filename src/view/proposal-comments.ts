/**
 * proposal-comments - 提案的生命周期与渲染
 *
 * 两条并存的界面:
 *   编辑器里的 Comment thread  - 看 diff,讨论,单个处理
 *   侧栏面板(webview)        - 总览所有提案,批量操作,统一发送
 *
 * 状态机:
 *   pending  待处理
 *   accepted 已接受(文件已经写入,但还没告诉 AI)
 *   rejected 已拒绝(文件没动,还没告诉 AI)
 *
 * 只有调 sendAll() 才把结果发给 AI.单个处理一律不发消息 -
 * 因为并行提案必须全部处理完再一起回复,否则 AI 会以为剩下的也没了.
 */
import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import { logInfo, logWarn } from "../logger.js";
import { vsSettings } from "../external-data/vs-settings.js";
import {
    buildDiff,
    locateInText,
    locateProposal,
    normalizeEol,
    type WriteProposal,
} from "../bridge/proposal.js";

const CONTROLLER_ID = "pi-bridge-proposal";

/** 未处理提案的落盘位置(工作区根下,和 .pi-tours 一个思路) */
const STORE_DIR = ".pi-proposals";
const STORE_FILE = "state.json";

export type ProposalStatus = "pending" | "accepted" | "rejected";

export interface ProposalView {
    proposalId: string;
    file: string;
    startLine?: number;
    endLine?: number;
    explanation: string;
    status: ProposalStatus;
    invalid?: string;
}

interface Discussion {
    question: string;
    answer: string;
}

export interface SettleResult {
    proposalId: string;
    file: string;
    status: "accepted" | "rejected" | "auto-rejected";
    error?: string;
}

export interface ApplyOutcome {
    ok: boolean;
    error?: string;
}

/** 存档结构:每个会话一份,键是会话文件名(不存路径,换目录不失效) */
interface StoreShape {
    sessions: Record<
        string,
        { proposals?: WriteProposal[]; discussion?: Record<string, Discussion> }
    >;
}

export class ProposalComments implements vscode.Disposable {
    private readonly controller: vscode.CommentController;
    private readonly idOf = new WeakMap<vscode.CommentThread, string>();
    private readonly threads = new Map<string, vscode.CommentThread>();
    private readonly data = new Map<string, WriteProposal>();
    private readonly status = new Map<string, ProposalStatus>();
    private readonly invalid = new Map<string, string>();
    private readonly discussion = new Map<string, Discussion>();

    private readonly highlight: vscode.TextEditorDecorationType;
    private readonly watchSub: vscode.Disposable;
    private revalidateTimer: NodeJS.Timeout | undefined;
    private saveTimer: NodeJS.Timeout | undefined;
    /**
     * 当前挂在哪份会话上(用文件名,不存绝对路径)。
     *
     * 提案是会话的私事:切走了就不该再显示,切回来再拿出来。
     * 存档始终在项目根的 .pi-proposals/ 下,会话文件一个字节不动。
     */
    private sessionKey: string | null = null;

    constructor(
        private readonly root: string,
        private readonly onAsk: (proposalId: string, text: string) => void,
        private readonly onChange: () => void,
    ) {
        this.controller = vscode.comments.createCommentController(CONTROLLER_ID, "Pi 代码提案");
        this.controller.options = {
            prompt: "对这个提案提问,AI 会回答(讨论不影响是否通过)",
            placeHolder: "提问...",
        };
        this.controller.commentingRangeProvider = { provideCommentingRanges: () => [] };
        this.highlight = vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
        });

        this.watchSub = vscode.workspace.onDidChangeTextDocument((e) => {
            if (this.threads.size === 0) return;
            const touched = [...this.threads.values()].some(
                (t) => t.uri.toString() === e.document.uri.toString(),
            );
            if (!touched) return;
            if (this.revalidateTimer) clearTimeout(this.revalidateTimer);
            this.revalidateTimer = setTimeout(() => this.revalidate(e.document), 250);
        });
    }

    get(proposalId: string): WriteProposal | undefined {
        return this.data.get(proposalId);
    }

    get count(): number {
        return this.data.size;
    }

    /** 给侧栏面板用的快照 */
    list(): ProposalView[] {
        const out: ProposalView[] = [];
        for (const [id, p] of this.data) {
            const loc = this.invalid.has(id) ? undefined : locateProposal(this.root, p);
            out.push({
                proposalId: id,
                file: p.file,
                startLine: loc?.ok ? loc.startLine : undefined,
                endLine: loc?.ok ? loc.endLine : undefined,
                explanation: p.explanation ?? "",
                status: this.status.get(id) ?? "pending",
                invalid: this.invalid.get(id),
            });
        }
        return out;
    }

    /** 显示(或刷新)提案 */
    show(p: WriteProposal, silent = false): void {
        this.data.set(p.proposalId, p);
        this.status.set(p.proposalId, "pending");

        const abs = path.resolve(this.root, p.file);
        const uri = vscode.Uri.file(abs);
        const loc = locateProposal(this.root, p);
        const anchorLine = loc.ok ? Math.max(0, (loc.endLine ?? 1) - 1) : 0;
        const range = new vscode.Range(anchorLine, 0, anchorLine, 0);

        let thread = this.threads.get(p.proposalId);
        if (!thread) {
            thread = this.controller.createCommentThread(uri, range, []);
            thread.canReply = true;
            thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
            thread.contextValue = "pi-proposal";
            this.idOf.set(thread, p.proposalId);
            this.threads.set(p.proposalId, thread);
        }
        thread.range = range;
        thread.comments = this.buildComments(p);

        logInfo(
            `提案 ${p.proposalId} 挂在 ${p.file}:${anchorLine + 1}` +
            `(${loc.ok ? `${loc.startLine}-${loc.endLine}` : `定位失败:${loc.error}`})` +
            `,活跃 ${this.threads.size} 个`,
        );

        this.repaintHighlights();
        if (!silent) this.changed();

        // 自动跳到提案位置,免得用户自己去翻文件(受 autoReveal 开关控制)
        if (!silent) this.maybeAutoReveal(p.proposalId, uri, anchorLine);
    }

    /**
     * 把未处理的提案写盘 / 从盘里读回来.
     *
     * 为什么要落盘:提案不是对话气泡,它是有生命周期的对象。
     * 退出 VS Code 再回来,pi 不会重放历史里的自定义条目
     * (onOurEntry 只挂在 entry_appended 上),所以只能自己存。
     * 只存 pending 的:已决策的没恢复价值,文件也已经变过了。
     */
    /**
     * 切到另一个会话。
     *
     * 上一个会话还没处理的提案先存回盘里再收起来;
     * 新会话有存档就拿出来,没有就空着。
     */
    setSession(file: string | null): void {
        const key = file ? path.basename(file) : null;
        if (this.sessionKey === key) return;
        if (this.sessionKey) this.writeStore(this.sessionKey);
        this.clearAll();
        this.sessionKey = key;
        if (key) this.restore();
        this.changed();
    }

    /** 把内存里的提案全清掉(不碰存档) */
    private clearAll(): void {
        for (const id of [...this.threads.keys()]) this.threads.get(id)?.dispose();
        this.threads.clear();
        this.data.clear();
        this.status.clear();
        this.invalid.clear();
        this.discussion.clear();
        this.clearHighlight();
    }

    restore(): void {
        if (!this.sessionKey) return;
        const entry = this.readStore().sessions[this.sessionKey];
        if (!entry) return;
        const list = entry.proposals ?? [];
        // 打开过程中不逐条触发 onChange:外面会在 restore() 之后统一推一次
        for (const p of list) {
            if (!p?.proposalId || !p.file) continue;
            this.show(p, true);
        }
        // 讨论内容也要回来:否则恢复出来的提案只剩 diff,上一轮说过什么全没了
        for (const [id, d] of Object.entries(entry.discussion ?? {})) {
            if (this.data.has(id) && d) this.discussion.set(id, d);
        }
        if (list.length) logInfo(`恢复 ${list.length} 个未处理的提案(含讨论)`);
    }

    /** 状态变了:先落盘,再通知界面。所有变更点都走这里,免得漏存 */
    private changed(): void {
        this.persist();
        this.onChange();
    }

    private storeFile(): string {
        return path.join(this.root, STORE_DIR, STORE_FILE);
    }

    private readStore(): StoreShape {
        try {
            const raw = fs.readFileSync(this.storeFile(), "utf8");
            const parsed = JSON.parse(raw) as StoreShape;
            return parsed?.sessions ? parsed : { sessions: {} };
        } catch {
            return { sessions: {} };
        }
    }

    private persist(): void {
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
            this.saveTimer = undefined;
            if (this.sessionKey) this.writeStore(this.sessionKey);
        }, 120);
    }

    private writeStore(key: string): void {
        const store = this.readStore();
        const pending: WriteProposal[] = [];
        const discussion: Record<string, Discussion> = {};
        for (const [id, p] of this.data) {
            if ((this.status.get(id) ?? "pending") !== "pending") continue;
            pending.push(p);
            const d = this.discussion.get(id);
            if (d && (d.question || d.answer)) discussion[id] = d;
        }
        if (pending.length) store.sessions[key] = { proposals: pending, discussion };
        else delete store.sessions[key];

        const file = this.storeFile();
        try {
            if (!Object.keys(store.sessions).length) {
                if (fs.existsSync(file)) fs.unlinkSync(file);
                return;
            }
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, JSON.stringify(store, null, 2), "utf8");
        } catch (err) {
            logWarn(`提案存档写入失败:${String(err)}`);
        }
    }

    private revealTimer: ReturnType<typeof setTimeout> | undefined;
    private pendingReveal: { uri: vscode.Uri; line: number } | undefined;

    /**
     * 新提案到达时要不要自动跳。
     *
     * off   - 完全不跳，靠面板上的「定位」按钮手动跳
     * first - 一批只跳第一个。判断依据是"除它之外还有没有别的待处理"，
     *         所以第二批提案到达时仍然会跳
     * all   - 每个都跳，靠 60ms 合并避免连续闪烁
     */
    private maybeAutoReveal(proposalId: string, uri: vscode.Uri, line: number): void {
        const mode = vsSettings.get("pi-bridge.proposal.autoReveal");
        if (mode === "off") return;
        if (mode === "first") {
            const pending = [...this.status.entries()].filter(([, st]) => st === "pending");
            const isFirstOfBatch = pending.length <= 1 || pending[0][0] === proposalId;
            if (!isFirstOfBatch) return;
        }
        this.scheduleReveal(uri, line);
    }

    /**
     * 处理完一个之后跳到下一个待处理的。
     *
     * 和 autoReveal 独立：关掉自动跳转仍然可以开着它，
     * 因为这是"接着看下一个"，不是"新提案打断你"。
     */
    private revealNextPending(): void {
        if (!vsSettings.get("pi-bridge.proposal.revealNext")) return;
        const next = [...this.status.entries()].find(([, st]) => st === "pending");
        if (next) void this.reveal(next[0]);
    }

    /**
     * 合并跳转。
     *
     * 一次提交多个提案时它们会连着到达,每个都跳一次会闪好几下,
     * 而且最后停在哪个取决于到达顺序。用 60ms 的窗口合并,只跳最后那个。
     */
    private scheduleReveal(uri: vscode.Uri, line: number): void {
        this.pendingReveal = { uri, line };
        if (this.revealTimer) clearTimeout(this.revealTimer);
        this.revealTimer = setTimeout(() => {
            this.revealTimer = undefined;
            const p = this.pendingReveal;
            this.pendingReveal = undefined;
            if (p) void this.revealNow(p.uri, p.line);
        }, 60);
    }

    /** 手动跳到某个提案(面板上的"定位"按钮走这里,不受自动跳转开关影响) */
    async reveal(proposalId: string): Promise<void> {
        const p = this.data.get(proposalId);
        if (!p) return;
        const uri = vscode.Uri.file(path.resolve(this.root, p.file));
        const loc = locateProposal(this.root, p);
        const line = loc.ok ? Math.max(0, (loc.endLine ?? 1) - 1) : 0;
        await this.revealNow(uri, line);
    }

    private async revealNow(uri: vscode.Uri, line: number): Promise<void> {
        const target = new vscode.Range(line, 0, line, 0);
        try {
            const editor = await vscode.window.showTextDocument(uri, {
                preview: false,
                selection: target,
            });
            editor.revealRange(target, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        } catch {
            // 文件被删/目录被移走之类的,跳不过去不影响提案本身
        }
    }

    /** AI 在讨论里回答了一句 */
    setAnswer(proposalId: string, text: string): void {
        const p = this.data.get(proposalId);
        const thread = this.threads.get(proposalId);
        if (!p || !thread) return;
        const cur = this.discussion.get(proposalId) ?? { question: "", answer: "" };
        cur.answer = text;
        this.discussion.set(proposalId, cur);
        thread.comments = this.buildComments(p);
        this.persist();
    }

    /** 用户提交了一条讨论回复 */
    handleReply(thread: vscode.CommentThread, text: string): void {
        const id = this.idOf.get(thread);
        if (!id) return;
        const cur = this.discussion.get(id) ?? { question: "", answer: "" };
        cur.question = text;
        cur.answer = "";
        this.discussion.set(id, cur);
        const p = this.data.get(id);
        if (p) thread.comments = this.buildComments(p);
        this.persist();
        this.onAsk(id, text);
    }

    /**
     * 接受:立即写入文件,但不通知 AI.
     *
     * 用户能马上看到文件变了;什么时候回复 AI 由面板上的"发送"决定.
     */
    async accept(proposalId: string): Promise<ApplyOutcome> {
        const p = this.data.get(proposalId);
        if (!p) return { ok: false, error: "提案已经不存在了" };

        const bad = this.invalid.get(proposalId);
        if (bad) {
            this.status.set(proposalId, "rejected");
            this.dismissThread(proposalId);
            this.changed();
            return { ok: false, error: `提案已失效:${bad}` };
        }

        const uri = vscode.Uri.file(path.resolve(this.root, p.file));

        // 新建文件:没有旧文档可打开,也就没有"定位"这回事 —— 整份内容都是新的
        if (p.mode === "create") {
            const edit = new vscode.WorkspaceEdit();
            edit.createFile(uri, { ignoreIfExists: false });
            edit.insert(uri, new vscode.Position(0, 0), p.newText ?? "");
            const applied = await vscode.workspace.applyEdit(edit);
            if (!applied) return { ok: false, error: "VS Code 拒绝创建这个文件(可能已经存在)" };

            this.status.set(proposalId, "accepted");
            this.dismissThread(proposalId);
            this.changed();
            this.revealNextPending();
            return { ok: true };
        }

        let doc: vscode.TextDocument;
        try {
            doc = await vscode.workspace.openTextDocument(uri);
        } catch (err) {
            return { ok: false, error: `打不开文件:${String(err)}` };
        }

        const loc = locateInText(doc.getText(), p);
        if (!loc.ok || loc.offset == null || loc.length == null) {
            this.status.set(proposalId, "rejected");
            this.invalid.set(proposalId, loc.error ?? "定位失败");
            this.dismissThread(proposalId);
            this.changed();
            return { ok: false, error: loc.error ?? "定位失败" };
        }

        const eol = doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
            uri,
            new vscode.Range(doc.positionAt(loc.offset), doc.positionAt(loc.offset + loc.length)),
            normalizeEol(p.newText ?? "", eol),
        );
        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) return { ok: false, error: "VS Code 拒绝了这个编辑" };

        try {
            await doc.save();
        } catch (err) {
            return { ok: false, error: `已修改但保存失败:${String(err)}` };
        }

        this.status.set(proposalId, "accepted");
        this.dismissThread(proposalId);
        this.changed();
        this.revealNextPending();
        return { ok: true };
    }

    /** 拒绝:只改状态,不写文件 */
    reject(proposalId: string): void {
        if (!this.data.has(proposalId)) return;
        this.status.set(proposalId, "rejected");
        this.dismissThread(proposalId);
        this.changed();
        this.revealNextPending();
    }

    /** 批量:把所有待处理的按接受/拒绝处理 */
    async acceptAllPending(): Promise<void> {
        for (const [id, s] of [...this.status]) {
            if (s === "pending") await this.accept(id);
        }
    }

    rejectAllPending(): void {
        for (const [id, s] of [...this.status]) {
            if (s === "pending") this.reject(id);
        }
    }

    /**
     * 把所有提案的结果一次性交给调用方(由它发给 AI),然后清空.
     *
     * 还在 pending 的按"未处理,自动拒绝"记 - 用户点了发送就表示
     * 这一轮到此为止,不能再让 AI 等着.
     */
    settleAll(): SettleResult[] {
        const out: SettleResult[] = [];
        for (const [id, p] of [...this.data]) {
            const s = this.status.get(id) ?? "pending";
            out.push({
                proposalId: id,
                file: p.file,
                status: s === "accepted" ? "accepted" : s === "rejected" ? "rejected" : "auto-rejected",
                error: this.invalid.get(id),
            });
            this.close(id);
        }
        // 结算会把待处理的清空,得把存档一起收掉,并让面板跟着消失
        if (this.sessionKey) this.writeStore(this.sessionKey);
        this.onChange();
        return out;
    }

    close(proposalId: string): void {
        this.threads.get(proposalId)?.dispose();
        this.threads.delete(proposalId);
        this.data.delete(proposalId);
        this.status.delete(proposalId);
        this.invalid.delete(proposalId);
        this.discussion.delete(proposalId);
        this.clearHighlight();
        this.repaintHighlights();
    }

    /**
     * 处理完就把它从编辑器里收掉.
     *
     * 数据(data / status)保留,因为侧栏面板还要显示"已接受/已拒绝".
     */
    private dismissThread(proposalId: string): void {
        this.threads.get(proposalId)?.dispose();
        this.threads.delete(proposalId);
        this.discussion.delete(proposalId);
        this.clearHighlight();
        this.repaintHighlights();
    }

    private refreshThread(proposalId: string): void {
        const p = this.data.get(proposalId);
        const thread = this.threads.get(proposalId);
        if (!p || !thread) return;
        thread.comments = this.buildComments(p);
    }

    private revalidate(doc: vscode.TextDocument): void {
        const raw = doc.getText();
        for (const [id, thread] of this.threads) {
            if (thread.uri.toString() !== doc.uri.toString()) continue;
            const p = this.data.get(id);
            if (!p) continue;
            // 已经处理过的不用再校验
            if ((this.status.get(id) ?? "pending") !== "pending") continue;

            const loc = locateInText(raw, p);
            const changed = loc.ok
                ? this.invalid.delete(id)
                : (this.invalid.set(id, loc.error ?? "定位失败"), true);
            if (!changed) continue;

            thread.label = loc.ok
                ? `${p.file}:${loc.startLine}-${loc.endLine}`
                : `${p.file}(已失效)`;
            thread.comments = this.buildComments(p);
            this.changed();
        }
    }

    private clearHighlight(): void {
        for (const editor of vscode.window.visibleTextEditors) {
            editor.setDecorations(this.highlight, []);
        }
    }

    private repaintHighlights(): void {
        const byUri = new Map<string, vscode.Range[]>();
        for (const [id, thread] of this.threads) {
            const p = this.data.get(id);
            if (!p) continue;
            if ((this.status.get(id) ?? "pending") !== "pending") continue;
            const loc = locateProposal(this.root, p);
            if (!loc.ok || loc.startLine == null || loc.endLine == null) continue;
            const key = thread.uri.toString();
            const list = byUri.get(key) ?? [];
            list.push(
                new vscode.Range(loc.startLine - 1, 0, loc.endLine - 1, Number.MAX_SAFE_INTEGER),
            );
            byUri.set(key, list);
        }
        for (const editor of vscode.window.visibleTextEditors) {
            editor.setDecorations(this.highlight, byUri.get(editor.document.uri.toString()) ?? []);
        }
    }

    private buildComments(p: WriteProposal): vscode.Comment[] {
        const out: vscode.Comment[] = [
            {
                author: { name: "Pi" },
                mode: vscode.CommentMode.Preview,
                body: this.buildBody(p),
            },
        ];

        const d = this.discussion.get(p.proposalId);
        if (d?.question) {
            const q = new vscode.MarkdownString();
            q.appendText(d.question);
            out.push({ author: { name: "你" }, mode: vscode.CommentMode.Preview, body: q });
        }
        if (d?.answer) {
            const a = new vscode.MarkdownString();
            a.appendMarkdown(d.answer);
            out.push({ author: { name: "Pi" }, mode: vscode.CommentMode.Preview, body: a });
        }
        return out;
    }

    private buildBody(p: WriteProposal): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.supportThemeIcons = true;
        md.isTrusted = {
            enabledCommands: ["pi-bridge.proposalAccept", "pi-bridge.proposalReject"],
        };

        const status = this.status.get(p.proposalId) ?? "pending";
        const bad = this.invalid.get(p.proposalId);

        md.appendMarkdown(`**${p.explanation || "(没有说明)"}**\n\n`);

        if (bad) {
            md.appendMarkdown(`$(error) 无法定位:${bad}\n\n`);
        } else {
            const loc = locateProposal(this.root, p);
            // 插入类提案没有"删除"这回事:锚点原样保留,只是多了几行
            const removedPart = p.mode === "text" ? (loc.matchedText ?? "") : "";
            const diff = buildDiff(removedPart, p.newText ?? "");
            md.appendCodeblock(
                [
                    ...diff.removed.map((l) => `- ${l}`),
                    ...diff.added.map((l) => `+ ${l}`),
                ].join("\n"),
                "diff",
            );
        }

        const arg = encodeURIComponent(JSON.stringify({ id: p.proposalId }));
        if (status === "accepted") {
            md.appendMarkdown(`\n\n$(pass-filled) 已接受,已写入文件.在侧栏点"发送"告诉 AI.`);
        } else if (status === "rejected") {
            md.appendMarkdown(`\n\n$(circle-slash) 已拒绝.在侧栏点"发送"告诉 AI.`);
        } else if (bad) {
            md.appendMarkdown(
                `\n\n[$(close) 拒绝](command:pi-bridge.proposalReject?${arg})`,
            );
        } else {
            md.appendMarkdown(
                `\n\n[$(check) 接受](command:pi-bridge.proposalAccept?${arg})` +
                `  ·  [$(close) 拒绝](command:pi-bridge.proposalReject?${arg})`,
            );
        }
        return md;
    }

    dispose(): void {
        if (this.revalidateTimer) clearTimeout(this.revalidateTimer);
        this.watchSub.dispose();
        for (const t of this.threads.values()) t.dispose();
        this.threads.clear();
        this.highlight.dispose();
        this.controller.dispose();
    }
}

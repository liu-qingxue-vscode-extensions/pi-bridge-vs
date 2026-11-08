/**
 * proposal-comments —— 提案的生命周期与渲染
 *
 * 两条并存的界面：
 *   编辑器里的 Comment thread  —— 看 diff、讨论、单个处理
 *   侧栏面板（webview）        —— 总览所有提案、批量操作、统一发送
 *
 * 状态机：
 *   pending  待处理
 *   accepted 已接受（文件已经写入，但还没告诉 AI）
 *   rejected 已拒绝（文件没动，还没告诉 AI）
 *
 * 只有调 sendAll() 才把结果发给 AI。单个处理一律不发消息 ——
 * 因为并行提案必须全部处理完再一起回复，否则 AI 会以为剩下的也没了。
 */
import * as vscode from "vscode";
import * as path from "node:path";
import { logInfo } from "../logger.js";
import {
    buildDiff,
    locateInText,
    locateProposal,
    normalizeEol,
    type WriteProposal,
} from "../bridge/proposal.js";

const CONTROLLER_ID = "pi-bridge-proposal";

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

    constructor(
        private readonly root: string,
        private readonly onAsk: (proposalId: string, text: string) => void,
        private readonly onChange: () => void,
    ) {
        this.controller = vscode.comments.createCommentController(CONTROLLER_ID, "Pi 代码提案");
        this.controller.options = {
            prompt: "对这个提案提问，AI 会回答（讨论不影响是否通过）",
            placeHolder: "提问…",
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

    /** 显示（或刷新）提案 */
    show(p: WriteProposal): void {
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
                `（${loc.ok ? `${loc.startLine}-${loc.endLine}` : `定位失败：${loc.error}`}）` +
                `，活跃 ${this.threads.size} 个`,
        );

        this.repaintHighlights();
        this.onChange();
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
        this.onAsk(id, text);
    }

    /**
     * 接受：立即写入文件，但不通知 AI。
     *
     * 用户能马上看到文件变了；什么时候回复 AI 由面板上的"发送"决定。
     */
    async accept(proposalId: string): Promise<ApplyOutcome> {
        const p = this.data.get(proposalId);
        if (!p) return { ok: false, error: "提案已经不存在了" };

        const bad = this.invalid.get(proposalId);
        if (bad) {
            this.status.set(proposalId, "rejected");
            this.dismissThread(proposalId);
            this.onChange();
            return { ok: false, error: `提案已失效：${bad}` };
        }

        const uri = vscode.Uri.file(path.resolve(this.root, p.file));
        let doc: vscode.TextDocument;
        try {
            doc = await vscode.workspace.openTextDocument(uri);
        } catch (err) {
            return { ok: false, error: `打不开文件：${String(err)}` };
        }

        const loc = locateInText(doc.getText(), p);
        if (!loc.ok || loc.offset == null || loc.length == null) {
            this.status.set(proposalId, "rejected");
            this.invalid.set(proposalId, loc.error ?? "定位失败");
            this.dismissThread(proposalId);
            this.onChange();
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
            return { ok: false, error: `已修改但保存失败：${String(err)}` };
        }

        this.status.set(proposalId, "accepted");
        this.dismissThread(proposalId);
        this.onChange();
        return { ok: true };
    }

    /** 拒绝：只改状态，不写文件 */
    reject(proposalId: string): void {
        if (!this.data.has(proposalId)) return;
        this.status.set(proposalId, "rejected");
        this.dismissThread(proposalId);
        this.onChange();
    }

    /** 批量：把所有待处理的按接受/拒绝处理 */
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
     * 把所有提案的结果一次性交给调用方（由它发给 AI），然后清空。
     *
     * 还在 pending 的按"未处理，自动拒绝"记 —— 用户点了发送就表示
     * 这一轮到此为止，不能再让 AI 等着。
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
     * 处理完就把它从编辑器里收掉。
     *
     * 数据（data / status）保留，因为侧栏面板还要显示"已接受/已拒绝"。
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
                : `${p.file}（已失效）`;
            thread.comments = this.buildComments(p);
            this.onChange();
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

        md.appendMarkdown(`**${p.explanation || "（没有说明）"}**\n\n`);

        if (bad) {
            md.appendMarkdown(`$(error) 无法定位：${bad}\n\n`);
        } else {
            const loc = locateProposal(this.root, p);
            const diff = buildDiff(loc.matchedText ?? "", p.newText ?? "");
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
            md.appendMarkdown(`\n\n$(pass-filled) 已接受，已写入文件。在侧栏点"发送"告诉 AI。`);
        } else if (status === "rejected") {
            md.appendMarkdown(`\n\n$(circle-slash) 已拒绝。在侧栏点"发送"告诉 AI。`);
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

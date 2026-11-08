/**
 * walkthrough —— 讲解剧本的播放与缓存（自研，不依赖 CodeTour）
 *
 * 形态是 VS Code 原生的 Comment：每帧在代码行下面挂一个块，里面是说明和翻页链接。
 *
 * 身份就是【锚点行的原文】：
 *   · 同一个地方重讲，原文一样 ⇒ 直接覆盖
 *   · 播放时用它现搜位置，行号漂了也能跟上，所以不存行号
 *   · 原文为空或全文不唯一 ⇒ 这份剧本没法定位，创建时就失败
 *
 * 存储是单个索引：.pi-tours/index.json，按相对文件路径分组。
 */
import * as vscode from "vscode";
import * as path from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { logInfo, logWarn } from "../logger.js";

const CONTROLLER_ID = "pi-bridge-tour";
const TOUR_DIR = ".pi-tours";
const INDEX_FILE = "index.json";

export interface TourStep {
    /** 相对锚点行的偏移（0 = 锚点那一行） */
    offset: number;
    endOffset?: number;
    text: string;
}

export interface TourData {
    /** 身份：锚点那一行的原文（trim 后） */
    anchorText: string;
    title: string;
    steps: TourStep[];
    createdAt: number;
}

/** 索引：按相对文件路径分组，查询只需一次哈希 */
interface IndexFile {
    version: number;
    files: Record<string, TourData[]>;
}

interface Playing {
    file: string;
    tour: TourData;
    /** 锚点的绝对行号（播放时现搜出来的） */
    anchorLine: number;
    index: number;
}

export class Walkthrough implements vscode.Disposable {
    private readonly controller: vscode.CommentController;
    private readonly status: vscode.StatusBarItem;
    private readonly highlight: vscode.TextEditorDecorationType;
    private thread: vscode.CommentThread | undefined;
    private playing: Playing | undefined;

    constructor(private readonly root: string) {
        this.controller = vscode.comments.createCommentController(CONTROLLER_ID, "Pi 讲解");
        this.controller.commentingRangeProvider = { provideCommentingRanges: () => [] };
        this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
        this.highlight = vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
        });
    }

    /** 来自 vs_show：建剧本、存盘、立即播放 */
    async show(payload: {
        title: string;
        file: string;
        steps: Array<{ line: number; endLine?: number; description: string }>;
    }): Promise<{ ok: boolean; error?: string }> {
        if (!payload.steps?.length) return { ok: false, error: "没有任何帧" };

        const first = payload.steps[0];
        const anchorText = this.lineText(payload.file, first.line);
        if (!anchorText) {
            return { ok: false, error: `第 ${first.line} 行是空的（或读不到文件），没法当锚点` };
        }

        const tour: TourData = {
            anchorText,
            title: payload.title || "讲解",
            steps: payload.steps.map((st) => ({
                offset: st.line - first.line,
                endOffset:
                    st.endLine != null && st.endLine > st.line ? st.endLine - first.line : undefined,
                text: st.description ?? "",
            })),
            createdAt: Date.now(),
        };

        this.put(payload.file, tour);
        return this.play(payload.file, tour, first.line, false);
    }

    /** 「查看这里的讲解」：当前行原文精确命中就播，否则列出本文件的剧本 */
    async playHere(): Promise<void> {
        const at = this.activeFile();
        if (!at) {
            void vscode.window.showInformationMessage("先打开一个文件");
            return;
        }

        const list = this.toursOf(this.loadIndex(), at.file);
        if (list.length === 0) {
            void vscode.window.showInformationMessage(`「${at.file}」还没有任何讲解`);
            return;
        }

        const exact = list.find((t) => t.anchorText === at.text);
        if (exact) {
            const r = await this.play(at.file, exact, at.line, false);
            if (!r.ok) void vscode.window.showWarningMessage(`无法播放：${r.error ?? "未知"}`);
            return;
        }

        await this.pickFrom(list, at.file, "当前这行没有匹配的讲解");
    }

    /** 列出所有文件的所有剧本 */
    async pickAll(): Promise<void> {
        const index = this.loadIndex();
        const all: Array<{ label: string; description: string; detail: string; file: string; tour: TourData }> = [];
        for (const [file, list] of Object.entries(index.files)) {
            for (const t of list) {
                all.push({
                    label: t.title,
                    description: file,
                    detail: `${t.anchorText} · ${t.steps.length} 帧`,
                    file,
                    tour: t,
                });
            }
        }
        if (all.length === 0) {
            void vscode.window.showInformationMessage("还没有任何讲解");
            return;
        }
        const picked = await vscode.window.showQuickPick(all, {
            placeHolder: "选择要播放的讲解",
            matchOnDescription: true,
        });
        if (!picked) return;
        const r = await this.play(picked.file, picked.tour, undefined, true);
        if (!r.ok) void vscode.window.showWarningMessage(`无法播放：${r.error ?? "未知"}`);
    }

    /** 手动清理失效剧本：孤儿必然存在，没法自动判断，列出来让用户勾 */
    async prune(): Promise<void> {
        const index = this.loadIndex();
        type Stale = { file: string; tour: TourData; why: string };
        const stale: Stale[] = [];

        for (const [file, list] of Object.entries(index.files)) {
            let text: string;
            try {
                text = readFileSync(path.resolve(this.root, file), "utf8");
            } catch {
                for (const t of list) stale.push({ file, tour: t, why: "文件不存在" });
                continue;
            }
            const lines = text.split(/\r?\n/);
            for (const t of list) {
                const hits = lines.filter((l) => l.trim() === t.anchorText).length;
                if (hits === 0) stale.push({ file, tour: t, why: "锚点内容已不在文件里" });
                else if (hits > 1)
                    stale.push({ file, tour: t, why: `锚点内容重复出现 ${hits} 次，无法定位` });
            }
        }

        if (stale.length === 0) {
            void vscode.window.showInformationMessage("没有失效的讲解");
            return;
        }

        const items = stale.map((s) => ({
            label: s.tour.title,
            description: s.file,
            detail: `${s.why}  ·  ${s.tour.anchorText}`,
            picked: false,
            stale: s,
        }));
        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: `发现 ${stale.length} 份可能失效的讲解，勾选要删除的`,
            canPickMany: true,
        });
        if (!picked?.length) return;

        for (const p of picked) {
            const rest = this.toursOf(index, p.stale.file).filter(
                (t) => t.anchorText !== p.stale.tour.anchorText,
            );
            if (rest.length) index.files[p.stale.file] = rest;
            else delete index.files[p.stale.file];
        }
        this.saveIndex(index);
        void vscode.window.showInformationMessage(`已删除 ${picked.length} 份失效讲解`);
    }

    next(): void {
        if (!this.playing) return;
        if (this.playing.index >= this.playing.tour.steps.length - 1) {
            this.stop();
            return;
        }
        this.playing.index++;
        void this.render();
    }

    prev(): void {
        if (!this.playing || this.playing.index === 0) return;
        this.playing.index--;
        void this.render();
    }

    stop(): void {
        this.thread?.dispose();
        this.thread = undefined;
        this.playing = undefined;
        this.status.hide();
        for (const editor of vscode.window.visibleTextEditors) {
            editor.setDecorations(this.highlight, []);
        }
    }

    /**
     * 播放。
     *
     * hintLine 只当"优先候选"（比如刚创建时知道确切行号、或用户光标位置），
     * 真正定位始终靠 anchorText 现搜，所以行号漂移不会播错地方。
     */
    private async play(
        file: string,
        tour: TourData,
        hintLine: number | undefined,
        dropOnFail: boolean,
    ): Promise<{ ok: boolean; error?: string }> {
        const resolved = this.resolveAnchor(file, tour, hintLine);
        if (!resolved.ok) {
            if (dropOnFail) {
                this.remove(file, tour);
                logInfo(`剧本已失效并移除：${tour.title}（${resolved.error}）`);
            }
            return { ok: false, error: resolved.error };
        }

        this.playing = { file, tour, anchorLine: resolved.line, index: 0 };
        await this.render();
        return { ok: true };
    }

    private async render(): Promise<void> {
        const p = this.playing;
        if (!p) return;

        const step = p.tour.steps[p.index];
        const line = p.anchorLine + step.offset;
        // 有结束行就挂在结束行下面，否则挂在这一行下面
        const endLine = step.endOffset != null ? p.anchorLine + step.endOffset : line;
        const anchorLine = step.endOffset != null ? endLine : line;

        const uri = vscode.Uri.file(path.resolve(this.root, p.file));
        const range = new vscode.Range(anchorLine - 1, 0, anchorLine - 1, 0);

        this.thread?.dispose();
        this.thread = this.controller.createCommentThread(uri, range, []);
        this.thread.canReply = false;
        this.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        this.thread.label = `${p.tour.title} · 第 ${p.index + 1}/${p.tour.steps.length} 帧`;
        this.thread.comments = [
            { author: { name: "Pi" }, mode: vscode.CommentMode.Preview, body: this.buildBody(p) },
        ];

        try {
            const editor = await vscode.window.showTextDocument(uri, {
                selection: new vscode.Range(line - 1, 0, endLine - 1, 0),
                preview: false,
            });
            editor.setDecorations(this.highlight, [
                new vscode.Range(line - 1, 0, endLine - 1, Number.MAX_SAFE_INTEGER),
            ]);
        } catch (err) {
            logWarn(`打开 ${p.file} 失败：${String(err)}`);
        }

        this.status.text = `$(book) ${p.tour.title} ${p.index + 1}/${p.tour.steps.length}`;
        this.status.tooltip = "Ctrl+Alt+→ 下一帧";
        this.status.show();
    }

    private buildBody(p: Playing): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.supportThemeIcons = true;
        md.isTrusted = {
            enabledCommands: ["pi-bridge.tourNext", "pi-bridge.tourPrev", "pi-bridge.tourStop"],
        };

        md.appendMarkdown(p.tour.steps[p.index].text || "");
        md.appendMarkdown("\n\n---\n");

        const parts: string[] = [];
        if (p.index > 0) parts.push("[$(arrow-left) 上一帧](command:pi-bridge.tourPrev)");
        if (p.index < p.tour.steps.length - 1) {
            parts.push("[$(arrow-right) 下一帧](command:pi-bridge.tourNext)");
        }
        parts.push("[$(close) 退出](command:pi-bridge.tourStop)");
        md.appendMarkdown(parts.join("  ·  "));
        return md;
    }

    /** 找锚点：优先用 hintLine（若内容对得上），否则全文搜 anchorText */
    private resolveAnchor(
        file: string,
        tour: TourData,
        hintLine: number | undefined,
    ): { ok: boolean; line: number; error?: string } {
        let text: string;
        try {
            text = readFileSync(path.resolve(this.root, file), "utf8");
        } catch {
            return { ok: false, line: 0, error: `找不到文件 ${file}` };
        }
        const lines = text.split(/\r?\n/);
        const expected = tour.anchorText;

        if (hintLine != null && hintLine >= 1 && hintLine <= lines.length) {
            if ((lines[hintLine - 1] ?? "").trim() === expected) {
                return { ok: true, line: hintLine };
            }
        }

        const hits: number[] = [];
        for (let i = 1; i <= lines.length; i++) {
            if ((lines[i - 1] ?? "").trim() === expected) hits.push(i);
        }
        if (hits.length === 1) return { ok: true, line: hits[0] };
        if (hits.length > 1) {
            return { ok: false, line: 0, error: `锚点内容在文件里出现 ${hits.length} 次，无法定位` };
        }
        return { ok: false, line: 0, error: "文件里已经找不到这段代码（可能被改了或删了）" };
    }

    private lineText(file: string, line: number): string | undefined {
        try {
            const text = readFileSync(path.resolve(this.root, file), "utf8");
            return (text.split(/\r?\n/)[line - 1] ?? "").trim() || undefined;
        } catch {
            return undefined;
        }
    }

    private activeFile(): { file: string; line: number; text: string } | undefined {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return undefined;
        const file = vscode.workspace.asRelativePath(editor.document.uri, false);
        const line = editor.selection.active.line + 1;
        const text = editor.document.lineAt(line - 1).text.trim();
        return { file, line, text };
    }

    private async pickFrom(list: TourData[], file: string, why: string): Promise<void> {
        const items = list.map((t) => ({
            label: t.title,
            description: t.anchorText,
            detail: `${t.steps.length} 帧`,
            tour: t,
        }));
        const picked = await vscode.window.showQuickPick(items, { placeHolder: `「${file}」：${why}` });
        if (!picked) return;
        const r = await this.play(file, picked.tour, undefined, true);
        if (!r.ok) void vscode.window.showWarningMessage(`无法播放：${r.error ?? "未知"}`);
    }

    /* ── 存储 ── */

    private indexPath(): string {
        return path.join(this.root, TOUR_DIR, INDEX_FILE);
    }

    private loadIndex(): IndexFile {
        try {
            const raw = readFileSync(this.indexPath(), "utf8");
            const data = JSON.parse(raw) as IndexFile;
            if (data && typeof data === "object" && data.files) return data;
        } catch {
            /* 没有或坏了，当空 */
        }
        return { version: 2, files: {} };
    }

    private saveIndex(index: IndexFile): void {
        try {
            mkdirSync(path.join(this.root, TOUR_DIR), { recursive: true });
            writeFileSync(this.indexPath(), JSON.stringify(index, null, 2) + "\n", "utf8");
        } catch (err) {
            logWarn(`写剧本索引失败：${String(err)}`);
        }
    }

    private toursOf(index: IndexFile, file: string): TourData[] {
        return index.files[file] ?? [];
    }

    /** 写入：同文件里 anchorText 相同的就是同一份，直接替换 */
    private put(file: string, tour: TourData): void {
        const index = this.loadIndex();
        const list = this.toursOf(index, file).filter((t) => t.anchorText !== tour.anchorText);
        const replaced = this.toursOf(index, file).length - list.length;

        list.push(tour);
        index.files[file] = list;
        this.saveIndex(index);
        logInfo(
            `讲解已${replaced ? "覆盖" : "保存"}：${tour.title}（${file} · ${tour.anchorText} · ${tour.steps.length} 帧）`,
        );
    }

    private remove(file: string, tour: TourData): void {
        const index = this.loadIndex();
        const list = this.toursOf(index, file).filter((t) => t.anchorText !== tour.anchorText);
        if (list.length) index.files[file] = list;
        else delete index.files[file];
        this.saveIndex(index);
    }

    dispose(): void {
        this.stop();
        this.status.dispose();
        this.highlight.dispose();
        this.controller.dispose();
    }
}

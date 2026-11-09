/**
 * walkthrough - 讲解剧本的播放与存储(自研,不依赖 CodeTour)
 *
 * [三层分离]
 *   frames  资产层:一帧只负责"指向哪,说什么",不知道自己排第几,有谁在用
 *   tours   编排层:就是帧 ID 的数组,插帧只在数组里插一个 ID
 *   edges   结构层:从某剧某帧通向另一部剧,树由这些边连成
 *
 * [为什么这么分]
 *   同一处代码在不同语境要说不同的话 ⇒ 写两个 frame(window 相同,note 不同).
 *   但同一句说明只该写一遍 ⇒ 改 note 处处生效.
 *   引用一律用 ID ⇒ 插帧,删帧,改名都不会串位.
 *
 * [定位与引用是两套正交机制]
 *   定位靠 window(那几行原文),与帧在剧本里排第几无关.
 *   引用靠 ID.返回栈记 ID 不记序号,所以父剧本被插帧也能回来.
 */
import * as vscode from "vscode";
import * as path from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { logInfo, logWarn } from "../logger.js";

const CONTROLLER_ID = "pi-bridge-tour";
const TOUR_DIR = ".pi-tours";
const INDEX_FILE = "index.json";

/** 窗口最多往上抓几行.再抓不到唯一就是这段代码本身没法定位了 */
const MAX_CONTEXT = 6;
/** 播放栈最大深度.到这还没讲完,说明粒度该粗一点了 */
const MAX_DEPTH = 8;

/* ── 数据 ── */

export interface Frame {
    id: string;
    file: string;
    /** 定位窗口(去空白原文),末元素是目标行 */
    window: string[];
    /** 录制时的行号,只用于窗口多命中时消歧 */
    hintLine: number;
    /** 可选:高亮结束位置的窗口 */
    endWindow?: string[];
    note: string;
}

export interface Tour {
    id: string;
    title: string;
    /** 帧 ID 的顺序 */
    steps: string[];
}

export interface Edge {
    fromTour: string;
    fromStep: string;
    toTour: string;
    label?: string;
}

interface IndexFile {
    version: number;
    frames: Record<string, Frame>;
    tours: Record<string, Tour>;
    edges: Edge[];
}

interface StackEntry {
    tourId: string;
    stepId: string;
}

interface Playing {
    tourId: string;
    index: number;
    /** 从哪来.进入子剧本前压栈,返回时弹栈 */
    stack: StackEntry[];
}

/* ── 窗口匹配 ── */

/**
 * 剥掉行尾注释,只留代码骨架.
 *
 * 为什么必须这么做:window 存的是整行原文,行尾注释改一个标点(哪怕是全角括号
 * 换成半角)就会失配.定位只该关心代码,注释是给人看的,不该参与身份.
 *
 * 只处理 C 系和 Python 的行注释,字符串里的符号不算.
 */
function stripComment(line: string): string {
    const t = line.trim();
    if (!t) return "";

    let quote: string | null = null;
    for (let i = 0; i < t.length; i++) {
        const c = t[i];

        if (quote) {
            if (c === "\\") {
                i++;
                continue;
            }
            if (c === quote) quote = null;
            continue;
        }

        if (c === '"' || c === "'" || c === "`") {
            quote = c;
            continue;
        }
        if (c === "/" && t[i + 1] === "/") return t.slice(0, i).trim();
        if (c === "/" && t[i + 1] === "*") return t.slice(0, i).trim();
        // 私有字段(#field)在 TS 里也很常见,所以 # 只认前面是空白的
        if (c === "#" && (i === 0 || /\s/.test(t[i - 1]))) {
            if (i === 0) return "";
            return t.slice(0, i).trim();
        }
    }
    return t;
}

/** 这一行是不是"噪声":空行或整行注释,定位时应当跳过 */
function isNoise(line: string): boolean {
    return stripComment(line) === "";
}

/**
 * 滑动匹配窗口,返回所有命中处的起始行下标(0-based,指向窗口第一行).
 *
 * 比较的是剥掉注释之后的骨架,而且允许文件里在窗口各行之间夹着注释和空行-
 * 所以你在两个代码行中间插一段说明,删几行注释,都不会让剧本失效.
 */
function findWindow(lines: string[], win: string[]): number[] {
    if (win.length === 0) return [];
    const code = win.map(stripComment).filter((l) => l !== "");
    if (code.length === 0) return [];

    const src = lines.map(stripComment);
    const hits: number[] = [];

    for (let i = 0; i < src.length; i++) {
        if (src[i] === "") continue;
        let j = 0;
        let k = i;
        while (j < code.length && k < src.length) {
            if (src[k] === "") {
                k++;
                continue;
            }
            if (src[k] !== code[j]) break;
            j++;
            k++;
        }
        if (j === code.length) hits.push(i);
    }
    return hits;
}

/**
 * 为某一帧造定位窗口:先试 1 个代码行,不唯一就往上加,直到唯一.
 *
 * 往上而不是往下,是因为"这一行"下面往往跟着同级的其他语句,
 * 往上则是它的开头上下文(函数签名,声明,上一级缩进),更能区分.
 *
 * 只收代码行,注释和空行不进窗口-它们的增删改不该影响定位.
 */
function buildWindow(lines: string[], line: number): string[] | undefined {
    const idx = line - 1;
    if (idx < 0 || idx >= lines.length) return undefined;
    if (stripComment(lines[idx]) === "") return undefined;

    const picked: string[] = [];
    for (let i = idx; i >= 0 && picked.length < MAX_CONTEXT; i--) {
        const c = stripComment(lines[i]);
        if (c === "") continue;
        picked.unshift(c);
        if (findWindow(lines, picked).length === 1) return picked;
    }
    return undefined;
}

let frameSeq = 0;
function newId(prefix: string): string {
    frameSeq += 1;
    return `${prefix}-${Date.now().toString(36)}${frameSeq.toString(36)}`;
}

export class Walkthrough implements vscode.Disposable {
    private readonly controller: vscode.CommentController;
    private readonly status: vscode.StatusBarItem;
    private readonly highlight: vscode.TextEditorDecorationType;
    private thread: vscode.CommentThread | undefined;
    private playing: Playing | undefined;
    /** 剧本 ID → 帧 ID → 出边.加载索引时一次性建好 */
    private edgeIndex = new Map<string, Edge[]>();

    constructor(private readonly root: string) {
        this.controller = vscode.comments.createCommentController(CONTROLLER_ID, "Pi 讲解");
        this.controller.commentingRangeProvider = { provideCommentingRanges: () => [] };
        this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
        this.highlight = vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
        });
    }

    /** 来自 vs_show:逐帧造窗口,存盘,立即播放 */
    async show(payload: {
        title: string;
        file: string;
        steps: Array<{ file?: string; line: number; endLine?: number; description: string }>;
    }): Promise<{ ok: boolean; error?: string; tourId?: string; frameIds?: string[] }> {
        if (!payload.steps?.length) return { ok: false, error: "没有任何帧" };

        const index = this.loadIndex();
        const frames: Frame[] = [];

        for (let i = 0; i < payload.steps.length; i++) {
            const raw = payload.steps[i];
            const file = raw.file ?? payload.file;
            const lines = this.readLines(file);
            if (!lines) return { ok: false, error: `第 ${i + 1} 帧:读不到文件 ${file}` };

            const win = buildWindow(lines, raw.line);
            if (!win) {
                return {
                    ok: false,
                    error: `第 ${i + 1} 帧:${file} 第 ${raw.line} 行的内容在文件里没法唯一定位(空行或重复过多)`,
                };
            }

            let endWindow: string[] | undefined;
            if (raw.endLine != null && raw.endLine > raw.line) {
                endWindow = buildWindow(lines, raw.endLine);
                if (!endWindow) {
                    return {
                        ok: false,
                        error: `第 ${i + 1} 帧:结束行 ${file} 第 ${raw.endLine} 行没法唯一定位`,
                    };
                }
            }

            const frame: Frame = {
                id: newId("f"),
                file,
                window: win,
                hintLine: raw.line,
                endWindow,
                note: raw.description ?? "",
            };
            index.frames[frame.id] = frame;
            frames.push(frame);
        }

        // 同名剧本视为重讲:复用剧本 ID,顶掉旧帧,并清掉没人再引用的孤儿帧
        const existing = Object.values(index.tours).find((t) => t.title === payload.title);
        const tourId = existing?.id ?? newId("t");
        const oldSteps = existing?.steps ?? [];

        index.tours[tourId] = {
            id: tourId,
            title: payload.title || "讲解",
            steps: frames.map((f) => f.id),
        };
        // 旧的出边全部作废:剧本重讲之后"哪一帧通向哪"已经变了
        index.edges = index.edges.filter((e) => e.fromTour !== tourId);
        this.dropOrphanFrames(index, oldSteps);

        this.saveIndex(index);
        logInfo(
            `讲解已${existing ? "覆盖" : "保存"}:${payload.title}(${frames.length} 帧,涉及 ${new Set(frames.map((f) => f.file)).size} 个文件)`,
        );
        return this.play(tourId);
    }

    /** 播放某一帧上挂的子剧本(来自 Comment 里的「深入」链接) */
    async dig(tourId: string): Promise<void> {
        const p = this.playing;
        if (!p) return;
        if (p.stack.length >= MAX_DEPTH) {
            void vscode.window.showWarningMessage(`最多深入 ${MAX_DEPTH} 层,先返回吧`);
            return;
        }
        const frameId = this.currentFrameId();
        if (!frameId) return;

        const ok = await this.play(tourId, [...p.stack, { tourId: p.tourId, stepId: frameId }]);
        if (!ok.ok) void vscode.window.showWarningMessage(`无法深入:${ok.error ?? "未知"}`);
    }

    /** 返回上一层.按 stepId 找回,所以父剧本被插帧也能准确定位 */
    async back(): Promise<void> {
        const p = this.playing;
        if (!p || p.stack.length === 0) return;

        const stack = [...p.stack];
        const parent = stack.pop()!;
        const ok = await this.play(parent.tourId, stack, parent.stepId);
        if (!ok.ok) void vscode.window.showWarningMessage(`无法返回:${ok.error ?? "未知"}`);
    }

    /** 「查看这里的讲解」:当前文件相关的剧本,命中当前行就播,否则列出来挑 */
    async playHere(): Promise<void> {
        const at = this.activeFile();
        if (!at) {
            void vscode.window.showInformationMessage("先打开一个文件");
            return;
        }

        const index = this.loadIndex();
        // 一个跨文件的剧本,只要有一帧落在这个文件里,就算"这个文件有讲解"
        const related = Object.values(index.tours).filter((t) =>
            t.steps.some((fid) => index.frames[fid]?.file === at.file),
        );
        if (related.length === 0) {
            void vscode.window.showInformationMessage(`「${at.file}」还没有任何讲解`);
            return;
        }

        const hit = related.find((t) =>
            t.steps.some((fid) => {
                const f = index.frames[fid];
                return f && f.file === at.file && f.window[f.window.length - 1] === at.text;
            }),
        );
        if (hit) {
            const r = await this.play(hit.id);
            if (!r.ok) void vscode.window.showWarningMessage(`无法播放:${r.error ?? "未知"}`);
            return;
        }

        await this.pickFrom(related, index, at.file);
    }

    /** 列出所有剧本(入口优先:没人引用的排前面,它们才是顶层) */
    async pickAll(): Promise<void> {
        const index = this.loadIndex();
        const all = Object.values(index.tours);
        if (all.length === 0) {
            void vscode.window.showInformationMessage("还没有任何讲解");
            return;
        }

        const referenced = new Set(index.edges.map((e) => e.toTour));
        const items = all
            .map((t) => ({
                label: t.title,
                description: `${t.steps.length} 帧${referenced.has(t.id) ? "" : " · 入口"}`,
                detail: [...new Set(t.steps.map((fid) => index.frames[fid]?.file).filter(Boolean))].join(" · "),
                tour: t,
            }))
            .sort((a, b) => Number(a.description.includes("入口")) - Number(b.description.includes("入口")));

        const picked = await vscode.window.showQuickPick(items.reverse(), {
            placeHolder: "选择要播放的讲解",
        });
        if (!picked) return;
        const r = await this.play(picked.tour.id);
        if (!r.ok) void vscode.window.showWarningMessage(`无法播放:${r.error ?? "未知"}`);
    }

    /** 手动清理失效帧.孤儿帧和失效帧是必然存在的,列出来让用户勾 */
    async prune(): Promise<void> {
        const index = this.loadIndex();
        const stale: Array<{ frame: Frame; why: string }> = [];

        for (const f of Object.values(index.frames)) {
            const lines = this.readLines(f.file);
            if (!lines) {
                stale.push({ frame: f, why: `${f.file} 不存在` });
                continue;
            }
            if (findWindow(lines, f.window).length === 0) {
                stale.push({ frame: f, why: `${f.file} 找不到「${f.window[f.window.length - 1]}」` });
            }
        }

        if (stale.length === 0) {
            void vscode.window.showInformationMessage("没有失效的帧");
            return;
        }

        const items = stale.map((s) => ({
            label: s.frame.note.slice(0, 40) || s.frame.window[s.frame.window.length - 1],
            description: `${s.frame.file}:${s.frame.hintLine}`,
            detail: s.why,
            picked: false,
            frame: s.frame,
        }));
        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: `发现 ${stale.length} 个定位不到的帧,勾选要删除的`,
            canPickMany: true,
        });
        if (!picked?.length) return;

        const drop = new Set(picked.map((p) => p.frame.id));
        const index2 = this.loadIndex();
        for (const id of drop) delete index2.frames[id];
        for (const t of Object.values(index2.tours)) {
            t.steps = t.steps.filter((fid) => !drop.has(fid));
        }
        index2.tours = Object.fromEntries(
            Object.entries(index2.tours).filter(([, t]) => t.steps.length > 0),
        );
        index2.edges = index2.edges.filter(
            (e) => !drop.has(e.fromStep) && index2.tours[e.toTour] && index2.tours[e.fromTour],
        );
        this.saveIndex(index2);
        void vscode.window.showInformationMessage(`已删除 ${picked.length} 个帧`);
    }

    next(): void {
        const p = this.playing;
        if (!p) return;
        const tour = this.loadIndex().tours[p.tourId];
        if (!tour) return this.stop();
        if (p.index >= tour.steps.length - 1) {
            this.stop();
            return;
        }
        p.index++;
        void this.render();
    }

    prev(): void {
        const p = this.playing;
        if (!p || p.index === 0) return;
        p.index--;
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

    private currentFrameId(): string | undefined {
        const p = this.playing;
        if (!p) return undefined;
        return this.loadIndex().tours[p.tourId]?.steps[p.index];
    }

    private async play(
        tourId: string,
        stack: StackEntry[] = [],
        startStepId?: string,
    ): Promise<{ ok: boolean; error?: string; tourId?: string; frameIds?: string[] }> {
        const index = this.loadIndex();
        const tour = index.tours[tourId];
        if (!tour) return { ok: false, error: "剧本不存在" };

        // 防环:目标已经在栈上就别进去(正常存盘时就该拦住,这里是兜底)
        if (stack.some((s) => s.tourId === tourId)) {
            return { ok: false, error: "这样会绕回来(剧本在栈里已经出现过)" };
        }

        let idx = 0;
        if (startStepId) {
            const at = tour.steps.indexOf(startStepId);
            if (at < 0) {
                logWarn(`返回点 ${startStepId} 已不在剧本 ${tour.title} 里,从头开始`);
            } else {
                idx = at;
            }
        }

        const first = index.frames[tour.steps[idx]];
        if (!first) return { ok: false, error: "第一帧不存在" };

        this.playing = { tourId, index: idx, stack };
        await this.render();
        return { ok: true, tourId, frameIds: tour.steps };
    }

    /** 把一帧解析成实际行号.窗口多命中时取离 hintLine 最近的那处 */
    private resolveFrame(frame: Frame): { start: number; end: number } | undefined {
        const lines = this.readLines(frame.file);
        if (!lines) return undefined;

        const hits = findWindow(lines, frame.window);
        if (hits.length === 0) return undefined;

        const targetOf = (startIdx: number) => startIdx + frame.window.length - 1;
        let best = hits[0];
        if (hits.length > 1) {
            let bestDist = Infinity;
            for (const h of hits) {
                const dist = Math.abs(targetOf(h) + 1 - frame.hintLine);
                if (dist < bestDist) {
                    bestDist = dist;
                    best = h;
                }
            }
        }
        const start = targetOf(best) + 1;

        let end = start;
        if (frame.endWindow) {
            const ehits = findWindow(lines, frame.endWindow);
            if (ehits.length) {
                let eb = ehits[0];
                if (ehits.length > 1) {
                    let bestDist = Infinity;
                    for (const h of ehits) {
                        const dist = Math.abs(h + frame.endWindow.length - start);
                        if (dist < bestDist) {
                            bestDist = dist;
                            eb = h;
                        }
                    }
                }
                end = eb + frame.endWindow.length;
            }
        }
        return { start, end };
    }

    private async render(): Promise<void> {
        const p = this.playing;
        if (!p) return;

        const index = this.loadIndex();
        const tour = index.tours[p.tourId];
        if (!tour) return this.stop();

        const frameId = tour.steps[p.index];
        const frame = index.frames[frameId];
        if (!frame) {
            void vscode.window.showWarningMessage(`第 ${p.index + 1} 帧不存在,播放结束`);
            return this.stop();
        }

        const pos = this.resolveFrame(frame);
        if (!pos) {
            void vscode.window.showWarningMessage(
                `第 ${p.index + 1} 帧指不到位置了(${frame.file}),播放结束`,
            );
            return this.stop();
        }

        const uri = vscode.Uri.file(path.resolve(this.root, frame.file));
        // 有范围就挂在范围最后一行下面,否则挂在这一行下面
        const anchorLine = pos.end > pos.start ? pos.end : pos.start;
        const range = new vscode.Range(anchorLine - 1, 0, anchorLine - 1, 0);

        this.thread?.dispose();
        this.thread = this.controller.createCommentThread(uri, range, []);
        this.thread.canReply = false;
        this.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        this.thread.label = `${tour.title} · 第 ${p.index + 1}/${tour.steps.length} 帧`;
        this.thread.comments = [
            {
                author: { name: "Pi" },
                mode: vscode.CommentMode.Preview,
                body: this.buildBody(tour, frame),
            },
        ];

        try {
            const editor = await vscode.window.showTextDocument(uri, {
                selection: new vscode.Range(pos.start - 1, 0, anchorLine - 1, 0),
                preview: false,
            });
            editor.setDecorations(this.highlight, [
                new vscode.Range(pos.start - 1, 0, anchorLine - 1, Number.MAX_SAFE_INTEGER),
            ]);
            editor.revealRange(
                new vscode.Range(pos.start - 1, 0, anchorLine - 1, 0),
                vscode.TextEditorRevealType.InCenterIfOutsideViewport,
            );
        } catch (err) {
            logWarn(`打开 ${frame.file} 失败:${String(err)}`);
        }

        this.status.text = `$(book) ${tour.title} ${p.index + 1}/${tour.steps.length}`;
        this.status.tooltip = p.stack.length ? `第 ${p.stack.length + 1} 层` : "顶层";
        this.status.show();
    }

    private buildBody(tour: Tour, frame: Frame): vscode.MarkdownString {
        const p = this.playing!;
        const md = new vscode.MarkdownString();
        md.supportThemeIcons = true;
        md.isTrusted = {
            enabledCommands: [
                "pi-bridge.tourNext",
                "pi-bridge.tourPrev",
                "pi-bridge.tourStop",
                "pi-bridge.tourBack",
                "pi-bridge.tourDig",
            ],
        };

        md.appendMarkdown(frame.note || "");

        // 这一帧的出边:可以深入哪几份剧本
        const out = this.edgeIndex.get(`${tour.id}|${frame.id}`) ?? [];
        const index = this.loadIndex();
        const live = out.filter((e) => index.tours[e.toTour]);
        if (live.length) {
            md.appendMarkdown("\n\n");
            for (const e of live) {
                const label = e.label || index.tours[e.toTour].title;
                const arg = encodeURIComponent(JSON.stringify([e.toTour]));
                md.appendMarkdown(`\n- [$(book) 深入:${label}](command:pi-bridge.tourDig?${arg})`);
            }
        }

        md.appendMarkdown("\n\n---\n");

        const parts: string[] = [];
        if (p.stack.length > 0) parts.push("[$(arrow-up) 返回](command:pi-bridge.tourBack)");
        if (p.index > 0) parts.push("[$(arrow-left) 上一帧](command:pi-bridge.tourPrev)");
        if (p.index < tour.steps.length - 1) {
            parts.push("[$(arrow-right) 下一帧](command:pi-bridge.tourNext)");
        }
        parts.push("[$(close) 退出](command:pi-bridge.tourStop)");
        md.appendMarkdown(parts.join("  ·  "));
        return md;
    }

    private async pickFrom(
        related: Tour[],
        index: IndexFile,
        file: string,
    ): Promise<void> {
        const items = related.map((t) => ({
            label: t.title,
            description: `${t.steps.length} 帧`,
            detail: t.steps
                .map((fid) => index.frames[fid])
                .filter((f) => f && f.file === file)
                .map((f) => f!.window[f!.window.length - 1])
                .slice(0, 2)
                .join(" · "),
            tour: t,
        }));
        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: `「${file}」里的讲解(当前这行没有精确匹配)`,
        });
        if (!picked) return;
        const r = await this.play(picked.tour.id);
        if (!r.ok) void vscode.window.showWarningMessage(`无法播放:${r.error ?? "未知"}`);
    }

    private readLines(file: string): string[] | undefined {
        try {
            return readFileSync(path.resolve(this.root, file), "utf8").split(/\r?\n/);
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

    /* ── 存储 ── */

    private indexPath(): string {
        return path.join(this.root, TOUR_DIR, INDEX_FILE);
    }

    private loadIndex(): IndexFile {
        let index: IndexFile = { version: 4, frames: {}, tours: {}, edges: [] };
        try {
            const raw = readFileSync(this.indexPath(), "utf8");
            const data = JSON.parse(raw) as IndexFile;
            // 旧版本(按文件分组,没有帧表)直接当空,用户说旧数据删掉即可
            if (data && data.version >= 4 && data.frames && data.tours) index = data;
        } catch {
            /* 没有或坏了,当空 */
        }
        this.rebuildEdgeIndex(index);
        return index;
    }

    private rebuildEdgeIndex(index: IndexFile): void {
        this.edgeIndex = new Map();
        for (const e of index.edges) {
            const k = `${e.fromTour}|${e.fromStep}`;
            const list = this.edgeIndex.get(k);
            if (list) list.push(e);
            else this.edgeIndex.set(k, [e]);
        }
    }

    private saveIndex(index: IndexFile): void {
        try {
            mkdirSync(path.join(this.root, TOUR_DIR), { recursive: true });
            writeFileSync(this.indexPath(), JSON.stringify(index, null, 2) + "\n", "utf8");
            this.rebuildEdgeIndex(index);
        } catch (err) {
            logWarn(`写剧本索引失败:${String(err)}`);
        }
    }

    /** 清掉没人再引用的帧(剧本重讲后旧帧就没人要了) */
    private dropOrphanFrames(index: IndexFile, candidates: string[]): void {
        const used = new Set<string>();
        for (const t of Object.values(index.tours)) for (const fid of t.steps) used.add(fid);
        for (const e of index.edges) used.add(e.fromStep);
        for (const fid of candidates) {
            if (!used.has(fid)) delete index.frames[fid];
        }
    }

    dispose(): void {
        this.stop();
        this.status.dispose();
        this.highlight.dispose();
        this.controller.dispose();
    }
}

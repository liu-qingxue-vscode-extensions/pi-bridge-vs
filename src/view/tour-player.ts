/**
 * tour-player —— 把 AI 写的讲解剧本交给 CodeTour 播放
 *
 * 为什么不自己写播放器：
 *   帧队列、快捷键、进度条、跨文件跳转、多窗口隔离，CodeTour 全都做好了，
 *   而且它暴露了 startTourByUri 这个入口。我们只负责把帧写成 tour 文件。
 *
 * 剧本落在工作区的 .tours/ 下（CodeTour 的默认扫描目录），
 * 每次覆盖 ai-live.tour.json，所以不会堆一堆临时文件。
 */
import * as vscode from "vscode";
import * as path from "node:path";
import { logInfo, logWarn } from "../logger.js";

const CODETOUR_ID = "vsls-contrib.codetour";

export interface TourStep {
    file: string;
    /** 1-based */
    line: number;
    /** 1-based，可选 */
    endLine?: number;
    description: string;
}

export interface TourPayload {
    tourId: string;
    title: string;
    steps: TourStep[];
    at: number;
}

interface CodeTourApi {
    startTourByUri?: (uri: vscode.Uri, stepNumber?: number) => Thenable<void>;
    endCurrentTour?: () => Thenable<void>;
}

export interface PlayResult {
    ok: boolean;
    error?: string;
}

export async function playTour(root: string, payload: TourPayload): Promise<PlayResult> {
    const ext = vscode.extensions.getExtension(CODETOUR_ID);
    if (!ext) {
        return {
            ok: false,
            error: "没装 CodeTour 扩展（vsls-contrib.codetour），讲解需要一个播放器",
        };
    }

    const tour = {
        title: payload.title || "分享",
        steps: payload.steps.map((s) => {
            const step: Record<string, unknown> = {
                file: s.file,
                line: s.line,
                description: s.description ?? "",
            };
            // 只有跨行时才给 selection（CodeTour 里行号都是 1-based）
            if (s.endLine != null && s.endLine > s.line) {
                step.selection = {
                    start: { line: s.line, character: 1 },
                    end: { line: s.endLine, character: 1 },
                };
            }
            return step;
        }),
    };

    const dir = path.join(root, ".tours");
    const file = path.join(dir, "ai-live.tour.json");
    try {
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
        await vscode.workspace.fs.writeFile(
            vscode.Uri.file(file),
            Buffer.from(JSON.stringify(tour, null, 2) + "\n", "utf8"),
        );
    } catch (err) {
        return { ok: false, error: `写剧本文件失败：${String(err)}` };
    }

    try {
        await ext.activate();
    } catch (err) {
        return { ok: false, error: `CodeTour 激活失败：${String(err)}` };
    }

    const api = ext.exports as CodeTourApi;
    if (typeof api.startTourByUri !== "function") {
        return { ok: false, error: "这个版本的 CodeTour 没有暴露 startTourByUri" };
    }

    try {
        await api.startTourByUri(vscode.Uri.file(file), 0);
    } catch (err) {
        return { ok: false, error: `播放失败：${String(err)}` };
    }

    logInfo(`讲解剧本已播放：${payload.title}（${payload.steps.length} 帧）-> ${file}`);
    logWarn(
        "提示：CodeTour 默认快捷键是 ctrl+up ctrl+up 启动 / ctrl+左右 翻页，" +
            "可能与编辑器冲突",
    );
    return { ok: true };
}

/**
 * proposal - 提案的定位与 diff 生成(纯逻辑,不依赖 VS Code)
 *
 * 为什么单独放:
 *   定位规则(怎么找到要改的地方)是这个功能最容易出错的部分,
 *   抽成纯函数才能喂假数据验证.真正的写入在 view/proposal-comments.ts,
 *   那里用 VS Code 的 WorkspaceEdit(这样能同步编辑器缓冲区,支持撤销).
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";

/**
 * 提案的定位方式.
 *
 * 现在只实现 text,另外两个分支先留好位置:
 *   symbol - 按函数/类名定位(需要 VS Code 的符号查询,走 LSP)
 *   range  - 按行号定位(兜底,AI 明确知道行号时用)
 */
export type WriteMode = "text" | "symbol" | "range";

export interface WriteProposal {
    proposalId: string;
    kind: "write";
    /** 相对于工作区根目录的路径 */
    file: string;
    mode: WriteMode;
    /** mode=text 时必填:要被替换的原文(含缩进,必须在文件里唯一) */
    oldText?: string;
    /** mode=symbol 时必填:函数或类的名字 */
    symbolName?: string;
    /** mode=range 时必填:1-based,两端包含 */
    startLine?: number;
    endLine?: number;
    newText: string;
    explanation: string;
    at: number;
}

export interface LocateResult {
    ok: boolean;
    /** 1-based,两端包含 */
    startLine?: number;
    endLine?: number;
    /** 在文本中的字符偏移量(用来构造精确的替换范围) */
    offset?: number;
    length?: number;
    /** 实际匹配到的原文 */
    matchedText?: string;
    error?: string;
}

/** 统一换行符,避免 CRLF/LF 差异让原文匹配失败 */
function normalize(s: string): string {
    return s.replace(/\r\n/g, "\n");
}

/** 把文本的换行符统一成指定的那种(写入时用文档自己的换行符) */
export function normalizeEol(s: string, eol: string): string {
    return normalize(s).replace(/\n/g, eol);
}

function countOccurrences(haystack: string, needle: string): number {
    if (!needle) return 0;
    let n = 0;
    let i = haystack.indexOf(needle);
    while (i >= 0) {
        n++;
        i = haystack.indexOf(needle, i + 1);
    }
    return n;
}

function lineRangeOf(haystack: string, index: number, length: number): {
    startLine: number;
    endLine: number;
} {
    const before = haystack.slice(0, index);
    const startLine = before.split("\n").length; // 1-based
    const inner = haystack.slice(index, index + length);
    const endLine = startLine + inner.split("\n").length - 1;
    return { startLine, endLine };
}

/**
 * 在当前文件里定位提案要改的地方.
 *
 * 定位失败要明确说原因,不要猜 - AI 需要据此重新提交.
 */
export function locateProposal(root: string, p: WriteProposal): LocateResult {
    const abs = path.resolve(root, p.file);
    let raw: string;
    try {
        raw = readFileSync(abs, "utf8");
    } catch (err) {
        return { ok: false, error: `读不到文件 ${p.file}:${String(err)}` };
    }
    return locateInText(raw, p);
}

/**
 * 在一段文本里定位.
 *
 * 之所以要独立出来:写入时必须用[编辑器里当前的文档内容]来定位,
 * 而不是磁盘上的旧内容(编辑器可能有未保存的修改).
 */
export function locateInText(raw: string, p: WriteProposal): LocateResult {
    // 不整体转换换行符:offset 必须能直接用在原文档上,
    // 所以只把 oldText 对齐到文件实际使用的换行符.
    const eol = raw.includes("\r\n") ? "\r\n" : "\n";
    const align = (s: string): string => normalize(s).replace(/\n/g, eol);
    const text = raw;

    if (p.mode === "text") {
        const needle = align(p.oldText ?? "");
        if (!needle.trim()) {
            return { ok: false, error: "oldText 不能为空" };
        }
        const hits = countOccurrences(text, needle);
        if (hits === 0) {
            return { ok: false, error: "在文件里找不到 oldText(内容可能已经变了)" };
        }
        if (hits > 1) {
            return {
                ok: false,
                error: `oldText 在文件里匹配到 ${hits} 处,无法确定改哪一处.请带上更多上下文使其唯一`,
            };
        }
        const idx = text.indexOf(needle);
        const range = lineRangeOf(text, idx, needle.length);
        return {
            ok: true,
            ...range,
            offset: idx,
            length: needle.length,
            matchedText: needle,
        };
    }

    if (p.mode === "range") {
        const startLine = p.startLine ?? 0;
        const endLine = p.endLine ?? 0;
        const lines = text.split(eol);
        if (startLine < 1 || endLine < startLine || endLine > lines.length) {
            return {
                ok: false,
                error: `行号越界:${startLine}-${endLine},文件共 ${lines.length} 行`,
            };
        }
        const offset =
            lines.slice(0, startLine - 1).join(eol).length + (startLine > 1 ? eol.length : 0);
        const matched = lines.slice(startLine - 1, endLine).join(eol);
        return {
            ok: true,
            startLine,
            endLine,
            offset,
            length: matched.length,
            matchedText: matched,
        };
    }

    // symbol 模式还没实现:需要 VS Code 的符号查询,这里不能做
    return { ok: false, error: "symbol 模式尚未实现,请改用 mode=text" };
}

/** 给渲染用的 diff 行(不带 +/- 前缀,渲染层自己加) */
export function buildDiff(oldText: string, newText: string): {
    removed: string[];
    added: string[];
} {
    return {
        removed: oldText ? normalize(oldText).split("\n") : [],
        added: normalize(newText ?? "").split("\n"),
    };
}

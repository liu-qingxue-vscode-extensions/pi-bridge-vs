/**
 * ★★ B41：把工具块的内容【送到左边的编辑器区】显示
 *
 * 【按内容类型分派】—— 不同内容的"最自然看法"不一样：
 *
 *   read / write   → 打开【真实文件】（能编辑 ✓ 有完整的语法高亮和语言服务 ✓）
 *   edit           → 打开【真 diff 视图】vscode.diff(before, after)
 *                     · after  = 真实文件（可编辑的活文件 ✓）
 *                     · before = 用 details.patch 反推出来的虚拟文档
 *   bash / 其他    → 虚拟文档（纯文本 ✗ 只读）
 *
 * 【为什么 edit 要反推 before】
 *   patch 里同时含"改前"和"改后"的信息 ✓ 而 after 就是磁盘上的当前文件 ✓
 *   ⇒ 两者相减就得到 before ✓ 不必依赖 git / 历史 / 备份 ✓
 *
 * 【扩展工具】
 *   目前走 default 分支（虚拟文档 ✗ 参数 + 结果拼一份）
 *   ★ 将来某个扩展工具想要特殊渲染 ⇒ 在这里加一个 case 即可 ✓
 */

import * as vscode from "vscode";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import * as path from "path";
import type { Block } from "../view/chat-types.js";
import { reverseApplyPatch } from "../bridge/patch-reverse.js";
import { registerVirtualDoc } from "../view/virtual-docs.js";
import { logError, logInfo } from "../logger.js";

/* ───────────────────────── 打开动作 ───────────────────────── */

/** 把块里的 parts 拼成纯文本（用于虚拟文档兜底）*/
function partsToText(blk: Block): string {
    const parts = blk.resultParts ?? blk.partialParts ?? [];
    const out: string[] = [];
    for (const p of parts) {
        const t = (p as { type?: string; text?: string } | null)?.type;
        if (t === "text") out.push((p as { text?: string }).text ?? "");
        else if (t === "image") out.push("（图像输出 ✗ 不支持在编辑器中显示）");
        else out.push(JSON.stringify(p, null, 2));
    }
    return out.join("\n");
}

/** 参数 → 文本（兜底显示用）*/
function argsToText(blk: Block): string {
    const args = blk.args;
    if (args === undefined || args === null) return "";
    if (typeof args === "string") return args;
    try {
        return JSON.stringify(args, null, 2);
    } catch {
        return String(args);
    }
}

/** 打开真实的文本文件（返回是否成功）*/
async function openRealFile(filePath: string): Promise<boolean> {
    if (!filePath || !existsSync(filePath)) return false;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(doc, { preview: false });
    return true;
}

/** ★ edit：真 diff 视图（左 = 反推出的改前 ✗ 右 = 真实文件 ⇒ 右边是活的）*/
async function openEditDiff(blk: Block): Promise<boolean> {
    const filePath = (blk.args as { path?: unknown } | null)?.path;
    const patch = (blk.details as { patch?: unknown } | null)?.patch;
    if (typeof filePath !== "string" || typeof patch !== "string" || !patch.trim()) return false;
    if (!existsSync(filePath)) return false;

    const after = await readFile(filePath, "utf8");
    const before = reverseApplyPatch(after, patch);

    // ★ 左边用虚拟文档（不落盘 ✓）✗ 右边直接指向真实文件 ⇒ 可以就地编辑保存 ✓
    const beforeUri = registerVirtualDoc(`改前-${path.basename(filePath)}`, before);
    const afterUri = vscode.Uri.file(filePath);
    await vscode.commands.executeCommand(
        "vscode.diff",
        beforeUri,
        afterUri,
        `${path.basename(filePath)}（改前 ↔ 改后）`,
    );
    return true;
}

/**
 * 打开入口：按工具类型分派
 * ★ 找不到一致的处理方式时【兜底成虚拟文档】✗ 而不是静默失败 ✓
 */
export async function openToolInEditor(blk: Block | undefined): Promise<void> {
    if (!blk) {
        void vscode.window.showWarningMessage("找不到这个工具块（可能已经被清掉了）");
        return;
    }
    const tool = blk.toolName ?? "";
    const filePath = (blk.args as { path?: unknown } | null)?.path;

    try {
        // ⓪ ★★ B46：压缩摘要 → ★ Markdown 预览（不是只读源码视图 ✓）
        //
        // 【为什么必须是"预览"而不是打开 .md 文件】
        //   虚拟文档是【只读编辑器】⇒ ★ Ctrl+F 搜索、折叠、大纲全都不可用 ✗
        //     用户实测："只读编辑器 Ctrl+F 渲染都失效了"✓
        //   ⇒ Markdown 预览是 VS Code 内置的渲染视图 ✗ 它可以搜索 ✓
        //     （而且有标题大纲 / 表格 / 代码高亮 ✗ 正是读长摘要需要的 ✓）
        //
        // 【副作用】预览是"渲染视图"✗ 不能选原文地址
        //   ⇒ 想看源码/要复制原文 ⇒ 右键菜单里另给一个"打开源码"✓
        if (blk.type === "compaction") {
            const head = blk.tokensBefore
                ? `已被压缩的对话（压缩前约 ${blk.tokensBefore.toLocaleString()} tokens）`
                : "已被压缩的对话";
            const when = blk.time ? `\n\n压缩时间：${blk.time}` : "";
            // ★ 用引用块做头（渲染出来是灰底 ✓ 一眼看出"这是被压缩的"✓）
            const body = `> ${head}${when}\n\n---\n\n${blk.summary ?? ""}`;
            // ★ key = 压缩块的 compId ⇒ 重复点击【复用同一个 tab】✓
            // ★ showPreview（当前组）而不是 showPreviewToSide（会新开一组 ✗ 用户不要 ✓）
            const uri = registerVirtualDoc("压缩摘要.md", body, blk.compId ? `comp:${blk.compId}` : undefined);
            await vscode.commands.executeCommand("markdown.showPreview", uri);
            logInfo("★ 送去编辑器：压缩摘要 → Markdown 预览");
            return;
        }

        // ① 有真实文件路径的（read / write）→ 直接开真文件
        if ((tool === "read" || tool === "write") && typeof filePath === "string") {
            if (await openRealFile(filePath)) {
                logInfo(`★ 送去编辑器：${tool} → ${filePath}`);
                return;
            }
            // 文件没了 → 落到虚拟文档兜底
        }

        // ② edit → 真 diff 视图
        if (tool === "edit" && (await openEditDiff(blk))) {
            logInfo(`★ 送去编辑器：edit → diff 视图（${filePath}）`);
            return;
        }

        // ③ 兜底：虚拟文档（bash 输出 / 扩展工具 / 文件已不存在）
        const name = tool === "bash" ? `bash-输出.txt` : `${tool || "tool"}-输出.txt`;
        const body = [argsToText(blk), partsToText(blk)].filter(Boolean).join("\n\n");
        const uri = registerVirtualDoc(name, body || "（没有内容）");
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: false });
        logInfo(`★ 送去编辑器：${tool} → 虚拟文档`);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logError(`送去编辑器失败（${tool}）: ${msg}`);
        void vscode.window.showErrorMessage(`送去编辑器失败：${msg}`);
    }
}

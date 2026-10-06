/**
 * ★★ B41：虚拟文档（只读）—— 让"还没落盘的内容"也能在编辑器里显示
 *
 * 【为什么不用临时文件】
 *   写 /tmp/xxx.txt 然后打开 ✗ 会有：文件堆积、要清理、多窗口互相覆盖、
 *   用户翻 /tmp 时看见一堆垃圾 ✓
 *   VS Code 的正统做法是 TextDocumentContentProvider：注册一个 URI scheme ✗
 *   编辑器要显示时来问我们"这个 URI 的内容是什么" ✓ 我们现答 ✓
 *
 * 【它能带来什么】
 *   · 不落盘、零清理 ✓
 *   · 可以 diff（两个虚拟文档 ✗ 或者虚拟文档 vs 真实文件 ✓ 见 editor-open.ts）
 *   · URI 的路径带扩展名 ⇒ VS Code 自动上语法高亮 ✓
 */

import * as vscode from "vscode";

const SCHEME = "pi-view";

/** uri.toString() → 内容 */
const contents = new Map<string, string>();

/** 序号：保证同名文件（如多个 a.ts）也各有各的 URI ✗ 不会互相覆盖 */
let seq = 0;

/**
 * 登记一份虚拟内容，返回可以被 VS Code 打开的 URI
 * ★ name 只是"显示用的文件名" ✗ 带扩展名就能触发对应的语言高亮 ✓
 */
export function registerVirtualDoc(name: string, content: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${++seq}/${name}` });
    contents.set(uri.toString(), content);
    return uri;
}

/** 注册 provider（在 activate 里调一次）*/
export function createVirtualDocProvider(): vscode.Disposable {
    return vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
        provideTextDocumentContent(uri) {
            // ★ 取不到就返回空串（而不是抛错）✗ 编辑器会显示空白而不是报错 ✓
            return contents.get(uri.toString()) ?? "";
        },
    });
}

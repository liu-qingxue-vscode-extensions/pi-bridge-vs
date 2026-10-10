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

/** ★ key → uri（同一个逻辑对象复用同一个 URI ✓）*/
const byKey = new Map<string, vscode.Uri>();

/** ★ 内容变了要通知编辑器刷新（否则还显示旧文本 ✗）*/
let onDidChange: ((uri: vscode.Uri) => void) | null = null;

/**
 * 登记一份虚拟内容，返回可以被 VS Code 打开的 URI
 * ★ name 只是"显示用的文件名" ✗ 带扩展名就能触发对应的语言高亮 ✓
 *
 * ★★ key（B46）：同一个逻辑对象（如"某个压缩块"）应该【复用同一个 URI】
 *   【为什么】不给 key 的话每次调用都 seq++ ⇒ 新 URI ⇒ 编辑器【又开一个 tab】
 *     用户实测："重复点击它会重复一直重复弹"✓
 *   ★ 给了 key：第二次点就是同一个 URI ⇒ VS Code 直接【聚焦已打开的那个】✓
 */
export function registerVirtualDoc(name: string, content: string, key?: string): vscode.Uri {
    if (key) {
        const hit = byKey.get(key);
        if (hit) {
            contents.set(hit.toString(), content);
            onDidChange?.(hit); // ★ 内容变了 ⇒ 让已打开的编辑器刷新
            return hit;
        }
    }
    const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${++seq}/${name}` });
    contents.set(uri.toString(), content);
    if (key) byKey.set(key, uri);
    return uri;
}

/** 注册 provider（在 activate 里调一次）*/
export function createVirtualDocProvider(): vscode.Disposable {
    const emitter = new vscode.EventEmitter<vscode.Uri>();
    onDidChange = (uri) => emitter.fire(uri);
    return vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
        provideTextDocumentContent(uri) {
            // ★ 取不到就返回空串（而不是抛错）✗ 编辑器会显示空白而不是报错 ✓
            return contents.get(uri.toString()) ?? "";
        },
        onDidChange: emitter.event,
    });
}

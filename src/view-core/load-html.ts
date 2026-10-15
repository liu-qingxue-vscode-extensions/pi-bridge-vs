import * as fs from "node:fs";
import * as path from "node:path";

import * as vscode from "vscode";

export function loadHtml(
    extensionUri: vscode.Uri,
    /**对象的文件名 ,如chat.html */
    fileName: string,
): string {
    const filePath = path.join(extensionUri.fsPath, "media", fileName);
    const raw = fs.readFileSync(filePath, "utf8");
    return raw
}
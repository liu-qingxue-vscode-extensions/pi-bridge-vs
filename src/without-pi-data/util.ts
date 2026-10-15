import os from "node:os"

import * as vscode from "vscode";
import { initVSLogger, vsLogDebug, vsLogError, vsLogInfo, vsLogWarn } from "../logger.js"

export function getCwd(): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const cwd = workspaceFolder ?? os.homedir();
    if (!workspaceFolder) {
        vsLogInfo(`未打开工作区, pi 将以 HOME 目录作为工作目录:${cwd}`);
    } else {
        vsLogInfo(`pi 工作目录在 VS 工作区:${cwd}`);
    }
    return cwd
}
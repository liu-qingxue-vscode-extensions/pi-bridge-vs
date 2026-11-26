import * as vscode from "vscode"
import os from "node:os";
import { createVSLogger } from "../logger.js";

const log = createVSLogger("util/reolveWorkspace")
export function reolveWorkspace() {
    // 1. 确定 pi 的工作目录
    //    没有打开工作区时用 HOME(而不是 process.cwd(),后者不可靠)
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const cwd = workspaceFolder ?? os.homedir();
    if (!workspaceFolder) {
        log.info(`未打开工作区,pi 将以 HOME 目录作为工作目录:${cwd}`);
    } else {
        log.info(`pi 工作目录:${cwd}`);
    }
    return cwd
}